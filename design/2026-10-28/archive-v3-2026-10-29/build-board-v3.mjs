import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const route = (screen, device = 'desktop', extra = {}) => `./index.html?${new URLSearchParams({ screen, device, ...extra })}`;
const external = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9M10 4H4v16h16v-6"/></svg>';
const frame = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V3h6m6 0h6v6m0 6v6h-6M9 21H3v-6M8 8h8v8H8z"/></svg>';
const groups = [
  {
    title: '탐색과 로그인', subtitle: '방송을 찾고, 내 계정으로 이어지는 진입 화면',
    items: [
      ['home', '홈', 'live', '정렬된 카드와 검색을 중심으로 방송을 탐색합니다.'],
      ['login', '로그인', 'login', '로그인 방식과 계정 선택을 한 흐름으로 연결합니다.']
    ]
  },
  {
    title: '내 설정', subtitle: '계정 정보와 개인 이용 설정',
    items: [
      ['settings-profile', '프로필 설정', 'profile', '닉네임, 소개와 채널 주소를 한곳에서 관리합니다.'],
      ['settings-notifications', '알림 설정', 'preferences', '받고 싶은 알림을 항목별로 선택합니다.']
    ]
  },
  {
    title: '방송 스튜디오 · 채널 관리', subtitle: '공개 채널과 구분되는 방송자 편집 화면',
    items: [
      ['channel-management', '채널 기본 정보', 'channel-edit', '채널 정보 편집과 공개 미리보기를 함께 확인합니다.'],
      ['channel-branding', '채널 브랜딩', 'channel-edit', '프로필 이미지와 배너를 채널 미리보기로 확인합니다.', { tab: 'branding' }]
    ]
  },
  {
    title: '방송 스튜디오 · 방송하기', subtitle: '방송 준비와 방송 중 화면의 역할을 구분',
    items: [
      ['studio-ready', '방송 준비', 'studio', '방송 정보와 공유할 화면을 확인한 뒤 방송을 시작합니다.', { state: '방송 전' }],
      ['studio-live', '방송 중', 'studio', '미리보기와 채팅을 보며 진행 중인 방송을 관리합니다.', { state: '방송 중' }]
    ]
  },
  {
    title: '방송 시청과 참여', subtitle: '기존 영상 제어를 유지한 주변 화면',
    items: [
      ['watch', '방송 시청', 'watch', '영상을 중심에 두고 채팅과 방송 정보로 연결합니다.'],
      ['donation', '후원하기', 'donate', '금액 선택과 메시지 입력을 기존 후원 흐름 안에서 정돈합니다.']
    ]
  }
];
const mobile = [
  ['home-mobile', '홈', 'live'],
  ['login-mobile', '로그인', 'login'],
  ['channel-mobile', '채널 관리', 'channel-edit'],
  ['studio-mobile', '방송 준비', 'studio', { state: '방송 전' }],
  ['watch-mobile', '방송 시청', 'watch']
];

