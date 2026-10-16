$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$readyDir = Join-Path $env:LOCALAPPDATA 'NamiTime\m0'
[void][System.IO.Directory]::CreateDirectory($readyDir)
$rf = Join-Path $readyDir 'ready-win.json'
if ([System.IO.File]::Exists($rf)) { [System.IO.File]::Delete($rf) }
$p = Start-Process -FilePath $electron -ArgumentList @('.', "--ready-file=$rf") -WorkingDirectory $root -PassThru
for ($i = 0; $i -lt 60 -and -not [System.IO.File]::Exists($rf); $i++) { Start-Sleep -Milliseconds 300 }
Start-Sleep -Seconds 6
Write-Host "=== electron 进程的窗口信息 ==="
foreach ($x in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'")) {
  $g = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue
  if (-not $g) { continue }
  $cl = [string]$x.CommandLine
  $t = if ($cl -match '--type=([a-z0-9\-]+)') { $Matches[1] } else { 'browser-main' }
  [pscustomobject]@{
    pid = $x.ProcessId; 类型 = $t
    MainWindowHandle = $g.MainWindowHandle
    MainWindowTitle = "[$($g.MainWindowTitle)]"
  } | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
}
if (-not ('WEnum' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WEnum {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> List(uint want) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      res.Add(h.ToString() + " visible=" + IsWindowVisible(h) + " class=" + c + " title=[" + t + "]");
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
}
Write-Host "=== 哪个 electron 进程拥有窗口 ==="
foreach ($x in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'")) {
  $lst = [WEnum]::List([uint32]$x.ProcessId)
  if ($lst.Count -gt 0) { Write-Host "pid $($x.ProcessId):"; $lst | ForEach-Object { "   $_" } }
}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue