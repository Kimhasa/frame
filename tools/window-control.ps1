# Geometry and placement of a top-level window found by title prefix, measured per-monitor DPI aware (physical pixels):
# window rect (with invisible resize borders), DWM visible frame bounds, client rect, DPI and the monitors.
#   powershell -File tools\window-control.ps1 -Title "FRAME 가장자리" [-Action info|restore|maximize|move|size|place|minimize|shownoactivate|below|close] [-X 100 -Y 100] [-Width 1200 -Height 700] [-Other "FRAME Console"]
# place, minimize, shownoactivate and below never activate the window (for test windows); below puts it under -Other in z-order.
param([Parameter(Mandatory)] [string]$Title, [string]$Action = 'info', [int]$X = 0, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0, [string]$Other = '')
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static IntPtr Find(string prefix) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { var s = new StringBuilder(512); GetWindowText(h, s, 512); if (IsWindowVisible(h) && s.ToString().StartsWith(prefix)) { found = h; return false; } return true; }, IntPtr.Zero); return found; }
}
'@
[Win]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$h = [Win]::Find($Title)
if ($h -eq [IntPtr]::Zero) { throw "window not found: $Title" }
switch ($Action) {
  'restore'  { [Win]::ShowWindow($h, 9) | Out-Null }
  'maximize' { [Win]::ShowWindow($h, 3) | Out-Null }
  'move'     { [Win]::ShowWindow($h, 9) | Out-Null; [Win]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, 0x0015) | Out-Null }   # NOSIZE|NOZORDER|NOACTIVATE
  'size'     { [Win]::ShowWindow($h, 9) | Out-Null; [Win]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x0016) | Out-Null } # NOMOVE|NOZORDER|NOACTIVATE
  'place'    { [Win]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x0014) | Out-Null }   # NOZORDER|NOACTIVATE
  'minimize' { [Win]::ShowWindow($h, 7) | Out-Null }   # SW_SHOWMINNOACTIVE
  'shownoactivate' { [Win]::ShowWindow($h, 4) | Out-Null }   # SW_SHOWNOACTIVATE: restores without activating
  'below'    { $o = [Win]::Find($Other); if ($o -eq [IntPtr]::Zero) { throw "window not found: $Other" }; [Win]::SetWindowPos($h, $o, 0, 0, 0, 0, 0x0013) | Out-Null }   # NOSIZE|NOMOVE|NOACTIVATE
  'close'    { [Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; return }   # WM_CLOSE
}
Start-Sleep -Milliseconds 400
$w = New-Object Win+RECT; $f = New-Object Win+RECT; $c = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$w) | Out-Null
[Win]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) | Out-Null   # DWMWA_EXTENDED_FRAME_BOUNDS
[Win]::GetClientRect($h, [ref]$c) | Out-Null
$p = New-Object Win+POINT; [Win]::ClientToScreen($h, [ref]$p) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
[pscustomobject]@{
  window = "$($w.Right - $w.Left)x$($w.Bottom - $w.Top) at ($($w.Left),$($w.Top))"
  frame  = "$($f.Right - $f.Left)x$($f.Bottom - $f.Top) at ($($f.Left),$($f.Top))"
  client = "$($c.Right)x$($c.Bottom) at ($($p.X),$($p.Y))"
  insets = "l$($p.X - $f.Left) t$($p.Y - $f.Top) r$($f.Right - $p.X - $c.Right) b$($f.Bottom - $p.Y - $c.Bottom)"
  dpi    = [Win]::GetDpiForWindow($h)
  minimized = [Win]::IsIconic($h)
  monitors = ([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) $($_.Bounds.Width)x$($_.Bounds.Height) at ($($_.Bounds.X),$($_.Bounds.Y))$(if ($_.Primary) {' primary'})" }) -join '; '
} | ConvertTo-Json -Compress
