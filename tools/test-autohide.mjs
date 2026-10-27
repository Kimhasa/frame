// Player controls auto-hide on a viewer page in a new Edge window (DevTools 9334), with real mouse, keyboard and touch
// input from DevTools: default hidden while playing, shown on movement, idle hide, leaving the area, hover, slider drag,
// quality menu, keyboard focus, touch reveal without toggling playback, click on the picture, no layout shift, chat typing,
// wide view and full screen; also checks that the player box has the picture's aspect ratio.
// usage: node tools/test-autohide.mjs <viewer url>
import { connect, sleep } from './cdp.mjs';

const url = process.argv[2] || 'http://192.168.1.27:8889/screen-01';
const browser = new WebSocket((await (await fetch('http://127.0.0.1:9334/json/version')).json()).webSocketDebuggerUrl);
await new Promise(r => browser.onopen = r);
const id = await new Promise(resolve => { browser.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m.result.targetId); }; browser.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, newWindow: true } })); });
browser.close();
await sleep(3000);
const c = await connect(9334, t => t.id === id);
await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(500);
await c.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
for (let i = 0; i < 40 && !(await c.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.currentTime > 0.5)`)); i++) await sleep(250);
const out = (name, data) => console.log(name.padEnd(22), JSON.stringify(data));
const st = () => c.evaluate(`(() => { const p = document.getElementById('viewer-preview'), k = document.getElementById('player-controls'), cs = getComputedStyle(k), v = window.FrameRuntime.video, r = p.getBoundingClientRect(), vr = v ? v.getBoundingClientRect() : null;
  return { hidden: p.classList.contains('controls-idle'), opacity: +(+cs.opacity).toFixed(2), events: cs.pointerEvents, paused: v ? v.paused : null, wide: document.getElementById('viewer-view').classList.contains('is-wide'),
    box: [Math.round(r.width), Math.round(r.height)], videoBox: vr ? [Math.round(vr.width), Math.round(vr.height)] : null, video: v ? [v.videoWidth, v.videoHeight] : null, fullscreen: !!document.fullscreenElement }; })()`);
const center = sel => c.center(sel);
const move = async (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const p = await center('#viewer-preview');
await move(p.x, p.y);
out('after move', await st());
await sleep(3200);
const idle = await st();
out('idle 3.2 s', idle);
out('aspect', { boxRatio: +(idle.box[0] / idle.box[1]).toFixed(3), videoRatio: idle.video ? +(idle.video[0] / idle.video[1]).toFixed(3) : null });
await move(p.x, p.y + 5);
const shown = await st();
out('move shows', shown);
out('no layout shift', { same: JSON.stringify(shown.box) === JSON.stringify(idle.box) && JSON.stringify(shown.videoBox) === JSON.stringify(idle.videoBox) });
await move(5, 500);  // leave the player (sidebar)
await sleep(400);
out('left area', await st());
const vol = await center('#player-volume');
await move(vol.x, vol.y); await sleep(3500);
out('hover controls 3.5 s', await st());
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vol.x, y: vol.y, button: 'left', clickCount: 1 });
await move(vol.x - 10, vol.y); await sleep(3500);
out('dragging 3.5 s', await st());
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vol.x - 10, y: vol.y, button: 'left', clickCount: 1 });
await move(p.x, p.y); await sleep(3200);
out('after drag idle', await st());
await move(p.x, p.y + 3);
await c.click('#player-settings'); await move(p.x, p.y - 100); await sleep(3500);
out('menu open 3.5 s', { ...(await st()), menu: !(await c.evaluate(`document.getElementById('player-quality-menu').hidden`)) });
await c.key('Escape'); await sleep(3200);
out('menu closed idle', await st());
// Keyboard: focus the player, then Tab into the controls.
await move(5, 500); await sleep(300);
await c.evaluate(`document.getElementById('viewer-preview').focus()`);
await c.key('Tab'); await sleep(3500);
out('tab focus 3.5 s', { ...(await st()), focused: await c.evaluate(`document.activeElement.id || document.activeElement.className`) });
await c.evaluate(`document.getElementById('chat-message').focus()`); await sleep(400);
out('focus left player', await st());
// Typing in chat: Space and K must not pause.
await c.key(' ', 'Space', ' '); await c.key('k', 'KeyK', 'k'); await sleep(300);
out('chat typing', { paused: (await st()).paused, draft: await c.evaluate(`document.getElementById('chat-message').value`) });
await c.evaluate(`(() => { const t = document.getElementById('chat-message'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);
// Touch: a tap on hidden controls only reveals them; the next tap pauses; another resumes.
await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await sleep(3200);
const tap = async (x, y) => { await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(500); };
const settings = await center('#viewer-wide');
out('before tap', await st());
await tap(settings.x, settings.y);  // where the hidden "확대 보기" button is
out('tap reveals', await st());
await tap(p.x, p.y);
out('tap pauses', await st());
await tap(p.x, p.y);
out('tap resumes', await st());
await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
// Mouse click on the picture toggles playback; a click on a control does not.
await move(p.x, p.y); await c.click('#viewer-preview video'); await sleep(400);
out('click picture', await st());
await c.click('#player-mute'); await sleep(300);
out('click mute button', await st());
await c.click('#player-mute'); await c.click('#viewer-preview video'); await sleep(300);
// Wide view and full screen use the same policy.
await c.click('#viewer-wide'); await move(p.x, p.y); await sleep(3200);
const wideIdle = await st();
out('wide idle', { ...wideIdle, boxRatio: +(wideIdle.box[0] / wideIdle.box[1]).toFixed(3) });
await move(p.x, p.y + 4); await c.click('#viewer-wide'); await sleep(300);
await move(p.x, p.y + 6); await c.click('#viewer-fullscreen'); await sleep(800); await move(400, 400); await sleep(3200);
out('fullscreen idle', await st());
await move(420, 420);
out('fullscreen move', await st());
await c.evaluate(`document.exitFullscreen()`); await sleep(500);
c.close();
await fetch(`http://127.0.0.1:9334/json/close/${id}`, { method: 'PUT' });
