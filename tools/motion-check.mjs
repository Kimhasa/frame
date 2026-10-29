// Is the motion-test window (Edge, DevTools 9333) really animating? A hidden or occluded window is throttled by Edge,
// which makes the broadcast nearly static (very low bitrate) and load results meaningless. Prints visibility, the
// page's measured animation frame rate and the broadcast's source bitrate from the app's /api/stats.
// usage: node tools/motion-check.mjs [viewer url]
import { connect, sleep } from './cdp.mjs';

const url = process.argv[2] || 'http://192.168.1.27:8889/screen-01';
const m = await connect(9333, t => t.type === 'page' && t.url.includes('motion'));
const page = await m.evaluate(`new Promise(resolve => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve({ visibility: document.visibilityState, rafFps: +(n / ((performance.now() - t0) / 1000)).toFixed(1), size: innerWidth + 'x' + innerHeight }); }; requestAnimationFrame(tick); setTimeout(() => resolve({ visibility: document.visibilityState, rafFps: 0, size: innerWidth + 'x' + innerHeight }), 4000); })`);
m.close();
const origin = new URL(url).origin, path = new URL(url).pathname.slice(1);
const stats = async () => (await fetch(origin + '/api/stats', { cache: 'no-store' })).json();
const a = await stats(); await sleep(5000); const b = await stats();
const sourceMbps = a.paths[path] && b.paths[path] ? +((b.paths[path].bytesReceived - a.paths[path].bytesReceived) * 8 / ((b.timeMs - a.timeMs) / 1000) / 1e6).toFixed(2) : null;
console.log(JSON.stringify({ ...page, sourceMbps }));
