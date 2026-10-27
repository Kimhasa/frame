// Puts a FRAME Console page (the approved prototype or the running app) into the states shown in reference/screenshots.
// Every step goes through the visible controls (clicks, the custom select menus, keyboard focus).
import { sleep } from './cdp.mjs';

const pick = async (c, control, label) => {
  await c.click(`#${control}-trigger`);
  await sleep(150);
  await c.evaluate(`[...document.querySelectorAll('#select-popup .select-option')].find(o => o.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
  await sleep(150);
};

// Sender as in frame-sender.png: a source selected, 144 fps, system + mic, caret at the end of the server address.
export async function senderState(c, chooseSource) {
  await chooseSource();
  await pick(c, 'fps', '144 fps');
  await pick(c, 'audio-source', '시스템 + 마이크');
  const { x, y } = await c.evaluate(`(() => { const r = document.getElementById('server-host').getBoundingClientRect(); return { x: r.right - 12, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await c.evaluate(`(() => { const i = document.getElementById('server-host'); i.setSelectionRange(i.value.length, i.value.length); })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 1090 });
  await sleep(300);
}

// frame-fps-focus.png: same settings, keyboard focus on the frame-rate menu button.
export async function fpsFocusState(c) {
  await c.evaluate(`document.getElementById('resolution-trigger').focus()`);
  await c.key('Tab');
  await sleep(200);
}

// Viewer as in frame-viewer.png: connected, 720p chosen in the quality menu, menu open again, pointer over the button.
export async function viewerState(c, connectViewer) {
  await connectViewer();
  await c.click('#player-settings'); await sleep(200);
  await c.evaluate(`[...document.querySelectorAll('#player-quality-options button')].find(b => b.textContent.trim() === '720p').click()`);
  await sleep(4000);
  await c.click('#player-settings'); await sleep(300);
}
