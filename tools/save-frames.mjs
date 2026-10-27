// Saves what is shown right now: the app's sender preview canvas (9222) and the LAN viewer's video frame (9334), plus a
// screen capture of the source window with its title bar (the "before"), into verification/crop/<name>-*.png.
// usage: node tools/save-frames.mjs <name> [window title prefix]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const [name = 'frame', title] = process.argv.slice(2);
const dir = new URL('../verification/crop/', import.meta.url);
mkdirSync(dir, { recursive: true });
const grab = async (port, match, expression) => {
  const c = await connect(port, match);
  const data = await c.evaluate(`(async () => { const s = ${expression}; if (!s) return null; const w = s.videoWidth || s.width, h = s.videoHeight || s.height;
    const cv = new OffscreenCanvas(w, h); cv.getContext('2d').drawImage(s, 0, 0, w, h); const b = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let t = ''; for (let i = 0; i < b.length; i += 32768) t += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(t); })()`);
  c.close();
  return data && Buffer.from(data, 'base64');
};
const preview = await grab(9222, t => t.url.includes('frame-console.example'), `document.getElementById('sender-canvas')`);
if (preview) writeFileSync(new URL(name + '-preview.png', dir), preview);
const viewer = await grab(9334, t => /:\d+\/[A-Za-z0-9_-]+/.test(t.url), `window.FrameRuntime && window.FrameRuntime.video`).catch(() => null);
if (viewer) writeFileSync(new URL(name + '-viewer.png', dir), viewer);
if (title) {
  // The window as Windows shows it, title bar included (physical pixels of its visible frame).
  const out = new URL(name + '-window.png', dir).pathname.slice(1);
  execFileSync('powershell', ['-NoProfile', '-Command', `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class S { public delegate bool P(IntPtr h, IntPtr l); [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
 public static IntPtr Find(string t) { IntPtr f = IntPtr.Zero; EnumWindows((h, l) => { var s = new StringBuilder(512); GetWindowText(h, s, 512); if (IsWindowVisible(h) && s.ToString().StartsWith(t)) { f = h; return false; } return true; }, IntPtr.Zero); return f; } }'
[S]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
Add-Type -AssemblyName System.Drawing
# PrintWindow renders the whole window (title bar included) even when other windows cover it; keep its visible frame.
$h = [S]::Find('${title.replace(/'/g, "''")}'); $w = New-Object S+R; $f = New-Object S+R
[S]::GetWindowRect($h, [ref]$w) | Out-Null; [S]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) | Out-Null
$full = New-Object System.Drawing.Bitmap ($w.Ri - $w.L), ($w.B - $w.T)
$g = [System.Drawing.Graphics]::FromImage($full); $dc = $g.GetHdc(); [S]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$crop = $full.Clone((New-Object System.Drawing.Rectangle ($f.L - $w.L), ($f.T - $w.T), ($f.Ri - $f.L), ($f.B - $f.T)), $full.PixelFormat); $crop.Save('${out}')`], { encoding: 'utf8' });
}
console.log(JSON.stringify({ name, preview: !!preview, viewer: !!viewer, window: !!title }));
