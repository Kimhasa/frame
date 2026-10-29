import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),dir=path.join(root,'verification/broadcaster-review');
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const baseline=JSON.parse(await fs.readFile(path.join(root,'PLAYER_PRESERVATION.json'),'utf8'));
const protectedFiles=[];
for(const row of baseline.files)protectedFiles.push({file:row.file,unchanged:await hash(path.resolve(root,'../..',row.file))===row.sha256});
for(const file of ['preserved-player.js','preserved-player.css','preserved-player-data.js','design-data.js'])protectedFiles.push({file:'dist/'+file,unchanged:await hash(path.join(root,'dist',file))===await hash(path.join(root,'archive-before-full-review-2026-10-29',file))});
if(protectedFiles.some(row=>!row.unchanged))throw new Error('Protected files changed; do not replace baseline.');
const sourceHashes=[];
for(const file of (await fs.readdir(path.join(root,'dist'))).filter(name=>/^design-v36-.*\.(js|css)$/.test(name))){
 if(file.endsWith('.js')){const result=spawnSync(process.execPath,['--check',path.join(root,'dist',file)],{encoding:'utf8'});if(result.status)throw new Error(result.stderr);}
 sourceHashes.push({file,sha256:await hash(path.join(root,'dist',file))});
}
const layout=[];
for(const width of [320,390,820,1440,1920])layout.push(...JSON.parse(await fs.readFile(path.join(dir,'layout-'+width+'.json'),'utf8')));
const issues=layout.filter(row=>row.overflow>1||row.dialogOverflow>1||row.outside||row.duplicateIds.length);
if(issues.length)throw new Error(JSON.stringify(issues));
const flows=[];
for(const file of ['source-flows.json','settings-flows.json','info-flows.json']){
 const data=JSON.parse(await fs.readFile(path.join(dir,file),'utf8')),checks=data.checks||data.tests;
 if(!Array.isArray(checks)||!checks.length)throw new Error('Missing browser checks '+file);
 if(checks.some(row=>(row.passed??row.pass)!==true))throw new Error('Failed browser check '+file);
 flows.push({file,count:checks.length});
}
const summary={version:'3.6',date:'2026-10-29',research:{chzzkCaptures:16,twitchCaptures:24,broadcasterAccess:'Accessible actual logged-in offline consoles; no live broadcasting/remote settings changes performed.'},layouts:{states:150,widths:[320,390,820,1440,1920],checks:layout.length,issues},browserFlows:flows,flowChecks:flows.reduce((n,row)=>n+row.count,0),protectedFiles,sourceHashes,limits:['Local UI fixtures only.','No native capture, encoder, remote delivery or real live-stream verification.','Private account/credential research excluded from dist.']};
const board=JSON.parse(await fs.readFile(path.join(dir,'board-manifest.json'),'utf8'));
const urls=['broadcaster-review.html',...board.prototype.map(file=>'assets/broadcaster-review/'+file),...board.safeReferences.map(file=>'assets/broadcaster-review/twitch-'+file)];
summary.http=await Promise.all(urls.map(async relative=>{const response=await fetch('http://127.0.0.1:5328/'+relative);await response.arrayBuffer();return{path:relative,status:response.status};}));
if(summary.http.some(row=>row.status!==200))throw new Error('Board asset request failed.');
await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
if(process.argv[2]){
 const out=path.resolve(process.argv[2]);await fs.mkdir(out,{recursive:true});
 await fs.cp(dir,path.join(out,'verification'),{recursive:true});
 for(const file of ['BROADCASTER_REVIEW.txt','CLAUDE_DESIGN_HANDOFF_V36.txt'])await fs.copyFile(path.join(root,file),path.join(out,file));
}
console.log(JSON.stringify({layouts:layout.length,browserFlows:summary.flowChecks,protectedFilesUnchanged:protectedFiles.length}));
