// Local-PC OBS runtime only. No capture, sender, native-app changes, or OBS-profile changes.
// node server/obs-local.mjs start|status|stop|restart-api
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync,renameSync,unlinkSync,copyFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const localAppDataRoot=process.env.LOCALAPPDATA;if(!localAppDataRoot)throw Error('LOCALAPPDATA is required');
const DIR=join(localAppDataRoot,'Frame','obs-local'),CONFIG=join(DIR,'studio.json'),STATE=join(DIR,'runtime.json'),LOCK=join(DIR,'operation.lock');
const BIN=join(ROOT,'dist','FrameConsole','bin'),MTX=join(BIN,'mediamtx.exe'),FFMPEG=join(BIN,'ffmpeg.exe'),JAR=join(ROOT,'apps','api','build','libs','frame-api.jar');
const PORT={spring:18080,rtmp:1935,rtsp:18554,api:19997,hls:18888,playback:19996};
const URL=`http://127.0.0.1:${PORT.spring}`,PATH='obs-spring';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
function write(file,value){const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,file);}
function identity(pid){
 if(!Number.isInteger(pid)||pid<1)return null;
 try {return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress`],{windowsHide:true,stdio:['ignore','pipe','ignore']}).toString()||'null');}catch{return null;}
}
function exactArgument(command,value){const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp('(?:^|[\\s"])'+escaped+'(?:[\\s"]|$)','i').test(command||'');}
function owned(pid){const p=identity(pid);if(!p)return false;return p.Name?.toLowerCase()==='java.exe'?exactArgument(p.CommandLine,'-Dframe.obs.runtimeDir='+DIR):p.Name?.toLowerCase()==='mediamtx.exe'&&exactArgument(p.CommandLine,join(DIR,'mediamtx.yml'));}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
function operationLock(){
 const self=identity(process.pid);if(!self?.CreationDate)throw Error('Cannot verify launcher process identity.');
 const lease={pid:process.pid,name:self.Name,createdAt:self.CreationDate,nonce:randomBytes(16).toString('hex')};
 for(let attempt=0;attempt<3;attempt++){
  let fd;
  try{fd=openSync(LOCK,'wx',0o600);}catch(error){
   if(error.code!=='EEXIST')throw error;
   const previous=read(LOCK);
   if(!previous?.pid||!previous?.nonce||!previous?.createdAt)throw Error('An incomplete operation lock exists; no runtime process was changed.');
   const owner=identity(previous.pid);
   if(owner&&owner.CreationDate===previous.createdAt&&owner.Name===previous.name)throw Error('Another local OBS start/stop operation is running. Try again when it finishes.');
   if(!owner&&alive(previous.pid))throw Error('Cannot verify the operation lock owner; no runtime process was changed.');
   // Recover a dead/reused PID's stale lease only if it is still the same lease. A new owner is never cleared.
   if(read(LOCK)?.nonce!==previous.nonce)continue;
   try{unlinkSync(LOCK);}catch(error){if(error.code!=='ENOENT')throw error;}
   continue;
  }
  try{writeFileSync(fd,JSON.stringify(lease)+'\n');}finally{closeSync(fd);}
  const assert=()=>{if(read(LOCK)?.nonce!==lease.nonce)throw Error('Local OBS operation lock ownership changed.');};
  const release=()=>{if(read(LOCK)?.nonce===lease.nonce)try{unlinkSync(LOCK);}catch{}};
  process.once('exit',release);return{assert,release};
 }
 throw Error('Could not acquire the local OBS operation lock.');
}
function listenersMatch(state,mediaOnly=false){
 try{
  const expected=Object.entries(PORT).filter(([name])=>!mediaOnly||name!=='spring');
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',`Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(${expected.map(([,port])=>port).join(',')}) } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`],{windowsHide:true,stdio:['ignore','pipe','ignore']}).toString();
  const value=JSON.parse(raw||'[]'),rows=Array.isArray(value)?value:[value];
  return expected.every(([name,port])=>rows.some(row=>row.LocalPort===port&&row.LocalAddress==='127.0.0.1'&&row.OwningProcess===(name==='spring'?state.spring:state.mediamtx)));
 }catch{return false;}
}
async function free(port){return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});}
async function healthy(){try{const r=await fetch(URL+'/healthz',{signal:AbortSignal.timeout(2500)});return r.ok&&(await r.json()).mediamtx===true;}catch{return false;}}
async function wait(fn,ms){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await sleep(250);}return false;}
function env(values){const merged={...process.env};for(const key of Object.keys(merged))if(/^(RELAY_|MTX_|TOSS_TEST_|FRAME_PRODUCT_)/i.test(key))delete merged[key];for(const[k,v]of Object.entries(values)){for(const key of Object.keys(merged))if(key.toLowerCase()===k.toLowerCase())delete merged[key];merged[k]=v;}return merged;}
function paymentEnv(){
 const payment=read(join(DIR,'toss-test.json'));
 if(!payment)return{TOSS_TEST_ENABLED:'false',TOSS_TEST_CLIENT_KEY:'',TOSS_TEST_SECRET_KEY:'',TOSS_TEST_SECURITY_KEY:'',TOSS_TEST_STORE_DIR:''};
 const clientKey=payment.clientKey||'',secretKey=payment.secretKey||'',securityKey=payment.securityKey||'';
 if(!/^test_(sk|gsk)_[A-Za-z0-9_-]{8,400}$/.test(secretKey)||clientKey&&(!/^test_(ck|gck)_[A-Za-z0-9_-]{8,400}$/.test(clientKey)||(clientKey.startsWith('test_ck_')!==secretKey.startsWith('test_sk_'))))throw Error('Toss local configuration requires a matching TEST-only key pair; no credentials were printed.');
 return{TOSS_TEST_ENABLED:'true',TOSS_TEST_CLIENT_KEY:clientKey,TOSS_TEST_SECRET_KEY:secretKey,TOSS_TEST_SECURITY_KEY:securityKey,TOSS_TEST_STORE_DIR:join(DIR,'payments')};
}
function productEnv(){
 const file=process.env.FRAME_PRODUCT_CONFIG||join(localAppDataRoot,'Frame','product','config.json');
 if(!existsSync(file))return{FRAME_PRODUCT_ENABLED:'false'};
 const product=read(file);
 if(!product||product.version!==1)throw Error('Invalid local product configuration; no credentials were printed.');
 if(product.enabled!==true)return{FRAME_PRODUCT_ENABLED:'false'};
 if(!/^jdbc:postgresql:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9_]+$/.test(product.dbUrl)||!product.dbUsername||!product.dbPassword
   ||product.redisHost!=='127.0.0.1'||!Number.isInteger(product.redisPort)||product.redisPort<1024||product.redisPort>65535||!product.redisPassword
   ||!/^frame:[a-zA-Z0-9:_-]+$/.test(product.redisNamespace)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(product.publicOrigin)||product.cookieSecure!==false)
  throw Error('Product configuration must use this PC’s private database and Redis; no credentials were printed.');
 return{FRAME_PRODUCT_ENABLED:'true',FRAME_PRODUCT_DB_URL:product.dbUrl,FRAME_PRODUCT_DB_USERNAME:product.dbUsername,FRAME_PRODUCT_DB_PASSWORD:product.dbPassword,
  FRAME_PRODUCT_REDIS_HOST:product.redisHost,FRAME_PRODUCT_REDIS_PORT:String(product.redisPort),FRAME_PRODUCT_REDIS_PASSWORD:product.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE:product.redisNamespace,FRAME_PRODUCT_PUBLIC_ORIGIN:product.publicOrigin,FRAME_PRODUCT_COOKIE_SECURE:'false'};
}
function ensureProduct(){
 if(productEnv().FRAME_PRODUCT_ENABLED!=='true')return;
 const file=process.env.FRAME_PRODUCT_CONFIG||join(localAppDataRoot,'Frame','product','config.json');
 const docker=read(file)?.runtime==='docker';
 try{execFileSync(process.execPath,[join(ROOT,'server',docker?'product-docker.mjs':'product-local.mjs'),'start'],{
  cwd:ROOT,env:docker?{...process.env,FRAME_DOCKER_DIR:resolve(file,'..')}:process.env,windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:docker?180000:60000});}
 catch{throw Error(`The FRAME database or Redis is not ready. Run node server/${docker?'product-docker':'product-local'}.mjs status; no media process was stopped.`);}
}
function javaExecutable(){
 if(process.env.FRAME_JAVA){
  if(!existsSync(process.env.FRAME_JAVA))throw Error('FRAME_JAVA must point to an installed Java executable; no process was changed.');
  return process.env.FRAME_JAVA;
 }
 const configured=process.env.JAVA_HOME&&join(process.env.JAVA_HOME,'bin','java.exe');
 if(configured&&existsSync(configured))return configured;
 try{
  const found=execFileSync('where.exe',['java'],{windowsHide:true,stdio:['ignore','pipe','ignore']}).toString().trim().split(/\r?\n/)[0];
  if(found&&existsSync(found))return found;
 }catch{}
 throw Error('Java 21 is required. Set JAVA_HOME to its JDK folder or FRAME_JAVA to java.exe; no process was changed.');
}
function startApi(java,config){
 // A new build must not replace a JAR still being read lazily by the running JVM.
 const runtimeJar=join(DIR,`api-${Date.now()}-${randomBytes(3).toString('hex')}.jar`);
 copyFileSync(JAR,runtimeJar);
 return launch('spring',java,['-Xms64m','-Xmx256m',`-Dframe.obs.runtimeDir=${DIR}`,'-jar',runtimeJar],{
  RELAY_LISTEN_HOST:'127.0.0.1',RELAY_PORT:String(PORT.spring),RELAY_PUBLIC_BASE_URL:URL,RELAY_PUBLISHER_TOKENS:`${config.token} ${PATH}`,RELAY_PUBLISHER_TOKENS_FILE:'',
  RELAY_OBS_ENABLED:'true',RELAY_OBS_SERVER_URL:`rtmp://127.0.0.1:${PORT.rtmp}`,RELAY_HLS:'true',RELAY_DVR:'true',RELAY_HLS_AAC:'false',
  RELAY_MEDIAMTX_API:`http://127.0.0.1:${PORT.api}`,RELAY_MEDIAMTX_HLS:`http://127.0.0.1:${PORT.hls}`,RELAY_MEDIAMTX_WEBRTC:'http://127.0.0.1:18889',RELAY_MEDIAMTX_PLAYBACK:`http://127.0.0.1:${PORT.playback}`,RELAY_MEDIAMTX_RTSP:`rtsp://127.0.0.1:${PORT.rtsp}`,
  RELAY_RECORD_DIR:join(DIR,'recordings'),RELAY_FFMPEG:FFMPEG,RELAY_RENDITIONS:'',RELAY_UI_FILE:'',RELAY_STATS_DIR:'',...paymentEnv(),...productEnv(),PATH:BIN+';'+process.env.PATH});
}
function launch(name,file,args,values){
 const log=openSync(join(DIR,name+'.log'),'a');
 try{const child=spawn(file,args,{cwd:DIR,env:env(values),detached:true,windowsHide:true,stdio:['ignore',log,log]});child.on('error',()=>{});child.unref();return child.pid;}finally{closeSync(log);}
}
function stopOwned(state){
 // Command-line marker prevents killing a reused PID or another Java/MediaMTX process on this computer.
 for(const pid of[state?.spring,state?.mediamtx])if(owned(pid))try{execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
}
function mediaConfig(token){
 const hash='sha256:'+createHash('sha256').update(token).digest('base64');
 return[
  'logLevel: info','logDestinations: [stdout]','writeQueueSize: 1024','authMethod: internal','authInternalUsers:',
  '  - user: any','    pass:',"    ips: ['127.0.0.1', '::1']",'    permissions:','      - action: read','      - action: api','      - action: playback','      - action: publish',"        path: '~^obs-[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}/(src|(240|360|480|720|1080|1440)p|rec)$'",
  `  - user: ${PATH}`,`    pass: ${JSON.stringify(hash)}`,"    ips: ['127.0.0.1', '::1']",'    permissions:','      - action: publish',`        path: ${PATH}`,
  'api: true',`apiAddress: 127.0.0.1:${PORT.api}`,'apiTrustedProxies: []','metrics: false','pprof: false',
  'rtsp: true','rtspTransports: [tcp]','rtspEncryption: "no"',`rtspAddress: 127.0.0.1:${PORT.rtsp}`,
  'rtmp: true','rtmpEncryption: "no"',`rtmpAddress: 127.0.0.1:${PORT.rtmp}`,'rtmpTrustedProxies: []','srt: false','moq: false','webrtc: false',
  'hls: true',`hlsAddress: 127.0.0.1:${PORT.hls}`,'hlsEncryption: false','hlsAllowOrigins: []','hlsTrustedProxies: []','hlsVariant: lowLatency','hlsSegmentCount: 7','hlsSegmentDuration: 1s','hlsPartDuration: 200ms','hlsMuxerCloseAfter: 60s',
  'playback: true',`playbackAddress: 127.0.0.1:${PORT.playback}`,'playbackAllowOrigins: []',
  'pathDefaults:','  source: publisher','  overridePublisher: false','  record: false',
  'paths:',`  ${PATH}:`,
  `    runOnAvailable: ffmpeg -hide_banner -nostdin -loglevel warning -rtsp_transport tcp -i rtsp://127.0.0.1:${PORT.rtsp}/${PATH} -map 0:v:0 -map 0:a:0? -c copy -f rtsp -rtsp_transport tcp -pkt_size 1190 rtsp://127.0.0.1:${PORT.rtsp}/${PATH}/rec`,
  '    runOnAvailableRestart: true',`  ${PATH}/rec:`,'    record: true',`    recordPath: ${JSON.stringify(join(DIR,'recordings','%path','%Y-%m-%d_%H-%M-%S-%f%z').replaceAll('\\','/'))}`,
  '    recordFormat: fmp4','    recordPartDuration: 1s','    recordSegmentDuration: 60s','    recordDeleteAfter: 6h',
  "  '~^obs-[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}/(src|(240|360|480|720|1080|1440)p)$':",'    useAbsoluteTimestamp: true',''
 ].join('\n');
}

const command=process.argv[2]||'status';
if(!['start','status','stop','restart-api'].includes(command))throw Error('Usage: node server/obs-local.mjs start|status|stop|restart-api');
if(process.platform!=='win32')throw Error('This local launcher currently supports Windows only');
mkdirSync(DIR,{recursive:true});
const operation=command==='status'?null:operationLock();
try{
let state=read(STATE);
if(command==='stop'){
 operation.assert();
 stopOwned(state);write(STATE,{stoppedAt:new Date().toISOString()});console.log('Stopped the local OBS runtime owned by this launcher.');
}else if(command==='status'){
 const running=!!(owned(state?.spring)&&owned(state?.mediamtx)&&listenersMatch(state)&&await healthy());
 console.log(JSON.stringify({running,backendUrl:URL,serverUrl:`rtmp://127.0.0.1:${PORT.rtmp}`,configPath:CONFIG,ports:PORT},null,2));
 if(!running)process.exitCode=1;
}else if(command==='restart-api'){
 operation.assert();
 if(!owned(state?.mediamtx)||!listenersMatch(state,true))throw Error('The owned media receiver must be running; no process was changed.');
 const apiOwned=owned(state?.spring);
 if(!apiOwned&&(Number.isInteger(state?.spring)&&alive(state.spring)||!['api-starting','running'].includes(state?.phase)||!await free(PORT.spring)))
  throw Error('Cannot verify the API process owner or free port; no process was changed.');
 const config=read(CONFIG);
 if(config?.backendUrl!==URL||config?.path!==PATH||typeof config?.token!=='string'||!/^[a-f0-9]{64}$/.test(config.token)||!existsSync(JAR))throw Error('API restart configuration is incomplete.');
 productEnv();paymentEnv();ensureProduct();
 const java=javaExecutable();
 // Only the API is replaced. OBS input and the recording process owned by MediaMTX keep running.
 if(apiOwned)execFileSync('taskkill.exe',['/PID',String(state.spring),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 if(!await wait(()=>free(PORT.spring),5000))throw Error('The old API port did not close; the media receiver is still running.');
 state.phase='api-starting';state.spring=startApi(java,config);write(STATE,state);
 if(!await wait(async()=>owned(state.spring)&&listenersMatch(state)&&await healthy(),45000))throw Error('API did not become ready; the media receiver remains running. See its private local log.');
 state.phase='running';state.apiRestartedAt=new Date().toISOString();write(STATE,state);
 console.log(JSON.stringify({running:true,apiRestarted:true,mediaReceiverPreserved:true,backendUrl:URL,productEnabled:productEnv().FRAME_PRODUCT_ENABLED==='true'},null,2));
}else{
 if(owned(state?.spring)&&owned(state?.mediamtx)&&listenersMatch(state)&&await healthy()){
  console.log(JSON.stringify({running:true,alreadyRunning:true,configPath:CONFIG,backendUrl:URL},null,2));
 }else{
  if(owned(state?.spring)||owned(state?.mediamtx))throw Error('A partial local runtime is running. Run "node server/obs-local.mjs stop" first.');
  for(const file of[MTX,FFMPEG,JAR])if(!existsSync(file))throw Error('Missing runtime dependency: '+file);
  for(const port of Object.values(PORT))if(!await free(port))throw Error('Port '+port+' is already in use; no process was stopped.');
  let config=read(CONFIG);
  if(!config){config={version:1,backendUrl:URL,path:PATH,token:randomBytes(32).toString('hex')};write(CONFIG,config);}
  if(config.backendUrl!==URL||config.path!==PATH||typeof config.token!=='string'||!/^[a-f0-9]{64}$/.test(config.token))throw Error('Local studio config is invalid; it was not overwritten.');
  const java=javaExecutable();
  const mtxConfig=join(DIR,'mediamtx.yml');writeFileSync(mtxConfig,mediaConfig(config.token),{mode:0o600});
  paymentEnv();productEnv();ensureProduct();
  state={root:ROOT,marker:DIR,phase:'starting',startedAt:new Date().toISOString()};
  try{
   operation.assert();
   state.mediamtx=launch('mediamtx',MTX,[mtxConfig],{PATH:BIN+';'+process.env.PATH});write(STATE,state);
   if(!await wait(async()=>{try{return owned(state.mediamtx)&&listenersMatch(state,true)&&(await fetch(`http://127.0.0.1:${PORT.api}/v3/paths/list`,{signal:AbortSignal.timeout(1500)})).ok;}catch{return false;}},15000))throw Error('Local MediaMTX did not become ready with the expected process/listeners; see its local log.');
   operation.assert();
   state.spring=startApi(java,config);write(STATE,state);
   if(!await wait(async()=>owned(state.spring)&&owned(state.mediamtx)&&listenersMatch(state)&&await healthy(),30000))throw Error('Local Spring backend did not become ready with the expected process/listeners; see its local log.');
   const info=await fetch(URL+'/api/obs/'+PATH,{headers:{Authorization:'Bearer '+config.token},signal:AbortSignal.timeout(5000)});
   if(!info.ok)throw Error('Local publisher authorization check failed.');
   operation.assert();
   state.phase='running';write(STATE,state);
   console.log(JSON.stringify({running:true,configPath:CONFIG,backendUrl:URL,serverUrl:`rtmp://127.0.0.1:${PORT.rtmp}`,ports:PORT},null,2));
  }catch(error){stopOwned(state);write(STATE,{stoppedAt:new Date().toISOString()});throw error;}
 }
}
}finally{operation?.release();}
