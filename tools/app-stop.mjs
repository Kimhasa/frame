// Stops the running broadcast in FrameConsole.exe (DevTools 9222) through its own UI and prints the newest events.
import { app, sleep } from './app-flow.mjs';

const a = await app();
if ((await a.evaluate(`document.getElementById('start-button').innerText`)).includes('종료')) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await a.evaluate(`document.getElementById('start-button').click()`); await sleep(400);
  await a.evaluate(`document.getElementById('confirm-stop').click()`); await sleep(3500);
}
console.log((await a.evaluate(`[...document.querySelectorAll('#log-list tr')].slice(0, 5).map(r => r.innerText.split('\\t').join(' | '))`)).join('\n'));
a.close();
