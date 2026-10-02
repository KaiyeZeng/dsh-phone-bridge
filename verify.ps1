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

# 8. 后加的路由也要活着（/status 与 /models）
$st = & curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/phone-bridge/status 2>$null
Report "DSH 侧 /phone-bridge/status" ($st -eq '200') ("HTTP " + $st)

$md = & curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/phone-bridge/models 2>$null
Report "DSH 侧 /phone-bridge/models" ($md -eq '200') ("HTTP " + $md)

# 9. DSH 内部接口是否齐全（DSH 升级后最容易断的地方）
$hc = & curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/phone-bridge/health 2>$null
if ($hc -eq '200') {
  $hb = (& curl.exe -s -o - http://127.0.0.1:19387/phone-bridge/health 2>$null) -join ''
  $hj = $hb | ConvertFrom-Json
  Report "sessionController 方法齐全" ($hj.missing.Count -eq 0) $(if ($hj.missing.Count -eq 0) { $hj.required.Count.ToString() + " 个都在" } else { "缺: " + ($hj.missing -join ', ') })
} else {
  Report "DSH 侧 /phone-bridge/health" $false ("HTTP " + $hc + "  <- 404 说明 DSH 侧插件版本旧，跑 dsh plugin --profile desktop add dsh-phone-bridge 更新")
}

# 9. OpenClaw 侧插件在不在（npm 安装版 或 扩展目录版，有一种即可）
$ocHome = Join-Path $env:USERPROFILE '.openclaw'
# OpenClaw 每次更新会装到一个新目录，名字形如
# openclaw-dsh-bridge__openclaw-generation__g-xxxx，所以按前缀匹配。
# 用精确名字的话，装好了也会被判成没装。
$npmDirs = @(Get-ChildItem (Join-Path $ocHome 'npm\projects') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'openclaw-dsh-bridge*' })
$extVer = Test-Path (Join-Path $ocHome 'extensions\dsh-bridge')
Report "OpenClaw 侧插件" ($npmDirs.Count -gt 0 -or $extVer) $(if ($npmDirs.Count -gt 0) { "npm 安装版，共 " + $npmDirs.Count + " 个目录" } elseif ($extVer) { "扩展目录版" } else { "都没找到" })

# 10. 重复副本会让同一条消息被转发两次
$dupes = @(Get-ChildItem (Join-Path $ocHome 'extensions') -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'openclaw.plugin.json') })
Report "没有重复插件副本" ($dupes.Count -le 1) $(if ($dupes.Count -le 1) { "干净" } else { ($dupes | ForEach-Object { $_.Name }) -join ', ' })

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
