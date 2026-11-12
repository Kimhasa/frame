// Isolated OBS-compatible H.264 + single AAC publication -> MediaMTX -> Spring auto registration -> HLS/DVR.
// Uses FFmpeg as the RTMP/RTMPS protocol sender, not the OBS GUI; no user's OBS profile or native config is touched.
// Run alone (one heavy media verification at a time): node server/verify/obs-e2e.mjs
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {start,stop,stopAll,waitFor,sleep,checks,portFree,scrub} from './harness.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const TMP=join(tmpdir(),'frame-obs-e2e-'+Date.now()),OUT=join(ROOT,'verification/obs');
const BIN=join(ROOT,'dist/FrameConsole/bin'),FFMPEG=join(BIN,'ffmpeg.exe'),MTX=join(BIN,'mediamtx.exe');
const JAVA=process.env.FRAME_JAVA||execFileSync('where.exe',['java']).toString().trim().split(/\r?\n/)[0];
const JAR=join(ROOT,'apps/api/build/libs/frame-api.jar');
const OPENSSL=['C:/Program Files/Git/usr/bin/openssl.exe','C:/Program Files/Git/mingw64/bin/openssl.exe'].find(existsSync);
const PORT={rtmp:29635,rtmps:29636,rtsp:29554,rtsps:29322,api:29997,hls:29888,webrtc:29889,playback:29996,metrics:29998,ice:29189,spring:29070};
const API=`http://127.0.0.1:${PORT.spring}`,MTXAPI=`http://127.0.0.1:${PORT.api}`,PATH='obs-spring';
const TOKEN=randomBytes(32).toString('hex'),OTHER=randomBytes(32).toString('hex'),NATIVE=randomBytes(32).toString('hex');
const sha=s=>'sha256:'+createHash('sha256').update(s).digest('base64');
const mask=s=>[TOKEN,OTHER,NATIVE].reduce((text,key)=>text.replaceAll(key,'***'),scrub(String(s),ROOT));
for(const dir of[TMP,OUT])mkdirSync(dir,{recursive:true});
const {list,check}=checks();let sender;
const result={startedAt:new Date().toISOString(),kind:'FFmpeg H264+AAC RTMP/RTMPS protocol sender (OBS GUI not exercised), loopback PC only',ports:PORT,checks:list};
const get=async(path,token)=>{const r=await fetch(API+path,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(12000)});const text=await r.text();let body;try{body=JSON.parse(text)}catch{}return{status:r.status,text,body,headers:r.headers};};
const auth=()=>({Authorization:'Bearer '+TOKEN});
async function publish(name,{token=TOKEN,path=PATH,tls=false,native=false}={}){
 const url=native?`rtsps://frame-sender-01:${NATIVE}@127.0.0.1:${PORT.rtsps}/screen-01`:`${tls?'rtmps':'rtmp'}://127.0.0.1:${tls?PORT.rtmps:PORT.rtmp}/${path}?user=${PATH}&pass=${token}`;
 const args=['-hide_banner','-nostdin','-loglevel','info','-re','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-f','lavfi','-i','sine=frequency=880:sample_rate=48000',
  '-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-g','30','-bf','0','-b:v','1800k','-c:a','aac','-b:a','128k','-ar','48000'];
 if(tls||native)args.push('-ca_file',join(TMP,'cert.pem'));
 if(native)args.push('-f','rtsp','-rtsp_transport','tcp',url);else args.push('-f','flv',url);
 return start(name,FFMPEG,args,{logDir:TMP});
}
async function decode(name,url){
 const process=start(name,FFMPEG,['-hide_banner','-nostdin','-loglevel','info','-rw_timeout','10000000','-i',url,'-t','2','-map','0:v:0','-map','0:a:0','-f','null','-'],{logDir:TMP});
 const code=await Promise.race([process.exited,sleep(20000).then(()=>-999)]);if(code===-999)await stop(process);
 const log=process.lines.join('\n');return{code,video:/Video: h264/.test(log),audio:/Audio: aac/.test(log),frames:/frame=\s*[1-9]/.test(log)};
}
try{
 for(const file of[FFMPEG,MTX,JAR,JAVA,OPENSSL])if(!file||!existsSync(file))throw Error('Missing verification dependency');
 for(const port of Object.values(PORT))if(!await portFree(port))throw Error('Verification port in use: '+port);
 execFileSync(OPENSSL,['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(TMP,'key.pem'),'-out',join(TMP,'cert.pem')],{stdio:'ignore'});
 copyFileSync(join(ROOT,'deploy/mediamtx-relay.yml'),join(TMP,'mediamtx.yml'));
 start('mediamtx',MTX,['mediamtx.yml'],{cwd:TMP,logDir:TMP,env:{
  MTX_AUTHINTERNALUSERS_1_PASS:sha(NATIVE),MTX_AUTHINTERNALUSERS_2_PASS:sha(OTHER),MTX_AUTHINTERNALUSERS_3_PASS:sha(TOKEN),
  MTX_RTMP:'true',MTX_RTMPADDRESS:`127.0.0.1:${PORT.rtmp}`,MTX_RTMPSADDRESS:`127.0.0.1:${PORT.rtmps}`,MTX_RTMPSERVERKEY:join(TMP,'key.pem'),MTX_RTMPSERVERCERT:join(TMP,'cert.pem'),
  MTX_RTSPADDRESS:`127.0.0.1:${PORT.rtsp}`,MTX_RTSPSADDRESS:`127.0.0.1:${PORT.rtsps}`,MTX_RTSPSERVERKEY:join(TMP,'key.pem'),MTX_RTSPSERVERCERT:join(TMP,'cert.pem'),
  MTX_APIADDRESS:`127.0.0.1:${PORT.api}`,MTX_HLSADDRESS:`127.0.0.1:${PORT.hls}`,MTX_WEBRTCADDRESS:`127.0.0.1:${PORT.webrtc}`,MTX_PLAYBACKADDRESS:`127.0.0.1:${PORT.playback}`,MTX_METRICSADDRESS:`127.0.0.1:${PORT.metrics}`,
  MTX_WEBRTCLOCALUDPADDRESS:`127.0.0.1:${PORT.ice}`,MTX_WEBRTCLOCALTCPADDRESS:`127.0.0.1:${PORT.ice}`,MTX_WEBRTCADDITIONALHOSTS:'127.0.0.1',PATH:BIN+';'+process.env.PATH}});
 if(!await waitFor(async()=> (await fetch(MTXAPI+'/v3/paths/list')).ok,15000))throw Error('MediaMTX did not start');
 start('spring',JAVA,['-Xms64m','-jar',JAR],{logDir:TMP,env:{RELAY_PORT:String(PORT.spring),RELAY_PUBLISHER_TOKENS:`${TOKEN} ${PATH},${OTHER} obs-other,${NATIVE} screen-01`,RELAY_OBS_ENABLED:'true',RELAY_OBS_SERVER_URL:`rtmp://127.0.0.1:${PORT.rtmp}`,
  RELAY_MEDIAMTX_API:MTXAPI,RELAY_MEDIAMTX_HLS:`http://127.0.0.1:${PORT.hls}`,RELAY_MEDIAMTX_WEBRTC:`http://127.0.0.1:${PORT.webrtc}`,RELAY_MEDIAMTX_PLAYBACK:`http://127.0.0.1:${PORT.playback}`,RELAY_MEDIAMTX_RTSP:`rtsp://127.0.0.1:${PORT.rtsp}`,
  RELAY_ANNOUNCE_TTL_MS:'3000',RELAY_MEDIA_GRACE_MS:'5000',RELAY_RECORD_DIR:join(TMP,'recordings'),RELAY_FFMPEG:FFMPEG,RELAY_RENDITIONS:'480p'}});
 if(!await waitFor(async()=> (await get('/healthz')).body?.mediamtx,30000))throw Error('Spring did not start');
 const unsigned=await get('/api/obs/'+PATH),wrongOwner=await get('/api/obs/'+PATH,OTHER),ready=await get('/api/obs/'+PATH,TOKEN);
 check('publisher-only OBS status and no-store',unsigned.status===401&&wrongOwner.status===403&&ready.status===200&&ready.headers.get('cache-control')==='no-store'&&ready.body.streamKey===`${PATH}?user=${PATH}&pass=${TOKEN}`,{unsigned:unsigned.status,wrongOwner:wrongOwner.status,owner:ready.status});
 const put=await fetch(API+'/api/obs/'+PATH,{method:'PUT',headers:{...auth(),'Content-Type':'application/json'},body:JSON.stringify({title:'OBS protocol test',publisher:'Test sender'})});
 check('authenticated metadata',put.status===204,{status:put.status});
 const bad=await publish('wrong-password',{token:OTHER});const badExit=await Promise.race([bad.exited,sleep(7000).then(()=>-999)]);await stop(bad);
 check('RTMP wrong password rejected',badExit!==0&&badExit!==-999&&!((await get('/api/broadcasts')).body?.items?.length),{exit:badExit});
 const wrongPath=await publish('wrong-path',{path:'obs-other'});const wrongExit=await Promise.race([wrongPath.exited,sleep(7000).then(()=>-999)]);await stop(wrongPath);
 check('RTMP key cannot publish another path',wrongExit!==0&&wrongExit!==-999&&!((await get('/api/broadcasts')).body?.items?.length),{exit:wrongExit});
 sender=await publish('rtmp-publisher');
 const active=await waitFor(async()=>{const r=await get('/api/broadcasts');return r.body?.items?.find(i=>i.path===PATH);},20000);
 check('OBS media auto-registers without announce helper',!!active&&active.title==='OBS protocol test',{id:active?.id,title:active?.title});if(!active)throw Error('RTMP never registered');
 const firstId=active.id;await sleep(4500);
 check('backend heartbeat outlives announce TTL',((await get('/api/broadcasts')).body?.items||[]).some(i=>i.id===firstId),{ttlMs:3000,waitMs:4500});
 const live=await decode('hls-decode',`${API}/${PATH}/b/${firstId}/live.m3u8`);
 check('public HLS decodes H264 and single AAC',live.code===0&&live.video&&live.audio&&live.frames,live);
 const dvrReady=await waitFor(async()=>{const r=await get(`/${PATH}/b/${firstId}/dvr.m3u8`);return r.status===200&&r.text.includes('#EXTINF');},20000);
 const dvr=dvrReady?await decode('dvr-decode',`${API}/${PATH}/b/${firstId}/dvr.m3u8`):{code:-1};
 check('DVR retains OBS AAC audio',dvr.code===0&&dvr.video&&dvr.audio&&dvr.frames,dvr);
 const publicList=await get('/api/broadcasts'),publicInfo=await get('/'+PATH+'/info');
 check('public viewer responses contain no publisher secrets',![TOKEN,OTHER,NATIVE].some(secret=>(publicList.text+publicInfo.text).includes(secret)),{list:publicList.status,info:publicInfo.status});
 await stop(sender);sender=await publish('quick-reconnect');
 const resumed=await waitFor(async()=>{const r=await get('/api/obs/'+PATH,TOKEN);return r.body?.state==='live'&&r.body;},10000);
 check('OBS reconnect within grace keeps broadcast id',resumed?.broadcastId===firstId,{id:resumed?.broadcastId,expected:firstId,graceMs:5000});
 await stop(sender);sender=null;
 const ended=await waitFor(async()=>{const r=await get('/api/obs/'+PATH,TOKEN);return r.body?.state==='waiting'&&!r.body?.broadcastId;},15000);
 const endedLink=await get(`/${PATH}/b/${firstId}/live.m3u8`);
 check('stop OBS ends after reconnect grace',!!ended&&endedLink.status===404,{graceMs:5000,oldLink:endedLink.status});
 sender=await publish('rtmps-publisher',{tls:true});
 const next=await waitFor(async()=>{const r=await get('/api/broadcasts');return r.body?.items?.find(i=>i.path===PATH&&i.id!==firstId);},20000);
 const oldLink=await get(`/${PATH}/b/${firstId}/live.m3u8`);
 check('RTMPS next broadcast uses new id; old link refused',!!next&&oldLink.status===409,{newId:next?.id,oldId:firstId,oldLink:oldLink.status});
 await stop(sender);sender=null;await waitFor(async()=>{const r=await get('/api/obs/'+PATH,TOKEN);return r.body?.state==='waiting'&&!r.body?.broadcastId;},15000);
 sender=await publish('native-compatible-rtsps',{native:true});
 const nativeUp=await waitFor(async()=>{const r=await fetch(MTXAPI+'/v3/paths/list');return(await r.json()).items?.some(i=>i.name==='screen-01'&&(i.ready||i.available));},15000);
 check('existing native RTSPS credential still publishes',!!nativeUp,{path:'screen-01'});
 await stop(sender);sender=null;
 const mtxLog=readFileSync(join(TMP,'mediamtx.log'),'utf8'),springLog=readFileSync(join(TMP,'spring.log'),'utf8');
 check('MediaMTX and Spring logs omit publisher token',![TOKEN,OTHER,NATIVE].some(secret=>(mtxLog+springLog).includes(secret)),{});
}catch(error){check('verification completed',false,{error:mask(error.stack||error)});}finally{
 await stopAll();result.finishedAt=new Date().toISOString();result.passed=list.filter(c=>c.ok).length;result.failed=list.filter(c=>!c.ok).length;
 writeFileSync(join(OUT,'obs-e2e-result.json'),mask(JSON.stringify(result,null,2))+'\n');
 mkdirSync(join(OUT,'logs'),{recursive:true});for(const name of readdirSync(TMP).filter(f=>f.endsWith('.log')))writeFileSync(join(OUT,'logs',name),mask(readFileSync(join(TMP,name),'utf8')));
 console.log(JSON.stringify({passed:result.passed,failed:result.failed,temp:TMP,result:join(OUT,'obs-e2e-result.json')}));if(result.failed)process.exitCode=1;
}
