// Picture-in-picture in a viewer page (default: the app's own WebView2 receiver, DevTools 9222) with real mouse clicks:
// PiP opens on the live video, and every switch (to recorded history, back to live, another quality, disconnect)
// closes the previous PiP window and leaves exactly one media element.
// usage: node tools/test-pip.mjs [port=9222] [page target id]   (a browser page must already show the viewer, connected)
import { connect, sleep } from './cdp.mjs';

const port = Number(process.argv[2] || 9222), targetId = process.argv[3];
const c = await connect(port, t => targetId ? t.id === targetId : port === 9222 ? t.url.includes('frame-console.example') : /:\d+\/[A-Za-z0-9_-]+/.test(t.url));
const out = (name, data) => console.log(name.padEnd(14), JSON.stringify(data));
const state = () => c.evaluate(`(() => { const v = window.FrameRuntime.video;
  return { enabled: document.pictureInPictureEnabled, pipButton: !document.getElementById('player-pip').disabled, pip: !!document.pictureInPictureElement,
    pipIsCurrent: !!v && document.pictureInPictureElement === v, src: v ? (v.srcObject ? 'webrtc' : 'mse') : null, mode: window.FrameRuntime.playback.mode,
    videos: document.querySelectorAll('video').length, connected: window.FrameRuntime.connected }; })()`);
const until = async test => { for (let i = 0; i < 60; i++) { const s = await state(); if (test(s)) return s; await sleep(250); } return state(); };
if (port === 9222) {
  await c.evaluate(`document.getElementById('tab-sender').click()`); await sleep(300);
  await c.evaluate(`document.getElementById('open-viewer').click()`);
}
await until(s => s.connected && s.src === 'webrtc');
await sleep(2500);
out('live', await state());
await c.click('#player-pip');
out('pip on live', await until(s => s.pip));
// To recorded history: the live element is replaced, its PiP window must close.
const first = await c.evaluate(`window.FrameRuntime.playback.ranges?.[0]?.startMs ?? null`);
await c.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${first} + 5000; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
out('to history', await until(s => s.mode === 'history'));
await sleep(1000);
await c.click('#player-pip');
out('pip on history', await until(s => s.pip));
await c.click('#player-live');
out('back to live', await until(s => s.src === 'webrtc'));
await sleep(1000);
await c.click('#player-pip');
out('pip on live', await until(s => s.pip));
await c.click('#player-settings'); await sleep(300);
const quality = await c.evaluate(`(() => { const b = [...document.querySelectorAll('#player-quality-options button')].find(x => x.innerText.startsWith('720p')); if (b) b.click(); return !!b; })()`);
await sleep(5000);
out('quality 720p', { clicked: quality, label: await c.evaluate(`document.getElementById('player-quality-label').textContent`), ...(await state()) });
await c.click('#player-pip');
await until(s => s.pip);
await c.evaluate(`window.FrameRuntime.disconnect()`);
out('disconnected', await until(s => !s.connected));
if (port === 9222) { await c.evaluate(`document.getElementById('tab-sender').click()`); }
c.close();
