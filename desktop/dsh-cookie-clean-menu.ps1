# =====================================================================
#  DSH Cookie 守护 · 命令行清理菜单  (dsh-cookie-clean-menu.ps1)
#
#  作用：查/删 DSH 桌面版累积的 dsh-auth-* 登录 cookie。
#  建议：在【管理员】PowerShell 里运行
#        Win + X  →  终端(管理员)  →  粘贴本文件路径回车
#
#  参数：无（本文件是交互菜单，不要加 -Clean 之类）
# =====================================================================

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- 配色
$C = @{
    Title = 'Cyan'
    Ok    = 'Green'
    Warn  = 'Yellow'
    Bad   = 'Red'
    Dim   = 'DarkGray'
    Acc   = 'Magenta'
    Line  = 'DarkCyan'
}

$script:BAR = ('=' * 66)
$script:MAX_COOKIES = 16384 / 228      # ≈ 71.86 → 第 72 次启动就炸

# ---------------------------------------------------------------- 输出
function Write-Bar {
    param([string]$Char = '=', [string]$Color = $C.Line)
    Write-Host ('  ' + ($Char * 66)) -ForegroundColor $Color
}

function Write-Title {
    param([string]$Text)
    Write-Host ''
    Write-Host ('  > ' + $Text) -ForegroundColor $C.Title
}

function Write-Ok {
    param([string]$Text)
    Write-Host ('      [ OK ] ' + $Text) -ForegroundColor $C.Ok
}

function Write-Warn2 {
    param([string]$Text)
    Write-Host ('      [注意] ' + $Text) -ForegroundColor $C.Warn
}

function Write-Bad {
    param([string]$Text)
    Write-Host ('      [失败] ' + $Text) -ForegroundColor $C.Bad
}

function Write-Info {
    param([string]$Text)
    Write-Host ('             ' + $Text) -ForegroundColor $C.Dim
}

function Pause-Any {
    Write-Host ''
    Write-Host '      按回车返回菜单…' -ForegroundColor $C.Dim -NoNewline
    [void](Read-Host)
}

# ---------------------------------------------------------------- 环境
function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-DshProcs {
    $out = @()
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
        $n = ''
        try { $n = $p.ProcessName.ToLower() } catch { continue }
        if ($n -like '*deepseek*' -or $n -like 'dsh*' -or $n -like '*dsh-desktop*') {
            $out += $p
        }
    }
    return $out
}

# 找出所有可能的 cookie 主库 / 分区库
# 注意：Electron 的 userData 路径可能是
#   %APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies      ← 多一层
#   %APPDATA%\DeepSeek Harness\Network\Cookies              ← 少一层
# 所以名字命中的目录本身和它下一层目录都要看。
function Get-CookieDbs {
    $roots = @()
    if ($env:APPDATA) { $roots += $env:APPDATA }
    if ($env:LOCALAPPDATA) { $roots += $env:LOCALAPPDATA }

    $found = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $tops = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'deepseek|dsh' }
        $cands = @()
        foreach ($d in $tops) {
            $cands += $d.FullName
            foreach ($s in (Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue)) {
                $cands += $s.FullName
            }
        }
        foreach ($c in $cands) {
            $main = Join-Path $c 'Network\Cookies'
            if (Test-Path -LiteralPath $main) {
                $found += [pscustomobject]@{ Path = $main; Kind = '主库'; Root = $c }
            }
            $parts = Join-Path $c 'Partitions'
            if (Test-Path -LiteralPath $parts) {
                foreach ($pd in (Get-ChildItem -LiteralPath $parts -Directory -ErrorAction SilentlyContinue)) {
                    $pp = Join-Path $pd.FullName 'Network\Cookies'
                    if (Test-Path -LiteralPath $pp) {
                        $found += [pscustomobject]@{ Path = $pp; Kind = '分区'; Root = $pd.FullName }
                    }
                }
            }
        }
    }
    return $found
}

