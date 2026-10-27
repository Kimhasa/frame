// Reads the picture of a page element (the app's sender preview canvas or a viewer's video) and reports what is on its
// four edges, for the tools/edge-window.ps1 test window: the first rows/columns must be the client-area colour bands
// (top red, right green, bottom blue, left magenta), not title-bar or border pixels, and the bands must be present
// (nothing cut off). Also reports the picture size and aspect ratio.
// usage: node tools/check-edges.mjs <devtools port> <"preview" | "viewer"> [page target id]
import { connect } from './cdp.mjs';

const [port = '9222', what = 'preview', targetId] = process.argv.slice(2);
const c = await connect(Number(port), t => targetId ? t.id === targetId : Number(port) === 9222 ? t.url.includes('frame-console.example') : /:\d+\/[A-Za-z0-9_-]+/.test(t.url));
const result = await c.evaluate(`(async () => {
  const source = ${JSON.stringify(what)} === 'preview' ? document.getElementById('sender-canvas') : window.FrameRuntime.video;
  if (!source) return { error: 'no picture' };
  const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
  const cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(source, 0, 0, W, H);
  const px = (x, y) => { const d = cx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
  const name = ([r, g, b]) => r > 180 && g < 90 && b < 90 ? 'red' : r < 90 && g > 180 && b < 90 ? 'green' : r < 90 && g < 90 && b > 180 ? 'blue' : r > 180 && g < 90 && b > 180 ? 'magenta' : r > 220 && g > 220 && b > 220 ? 'white' : r < 40 && g < 40 && b < 40 ? 'black' : 'other(' + r + ',' + g + ',' + b + ')';
  // Colour along each edge (rows/columns 0 and 2) at 5 points, and how deep the band goes at the middle of each edge.
  // The content may sit inside bars (output shape differs from the window): find it from the middle of each side.
  const dark = ([r, g, b]) => r < 24 && g < 24 && b < 24;
  let L = 0, T = 0, R = W - 1, B = H - 1;
  while (L < W / 2 && dark(px(L, Math.round(H / 2)))) L++;
  while (R > W / 2 && dark(px(R, Math.round(H / 2)))) R--;
  while (T < H / 2 && dark(px(Math.round(W / 2), T))) T++;
  while (B > H / 2 && dark(px(Math.round(W / 2), B))) B--;
  const bars = { left: L, right: W - 1 - R, top: T, bottom: H - 1 - B };
  const CW = R - L + 1, CH = B - T + 1;
  const along = (fn) => [0.1, 0.3, 0.5, 0.7, 0.9].map(f => name(fn(f)));
  const depth = (fx, fy, dx, dy, colour) => { let n = 0; for (let i = 0; i < 40; i++) { const x = Math.round(fx + dx * i), y = Math.round(fy + dy * i); if (x < 0 || y < 0 || x >= W || y >= H || name(px(x, y)) !== colour) break; n++; } return n; };
  return { size: W + 'x' + H, bars, content: CW + 'x' + CH, contentRatio: +(CW / CH).toFixed(4),
    top: along(f => px(L + Math.round(f * (CW - 1)), T)), top2: along(f => px(L + Math.round(f * (CW - 1)), T + 2)),
    bottom: along(f => px(L + Math.round(f * (CW - 1)), B)), left: along(f => px(L, T + Math.round(f * (CH - 1)))), right: along(f => px(R, T + Math.round(f * (CH - 1)))),
    bandPx: { top: depth(L + CW / 2, T, 0, 1, 'red'), bottom: depth(L + CW / 2, B, 0, -1, 'blue'), left: depth(L, T + CH / 2, 1, 0, 'magenta'), right: depth(R, T + CH / 2, -1, 0, 'green') } };
})()`);
console.log(JSON.stringify(result));
c.close();
