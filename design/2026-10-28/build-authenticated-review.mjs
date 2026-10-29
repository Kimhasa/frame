import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),research=path.join(root,'research/logged-in-2026-10-29');
const chzzk=JSON.parse(await fs.readFile(path.join(research,'chzzk/manifest.json'),'utf8'));
const twitch=JSON.parse(await fs.readFile(path.join(research,'twitch/manifest.json'),'utf8'));
const asset=path.join(root,'dist/assets/authenticated-review');await fs.mkdir(asset,{recursive:true});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const prototype=[
  ['metadata-desktop.jpg','조회수와 날짜','조회수 1,284회 · 2일 전','channel'],
  ['navigation-desktop.jpg','부모와 하위 메뉴','페이지 이동과 접기 버튼을 구분','integrations'],
  ['navigation-mobile.jpg','모바일 하위 이동','현재 그룹 안에서 화면 전환','integrations'],
  ['channel-editor-desktop.jpg','소셜 링크 편집','제목·URL, 추가·삭제·저장','channel-edit'],
  ['channel-editor-mobile-bottom.jpg','모바일 링크와 저장','입력과 저장 영역 가림 확인','channel-edit'],
  ['channel-public-desktop.jpg','공개 채널 반영','저장된 소개와 링크 사용','channel'],
  ['studio-desktop.jpg','방송 준비','화면·방송 정보·채팅의 기존 흐름','studio'],
  ['broadcast-settings-desktop.jpg','방송 설정','기존 영상·오디오·녹화 제어 유지','broadcast-settings']
];
for(const [file]of prototype){
 const current={'studio-desktop.jpg':'studio-desktop.jpg','broadcast-settings-desktop.jpg':'settings-video-desktop.jpg'}[file];
 const candidate=current?path.join(root,'verification/broadcaster-review',current):null;
 const source=candidate&&await fs.access(candidate).then(()=>true,()=>false)?candidate:path.join(root,'verification/authenticated-review',file);
 await fs.copyFile(source,path.join(asset,file));
}
const reference=[];
for(const file of chzzk.publicDisplayCandidateFiles){
  const row=chzzk.screenshots.find(x=>x.file===file);if(row?.sensitivity!=='public-reference')throw new Error('Private CHZZK reference rejected: '+file);
  const target='chzzk-'+file;await fs.copyFile(path.join(research,'chzzk',file),path.join(asset,target));reference.push({file:target,platform:'CHZZK',title:row.notes,url:row.url});
}
for(const row of twitch.screens.filter(x=>x.privacy==='public-ui-reference')){
  const target='twitch-'+row.file;await fs.copyFile(path.join(research,'twitch',row.file),path.join(asset,target));reference.push({file:target,platform:'Twitch',title:row.section||row.note,url:row.url});
}
const index=['로그인 조사 원본 인덱스 · 2026-10-29','치지직 53장 / Twitch 19장. 캡처 수는 고유 메뉴 검증 수가 아닙니다.','개인 계정 원본은 로컬 연구 폴더에만 있으며 dist 또는 배포물에 포함하지 않습니다.',''];
for(const [name,m,rows]of [['chzzk',chzzk,chzzk.screenshots],['twitch',twitch,twitch.screens]]){index.push(name);for(const row of rows)index.push(`${row.file} | ${row.sensitivity||row.privacy} | ${row.notes||row.section||''}`);index.push('');}
await fs.writeFile(path.join(research,'CAPTURE_INDEX.txt'),index.join('\n'));
await fs.copyFile(path.join(root,'AUTHENTICATED_REVIEW.txt'),path.join(root,'dist/authenticated-review.txt'));
const rows=items=>items.map(([a,b,c])=>`<tr><th>${esc(a)}</th><td>${esc(b)}</td><td>${esc(c)}</td></tr>`).join('');
const table=items=>`<div class="table-wrap"><table><thead><tr><th>영역</th><th>확인한 내용</th><th>범위</th></tr></thead><tbody>${rows(items)}</tbody></table></div>`;
const shots=prototype.map(([file,title,copy,screen])=>`<figure><a href="./assets/authenticated-review/${file}" target="_blank"><img loading="lazy" src="./assets/authenticated-review/${file}" alt="${esc(title)}"></a><figcaption><strong>${title}</strong><p>${copy}</p><a href="./index.html?screen=${screen}&device=${file.includes('mobile')?'mobile':'desktop'}">실행 시안 →</a></figcaption></figure>`).join('');
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FRAME · 로그인 레퍼런스와 최신 시안</title><style>
@font-face{font-family:Pretendard;src:url('./assets/PretendardVariable.woff2') format('woff2');font-weight:100 900;font-display:swap}*{box-sizing:border-box}body{margin:0;font:15px/1.65 Pretendard,sans-serif;color:#20282d;background:#f6f8f7}a{color:#23724f;text-decoration:none}header{background:#fff;padding:20px max(24px,calc((100vw - 1376px)/2));display:flex;align-items:center;gap:22px;flex-wrap:wrap}header strong{font-size:20px}header nav{margin-left:auto;display:flex;gap:22px;flex-wrap:wrap}main{max-width:1424px;padding:36px 24px 70px;margin:auto}h1{font-size:31px;letter-spacing:-1px;line-height:1.4;margin:0 0 12px}h2{font-size:23px;margin:0 0 12px;letter-spacing:-.5px}p{margin:6px 0;color:#66746c}section{margin-top:42px}.intro{max-width:1000px}.count{display:flex;gap:28px;flex-wrap:wrap;margin-top:24px;font-size:14px}.count strong{font-size:24px;color:#244f3a;margin-right:8px}.shots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}figure{margin:0;min-width:0;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 0 #e5ebe7}figure>a{display:block;aspect-ratio:1.44;background:#e9eeeb;overflow:hidden}figure img{display:block;width:100%;height:100%;object-fit:contain}figcaption{padding:16px 20px 20px}figcaption strong{font-size:17px}figcaption p{font-size:14px;margin:6px 0 12px}.table-wrap{overflow:auto;background:#fff;border-radius:10px}table{border-collapse:collapse;width:100%;font-size:14px;min-width:650px;text-align:left}th,td{padding:15px 18px;vertical-align:top;border-bottom:1px solid #edf1ee}thead th{font-weight:600;color:#67766d;background:#edf3ef}tbody th{width:160px;font-weight:600}td:last-child{width:230px;color:#6b796f}details{background:#fff;border-radius:10px;margin-top:12px;padding:17px 20px}summary{cursor:pointer;font-weight:650;list-style:none}summary::after{content:'＋';float:right;color:#718178}details[open]>summary::after{content:'−'}summary::-webkit-details-marker{display:none}details .table-wrap{margin-top:16px}.notice{padding:20px 24px;background:#eef4f0;border-radius:10px;margin-top:24px;color:#50685a}.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.flow a{padding:17px 20px;background:#fff;border-radius:9px;display:block;font-weight:600}.flow small{display:block;margin-top:7px;color:#758178;font-weight:400}.references figure>a{aspect-ratio:1.6}.references figcaption p{font-size:13px}.references figcaption strong{font-size:16px}@media(max-width:740px){header{padding:18px;gap:13px}header nav{margin-left:0;font-size:13px;gap:16px}main{padding:27px 16px 50px}h1{font-size:26px}.shots{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}.count{gap:12px 20px}.notice{padding:17px 18px}.count strong{font-size:21px}}
</style></head><body><header><strong>FRAME · 상세 검토</strong><nav><a href="./index.html?screen=live">실행 시안</a><a href="./review-all.html">전체 화면</a><a href="./authenticated-review.txt">검토 기록</a></nav></header><main><div class="intro"><h1>로그인 화면을 대조하고, 시안에 반영했어요.</h1><p>조회수 표기, 메뉴 계층, 채널 편집과 공개 결과의 연결을 정리했습니다.</p><div class="count"><span><strong>53</strong>치지직 캡처</span><span><strong>19</strong>Twitch 캡처</span><span><strong>750</strong>시안 화면 폭 검사</span></div><p>캡처 수는 로딩·팝오버·차단 상태를 포함합니다. 모든 서비스 기능의 조작 검증 수를 의미하지 않습니다.</p></div><section><h2>최신 시안</h2><div class="shots">${shots}</div></section><section><h2>방송 준비와 설정의 구분</h2><div class="flow"><a href="./index.html?screen=sources">화면 선택<small>프로그램 창 / 전체 화면</small></a><a href="./index.html?screen=studio&state=${encodeURIComponent('방송 전')}">방송 정보<small>제목 / 카테고리 / 공개 설정</small></a><a href="./index.html?screen=broadcast-settings">방송 설정<small>영상 / 오디오 / 녹화</small></a><a href="./index.html?screen=studio&state=${encodeURIComponent('방송 중')}">방송 중 관리<small>미리보기 / 채팅</small></a></div><div class="notice">추가 조사에서는 두 서비스의 실제 방송자 대시보드에 접근했습니다. 치지직 16장과 Twitch 24개 화면 상태를 확인했고, 준비·연결·운영 구조와 시안 보완을 <a href="./broadcaster-review.html">방송자 화면 검토</a>에 정리했습니다. 실제 방송·외부 설정 저장·송출 연결 시험은 진행하지 않았습니다. 기존 영상·화질 제어·실제 앱 코드는 유지했습니다.</div></section><section><h2>어디까지 확인했는지</h2><details open><summary>치지직 · 공개 탐색과 로그인 메뉴</summary>${table([
['공개 탐색',(chzzk.publicNavigation?.opened||[]).join(' / '),'직접 열람 · 하위 탭 전체 클릭은 아님'],
['개인 설정',(chzzk.personalSettings?.opened||[]).join(' / '),'직접 열람 · 값 변경 없음'],
['채널',(chzzk.channel?.opened||[]).join(' / '),'직접 열람 · 저장/게시 없음'],
['채널 관리',(chzzk.channel?.managementSections||[]).join(' / '),'직접 열람 · 개인 원본은 로컬 보관'],
['스튜디오','방송 준비·정보·채팅·인코더 연결·방송 중 관리','추가 조사 완료 · 방송자 검토 보드 참조']
])}</details><details><summary>Twitch · 설정과 공개 채널</summary>${table([
['프로필 메뉴','채널 / 대시보드 / 설정 / 구독 / 드롭스 등','메뉴 목록 확인'],
['일반 설정',twitch.coverage.accountTabs.directlyVisited.join(' / '),'직접 열람 · 값 변경 없음'],
['공개 채널',twitch.coverage.publicChannel.visited.join(' / '),'직접 열람 · 동영상/클립은 빈 상태'],
['방송자 메뉴','홈 / 방송 관리자 / 설정-채널 / 설정-방송','추가 조사에서 직접 열람 · 방송자 검토 보드 참조'],
['초기 조사에서 차단된 메뉴',twitch.coverage.dashboard.notExploredDueToGate.join(' / '),'후속 방송자 조사 범위를 별도 보드에 기록']
])}</details><p>개인 설정·연결·보안·활동 원본은 로컬 연구 폴더에만 보관하고 이 보드에는 복사하지 않았습니다.</p></section><section><h2>공개 화면 레퍼런스</h2><div class="shots references">${reference.map(r=>`<figure><a href="./assets/authenticated-review/${esc(r.file)}" target="_blank"><img loading="lazy" src="./assets/authenticated-review/${esc(r.file)}" alt="${esc(r.platform+' '+r.title)}"></a><figcaption><strong>${r.platform}</strong><p>${esc(r.title)}</p><a href="${esc(r.url)}" target="_blank" rel="noreferrer">실제 서비스 열기 →</a></figcaption></figure>`).join('')}</div></section></main></body></html>`;
for(const file of ['authenticated-review.html','detail-review.html'])await fs.writeFile(path.join(root,'dist',file),html);
await fs.writeFile(path.join(root,'verification/authenticated-review/board-manifest.json'),JSON.stringify({prototype:prototype.map(x=>x[0]),reference:reference.map(x=>x.file),privateScreenshotsCopied:0,captureCounts:{chzzk:53,twitch:19}},null,2));
console.log(JSON.stringify({board:'dist/authenticated-review.html',prototypeImages:prototype.length,publicReferences:reference.length,privateCopied:0}));
