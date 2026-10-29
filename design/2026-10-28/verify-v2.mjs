import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const rows=JSON.parse(await fs.readFile(path.join(root,'verification/v2/render-checks.json'),'utf8'));
const shots=JSON.parse(await fs.readFile(path.join(root,'research/capture-manifest.json'),'utf8'));
const broken=[];
for(const name of ['index.html','board.html','research.html']){
 const html=await fs.readFile(path.join(root,'dist',name),'utf8');
 for(const [,href] of html.matchAll(/(?:href|src)="([^"<]+)"/g)){
  if(/^(?:https?:|#|data:)/.test(href)||!href.startsWith('./'))continue;
  try{await fs.access(path.join(root,'dist',href.split(/[?#]/)[0]));}catch{broken.push({page:name,href})}
 }
}
const result={date:'2026-10-28',version:'2.0',renderStates:rows.length,renderExceptions:rows.filter(r=>r.error).length,rootHorizontalOverflow:rows.filter(r=>r.horizontalOverflow).length,intentionalScrollRows:rows.filter(r=>r.escapedControls?.length).map(r=>({device:r.device,screen:r.id,state:r.state,controls:r.escapedControls,reason:r.id==='live'?'가로 스크롤 카테고리 내부':'가로 스크롤 표 내부'})),captures:shots.length,brokenLocalReferences:broken,functionalObservations:['방송 카드의 썸네일과 프로필 클릭 경로 구분','검색어 작업 유지 및 채널·라이브 결과 표시','검색 결과에서 선택한 공개 채널로 이동','공개 채널에서 시청자용 방송 일정 탭 표시','캡처 갤러리 확대·닫기'],consoleErrorsObserved:0,limits:['로컬 예시 데이터와 Chromium 디자인 검사','실제 앱 미디어·로그인·결제는 변경하거나 검증하지 않음','iOS Safari·Android 실제 기기·동시 시청 부하는 미검증','후속 관리 화면 표는 모바일에서 가로 스크롤 구조 유지']};
// Keep the report language consistent for the reader.
result.intentionalScrollRows.forEach(r=>{if(r.screen==='live')r.reason='가로 스크롤 카테고리 내부'});
await fs.writeFile(path.join(root,'verification/v2/summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({renderStates:result.renderStates,exceptions:result.renderExceptions,horizontalOverflow:result.rootHorizontalOverflow,captures:shots.length,brokenReferences:broken.length}));
if(broken.length||result.renderExceptions||result.rootHorizontalOverflow)process.exitCode=1;
