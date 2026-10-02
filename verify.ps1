# verify.ps1 - 一条命令判断手机桥链路是否通畅
# 用法: powershell -File verify.ps1

$ErrorActionPreference = 'SilentlyContinue'
$ok = 0; $bad = 0

function Report($label, $good, $detail) {
  if ($good) { Write-Host ("  [OK]   " + $label + "  " + $detail) -ForegroundColor Green; $script:ok++ }
  else       { Write-Host ("  [FAIL] " + $label + "  " + $detail) -ForegroundColor Red;   $script:bad++ }
}

Write-Host ""
Write-Host "dsh-phone-bridge 自检" -ForegroundColor Cyan
Write-Host ("=" * 50)

# 1. DSH 进程
$dsh = Get-Process -Name 'DeepSeek Harness' | Select-Object -First 1
Report "DSH 进程" ($null -ne $dsh) $(if ($dsh) { "已运行 " + [math]::Round(((Get-Date) - $dsh.StartTime).TotalMinutes, 1) + " 分钟" } else { "没找到" })

# 2. 端口监听
$listen = Get-NetTCPConnection -LocalPort 19387 -State Listen | Select-Object -First 1
Report "19387 端口" ($null -ne $listen) $(if ($listen) { "PID " + $listen.OwningProcess } else { "没有监听" })

# 3. DSH 侧插件
$r = & curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/phone-bridge/sessions 2>$null
Report "DSH 侧 /phone-bridge/sessions" ($r -eq '200') ("HTTP " + $r + $(if ($r -eq '404') { "  <- 插件没挂上，检查 cordis.patch.yml 的 insert 段" } else { "" }))

# 4. 会话数
if ($r -eq '200') {
  $body = & curl.exe -s -o - http://127.0.0.1:19387/phone-bridge/sessions 2>$null
  $n = ([regex]::Matches(($body -join ''), '"sessionId"')).Count
  Report "能列出会话" ($n -gt 0) ($n.ToString() + " 个")
}

# 5. 回收站
$t = & curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/phone-bridge/trash 2>$null
Report "DSH 侧 /phone-bridge/trash" ($t -eq '200') ("HTTP " + $t)

# 6. 通知插件（提问/审批通道）
$n2 = & curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/dsh-notify/state 2>$null
Report "通知插件 /dsh-notify/state" ($n2 -eq '200') ("HTTP " + $n2 + $(if ($n2 -eq '404') { "  <- 通知插件没挂上" } else { "" }))

# 7. OpenClaw 侧日志
$log = Join-Path $env:LOCALAPPDATA 'dsh-bridge\hook.log'
Report "OpenClaw 插件日志" (Test-Path $log) $(if (Test-Path $log) { $log } else { "还没生成，说明 OpenClaw 侧没收到过消息" })

Write-Host ("=" * 50)
Write-Host ("通过 " + $ok + " 项，失败 " + $bad + " 项") -ForegroundColor $(if ($bad -eq 0) { 'Green' } else { 'Yellow' })
if ($bad -gt 0) {
  Write-Host ""
  Write-Host "排查提示：" -ForegroundColor Yellow
  Write-Host "  /phone-bridge 系列 404 -> DSH 侧插件没加载，看 docs/installation.md 的「怎么知道装对了」"
  Write-Host "  /dsh-notify/state 404  -> 通知插件没挂上，提问和审批的回复会收不到"
  Write-Host "  hook.log 不存在        -> OpenClaw 侧插件没被加载（plugins.allow 加了吗）"
}
Write-Host ""
