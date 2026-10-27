import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const lock=JSON.parse(await readFile(resolve(root,'UI_V05_LOCK.json'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex'),issues=[];
for(const entry of [...lock.referenceFiles,...lock.lockedSources]){
  try{if(hash(await readFile(resolve(root,entry.path)))!==entry.sha256)issues.push('Changed UI reference/source: '+entry.path);}catch{issues.push('Missing UI reference/source: '+entry.path);}
}
const html=await readFile(resolve(root,process.argv[2]||'outputs/index.html'),'utf8');
const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
if(hash(markup)!==lock.markupSha256)issues.push('UI 0.5 static markup, styles or SVG changed');
if(/<select\b|<h1\b|id="(?:sender-status|viewer-status)"/i.test(markup))issues.push('Native select, large title or adjacent status badge returned');
const ids=[...markup.matchAll(/\bid="([^"]+)"/g)].map(item=>item[1]);
if(new Set(ids).size!==ids.length)issues.push('Duplicate IDs');
for(const id of lock.controlIds)if(!ids.includes(id))issues.push('Missing control: '+id);
if(/<link\b[^>]*\bhref=["']https?:|<script\b[^>]*\bsrc=["']https?:/i.test(html))issues.push('External UI dependency');
if(/review-fixture|review\/fixture|review-broadcast|review-chat-/.test(html))issues.push('Visual review fixtures entered the production UI');
if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}
else console.log('UI 0.5 passed; 0.4 references preserved. Functional JS, native execution and real LAN streaming require their own validation.');
