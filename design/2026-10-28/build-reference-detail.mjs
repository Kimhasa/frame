import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const evidence=path.join(root,'verification/reference-detail');
const assets=path.join(root,'dist/assets/reference-detail');
await fs.mkdir(assets,{recursive:true});
const groups=[
  ['목록과 카드','제목 바로 아래에 채널명을 두고, 불필요한 카테고리 줄을 덜어냈어요.','live',[
    ['home-desktop.jpg','홈 · 데스크톱','desktop'],['home-mobile.jpg','홈 · 모바일','mobile'],['history-desktop.jpg','시청 기록','desktop']]],
  ['방송 설정','영상·오디오·녹화를 나누고, 탭을 바꿔도 입력을 유지해요.','broadcast-settings',[
    ['settings-video-desktop.jpg','영상','desktop'],['settings-audio-desktop.jpg','오디오','desktop'],['settings-recording-desktop.jpg','녹화','desktop'],['settings-mobile.jpg','방송 설정 · 모바일','mobile']]],
  ['채팅과 닉네임','이름 변경과 메시지 입력, 읽던 위치와 최신 메시지 복귀를 정리했어요.','watch',[
    ['watch-desktop.jpg','시청과 채팅','desktop'],['nickname-desktop.jpg','닉네임 변경','desktop'],['nickname-mobile.jpg','닉네임 오류 · 모바일','mobile']]],
  ['채널 관리','폼과 미리보기, 역할 행의 정렬을 맞췄어요.','channel-edit',[
    ['channel-edit-desktop.jpg','기본 정보','desktop'],['channel-edit-mobile.jpg','채널 관리 · 모바일','mobile']]]
];
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
for(const group of groups)for(const [file] of group[3])await fs.copyFile(path.join(evidence,file),path.join(assets,file));
await fs.copyFile(path.join(root,'REFERENCE_DETAIL_REVIEW.txt'),path.join(root,'dist/reference-detail-review.txt'));
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FRAME · 세부 검토</title><style>
@font-face{font-family:Pretendard;src:url('./assets/PretendardVariable.woff2') format('woff2');font-weight:100 900;font-display:swap}*{box-sizing:border-box}body{margin:0;font:15px/1.6 Pretendard,sans-serif;color:#20272b;background:#f5f7f6}a{color:#22704f;text-decoration:none}header{padding:22px max(24px,calc((100vw - 1392px)/2));background:#fff;display:flex;align-items:center;gap:20px;flex-wrap:wrap}header strong{font-size:20px}header nav{margin-left:auto;display:flex;gap:20px}main{max-width:1440px;margin:auto;padding:38px 24px 70px}h1{font-size:31px;letter-spacing:-1px;margin:0 0 8px}h2{font-size:23px;margin:0;letter-spacing:-.6px}p{color:#65736a;margin:7px 0 0}section{margin-top:42px}.section-head{display:flex;gap:20px;justify-content:space-between;align-items:center;margin-bottom:18px}.shots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.shot{min-width:0;margin:0;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 0 #e6ebe7}.shot a{display:block;background:#e9edeb;aspect-ratio:1.44;overflow:hidden}.shot img{display:block;width:100%;height:100%;object-fit:contain}.shot figcaption{padding:15px 18px;font-weight:600}.shot small{float:right;color:#7a857e;font-weight:400}.scope{font-size:13px;max-width:970px;margin-top:20px}.sources{font-size:13px;display:flex;gap:16px;flex-wrap:wrap;margin-top:16px}@media(max-width:720px){header{padding:18px}header nav{margin-left:0;gap:14px;font-size:13px}main{padding:28px 16px 50px}.shots{grid-template-columns:1fr}h1{font-size:26px}.section-head{align-items:flex-start}.section-head>a{flex:none;font-size:13px}.shot figcaption{padding:13px 15px}}
</style></head><body><header><strong>FRAME · 세부 검토</strong><nav><a href="./index.html?screen=live">실행 시안</a><a href="./review-all.html">전체 화면</a><a href="./reference-detail-review.txt">검토 기록</a></nav></header><main><h1>설정과 채팅, 카드까지</h1><p>레퍼런스의 정보 순서와 조작 흐름을 대조해 현재 시안에 반영했어요.</p><p class="scope">공개 화면·공식 안내와 FRAME의 설계 판단을 구분했습니다. 실제 계정 변경·서버 채팅·미디어 성능 검증은 포함하지 않습니다. 기존 영상 플레이어·화질 메뉴와 실제 앱 코드는 유지했습니다.</p><div class="sources"><a href="https://chzzk.naver.com/lives">CHZZK 공개 목록</a><a href="https://support.google.com/youtube/answer/9854503?hl=en">YouTube 방송 설정 안내</a><a href="https://help.twitch.tv/s/article/creator-dashboard?language=en_US">Twitch 방송 관리자 안내</a><a href="https://bjguide.sooplive.com/tech.php">SOOP 방송 가이드</a></div>${groups.map(([title,copy,screen,shots])=>`<section><div class="section-head"><div><h2>${title}</h2><p>${copy}</p></div><a href="./index.html?screen=${screen}&device=desktop">시안 열기 →</a></div><div class="shots">${shots.map(([file,label,device])=>`<figure class="shot"><a href="./assets/reference-detail/${file}" target="_blank"><img src="./assets/reference-detail/${file}" alt="${escape(label)}" loading="lazy"></a><figcaption>${label}<small>${device==='mobile'?'390px':'1440px'}</small></figcaption></figure>`).join('')}</div></section>`).join('')}</main></body></html>`;
await fs.writeFile(path.join(root,'dist/detail-review.html'),html);
console.log(JSON.stringify({file:'dist/detail-review.html',images:groups.reduce((n,g)=>n+g[3].length,0)}));
