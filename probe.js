/**
 * 读 Chromium 的 cookie 库，数出 jar 里到底攒了多少条 `dsh-auth-*`。
 *
 * 为什么这么绕：DSH 运行期间，桌面外壳对 `Network/Cookies` 是独占打开，任何
 * 常规 `open()` 都拿到 ERROR_SHARING_VIOLATION(32)；而 renderer 的请求又是
 * 经 IPC 单条注入转发的，`Cookie` 头里只会出现当前这一次启动的那一条，看不
 * 出 jar 的真实体积。唯一可靠的办法是"借"外壳进程已经打开的那个句柄 —— 先
 * 用 NtQuerySystemInformation 枚举全机句柄表，再对目标进程 DuplicateHandle，
 * 在副本上读。Node 没有 FFI，所以借 DSH 自带的那份 koffi 原生模块来调用
 * Win32；拿不到就退化成"读不了"，绝不猜数。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

const COOKIE_PATTERN = /dsh-auth-[A-Za-z0-9_-]{43}/g
const TARGET_SUFFIX = `${sep}network${sep}cookies`.toLowerCase()
const HANDLE_ENTRY_STRIDE = 40

export function cookieDatabasePath() {
  const override = process.env.DSH_COOKIE_GUARD_DB
  if (typeof override === 'string' && override.trim() !== '') return override
  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || appData === '') {
    return join(homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  }
  return join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

/** DSH 自带的 koffi 在不同安装方式下位置不同，按可能性依次找。 */
function koffiCandidates() {
  const override = process.env.DSH_COOKIE_GUARD_KOFFI
  const out = []
  if (typeof override === 'string' && override.trim() !== '') out.push(override)
  const roots = []
  if (typeof process.resourcesPath === 'string') roots.push(process.resourcesPath)
  const execPath = process.execPath ?? ''
  if (execPath !== '') {
    roots.push(join(execPath, '..', 'resources'))
    roots.push(join(execPath, '..'))
  }
  for (const root of roots) {
    out.push(join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs'))
    out.push(join(root, 'dsh', 'node_modules', 'koffi', 'index.cjs'))
    out.push(join(root, 'node_modules', 'koffi', 'index.cjs'))
  }
  return out
}

let ffiCache

function loadFfi() {
  if (ffiCache !== undefined) return ffiCache
  if (process.platform !== 'win32') {
    ffiCache = { ok: false, reason: '仅支持 Windows' }
    return ffiCache
  }
  for (const candidate of koffiCandidates()) {
    try {
      statSync(candidate)
    } catch {
      continue
    }
    try {
      const require = createRequire(import.meta.url)
      const koffi = require(candidate)
      const k32 = koffi.load('kernel32.dll')
      const ntdll = koffi.load('ntdll.dll')
      ffiCache = {
        ok: true,
        k32,
        ntdll,
        api: {
          CreateToolhelp32Snapshot: k32.func('void * __stdcall CreateToolhelp32Snapshot(uint32, uint32)'),
          Process32FirstW: k32.func('int32 __stdcall Process32FirstW(void *, void *)'),
          Process32NextW: k32.func('int32 __stdcall Process32NextW(void *, void *)'),
          OpenProcess: k32.func('void * __stdcall OpenProcess(uint32, int32, uint32)'),
          CloseHandle: k32.func('int32 __stdcall CloseHandle(void *)'),
          DuplicateHandle: k32.func(
            'int32 __stdcall DuplicateHandle(void *, void *, void *, void **, uint32, int32, uint32)',
          ),
          GetFinalPathNameByHandleW: k32.func(
            'uint32 __stdcall GetFinalPathNameByHandleW(void *, void *, uint32, uint32)',
          ),
          SetFilePointer: k32.func('uint32 __stdcall SetFilePointer(void *, int32, void *, uint32)'),
          ReadFile: k32.func('int32 __stdcall ReadFile(void *, void *, uint32, uint32 *, void *)'),
          GetCurrentProcess: k32.func('void * __stdcall GetCurrentProcess()'),
          NtQuerySystemInformation: ntdll.func(
            'long __stdcall NtQuerySystemInformation(uint32, void *, uint32, uint32 *)',
          ),
        },
      }
      return ffiCache
    } catch (err) {
      ffiCache = { ok: false, reason: `koffi 加载失败：${err === undefined || err === null ? err : err.message ?? err}` }
      return ffiCache
    }
  }
  ffiCache = { ok: false, reason: '没找到 DSH 自带的 koffi' }
  return ffiCache
}

function cookieProcesses(api) {
  const snapshot = api.CreateToolhelp32Snapshot(0x2, 0)
  if (snapshot === null || snapshot === undefined || snapshot === 0n) return []
  const entry = Buffer.alloc(568)
  entry.writeUInt32LE(568, 0)
  const found = []
  let more = api.Process32FirstW(snapshot, entry)
  while (more) {
    const pid = entry.readUInt32LE(8)
    const exe = entry
      .toString('utf16le', 44, 44 + 520)
      .split('\u0000')[0]
      .toLowerCase()
    if ((exe.includes('deepseek') || exe.includes('dsh-desktop')) && pid !== process.pid) {
      found.push(pid)
    }
    more = api.Process32NextW(snapshot, entry)
  }
  api.CloseHandle(snapshot)
  return found
}

/** 借一个已经打开的句柄，把整个文件读进内存。 */
function readThroughOpenHandle(api, pids) {
  let size = 32 << 20
  let table = Buffer.alloc(size)
  const needed = Buffer.alloc(4)
  let status = api.NtQuerySystemInformation(64, table, size, needed) >>> 0
  if (status === 0xc0000004) {
    size = needed.readUInt32LE(0) + (4 << 20)
    table = Buffer.alloc(size)
    status = api.NtQuerySystemInformation(64, table, size, needed) >>> 0
  }
  if (status !== 0) throw new Error(`NtQuerySystemInformation 0x${status.toString(16)}`)

  const total = table.readUInt32LE(0)
  const wanted = new Set(pids)
  const self = api.GetCurrentProcess()
  const pathBuffer = Buffer.alloc(4096 * 2)
  const handleOut = Buffer.alloc(8)
  const readBuffer = Buffer.alloc(1 << 20)
  const readOut = Buffer.alloc(4)

  for (let index = 0; index < total; index += 1) {
    const base = 16 + index * HANDLE_ENTRY_STRIDE
    const pid = Number(table.readBigUInt64LE(base + 8))
    if (!wanted.has(pid)) continue
    const handle = table.readBigUInt64LE(base + 16)
    const processHandle = api.OpenProcess(0x40, 0, pid)
    if (processHandle === null || processHandle === undefined || processHandle === 0n) continue
    let copied = 0
    try {
      copied = api.DuplicateHandle(processHandle, handle, self, handleOut, 0, 0, 0x2)
    } catch {
      copied = 0
    }
    api.CloseHandle(processHandle)
    if (!copied) continue

    const duplicate = handleOut.readBigUInt64LE(0)
    const length = api.GetFinalPathNameByHandleW(duplicate, pathBuffer, 4096, 0)
    const path = length ? pathBuffer.toString('utf16le', 0, length * 2).toLowerCase() : ''
    if (!path.endsWith(TARGET_SUFFIX) || path.includes('partitions')) {
      api.CloseHandle(duplicate)
      continue
    }
    api.SetFilePointer(duplicate, 0, null, 0)
    const chunks = []
    for (;;) {
      const ok = api.ReadFile(duplicate, readBuffer, readBuffer.length, readOut, null)
      const count = readOut.readUInt32LE(0)
      if (!ok || count === 0) break
      chunks.push(Buffer.from(readBuffer.subarray(0, count)))
      if (count < readBuffer.length) break
    }
    api.CloseHandle(duplicate)
    return Buffer.concat(chunks)
  }
  return null
}

function readDirectly(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const size = statSync(file).size
      const buffer = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const got = readSync(fd, buffer, offset, size - offset, offset)
        if (got <= 0) break
        offset += got
      }
      return buffer.subarray(0, offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function countNames(raw) {
  const names = new Set()
  const text = raw.toString('latin1')
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(text)) !== null) names.add(match[0])
  return names.size
}

