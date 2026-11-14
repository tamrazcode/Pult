Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct WinRect { public int Left, Top, Right, Bottom; }
public class WinRectApi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out WinRect r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$procs = Get-Process pult-core -ErrorAction SilentlyContinue
if (-not $procs) { "no-pult-process"; exit }
foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  if ($h -eq 0) { "pid=$($p.Id) no-main-window"; continue }
  $r = New-Object WinRect
  [void][WinRectApi]::GetWindowRect($h, [ref]$r)
  $vis = [WinRectApi]::IsWindowVisible($h)
  "pid=$($p.Id) L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom) VIS=$vis"
}
