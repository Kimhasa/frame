// Mobile and tablet layout check of the viewer page (UI 0.6 mobile addendum, UI_V06_ADDENDUM.json).
// A headless Edge with device emulation (touch, DPR 2-3 phones / 2 tablets, emulated safe-area insets) opens the built page
// from a local static server, where it runs in remote viewer mode. The broadcast list, chat and player states are built
// by this script only (fixture JSON, SVG thumbnails, a <video> fed by canvas.captureStream()); none of it is product code.
// "before" is the current build with the 0.6 changes taken out (same scripts), so differences come from 0.6 alone. Mouse
// windows and the FrameConsole app on a touch screen (html.frame-native added by this script, as the app's script does in
// WebView2) are pixel-compared before/after: 801 px and wider must be unchanged outside the removed badge; 800 px is
// compared for information only (narrow-window rules apply there). Emulation is a layout test: real iPhone Safari /
// Android Chrome (WebKit, decoding, audio policy, real on-screen keyboard, address bar) are not covered by it. The
// "keyboard" state only sets --frame-visual-height (the hook the page script fills from visualViewport) to a smaller value.
// Live phase (unless --no-live): the bundled MediaMTX and FFmpeg publish a test pattern on loopback (RTSP, WebRTC, ICE
// ports below) and the page plays it through its own WHEP player code, so auto-hide, tap-to-show and tap-to-pause run on
// the real <video> at each size. No audio, DVR or chat in that phase.
// usage: node tools/capture-mobile.mjs [--sizes phone-390,desktop] [--builds after,before] [--no-shots] [--no-live]
//          [--port 23100] [--devtools 23222] [--rtsp 23554] [--webrtc 23889] [--ice 23189] [--out <dir>] [--git-head]
//          [--page <file>]
// page: by default the 0.6 baseline, a fresh build without the 0.6.1 stylesheet (work/build-console.mjs --without-0.6.1
// into a temp file), the same page tools/verify-ui-v06.mjs checks; --page uses another built page instead.
// output: <out>/<build>/<size>-<state>.png, <out>/diff/<size>-<state>.png, <out>/results.json. A full run (all sizes, both
// builds, screenshots and live phase) writes verification/mobile/ and replaces only after/, before/, diff/ and
// results.json there; any partial run writes verification/mobile/partial/<sizes>_<builds>/ instead, so the full evidence
// is never wiped. --git-head also compares the before build with git HEAD:outputs/index.html (read-only git call).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, sleep } from './cdp.mjs';

const root = new URL('../', import.meta.url);
const args = process.argv.slice(2), option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(option('port', 23100)), DEVTOOLS = Number(option('devtools', 23222));
const shots = !args.includes('--no-shots'), live = !args.includes('--no-live');
const LIVE = { rtsp: Number(option('rtsp', 23554)), webrtc: Number(option('webrtc', 23889)), ice: Number(option('ice', 23189)), path: 'mobile' };
// This tool shares the machine with the app and other tests: it stays inside its own port range, on loopback only.
const ports = { http: PORT, devtools: DEVTOOLS, ...(live ? { rtsp: LIVE.rtsp, webrtc: LIVE.webrtc, ice: LIVE.ice } : {}) };
for (const [name, port] of Object.entries(ports)) if (!(Number.isInteger(port) && port >= 23000 && port <= 23999)) throw new Error('--' + (name === 'http' ? 'port' : name) + ' must stay in 23000-23999');
if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('ports must differ: ' + JSON.stringify(ports));
// A busy port is an error, never a reason to attach to someone else's browser or media server.
const portFree = (port, udp) => new Promise(resolve => {
  const socket = udp ? dgram.createSocket('udp4') : net.createServer();
  socket.once('error', () => resolve(false));
  const done = () => (udp ? socket.close(() => resolve(true)) : socket.close(() => resolve(true)));
  udp ? socket.bind(port, '127.0.0.1', done) : socket.listen(port, '127.0.0.1', done);
});
for (const [name, port] of Object.entries(ports)) if (!(await portFree(port, name === 'ice'))) throw new Error(`port ${port} (${name}) is in use; pick another one in 23000-23999`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// Phone sizes use iPhone-like safe areas (Safari, toolbar collapsed); 360 px stands for an Android phone without insets.
// mobile: emulated as a phone/tablet browser (default: same as touch). native: html.frame-native, the FrameConsole app
// (WebView2) on a Windows touch screen, which must keep the desktop UI.
const SIZES = [
  { name: 'phone-360', width: 360, height: 780, dpr: 3, touch: true, insets: {} },
  { name: 'phone-390', width: 390, height: 844, dpr: 3, touch: true, insets: { bottom: 34 } },
  { name: 'phone-430', width: 430, height: 932, dpr: 3, touch: true, insets: { bottom: 34 } },
  { name: 'phone-landscape', width: 844, height: 390, dpr: 3, touch: true, insets: { left: 47, right: 47, bottom: 21 } },
  { name: 'tablet-portrait', width: 768, height: 1024, dpr: 2, touch: true, insets: {} },
  { name: 'tablet-landscape', width: 1024, height: 768, dpr: 2, touch: true, insets: {} },
  { name: 'tablet-820', width: 820, height: 1180, dpr: 2, touch: true, insets: {} },
  { name: 'desktop', width: 1440, height: 1000, dpr: 1, touch: false, insets: {} },
  { name: 'desktop-1100', width: 1100, height: 800, dpr: 1, touch: false, insets: {} },
  { name: 'phone-320', width: 320, height: 568, dpr: 2, touch: true, insets: {} },
  { name: 'android-land-780', width: 780, height: 360, dpr: 3, touch: true, insets: {} },
  { name: 'se-land-667', width: 667, height: 375, dpr: 2, touch: true, insets: {} },
  { name: 'promax-land-932', width: 932, height: 430, dpr: 3, touch: true, insets: { left: 59, right: 59, bottom: 21 } },
  { name: 'ipad13-land-1376', width: 1376, height: 1032, dpr: 2, touch: true, insets: {} },
  { name: 'ipad13-port-1024', width: 1024, height: 1366, dpr: 2, touch: true, insets: {} },
  { name: 'mouse-800', width: 800, height: 700, dpr: 1, touch: false, insets: {} },
  { name: 'mouse-801', width: 801, height: 700, dpr: 1, touch: false, insets: {} },
  { name: 'mouse-1000', width: 1000, height: 700, dpr: 1, touch: false, insets: {} },
  { name: 'native-touch-1280', width: 1280, height: 800, dpr: 1.5, touch: true, mobile: false, native: true, insets: {} }
];
const sizeFilter = option('sizes') ? option('sizes').split(',') : null;
for (const name of sizeFilter || []) if (!SIZES.some(size => size.name === name)) throw new Error('unknown size ' + name + '; known: ' + SIZES.map(size => size.name).join(','));
const sizes = SIZES.filter(size => !sizeFilter || sizeFilter.includes(size.name));
const buildNames = (option('builds') || 'after,before').split(',');
for (const build of buildNames) if (!['after', 'before'].includes(build)) throw new Error('unknown build ' + build);
// Pixel comparison before/after: mouse windows and the app on a touch screen. Unchanged is required from 801 px up.
const compared = size => !size.touch || size.native, mustBeUnchanged = size => size.native || size.width > 800;
const fullRun = !sizeFilter && buildNames.length === 2 && shots && live;
const out = option('out') ? pathToFileURL(resolve(option('out')) + '/') : new URL(fullRun ? 'verification/mobile/'
  : 'verification/mobile/partial/' + ((sizeFilter || ['all']).join('+') + '_' + buildNames.join('+') + (shots ? '' : '_noshots') + (live ? '' : '_nolive')).replace(/[^\w+.-]/g, '').slice(0, 90) + '/', root);
const repoPath = path => relative(fileURLToPath(root), fileURLToPath(path)).replace(/\\/g, '/');

// ---- Builds -------------------------------------------------------------------------------------------------------
const addendum = JSON.parse(await readFile(new URL('UI_V06_ADDENDUM.json', root), 'utf8'));
const mobileCss = await readFile(new URL(addendum.stylesheet.path, root), 'utf8');
const afterHtml = await (async () => {
  if (option('page')) return readFile(resolve(option('page')), 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'frame-capture-mobile-page-')), file = join(dir, 'index.html');
  const build = spawnSync(process.execPath, [fileURLToPath(new URL('work/build-console.mjs', root)), '--without-0.6.1', '--out', file], { cwd: fileURLToPath(root), encoding: 'utf8' });
  if (build.status !== 0) throw new Error('build without 0.6.1 failed: ' + (build.stderr || build.stdout).trim().slice(0, 300));
  const html = await readFile(file, 'utf8'); await rm(dir, { recursive: true, force: true }); return html;
})();
function revert(html) {
  const once = (text, part) => { if (text.split(part).length !== 2) throw new Error('0.6 change not found exactly once: ' + part.slice(0, 70)); };
  once(html, '\n' + mobileCss);
  let page = html.replace('\n' + mobileCss, '');
  for (const edit of [...addendum.template.edits].reverse()) { once(page, edit.to); page = page.replace(edit.to, () => edit.from); }
  return page;
}
const builds = { after: afterHtml, before: revert(afterHtml) };
const withoutScripts = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const sha256 = text => createHash('sha256').update(text).digest('hex');
let headHtml = null;
if (args.includes('--git-head')) try { headHtml = execFileSync('git', ['show', 'HEAD:outputs/index.html'], { cwd: fileURLToPath(root), maxBuffer: 1 << 27 }).toString('utf8'); } catch {}