const pattern = COOKIE_PATTERN

/**
 * @returns {{ok: true, count: number, bytes: number, source: string, fileSize: number, elapsedMs: number}
 *          | {ok: false, reason: string, fileSize?: number}}
 */
export function probeJar() {
  const startedAt = Date.now()
  const file = cookieDatabasePath()
  let fileSize
  try {
    fileSize = statSync(file).size
  } catch {
    return { ok: false, reason: `找不到 cookie 库：${file}` }
  }

  const direct = readDirectly(file)
  if (direct !== null && direct.length > 0) {
    return {
      ok: true,
      count: countNames(direct),
      source: 'file',
      fileSize,
      elapsedMs: Date.now() - startedAt,
    }
  }

  const ffi = loadFfi()
  if (!ffi.ok) return { ok: false, reason: ffi.reason === undefined ? '读不了 cookie 库' : ffi.reason, fileSize }

  const pids = cookieProcesses(ffi.api)
  if (pids.length === 0) {
    return { ok: false, reason: 'DSH 正在运行，但没有找到可借句柄的进程', fileSize }
  }

  let raw = null
  try {
    raw = readThroughOpenHandle(ffi.api, pids)
  } catch (err) {
    return {
      ok: false,
      reason: `借句柄失败：${err === undefined || err === null ? err : err.message ?? err}`,
      fileSize,
    }
  }
  if (raw === null || raw.length === 0) {
    return { ok: false, reason: '没能从运行中的 DSH 借到 cookie 库句柄', fileSize }
  }
  return {
    ok: true,
    count: countNames(raw),
    source: 'borrowed-handle',
    fileSize,
    elapsedMs: Date.now() - startedAt,
  }
}

export function peekFileSize() {
  try {
    return statSync(cookieDatabasePath()).size
  } catch {
    return undefined
  }
}
