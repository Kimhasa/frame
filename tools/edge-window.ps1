# Test window with a normal Windows title bar and borders, for checking that window capture keeps only the client area.
# The client area has 6 px colour bands on its edges (top red, right green, bottom blue, left magenta), corner labels and
# its own size and DPI in the middle. -DpiAware makes the process per-monitor DPI aware (v2); without it Windows scales
# the window as a DPI-unaware application.
#   powershell -ExecutionPolicy Bypass -File tools\edge-window.ps1 [-DpiAware] [-Title "..."]
param([switch]$DpiAware, [string]$Title = '')
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class EdgeDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
}
'@
if ($DpiAware) { [EdgeDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not $Title) { $Title = if ($DpiAware) { 'FRAME 가장자리 테스트 (DPI 인식)' } else { 'FRAME 가장자리 테스트 (DPI 비인식)' } }
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(160, 140)
$form.ClientSize = New-Object System.Drawing.Size(900, 560)
$form.BackColor = [System.Drawing.Color]::White
$font = New-Object System.Drawing.Font('Malgun Gothic', 14, [System.Drawing.FontStyle]::Bold)
$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics; $r = $sender.ClientRectangle; $b = 6
  $g.Clear([System.Drawing.Color]::White)
  $g.FillRectangle([System.Drawing.Brushes]::Red, 0, 0, $r.Width, $b)
  $g.FillRectangle([System.Drawing.Brushes]::Lime, $r.Width - $b, 0, $b, $r.Height)
  $g.FillRectangle([System.Drawing.Brushes]::Blue, 0, $r.Height - $b, $r.Width, $b)
  $g.FillRectangle([System.Drawing.Brushes]::Magenta, 0, 0, $b, $r.Height)
  $black = [System.Drawing.Brushes]::Black
  $g.DrawString('좌상 TL', $font, $black, 10, 10)
  $size = $g.MeasureString('우상 TR', $font); $g.DrawString('우상 TR', $font, $black, $r.Width - $size.Width - 10, 10)
  $g.DrawString('좌하 BL', $font, $black, 10, $r.Height - $size.Height - 10)
  $g.DrawString('우하 BR', $font, $black, $r.Width - $size.Width - 10, $r.Height - $size.Height - 10)
  $info = "client $($r.Width)x$($r.Height) px, DPI $([EdgeDpi]::GetDpiForWindow($sender.Handle))"
  $s2 = $g.MeasureString($info, $font); $g.DrawString($info, $font, $black, ($r.Width - $s2.Width) / 2, ($r.Height - $s2.Height) / 2)
})
# Started without a console window (-WindowStyle Hidden), the first show is hidden: show it normally once more.
$form.Add_Shown({ [EdgeDpi]::ShowWindow($form.Handle, 1) | Out-Null })
$form.Add_Resize({ $form.Invalidate() })
$form.Add_Move({ $form.Invalidate() })
[System.Windows.Forms.Application]::Run($form)
