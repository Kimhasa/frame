// Prepare the current review board without rebuilding or replacing the frozen player.
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),report=path.join(root,'verification/v31');
const core=['home','login','settings-profile','settings-notifications','channel-management','channel-branding','studio-ready','studio-live','watch','donation','home-mobile','login-mobile','channel-mobile','studio-mobile','watch-mobile'];
const states=['search-empty','live-loading','live-error','following-empty','channel-tabs','viewer-info'];
for(const [folder,names] of [['v3',core],['v31',states]]){
  const target=path.join(root,'dist/assets',folder);await mkdir(target,{recursive:true});
  for(const name of names)await copyFile(path.join(report,'screens',name+'.jpg'),path.join(target,name+'.jpg'));
}
const modules=(await readdir(path.join(root,'dist'))).filter(file=>/^design-v3(?:1)?-.*\.js$/.test(file));
for(const file of [...modules,'design-events.js']){const r=spawnSync(process.execPath,['--check',path.join(root,'dist',file)],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);}
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const baseline=JSON.parse(await readFile(path.join(root,'PLAYER_PRESERVATION.json'),'utf8'));
const originalChecks=await Promise.all(baseline.files.map(async file=>({file:file.file,matched:await hash(path.resolve(root,'../..',file.file))===file.sha256})));
const protectedChecks=await Promise.all(['preserved-player.js','preserved-player.css','preserved-player-data.js'].map(async file=>({file,unchanged:await hash(path.join(root,'dist',file))===await hash(path.join(root,'archive-v3-2026-10-29',file))})));
await writeFile(path.join(report,'player-source-check.json'),JSON.stringify(originalChecks,null,2));
await writeFile(path.join(report,'preserved-module-check.json'),JSON.stringify(protectedChecks,null,2));
if(originalChecks.some(r=>!r.matched)||protectedChecks.some(r=>!r.unchanged))throw new Error('Protected source differs. Do not replace or update its baseline.');
const read=async name=>JSON.parse(await readFile(path.join(report,name+'.json'),'utf8'));
const responsive=await read('responsive-checks'),allStates=await read('all-state-checks'),functional=await read('functional-checks'),layout=await read('layout-consistency'),edge=await read('edge-checks'),player=await read('player-interaction-check'),events=await read('browser-events'),captures=await read('capture-manifest');
const issues=[...responsive.filter(r=>r.overflow>2||r.scopeOverflow>2||r.spill.length),...allStates.filter(r=>r.error||r.rootOverflow>2||r.scopeOverflow>2),...functional.filter(r=>!r.ok)];
const summary={version:'3.1',date:'2026-10-29',artboards:core.length+states.length,captures:captures.length,syntaxModules:modules,responsiveChecks:responsive.length,stateChecks:allStates.length,functionalChecks:functional.length,issues,layout,edge,player,browserEvents:events.events,originalChecks,protectedChecks,scope:'Local UI prototype. Browser viewport and render checks; no physical mobile-device, authentication, payment, capture, encoder, streaming or load validation.'};
await writeFile(path.join(report,'summary.json'),JSON.stringify(summary,null,2));
if(issues.length||!layout.shortWindow.visible||!player.pause||!player.originalQualityMenu)throw new Error('Review validation has unresolved issues.');
const build=spawnSync(process.execPath,[path.join(root,'build-board-v3.mjs')],{encoding:'utf8'});if(build.status)throw new Error(build.stderr);
console.log(JSON.stringify({version:summary.version,artboards:summary.artboards,captures:summary.captures,responsiveChecks:summary.responsiveChecks,stateChecks:summary.stateChecks,functionalChecks:summary.functionalChecks,issues:issues.length,protectedOriginals:originalChecks.every(r=>r.matched),protectedPlayer:protectedChecks.every(r=>r.unchanged)}));