// ---- Test-only fixtures, served by this script ----------------------------------------------------------------------
const base = 'http://127.0.0.1:' + PORT;
const broadcasts = [
  ['개발팀 화면 공유', 'DEV-PC-01', 1080, 60], ['주간 회의 자료', 'MEETING-ROOM', 1080, 30], ['디자인 검토 화면', 'DESIGN-PC', 1440, 60],
  ['서버 모니터링 대시보드', 'OPS-PC-02', 720, 30], ['교육용 실습 화면', 'TRAINING-PC', 1080, 60]
].map(([title, publisher, height, fps], index) => ({ id: 'mobile-test-' + (index + 1), title, publisher, height, fps, path: 'screen-0' + (index + 1),
  baseUrl: base, thumbnailUrl: base + '/__test/thumb-' + (index + 1) + '.svg', running: true }));
const thumbnail = n => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d3445"/><stop offset="1" stop-color="#${['2d6a52', '3b4f7a', '6a4b2d', '2d5f6a', '5a2d6a'][n - 1]}"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><rect x="90" y="90" width="1100" height="70" rx="8" fill="#ffffff22"/><rect x="90" y="200" width="520" height="420" rx="8" fill="#ffffff18"/><rect x="660" y="200" width="530" height="190" rx="8" fill="#ffffff18"/><rect x="660" y="430" width="530" height="190" rx="8" fill="#ffffff18"/></svg>`;
const messages = [['시청자1', '안녕하세요. 화면 잘 보입니다.'], ['QA-Mobile', '휴대폰 세로 화면에서 확인 중입니다.'], ['시청자2', '글자가 선명하게 보이네요.'],
  ['관리자', '긴 메시지 줄바꿈 확인: 가나다라마바사아자차카타파하 가나다라마바사아자차카타파하 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'], ['시청자3', '채팅 입력도 가능합니다.'], ['시청자1', '좋아요!']]
  .map(([author, text], index) => ({ id: 'm' + (index + 1), author, text }));

const types = { '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const send = (status, type, body, cache = 'no-store') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache }); res.end(body); };
  try {
    if (url.pathname === '/' || url.pathname === '/' + LIVE.path) return send(200, 'text/html; charset=utf-8', builds[url.searchParams.get('build')] ?? builds.after);
    // Live phase: the viewer server's info and WHEP routes, answered for the loopback test stream.
    if (url.pathname === '/' + LIVE.path + '/info') return send(200, 'application/json', JSON.stringify({ running: true, title: '모바일 실측 스트림', path: LIVE.path,
      width: 1280, height: 720, fps: 30, bitrate: 2, audio: 'none', renditions: [], dvr: false, iceServers: [] }));
    if (url.pathname.startsWith('/' + LIVE.path + '/whep') && /^\/[\w-]+\/whep(\/[\w-]+)?$/.test(url.pathname)) {
      const body = await new Promise(done => { const parts = []; req.on('data', part => parts.push(part)); req.on('end', () => done(Buffer.concat(parts))); });
      const upstream = await fetch('http://127.0.0.1:' + LIVE.webrtc + url.pathname, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/sdp' }, body: body.length ? body : undefined });
      const headers = { 'Content-Type': upstream.headers.get('content-type') || 'text/plain' };
      if (upstream.headers.get('location')) headers.Location = upstream.headers.get('location');
      res.writeHead(upstream.status, headers); res.end(Buffer.from(await upstream.arrayBuffer())); return;
    }
    if (url.pathname === '/api/broadcasts') return send(200, 'application/json', JSON.stringify(broadcasts));
    const thumb = url.pathname.match(/^\/__test\/thumb-([1-5])\.svg$/);
    if (thumb) return send(200, 'image/svg+xml', thumbnail(Number(thumb[1])), 'max-age=3600');
    if (/^\/assets\/fonts\/[\w.-]+$/.test(url.pathname)) return send(200, types[extname(url.pathname)] || 'application/octet-stream', await readFile(new URL('outputs' + url.pathname, root)), 'max-age=3600');
  } catch {}
  send(404, 'text/plain', 'not found');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });

