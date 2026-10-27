// Verification driver for the running FrameConsole.exe (DevTools port 9222): small reusable steps.
import { connect, sleep } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';

export const app = () => connect(9222, t => t.url.includes('frame-console.example'));

export async function selectWindow(c, title) {
  if (!(await c.evaluate('document.getElementById("source-dialog").open')))
    await c.evaluate('(document.getElementById("source-row").hidden ? document.getElementById("source-empty-button") : document.getElementById("source-button")).click()');
  const find = `[...document.querySelectorAll("[data-source]")].find(b => b.title.startsWith(${JSON.stringify(title)}))`;
  for (let i = 0; i < 50 && !(await c.evaluate(`!!${find}`)); i++) await sleep(100);
  await c.evaluate(`${find}.click()`);
  await c.evaluate('document.getElementById("confirm-source").click()');
  for (let i = 0; i < 50 && (await c.evaluate('document.getElementById("source-row").hidden')); i++) await sleep(100);
}

export const snapshot = c => c.evaluate(`({
  status: document.getElementById("start-button").innerText.trim(), source: document.getElementById("source-name").textContent,
  start: document.getElementById("start-button").innerText, startDisabled: document.getElementById("start-button").disabled,
  duration: document.getElementById("metric-duration").textContent, fps: document.getElementById("metric-fps").textContent,
  bitrate: document.getElementById("metric-bitrate").textContent, viewers: document.getElementById("metric-viewers").textContent,
  toast: document.getElementById("toast").classList.contains("visible") ? document.getElementById("toast").textContent : "",
  logs: [...document.querySelectorAll("#log-list tr")].map(r => [...r.cells].map(td => td.textContent).join(" | ")) })`);

export async function shot(c, name, clip) { await writeFile(new URL('../verification/app/' + name + '.png', import.meta.url), await c.screenshot(clip)); }
export { sleep };
