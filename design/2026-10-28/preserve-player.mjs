import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const project=path.resolve(root,'../..');
const dist=path.join(root,'dist');
const snapshot=path.join(root,'preserved-player');
fs.mkdirSync(snapshot,{recursive:true});
const files=['work/console-template.html','work/console.css','work/ux.css','work/components.css','work/console-ui.css','work/player-ui.css','work/mobile-ui.css','work/console-ux.js'];
const hashes=files.map(file=>{const bytes=fs.readFileSync(path.join(project,file));fs.writeFileSync(path.join(snapshot,path.basename(file)),bytes);return{file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
const html=fs.readFileSync(path.join(project,'work/console-template.html'),'utf8');
const start=html.indexOf('<div class="player-controls"');
const end=html.indexOf('<div class="player-quality-menu"',start);
if(start<0||end<0)throw new Error('Original player markup not found');
const controls=html.slice(start,end);
const built=fs.readFileSync(path.join(project,'outputs/index.html'),'utf8');
const symbols=[...built.matchAll(/<symbol\b[^>]*id="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g)].map(m=>({id:m[1],markup:m[0].replaceAll('id="i-','id="locked-i-')}));
if(!symbols.length)throw new Error('Original icon symbols not found');
const classNames=['player-controls','player-toolbar','player-button','player-volume','player-spacer','live-button','live-dot','timeline','timeline-times','player-quality-menu','quality-menu-title','quality-menu-option','quality-option-copy','pause-overlay','control-label'];
const rules=[];
for(const file of ['ux.css','components.css','console-ui.css']){
 for(const line of fs.readFileSync(path.join(project,'work',file),'utf8').split(/\r?\n/)){
  if(!line.includes('{')||!line.includes('}'))continue;
  if(!classNames.some(name=>line.includes('.'+name)))continue;
  if(line.trim().startsWith('@media')&&file!=='components.css')continue;
  let adapted=line.replaceAll('#viewer-stage ','.preserved-player ').replaceAll('#player-settings','#locked-player-settings');
  for(const cls of [...classNames].sort((a,b)=>b.length-a.length))adapted=adapted.replace(new RegExp('\\.'+cls+'(?![\\w-])','g'),'.locked-'+cls);
  if(adapted.startsWith('@media'))adapted=adapted.replace('@media','@container');
  rules.push(adapted);
 }
}
fs.writeFileSync(path.join(dist,'preserved-player.css'),'/* Read-only visual adapter of the existing player. Original source files are preserved separately; no encoder or media code is imported. */\n'+rules.join('\n')+'\n.preserved-player .locked-player-controls{opacity:0;pointer-events:none;transition:opacity .18s ease}.preserved-player.show-controls .locked-player-controls,.preserved-player:focus-within .locked-player-controls,.preserved-player.is-paused .locked-player-controls,.preserved-player.menu-open .locked-player-controls{opacity:1;pointer-events:auto}.preserved-player .locked-player-quality-menu{z-index:8}.preserved-player .locked-player-quality-menu[hidden]{display:none}.preserved-player .locked-player-controls input[type=range]{min-height:18px}.preserved-player .locked-player-volume input[type=range]{width:78px}.preserved-player .locked-player-toolbar{flex-wrap:nowrap}.preserved-player .locked-player-button{white-space:nowrap}@container(max-width:600px){.preserved-player .locked-player-toolbar{gap:2px}.preserved-player .locked-player-volume input[type=range]{width:45px}.preserved-player .locked-player-controls{padding:25px 6px 7px}.preserved-player .locked-control-label{display:none}}\n');
fs.appendFileSync(path.join(dist,'preserved-player.css'),'\n.preserved-player .locked-player-controls svg,.preserved-player .locked-player-quality-menu svg,.preserved-player .locked-pause-overlay svg{display:block;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}\n');
fs.writeFileSync(path.join(dist,'preserved-player-data.js'),'window.FRAME_PRESERVED_PLAYER = '+JSON.stringify({controls,symbols,classNames,sourceFiles:hashes})+';\n');
fs.writeFileSync(path.join(root,'PLAYER_PRESERVATION.json'),JSON.stringify({date:'2026-10-28',instruction:'Existing player, quality menu, timeline, audio controls, capture and encoder behavior must be reused unchanged. Local prototype uses read-only markup/CSS adapters; it is not a replacement media implementation.',files:hashes},null,2));
console.log(JSON.stringify({protectedFiles:hashes.length,icons:symbols.length,controlMarkupBytes:Buffer.byteLength(controls),copiedCssRules:rules.length}));