# 读字节数 dsh-auth-* 的条数；被锁时返回 -1
function Count-Cookies {
    param([string]$Path)
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                                     [System.IO.FileAccess]::Read,
                                     [System.IO.FileShare]::ReadWrite)
        try {
            $len = [int]$fs.Length
            $buf = New-Object byte[] $len
            $read = $fs.Read($buf, 0, $len)
        } finally {
            $fs.Dispose()
        }
        $latin1 = [System.Text.Encoding]::GetEncoding(28591)
        $text = $latin1.GetString($buf, 0, $read)
        $seen = @{}
        foreach ($m in [regex]::Matches($text, 'dsh-auth-[A-Za-z0-9_\-]{43}')) {
            $seen[$m.Value] = 1
        }
        return $seen.Count
    } catch {
        return -1
    }
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0} B' -f $Bytes)
}

# ---------------------------------------------------------------- 状态面板

# 分区库的路径里那串 GUID 太长，会把整行顶到换行；只留前 12 位
function Format-DbPath {
    param([string]$Path)
    return ($Path -replace '\\Partitions\\([^\\]{12})[^\\]*\\', '\Partitions\$1…\')
}

function Show-Status {
    $procs = @(Get-DshProcs)
    $dbs = @(Get-CookieDbs)

    Write-Title '当前状态'

    if ($procs.Count -eq 0) {
        Write-Ok 'DSH 进程：0 个（可以安全清理）'
    } else {
        Write-Warn2 ('DSH 进程：{0} 个 —— cookie 库被独占锁着，删之前必须先结束它们' -f $procs.Count)
        $i = 0
        foreach ($p in $procs) {
            if ($i -ge 6) { Write-Info ('… 另有 ' + ($procs.Count - 6) + ' 个未列出'); break }
            Write-Info ('  pid {0,-7} {1}' -f $p.Id, $p.ProcessName)
            $i++
        }
    }

    if ($dbs.Count -eq 0) {
        Write-Bad '没找到任何 cookie 库 —— 这台机器可能不是桌面版 DSH'
        Write-Info '（只查了 %APPDATA% 和 %LOCALAPPDATA% 里名字含 deepseek / dsh 的目录）'
    }

    foreach ($db in $dbs) {
        Write-Host ''
        Write-Host ('      [' + $db.Kind + '] ' + (Format-DbPath $db.Path)) -ForegroundColor $C.Acc
        try {
            $f = Get-Item -LiteralPath $db.Path -Force
            $sizeText = Format-Size $f.Length
            $timeText = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
        } catch {
            $sizeText = '?'
            $timeText = '?'
        }
        $n = Count-Cookies $db.Path
        if ($n -lt 0) {
            Write-Info ('大小 ' + $sizeText + ' · 写于 ' + $timeText + ' · dsh-auth-* 读不到（被 DSH 占着）')
        } else {
            $pct = [math]::Round(($n * 228) / 16384 * 100, 0)
            $left = [int][math]::Floor($script:MAX_COOKIES) - $n
            if ($left -lt 0) { $left = 0 }
            $color = $C.Ok
            if ($n -ge 72) { $color = $C.Bad }
            elseif ($n -ge 36) { $color = $C.Warn }
            Write-Host ('            大小 ' + $sizeText + ' · 写于 ' + $timeText) -ForegroundColor $C.Dim
            Write-Host ('            dsh-auth-* ' + $n + ' 条 · 占请求头约 ' + $pct + '% · 还能启动约 ' + $left + ' 次') -ForegroundColor $color
        }
    }
    Write-Host ''
}

# ---------------------------------------------------------------- 动作
function Stop-DshProcs {
    $procs = @(Get-DshProcs)
    if ($procs.Count -eq 0) {
        Write-Ok '没有需要结束的进程'
        return $true
    }
    Write-Info ('结束 ' + $procs.Count + ' 个 DSH 进程（未保存的内容会丢）…')
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Write-Ok ('已结束 pid ' + $p.Id)
        } catch {
            Write-Bad ('结束 pid ' + $p.Id + ' 失败：' + $_.Exception.Message)
        }
    }
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 250
        if (@(Get-DshProcs).Count -eq 0) { break }
    }
    $left = @(Get-DshProcs).Count
    if ($left -eq 0) {
        Write-Ok 'DSH 进程已全部退出，cookie 库解锁'
        return $true
    }
    Write-Bad ('还有 ' + $left + ' 个进程没退掉 —— 试试以管理员身份重开这个窗口')
    return $false
}

