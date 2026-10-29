// Starts a broadcast of the motion-test window in FrameConsole.exe (DevTools 9222) through its own UI, when none runs,
// and prints the viewer address. usage: node tools/app-start.mjs [window title]
import { app, selectWindow, sleep } from './app-flow.mjs';

const a = await app();
if (!(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`))) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, process.argv[2] || 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 80 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
  await sleep(1500);
}
console.log(await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`));
a.close();
