import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=path.dirname(fileURLToPath(import.meta.url));
const report=path.join(root,'verification/v32-detail');
const read=async name=>JSON.parse(await readFile(path.join(report,name+'.json'),'utf8'));
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const changed=['design-v31-layout.js','design-v31-layout.css','design-v31-states.js','design-v32-settings.js','design-v32-settings.css'];
for(const name of changed.filter(name=>name.endsWith('.js'))){
  const result=spawnSync(process.execPath,['--check',path.join(root,'dist',name)],{encoding:'utf8'});
  if(result.status)throw new Error(result.stderr);
}
const baseline=JSON.parse(await readFile(path.join(root,'PLAYER_PRESERVATION.json'),'utf8'));
const originals=await Promise.all(baseline.files.map(async file=>({file:file.file,unchanged:await hash(path.resolve(root,'../..',file.file))===file.sha256})));
const protectedFiles=await Promise.all(['preserved-player.js','preserved-player.css','preserved-player-data.js','design-data.js'].map(async file=>({file,unchanged:await hash(path.join(root,'dist',file))===await hash(path.join(root,'archive-v32-before-detail-2026-10-29',file))})));
if([...originals,...protectedFiles].some(file=>!file.unchanged))throw new Error('Protected source differs from its retained baseline.');
const captures=await read('capture-manifest'),responsive=await read('responsive-checks'),functional=await read('functional-checks'),states=await read('all-state-checks'),events=await read('browser-events');
const issues=[...responsive.filter(row=>row.error||row.overflow>2||row.spill.length||!row.activeVisible||!row.rowsTouch),...functional.filter(row=>!row.ok),...states.filter(row=>row.error||row.overflow>2),...events.events];
if(issues.length)throw new Error('Unresolved design validation issues.');
const general=new Set(['channel-management','channel-branding','login','studio-ready','login-mobile','channel-mobile','studio-mobile']);
for(const row of captures){
  if(!row.name.startsWith('settings-')&&!general.has(row.name))continue;
  const destination=path.join(root,'dist/assets',row.name.startsWith('settings-')?'v32':'v3');
  await mkdir(destination,{recursive:true});
  await copyFile(path.join(report,'screens',row.name+'.jpg'),path.join(destination,row.name+'.jpg'));
}
for(const name of ['settings-profile','settings-notifications'])await copyFile(path.join(report,'screens',name+'.jpg'),path.join(root,'dist/assets/v3',name+'.jpg'));
for(const build of ['build-settings-board.mjs','build-board-v3.mjs']){
  const result=spawnSync(process.execPath,[path.join(root,build)],{encoding:'utf8'});
  if(result.status)throw new Error(result.stderr);
}
const sourceChanges=await Promise.all(changed.map(async file=>({file,before:await hash(path.join(root,'archive-v32-before-detail-2026-10-29',file)),after:await hash(path.join(root,'dist',file))})));
const summary={version:'3.2-detail',date:'2026-10-29',captures:captures.length,responsiveChecks:responsive.length,functionalChecks:functional.length,stateRenderChecks:states.length,issues,originals,protectedFiles,sourceChanges,scope:'Local design prototype; no actual account, security, streaming or quality implementation. Responsive QA used browser viewport emulation.'};
await writeFile(path.join(report,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({version:summary.version,captures:captures.length,responsiveChecks:responsive.length,functionalChecks:functional.length,stateChecks:states.length,issues:issues.length,protected:true}));