const desktopCard = ([id, title, screen, description, extra = {}]) => {
  const href = route(screen, 'desktop', extra);
  return `<article class="screen-card" id="${id}"><a class="screen-image" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(title)} 시안 직접 열기"><img src="./assets/v3/${id}.jpg" alt="${esc(title)} · PC 화면" loading="lazy" decoding="async"></a><div class="screen-caption"><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div><a class="open-link" href="${esc(href)}" target="_blank" rel="noopener">직접 열기${external}<span class="sr-only"> · ${esc(title)}, 새 탭</span></a></div></article>`;
};
const mobileCard = ([id, title, screen, extra = {}]) => {
  const href = route(screen, 'mobile', extra);
  return `<article class="phone-card"><a class="phone-image" href="${esc(href)}" target="_blank" rel="noopener" aria-label="모바일 ${esc(title)} 시안 직접 열기"><img src="./assets/v3/${id}.jpg" alt="${esc(title)} · 모바일 화면" loading="lazy" decoding="async"></a><div class="phone-caption"><h3>${esc(title)}</h3><a class="open-link" href="${esc(href)}" target="_blank" rel="noopener">직접 열기${external}<span class="sr-only"> · 모바일 ${esc(title)}, 새 탭</span></a></div></article>`;
};

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<title>FRAME · 디자인 검토 V3</title>
<style>
@font-face{font-family:Pretendard;src:url('./assets/PretendardVariable.woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:#f7f8fa;color:#1b242f;font:15px/1.55 Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit;text-decoration:none}button,a{-webkit-tap-highlight-color:transparent}a:focus-visible{outline:2px solid #0b9162;outline-offset:5px;border-radius:4px}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.topbar{background:#fff;border-bottom:1px solid #e5e9ed}.topbar-inner{max-width:1400px;margin:auto;padding:22px 28px;display:flex;justify-content:space-between;align-items:center;gap:20px}.brand{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:780;letter-spacing:-.7px}.brand>svg{width:25px;height:25px;color:#0a9a69;stroke-width:2}.brand span{margin-left:8px;border-left:1px solid #dde3e8;padding-left:17px;color:#66727f;font-size:14px;font-weight:500;letter-spacing:0}.primary-link{display:inline-flex;align-items:center;justify-content:center;gap:9px;border:1px solid #d8e7df;background:#f0f8f3;color:#16704f;padding:10px 15px;border-radius:8px;font-size:13px;font-weight:650;white-space:nowrap}.primary-link:hover{background:#e7f4ec}
main{max-width:1400px;margin:auto;padding:45px 28px 42px}.intro{margin-bottom:41px}.eyebrow{display:flex;align-items:center;gap:9px;color:#71808c;font-size:11px;font-weight:650;letter-spacing:1px}.eyebrow i{display:block;width:6px;height:6px;border-radius:50%;background:#0b9b69}.intro h1{font-size:35px;line-height:1.35;font-weight:760;letter-spacing:-1.2px;margin:12px 0 12px}.intro-description{margin:0;color:#677481;font-size:15px;line-height:1.8}.intro-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px;font-size:12px;color:#7b8792}.preserved{display:inline-flex;align-items:center;gap:6px;color:#33795d;background:#edf6f0;border:1px solid #deece3;border-radius:5px;padding:4px 8px}.preserved svg{width:14px;height:14px}
.flow-nav{display:flex;flex-wrap:wrap;gap:9px;margin-top:25px}.flow-nav a{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #e1e6eb;border-radius:7px;padding:9px 13px;font-size:13px;color:#465462;font-weight:550}.flow-nav a span{font-size:11px;font-weight:500;color:#95a0aa}.flow-nav a:hover{background:#f0f6f3;border-color:#bfd7c9;color:#126447}
.screen-group{margin-top:38px}.section-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:17px}.section-heading h2{font-size:21px;letter-spacing:-.55px;font-weight:720;line-height:1.4;margin:0}.section-heading p{color:#7b8691;font-size:12px;margin:0 0 2px}.screen-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.screen-card{min-width:0;background:white;border:1px solid #e1e6eb;border-radius:12px;overflow:hidden;scroll-margin-top:25px;box-shadow:0 2px 5px #1a2d3c02}.screen-image{display:block;aspect-ratio:16/10;background:#edf1f4;border-bottom:1px solid #e7ecf0;overflow:hidden}.screen-image img{display:block;width:100%;height:100%;object-fit:contain;object-position:top center}.screen-caption{padding:19px 20px 20px;display:flex;justify-content:space-between;align-items:flex-start;gap:14px;min-height:102px}.screen-caption>div{min-width:0}.screen-caption h3,.phone-caption h3{margin:0;font-size:16px;font-weight:670;line-height:1.4;letter-spacing:-.3px}.screen-caption p{margin:6px 0 0;color:#75818d;font-size:12px;line-height:1.7}.open-link{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:12px;font-weight:550;color:#46725c;white-space:nowrap;padding:2px 0}.open-link svg{width:14px;height:14px}.open-link:hover{color:#088052;text-decoration:underline;text-underline-offset:3px}
.mobile-section{margin-top:48px;padding-top:34px;border-top:1px solid #dfe5e9}.mobile-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:17px;align-items:start}.phone-card{background:#fff;border:1px solid #dfe5e9;border-radius:12px;overflow:hidden;min-width:0}.phone-image{display:block;aspect-ratio:390/844;background:#edf1f4;overflow:hidden;border-bottom:1px solid #e7ecf0}.phone-image img{display:block;width:100%;height:100%;object-fit:contain;object-position:top center}.phone-caption{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:15px 13px}.phone-caption h3{font-size:13px}.phone-caption .open-link{font-size:11px;gap:3px}.phone-caption .open-link svg{width:12px;height:12px}
.bottom-links{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-top:43px;padding:22px 0;border-top:1px solid #e0e6eb;font-size:12px;color:#74808b}.bottom-links nav{display:flex;flex-wrap:wrap;gap:22px}.bottom-links nav a{display:inline-flex;gap:5px;align-items:center}.bottom-links nav a:hover{color:#0a7953}.bottom-links nav svg{width:13px;height:13px}.bottom-links>span{font-size:11px;color:#99a2ab}footer{font-size:11px;color:#88939d;line-height:1.8;margin-top:4px}
@media(min-width:1600px){main{padding-top:53px}.screen-caption p{font-size:13px}}
@media(max-width:1050px){.section-heading{align-items:flex-start;flex-direction:column;gap:5px}.screen-caption{flex-direction:column;gap:11px;min-height:132px}.mobile-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:17px}.phone-caption{padding:14px 13px}.mobile-section .section-heading{margin-bottom:19px}}
@media(max-width:680px){html{scroll-padding-top:18px}.topbar-inner{padding:17px 18px}.brand{font-size:20px;gap:7px}.brand>svg{width:23px;height:23px}.brand span{font-size:12px;margin-left:3px;padding-left:10px}.primary-link{padding:8px 10px;font-size:11px;gap:5px}.primary-link svg{width:14px;height:14px}main{padding:29px 18px 30px}.intro{margin-bottom:31px}.intro h1{font-size:29px;letter-spacing:-.95px;line-height:1.4}.intro-description{font-size:13px}.intro-meta{gap:8px;font-size:11px}.flow-nav{gap:7px;margin-top:22px}.flow-nav a{padding:8px 10px;font-size:12px;gap:7px}.screen-group{margin-top:29px}.section-heading h2{font-size:19px}.section-heading p{font-size:11px;line-height:1.65}.screen-grid{grid-template-columns:1fr;gap:16px}.screen-caption{flex-direction:row;min-height:101px;padding:17px 16px;gap:12px}.screen-caption h3{font-size:15px}.screen-caption p{font-size:11px}.screen-caption .open-link{font-size:11px}.mobile-section{margin-top:35px;padding-top:27px}.mobile-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.phone-caption{padding:12px 11px;align-items:flex-start;flex-direction:column;gap:6px}.bottom-links{flex-direction:column;align-items:flex-start;gap:16px;margin-top:30px;padding:20px 0}.bottom-links nav{gap:13px 18px;font-size:11px}.bottom-links>span{font-size:10px}footer{font-size:10px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><a class="brand" href="./board-v3.html" aria-label="FRAME 디자인 검토">${frame}FRAME<span>디자인 검토</span></a><a class="primary-link" href="${esc(route('live'))}" target="_blank" rel="noopener">시안 둘러보기${external}</a></div></header>
<main>
<section class="intro"><div class="eyebrow"><i></i>DESIGN REVIEW · V3</div><h1>탐색부터 방송까지,<br>하나의 흐름으로.</h1><p class="intro-description">홈, 내 설정, 채널 관리와 방송 스튜디오의 최근 디자인을 한눈에 확인하세요.</p><div class="intro-meta"><span>PC 10개 화면 · 모바일 5개 화면</span><span class="preserved"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>기존 영상·화질 제어 유지</span></div><nav class="flow-nav" aria-label="핵심 6개 흐름">${[['home','홈'],['login','로그인'],['settings-profile','내 설정'],['channel-management','채널 관리'],['studio-ready','방송 준비'],['studio-live','방송 중']].map(([id,title],index)=>`<a href="#${id}"><span>0${index+1}</span>${esc(title)}</a>`).join('')}</nav></section>
${groups.map(group=>`<section class="screen-group"><div class="section-heading"><h2>${esc(group.title)}</h2><p>${esc(group.subtitle)}</p></div><div class="screen-grid">${group.items.map(desktopCard).join('')}</div></section>`).join('\n')}
<section class="mobile-section"><div class="section-heading"><h2>모바일 배치</h2><p>작은 화면에서 확인하는 탐색·계정·방송 흐름</p></div><div class="mobile-grid">${mobile.map(mobileCard).join('')}</div></section>
<div class="bottom-links"><nav aria-label="이전 검토와 참고 자료"><a href="./board.html">이전 디자인 보드${external}</a><a href="./research.html">서비스 레퍼런스${external}</a><a href="./account-research.html">계정·방송자 화면 조사${external}</a></nav><span>FRAME / DESIGN REVIEW V3</span></div>
<footer>이 화면들은 로컬 디자인 시안이며, 실제 로그인·방송 송출·결제 및 모든 기능의 상세 구현이 완료되었음을 의미하지 않습니다.</footer>
</main>
</body></html>`;

await fs.writeFile(path.join(root, 'dist', 'board-v3.html'), html, 'utf8');
console.log('V3 board generated: dist/board-v3.html (10 desktop + 5 mobile screens)');
