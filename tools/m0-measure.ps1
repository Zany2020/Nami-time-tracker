param(
  [string]$Label = 'run',
  [int]$WarmupSec = 8,
  [int]$ActiveSec = 8,
  [int]$IdleSec = 14,
  [int]$GapSec = 6,
  [switch]$NoHwAccel,
  [switch]$DisableGpu,
  [switch]$SingleProcess,
  [switch]$NoTrim,
  [string]$Shot = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$readyDir = Join-Path $env:LOCALAPPDATA 'NamiTime\m0'
[void][System.IO.Directory]::CreateDirectory($readyDir)
$rf = Join-Path $readyDir "ready-$Label.json"
if ([System.IO.File]::Exists($rf)) { [System.IO.File]::Delete($rf) }

if (-not ('NamiMem' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NamiMem {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll")] public static extern bool SetProcessWorkingSetSize(IntPtr h, IntPtr min, IntPtr max);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void Trim(uint pid) {
    IntPtr h = OpenProcess(0x0500, false, pid);
    if (h != IntPtr.Zero) { SetProcessWorkingSetSize(h, (IntPtr)(-1), (IntPtr)(-1)); CloseHandle(h); }
  }
}
"@
}

function Get-OurProcs {
  $rows = @()
  foreach ($x in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'")) {
    $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue
    if (-not $g) { continue }
    $cl = [string]$x.CommandLine
    $t = if ($cl -match '--type=([a-z0-9\-]+)') { $Matches[1] } else { 'browser-main' }
    $rows += [pscustomobject]@{ pid = [uint32]$x.ProcessId; 类型 = $t; WS = $g.WorkingSet64 / 1MB; 私有 = $g.PrivateMemorySize64 / 1MB; Handle = $g.MainWindowHandle }
  }
  ,$rows
}

function Trim-All {
  $n = 0
  foreach ($r in (Get-OurProcs)) { [NamiMem]::Trim($r.pid); $n++ }
  Start-Sleep -Milliseconds 1500
  return $n
}

function Sample([int]$sec, [string]$name) {
  $acc = @{}; $n = 0
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) {
    foreach ($r in (Get-OurProcs)) {
      if (-not $acc.ContainsKey($r.pid)) { $acc[$r.pid] = @{ 类型 = $r.类型; ws = @(); pv = @() } }
      $acc[$r.pid].ws += $r.WS; $acc[$r.pid].pv += $r.私有
    }
    $n++; Start-Sleep -Milliseconds 900
  }
  $out = foreach ($k in $acc.Keys) {
    [pscustomobject]@{
      类型 = $acc[$k].类型
      WS均值MB = [math]::Round((($acc[$k].ws | Measure-Object -Average).Average), 1)
      私有均值MB = [math]::Round((($acc[$k].pv | Measure-Object -Average).Average), 1)
    }
  }
  $out = $out | Sort-Object WS均值MB -Descending
  $ws = [math]::Round((($out | Measure-Object WS均值MB -Sum).Sum), 1)
  $pv = [math]::Round((($out | Measure-Object 私有均值MB -Sum).Sum), 1)
  Write-Host ""
  Write-Host "===== $name =====" -ForegroundColor Cyan
  $out | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
  Write-Host ("  --> WS合计 {0} MB | 私有合计 {1} MB | 进程 {2}" -f $ws, $pv, $out.Count) -ForegroundColor Yellow
  return [pscustomobject]@{ 状态 = $name; WS合计MB = $ws; 私有合计MB = $pv; 进程数 = $out.Count }
}

$eargs = @('.', "--ready-file=$rf", "--minimize-after=$((($WarmupSec + $ActiveSec * 2 + $GapSec * 2) * 1000))")
if ($NoHwAccel) { $eargs += '--no-hw-accel' }
if ($DisableGpu) { $eargs += '--disable-gpu' }
if ($SingleProcess) { $eargs += '--single-process' }
$eargs += '--always-on-top'
Write-Host ("启动  no-hw={0} disable-gpu={1} single-process={2}  label={3}" -f [bool]$NoHwAccel, [bool]$DisableGpu, [bool]$SingleProcess, $Label)
$proc = Start-Process -FilePath $electron -ArgumentList $eargs -WorkingDirectory $root -PassThru

$t0 = Get-Date
while (-not [System.IO.File]::Exists($rf)) {
  if ((Get-Date) -gt $t0.AddSeconds(35)) { Write-Host "启动超时" -ForegroundColor Red; break }
  Start-Sleep -Milliseconds 300
}
Write-Host ("就绪: " + [System.IO.File]::ReadAllText($rf))
Start-Sleep -Seconds $WarmupSec

Start-Sleep -Milliseconds 1200  # 窗口用 --always-on-top 常驻前台，这里只等它稳定

$results = @()
$results += Sample $ActiveSec 'A 窗口打开 · 活跃'

if (-not $NoTrim) {
  $n = Trim-All
  Write-Host "已对 $n 个进程执行 EmptyWorkingSet"
  $results += Sample 4 'A2 活跃 + 工作集整理'
}

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

Write-Host "等待自动最小化 ..."
Start-Sleep -Seconds ($GapSec + 3)
$results += Sample $IdleSec 'B 最小化后 · 空闲'
if (-not $NoTrim) {
  [void](Trim-All)
  $results += Sample 4 'B2 最小化 + 工作集整理'
}

Write-Host ""
Write-Host "===== 汇总 ($Label) =====" -ForegroundColor Green
$results | Select-Object 状态, WS合计MB, 私有合计MB, 进程数 | Format-Table -AutoSize | Out-String -Width 160 | Write-Host

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2