// ---- Page-side helpers (serialized into the page; test only) ------------------------------------------------------
function installProbe() {
  const $ = id => document.getElementById(id);
  const box = r => [r.left, r.top, r.width, r.height].map(v => Math.round(v * 10) / 10);
  const shown = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const view = (insets, visibleHeight) => { const W = document.documentElement.clientWidth, H = visibleHeight || innerHeight; return { W, H, l: insets.left || 0, t: insets.top || 0, r: W - (insets.right || 0), b: H - (insets.bottom || 0) }; };
  const inside = (r, v, safe) => r.left >= (safe ? v.l : 0) - 0.5 && r.top >= (safe ? v.t : 0) - 0.5 && r.right <= (safe ? v.r : v.W) + 0.5 && r.bottom <= (safe ? v.b : v.H) + 0.5;
  // A control counts as reachable only if a tap at its centre lands on it (not on a panel drawn over it).
  const hitAt = el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (hit === el || el.contains(hit) || !!hit.closest('label')?.contains(el)); };
  // Inside a dialog the body scrolls: a field below the fold is reachable when scrolling the body brings it to the finger.
  const covered = el => {
    if (!el.matches('button,input,textarea,[tabindex]') || hitAt(el)) return false;
    const body = el.closest('dialog .dialog-body'); if (!body) return true;
    const top = body.scrollTop; el.scrollIntoView({ block: 'nearest' }); const reachable = hitAt(el); body.scrollTop = top; return !reachable;
  };
  const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // full: must be completely on screen (inside the safe area); across: only horizontally (lists scroll vertically);
  // within: [container, selectors] - each shown element must lie inside the container (player controls inside the frame).
  // visibleHeight: the height above an on-screen keyboard (keyboard state), instead of innerHeight.
  function measure({ full = [], across = [], targets = [], within = [], insets = {}, visibleHeight = 0 }) {
    const v = view(insets, visibleHeight), items = [];
    const each = (list, fn) => { for (const sel of list) for (const el of document.querySelectorAll(sel)) if (shown(el)) fn(el, sel); };
    each(full, (el, sel) => { const r = el.getBoundingClientRect(); items.push({ kind: 'full', sel: el.id ? '#' + el.id : sel, rect: box(r), inViewport: inside(r, v, false), inSafeArea: inside(r, v, true), covered: inside(r, v, false) && covered(el) }); });
    each(across, (el, sel) => { const r = el.getBoundingClientRect(); items.push({ kind: 'across', sel: el.id ? '#' + el.id : sel, rect: box(r), inViewport: r.left >= -0.5 && r.right <= v.W + 0.5, inSafeArea: r.left >= v.l - 0.5 && r.right <= v.r + 0.5 }); });
    // Touch target: the hit box of the control (a range input's whole box, not its thumb).
    each(targets, (el, sel) => { const r = el.getBoundingClientRect(); items.push({ kind: 'target', sel: el.id ? '#' + el.id : sel, size: [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10], ok: Math.min(r.width, r.height) >= 43.5, clipped: el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1 }); });
    for (const [container, list] of within) { const c = document.querySelector(container); if (!c || !shown(c)) continue; const cr = c.getBoundingClientRect();
      each(list, (el, sel) => { const r = el.getBoundingClientRect(); items.push({ kind: 'within', sel: el.id ? '#' + el.id : sel, container, rect: box(r), ok: r.left >= cr.left - 0.5 && r.top >= cr.top - 0.5 && r.right <= cr.right + 0.5 && r.bottom <= cr.bottom + 0.5 }); }); }
    return { innerWidth, innerHeight, visibleHeight: v.H, clientWidth: v.W, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, overflowY: document.documentElement.scrollHeight > innerHeight + 1,
      visualScale: visualViewport ? Math.round(visualViewport.scale * 1000) / 1000 : 1, overflowX: document.documentElement.scrollWidth > v.W || document.body.scrollWidth > v.W, items };
  }
  // The picture inside the player: the test video fills the player box and is fitted with object-fit (contain expected).
  function picture(insets = {}) {
    const frame = $('viewer-preview'), video = frame.querySelector('video'), v = view(insets);
    const f = frame.getBoundingClientRect(), r = video.getBoundingClientRect(), fit = getComputedStyle(video).objectFit;
    const s = fit === 'contain' ? Math.min(r.width / video.videoWidth, r.height / video.videoHeight) : Math.max(r.width / video.videoWidth, r.height / video.videoHeight);
    const w = video.videoWidth * s, h = video.videoHeight * s, p = { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2 };
    Object.assign(p, { right: p.left + w, bottom: p.top + h, width: w, height: h });
    const visible = { left: Math.max(p.left, f.left, 0), top: Math.max(p.top, f.top, 0), right: Math.min(p.right, f.right, v.W), bottom: Math.min(p.bottom, f.bottom, v.H) };
    const shownArea = Math.max(0, visible.right - visible.left) * Math.max(0, visible.bottom - visible.top);
    return { source: [video.videoWidth, video.videoHeight], objectFit: fit, frame: box(f), frameRatio: Math.round(f.width / f.height * 1000) / 1000, video: box(r), picture: box(p),
      fillsFrame: Math.abs(r.left - f.left) < 1 && Math.abs(r.top - f.top) < 1 && Math.abs(r.width - f.width) < 1 && Math.abs(r.height - f.height) < 1,
      pictureShownPct: Math.round(shownArea / (w * h) * 1000) / 10, frameInViewport: inside(f, v, false), frameInSafeArea: inside(f, v, true) };
  }
  // The player frame must not move or resize when the controls hide or the timeline disappears.
  function stability() {
    const frame = $('viewer-preview'), at = () => JSON.stringify(box(frame.getBoundingClientRect())), shownAt = at();
    frame.classList.add('controls-idle'); const idleAt = at(); frame.classList.remove('controls-idle');
    $('player-timeline').hidden = true; const noTimelineAt = at(); $('player-timeline').hidden = false;
    return { stable: shownAt === idleAt && idleAt === noTimelineAt, shown: shownAt, idle: idleAt, noTimeline: noTimelineAt };
  }
  function overlap(a, b) { const x = document.querySelector(a), y = document.querySelector(b); return x && y && shown(x) && shown(y) ? Math.round(area(x.getBoundingClientRect(), y.getBoundingClientRect())) : 0; }
  function dialog(id, insets = {}) {
    const d = $(id), r = d.getBoundingClientRect(), v = view(insets), body = d.querySelector('.dialog-body');
    return { open: d.open, rect: box(r), inViewport: inside(r, v, false), inSafeArea: inside(r, v, true), bodyScrolls: body.scrollHeight > body.clientHeight + 1, dialogScrolls: d.scrollHeight > d.clientHeight + 1 };
  }
  // Test picture: a static pattern with a bright edge, so a cropped edge is visible in the screenshots.
  function paint(canvas) {
    const g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    g.fillStyle = '#1d3445'; g.fillRect(0, 0, w, h); g.strokeStyle = '#ffffff26'; g.lineWidth = 2;
    for (let x = 0; x <= w; x += 80) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 80) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = '#22d581'; g.lineWidth = 12; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#ffffff'; g.font = '600 ' + Math.round(Math.min(w, h) / 9) + 'px Pretendard, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('TEST ' + w + 'x' + h, w / 2, h / 2);
  }
  async function testVideo(w, h) {
    const canvas = window.__testCanvas || (window.__testCanvas = document.createElement('canvas'));
    canvas.width = w; canvas.height = h; paint(canvas);
    let video = $('viewer-preview').querySelector('video');
    if (!video) {
      video = document.createElement('video'); video.muted = true; video.playsInline = true; video.autoplay = true;
      video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';  // same element setup as the player
      video.srcObject = canvas.captureStream(); $('viewer-canvas').after(video);
    }
    for (let i = 0; i < 200 && (video.videoWidth !== w || video.videoHeight !== h || video.readyState < 2); i++) { paint(canvas); await new Promise(r => setTimeout(r, 50)); }
    await video.play().catch(() => {});
    return [video.videoWidth, video.videoHeight];
  }
  // Player state like a connected stream, without a stream: stage shown, controls and DVR timeline visible, chat filled.
  // Picture-in-picture enabled, as the player script does where the browser supports it (desktop and Android Chrome):
  // the widest control bar.
  async function stage(messages) {
    window.FrameUI.showStage(true);
    $('no-signal').hidden = true; $('player-controls').hidden = false; $('chat-toggle').disabled = false; $('player-pip').disabled = false;
    $('viewer-title').textContent = '개발팀 화면 공유'; $('info-resolution').textContent = '1080p (자동)'; $('info-fps').textContent = '60 fps';
    $('info-bitrate').textContent = '8.0 Mbps'; $('info-audio').textContent = '시스템 오디오'; $('viewer-clock').textContent = '00:12:34';
    window.FrameUI.setTimeline({ startMs: 0, endMs: 3600000, positionMs: 2700000, mode: 'history' });
    window.FrameUI.setChatState({ connected: true, canSend: true, broadcastId: 'mobile-test-1' });
    window.FrameUI.setMessages(messages);
    return testVideo(1280, 720);
  }
  window.__m = { covered: sel => covered(document.querySelector(sel)), measure, picture, stability, overlap, dialog, testVideo, stage };
}
function comparePixels(a, b, masks) {
  const load = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
  return Promise.all([load(a), load(b)]).then(async ([ra, rb]) => {
    const W = ra.naturalWidth, H = ra.naturalHeight;
    if (rb.naturalWidth !== W || rb.naturalHeight !== H) return { sameSize: false };
    const pixels = img => { const c = new OffscreenCanvas(W, H), x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, W, H).data; };
    const A = pixels(ra), B = pixels(rb), out = new OffscreenCanvas(W, H), ox = out.getContext('2d'), img = ox.createImageData(W, H), d = img.data;
    const masked = (x, y) => masks.some(([mx, my, mw, mh]) => x >= mx && x < mx + mw && y >= my && y < my + mh);
    let changed = 0, changedOutsideMask = 0, strong = 0, bounds = null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, delta = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      const g = (A[i] + A[i + 1] + A[i + 2]) / 3 * 0.35 + 160;
      d[i + 3] = 255;
      if (delta > 0) { changed++; if (delta > 40) strong++; bounds = bounds ? [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)] : [x, y, x, y]; }
      if (delta > 0 && !masked(x, y)) changedOutsideMask++;
      if (delta > 0) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; } else if (masked(x, y)) { d[i] = g * 0.6; d[i + 1] = g * 0.7; d[i + 2] = 255; } else d[i] = d[i + 1] = d[i + 2] = g;
    }
    ox.putImageData(img, 0, 0);
    const buf = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = ''; for (let k = 0; k < buf.length; k += 32768) bin += String.fromCharCode(...buf.subarray(k, k + 32768));
    return { sameSize: true, width: W, height: H, changedPixels: changed, changedPctOfPage: +(changed / (W * H) * 100).toFixed(4), strongPixels: strong, changedOutsideMask, changedBounds: bounds, diff: btoa(bin) };
  });
}

