param([int]$WarmupSec = 12, [switch]$NoHwAccel, [switch]$NetInProc, [switch]$KeepAlive, [string]$Shot = "")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$readyDir = Join-Path $env:LOCALAPPDATA 'NamiTime\m0'
[void][System.IO.Directory]::CreateDirectory($readyDir)
$rf = Join-Path $readyDir 'ready-raw.json'
if ([System.IO.File]::Exists($rf)) { [System.IO.File]::Delete($rf) }

$eargs = @('.', "--ready-file=$rf")
if ($NoHwAccel) { $eargs += '--no-hw-accel' }
if ($NetInProc) { $eargs += '--net-inproc' }
Write-Host ("启动 Electron  no-hw-accel={0} net-inproc={1}" -f [bool]$NoHwAccel, [bool]$NetInProc)
$p = Start-Process -FilePath $electron -ArgumentList $eargs -WorkingDirectory $root -PassThru
Write-Host "main pid = $($p.Id)"

for ($i = 0; $i -lt 60 -and -not [System.IO.File]::Exists($rf); $i++) { Start-Sleep -Milliseconds 300 }
Write-Host ("ready: " + $(if ([System.IO.File]::Exists($rf)) { [System.IO.File]::ReadAllText($rf) } else { 'TIMEOUT' }))
Start-Sleep -Seconds $WarmupSec

$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
$rows = @()
foreach ($x in $procs) {
  $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue
  if (-not $g) { continue }
  $cl = [string]$x.CommandLine
  $type = if ($cl -match '--type=([a-z0-9\-]+)') { $Matches[1] } else { 'browser-main' }
  $rows += [pscustomobject]@{
    pid = $x.ProcessId; ppid = $x.ParentProcessId; 类型 = $type
    WS_MB = [math]::Round($g.WorkingSet64 / 1MB, 1)
    私有MB = [math]::Round($g.PrivateMemorySize64 / 1MB, 1)
    线程 = $g.Threads.Count
  }
}
Write-Host ""
Write-Host "=== electron 进程明细 ==="
$rows | Sort-Object WS_MB -Descending | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
$wsSum = ($rows | Measure-Object WS_MB -Sum).Sum
$pvSum = ($rows | Measure-Object 私有MB -Sum).Sum
Write-Host ("合计 WS = {0} MB   合计 私有 = {1} MB   进程数 = {2}" -f [math]::Round($wsSum,1), [math]::Round($pvSum,1), $rows.Count) -ForegroundColor Yellow

if ($Shot) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "截图: $Shot"
  } catch { Write-Host "截图失败: $($_.Exception.Message)" }
}
if (-not $KeepAlive) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Write-Host "已停止 $($p.Id)"
} else {
  Write-Host "保持运行 (pid $($p.Id))"
}