function Backup-Db {
    param([string]$Path)
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop = $env:TEMP }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $target = Join-Path $desktop ('dsh-cookies-backup-' + $stamp + '.db')
    try {
        Copy-Item -LiteralPath $Path -Destination $target -Force -ErrorAction Stop
        Write-Ok ('已备份到 ' + $target)
        return $target
    } catch {
        Write-Warn2 ('备份失败（继续删）：' + $_.Exception.Message)
        return ''
    }
}

function Remove-Db {
    param([string]$Path)
    $journal = $Path + '-journal'
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $journal) {
        Remove-Item -LiteralPath $journal -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $Path) {
        try {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        } catch {
            Write-Bad ('删不掉：' + $Path)
            Write-Info ($_.Exception.Message)
            return $false
        }
    }
    if (Test-Path -LiteralPath $Path) {
        Write-Bad ('删不掉：' + $Path)
        return $false
    }
    Write-Ok ('已删除：' + $Path)
    return $true
}

function Do-Fix {
    Write-Title '一键修复：结束进程 → 备份 → 删除 → 校验'
    $ok = Stop-DshProcs
    if (-not $ok) {
        Write-Warn2 '进程没退干净，删除多半会失败；先选 [3] 再试，或用管理员窗口重跑。'
    }
    $dbs = @(Get-CookieDbs)
    if ($dbs.Count -eq 0) {
        Write-Bad '没找到 cookie 库，没什么可删的'
        return
    }
    $done = 0
    foreach ($db in $dbs) {
        if ($db.Kind -ne '主库') { continue }
        Write-Host ''
        Write-Info ('处理 ' + $db.Path)
        [void](Backup-Db $db.Path)
        if (Remove-Db $db.Path) { $done++ }
    }
    Write-Host ''
    if ($done -gt 0) {
        Write-Ok ('清理完成（' + $done + ' 个库）。重新打开 DSH，登录一次即可；')
        Write-Info '会话、插件、配置都在 %USERPROFILE%\.dsh，不会丢。'
    } else {
        Write-Bad '一个都没删掉，看上面的报错'
    }
}

function Do-Diag {
    Write-Title '只诊断（不改任何文件）'
    Show-Status
    Write-Info '这是只读模式，什么都没动。'
}

function Do-Kill {
    Write-Title '只结束 DSH 进程（不删 cookie）'
    Write-Warn2 'DSH 里没保存的内容会丢。'
    Write-Host '      确认？输入 y 回车：' -ForegroundColor $C.Dim -NoNewline
    $a = Read-Host
    if ($a -ne 'y' -and $a -ne 'Y') {
        Write-Info '已取消'
        return
    }
    [void](Stop-DshProcs)
}

function Do-DeleteOnly {
    Write-Title '只删 cookie（要求 DSH 已经退出）'
    if (@(Get-DshProcs).Count -gt 0) {
        Write-Bad 'DSH 还在跑，先彻底退出（含托盘图标），或者选 [1] / [3]'
        return
    }
    $dbs = @(Get-CookieDbs)
    if ($dbs.Count -eq 0) { Write-Bad '没找到 cookie 库'; return }
    foreach ($db in $dbs) {
        if ($db.Kind -ne '主库') { continue }
        Write-Host ''
        Write-Info ('处理 ' + $db.Path)
        [void](Backup-Db $db.Path)
        [void](Remove-Db $db.Path)
    }
    Write-Host ''
    Write-Ok '重新打开 DSH，登录一次即可。'
}

function Do-OpenFolder {
    $dbs = @(Get-CookieDbs)
    if ($dbs.Count -eq 0) { Write-Bad '没找到 cookie 目录'; return }
    foreach ($db in $dbs) {
        if ($db.Kind -ne '主库') { continue }
        $dir = Split-Path -LiteralPath $db.Path -Parent
        try {
            Start-Process explorer.exe $dir
            Write-Ok ('已打开 ' + $dir)
        } catch {
            Write-Bad ('打不开：' + $dir)
        }
    }
}

