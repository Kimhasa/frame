// Portfolio screenshots only: an isolated static design build, never the OBS/runtime server.
// node outputs/portfolio-frame/capture.mjs [--build-dir <portfolio-build>] [--out <screens-folder>]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from '../../tools/cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf('--' + name); return index < 0 ? fallback : args[index + 1]; };
const buildDir = resolve(root, option('build-dir', 'outputs/portfolio-frame/site'));
const out = resolve(root, option('out', 'outputs/portfolio-frame/screens'));
const port = 5361, devtools = 9495, origin = `http://127.0.0.1:${port}`;
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const free = port => new Promise(resolve => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
if (!existsSync(join(buildDir, 'index.html'))) throw new Error('Portfolio build not found: ' + buildDir);
for (const value of [port, devtools]) if (!await free(value)) throw new Error(`Port ${value} is busy; no existing process will be touched.`);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'frame-portfolio-capture-'));
const preview = spawn(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'design', '--outDir', buildDir,
  '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: join(root, 'apps/web'), windowsHide: true, stdio: 'ignore' });
let edge, client;
const manifest = { createdAt: new Date().toISOString(), fixtureOnly: true, buildDir, screens: [], errors: [] };

try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(origin + '/_frame/', { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    if (attempt === 79) throw new Error('Isolated static preview did not become ready.');
    await sleep(200);
  }
  edge = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-features=msEdgeSidebarV2', '--disable-background-networking', '--force-device-scale-factor=1',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devtools}`, `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  for (let attempt = 0; attempt < 80; attempt++) {
    try { client = await connect(devtools); break; } catch {}
    if (attempt === 79) throw new Error('Isolated screenshot browser did not become ready.');
    await sleep(200);
  }
  await client.send('Page.enable');
  await client.send('Network.enable');
  // Fixture pages need assets only. This blocks media/API access even if the build is misconfigured.
  await client.send('Network.setBlockedURLs', { urls: ['*/api/*', '*/info*', '*/hls/*', '*whep*', 'http://127.0.0.1:5360/*', 'http://127.0.0.1:18080/*'] });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(origin)}) {
    const OriginalDate = Date, instant = OriginalDate.parse('2026-11-11T20:18:00+09:00');
    window.Date = class extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super(instant); } static now() { return instant; } };
    localStorage.setItem('frame.design-session.v1','1'); localStorage.removeItem('frame.design-community.v1');
  }` });
  client.on(event => {
    if (event.method === 'Runtime.exceptionThrown') manifest.errors.push(event.params.exceptionDetails.text);
  });
  await client.send('Runtime.enable');
  const watchPath = option('watch-path', 'workspace'), watchId = option('watch-id', '1'.padStart(32, '0'));
  const watch = `/watch/${encodeURIComponent(watchPath)}/${encodeURIComponent(watchId)}`;
  const screens = [
    ['live', '/live'], ['watch', watch], ['channel', '/channel/spring'], ['following', '/following'],
    ['broadcast', '/studio/broadcast?state=live'], ['analytics', '/studio/analytics'], ['revenue', '/studio/revenue'],
    ['channel-videos', '/channel/spring?tab=videos'],
    ['live-mobile', '/live', true], ['channel-mobile', '/channel/spring', true], ['watch-mobile', watch, true],
  ];
  for (const [name, route, mobile = false] of screens) {
    const width = mobile ? 390 : 1600, height = mobile ? 844 : 1050, dpr = 2;
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await client.send('Page.navigate', { url: origin + '/_frame' + route });
    for (let attempt = 0; attempt < 80; attempt++) {
      const ready = await client.evaluate(`!!document.querySelector('main h1') && document.readyState === 'complete'`);
      if (ready) break;
      if (attempt === 79) throw new Error('Page did not render: ' + route);
      await sleep(125);
    }
    await client.evaluate(`(async()=>{ await document.fonts.ready; await Promise.all([...document.images].map(image=>{image.loading='eager';return image.decode().catch(()=>{});})); await Promise.all([...document.querySelectorAll('video[poster]')].map(video=>new Promise(resolve=>{const image=new Image();image.onload=image.onerror=resolve;image.src=video.poster;}))); window.scrollTo(0,0); })()`);
    await sleep(350);
    if (name === 'live' || name === 'live-mobile') {
      await client.evaluate(`(()=>{const select=document.querySelector('select[aria-label="방송 정렬"]');if(select){select.value='viewers';select.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
      await sleep(80);
    }
    if (name.startsWith('watch')) {
      const nickname = await client.evaluate(`(()=>{const button=document.querySelector('button[aria-label="채팅 닉네임 설정"]');if(!button)return false;button.click();return true;})()`);
      if (nickname) {
        await sleep(80);
        await client.send('Input.insertText', { text: '봄' });
        await sleep(80);
        await client.evaluate(`document.querySelector('dialog[open] form')?.requestSubmit()`);
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!await client.evaluate(`!!document.querySelector('dialog[open]')`)) break;
          if (attempt === 19) throw new Error('Nickname dialog did not close: ' + route);
          await sleep(100);
        }
        await client.evaluate('window.scrollTo(0,0)');
      }
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.min(width - 24, 700), y: mobile ? 260 : 600 });
      await sleep(80);
    }
    const info = await client.evaluate(`({title:document.title,h1:document.querySelector('main h1')?.textContent.trim(),capturedFixtureDate:new Date().toISOString(),fontLoaded:document.fonts.check('15px Pretendard'),viewport:[innerWidth,innerHeight],cards:document.querySelectorAll('main article').length,brokenImages:[...document.images].filter(i=>i.complete&&!i.naturalWidth).length,openDialogs:document.querySelectorAll('dialog[open]').length,bodyOverflow:document.documentElement.scrollWidth>innerWidth,unexpectedEmpty:/지금 방송 중인 채널이 없어요|잠시 후 다시 시도|송출 정보를 불러오는 중/.test(document.querySelector('main')?.textContent||'')})`);
    if (!info.fontLoaded || info.brokenImages || info.openDialogs || info.unexpectedEmpty) throw new Error('Incomplete screenshot ' + name + ': ' + JSON.stringify(info));
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width, height, scale: 1 } });
    const image = Buffer.from(screenshot.data, 'base64');
    const file = join(out, name + '.png');
    await writeFile(file, image);
    manifest.screens.push({ name, route, file, cssSize: [width, height], pngSize: [image.readUInt32BE(16), image.readUInt32BE(20)], dpr, ...info });
    console.log(JSON.stringify({ name, pngSize: manifest.screens.at(-1).pngSize, cards: info.cards, overflow: info.bodyOverflow }));
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Portfolio screenshots ready: ' + out);
} finally {
  if (client) { try { await client.send('Browser.close'); } catch {} client.close(); }
  if (edge && edge.exitCode === null) edge.kill();
  preview.kill();
  const temporaryRoot = resolve(tmpdir());
  if (resolve(profile).startsWith(temporaryRoot + '\\') || resolve(profile).startsWith(temporaryRoot + '/')) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
}
