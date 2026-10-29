import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),report=path.join(root,'verification/v32');
const target=path.join(root,'dist/assets/v32');await mkdir(target,{recursive:true});
const captures=JSON.parse(await readFile(path.join(report,'capture-manifest.json'),'utf8'));
for(const row of captures)await copyFile(path.join(report,'screens',row.name+'.jpg'),path.join(target,row.name+'.jpg'));
for(const file of ['settings-profile.jpg','settings-notifications.jpg'])await copyFile(path.join(target,file),path.join(root,'dist/assets/v3',file));
const modules=(await readdir(path.join(root,'dist'))).filter(file=>/^design-v32-.*\.js$/.test(file));
for(const file of modules){const result=spawnSync(process.execPath,['--check',path.join(root,'dist',file)],{encoding:'utf8'});if(result.status)throw new Error(result.stderr);}
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const originals=JSON.parse(await readFile(path.join(root,'PLAYER_PRESERVATION.json'),'utf8'));
const originalChecks=await Promise.all(originals.files.map(async f=>({file:f.file,unchanged:await hash(path.resolve(root,'../..',f.file))===f.sha256})));
const protectedChecks=await Promise.all(['preserved-player.js','preserved-player.css','preserved-player-data.js','design-data.js'].map(async file=>({file,unchanged:await hash(path.join(root,'dist',file))===await hash(path.join(root,'archive-v31-2026-10-29',file))})));
await writeFile(path.join(report,'preservation-checks.json'),JSON.stringify({originalChecks,protectedChecks},null,2));
if([...originalChecks,...protectedChecks].some(r=>!r.unchanged))throw new Error('A protected source changed. Preserve the baseline.');
const read=async name=>JSON.parse(await readFile(path.join(report,name+'.json'),'utf8'));
const responsive=await read('responsive-checks'),profile=await read('profile-layout-check'),functional=await read('functional-checks'),states=await read('all-state-checks'),navigation=await read('navigation-checks'),modalHistory=await read('modal-history-check'),events=await read('browser-events');
const issues=[...responsive.filter(r=>r.overflow>2||r.scopeOverflow>2||r.spill.length||!r.activeVisible||!r.transparent),...profile.filter(r=>r.overflow>2||r.spill.length),...functional.filter(r=>!r.ok),...states.filter(r=>r.error||r.overflow>2||r.scopeOverflow>2)];
if(issues.length)throw new Error('Settings review has unresolved validation issues.');
for(const build of ['build-settings-board.mjs','build-board-v3.mjs']){const result=spawnSync(process.execPath,[path.join(root,build)],{encoding:'utf8'});if(result.status)throw new Error(result.stderr);}
const summary={version:'3.2',date:'2026-10-29',settingsSections:5,focusedArtboards:10,captures:captures.length,syntaxModules:modules,responsiveChecks:responsive.length,profileLayoutChecks:profile.length,functionalChecks:functional.length,stateRenderChecks:states.length,issues,navigation,modalHistory,browserEvents:events.events,originalChecks,protectedChecks,scope:'Local UI prototype. No actual OAuth, email change, remote session revocation, browser permission request, streaming or media-quality changes. Viewport tests are browser-based.'};
await writeFile(path.join(report,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({version:summary.version,settings:summary.settingsSections,artboards:summary.focusedArtboards,captures:summary.captures,responsiveChecks:summary.responsiveChecks,functionalChecks:summary.functionalChecks,stateRenderChecks:summary.stateRenderChecks,issues:issues.length,protected:summary.originalChecks.every(r=>r.unchanged)&&summary.protectedChecks.every(r=>r.unchanged)}));