function Do-Help {
    Write-Title '这到底是怎么回事'
    Write-Host '      每次启动 DSH 桌面版，外壳都会拿一个随机端口去登录，' -ForegroundColor $C.Dim
    Write-Host '      于是浏览器 cookie 库里就多存一条 dsh-auth-xxxx（名字由端口算出来，' -ForegroundColor $C.Dim
    Write-Host '      所以每次都不一样）。每条约占 228 字节，谁也不会去清它。' -ForegroundColor $C.Dim
    Write-Host ''
    Write-Host '      攒到第 72 条时，请求头超过 Node 默认的 16 KiB（16384 字节），' -ForegroundColor $C.Dim
    Write-Host '      服务端直接回 431，DSH 就永远卡在：' -ForegroundColor $C.Dim
    Write-Host '          desktop welcome: Web authentication failed' -ForegroundColor $C.Bad
    Write-Host ''
    Write-Title '为什么要管理员'
    Write-Host '      结束进程、删 %APPDATA% 下的文件，普通账号多数能行；' -ForegroundColor $C.Dim
    Write-Host '      但如果 DSH 是被更高级别账号启动的，普通窗口会删不掉。' -ForegroundColor $C.Dim
    Write-Host '      Win + X → 终端(管理员)，再跑本脚本，最省事。' -ForegroundColor $C.Warn
    Write-Host ''
    Write-Title '数据会不会丢'
    Write-Host '      不会。只删登录 cookie。会话、插件、配置、记忆都在 %USERPROFILE%\.dsh。' -ForegroundColor $C.Dim
    Write-Host '      删完重新打开 DSH，登录一次就好。' -ForegroundColor $C.Dim
    Write-Host ''
    Write-Title '清完还会再涨吗'
    Write-Host '      会，每次启动多一条。所以别没事重启；真要重启，先来这里看一眼。' -ForegroundColor $C.Dim
    Write-Host '      装了 Cookie 守护插件的话，DSH 首页会一直显示条数和剩余次数。' -ForegroundColor $C.Dim
}

# ---------------------------------------------------------------- 菜单
function Show-Menu {
    Clear-Host
    Write-Host ''
    Write-Bar '=' $C.Line
    Write-Host '   DSH Cookie 守护 · 命令行清理菜单   v1.2' -ForegroundColor $C.Title
    Write-Bar '=' $C.Line

    if (Test-Admin) {
        Write-Host '   权限：管理员 ✓' -ForegroundColor $C.Ok
    } else {
        Write-Host '   权限：普通用户 —— 建议 Win+X → 终端(管理员) 重开' -ForegroundColor $C.Warn
    }

    Show-Status
    Write-Bar '-' $C.Line
    Write-Host '   [1] 一键修复    结束 DSH 进程 → 备份 → 删除 → 校验' -ForegroundColor $C.Ok
    Write-Host '   [2] 只诊断      看看有几条，不改任何文件' -ForegroundColor $C.Dim
    Write-Host '   [3] 结束进程    只杀 DSH 进程，不删 cookie' -ForegroundColor $C.Dim
    Write-Host '   [4] 只删 cookie 需先自己退出 DSH' -ForegroundColor $C.Dim
    Write-Host '   [5] 打开目录    在资源管理器里看 Network 文件夹' -ForegroundColor $C.Dim
    Write-Host '   [6] 说明 / FAQ  原理、为什么用管理员、会不会丢数据' -ForegroundColor $C.Dim
    Write-Host '   [0] 退出' -ForegroundColor $C.Dim
    Write-Bar '-' $C.Line
}

function Start-Menu {
    while ($true) {
        Show-Menu
        Write-Host '   请输入编号 [0-6]：' -ForegroundColor $C.Acc -NoNewline
        $choice = Read-Host
        switch ($choice) {
            '1' { Do-Fix;          Pause-Any }
            '2' { Do-Diag;         Pause-Any }
            '3' { Do-Kill;         Pause-Any }
            '4' { Do-DeleteOnly;   Pause-Any }
            '5' { Do-OpenFolder;   Pause-Any }
            '6' { Do-Help;         Pause-Any }
            '0' {
                Write-Host ''
                Write-Host '   再见。' -ForegroundColor $C.Dim
                return
            }
            default {
                Write-Host ''
                Write-Host '   没有这个选项，输入 0-6 的数字。' -ForegroundColor $C.Warn
                Start-Sleep -Milliseconds 900
            }
        }
    }
}

# ---------------------------------------------------------------- 入口
try {
    $Host.UI.RawUI.WindowTitle = 'DSH Cookie 守护 · 清理菜单'
} catch { }

Start-Menu