// ---- Browser ------------------------------------------------------------------------------------------------------
const profile = join(tmpdir(), 'frame-capture-mobile-' + process.pid);
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + DEVTOOLS, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', 'about:blank'], { stdio: 'ignore' });
// Media processes are children of this script only and are ended by PID on any exit.
const children = [];
process.on('exit', () => { for (const child of children) if (child.exitCode === null) try { child.kill(); } catch {} });
let c;
for (let i = 0; i < 80 && !c; i++) { try { c = await connect(DEVTOOLS); } catch { await sleep(250); } }
if (!c) throw new Error('headless Edge did not start on port ' + DEVTOOLS);
const browserInfo = await (await fetch('http://127.0.0.1:' + DEVTOOLS + '/json/version')).json();
let loaded = null;
c.on(message => { if (message.method === 'Page.loadEventFired' && loaded) { loaded(); loaded = null; } });
await c.send('Page.enable');
const js = expression => c.evaluate(expression);
const call = (fn, ...values) => js('(' + fn + ')(' + values.map(value => JSON.stringify(value)).join(',') + ')');
async function waitFor(expression, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await js(expression)) return true; await sleep(100); } return false; }
async function emulate(size) {
  const landscape = size.width > size.height;
  await c.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: size.mobile ?? size.touch,
    ...(size.touch ? { screenOrientation: { type: landscape ? 'landscapePrimary' : 'portraitPrimary', angle: landscape ? 90 : 0 } } : {}) });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: size.touch, maxTouchPoints: size.touch ? 5 : 1 });
  await c.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0, ...size.insets } });
}
async function open(build, size, path = '/') {
  const done = new Promise(resolve => { loaded = resolve; });
  await c.send('Page.navigate', { url: base + path + '?build=' + build });
  await Promise.race([done, sleep(10000)]);
  // The FrameConsole app's script marks WebView2 with html.frame-native; here the class stands in for it (both builds).
  if (size.native) await js("document.documentElement.classList.add('frame-native'), true");
  await js('document.fonts.ready.then(() => true)');
  await js('(' + installProbe + ')(), true');
  if (path !== '/') return;
  // Thumbnails on screen are loaded (lazy ones below the fold are not needed for the viewport capture).
  await waitFor(`document.querySelectorAll('.broadcast-card').length === ${broadcasts.length} && [...document.querySelectorAll('.broadcast-card img')].filter(i => i.getBoundingClientRect().top < innerHeight).every(i => i.complete && i.naturalWidth)`);
}
const settle = async () => { await js('document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); await sleep(250); };
async function shot(build, size, state) {
  await settle();
  if (!shots) return null;
  const file = `${build}/${size.name}-${state}.png`;
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(file, out), Buffer.from(r.data, 'base64'));
  return repoPath(new URL(file, out));
}
const coveredTaps = [];
async function tap(selector) {
  const p = await c.center(selector);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function press(size, selector, build) {
  if (await call('(s) => window.__m.covered(s)', selector)) { coveredTaps.push({ build, size: size.name, selector }); return js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  if (size.touch) return tap(selector);
  const p = await c.center(selector);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });  // no hover styles left in later captures
}
// Finger drag on the volume slider, 14 px below the track's centre line: inside a 44 px hit box, outside the 24 px one.
async function dragVolume() {
  const r = await js(`(() => { const e = document.getElementById('player-volume'), b = e.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width, h: b.height, shown: getComputedStyle(e).display !== 'none' && b.width > 0 }; })()`);
  if (!r.shown) return { shown: false, ok: true, note: 'slider hidden in this player width; mute button and the device volume keys remain' };
  const y = r.y + 14, from = r.x + r.w * 0.85, to = r.x + r.w * 0.3;
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
  for (let i = 1; i <= 8; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 8, y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(100);
  const value = Number(await js(`document.getElementById('player-volume').value`));
  await js(`(() => { const e = document.getElementById('player-volume'); e.value = 80; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  return { shown: true, sliderHeight: Math.round(r.h * 10) / 10, touchOffsetFromCentre: 14, expected: 30, value, ok: Math.abs(value - 30) <= 12 };
}

// ---- Captures -----------------------------------------------------------------------------------------------------
const NAV = ['#tab-sender', '#tab-viewer'];
const STAGE = ['#viewer-info-button', '#chat-toggle'];
const PLAYER = ['#player-pause', '#player-mute', '#player-volume', '#player-seek', '#player-live', '#player-settings', '#player-pip', '#viewer-wide', '#viewer-fullscreen'];
const CHAT = ['#chat-name-button', '#chat-close', '#chat-message', '#chat-send'];
const dialogParts = id => [`#${id}`, `#${id} .dialog-head .icon-button`, `#${id} .dialog-footer button`, `#${id} input:not([type=hidden])`];
const dialogTargets = id => [`#${id} .dialog-head .icon-button`, `#${id} .dialog-footer button`];
// Only what this run writes is replaced; other runs' evidence next to it (e.g. partial/) stays.
for (const part of ['after/', 'before/', 'diff/', 'results.json']) await rm(new URL(part, out), { recursive: true, force: true });
if (shots) for (const build of buildNames) await mkdir(new URL(build + '/', out), { recursive: true });
if (shots) await mkdir(new URL('diff/', out), { recursive: true });
await mkdir(out, { recursive: true });
const runs = [], touchChecks = [];
// The removed badge's place, per state (a scrollbar on the list page shifts it), masks the desktop comparison.
const badgeAt = () => js(`(() => { const e = document.querySelector('.topbar .environment'); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.floor(r.left) - 4, Math.floor(r.top) - 4, Math.ceil(r.width) + 8, Math.ceil(r.height) + 8]; })()`);
async function record(build, size, state, file, data) {
  const badge = compared(size) && build === 'before' ? await badgeAt() : undefined;
  runs.push({ build, size: size.name, state, file, ...(badge ? { badge } : {}), ...data }); console.log(build, size.name, state);
}

for (const build of buildNames) for (const size of sizes) {
  const insets = size.insets, coarse = size.touch;
  await emulate(size);
  await open(build, size);
  const media = await js(`({ coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, dpr: devicePixelRatio, viewport: document.querySelector('meta[name=viewport]').content })`);
  const measure = spec => call('(spec) => window.__m.measure(spec)', { insets, ...spec, targets: coarse ? spec.targets || [] : [] });

  await record(build, size, 'list', await shot(build, size, 'list'), { media, measure: await measure({ full: [...NAV, '#broadcast-search', '#refresh-broadcasts', '#manual-connect'], across: ['.broadcast-card', '.catalog-toolbar'], targets: [...NAV, '#refresh-broadcasts', '#manual-connect', '.catalog-search'] }) });

  await press(size, '#manual-connect', build); await sleep(300);
  await record(build, size, 'manual', await shot(build, size, 'manual'), { dialog: await call('(id, i) => window.__m.dialog(id, i)', 'viewer-connect-dialog', insets),
    measure: await measure({ full: dialogParts('viewer-connect-dialog'), targets: dialogTargets('viewer-connect-dialog') }) });
  await js(`document.getElementById('viewer-connect-dialog').close()`); await sleep(200);

  const source = await call('(m) => window.__m.stage(m)', messages);
  await js(`document.getElementById('chat-panel').hidden || document.getElementById('chat-close').click()`); await sleep(200);
  const playerSpec = { full: [...NAV, ...STAGE, ...PLAYER, '#viewer-preview'], targets: [...NAV, ...STAGE, ...PLAYER], within: [['#viewer-preview', PLAYER]] };
  const portrait = await (async () => { await call('(w, h) => window.__m.testVideo(w, h)', 720, 1280); const p = await call('(i) => window.__m.picture(i)', insets); await call('(w, h) => window.__m.testVideo(w, h)', 1280, 720); return p; })();
  await record(build, size, 'player', await shot(build, size, 'player'), { viewer: true, source, picture: await call('(i) => window.__m.picture(i)', insets), portraitSource: portrait,
    stability: await js('window.__m.stability()'), measure: await measure(playerSpec) });

  await press(size, '#chat-toggle', build); await sleep(300);
  await record(build, size, 'chat', await shot(build, size, 'chat'), { viewer: true, picture: await call('(i) => window.__m.picture(i)', insets), stability: await js('window.__m.stability()'),
    chatOverPlayer: await call('(a, b) => window.__m.overlap(a, b)', '#chat-panel', '#viewer-preview'),
    measure: await measure({ full: [...playerSpec.full, ...CHAT], targets: [...playerSpec.targets, '#chat-name-button', '#chat-close', '#chat-send'], within: playerSpec.within }) });

  // On-screen keyboard (touch browsers): the page script sets --frame-visual-height from visualViewport.height; here it
  // is set by hand to the height left above a typical keyboard. The message box, the send button and the player frame
  // must stay above it, and the page must not scroll. Not a real keyboard (no focus, no visual-viewport panning).
  if (coarse && !size.native) {
    const landscape = size.width > size.height, keyboardHeight = Math.round(size.height * (landscape ? 0.55 : size.height >= 900 ? 0.33 : 0.45));
    const visibleHeight = size.height - keyboardHeight;
    const previous = await call('(h) => { const s = document.documentElement.style, p = s.getPropertyValue("--frame-visual-height"); s.setProperty("--frame-visual-height", h + "px"); return p; }', visibleHeight);
    await sleep(300);
    await record(build, size, 'keyboard', await shot(build, size, 'keyboard'), { viewer: true, keyboard: { height: keyboardHeight, visibleHeight },
      measure: await measure({ full: ['#viewer-preview', ...CHAT], within: playerSpec.within, insets: { ...insets, bottom: 0 }, visibleHeight }) });
    await call('(p) => { const s = document.documentElement.style; p ? s.setProperty("--frame-visual-height", p) : s.removeProperty("--frame-visual-height"); return true; }', previous);
    await sleep(200);
  }

  await press(size, '#chat-name-button', build); await sleep(300);
  await record(build, size, 'chat-name', await shot(build, size, 'chat-name'), { dialog: await call('(id, i) => window.__m.dialog(id, i)', 'chat-name-dialog', insets),
    measure: await measure({ full: dialogParts('chat-name-dialog'), targets: dialogTargets('chat-name-dialog') }) });
  await js(`document.getElementById('chat-name-dialog').close()`); await sleep(200);

  await press(size, '#viewer-info-button', build); await sleep(300);
  await record(build, size, 'info', await shot(build, size, 'info'), { dialog: await call('(id, i) => window.__m.dialog(id, i)', 'viewer-info-dialog', insets),
    measure: await measure({ full: dialogParts('viewer-info-dialog'), targets: dialogTargets('viewer-info-dialog') }) });
  await js(`document.getElementById('viewer-info-dialog').close()`); await sleep(200);

  await js(`document.getElementById('chat-panel').hidden || document.getElementById('chat-close').click()`); await sleep(200);
  await press(size, '#player-settings', build); await sleep(300);
  const menuOpen = await js(`!document.getElementById('player-quality-menu').hidden`);
  await record(build, size, 'quality', await shot(build, size, 'quality'), { menuOpen, menuInPlayer: await js(`(() => { const m = document.getElementById('player-quality-menu').getBoundingClientRect(), f = document.getElementById('viewer-preview').getBoundingClientRect(); return m.top >= f.top - 0.5 && m.bottom <= f.bottom + 0.5 && m.left >= f.left - 0.5 && m.right <= f.right + 0.5; })()`),
    measure: await measure({ full: ['#player-quality-menu', '.quality-menu-option'], targets: ['.quality-menu-option'] }) });
  await js(`document.getElementById('player-quality-menu').hidden = true; document.getElementById('chat-panel').hidden && document.getElementById('chat-toggle').click(); document.getElementById('viewer-view').classList.add('is-wide')`); await sleep(300);
  await record(build, size, 'wide', await shot(build, size, 'wide'), { viewer: true, picture: await call('(i) => window.__m.picture(i)', insets), stability: await js('window.__m.stability()'),
    chatOverPlayer: await call('(a, b) => window.__m.overlap(a, b)', '#chat-panel', '#viewer-preview'), measure: await measure({ full: [...NAV, ...STAGE, ...PLAYER, '#viewer-preview', ...CHAT], within: playerSpec.within }) });
  await js(`document.getElementById('viewer-view').classList.remove('is-wide')`); await sleep(200);
  if (coarse) touchChecks.push({ build, size: size.name, volumeDrag: await (async () => { await js(`document.getElementById('player-quality-menu').hidden = true`); return dragVolume(); })() });
}

// ---- Live phase: real playback by the product player, finger taps on the picture -----------------------------------
const liveRuns = [];
if (live && buildNames.includes('after')) {
  const bin = new URL('dist/FrameConsole/bin/', root), dir = join(tmpdir(), 'frame-capture-mobile-live-' + process.pid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mediamtx.yml'), [
    'logLevel: warn', 'logDestinations: [stdout]', 'authInternalUsers:', '  - user: any', '    pass:', "    ips: ['127.0.0.1', '::1']", '    permissions:', '      - action: publish', '      - action: read',
    'api: false', 'metrics: false', 'pprof: false', 'playback: false', 'rtsp: true', 'rtspTransports: [tcp]', 'rtspEncryption: "no"', 'rtspAddress: 127.0.0.1:' + LIVE.rtsp,
    'rtmp: false', 'srt: false', 'moq: false', 'hls: false', 'webrtc: true', 'webrtcAddress: 127.0.0.1:' + LIVE.webrtc, 'webrtcEncryption: false', "webrtcAllowOrigins: ['*']",
    "webrtcLocalUDPAddress: '127.0.0.1:" + LIVE.ice + "'", "webrtcLocalTCPAddress: ''", 'webrtcIPsFromInterfaces: false', 'webrtcIPsFromInterfacesList: []', "webrtcAdditionalHosts: ['127.0.0.1']",
    'webrtcICEServers2: []', 'paths:', '  ' + LIVE.path + ':', '    source: publisher', ''].join('\n'));
  const mediamtx = spawn(fileURLToPath(new URL('mediamtx.exe', bin)), [join(dir, 'mediamtx.yml')], { stdio: 'ignore' }); children.push(mediamtx);
  await sleep(1500);
  // H.264 High, no B-frames, 1 s GOP like the product encoder; a moving test pattern, no audio.
  const ffmpeg = spawn(fileURLToPath(new URL('ffmpeg.exe', bin)), ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-c:v', 'libx264',
    '-profile:v', 'high', '-bf', '0', '-g', '30', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '2M', '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:' + LIVE.rtsp + '/' + LIVE.path], { stdio: 'ignore' });
  children.push(ffmpeg);
  await sleep(2500);
  const state = () => js(`(() => { const f = document.getElementById('viewer-preview'), v = f.querySelector('video'), r = f.getBoundingClientRect();
    return { frame: [r.left, r.top, r.width, r.height].map(n => Math.round(n * 10) / 10).join(','), idle: f.classList.contains('controls-idle'), paused: !document.getElementById('pause-overlay').hidden,
      videoPaused: v ? v.paused : null, time: v ? Math.round(v.currentTime * 10) / 10 : null, size: v ? [v.videoWidth, v.videoHeight] : null }; })()`);
  // A finger tap in the upper middle of the picture (away from the control bar).
  const tapPicture = async () => {
    const p = await js(`(() => { const r = document.getElementById('viewer-preview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.4 }; })()`);
    await js(`window.__events = []; if (!window.__logging) { window.__logging = true; for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, e => window.__events.push(type + ':' + (e.target.id || e.target.className || e.target.tagName) + (e.pointerType ? ':' + e.pointerType : '')), true); } true`);
    const hit = await js(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? (e.id || e.className || e.tagName) : null; })()`);
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] }); await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400); return { ...(await state()), hit, events: await js('window.__events') };
  };
  for (const size of sizes) {
    await emulate(size); await open('after', size, '/' + LIVE.path);
    const started = Date.now(), playing = await waitFor(`(() => { const v = document.querySelector('#viewer-preview video'); return !!(v && v.videoWidth && v.currentTime > 0.5); })()`, 20000);
    const run = { size: size.name, playing, firstFrameMs: playing ? Date.now() - started : null };
    if (playing) {
      await js(`document.getElementById('chat-panel').hidden || document.getElementById('chat-close').click()`);
      run.picture = await call('(i) => window.__m.picture(i)', size.insets);
      run.atStart = await state();
      const shownAt = Date.now();
      run.autoHidden = await waitFor(`document.getElementById('viewer-preview').classList.contains('controls-idle')`, 6000); run.autoHideMs = Date.now() - shownAt;
      run.idle = await state(); run.idleShot = await shot('after', size, 'live-idle');
      if (size.touch) {
        // Hidden controls: the first tap only shows them, the second (within the 2.5 s before they hide again) pauses, the
        // third resumes. Screenshots come after the taps: a DPR 3 capture can take longer than the auto-hide delay.
        run.firstTap = await tapPicture();
        run.secondTap = await tapPicture(); run.pausedShot = await shot('after', size, 'live-paused');
        run.thirdTap = await tapPicture(); run.controlsShot = await shot('after', size, 'live-controls');
        // A vertical swipe over the picture (scrolling) must not pause or resume.
        const from = await js(`(() => { const r = document.getElementById('viewer-preview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 }; })()`);
        await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
        for (let i = 1; i <= 6; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + i * 15 }] });
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(400);
        run.swipe = await state();
        run.tapFlowOk = run.idle.idle && !run.firstTap.idle && !run.firstTap.paused && run.secondTap.paused && !run.secondTap.idle && !run.thirdTap.paused && !run.swipe.paused;
      }
      const frames = [run.atStart, run.idle, run.firstTap, run.secondTap, run.thirdTap, run.swipe].filter(Boolean).map(item => item.frame);
      run.frameStable = frames.every(frame => frame === frames[0]);
      // The real control bar (picture-in-picture enabled where the browser supports it): every control inside the frame
      // and hit by a tap at its centre. The idle class is removed only for this measurement.
      run.pipEnabled = await js(`!document.getElementById('player-pip').disabled`);
      await js(`document.getElementById('viewer-preview').classList.remove('controls-idle'), true`);
      const bar = await call('(spec) => window.__m.measure(spec)', { insets: size.insets, full: PLAYER, within: [['#viewer-preview', PLAYER]] });
      run.controls = bar.items.filter(item => item.covered || item.inViewport === false || item.ok === false).map(item => item.sel + (item.kind === 'within' ? ' outside the player frame' : item.covered ? ' covered' : ' outside the viewport'));
      run.controlsOk = run.controls.length === 0;
    }
    run.ok = !!(run.playing && run.autoHidden && run.frameStable && run.controlsOk && run.picture.objectFit === 'contain' && run.picture.fillsFrame && run.picture.pictureShownPct >= 99.9 && (!size.touch || run.tapFlowOk));
    liveRuns.push(run);
    console.log('live', size.name, JSON.stringify({ ok: run.ok, playing: run.playing, firstFrameMs: run.firstFrameMs, autoHideMs: run.autoHideMs, tapFlowOk: run.tapFlowOk, frameStable: run.frameStable, pipEnabled: run.pipEnabled, controls: run.controls }));
  }
  await c.send('Page.navigate', { url: 'about:blank' }); await sleep(500);
  for (const child of [ffmpeg, mediamtx]) if (child.exitCode === null) child.kill();
  await sleep(500); await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ---- Desktop before/after pixel comparison --------------------------------------------------------------------------
const compare = [];
if (shots && buildNames.includes('before') && buildNames.includes('after')) {
  await c.send('Emulation.clearDeviceMetricsOverride'); await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Page.navigate', { url: 'about:blank' }); await sleep(300);
  for (const run of runs.filter(item => item.build === 'after' && item.file && compared(SIZES.find(size => size.name === item.size)))) {
    const size = SIZES.find(item => item.name === run.size), beforeFile = run.file.replace('/after/', '/before/');
    const dataUrl = async path => 'data:image/png;base64,' + (await readFile(new URL(path, root))).toString('base64');
    const badge = runs.find(item => item.build === 'before' && item.size === run.size && item.state === run.state)?.badge;
    const masks = badge ? [[Math.floor(badge[0] * size.dpr), Math.floor(badge[1] * size.dpr), Math.ceil(badge[2] * size.dpr), Math.ceil(badge[3] * size.dpr)]] : [];
    const r = await call(comparePixels, await dataUrl(beforeFile), await dataUrl(run.file), masks);
    if (r.diff) await writeFile(new URL(`diff/${run.size}-${run.state}.png`, out), Buffer.from(r.diff, 'base64'));
    delete r.diff;
    compare.push({ size: run.size, state: run.state, mustBeUnchanged: mustBeUnchanged(size), before: beforeFile, after: run.file, badgeMask: masks[0] || null, ...r, unchangedOutsideBadge: r.sameSize && r.changedOutsideMask === 0 });
    console.log('compare', run.size, run.state, JSON.stringify(compare.at(-1)));
  }
}

