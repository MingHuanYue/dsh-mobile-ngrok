# 换条路：用「出站隧道」把电脑上的 DSH 搬到一个网址上
#
# 为什么走这条：公司 WiFi 把手机和电脑隔开了（客户端隔离），而且 VPN 类服务
# 也被公司网关挡了（Tailscale 登录失败就是证据）。但**电脑能正常上网**。
#
# 所以反过来想：让电脑主动往外连一个中转服务，拿到一个公网网址，
# 手机用浏览器打开那个网址就行 —— 手机端一个 App 都不用装。
#
# 本文件只是一个「先跑哪条」的判定脚本，不装任何东西。
# 用法：双击本文件（或 node relay-check.js）看电脑能连到哪些中转服务。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Line($s = '') { Write-Host $s }

Line ''
Line ('=' * 64)
Line '  出站中继路线可行性判定'
Line ('=' * 64)
Line ''

# 1) 网关在跑吗
Line '--- 1. 网关状态 ---'
$listen = netstat -ano | Select-String -Pattern ':3081\s' | Select-String 'LISTENING'
if ($listen) {
    Write-Host '  [ok]  网关正在监听 3081' -ForegroundColor Green
} else {
    Write-Host '  [!]   网关没在跑 —— 先双击 启动网关.cmd' -ForegroundColor Yellow
    Line '        （隧道方案也需要网关在跑：它是 DSH 前面的那扇门）'
}

# 2) node 在不在
Line ''
Line '--- 2. 运行环境 ---'
$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source } elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { $node = "$env:ProgramFiles\nodejs\node.exe" }
if ($node) {
    Write-Host "  [ok]  node: $node" -ForegroundColor Green
} else {
    Write-Host '  [!]   找不到 node.exe' -ForegroundColor Yellow
}

# 3) 出站可达性
Line ''
Line '--- 3. 电脑能连到哪些中转服务 ---'
if (-not $node) {
    Write-Host '  跳过（没有 node）' -ForegroundColor Yellow
} else {
    $probe = Join-Path $here 'relay-check.js'
    if (Test-Path $probe) { & $node $probe } else { Write-Host "  找不到 $probe" -ForegroundColor Yellow }
}

# 4) 怎么看
Line ''
Line ('=' * 64)
Line '  结果怎么用'
Line ('=' * 64)
Line ''
Line '  手机和电脑被隔开，且 VPN 被挡 —— 剩下能走的就是「电脑主动往外连」：'
Line ''
Line '  A. Cloudflare 快速隧道（推荐先试）'
Line '     电脑装一个小程序 cloudflared，一条命令换到一个 https 网址，'
Line '     手机浏览器直接打开那个网址即可，手机端零安装。'
Line '     需要：电脑能连 1.1.1.1:443 和 cloudflared 的下载站。'
Line ''
Line '  B. ngrok'
Line '     同类，但可能同样被公司网关拦。需要注册账号。'
Line ''
Line '  C. 局域网直连（最省事，但要看运气）'
Line '     如果手机浏览器能打开 http://电脑IP:3081/ 出现「需要访问令牌」页，'
Line '     那前面所有麻烦都不存在 —— 先用手机试这一步，成了就什么都不用装。'
Line ''
Line '  注意：A/B 都会把你的 DSH 暴露在一个公网网址上。网关本身仍然要求令牌，'
Line '  但公网上谁都能访问那个域名 —— 用完记得把隧道关掉。'
Line ''
Read-Host '按回车关闭'
