// Manual connection on a viewer page in a new Edge window (DevTools 9334): wrong port, unreachable host, unknown stream,
// invalid input, cancel while connecting, success, and that the dialog reopens with the last manual connection that
// worked (not a failed edit, not a list card's target).   usage: node tools/test-manual.mjs <page url>
import { connect, sleep } from './cdp.mjs';

const url = process.argv[2] || 'http://192.168.1.27:8889/';
const browser = new WebSocket((await (await fetch('http://127.0.0.1:9334/json/version')).json()).webSocketDebuggerUrl);
await new Promise(r => browser.onopen = r);
const id = await new Promise(resolve => { browser.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m.result.targetId); }; browser.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, newWindow: true } })); });
browser.close();
await sleep(3000);
const c = await connect(9334, t => t.id === id);
await c.evaluate(`localStorage.removeItem('frame.manualTarget')`);
await c.send('Page.reload'); await sleep(3000);
const out = (name, data) => console.log(name.padEnd(18), JSON.stringify(data));
const fields = () => c.evaluate(`({ host: document.getElementById('viewer-host').value, port: document.getElementById('viewer-receive-port').value, path: document.getElementById('viewer-stream').value })`);
const dialog = () => c.evaluate(`({ open: document.getElementById('viewer-connect-dialog').open, error: document.getElementById('viewer-connect-error').hidden ? '' : document.getElementById('viewer-connect-error').textContent,
  fieldErrors: ['viewer-host-error', 'viewer-stream-error', 'viewer-receive-port-error'].map(i => document.getElementById(i).hidden ? '' : document.getElementById(i).textContent).filter(Boolean),
  connected: window.FrameRuntime.connected, connecting: window.FrameRuntime.connecting })`);
const open = async () => { await c.evaluate(`document.getElementById('manual-connect').click()`); await sleep(300); };
const attempt = async (label, host, port, path, wait = 7000) => {
  await c.evaluate(`(() => { const set = (i, v) => { const e = document.getElementById(i); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set('viewer-host', ${JSON.stringify(host)}); set('viewer-receive-port', ${JSON.stringify(String(port))}); set('viewer-stream', ${JSON.stringify(path)}); document.getElementById('viewer-form').requestSubmit(); })()`);
  const t0 = Date.now();
  for (let i = 0; i < wait / 250; i++) { await sleep(250); const d = await dialog(); if (!d.connecting && (d.error || d.fieldErrors.length || d.connected)) break; }
  out(label, { ms: Date.now() - t0, ...(await dialog()) });
};
await open();
out('defaults', await fields());
await attempt('wrong port', '192.168.1.27', 8890, 'screen-01');
await attempt('unknown stream', '192.168.1.27', 8889, 'no-such-stream');
await attempt('unreachable', '192.168.1.250', 8889, 'screen-01', 9000);
await attempt('invalid host', 'bad host!', 8889, 'screen-01', 1500);
await attempt('invalid port', '192.168.1.27', 70000, 'screen-01', 1500);
// Cancel: close the dialog while connecting to an unreachable host; nothing connects afterwards.
await c.evaluate(`(() => { const set = (i, v) => { const e = document.getElementById(i); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set('viewer-host', '192.168.1.251'); set('viewer-receive-port', '8889'); set('viewer-stream', 'screen-01'); document.getElementById('viewer-form').requestSubmit(); })()`);
await sleep(500);
await c.evaluate(`document.getElementById('viewer-connect-dialog').close()`);
await sleep(6000);
out('cancelled', await dialog());
await open();
out('reopen after fail', await fields());
await attempt('manual ok', '127.0.0.1', 8889, 'screen-01', 15000);
await c.evaluate(`window.FrameRuntime.disconnect()`); await sleep(1000);
await c.evaluate(`window.FrameUI.showStage(false); window.FrameUI.refreshCatalog()`); await sleep(2000);
await c.evaluate(`document.querySelector('.broadcast-card').click()`);
for (let i = 0; i < 40 && !(await c.evaluate(`window.FrameRuntime.connected`)); i++) await sleep(250);
out('card connected', { base: await c.evaluate(`window.FrameRuntime.stream.base`), fieldsUntouched: await fields() });
await c.evaluate(`window.FrameRuntime.disconnect()`); await sleep(500);
await c.evaluate(`window.FrameUI.showStage(false)`); await open();
out('reopen after card', await fields());
await c.evaluate(`document.getElementById('viewer-connect-dialog').close()`);
c.close();
await fetch(`http://127.0.0.1:9334/json/close/${id}`, { method: 'PUT' });
