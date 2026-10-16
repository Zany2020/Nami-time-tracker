param([string]$Label='diag', [string[]]$Extra=@(), [int]$WaitSec=6, [string]$Shot='')
$ErrorActionPreference='Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$readyDir = Join-Path $env:LOCALAPPDATA 'NamiTime\m0'
[void][System.IO.Directory]::CreateDirectory($readyDir)
$rf = Join-Path $readyDir "ready-$Label.json"
if ([System.IO.File]::Exists($rf)) { [System.IO.File]::Delete($rf) }
$eargs = @('.', "--ready-file=$rf") + $Extra
Write-Host ("参数: " + ($eargs -join ' '))
$p = Start-Process -FilePath $electron -ArgumentList $eargs -WorkingDirectory $root -PassThru
for ($i=0; $i -lt 60 -and -not [System.IO.File]::Exists($rf); $i++) { Start-Sleep -Milliseconds 300 }
if ([System.IO.File]::Exists($rf)) { Write-Host "=== ready ==="; Write-Host ([System.IO.File]::ReadAllText($rf)) } else { Write-Host "TIMEOUT" }
Start-Sleep -Seconds $WaitSec
if ($Shot) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "截图: $Shot (虚拟屏 $($vs.Width)x$($vs.Height) @ $($vs.Left),$($vs.Top))"
  } catch { Write-Host "截图失败: $($_.Exception.Message)" }
}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2