// Window-picker states on the running app (DevTools 9222, not broadcasting), with FRAME test windows only:
//   FRAME 미리보기 시험 A (Edge), FRAME 미리보기 시험 GDI, FRAME 캡처 제외 시험, FRAME 빈 창 시험 (scratch probe windows).
// Phases (--phase): live (default) = minimize / restore / close while the list is open, layout, retry-free states, quick
//   close-and-reopen, selection; fault = the app was started with FRAME_CONSOLE_THUMB_FAULT for the GDI window
//   (drop / delay / corrupt): retry states, manual retry, keyboard, cancel during retries.
// Window moves go through tools/window-control.ps1 (run this from a shell where PowerShell scripts may run).
// usage: node tools/test-window-preview.mjs [--phase live|fault] [--fault drop|delay|corrupt]
import { app, sleep } from './app-flow.mjs';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const phase = arg('phase', 'live'), fault = arg('fault', 'drop');
const A = 'FRAME 미리보기 시험 A', GDI = 'FRAME 미리보기 시험 GDI', EXCLUDED = 'FRAME 캡처 제외 시험', EMPTY = 'FRAME 빈 창 시험';
const control = (title, action, extra = []) => execFileSync('powershell', ['-NoProfile', '-File', fileURLToPath(new URL('window-control.ps1', import.meta.url)), '-Title', title, '-Action', action, ...extra], { encoding: 'utf8' });
const a = await app();
if (await a.evaluate('window.FrameRuntime.running')) throw new Error('the app is broadcasting');
const checks = [];
const check = (name, ok, data) => { checks.push({ name, ok: !!ok, data }); console.log((ok ? 'PASS ' : 'FAIL ') + name, data === undefined ? '' : JSON.stringify(data)); };
const open = () => a.evaluate(`(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()`);
const close = () => a.evaluate(`document.querySelector('#source-dialog .dialog-footer [data-close]').click()`);
// Card state by title prefix (cards carry the window title in their tooltip).
const card = title => a.evaluate(`(() => { const b = [...document.querySelectorAll('.source-options [data-source]')].find(x => x.title.startsWith(${JSON.stringify(title)}));
  if (!b) return null; const item = b.closest('.source-item'), chip = item.querySelector('.source-state'), retry = item.querySelector('.source-retry'), img = b.querySelector('img');
  const r = b.getBoundingClientRect(), t = b.querySelector('.source-thumb').getBoundingClientRect(), o = item.querySelector('.source-overlay').getBoundingClientRect();
  return { id: b.dataset.source, state: b.dataset.thumbState, fresh: b.dataset.thumbFresh, chip: chip.hidden ? '' : chip.textContent, retry: !retry.hidden, retryDisabled: retry.disabled,
    disabled: b.disabled, pressed: b.getAttribute('aria-pressed'), describedBy: b.getAttribute('aria-describedby') === chip.id, detail: b.title.split(String.fromCharCode(10))[1] || '',
    image: img ? img.src.length + ':' + img.src.slice(-24) : null, h: +r.height.toFixed(1), thumbH: +t.height.toFixed(1), overlayH: +o.height.toFixed(1), overlayTop: +(o.top - t.top).toFixed(1) }; })()`);
const waitFor = async (title, predicate, ms = 6000) => { const until = Date.now() + ms; let c; while (Date.now() < until) { c = await card(title); if (c && predicate(c)) return { ...c, waitedMs: ms - (until - Date.now()) }; await sleep(100); } return { ...c, timeout: true }; };
const logLines = async () => { const dir = new URL('../dist/FrameConsole/data/logs/', import.meta.url); const name = (await readdir(dir)).filter(n => /^frame-console-.*\.log$/.test(n)).sort().at(-1); return (await readFile(new URL(name, dir), 'utf8')).split('\n').filter(l => l.includes('[thumb]')); };

