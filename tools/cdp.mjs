// Minimal Chrome DevTools Protocol client (Node 22+ WebSocket) used only for verification of the running app.
export async function connect(port = 9222, match = () => true) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(t => t.type === 'page' && match(t));
  if (!target) throw new Error('no page target on port ' + port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method) listeners.forEach(fn => fn(msg));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const center = async selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async selector => {
    const { x, y } = await center(selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const key = async (key, code = key, text) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27, ' ': 32, ArrowDown: 40, ArrowUp: 38, End: 35, Home: 36 }[key] || key.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  const screenshot = async (clip) => {
    const metrics = await evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
    const area = clip || { x: 0, y: 0, width: metrics.w, height: metrics.h };
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, clip: { ...area, scale: 1 / metrics.dpr } });
    return Buffer.from(r.data, 'base64');
  };
  return { ws, send, evaluate, click, key, screenshot, center, on: fn => listeners.push(fn), close: () => ws.close() };
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
