/**
 * Cookie 守护 —— 宿主（Node）侧。
 *
 * 这个插件要回答的问题只有一个：Chromium 的 cookie jar 里现在攒了多少条
 * `dsh-auth-*` ？
 *
 * 为什么不能数请求头：桌面版里 renderer 的请求是外壳经 IPC 转发到 Host 的，
 * 只带当前这次启动的那一条 cookie，看不到 jar 的真实体积（实测库里 24 条、
 * 请求头只有 1 条）。所以只能去读 `Network/Cookies` 本身 —— 而它在 DSH 运
 * 行期间被独占打开，常规 open 必然 ERROR_SHARING_VIOLATION。probe.js 负责借
 * 外壳进程已打开的那个句柄把文件读出来；读不到就老实说读不到，不猜数。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { probeJar } from './probe.js'

export const name = 'dsh-cookie-guard'

/** 插件自己的接口路径，客户端 `fetch` 同一个地址。 */
const ROUTE = '/dsh-cookie-guard/api'
/** Node 默认 http 请求头上限，超过它服务端直接回 431。 */
const MAX_HEADER = 16384
/** 一条 `dsh-auth-*` 在请求头里的实际字节数（name 52 + '=' + value 173 + '; '）。 */
const BYTES_PER_COOKIE = 228
/** 16384 / 228 向上取整之前的临界条数：第 72 条就爆了。 */
const THRESHOLD = 71
/** 过半开始提醒。 */
const WARN_AT = 36
/** 宿主侧的兜底节拍：每 10 分钟检查一次「今天的快照写了没」。 */
const TICK_MS = 10 * 60 * 1000
/** 借句柄要把全机句柄表扫一遍，别让轮询把它当免费接口——缓存 60 秒。 */
const CACHE_MS = 60 * 1000
/** 就算前端催，两次真实探测之间也至少隔 5 秒。 */
const MIN_PROBE_GAP_MS = 5 * 1000

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

function stateFile() {
  return join(dshHome(), 'cookie-guard', 'state.json')
}

function headerValue(headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch (err) {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * 本机进程能不能直接打这个路由。
 *
 * 优先借 harness 自己的门禁（随 DSH 鉴权方式变化自动适配），拿不到时退回
 * 本地复述：只认 loopback 的 Host 头，拒绝跨站标记，Origin 必须同源。
 */
function makeFence(ctx) {
  function harnessConnection() {
    for (const source of [ctx, ctx.root]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection === undefined || connection === null) continue
        if (typeof connection.requestRejection !== 'function') continue
        return connection
      } catch (err) {
        /* 换下一个来源 */
      }
    }
    return undefined
  }

  return function refusal(request) {
    const connection = harnessConnection()
    if (connection !== undefined) {
      try {
        return connection.requestRejection(request)
      } catch (err) {
        /* 退回复述 */
      }
    }
    const headers = request === undefined || request === null ? undefined : request.headers
    const host = headerValue(headers, 'host')
    if (host === undefined) return 403
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return 403
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return 403
    const origin = headerValue(headers, 'origin')
    if (origin === undefined) return undefined
    try {
      return new URL(origin).host === hostUrl.host ? undefined : 403
    } catch (err) {
      return 403
    }
  }
}

/** 探测结果的短期缓存。 */
let probeCache

/**
 * 拿 jar 里的真实条数。
 *
 * 借句柄要扫一遍全机句柄表（本机 1.3M 个），一次约 240ms 且是同步阻塞的，
 * 所以默认 60 秒内复用上次结果；只有用户手动点按钮（force）才穿透缓存，而且
 * 两次真实探测之间至少隔 5 秒。
 *
 * @param {boolean} force 用户主动要求重新检测
 */
async function inspect(force) {
  const now = Date.now()
  if (probeCache !== undefined) {
    const age = now - probeCache.at
    if (age < CACHE_MS && !force) return { ...probeCache.payload, cached: true }
    if (age < MIN_PROBE_GAP_MS) return { ...probeCache.payload, cached: true }
  }
  // 让出一次事件循环，别让这一下阻塞把正在流式输出的会话卡住。
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  const result = probeJar()
  const payload = result.ok
    ? {
        ok: true,
        count: result.count,
        source: result.source,
        probeMs: result.elapsedMs,
        fileSize: result.fileSize,
      }
    : { ok: false, reason: result.reason, fileSize: result.fileSize }
  probeCache = { at: Date.now(), payload }
  return { ...payload, cached: false }
}