if (phase === 'live') {
  control(A, 'shownoactivate'); await sleep(800);
  open(); await sleep(1500);
  // States that need no waiting: shown, excluded by the app, empty (transparent) content.
  const shown = await waitFor(A, c => c.state === 'ready');
  check('shown window: current image, no status text', shown.state === 'ready' && shown.image && !shown.chip && shown.fresh === 'true', shown);
  const excluded = await card(EXCLUDED);
  check('window excluded from capture by its app: own state, no retry, still selectable', excluded?.state === 'excluded' && excluded.chip === '캡처가 제외된 창' && !excluded.retry && !excluded.disabled, excluded);
  const empty = await card(EMPTY);
  check('window that draws nothing (transparent): an image like any frame, not a failure', empty?.state === 'ready' && !!empty.image, empty);
  // Layout: every card as tall as in 0.6, the overlay exactly over the thumbnail area.
  const sizes = await a.evaluate(`[...document.querySelectorAll('.source-options .source-item')].map(i => { const b = i.querySelector('.source-choice').getBoundingClientRect(), t = i.querySelector('.source-thumb').getBoundingClientRect(), o = i.querySelector('.source-overlay').getBoundingClientRect(); return [+b.height.toFixed(1), +t.height.toFixed(1), +(o.top - t.top).toFixed(1), +(o.height - t.height).toFixed(1), +(b.width - i.getBoundingClientRect().width).toFixed(1), +t.width.toFixed(1)]; })`);
  // The overlay starts at the card's 1 px border; at 175 % the border is drawn as one device pixel (0.57 px), hence < 1 px.
  check('cards keep one height; 16:9 thumbnail; overlay = thumbnail area (< 1 px); card fills its grid cell', new Set(sizes.map(s => s[0])).size === 1 && sizes.every(s => Math.abs(s[5] / s[1] - 16 / 9) < 0.01 && Math.abs(s[2]) < 1 && Math.abs(s[3]) < 1 && s[4] === 0), sizes.slice(0, 3));
  // Minimize while the list is open: the image stays, the card says so; restore: a current image replaces it.
  const before = await card(A);
  control(A, 'minimize');
  const minimized = await waitFor(A, c => c.state === 'minimized');
  check('minimized while open: keeps the image, shows 최소화된 창', minimized.state === 'minimized' && minimized.chip === '최소화된 창' && minimized.image === before.image && minimized.h === before.h, minimized);
  await sleep(1500);
  control(A, 'shownoactivate');
  const restored = await waitFor(A, c => c.state === 'ready' && c.image !== before.image);
  check('restored while open: new current image, status cleared', restored.state === 'ready' && !restored.chip && restored.fresh === 'true' && restored.image !== before.image, restored);
  // Select the GDI window, then close it: closed state, card disabled, selection and the 선택 button cleared.
  await a.evaluate(`[...document.querySelectorAll('.source-options [data-source]')].find(x => x.title.startsWith(${JSON.stringify(GDI)})).click()`);
  const selected = await card(GDI);
  control(GDI, 'close');
  const closed = await waitFor(GDI, c => c.state === 'closed');
  const confirmDisabled = await a.evaluate(`document.getElementById('confirm-source').disabled`);
  check('selected window closed: 창이 닫혔습니다, disabled, deselected', selected.pressed === 'true' && closed.chip === '창이 닫혔습니다' && closed.disabled && closed.pressed === 'false' && confirmDisabled, { closed, confirmDisabled });
  await close(); await sleep(300);
  // Quick close and reopen: the first list's work stops; only the second list's results reach the cards.
  const genBefore = (await logLines()).filter(l => / gen \d+: /.test(l)).length;
  await open(); await sleep(40); await close(); await sleep(40); await open();
  const settled = await waitFor(A, c => c.state === 'ready', 4000);
  const lines = await logLines(), opened = lines.filter(l => / gen \d+: /.test(l)).slice(genBefore);
  const gens = opened.map(l => Number(l.match(/ gen (\d+):/)[1])), lastGen = gens.at(-1);
  const ended = lines.filter(l => gens.slice(0, -1).some(g => l.includes(' gen ' + g + ' ') && / (closed|replaced by a new list) after /.test(l)));
  const page = await a.evaluate(`({ cards: document.querySelectorAll('.source-options [data-source]').length })`);
  check('close then reopen within 40 ms: earlier list ended, newest list fills the cards', gens.length >= 2 && ended.length === gens.length - 1 && settled.state === 'ready', { gens, ended: ended.map(l => l.slice(24, 110)), cards: page.cards });
  // Selecting and confirming still works and starts nothing by itself.
  await a.evaluate(`[...document.querySelectorAll('.source-options [data-source]')].find(x => x.title.startsWith(${JSON.stringify(A)})).click()`);
  await a.evaluate(`document.getElementById('confirm-source').click()`); await sleep(1500);
  const chosen = await a.evaluate(`({ source: document.getElementById('source-name').textContent, open: document.getElementById('source-dialog').open, running: window.FrameRuntime.running, start: document.getElementById('start-button').innerText.trim() })`);
  check('selection sets the source and does not start a broadcast', chosen.source.startsWith(A) && !chosen.open && !chosen.running, chosen);
} else {
  open();
  if (fault === 'drop') {
    const slow = await waitFor(GDI, c => c.state === 'retrying', 3000);
    check('no first frame: retrying shows 응답이 늦습니다 (no retry button yet)', slow.chip === '응답이 늦습니다' && !slow.retry, slow);
    const final = await waitFor(GDI, c => c.state === 'timeout', 7000);
    check('attempts used up within the 5 s deadline: timeout, retry button', final.state === 'timeout' && final.chip === '응답이 늦습니다' && final.retry && final.waitedMs < 5600, final);
    // The retry button is not part of the card: clicking it does not select, double-clicking does not confirm.
    const pressedBefore = final.pressed;
    await a.evaluate(`(() => { const b = [...document.querySelectorAll('.source-options [data-source]')].find(x => x.title.startsWith(${JSON.stringify(GDI)})); const r = b.closest('.source-item').querySelector('.source-retry'); r.click(); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
    await sleep(150);
    const retried = await card(GDI), dialogOpen = await a.evaluate(`document.getElementById('source-dialog').open`);
    check('manual retry: queued at once, retry hidden, card not selected, dialog stays open', ['queued', 'loading', 'retrying'].includes(retried.state) && !retried.retry && retried.pressed === pressedBefore && dialogOpen, retried);
    const again = await waitFor(GDI, c => c.state === 'timeout', 7000);
    check('manual retry runs a full new job and ends in timeout again', again.state === 'timeout' && again.retry, again);
    // Keyboard: Tab from the card reaches its retry button; Enter retries.
    await a.evaluate(`[...document.querySelectorAll('.source-options [data-source]')].find(x => x.title.startsWith(${JSON.stringify(GDI)})).focus()`);
    await a.key('Tab');
    const focused = await a.evaluate(`document.activeElement.className + '|' + document.activeElement.getAttribute('aria-label')`);
    await a.key('Enter', 'Enter', String.fromCharCode(13)); await sleep(150);  // with text, as a real key press
    const keyRetry = await card(GDI);
    check('keyboard: Tab from the card focuses its retry button, Enter retries', focused.startsWith('source-retry|' + GDI) && ['queued', 'loading', 'retrying'].includes(keyRetry.state), { focused, state: keyRetry.state });
    // Close while retrying: the native job stops (log), nothing more is attempted for that list.
    await sleep(1300); await close(); await sleep(1500);
    const lines = await logLines(), closedLine = lines.filter(l => / closed after /.test(l)).at(-1);
    const gen = closedLine?.match(/ gen (\d+) closed/)?.[1], closedAt = lines.indexOf(closedLine);
    const later = lines.slice(closedAt + 1).filter(l => l.includes(' gen ' + gen + ' '));
    check('dialog closed during retries: job cancelled, no later attempt for that list', /unfinished [1-9]/.test(closedLine || '') && later.length === 0, { closedLine: closedLine?.slice(24), later: later.length });
  } else if (fault === 'delay') {
    const slow = await waitFor(GDI, c => c.state === 'retrying', 3000);
    const ok = await waitFor(GDI, c => c.state === 'ready', 5000);
    check('first frame late (fault delay): 응답이 늦습니다, then a current image on the next attempt', slow.chip === '응답이 늦습니다' && ok.state === 'ready' && !ok.chip && ok.fresh === 'true', { slow: slow.chip, ready: ok });
    await close();
  } else if (fault === 'corrupt') {
    const bad = await waitFor(GDI, c => c.state === 'failed', 4000);
    check('native image the UI cannot decode: 미리보기를 가져오지 못했습니다 + retry', bad.state === 'failed' && bad.chip === '미리보기를 가져오지 못했습니다' && bad.retry && !bad.image, bad);
    await sleep(500);
    const lines = await logLines();
    check('UI decode failure reaches the native log', lines.some(l => l.includes('could not decode')), lines.filter(l => l.includes('could not decode')).slice(-1));
    await close();
  }
}
a.close();
await mkdir(new URL('../verification/window-preview/', import.meta.url), { recursive: true });
await writeFile(new URL(`../verification/window-preview/states-${phase}${phase === 'fault' ? '-' + fault : ''}.json`, import.meta.url), JSON.stringify({ phase, fault: phase === 'fault' ? fault : undefined, measuredAt: new Date().toISOString(), passed: checks.every(c => c.ok), checks }, null, 1));
console.log(checks.every(c => c.ok) ? 'ALL PASS' : 'FAILURES: ' + checks.filter(c => !c.ok).map(c => c.name).join('; '));
