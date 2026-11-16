// Browser checks use only real archived clips from the owning isolated media fixture.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client } from './missions-client.mjs';

const dev = process.env.FRAME_CLIPS_DEV_SMOKE === '1', origin = `http://127.0.0.1:${dev ? 5366 : 5365}`, port = dev ? 9551 : 9550, output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_CLIPS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_CLIPS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external clip fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'clips-checkpoint.json'), 'utf8'));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!/^obs-clips-[0-9a-f]{12}$/.test(checkpoint.streamPath) || !uuid.test(checkpoint.publicClipId ?? '') || !uuid.test(checkpoint.recordingId ?? '') || !Array.isArray(checkpoint.owner?.cookies)) throw Error('Actual dedicated clip fixtures are required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), dev ? 'frame-clips-dev-ui-' : 'frame-clips-ui-')), profile = path.join(browserDirectory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(directory, dev ? 'browser-dev-owner.json' : 'browser-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], runtimeErrors = [], writes = [], reads = [], ownerHeaders = [], pending = new Set(), canceled = new Set(), intercepted = new Map();
let page, failure = null, holdMutation = false, heldMutation = null, pageLimit = !dev, videoMetrics = null, responseFailure = false, committedResponse = null;
const creations = [];
const privatePrefix = '/api/v1/me/clips', publicPrefix = '/api/v1/clips';
const catalogTransfers=new Map(),catalogCompletions=[];
function check(pass, name, detail) { results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(fn, label, ms = 25000) { for (const end = Date.now() + ms; Date.now() < end;) { const value = await fn(); if (value) return value; await sleep(100); } throw Error('Timeout: ' + label); }
const text = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function navigate(route) { const marker = String(Date.now()); await page.evaluate(`window.__clipDocument=${JSON.stringify(marker)}`); await page.send('Page.navigate', { url: origin + '/_frame' + route }); await until(async () => { try { return await page.evaluate(`window.__clipDocument!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'clip document'); }
async function cookies(saved) { await page.send('Network.clearBrowserCookies'); if (saved) await page.send('Network.setCookies', { cookies: saved.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) }); }
async function set(selector, value) { await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled input ' + selector); await page.evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing clip control');const proto=element.tagName==='SELECT'?HTMLSelectElement.prototype:element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function click(selector) { await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control ' + selector); await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label) { await until(() => page.evaluate(`Array.from(document.querySelectorAll('main button,dialog button')).some(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.matches(':disabled'))`), 'Enabled button ' + label); await page.evaluate(`(() => {const e=Array.from(document.querySelectorAll('main button,dialog button')).find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.matches(':disabled'));e.dataset.clipQaTarget='true';e.scrollIntoView({block:'center'});})()`); await page.click('[data-clip-qa-target]'); await page.evaluate(`document.querySelector('[data-clip-qa-target]')?.removeAttribute('data-clip-qa-target')`); }
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await page.evaluate('scrollTo(0,0)'); await writeFile(path.join(output, name), await page.screenshot()); }
async function command(method, parameters) { const request = intercepted.get(parameters.requestId); try { return await page.send(method, parameters); } catch (problem) { if (/Invalid InterceptionId/.test(problem.message) && request?.networkId) { await sleep(150); if (canceled.has(request.networkId)) return; } throw Error(`clip interception failed for ${request?.method ?? 'unknown'} request: ${problem.message}`); } finally { intercepted.delete(parameters.requestId); } }
async function fulfill(requestId, problem) { await command('Fetch.fulfillRequest', { requestId, responseCode: problem.status ?? 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify({ code: problem.code ?? 'PRODUCT_UNAVAILABLE', detail: problem.detail })).toString('base64') }); }
async function intercept(event) {
  const { requestId, request, networkId } = event.params, url = new URL(request.url); intercepted.set(requestId, { networkId, method: request.method });
  const responseStage = event.params.responseStatusCode !== undefined || event.params.responseErrorReason !== undefined;
  if (responseStage) {
    if (responseFailure && request.method === 'POST' && url.pathname === privatePrefix) { responseFailure = false; committedResponse = { status: event.params.responseStatusCode }; await fulfill(requestId, { detail: '서버 접수 후 클립 응답을 확인하지 못했어요.' }); return; }
    await command('Fetch.continueRequest', { requestId }); return;
  }
  if (request.method === 'GET' && url.pathname === publicPrefix) reads.push({ cursor: url.searchParams.has('cursor') });
  if (url.pathname.startsWith(privatePrefix)) ownerHeaders.push(Object.keys(request.headers).some(name => name.toLowerCase() === 'x-frame-user-id'));
  if (request.method !== 'GET' && request.method !== 'HEAD') writes.push({ method: request.method, kind: url.pathname === privatePrefix ? 'publish' : url.pathname.endsWith('/retry') ? 'retry' : 'edit' });
  if (request.method === 'POST' && url.pathname === privatePrefix) creations.push(JSON.parse(request.postData));
  if (holdMutation && request.method === 'POST' && url.pathname === privatePrefix) { heldMutation = requestId; return; }
  if (failure && (!failure.path || failure.path === url.pathname) && (!failure.method || failure.method === request.method) && (!failure.cursor || url.searchParams.has('cursor'))) { const active = failure; failure = null; await fulfill(requestId, active); return; }
  if (pageLimit && request.method === 'GET' && (url.pathname === publicPrefix || url.pathname === '/api/v1/me/recordings')) { url.searchParams.set('limit', url.pathname === publicPrefix ? '1' : '2'); await command('Fetch.continueRequest', { requestId, url: url.href }); }
  else await command('Fetch.continueRequest', { requestId });
}
async function ownerItem(client,id){const r=await client.request('GET','/me/clips/'+id);if(r.status!==200)throw Error('Private clip metadata returned HTTP '+r.status);return r.data.item;}
async function patch(client,item,visibility,title=item.title,description=item.description){return client.request('PATCH','/me/clips/'+item.id,{version:item.version,title,description,visibility});}
async function parentVisibility(client,visibility){const read=await client.request('GET','/me/vods/'+checkpoint.sourceVodId);if(read.status!==200)throw Error('Source VOD metadata is unavailable.');const item=read.data.item;return client.request('PATCH','/me/vods/'+item.id,{version:item.version,title:item.title,description:item.description,visibility});}
const watchPath=id=>'/clips/'+encodeURIComponent(checkpoint.channel.handle)+'/'+id;
async function findRecording(){await set('[aria-label="녹화 상태"]','ready');for(let i=0;i<30;i++){if(await page.evaluate('!!document.querySelector(\'tr[data-recording-id="'+checkpoint.recordingId+'"]\')'))return;if(await page.evaluate("Array.from(document.querySelectorAll('main button')).some(e=>e.textContent.trim()==='더 불러오기'&&!e.matches(':disabled'))"))await button('더 불러오기');else await sleep(150);}throw Error('The actual clip source recording did not appear.');}
try{
  await mkdir(output,{recursive:true});
  for(let i=0;i<70;i++){try{page=await connect(port,target=>!target.url.startsWith('edge://'));break;}catch{await sleep(100);}}
  if(!page)throw Error('Clip QA browser is unavailable.');
  await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Network.enable');
  page.on(event=>{
    if(event.method==='Runtime.exceptionThrown')runtimeErrors.push(event.params.exceptionDetails.text);
    if(event.method==='Network.requestWillBeSent'){const request=event.params.request,url=new URL(request.url);if(request.method==='GET'&&url.pathname===publicPrefix&&!url.searchParams.has('cursor'))catalogTransfers.set(event.params.requestId,{status:null});}
    if(event.method==='Network.responseReceived'){const request=catalogTransfers.get(event.params.requestId);if(request)request.status=event.params.response.status;}
    if(event.method==='Network.loadingFinished'){const request=catalogTransfers.get(event.params.requestId);if(request){catalogCompletions.push({status:request.status});catalogTransfers.delete(event.params.requestId);}}
    if(event.method==='Network.loadingFailed'){if(event.params.canceled)canceled.add(event.params.requestId);catalogTransfers.delete(event.params.requestId);}
    if(event.method==='Fetch.requestPaused'){const work=intercept(event).catch(problem=>runtimeErrors.push(problem.message));pending.add(work);void work.finally(()=>pending.delete(work));}
  });
  await page.send('Fetch.enable',{patterns:[{urlPattern:'*://*/api/v1/me/clips*',requestStage:'Request'},{urlPattern:'*://*/api/v1/me/clips',requestStage:'Response'},{urlPattern:'*://*/api/v1/clips*',requestStage:'Request'},{urlPattern:'*://*/api/v1/me/recordings*',requestStage:'Request'}]});
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const control=new Client(checkpoint.owner);let uiClipId=null;
  if(!dev){
    await cookies(checkpoint.owner);await navigate('/vod/'+encodeURIComponent(checkpoint.channel.handle)+'/'+checkpoint.sourceVodId);await button('클립 만들기');await has('dialog[open] [aria-label="클립 시작(초)"]');
    await set('[aria-label="클립 시작(초)"]','2');await set('[aria-label="클립 끝(초)"]','6');await set('[aria-label="클립 제목"]',checkpoint.uiTitle);await set('[aria-label="클립 설명"]',checkpoint.description);
    await button('클립 공개');await text('원본 안에서 5~60초 구간을 선택해 주세요.');
    check(creations.length===0,'The composer rejects a shorter-than-five-second interval before any creation request');
    await set('[aria-label="클립 끝(초)"]','8');
    await page.evaluate('document.querySelector(\'video[aria-label="클립 원본 영상"]\').muted=true');await button('선택 구간 재생');
    await until(()=>page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 원본 영상"]\');return !v.paused&&v.currentTime>2.1&&v.currentTime<8;})()'),'Selected source interval begins at its actual offset');
    await page.evaluate('document.querySelector(\'video[aria-label="클립 원본 영상"]\').currentTime=7.9');
    await until(()=>page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 원본 영상"]\');return v.paused&&v.currentTime>=8&&v.currentTime<8.5;})()'),'Selected interval stops at its end');
    check(true,'The source interval preview seeks to its chosen start and pauses at its actual end');
    await button('클립 공개');await has('[aria-label="클립 공개 확인"]');
    check(await page.evaluate("document.activeElement?.textContent.trim()==='취소'"),'Clip publication requires confirmation with initial focus on cancel');
    holdMutation=true;await button('클립 공개하기');await until(()=>heldMutation,'Pending clip creation');
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    check(await page.evaluate('!!document.querySelector(\'dialog[open]\')&&document.querySelector(\'[aria-label="클립 만들기 닫기"]\').matches(\':disabled\')')&&creations.length===1,'A pending clip request locks duplicate actions and composer Escape or close');
    holdMutation=false;const held=heldMutation;heldMutation=null;await fulfill(held,{detail:'클립 요청 결과를 확인하지 못했어요.'});await text('클립 요청 결과를 확인하지 못했어요.');
    check(await page.evaluate('document.querySelector(\'[aria-label="클립 제목"]\').value==='+JSON.stringify(checkpoint.uiTitle)+'&&document.querySelector(\'[aria-label="클립 시작(초)"]\').value==="2"&&document.querySelector(\'[aria-label="클립 끝(초)"]\').value==="8"&&document.querySelector(\'[aria-label="클립 제목"]\').disabled'),'An uncertain request freezes and preserves its intended interval and metadata');
    await button('클립 접수 결과 확인');await text('아직 접수된 클립이 없어요.');
    check(creations.length===1,'Receipt lookup confirms an absent request without automatically posting a new clip');
    responseFailure=true;await button('같은 요청 다시 보내기');await text('서버 접수 후 클립 응답을 확인하지 못했어요.');
    check(committedResponse?.status===202&&creations.length===2&&creations[0].clientRequestId===creations[1].clientRequestId&&JSON.stringify(creations[0])===JSON.stringify(creations[1]),'A manual resend keeps the exact UUID and snapshot even when the actual accepted response is lost');
    await button('클립 접수 결과 확인');await has('[aria-label="클립 편집"]');
    const receipt=await control.request('GET','/me/clips/by-request/'+creations[0].clientRequestId);uiClipId=receipt.data.item?.id;if(!uiClipId)throw Error('The actual accepted UI clip receipt is missing.');
    const created=await until(async()=>{const item=await ownerItem(control,uiClipId);return item.published?item:null;},'Actual UI clip ready and public');
    await has('dialog[open] a[href*="/clips/"][target="_blank"]');
    check(created.title===checkpoint.uiTitle&&created.startMs===2000&&created.endMs===8000&&creations.length===2,'Explicit receipt recovery finds one prepared public clip without repeating an accepted creation');
    const editedTitle=checkpoint.uiTitle+' 수정',editedDescription=checkpoint.description+'\n저장한 설명';
    await set('[aria-label="클립 관리 제목"]',editedTitle);await set('[aria-label="클립 관리 설명"]',editedDescription);failure={method:'PATCH',path:privatePrefix+'/'+uiClipId,detail:'클립 정보 저장을 확인하지 못했어요.'};await button('클립 정보 저장');await text('클립 정보 저장을 확인하지 못했어요.');
    check(await page.evaluate('document.querySelector(\'[aria-label="클립 관리 제목"]\').value==='+JSON.stringify(editedTitle)),'A failed clip metadata save preserves the publisher draft');
    await button('클립 최신 상태 확인');await button('클립 최신 내용으로 바꾸기');await until(()=>page.evaluate('document.querySelector(\'[aria-label="클립 관리 제목"]\').value==='+JSON.stringify(created.title)),'Explicit draft replacement');
    await set('[aria-label="클립 관리 제목"]',editedTitle);await set('[aria-label="클립 관리 설명"]',editedDescription);await button('클립 정보 저장');await text('클립 정보를 저장했어요.');
    check((await ownerItem(control,uiClipId)).title===editedTitle,'An explicitly retried metadata edit saves the real clip title');
    const draft='아직 저장하지 않은 설명';await set('[aria-label="클립 관리 설명"]',draft);const concurrent=await patch(control,await ownerItem(control,uiClipId),'public',editedTitle,editedDescription+'\n다른 창 변경');if(concurrent.status!==200)throw Error('The actual competing clip edit failed.');
    await button('클립 정보 저장');await text('다른 화면에서 설정이 바뀌었을 수 있어요.');
    check(await page.evaluate('document.querySelector(\'[aria-label="클립 관리 설명"]\').value==='+JSON.stringify(draft)),'A real competing revision produces a conflict without overwriting the local draft');
    await button('클립 최신 상태 확인');await button('클립 최신 내용으로 바꾸기');await until(()=>page.evaluate('document.querySelector(\'[aria-label="클립 관리 설명"]\').value==='+JSON.stringify(editedDescription+'\n다른 창 변경')),'Latest committed clip metadata');
    await button('클립 비공개로 변경');await has('[aria-label="클립 변경 확인"]');await button('취소');
    check((await ownerItem(control,uiClipId)).published,'Canceling the private confirmation preserves the actual published clip');
    await button('클립 비공개로 변경');await button('클립 비공개로 바꾸기');await until(async()=>!(await ownerItem(control,uiClipId)).published,'Actual clip withdrawal');
    check((await control.request('GET','/clips/'+uiClipId)).status===404,'Confirmed publisher UI withdrawal blocks anonymous clip detail');
    await button('클립 공개로 변경');await button('클립 공개하기');await until(async()=>(await ownerItem(control,uiClipId)).published,'Actual clip republication');
    check((await control.request('GET','/clips/'+uiClipId)).status===200,'Confirmed republication reuses the same prepared clip');
    await screenshot('clips-publisher-ui.png');await button('클립 만들기 닫기');
    check(await page.evaluate("!document.querySelector('dialog[open]')&&document.activeElement?.textContent.trim()==='클립 만들기'"),'Closing the composer restores focus to its source VOD action');
    await cookies(null);failure={path:publicPrefix,detail:'클립 목록의 첫 연결을 확인하지 못했어요.'};await navigate('/clips?q='+encodeURIComponent(checkpoint.needle));await text('클립 목록의 첫 연결을 확인하지 못했어요.');await button('클립 목록 다시 시도');await has('a[href*="/clips/"]');
    check(await page.evaluate("document.querySelector('main h1').textContent==='클립'&&!document.querySelector('main').innerText.includes('조회수')&&!document.querySelector('main').innerText.includes('지난 채팅')"),'The anonymous catalog uses real clip cards without invented views or old chat');
    failure={method:'GET',path:publicPrefix,detail:'클립 목록 갱신에 실패했어요.'};await click('[aria-label="클립 목록 새로고침"]');await text('클립 목록 갱신에 실패했어요.');
    check(await page.evaluate("!!document.querySelector('a[href*=\"/clips/\"]')"),'A failed clip refresh keeps the last real catalog visible');const completedBeforeRefresh=catalogCompletions.length;await button('클립 목록 다시 시도');await until(()=>catalogCompletions.slice(completedBeforeRefresh).some(result=>result.status===200),'A newer successful catalog response finishes');await until(()=>page.evaluate('!document.querySelector(\'[aria-label="클립 목록 새로고침"]\').disabled&&!document.body.innerText.includes("클립 목록 갱신에 실패했어요.")'),'Completed refresh response is rendered');
    const firstCount=await page.evaluate("document.querySelectorAll('main [data-clip-id]').length");failure={method:'GET',path:publicPrefix,cursor:true,detail:'다음 클립 목록을 확인하지 못했어요.'};await button('클립 더 불러오기');await text('다음 클립 목록을 확인하지 못했어요.');
    check(await page.evaluate("document.querySelectorAll('main [data-clip-id]').length")==firstCount,'A failed next-page request preserves existing real cards');await button('클립 더 불러오기 다시 시도');await until(async()=>await page.evaluate("document.querySelectorAll('main [data-clip-id]').length")>firstCount,'Actual next clip page');
    await page.evaluate("window.dispatchEvent(new Event('offline'))");await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await page.evaluate("window.dispatchEvent(new Event('offline'))");await text('인터넷 연결을 확인해 주세요.');
    check(await page.evaluate('document.querySelector(\'[aria-label="클립 제목 검색"]\').value==='+JSON.stringify(checkpoint.needle)),'Offline catalog state preserves its search filter');
    await page.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.evaluate("window.dispatchEvent(new Event('online'))");await until(()=>page.evaluate('!document.querySelector(\'[aria-label="클립 목록 새로고침"]\').disabled'),'Online clip catalog recovery');await screenshot('clips-catalog-ui.png');
    await navigate('/channel/'+encodeURIComponent(checkpoint.channel.handle)+'?tab=clips');await has('a[href*="'+uiClipId+'"]');
    check(await page.evaluate('!!document.querySelector(\'a[href*="'+uiClipId+'"]\')&&!document.querySelector(\'a[href*="'+checkpoint.privateClipId+'"]\')'),'The actual channel clip tab includes public clips and excludes a private clip');
    await navigate(watchPath(uiClipId));await has('video[aria-label="클립 영상"]');
    check(await page.evaluate('document.querySelector(\'video[aria-label="클립 영상"]\').paused&&!document.querySelector(\'video[aria-label="클립 영상"]\').autoplay&&!Array.from(document.querySelectorAll(\'main button\')).some(e=>e.textContent.trim()==="클립 만들기")'),'Anonymous clip playback is available without login and starts only on user intent');
    await page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 영상"]\');v.muted=true;v.play().catch(e=>{window.__clipPlayError=e.name;});})()');
    videoMetrics=await until(()=>page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 영상"]\'),q=v?.getVideoPlaybackQuality();return v&&v.videoWidth===320&&v.videoHeight===180&&v.currentTime>.3&&(q?.totalVideoFrames??0)>3?{width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime,duration:v.duration,decodedFrames:q.totalVideoFrames,audioDecodedBytes:v.webkitAudioDecodedByteCount??null}:null;})()'),'Anonymous actual clip decoding');
    check(Math.abs(videoMetrics.duration-6)<=.5&&videoMetrics.audioDecodedBytes>0,'The anonymous player decodes a real six-second video and audio clip',videoMetrics);
    const target=videoMetrics.duration/2;await page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 영상"]\');v.pause();v.currentTime='+target+';})()');await until(()=>page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 영상"]\');return !v.seeking&&Math.abs(v.currentTime-'+target+')<.3;})()'),'Actual clip seek');await page.evaluate('document.querySelector(\'video[aria-label="클립 영상"]\').play().catch(()=>{})');
    videoMetrics.seek=await until(()=>page.evaluate('(()=>{const v=document.querySelector(\'video[aria-label="클립 영상"]\'),q=v.getVideoPlaybackQuality();return v.currentTime>'+Number(target+.15)+'&&q.totalVideoFrames>'+videoMetrics.decodedFrames+'?{target:'+target+',currentTime:v.currentTime,decodedFrames:q.totalVideoFrames}:null;})()'),'Decoded clip progress after seek');await page.evaluate('document.querySelector(\'video[aria-label="클립 영상"]\').pause()');
    check(true,'The actual clipped file advances decoded frames after a native middle seek',videoMetrics.seek);
    await button('클립 공유');await has('dialog[open] input[readonly]');check(await page.evaluate("document.querySelector('dialog[open] input[readonly]').value===location.href"),'The clip share dialog exposes its stable public URL');await page.key('Escape');
    check(await page.evaluate("!document.querySelector('dialog[open]')&&document.activeElement?.textContent.trim()==='클립 공유'"),'Closing clip sharing restores focus');await screenshot('clips-watch-ui.png');
    for(const width of[390,320]){await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:true});check(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Clip metadata and player fit the '+width+'px viewport');await screenshot('clips-watch-'+width+'-ui.png');}
    await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});const hiddenParent=await parentVisibility(control,'private');if(hiddenParent.status!==200)throw Error('The actual source VOD withdrawal failed.');
    await until(()=>page.evaluate('!document.querySelector(\'video[aria-label="클립 영상"]\')'),'Parent withdrawal clears loaded clip playback',30000);
    check((await ownerItem(control,uiClipId)).visibility==='public','A real parent withdrawal clears clip playback while preserving the clip own public preference');
    await parentVisibility(control,'public');
    await cookies(checkpoint.owner);await navigate('/studio/recordings');await has('tr[data-recording-id]');await findRecording();await click('tr[data-recording-id="'+checkpoint.recordingId+'"] button');await has('[data-clip-id="'+uiClipId+'"]');await click('[data-clip-id="'+uiClipId+'"] button');await has('[aria-label="클립 편집"]');
    const sameModalDraft='같은 창에서 원본 공개를 바꿔도 남길 설명';await set('[aria-label="클립 관리 설명"]',sameModalDraft);
    await until(()=>page.evaluate('document.querySelector(\'[aria-label="클립 관리 설명"]\').value==='+JSON.stringify(sameModalDraft)+'&&Array.from(document.querySelectorAll(\'[aria-label="클립 편집"] button\')).some(e=>e.textContent.trim()==="클립 정보 저장"&&!e.disabled)'),'The enabled editor accepts its controlled unsaved draft');
    await button('비공개로 변경');await button('비공개로 바꾸기');
    await until(()=>page.evaluate('document.querySelector(\'[aria-label="클립 편집"]\').innerText.includes("원본 비공개")&&!document.querySelector(\'[aria-label="클립 편집"] a[href*="/clips/"]\')'),'Same-modal parent withdrawal updates clip availability');
    check(await page.evaluate('document.querySelector(\'[aria-label="클립 관리 설명"]\').value==='+JSON.stringify(sameModalDraft)),'Same-modal parent withdrawal hides clip public links while preserving the dirty clip draft');
    await button('공개로 변경');await button('공개하기');await has('[aria-label="클립 편집"] a[href*="/clips/"]');
    check(await page.evaluate('document.querySelector(\'[aria-label="클립 관리 설명"]\').value==='+JSON.stringify(sameModalDraft)),'Same-modal parent republication restores the clip state without overwriting its draft');
    await click('[aria-label="클립 상태 새로고침"]');await button('클립 최신 내용으로 바꾸기');await until(()=>page.evaluate('document.querySelector(\'[aria-label="클립 관리 설명"]\').value!=='+JSON.stringify(sameModalDraft)),'Explicitly discard the inspected dirty draft');
    await cookies(checkpoint.other);await click('[aria-label="클립 상태 새로고침"]');
    await until(()=>page.evaluate('!document.querySelector(\'[aria-label="클립 편집"]\')&&!document.querySelector(\'tr[data-recording-id]\')'),'Publisher cookie-account scope cleanup');
    check(true,'Changing the shared cookie account clears previous private clip and recording content');
  }else{
    await cookies(null);await navigate('/clips?q='+encodeURIComponent(checkpoint.needle));await has('a[href*="/clips/"]');check(true,'Development StrictMode renders actual anonymous clip cards');
    await navigate(watchPath(checkpoint.publicClipId));await has('video[aria-label="클립 영상"]');check(await page.evaluate("!document.querySelector('video').autoplay&&!document.querySelector('main').innerText.includes('지난 채팅')"),'Development clip watch uses actual media without autoplay or invented chat');
  }
  await Promise.all([...pending]);check(runtimeErrors.length===0&&ownerHeaders.every(Boolean)&&(!dev||writes.length===0),'Clip management carries its expected owner with no runtime or unconfirmed interception errors');
  await writeFile(path.join(output,dev?'clips-dev-result.json':'clips-ui-result.json'),JSON.stringify({verificationDatabaseOnly:true,checks:results.length,passed:results.filter(r=>r.pass).length,results,runtimeErrors,writes,videoMetrics,completedCatalogResponses:catalogCompletions,acceptedResponseBeforeFault:committedResponse,creationRequests:creations.length,creationSnapshotPreserved:creations.length===0||creations.every(item=>JSON.stringify(item)===JSON.stringify(creations[0])),paginationInstrumentation:dev?null:'Public clip list limit lowered to 1 and recording list to 2; rows and cursors remain actual server responses.',limits:['Headless Edge on one PC only','Mobile sizes are emulated viewports, not physical phones']},null,2));console.log(JSON.stringify({checks:results.length,passed:results.filter(r=>r.pass).length,runtimeErrors:runtimeErrors.length,writes:writes.length}));
}catch(problem){await writeFile(path.join(output,dev?'clips-dev-failure.json':'clips-ui-failure.json'),JSON.stringify({results,failure:problem.message,runtimeErrors,reads,writes},null,2));if(page)await screenshot('clips-ui-failure.png').catch(()=>{});throw problem;}
finally{if(page){await Promise.race([page.send('Browser.close').catch(()=>{}),sleep(1000)]);page.close();}browser.kill();const literal=profile.replaceAll("'","''");try{execFileSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"+literal+"') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{}}