function describe(count, extra) {
  const bytes = count * BYTES_PER_COOKIE
  const pct = Math.round((bytes / MAX_HEADER) * 100)
  return {
    count,
    bytes,
    pct: pct > 100 ? 100 : pct,
    rawPct: pct,
    maxHeader: MAX_HEADER,
    bytesPerCookie: BYTES_PER_COOKIE,
    threshold: THRESHOLD,
    remaining: count >= THRESHOLD ? 0 : THRESHOLD - count,
    level: count >= THRESHOLD ? 'danger' : count >= WARN_AT ? 'warn' : 'ok',
    updatedAt: new Date().toISOString(),
    ...extra,
  }
}

function localDay(now) {
  const date = now instanceof Date ? now : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

async function readState() {
  try {
    const raw = await readFile(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch (err) {
    return null
  }
}

async function writeState(state) {
  const file = stateFile()
  await mkdir(join(dshHome(), 'cookie-guard'), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * 记一条「当天快照」。同一天只写第一次，之后只更新条数，避免把文件搅成日志。
 */
async function stampToday(count, source) {
  const state = (await readState()) ?? {}
  const today = localDay()
  const history = Array.isArray(state.history) ? state.history : []
  const last = history[history.length - 1]
  const entry = { date: today, count, bytes: count * BYTES_PER_COOKIE, source, at: new Date().toISOString() }
  if (last !== undefined && last !== null && last.date === today) {
    history[history.length - 1] = entry
  } else {
    history.push(entry)
  }
  const trimmed = history.slice(-90)
  const next = { ...state, version: 1, lastCheck: entry, history: trimmed }
  await writeState(next)
  return next
}

export function apply(ctx) {
  const refusal = makeFence(ctx)
  /** 串行化状态文件的读写，避免并发 POST 把 history 写坏。 */
  let chain = Promise.resolve()

  function serial(task) {
    const run = chain.then(task, task)
    chain = run.catch(() => undefined)
    return run
  }

  function sendJson(response, status, body) {
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'no-store',
    })
    response.end(text)
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              const rejected = refusal(request)
              if (rejected !== undefined) {
                sendJson(response, rejected, { error: 'refused', status: rejected })
                return
              }
              const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
              const force = url.searchParams.get('force') === '1'

              if (request.method !== 'GET' && request.method !== 'POST') {
                response.writeHead(405, { allow: 'GET, POST' })
                response.end()
                return
              }

              const probe = await inspect(force)
              const state = await serial(() => (probe.ok ? stampToday(probe.count, probe.source) : readState()))
              const shared = {
                today: state === null || state.lastCheck === undefined ? null : state.lastCheck,
                history: state === null || state.history === undefined ? [] : state.history.slice(-7),
                forced: force,
                cached: probe.cached === true,
              }

              if (!probe.ok) {
                sendJson(response, 200, {
                  ok: false,
                  reason: probe.reason,
                  fileSize: probe.fileSize,
                  updatedAt: new Date().toISOString(),
                  ...shared,
                })
                return
              }

              sendJson(
                response,
                200,
                describe(probe.count, {
                  ok: true,
                  source: probe.source,
                  probeMs: probe.probeMs,
                  fileSize: probe.fileSize,
                  ...shared,
                }),
              )
            } catch (err) {
              try {
                sendJson(response, 500, { error: String(err === undefined || err === null ? err : err.message ?? err) })
              } catch (inner) {
                /* 头已经发出去了 */
              }
            }
          },
        }),
      'dsh-cookie-guard: api route',
    )
  })

  // 每日兜底：界面一天都没打开时，也按日期留一条快照。
  ctx.effect(() => {
    let stopped = false
    async function tick() {
      if (stopped) return
      try {
        const state = await serial(() => readState())
        const today = localDay()
        const last = state === null || state.lastCheck === undefined ? undefined : state.lastCheck
        if (last !== undefined && last !== null && last.date === today) return
        const probe = await inspect(false)
        if (stopped || !probe.ok) return
        await serial(() => stampToday(probe.count, 'host-timer'))
      } catch (err) {
        /* 定时器里不抛 */
      }
    }
    // 起机 15 秒后再补第一枪，避开外壳启动时最忙的那段。
    const initial = setTimeout(() => {
      void tick()
    }, 15 * 1000)
    const timer = setInterval(() => {
      void tick()
    }, TICK_MS)
    if (typeof initial.unref === 'function') initial.unref()
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, 'dsh-cookie-guard: daily check timer')
}
