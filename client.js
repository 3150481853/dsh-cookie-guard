window.__ModuleLoader__.load({ id: 'dsh-cookie-guard', factory(require) {
  const React = require('react')
  const h = React.createElement

  const API = '/dsh-cookie-guard/api'
  const POLL_MS = 60000
  const COLLAPSE_KEY = 'dsh.cookie-guard.collapsed'
  const POS_KEY = 'dsh.cookie-guard.pos'

  const CSS = `
.dcg-root{position:fixed;right:16px;bottom:16px;z-index:2147482000;pointer-events:auto;
  font-family:inherit;font-size:12px;line-height:1.4;color:#E8EEFF}
.dcg-card{width:268px;background:#0B1B3A;border:1px solid rgba(120,150,220,.22);border-radius:14px;
  box-shadow:0 18px 48px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.35);overflow:hidden}
.dcg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#142240;
  border-bottom:1px solid rgba(120,150,220,.14);cursor:grab;user-select:none}
.dcg-head:active{cursor:grabbing}
.dcg-mark{width:18px;height:18px;flex:none;border-radius:6px;background:#4D6BFE;color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.dcg-title{flex:1;font-weight:600;font-size:12.5px;letter-spacing:.2px}
.dcg-collapse{display:flex;align-items:center;gap:4px;flex:none;height:24px;padding:0 9px;
  border-radius:7px;border:1px solid rgba(120,150,220,.34);background:rgba(120,150,220,.12);
  color:#C9D8F5;font-size:11px;font-weight:600;line-height:1;cursor:pointer;
  transition:background .15s ease,color .15s ease,border-color .15s ease}
.dcg-collapse:hover{background:rgba(120,150,220,.28);color:#fff;border-color:rgba(140,170,240,.5)}
.dcg-collapse:active{background:rgba(120,150,220,.36)}
.dcg-body{padding:12px 12px 10px}
.dcg-ringwrap{display:flex;align-items:center;justify-content:center;padding:2px 0 8px}
.dcg-ring{display:block}
.dcg-pct{font-size:21px;font-weight:700;fill:#E8EEFF}
.dcg-pctsub{font-size:8.5px;fill:#8FA3C8;letter-spacing:.4px}
.dcg-stats{display:flex;gap:8px}
.dcg-stat{flex:1;background:#142240;border-radius:9px;padding:7px 4px;text-align:center;min-width:0}
.dcg-stat b{display:block;font-size:14.5px;font-weight:700;letter-spacing:.2px}
.dcg-stat span{display:block;font-size:9.5px;color:#8FA3C8;margin-top:2px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dcg-status{display:flex;align-items:center;gap:6px;margin:9px 0 8px;font-size:11.5px;color:#B9C9E6}
.dcg-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}
.dcg-btn{width:100%;border:0;border-radius:9px;padding:8px 0;font-size:12px;font-weight:600;
  cursor:pointer;background:#4D6BFE;color:#fff;transition:background .15s ease}
.dcg-btn:hover{background:#6E87FF}
.dcg-btn:active{background:#3A55E0}
.dcg-btn[disabled]{background:#2A3D68;color:#9DB2D8;cursor:default}
.dcg-note{margin-top:8px;font-size:9.5px;color:#6E82A8;line-height:1.45}
.dcg-pill{display:flex;align-items:center;gap:7px;background:#0B1B3A;border:1px solid rgba(120,150,220,.22);
  border-radius:999px;padding:6px 11px 6px 8px;box-shadow:0 10px 28px rgba(0,0,0,.4);cursor:grab;user-select:none}
.dcg-pill:active{cursor:grabbing}
.dcg-pill:hover{border-color:rgba(140,170,240,.45)}
.dcg-pill-go{display:flex;align-items:center;gap:2px;font-size:10px;color:#8FA3C8;margin-left:1px}
.dcg-pill .dcg-mark{width:16px;height:16px;border-radius:5px;font-size:10px}
.dcg-pill b{font-size:12.5px;font-weight:700}
.dcg-pill em{font-style:normal;font-size:10px;color:#8FA3C8}
`

  const LEVEL_COLOR = { ok: '#33D69F', warn: '#FFB020', danger: '#FF5A6E' }
  const LEVEL_TEXT = {
    ok: '余量充足',
    warn: '已过半，建议找时间清理',
    danger: '危险，随时会打不开',
  }
  const MUTED = '#8FA3C8'

  function clockOf(iso) {
    if (typeof iso !== 'string') return ''
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return ''
    const pad = function (n) {
      return String(n).padStart(2, '0')
    }
    return pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds())
  }

  function gaugeColor(level) {
    return LEVEL_COLOR[level] === undefined ? LEVEL_COLOR.ok : LEVEL_COLOR[level]
  }

  /** 读回上次拖到的位置；没有或读到脏数据就返回 null（回到右下角默认位）。 */
  function readPos() {
    try {
      const raw = window.localStorage.getItem(POS_KEY)
      if (raw === null) return null
      const value = JSON.parse(raw)
      if (value !== null && typeof value === 'object' && typeof value.x === 'number' && typeof value.y === 'number') {
        return { x: value.x, y: value.y }
      }
    } catch (err) {
      /* 隐私模式 / 脏数据：忽略，回默认位置 */
    }
    return null
  }

  function savePos(value) {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify(value))
    } catch (err) {
      /* 不可写就只当次生效 */
    }
  }

  /** 环形仪表：底环 + 进度弧，弧长按百分比算。 */
  function Ring(props) {
    const pct = props.pct
    const color = props.color
    const size = 104
    const stroke = 9
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    const dash = (circumference * pct) / 100
    return h(
      'svg',
      { className: 'dcg-ring', width: size, height: size, viewBox: '0 0 ' + size + ' ' + size },
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: '#2A3D68',
        strokeWidth: stroke,
      }),
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: color,
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeDasharray: dash + ' ' + (circumference - dash),
        transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
        style: { transition: 'stroke-dasharray .5s ease, stroke .3s ease' },
      }),
      h(
        'text',
        { x: '50%', y: '47%', textAnchor: 'middle', className: 'dcg-pct', fill: color },
        props.label === undefined ? pct + '%' : props.label,
      ),
      h('text', { x: '50%', y: '63%', textAnchor: 'middle', className: 'dcg-pctsub' }, '请求头占用'),
    )
  }

  function fmtK(bytes) {
    // 与桌面版 exe 一致：按 1024 进位（5472 → 5.3K），别用 1000 进位显示成 5.5K
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'K'
    return String(bytes)
  }

  /** 小箭头图标（收起/展开用），颜色跟随 currentColor。 */
  function Chevron(props) {
    const up = props.dir === 'up'
    return h(
      'svg',
      { width: 11, height: 11, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
      h('path', {
        d: up ? 'M2.5 7.5 6 4 9.5 7.5' : 'M2.5 4.5 6 8 9.5 4.5',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    )
  }

  function Stat(props) {
    return h(
      'div',
      { className: 'dcg-stat' },
      h('b', { style: { color: props.color === undefined ? '#E8EEFF' : props.color } }, props.value),
      h('span', null, props.label),
    )
  }

  function CookieGuard() {
    const [data, setData] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [collapsed, setCollapsed] = React.useState(function () {
      try {
        return window.localStorage.getItem(COLLAPSE_KEY) === '1'
      } catch (err) {
        return false
      }
    })
    const [pos, setPos] = React.useState(readPos)
    const rootRef = React.useRef(null)
    const dragRef = React.useRef(null)
    const posRef = React.useRef(pos)
    const movedRef = React.useRef(0)

    /** 按住标题栏/胶囊开始拖：记下指针与左上角的差，后续只算位移。 */
    function beginDrag(event) {
      if (event.button !== 0 && event.pointerType === 'mouse') return
      const node = rootRef.current
      if (node === null) return
      const rect = node.getBoundingClientRect()
      dragRef.current = {
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        w: rect.width,
        h: rect.height,
      }
      movedRef.current = 0
      const start = { x: rect.left, y: rect.top }
      posRef.current = start
      setPos(start)
    }

    /** 窗口变小 / 卡片尺寸变化后，把位置拉回可视区内，别让卡片飘到屏幕外。 */
    function clampIntoView() {
      const node = rootRef.current
      if (posRef.current === null || node === null) return
      const rect = node.getBoundingClientRect()
      const maxX = Math.max(0, window.innerWidth - rect.width)
      const maxY = Math.max(0, window.innerHeight - rect.height)
      const next = {
        x: Math.min(Math.max(0, Math.round(posRef.current.x)), maxX),
        y: Math.min(Math.max(0, Math.round(posRef.current.y)), maxY),
      }
      if (next.x === posRef.current.x && next.y === posRef.current.y) return
      posRef.current = next
      setPos(next)
      savePos(next)
    }

    React.useEffect(function () {
      function move(event) {
        const drag = dragRef.current
        if (drag === null) return
        movedRef.current += Math.abs(event.movementX) + Math.abs(event.movementY)
        const maxX = Math.max(0, window.innerWidth - drag.w)
        const maxY = Math.max(0, window.innerHeight - drag.h)
        const next = {
          x: Math.round(Math.min(Math.max(0, event.clientX - drag.dx), maxX)),
          y: Math.round(Math.min(Math.max(0, event.clientY - drag.dy), maxY)),
        }
        posRef.current = next
        setPos(next)
      }
      function stop() {
        if (dragRef.current === null) return
        dragRef.current = null
        if (posRef.current !== null) savePos(posRef.current)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
      window.addEventListener('resize', clampIntoView)
      return function () {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        window.removeEventListener('resize', clampIntoView)
      }
    }, [])

    // 折叠成胶囊或展开成卡片后尺寸会变，下一帧再校一次位置
    React.useEffect(
      function () {
        const id = window.requestAnimationFrame(clampIntoView)
        return function () {
          window.cancelAnimationFrame(id)
        }
      },
      [collapsed],
    )

    // 挂载后再兜一次：初始化时若读不到（存储尚未就绪 / 热更新重挂载），这里补上
    React.useEffect(function () {
      const saved = readPos()
      if (saved === null) return
      if (posRef.current !== null && posRef.current.x === saved.x && posRef.current.y === saved.y) return
      posRef.current = saved
      setPos(saved)
    }, [])

    const load = React.useCallback(function (force) {
      setBusy(true)
      setError(null)
      fetch(API + (force === true ? '?force=1' : ''), { credentials: 'include' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (body) {
          setData(body)
          setBusy(false)
        })
        .catch(function (err) {
          setError(err !== null && err !== undefined && err.message !== undefined ? err.message : String(err))
          setBusy(false)
        })
    }, [])

    React.useEffect(function () {
      load(false)
      const timer = window.setInterval(function () {
        load(false)
      }, POLL_MS)
      return function () {
        window.clearInterval(timer)
      }
    }, [load])

    function toggle() {
      setCollapsed(function (value) {
        const next = !value
        try {
          window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
        } catch (err) {
          /* 隐私模式下不可写，忽略 */
        }
        return next
      })
    }

    const ok = data !== null && data.ok === true
    const level = ok ? data.level : 'ok'
    const color = ok ? gaugeColor(level) : MUTED
    const pct = ok ? data.pct : 0
    const count = ok ? String(data.count) : '—'
    const bytes = ok ? fmtK(data.bytes) : '—'
    const remaining = ok ? String(data.remaining) : '—'
    // 拖过之后改用 left/top 定位；没拖过仍是右下角默认位（right/bottom）
    const rootStyle =
      pos === null ? undefined : { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }

    if (collapsed) {
      return h(
        'div',
        { className: 'dcg-root', ref: rootRef, style: rootStyle },
        h(
          'div',
          {
            className: 'dcg-pill',
            onPointerDown: beginDrag,
            onClick: function () {
              // 拖动结束后浏览器还会补一次 click，位移超过阈值就不当点击
              if (movedRef.current > 4) return
              toggle()
            },
            title: '按住可拖动，点击展开',
          },
          h('div', { className: 'dcg-mark' }, '盾'),
          h('b', { style: { color: color } }, ok ? pct + '%' : '—'),
          h('em', null, data === null ? '检测中' : ok ? data.count + ' 条' : '读取失败'),
          h('span', { className: 'dcg-pill-go' }, '展开', h(Chevron, { dir: 'up' })),
        ),
      )
    }

    let statusText
    if (error !== null) statusText = '检测失败：' + error
    else if (busy && data === null) statusText = '正在检测…'
    else if (data === null) statusText = '等待首次检测'
    else if (!ok) statusText = '读不到 cookie 库：' + (data.reason === undefined ? '未知原因' : data.reason)
    else statusText = LEVEL_TEXT[data.level] === undefined ? '未知' : LEVEL_TEXT[data.level]

    return h(
      'div',
      { className: 'dcg-root', ref: rootRef, style: rootStyle },
      h(
        'div',
        { className: 'dcg-card' },
        h(
          'div',
          { className: 'dcg-head', onPointerDown: beginDrag, title: '按住标题栏可拖动窗口' },
          h('div', { className: 'dcg-mark' }, '盾'),
          h('div', { className: 'dcg-title' }, 'Cookie 守护'),
          h(
            'button',
            {
              className: 'dcg-collapse',
              type: 'button',
              title: '收起成右下角的小胶囊',
              onPointerDown: function (event) {
                // 别让按钮上的按下被当成拖拽起手
                event.stopPropagation()
              },
              onClick: toggle,
            },
            h(Chevron, { dir: 'down' }),
            '收起',
          ),
        ),
        h(
          'div',
          { className: 'dcg-body' },
          h('div', { className: 'dcg-ringwrap' }, h(Ring, { pct: pct, color: color, label: ok ? undefined : '—' })),
          h(
            'div',
            { className: 'dcg-stats' },
            h(Stat, { value: count, label: 'cookie 条数' }),
            h(Stat, { value: bytes, label: '请求头字节' }),
            h(Stat, { value: remaining, label: '剩余次数', color: remaining === '0' ? color : undefined }),
          ),
          h(
            'div',
            { className: 'dcg-status' },
            h('i', { className: 'dcg-dot', style: { background: color } }),
            h('span', null, statusText),
          ),
          h(
            'button',
            {
              className: 'dcg-btn',
              type: 'button',
              disabled: busy,
              onClick: function () {
                load(true)
              },
            },
            busy ? '检测中…' : '立即检测',
          ),
          h(
            'div',
            { className: 'dcg-note' },
            ok
              ? '共 ' + data.count + ' 条，上限 ' + data.threshold + ' 条。每天自检一次，最近 ' +
                (data.today === null || data.today === undefined ? '—' : data.today.count + ' 条') +
                ' · 更新 ' + clockOf(data.updatedAt)
              : '每条 dsh-auth-* 约 228 字节，累计超过 71 条后请求头超过 16 KiB。',
          ),
        ),
      ),
    )
  }

  return {
    inject: ['slots'],
    apply(ctx) {
      ctx.effect(
        function () {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-cookie-guard')
          style.textContent = CSS
          document.head.appendChild(style)
          return function () {
            style.remove()
          }
        },
        'dsh-cookie-guard: styles',
      )

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'cookie-guard', order: 45, label: 'Cookie 守护' },
          CookieGuard,
        )
      })
    },
  }
} })
