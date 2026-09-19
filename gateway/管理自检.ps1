# 网关管理自检 —— 需要管理员权限
#
# 为什么单独一个脚本：防火墙规则和网络位置类型都存在 HKLM 里，普通权限读不到。
#   Get-NetFirewallRule / netsh  -> 拒绝访问
#   HKLM:\...\NetworkList        -> Requested registry access is not allowed
# 所以这部分只能提权跑。不需要权限的网络连通性检查在 net-check.js 里。
#
# 用法：
#   右键本文件 -> 使用 PowerShell 运行
#   或在「管理员」PowerShell 窗口里： powershell -ExecutionPolicy Bypass -File 管理自检.ps1
#
# 注意：本文件刻意不使用反引号（PowerShell 的续行/转义字符），
# 因为它混在英文命令串里极易被误当转义，导致「字符串缺少终止符」这类语法错误。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PORT = 3081
$RULE = 'Mingyue DSH gateway'

function Line($s = '') { Write-Host $s }
function Ok($s)   { Write-Host "  [ok]  $s" -ForegroundColor Green }
function Warn($s) { Write-Host "  [!]   $s" -ForegroundColor Yellow }
function Info($s) { Write-Host "  $s" }

Line ''
Line ('=' * 62)
Line '  溟月 · 网关管理自检（管理员部分）'
Line ('=' * 62)

# ---------------------------------------------------------------- 是否提权
$elevated = $false
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if (-not $elevated) {
    Warn '当前不是管理员权限，下面的结果可能为空或报「拒绝访问」。'
    Info '请右键本文件 -> 以管理员身份运行。'
    Line ''
}

# ------------------------------------------------------------- 防火墙规则
Line ''
Line '--- 1. 网关的防火墙规则 ---'
$found = $false
try {
    $rules = Get-NetFirewallRule -DisplayName $RULE -ErrorAction Stop
    foreach ($r in $rules) {
        $found = $true
        $portFilter = $r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
        $ports = @($portFilter | ForEach-Object { $_.LocalPort }) -join ','
        Ok ('规则存在：启用={0} 方向={1} 动作={2} 档={3} 端口={4}' -f
            $r.Enabled, $r.Direction, $r.Action, $r.Profile, $ports)
        if ($r.Profile -notmatch 'Private') {
            Warn '规则没有覆盖 Private 档 —— 手机走的那张网很可能被挡在外面'
        }
    }
} catch { }
if (-not $found) {
    Warn "没有找到规则「$RULE」"
    Info '双击 放行防火墙.cmd（UAC 点「是」），或手动执行下面这条：'
    $cmd = 'netsh advfirewall firewall add rule name="' + $RULE + '" dir=in action=allow protocol=TCP localport=' + $PORT + ' profile=private,domain'
    Info $cmd
}

# --------------------------------------------------------- 网络位置类型
Line ''
Line '--- 2. 每张网络被归到哪个档（规则只作用于 Private/Domain） ---'
try {
    $networkProfiles = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\Profiles' -ErrorAction Stop
    $map = @{ 0 = 'Public'; 1 = 'Private'; 2 = 'Domain' }
    $any = $false
    foreach ($p in $networkProfiles) {
        $v = Get-ItemProperty $p.PSPath -ErrorAction SilentlyContinue
        if (-not $v) { continue }
        $any = $true
        $cat = $map[[int]$v.Category]
        if ($null -eq $cat) { $cat = '未知(' + $v.Category + ')' }
        if ($cat -eq 'Public') { $mark = '<- 规则管不到，这张网会被防火墙挡' }
        else { $mark = '<- 规则管得到' }
        Line ('     [{0}] {1}  {2}' -f $cat, $v.ProfileName, $mark)
    }
    if (-not $any) { Warn '（没读到网络列表）' }
} catch {
    Warn ('读不到网络列表：' + $_.Exception.Message)
}

Line ''
Line '--- 3. 当前活动的网络连接 ---'
try {
    $active = Get-NetConnectionProfile -ErrorAction Stop
    foreach ($c in $active) {
        Line ('     {0,-28} {1,-8} {2}' -f $c.InterfaceAlias, $c.NetworkCategory, $c.IPv4Connectivity)
    }
} catch {
    Warn ('读不到：' + $_.Exception.Message)
}

# ------------------------------------------------------------ 监听情况
Line ''
Line '--- 4. 谁在监听网关端口 ---'
$listen = netstat -ano | Select-String -Pattern (':' + $PORT + '\s') | Select-String 'LISTENING'
if ($listen) {
    foreach ($l in $listen) { Line ('     ' + $l.Line.Trim()) }
} else {
    Warn "没有人在监听 $PORT —— 先启动 启动网关.cmd"
}

# ------------------------------------------------------------ 结论
Line ''
Line ('=' * 62)
Line '  结论怎么用'
Line ('=' * 62)
Line ''
Line '  第 1 节规则缺失            -> 跑 放行防火墙.cmd'
Line '  第 2 节手机那张网是 Public -> 规则管不到它，这就是超时的原因'
Line '  规则齐全、网络也是 Private，手机仍超时 -> 那台 WiFi 在更外层就'
Line '  禁止了设备互访（公司/校园/访客网的常规做法），防火墙怎么开都没用。'
Line ''
Line '  唯一的解法：让手机和电脑走一条点对点私有网络'
Line '  （Tailscale / ZeroTier / WireGuard），用那条网的地址。'
Line ''
Read-Host '按回车关闭'
