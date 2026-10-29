// v3 is edited directly in dist/design-v3-*; keep the earlier builders as archives.
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const target=path.join(root,'dist/assets/v3');
await mkdir(target,{recursive:true});
const screenshots=(await readdir(path.join(root,'verification/v3/screens'))).filter(n=>n.endsWith('.jpg'));
for(const name of screenshots)await copyFile(path.join(root,'verification/v3/screens',name),path.join(target,name));
const files=(await readdir(path.join(root,'dist'))).filter(n=>/^design-v3-.*\.js$/.test(n));
for(const file of files){const r=spawnSync(process.execPath,['--check',path.join(root,'dist',file)],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);}
const expected=['home','login','settings-profile','settings-notifications','channel-management','channel-branding','studio-ready','studio-live','watch','donation','home-mobile','login-mobile','channel-mobile','studio-mobile','watch-mobile'];
for(const name of expected)if(!screenshots.includes(name+'.jpg'))throw new Error('Missing screenshot: '+name);
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const originals=JSON.parse(await readFile(path.join(root,'PLAYER_PRESERVATION.json'),'utf8'));
const sourceRoot=path.resolve(root,'../..');
const originalChecks=await Promise.all(originals.files.map(async f=>({file:f.file,matched:await hash(path.join(sourceRoot,f.file))===f.sha256})));
const protectedChecks=await Promise.all(['preserved-player.js','preserved-player.css','preserved-player-data.js'].map(async file=>({file,unchanged:await hash(path.join(root,'dist',file))===await hash(path.join(root,'archive-v2-2026-10-29',file))})));
if(originalChecks.some(x=>!x.matched)||protectedChecks.some(x=>!x.unchanged))throw new Error('Protected source differs; do not overwrite the baseline.');
const responsive=JSON.parse(await readFile(path.join(root,'verification/v3/responsive-checks.json'),'utf8'));
const states=JSON.parse(await readFile(path.join(root,'verification/v3/all-state-checks.json'),'utf8'));
const functional=JSON.parse(await readFile(path.join(root,'verification/v3/functional-checks.json'),'utf8'));
const summary={version:'3.0',date:'2026-10-29',screenshots:screenshots.length,coreArtboards:expected.length,syntaxChecked:files,originalChecks,protectedChecks,responsiveChecks:responsive.length,responsiveIssues:responsive.filter(x=>x.rootOverflow>2||x.scopeOverflow>2||x.controls.length),stateChecks:states.length,stateIssues:states.filter(x=>x.error||x.rootOverflow>2||x.scopeOverflow>2),functionalChecks:functional,scope:'Local design prototype only. No authentication, payment, streaming, capture, encoder or production application changes.'};
await writeFile(path.join(root,'verification/v3/summary.json'),JSON.stringify(summary,null,2));
const board=spawnSync(process.execPath,[path.join(root,'build-board-v3.mjs')],{encoding:'utf8'});if(board.status)throw new Error(board.stderr);
console.log(JSON.stringify({artboards:expected.length,screenshots:screenshots.length,responsive:responsive.length,states:states.length,issues:summary.responsiveIssues.length+summary.stateIssues.length,protectedOriginals:originalChecks.every(x=>x.matched),protectedModules:protectedChecks.every(x=>x.unchanged)}));
