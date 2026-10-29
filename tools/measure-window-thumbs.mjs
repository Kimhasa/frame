// Window-picker thumbnails on the running app (DevTools 9222, not broadcasting): opens 송출 대상 선택 → 프로그램 창, records
// per window when the native side sent a thumbnail or a state, when the card really showed an image (decoded), and the
// final state; then closes the dialog. Works for the old build (image or icon only) and the new one (data-thumb-state).
// Privacy: the user's own windows are written as exe name and number only; titles are kept only for FRAME test windows.
// usage: node tools/measure-window-thumbs.mjs --label before|after --scenario desktop [--wait 8000] [--repeat 1]
import { app, sleep } from './app-flow.mjs';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const label = arg('label', 'run'), scenario = arg('scenario', 'desktop'), wait = Number(arg('wait', 8000)), repeat = Number(arg('repeat', 1));
const a = await app();
if (await a.evaluate('window.FrameRuntime.running')) throw new Error('the app is broadcasting; the picker is locked while it runs');
// Bridge hook (once per page load): every windows / thumb / thumbState event without its image data.
await a.evaluate(`(() => {
  if (window.__thumbProbe) return;
  const probe = window.__thumbProbe = { t0: 0, events: [], shown: {} };
  window.chrome.webview.addEventListener('message', ({ data }) => {
    if (!data || !['windows', 'thumb', 'thumbState'].includes(data.type)) return;
    const { jpeg, items, ...rest } = data;
    probe.events.push({ t: performance.now() - probe.t0, ...rest, jpegBytes: jpeg ? jpeg.length : undefined, items: items ? items.map(({ title, ...item }) => ({ ...item, testTitle: /^FRAME /.test(title || '') ? title : undefined })) : undefined });
  });
  new MutationObserver(records => { for (const r of records) for (const node of r.addedNodes) {
    const image = node.nodeName === 'IMG' ? node : node.querySelector?.('img'); if (!image) continue;
    const card = image.closest('[data-source]'); if (!card) continue;
    const id = card.dataset.source, at = performance.now() - probe.t0;
    image.decode().then(() => { (probe.shown[id] ||= []).push({ t: at, decodedAt: performance.now() - probe.t0, w: image.naturalWidth, h: image.naturalHeight, fresh: card.dataset.thumbFresh }); }, () => { (probe.shown[id] ||= []).push({ t: at, error: 'decode' }); });
  } }).observe(document.querySelector('.source-options'), { childList: true, subtree: true });
})()`);
const env = await a.evaluate(`({ dpr: devicePixelRatio, ua: navigator.userAgent.match(/Edg\\/[\\d.]+/)?.[0], viewport: innerWidth + 'x' + innerHeight })`);
const logDir = new URL('../dist/FrameConsole/data/logs/', import.meta.url);
const logName = (await readdir(logDir).catch(() => [])).filter(name => /^frame-console-.*.log$/.test(name)).sort().at(-1);
const log = logName ? await readFile(new URL(logName, logDir), 'utf8').catch(() => '') : '';
env.webview2 = log.match(/[webview2] runtime (.*)/g)?.at(-1)?.replace(/.*runtime /, '') || null;
env.gpu = log.match(/\[gpu\] adapter: (.*)/g)?.at(-1)?.replace(/.*adapter: /, '') || null;
const runs = [];
for (let run = 0; run < repeat; run++) {
  await a.evaluate(`(() => { const p = window.__thumbProbe; p.events = []; p.shown = {}; p.t0 = performance.now();
    (document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click(); })()`);
  await sleep(wait);
  const page = await a.evaluate(`(() => { const p = window.__thumbProbe; return { events: p.events, shown: p.shown,
    cards: [...document.querySelectorAll('.source-options [data-source]')].map(c => { const r = c.getBoundingClientRect(), t = c.querySelector('.source-thumb').getBoundingClientRect();
      return { id: c.dataset.source, state: c.dataset.thumbState || (c.querySelector('img') ? 'image' : 'icon'), fresh: c.dataset.thumbFresh, chip: c.closest('.source-item')?.querySelector('.source-state')?.textContent || '', retry: !!c.closest('.source-item')?.querySelector('.source-retry:not([hidden])'), disabled: c.disabled, h: Math.round(r.height * 10) / 10, thumbH: Math.round(t.height * 10) / 10, describe: c.title.split(String.fromCharCode(10))[1] || '' }; }) }; })()`);
  await a.evaluate(`document.querySelector('#source-dialog [data-close="source-dialog"].icon-button, #source-dialog .dialog-footer [data-close]')?.click()`);
  const list = page.events.find(e => e.type === 'windows');
  const counts = {};
  const items = (list?.items || []).map(item => {
    const n = counts[item.exe] = (counts[item.exe] || 0) + 1;
    const mine = page.events.filter(e => e.id === item.id), card = page.cards.find(c => c.id === item.id) || {};
    // A cached image (old build: none) is shown first but is not a capture of this opening: the new capture is counted apart.
    const thumb = mine.find(e => e.type === 'thumb' && e.jpegBytes), capture = mine.find(e => e.type === 'thumb' && e.jpegBytes && e.source !== 'cache');
    const shown = (page.shown[item.id] || []).filter(s => !s.error);
    return { key: item.exe + '#' + n, exe: item.exe, testTitle: item.testTitle, minimized: item.minimized, size: item.width + 'x' + item.height,
      firstImageMs: thumb ? Math.round(thumb.t) : null, firstImageSource: thumb ? thumb.source || 'capture' : null,
      captureMs: capture ? Math.round(capture.t) : null, captureSource: capture ? capture.source || 'capture' : null, captureCurrent: capture ? capture.fresh !== false : null,
      attempts: capture?.attempt ?? mine.filter(e => e.type === 'thumbState').at(-1)?.attempt ?? null, black: capture?.black,
      firstShownMs: shown.length ? Math.round(shown[0].decodedAt) : null,
      states: mine.filter(e => e.type === 'thumbState' || e.type === 'thumb').map(e => (e.state || (e.source === 'cache' ? 'cached-image' : 'image')) + (e.attempt ? '#' + e.attempt : '') + '@' + Math.round(e.t)),
      final: card.state, chip: card.chip, retry: card.retry, disabled: card.disabled, detail: card.describe || undefined, cardH: card.h, thumbH: card.thumbH };
  });
  runs.push({ run, listMs: list ? Math.round(list.t) : null, total: items.length, withImage: items.filter(i => i.firstShownMs !== null).length, withCapture: items.filter(i => i.captureMs !== null).length, items });
  console.log(JSON.stringify({ run, listMs: runs.at(-1).listMs, total: items.length, withImage: runs.at(-1).withImage, withCapture: runs.at(-1).withCapture }));
  for (const i of items) console.log(' ', i.key.padEnd(18), (i.testTitle || '').padEnd(22), i.minimized ? 'min' : '   ', String(i.captureMs ?? '-').padStart(6), (i.captureSource || '').padEnd(9), (i.final || '').padEnd(10), (i.chip || '').padEnd(12), i.states.join(' '));
  if (run + 1 < repeat) await sleep(1500);
}
a.close();
await mkdir(new URL('../verification/window-preview/', import.meta.url), { recursive: true });
const file = new URL(`../verification/window-preview/${label}-${scenario}.json`, import.meta.url);
await writeFile(file, JSON.stringify({ label, scenario, measuredAt: new Date().toISOString(), waitMs: wait, env, runs }, null, 1));
console.log('wrote', file.pathname);
