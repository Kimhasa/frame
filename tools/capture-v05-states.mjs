// Captures the running FrameConsole.exe (DevTools 9222, client 1440x1000 CSS px) in the states of reference-v05/screenshots.
// Needs a running broadcast (for the list card, player and sender chat). The monitor dialog is captured last, after the
// broadcast is stopped (the source cannot change while live); its desktop thumbnails are hidden for privacy.
// Output: verification/app/v05-cmp-<state>.png (1440x1000).
import { mkdir, writeFile } from 'node:fs/promises';
import { sleep } from './cdp.mjs';
import { app } from './app-flow.mjs';

const root = new URL('../', import.meta.url);
await mkdir(new URL('verification/app/', root), { recursive: true });
const c = await app();
const js = code => c.evaluate(code);
const save = async name => {
  const m = await js('({ dpr: devicePixelRatio })');
  await js('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  await sleep(250);
  const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 1000, scale: 1 / m.dpr } });
  await writeFile(new URL(`verification/app/v05-cmp-${name}.png`, root), Buffer.from(r.data, 'base64'));
  console.log('saved', name);
};
const closeDialogs = () => js(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`);
const playing = async () => { for (let i = 0; i < 40; i++) { await sleep(500); if (await js(`(() => { const v = document.querySelector('#viewer-preview video'); return !!(v && v.videoWidth && v.currentTime > 0.3); })()`)) return true; } return false; };

// List of live broadcasts.
await closeDialogs();
await js(`window.FrameRuntime.connected && window.FrameRuntime.disconnect()`);
await js(`document.getElementById('tab-viewer').click()`);
await js(`window.FrameUI.showStage(false); window.FrameUI.refreshCatalog()`);
await sleep(2000);
await save('catalog');
await js(`document.getElementById('manual-connect').click()`); await sleep(400);
await save('manual');
await closeDialogs(); await sleep(300);

// Player (chat closed), then with chat, name dialog and info dialog.
await js(`document.querySelector('.broadcast-card').click()`);
console.log('playing', await playing());
await sleep(2500);  // timeline appears after the first DVR index
await js(`document.getElementById('chat-panel').hidden || document.getElementById('chat-close').click()`); await sleep(300);
await save('player');
await js(`document.getElementById('chat-toggle').click()`); await sleep(400);
await save('viewer-chat');
await js(`document.getElementById('chat-name-button').click()`); await sleep(400);
await save('chat-name');
await closeDialogs(); await sleep(300);
await js(`document.getElementById('viewer-info-button').click()`); await sleep(400);
await save('viewer-info');
await closeDialogs(); await sleep(300);

// Sender with its chat, and the broadcast settings dialog.
await js(`document.getElementById('tab-sender').click()`); await sleep(800);
await save('sender-chat');
await js(`document.getElementById('sender-settings-button').click()`); await sleep(400);
await save('sender-settings');
await closeDialogs(); await sleep(300);

// Monitor tab of the source dialog (needs the broadcast stopped).
if ((await js(`document.getElementById('start-button').innerText`)).includes('종료')) {
  await js(`document.getElementById('start-button').click()`); await sleep(400);
  await js(`document.getElementById('confirm-stop').click()`); await sleep(3500);
}
await js(`(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()`); await sleep(600);
await js(`document.getElementById('source-tab-monitor').click()`);
for (let i = 0; i < 40 && !(await js(`document.querySelectorAll('.monitor-choice').length`)); i++) await sleep(250);
await js(`(() => { const s = document.createElement('style'); s.id = 'privacy-mask'; s.textContent = '.monitor-thumb img{visibility:hidden}'; document.head.append(s); })()`);
await save('monitors');
await js(`document.getElementById('privacy-mask')?.remove()`);
await closeDialogs();

// Broadcast settings before going live, with system audio + microphone picked in the dialog (the reference state);
// the previous choice is restored afterwards.
const pick = async label => {
  await js(`document.getElementById('audio-source-trigger').click()`); await sleep(200);
  await js(`[...document.querySelectorAll('#select-popup [role=option]')].find(o => o.innerText.trim().startsWith(${JSON.stringify(label)})).click()`); await sleep(300);
};
const previous = { none: '사용 안 함', system: '시스템 오디오', mic: '마이크', mix: '시스템 + 마이크' }[await js(`document.getElementById('audio-source').value`)];
await js(`document.getElementById('sender-settings-button').click()`); await sleep(400);
await pick('시스템 + 마이크');
await save('sender-settings-idle');
await pick(previous);
await closeDialogs();
c.close();
