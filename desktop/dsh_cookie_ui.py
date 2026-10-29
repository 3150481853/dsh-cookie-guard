# -*- coding: utf-8 -*-
"""DSH Cookie 检查 —— 图形界面版

规格对齐默认工作区的「自动远程桌面」项目：
  窗口 360x520（按 DPI 缩放）、无边框、圆角半径 14（优先 DWM，失败退 SetWindowRgn）、
  主色 #4D6BFE、底色 #0B1B3A、卡片 #142240。
不启动任何子进程（原来那个 py 闪三个黑框，就是 subprocess 调 powershell 造成的）。
"""
import ctypes
import ctypes.wintypes as w
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
from tkinter import messagebox

# ---------------------------------------------------------------- 规格常量
APP_TITLE = "DSH Cookie 检查"
BASE_W, BASE_H = 360, 520
CORNER_R = 14

BG = "#0B1B3A"
BOX = "#142240"
BOX_HI = "#1B2C50"
ACCENT = "#4D6BFE"
ACCENT_HOVER = "#6E87FF"
ACCENT_PRESS = "#3A55E0"
TEXT = "#E8EEFF"
MUTED = "#8FA0C4"
OK_C = "#33D69F"
WARN_C = "#FFB020"
DANGER_C = "#FF5A6E"
TRACK = "#2A3D68"

MAX_HEADER = 16384          # Node 默认 max-http-header-size
BYTES_PER_COOKIE = 228      # 52(name)+1(=)+173(value)+2("; ")
THRESHOLD = MAX_HEADER // BYTES_PER_COOKIE     # 71

DB_PATH = os.path.join(os.environ["APPDATA"], "@deepseek-ai", "dsh-desktop",
                       "Network", "Cookies")
PAT = re.compile(rb"dsh-auth-[A-Za-z0-9_-]{43}")

# ---------------------------------------------------------------- Win32
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
u32 = ctypes.WinDLL("user32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
gdi32 = ctypes.WinDLL("gdi32")

k32.OpenProcess.restype = w.HANDLE
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.DuplicateHandle.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE,
                                ctypes.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD]
k32.GetFinalPathNameByHandleW.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD]
k32.ReadFile.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD,
                         ctypes.POINTER(w.DWORD), ctypes.c_void_p]
k32.SetFilePointer.argtypes = [w.HANDLE, ctypes.c_long, ctypes.c_void_p, w.DWORD]
u32.GetParent.restype = w.HANDLE
u32.GetParent.argtypes = [w.HANDLE]
gdi32.CreateRoundRectRgn.restype = w.HANDLE
gdi32.CreateRoundRectRgn.argtypes = [ctypes.c_int] * 6
u32.SetWindowRgn.argtypes = [w.HANDLE, w.HANDLE, w.BOOL]

STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
PROCESS_DUP_HANDLE = 0x0040
DUPLICATE_SAME_ACCESS = 2
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2
GWL_EXSTYLE = -20
WS_EX_APPWINDOW = 0x00040000
SW_MINIMIZE = 6


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD),
                ("th32ProcessID", w.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", w.DWORD), ("cntThreads", w.DWORD),
                ("th32ParentProcessID", w.DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", w.DWORD), ("szExeFile", w.WCHAR * 260)]


def dsh_pids():
    """纯 Win32 枚举进程，不起子进程（所以不会闪黑框）。"""
    snap = k32.CreateToolhelp32Snapshot(2, 0)
    if snap in (None, w.HANDLE(-1).value):
        return set()
    out = set()
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    try:
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            name = entry.szExeFile
            if ("deepseek" in name.lower() or "dsh-desktop" in name.lower()) \
                    and entry.th32ProcessID != os.getpid():
                out.add(entry.th32ProcessID)
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return out


def _borrow_cookie_handle(pids):
    size = 1 << 22
    while size < (1 << 29):
        buf = ctypes.create_string_buffer(size)
        ret = ctypes.c_ulong(0)
        st = ntdll.NtQuerySystemInformation(64, buf, size,
                                            ctypes.byref(ret)) & 0xFFFFFFFF
        if st == STATUS_INFO_LENGTH_MISMATCH:
            size *= 2
            continue
        if st != 0:
            return None
        break
    else:
        return None
    num = ctypes.cast(buf, ctypes.POINTER(ctypes.c_size_t))[0]
    base = ctypes.addressof(buf) + 16
    me = k32.GetCurrentProcess()
    for i in range(num):
        e = base + i * 40
        pid = ctypes.cast(e + 8, ctypes.POINTER(ctypes.c_size_t))[0]
        hv = ctypes.cast(e + 16, ctypes.POINTER(ctypes.c_size_t))[0]
        if pid not in pids:
            continue
        ph = k32.OpenProcess(PROCESS_DUP_HANDLE, False, pid)
        if not ph:
            continue
        dup = w.HANDLE()
        ok = k32.DuplicateHandle(ph, w.HANDLE(hv), me, ctypes.byref(dup), 0,
                                 False, DUPLICATE_SAME_ACCESS)
        k32.CloseHandle(ph)
        if not ok:
            continue
        b = ctypes.create_unicode_buffer(1024)
        k32.GetFinalPathNameByHandleW(dup, b, 1024, 0)
        low = b.value.lower()
        if low.endswith("\\network\\cookies") and "partitions" not in low:
            return dup.value
        k32.CloseHandle(dup)
    return None


def _read_bytes():
    if not os.path.exists(DB_PATH):
        return None, False
    pids = dsh_pids()
    if not pids:
        try:
            with open(DB_PATH, "rb") as f:
                return f.read(), False
        except OSError:
            return None, False
    hd = _borrow_cookie_handle(pids)
    if not hd:
        return None, True
    hd = w.HANDLE(hd)
    k32.SetFilePointer(hd, 0, None, 0)
    buf = ctypes.create_string_buffer(1 << 16)
    n = w.DWORD(0)
    data = bytearray()
    while True:
        if not k32.ReadFile(hd, buf, 1 << 16, ctypes.byref(n), None):
            break
        if n.value == 0:
            break
        data.extend(buf.raw[:n.value])
    k32.CloseHandle(hd)
    return bytes(data), True


def probe():
    """返回一次完整体检结果。"""
    raw, running = _read_bytes()
    if raw is None:
        return {"ok": False, "running": running, "count": 0, "size": 0,
                "header": 0, "pct": 0.0, "remain": THRESHOLD, "level": "err",
                "detail": "读不到 Cookies 文件"}
    # 每个名字在表和唯一索引里各出现一次，所以 set 去重即可得到条数
    count = len(set(PAT.findall(raw)))
    header = count * BYTES_PER_COOKIE
    pct = header * 100.0 / MAX_HEADER
    remain = max(0, THRESHOLD - count)
    if count >= THRESHOLD - 8:
        level = "danger"
    elif count > THRESHOLD // 2:
        level = "warn"
    else:
        level = "ok"
    return {"ok": True, "running": running, "count": count, "size": len(raw),
            "header": header, "pct": pct, "remain": remain, "level": level,
            "detail": ""}


# ---------------------------------------------------------------- 清理菜单
MENU_NAME = "dsh-cookie-clean-menu.ps1"
CREATE_NO_WINDOW = 0x08000000

# 兜底：万一找不到 dsh-cookie-clean-menu.ps1，就用这段简单的
CLEAN_CMD_SIMPLE = r'''$p = "$env:APPDATA\@deepseek-ai\dsh-desktop\Network"
$n = @(Get-Process | Where-Object { $_.ProcessName -match 'deepseek|dsh' }).Count
if ($n -gt 0) {
  "DSH 还有 $n 个进程在跑，Cookies 被独占锁着，现在删不掉。先彻底退出 DSH（含托盘），再运行这条命令。"
} else {
  Remove-Item "$p\Cookies","$p\Cookies-journal" -Force -ErrorAction SilentlyContinue
  if (Test-Path "$p\Cookies") { "没删掉：文件仍被占用。" } else { "已清理，重新打开 DSH 并登录一次即可。" }
}'''


def menu_source_path():
    """按优先级找菜单脚本：打包目录 → exe 同级 → 源码同级 → 仓库根。"""
    cands = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        cands.append(meipass)
    if getattr(sys, "frozen", False):
        cands.append(os.path.dirname(os.path.abspath(sys.executable)))
    here = os.path.dirname(os.path.abspath(__file__))
    cands += [here, os.path.dirname(here), os.path.dirname(os.path.dirname(here))]
    for folder in cands:
        path = os.path.join(folder, MENU_NAME)
        if os.path.isfile(path):
            return path
    return None


def read_menu_script():
    path = menu_source_path()
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return fh.read()
    except OSError:
        return None


def stage_menu_script(text):
    """写到 %TEMP%，统一 UTF-8 BOM + CRLF —— PowerShell 5.1 没 BOM 会按 ANSI 读，中文全乱。"""
    target = os.path.join(tempfile.gettempdir(), MENU_NAME)
    body = text.replace("\r\n", "\n").replace("\n", "\r\n")
    with open(target, "w", encoding="utf-8-sig", newline="") as fh:
        fh.write(body)
    return target


def launch_command(menu_path):
    """复制进剪贴板的命令：在任意 PowerShell 里粘，弹 UAC，用管理员窗口跑菜单。"""
    return (
        '# 需要【管理员】权限：Win + X 打开「终端(管理员)」，粘贴回车\n'
        "Start-Process powershell -Verb RunAs -ArgumentList "
        "'-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',\"%s\"" % menu_path
    )


def spawn_menu(menu_path):
    cmd = (
        "Start-Process powershell -Verb RunAs -ArgumentList "
        "'-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',\"%s\"" % menu_path
    )
    subprocess.Popen(["powershell", "-NoProfile", "-Command", cmd],
                     creationflags=CREATE_NO_WINDOW)


# ---------------------------------------------------------------- 界面
class App:
    def __init__(self, root):
        self.root = root
        self.S = self._scale()
        S = self.S
        self.W = self.sc(BASE_W)
        self.H = self.sc(BASE_H)
        self.result = None
        self._busy = False
        self._dots = 0
        self._q = queue.Queue()

        root.title(APP_TITLE)
        root.overrideredirect(True)
        root.configure(bg=BG)
        root.resizable(False, False)
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        x = (sw - self.W) // 2
        y = (sh - self.H) // 2
        root.geometry("%dx%d+%d+%d" % (self.W, self.H, x, y))
        root.update_idletasks()
        self.hwnd = u32.GetParent(root.winfo_id())
        self._taskbar_presence()
        self._rounded()
        self._fonts()
        self._build()
        self.refresh()

    # -- 工具
    def sc(self, v):
        return int(round(v * self.S))

    def _scale(self):
        forced = os.environ.get("DSH_COOKIE_SCALE")   # 仅用于测试不同缩放
        if forced:
            try:
                return max(1.0, min(3.0, float(forced)))
            except ValueError:
                pass
        try:
            dpi = u32.GetDpiForSystem()
        except Exception:
            dpi = 96
        return max(1.0, min(3.0, dpi / 96.0))

    def _fonts(self):
        fam = "Microsoft YaHei UI"
        avail = set(tkfont.families())
        if fam not in avail:
            fam = "Microsoft YaHei" if "Microsoft YaHei" in avail else "Segoe UI"

        # 关键：Tk 里字体大小的"正数"单位是磅，会再乘一次 tk scaling（即系统 DPI
        # 缩放）。这里坐标已经按 S 放大过，字体再被乘一次就成了 S² 倍 ——
        # 150% 缩放下字会撑破卡片、和别的控件叠在一起。
        # 所以一律用负数 = 像素，Tk 不再做任何换算，尺寸完全由 S 决定。
        def f(px, weight=None):
            spec = (fam, -self.sc(px))
            return spec + ((weight,) if weight else ())

        self.f_small = f(9)
        self.f_body = f(10)
        self.f_bold = f(10, "bold")
        self.f_big = f(26, "bold")
        self.f_stat = f(17, "bold")
        self.f_title = f(10, "bold")

    def _taskbar_presence(self):
        try:
            ex = u32.GetWindowLongW(self.hwnd, GWL_EXSTYLE)
            u32.SetWindowLongW(self.hwnd, GWL_EXSTYLE, ex | WS_EX_APPWINDOW)
        except Exception:
            pass

    def _rounded(self):
        """圆角裁剪。

        注：实测无边框窗口上 DwmSetWindowAttribute(33) 会返回 0，
        但对 WS_POPUP 并不真正生效（清了 Region 就是直角），所以这里只用
        SetWindowRgn —— 与 auto-rdp 的 ReapplyRegion 兜底路径一致。
        """
        r = self.sc(CORNER_R)
        try:
            rgn = gdi32.CreateRoundRectRgn(0, 0, self.W + 1, self.H + 1,
                                           r * 2, r * 2)
            u32.SetWindowRgn(self.hwnd, rgn, True)
        except Exception:
            pass

    def _drag(self, ev):
        self._drag_from = (ev.x_root - self.root.winfo_x(),
                           ev.y_root - self.root.winfo_y())

    def _drag_move(self, ev):
        if getattr(self, "_drag_from", None):
            dx, dy = self._drag_from
            self.root.geometry("+%d+%d" % (ev.x_root - dx, ev.y_root - dy))

    # -- 布局
    def _build(self):
        S, sc = self.S, self.sc
        bar_h = sc(40)

        # 顶栏
        bar = tk.Frame(self.root, bg=ACCENT, height=bar_h)
        bar.place(x=0, y=0, width=self.W, height=bar_h)
        bar.pack_propagate(False)
        title = tk.Label(bar, text=APP_TITLE, bg=ACCENT, fg="#FFFFFF",
                         font=self.f_title, anchor="w")
        title.place(x=sc(16), y=0, height=bar_h)
        for widget in (bar, title):
            widget.bind("<Button-1>", self._drag)
            widget.bind("<B1-Motion>", self._drag_move)

        def title_btn(text, x, cmd, hover_bg):
            b = tk.Label(bar, text=text, bg=ACCENT, fg="#FFFFFF",
                         font=(self.f_body[0], -sc(12)), cursor="hand2")
            b.place(x=x, y=sc(4), width=sc(32), height=sc(32))
            b.bind("<Enter>", lambda e: b.configure(bg=hover_bg))
            b.bind("<Leave>", lambda e: b.configure(bg=ACCENT))
            b.bind("<Button-1>", lambda e: cmd())
            return b

        title_btn("—", self.W - sc(72), self._minimize, ACCENT_HOVER)
        title_btn("✕", self.W - sc(36), self.root.destroy, "#E5484D")

        # 副标题 + 上次检测时间（同一行，一居中一靠右，互不打架）
        self.sub = tk.Label(self.root, text="DSH 登录 cookie 泄漏自查",
                            bg=BG, fg=MUTED, font=self.f_small)
        self.sub.place(x=0, y=sc(52), width=self.W)
        self.stamp = tk.Label(self.root, text="", bg=BG, fg=MUTED,
                              font=self.f_small, anchor="e")
        # 只占右边一小条，否则这块背景会把居中的副标题整个盖住
        self.stamp.place(x=self.W - sc(14) - sc(64), y=sc(52), width=sc(64))

        # 环形仪表
        self.gauge = tk.Canvas(self.root, width=sc(148), height=sc(148),
                               bg=BG, highlightthickness=0)
        self.gauge.place(x=(self.W - sc(148)) // 2, y=sc(72))
        self._draw_gauge(0, MUTED)

        # 三格统计
        self.stat_vals = []
        self.stat_lbls = []
        bw = sc(102)
        gap = sc(10)
        left = (self.W - bw * 3 - gap * 2) // 2
        for i, cap in enumerate(("cookie 条数", "请求头字节", "剩余次数")):
            x = left + i * (bw + gap)
            box = tk.Frame(self.root, bg=BOX)
            box.place(x=x, y=sc(232), width=bw, height=sc(58))
            val = tk.Label(box, text="—", bg=BOX, fg=TEXT, font=self.f_stat)
            val.place(x=0, y=sc(8), width=bw)
            lbl = tk.Label(box, text=cap, bg=BOX, fg=MUTED, font=self.f_small)
            lbl.place(x=0, y=sc(34), width=bw)
            self.stat_vals.append(val)
            self.stat_lbls.append(lbl)

        # 状态行
        self.dot = tk.Canvas(self.root, width=sc(10), height=sc(10),
                             bg=BG, highlightthickness=0)
        self.dot.place(x=sc(18), y=sc(302))
        self.dot_dot = self.dot.create_oval(0, 0, sc(10), sc(10),
                                            fill=MUTED, outline="")
        self._status_text = "正在检测…"
        self.status = tk.Label(self.root, text=self._status_text, bg=BG, fg=TEXT,
                               font=self.f_body, anchor="w")
        self.status.place(x=sc(34), y=sc(297), width=self.W - sc(52))

        # 按钮
        top = sc(324)
        self.btn_recheck = self._button("重新检测", sc(16), top, sc(156),
                                        self.refresh, filled=False)
        self._button("打开目录", sc(184), top, sc(156), self.open_dir,
                     filled=False)
        self._button("复制清理命令", sc(16), top + sc(44), self.W - sc(32),
                     self.copy_cmd, filled=True)

        # 说明
        self.hint = tk.Label(self.root, text="", bg=BG, fg=MUTED,
                             font=self.f_small, justify="left", anchor="nw",
                             wraplength=self.W - sc(36))
        self.hint.place(x=sc(18), y=sc(416), width=self.W - sc(36),
                        height=sc(96))

    def _button(self, text, x, y, width, cmd, filled):
        bg = ACCENT if filled else BOX
        fg = "#FFFFFF" if filled else TEXT
        hover = ACCENT_HOVER if filled else BOX_HI
        press = ACCENT_PRESS if filled else TRACK
        b = tk.Label(self.root, text=text, bg=bg, fg=fg, font=self.f_bold,
                     cursor="hand2")
        b.place(x=x, y=y, width=width, height=self.sc(38))
        b.bind("<Enter>", lambda e: b.configure(bg=hover))
        b.bind("<Leave>", lambda e: b.configure(bg=bg))
        b.bind("<Button-1>", lambda e: b.configure(bg=press))
        b.bind("<ButtonRelease-1>", lambda e: (b.configure(bg=hover), cmd()))
        return b

    def _draw_gauge(self, pct, color):
        c = self.gauge
        c.delete("all")
        pad = self.sc(14)
        box = (pad, pad, self.sc(148) - pad, self.sc(148) - pad)
        width = self.sc(11)
        c.create_arc(*box, start=0, extent=360, style="arc",
                     outline=TRACK, width=width)
        if pct > 0:
            extent = -360.0 * min(pct, 100.0) / 100.0
            c.create_arc(*box, start=90, extent=extent, style="arc",
                         outline=color, width=width)
        c.create_text(self.sc(74), self.sc(64), text="%d%%" % round(pct),
                      fill=color, font=self.f_big)
        c.create_text(self.sc(74), self.sc(94), text="请求头占用",
                      fill=MUTED, font=self.f_small)

    # -- 检测：读文件放到后台线程，主线程只管转圈动画，窗口不会假死
    def refresh(self):
        if self._busy:
            return
        self._busy = True
        self._dots = 0
        self.btn_recheck.configure(bg=TRACK, fg=MUTED, text="检测中")
        self.root.configure(cursor="watch")
        self._tick()
        self.root.after(120, self._poll)
        threading.Thread(target=self._probe_worker, daemon=True).start()

    def _poll(self):
        """主线程轮询队列 —— Tk 不是线程安全的，工作线程里绝不能碰控件。"""
        try:
            r = self._q.get_nowait()
        except queue.Empty:
            if self._busy:
                self.root.after(120, self._poll)
            return
        try:
            self._apply(r)
        except Exception as exc:      # 渲染出错也要把界面从"检测中"救回来
            self._busy = False
            self.btn_recheck.configure(bg=BOX, fg=TEXT, text="重新检测")
            self.root.configure(cursor="")
            self.status.configure(text="检测失败：%s" % exc, fg=DANGER_C)

    def _tick(self):
        """按钮上的「检测中…」点点动画。"""
        if not self._busy:
            return
        self._dots = (self._dots + 1) % 4
        self.btn_recheck.configure(text="检测中" + "." * self._dots)
        self.root.after(320, self._tick)

    def _probe_worker(self):
        try:
            r = probe()
        except Exception as exc:          # 兜底：线程里抛异常别静默死掉
            r = {"ok": False, "running": False, "count": 0, "size": 0,
                 "header": 0, "pct": 0.0, "remain": THRESHOLD,
                 "level": "err", "detail": str(exc)}
        self._q.put(r)

    def _flash(self):
        """数字闪一下高亮色，明确告诉用户"刷新过了"。"""
        for v in self.stat_vals:
            v.configure(fg=ACCENT_HOVER)
        self.root.after(420, lambda: [v.configure(fg=TEXT)
                                      for v in self.stat_vals])

    def _apply(self, r):
        self._busy = False
        self.btn_recheck.configure(bg=BOX, fg=TEXT, text="重新检测")
        self.root.configure(cursor="")
        self.result = r
        self.stamp.configure(text=time.strftime("%H:%M:%S"))
        if not r["ok"]:
            self._draw_gauge(0, DANGER_C)
            self.dot.itemconfigure(self.dot_dot, fill=DANGER_C)
            self.status.configure(text="读取失败 · %s" % r["detail"],
                                  fg=DANGER_C)
            for v in self.stat_vals:
                v.configure(text="—")
            self.hint.configure(
                text="没找到 Cookies 文件，可能 DSH 桌面版没装在默认位置。")
            return

        color = {"ok": OK_C, "warn": WARN_C, "danger": DANGER_C}[r["level"]]
        self._draw_gauge(r["pct"], color)
        self.stat_vals[0].configure(text=str(r["count"]))
        kb = r["header"] / 1024.0
        self.stat_vals[1].configure(text=("%.1fK" % kb) if kb < 10
                                    else ("%dK" % round(kb)))
        self.stat_vals[2].configure(text=str(r["remain"]))

        self.dot.itemconfigure(self.dot_dot, fill=color)
        state = "DSH 正在运行" if r["running"] else "DSH 未运行"
        word = {"ok": "余量充足", "warn": "已过半，建议清理",
                "danger": "危险，随时会打不开"}[r["level"]]
        self._status_text = "%s · %s" % (state, word)
        self.status.configure(text=self._status_text, fg=color)
        self._flash()

        if r["level"] == "ok":
            self.hint.configure(
                text="每条 cookie 约 %d 字节，累计超过 %d 条后请求头超过 "
                     "16 KiB，DSH 会以 Web authentication failed 打不开。\n"
                     "当前 Cookie 文件 %.0f KB，无需处理。"
                     % (BYTES_PER_COOKIE, THRESHOLD, r["size"] / 1024.0))
        else:
            self.hint.configure(
                text="已积累 %d 条，距上限只剩 %d 次启动。\n"
                     "点「复制清理命令」→ 到【管理员】PowerShell 粘贴运行。\n"
                     "会话、插件、配置都不受影响。"
                     % (r["count"], r["remain"]))

    def _minimize(self):
        u32.ShowWindow(w.HANDLE(self.hwnd), SW_MINIMIZE)

    def open_dir(self):
        folder = os.path.dirname(DB_PATH)
        if os.path.isdir(folder):
            os.startfile(folder)
        else:
            self.hint.configure(text="目录不存在：%s" % folder)

    def _restore_status(self):
        level = (self.result or {}).get("level", "ok")
        self.status.configure(
            text=self._status_text, fg={"ok": OK_C, "warn": WARN_C,
                                        "danger": DANGER_C}.get(level, TEXT))

    def copy_cmd(self):
        script = read_menu_script()
        menu_path = None
        if script:
            try:
                menu_path = stage_menu_script(script)
                text = launch_command(menu_path)
            except OSError as err:
                self.hint.configure(text="写临时脚本失败：%s" % err)
                return
        else:
            text = CLEAN_CMD_SIMPLE

        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status.configure(text="已复制 · 请到【管理员】PowerShell 粘贴",
                              fg=ACCENT_HOVER)

        if menu_path:
            yes = messagebox.askyesno(
                "清理菜单已就绪",
                "清理菜单的命令已复制到剪贴板。\n\n"
                "请用【管理员】权限运行：\n"
                "  ① Win + X → 终端(管理员)  (或 Windows PowerShell 管理员)\n"
                "  ② 右键粘贴 → 回车\n\n"
                "会弹出一个带菜单的清理面板\n"
                "（脚本已生成在 %%TEMP%%\\%s）\n\n"
                "现在就替你打开管理员窗口吗？" % MENU_NAME,
                parent=self.root)
            if yes:
                try:
                    spawn_menu(menu_path)
                except OSError as err:
                    self.hint.configure(text="打不开管理员窗口：%s" % err)

        self.root.after(2800, self._restore_status)


def main():
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.WinDLL("user32").SetProcessDPIAware()
        except Exception:
            pass
    root = tk.Tk()
    App(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