// ---- Verdicts -------------------------------------------------------------------------------------------------------
function failures(run) {
  const size = SIZES.find(item => item.name === run.size), list = [];
  const m = run.measure;
  if (m) {
    if (m.overflowX) list.push(`horizontal overflow (scrollWidth ${m.scrollWidth} > ${m.clientWidth})`);
    if (m.visualScale !== 1) list.push('page zoomed out (visual viewport scale ' + m.visualScale + ')');
    for (const item of m.items) {
      if (item.covered) list.push(item.sel + ' covered by another element');
      const placed = item.kind === 'full' || item.kind === 'across';
      if (placed && !item.inViewport) list.push(item.sel + ' outside the viewport ' + JSON.stringify(item.rect));
      else if (placed && !item.inSafeArea) list.push(item.sel + ' under a safe-area inset ' + JSON.stringify(item.rect));
      if (item.kind === 'target' && !item.ok) list.push(item.sel + ' touch target ' + item.size.join('x'));
      if (item.kind === 'target' && item.clipped) list.push(item.sel + ' label clipped');
      if (item.kind === 'within' && !item.ok) list.push(item.sel + ' outside the player frame ' + JSON.stringify(item.rect));
    }
    if (run.viewer && m.overflowY) list.push(`page scrolls vertically in the viewer (scrollHeight ${m.scrollHeight} > ${m.innerHeight})`);
  }
  if (run.media && size.touch && !run.media.coarse) list.push('emulation did not give (pointer: coarse)');
  for (const key of ['picture', 'portraitSource']) if (run[key]) {
    const p = run[key];
    if (p.objectFit !== 'contain') list.push(key + ': object-fit ' + p.objectFit);
    if (!p.fillsFrame) list.push(key + ': video does not fill the player frame');
    if (p.pictureShownPct < 99.9) list.push(key + `: only ${p.pictureShownPct}% of the picture on screen`);
    if (!p.frameInViewport) list.push(key + ': player frame outside the viewport');
  }
  if (run.stability && !run.stability.stable) list.push('player frame moves when controls hide or the timeline changes');
  if (run.chatOverPlayer) list.push(`chat covers ${run.chatOverPlayer} px² of the player`);
  if (run.dialog && (!run.dialog.inViewport || !run.dialog.inSafeArea)) list.push('dialog outside the visible area');
  if (run.state === 'quality' && (!run.menuOpen || !run.menuInPlayer)) list.push('quality menu ' + (run.menuOpen ? 'outside the player' : 'did not open'));
  return list;
}
for (const run of runs) run.failures = failures(run);
for (const item of coveredTaps) runs.filter(run => run.build === item.build && run.size === item.size).at(-1)?.failures.push('tap target covered: ' + item.selector);
for (const check of touchChecks) if (!check.volumeDrag.ok) runs.find(run => run.build === check.build && run.size === check.size && run.state === 'quality').failures.push(`volume drag 14 px off the track centre gave ${check.volumeDrag.value} (expected about 30)`);
const summary = Object.fromEntries(buildNames.map(build => {
  const own = runs.filter(run => run.build === build);
  // A finding the "before" build shows in the same state is older than 0.6 (reported, not caused by this change).
  const older = run => runs.find(item => item.build === 'before' && item.size === run.size && item.state === run.state)?.failures || [];
  const kind = text => text.replace(/\s*[[{].*$/, '').replace(/\d+(\.\d+)?/g, 'N');
  const failing = own.filter(run => run.failures.length).map(run => ({ size: run.size, state: run.state, failures: run.failures,
    // Same finding (selector and kind; the coordinates may differ) in the same state of the before build.
    ...(build === 'after' ? { preexisting: run.failures.filter(item => older(run).map(kind).includes(kind(item))) } : {}) }));
  return [build, { states: own.length, passed: own.length - failing.length, failing,
    ...(build === 'after' ? { newFindings: failing.reduce((sum, item) => sum + item.failures.length - item.preexisting.length, 0) } : {}) }];
}));
const result = {
  generated: new Date().toISOString(), tool: 'tools/capture-mobile.mjs', browser: browserInfo.Browser, userAgent: browserInfo['User-Agent'],
  scope: 'Chromium device emulation (viewport, DPR, touch, pointer: coarse, safe-area insets). Layout test only: real iPhone Safari (WebKit) and Android Chrome, decoding, audio policy, on-screen keyboard and address-bar resizing are not tested; dvh equals svh here.',
  builds: { after: option('page') ? repoPath(pathToFileURL(resolve(option('page')))) : 'current sources built without the 0.6.1 stylesheet (work/build-console.mjs --without-0.6.1)', before: 'current build with work/mobile-ui.css removed and the recorded template edits reverted',
    beforeEqualsGitHead: headHtml === null ? null : headHtml === builds.before, afterEqualsGitHead: headHtml === null ? null : headHtml === builds.after,
    // Scripts may differ from HEAD while other work goes on; the static page (markup, styles, SVG) is what 0.6 changes.
    beforeMarkupEqualsGitHead: headHtml === null ? null : withoutScripts(headHtml) === withoutScripts(builds.before) },
  // verify-ui-v06.mjs --evidence compares these hashes with the current files (stale evidence check).
  page: { markupSha256: sha256(withoutScripts(builds.after)), mobileCssSha256: sha256(mobileCss) },
  run: { full: fullRun, out: repoPath(out), sizes: sizes.map(size => size.name), builds: buildNames, shots, live, ports },
  sizes, fixtures: 'test-only data served by this script: /api/broadcasts (5 items), /__test/thumb-N.svg, chat messages, a canvas.captureStream() video (1280x720 and 720x1280); picture-in-picture enabled in the static states (widest control bar)',
  summary, desktopCompare: compare, compareFailures: compare.filter(item => item.mustBeUnchanged && !item.unchangedOutsideBadge).map(item => item.size + ' ' + item.state), touchChecks, coveredTaps,
  live: live ? { scope: 'Loopback WebRTC: MediaMTX 1.21.3 WHEP (proxied by this script), FFmpeg testsrc2 1280x720 30 fps H.264 High, no B-frames, 1 s GOP, no audio; emulated sizes as above. The product player code (console-ux.js) creates the video and handles auto-hide and taps. Not a real phone, browser engine or network.', runs: liveRuns } : null,
  runs
};
await writeFile(new URL('results.json', out), JSON.stringify(result, null, 2));
for (const [build, item] of Object.entries(summary)) console.log(`${build}: ${item.passed}/${item.states} states without findings` + (item.newFindings !== undefined ? `, ${item.newFindings} findings not present before 0.6` : ''));
for (const item of compare) console.log(`compare ${item.size} ${item.state}: ${item.changedPixels} changed px, ${item.changedOutsideMask} outside the badge` + (item.mustBeUnchanged ? (item.unchangedOutsideBadge ? ' (unchanged as required)' : ' (MUST BE UNCHANGED)') : ' (narrow window, information only)'));
for (const run of runs.filter(item => item.build === 'after' && item.state === 'player')) console.log(`player frame ${run.size}: ${run.picture.frame[2]}x${run.picture.frame[3]} (${run.picture.frameRatio}:1)`);
console.log('evidence: ' + repoPath(out));

// ---- Shutdown: only the browser and server this script started ----------------------------------------------------
try { const ws = new WebSocket(browserInfo.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await sleep(800); ws.close(); } catch {}
c.close();
if (edge.exitCode === null) try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
server.close();
await sleep(500);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exitCode = (summary.after && (buildNames.includes('before') ? summary.after.newFindings : summary.after.failing.length)) || result.compareFailures.length || liveRuns.some(run => !run.ok) ? 1 : 0;
