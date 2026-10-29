import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url)),report=path.join(root,'verification/full-review');
const read=async name=>JSON.parse(await readFile(path.join(report,name+'.json'),'utf8'));
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const manifest=JSON.parse(await readFile(path.join(root,'design-manifest.json'),'utf8'));
const modules=(await readdir(path.join(root,'dist'))).filter(name=>/^design-v33-.*\.js$/.test(name));
for(const name of modules){const r=spawnSync(process.execPath,['--check',path.join(root,'dist',name)],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);}
const baseline=JSON.parse(await readFile(path.join(root,'PLAYER_PRESERVATION.json'),'utf8'));
const originals=await Promise.all(baseline.files.map(async row=>({file:row.file,unchanged:await hash(path.resolve(root,'../..',row.file))===row.sha256})));
const protectedFiles=await Promise.all(['preserved-player.js','preserved-player.css','preserved-player-data.js','design-data.js'].map(async name=>({file:name,unchanged:await hash(path.join(root,'dist',name))===await hash(path.join(root,'archive-before-full-review-2026-10-29',name))})));
if([...originals,...protectedFiles].some(row=>!row.unchanged))throw new Error('Protected source changed; retain its original baseline.');
const captures=await read('captures'),responsive=await read('responsive-checks'),viewer=await read('viewer-browser-flows'),extra=await read('viewer-extra-checks'),management=await read('management-browser-flows'),engagement=await read('engagement-browser-flows'),account=await read('account-studio-browser-flows'),scope=await read('feature-scope-audit');
const stateCount=manifest.screens.reduce((n,screen)=>n+screen.states.length,0);
const missing=[];for(const screen of manifest.screens)for(let i=0;i<screen.states.length;i++)for(const device of ['desktop','mobile']){const row=captures.find(row=>row.screen===screen.id&&row.stateIndex===i&&row.device===device);if(!row)missing.push(`${screen.id}:${i}:${device}`);else{await readFile(path.join(report,'screens',row.name+'.jpg'));if(row.bottomName)await readFile(path.join(report,'screens',row.bottomName+'.jpg'));}}
const issues=[...responsive.filter(row=>row.error||row.overflow>2||row.dialogOverflow>2||row.anonymous?.length||row.unlabeled?.length||row.duplicateIds?.length),...viewer.filter(row=>!row.ok),...extra.filter(row=>!row.ok),...management.checks.filter(row=>row.pass===false),...engagement.checks.filter(row=>row.passed===false)];
if(missing.length||issues.length||account.passedScreenGroups!==13)throw new Error(JSON.stringify({missing,issues,account:account.passedScreenGroups}));
const files=(await readdir(path.join(root,'dist'))).filter(name=>name.startsWith('design-v33-')||name==='index.html');
const sources=await Promise.all(files.map(async name=>({file:name,sha256:await hash(path.join(root,'dist',name))})));
const visualReports=['viewer','account-studio','engagement','management'].map(name=>`visual-review-${name}.json`);
for(const name of visualReports)await readFile(path.join(report,name));
const summary={version:'3.3',date:'2026-10-29',screenCount:manifest.screens.length,stateCount,featureCount:manifest.features.length,capturePairs:captures.length,viewportChecks:responsive.length,flowEvidence:{viewerChecks:viewer.length+extra.length,engagementChecks:engagement.checks.length,managementChecks:management.checks.length,accountStudioScreenFlows:account.passedScreenGroups},scopeClassification:scope.counts,missingCaptureStates:missing,issues,visualReports,originals,protectedFiles,sources,limitations:['Source-to-definition audit of 150 features is distinct from implementation completion.','Primary screen images and selected exception images were inspected; not every state image was independently inspected pixel by pixel.','Some keyboard checks use DOM key events; physical devices and actual backend/media/finance/authentication remain untested.','35 features need additional detailed UI design; 60 center on real technical validation.']};
await writeFile(path.join(report,'summary.json'),JSON.stringify(summary,null,2));
const build=spawnSync(process.execPath,[path.join(root,'build-full-review.mjs')],{encoding:'utf8'});if(build.status)throw new Error(build.stderr);
console.log(JSON.stringify({version:summary.version,screens:summary.screenCount,states:stateCount,features:summary.featureCount,captures:captures.length,viewportChecks:responsive.length,flowEvidence:summary.flowEvidence,issues:issues.length,protected:true}));
