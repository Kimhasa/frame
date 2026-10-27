// v0.5 receive-side checks against a running broadcast: list page, card click, playback, chat in both directions.
// usage: node tools/smoke-v05.mjs [viewerDevtoolsPort=9334] [appDevtoolsPort=9222]
import { writeFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';

const [viewerPort = '9334', appPort = '9222'] = process.argv.slice(2);
const out = (name, data) => console.log(name.padEnd(14), JSON.stringify(data));
const shot = async (c, name) => writeFile(new URL('../verification/app/' + name + '.png', import.meta.url), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

const v = await connect(Number(viewerPort), t => t.type === 'page' && /^https?:\/\/(?!127\.0\.0\.1:922)/.test(t.url) && !t.url.startsWith('edge'));
await v.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await v.send('Page.navigate', { url: new URL('/', (await v.evaluate('location.href'))).href });
await sleep(2500);
out('list', await v.evaluate(`({ count: document.getElementById('broadcast-count').textContent,
  cards: [...document.querySelectorAll('.broadcast-card')].map(c => c.innerText.split('\\n').join(' | ')), thumbnail: !!document.querySelector('.broadcast-card img') })`));
await shot(v, 'v05-lan-catalog');
await v.evaluate(`document.querySelector('.broadcast-card').click()`);
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (await v.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'); return !!(x && x.videoWidth && x.currentTime > 0.5); })()`)) break;
}
await sleep(1500);
out('playing', await v.evaluate(`({ video: (() => { const x = document.querySelector('#viewer-preview video'); return x ? x.videoWidth + 'x' + x.videoHeight : null; })(),
  title: document.getElementById('viewer-title').textContent, chatOpen: !document.getElementById('chat-panel').hidden,
  chatInputEnabled: !document.getElementById('chat-message').disabled, chatEmpty: document.getElementById('chat-empty').textContent, chatError: document.getElementById('chat-error').textContent })`));
await shot(v, 'v05-lan-player');

// Chat: viewer sets a name and sends; the sender (app) receives it and answers.
const sendFrom = async (c, name, text) => {
  await c.evaluate(`(() => { document.getElementById('chat-name-button').click(); document.getElementById('chat-display-name').value = ${JSON.stringify(name)};
    document.getElementById('chat-name-form').requestSubmit(); })()`);
  await sleep(500);
  await c.evaluate(`(() => { const t = document.getElementById('chat-message'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chat-form').requestSubmit(); })()`);
  await sleep(1200);
};
const messages = c => c.evaluate(`[...document.querySelectorAll('#chat-messages .chat-message')].map(r => r.innerText.split('\\n').join(': '))`);
await sendFrom(v, '수신자 B', '안녕하세요, 수신 PC입니다. <b>태그</b>');
const a = await connect(Number(appPort), t => t.url.includes('frame-console.example'));
await a.evaluate(`document.getElementById('tab-sender').click()`);
await sleep(800);
out('app sees', await messages(a));
await sendFrom(a, '송출자 A', '송출 PC 답장입니다.');
await sleep(800);
out('viewer sees', await messages(v));
out('viewer draft', await v.evaluate(`({ draft: document.getElementById('chat-message').value, error: document.getElementById('chat-error').textContent })`));
await shot(v, 'v05-lan-chat');
a.close(); v.close();
