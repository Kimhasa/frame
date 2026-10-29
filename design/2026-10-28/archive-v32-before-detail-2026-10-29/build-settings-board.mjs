import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9M10 4H4v16h16v-6"/></svg>';
const logo = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V3h6m6 0h6v6m0 6v6h-6M9 21H3v-6M8 8h8v8H8z"/></svg>';
const screens = [
  {id:'profile',title:'프로필',screen:'profile',description:'프로필 이미지와 닉네임, 소개를 편집합니다.'},
  {id:'account',title:'계정',screen:'security',section:'account',description:'이메일과 연결된 로그인 계정을 확인합니다.'},
  {id:'security',title:'보안',screen:'security',section:'security',description:'로그인 보호와 접속한 기기를 관리합니다.'},
  {id:'notifications',title:'알림',screen:'preferences',section:'notifications',description:'받고 싶은 소식을 항목별로 선택합니다.'},
  {id:'playback',title:'재생',screen:'preferences',section:'playback',description:'나에게 맞는 영상 재생 방식을 설정합니다.'}
];
const route = (item, device='desktop') => `./index.html?${new URLSearchParams({screen:item.screen,...(item.section?{section:item.section}:{}),device})}`;
const imagePath = (item, mobile=false) => `./assets/v32/settings-${item.id}${mobile?'-mobile':''}.jpg`;
const openLink = (item, device='desktop') => `<a class="open-link" href="${escape(route(item,device))}" target="_blank" rel="noopener">시안 열기${icon}<span class="sr-only"> · ${escape(item.title)} ${device==='desktop'?'PC':'모바일'}, 새 탭</span></a>`;
const desktopCard = item => `<article class="screen-card" id="${item.id}"><a class="screen-image" href="${escape(route(item))}" target="_blank" rel="noopener" aria-label="${escape(item.title)} PC 시안 열기, 새 탭"><img src="${imagePath(item)}" alt="내 설정 · ${escape(item.title)} · PC 화면" loading="lazy" decoding="async" width="1440" height="900"></a><div class="screen-caption"><div><h3><a href="${escape(route(item))}" target="_blank" rel="noopener">${escape(item.title)}<span class="sr-only"> PC 시안, 새 탭</span></a></h3><p>${escape(item.description)}</p></div>${openLink(item)}</div></article>`;
const mobileCard = item => `<article class="phone-card"><a class="phone-image" href="${escape(route(item,'mobile'))}" target="_blank" rel="noopener" aria-label="${escape(item.title)} 모바일 시안 열기, 새 탭"><img src="${imagePath(item,true)}" alt="내 설정 · ${escape(item.title)} · 모바일 화면" loading="lazy" decoding="async" width="390" height="844"></a><div class="phone-caption"><h3><a href="${escape(route(item,'mobile'))}" target="_blank" rel="noopener">${escape(item.title)}<span class="sr-only"> 모바일 시안, 새 탭</span></a></h3>${openLink(item,'mobile')}</div></article>`;

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<title>FRAME · 내 설정 디자인 검토</title>
<style>
@font-face{font-family:Pretendard;src:url('./assets/PretendardVariable.woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:#f7f8fa;color:#202832;font:15px/1.55 Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.15px}a{color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}a:focus-visible{outline:2px solid #0c9263;outline-offset:4px;border-radius:4px}svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}h1,h2,h3,p{margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.topbar{background:#fff;border-bottom:1px solid #e6eaed}.topbar-inner{max-width:1424px;margin:auto;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:inline-flex;align-items:center;gap:10px;font-size:22px;font-weight:780;letter-spacing:-.8px}.brand>svg{width:25px;height:25px;stroke-width:1.9;color:#139766}.brand>span{border-left:1px solid #e2e7eb;padding-left:18px;margin-left:7px;font-size:13px;font-weight:500;letter-spacing:-.2px;color:#7a858f}.primary-link{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:9px 14px;border:1px solid #dce9e1;border-radius:8px;background:#eff8f2;color:#267b57;font-size:12px;font-weight:650;white-space:nowrap}.primary-link:hover{background:#e7f3eb}.primary-link>svg{width:15px;height:15px}
main{max-width:1424px;margin:auto;padding:40px 28px 30px}.intro{margin-bottom:35px}.eyebrow{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;color:#8a959e;letter-spacing:.3px}.eyebrow:before{content:"";display:block;width:5px;height:5px;border-radius:50%;background:#2aa474}.intro h1{font-size:34px;line-height:1.35;font-weight:750;letter-spacing:-1.2px;margin:10px 0}.intro p{font-size:14px;line-height:1.8;color:#7a8690}.quick-links{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:24px}.quick-links>a{display:inline-flex;align-items:center;gap:9px;min-height:36px;padding:8px 13px;background:#fff;border:1px solid #e3e8ec;border-radius:7px;font-size:12px;font-weight:550;color:#586875}.quick-links>a>span{font-size:10px;color:#a0abb3;font-variant-numeric:tabular-nums}.quick-links>a:hover{background:#edf5f0;border-color:#c9dfd2;color:#277552}
.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:15px;margin-bottom:16px}.section-heading h2{font-size:20px;font-weight:700;letter-spacing:-.55px}.section-heading p{font-size:12px;color:#98a2ab}.screen-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}.screen-card{min-width:0;background:#fff;border:1px solid #e1e7eb;border-radius:12px;overflow:hidden;scroll-margin-top:25px;box-shadow:0 2px 5px #1c334103}.screen-image{display:block;aspect-ratio:16/10;background:#f0f3f5;border-bottom:1px solid #e7ecf0;overflow:hidden}.screen-image>img{display:block;width:100%;height:100%;object-fit:contain;object-position:top center}.screen-image:hover>img,.phone-image:hover>img{filter:brightness(.985)}.screen-caption{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px 20px;min-height:91px}.screen-caption>div{min-width:0}.screen-caption h3,.phone-caption h3{font-size:15px;line-height:1.45;font-weight:650;letter-spacing:-.3px}.screen-caption h3>a:hover,.phone-caption h3>a:hover{color:#148252}.screen-caption p{font-size:12px;line-height:1.7;color:#8b969f;margin-top:5px}.open-link{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1.5;font-weight:550;color:#59846e;padding:2px 0;white-space:nowrap;flex:none}.open-link>svg{width:13px;height:13px}.open-link:hover{color:#087e50;text-decoration:underline;text-underline-offset:3px}
.mobile-section{margin-top:45px;padding-top:30px;border-top:1px solid #e1e7eb}.phone-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));align-items:start;gap:17px}.phone-card{min-width:0;background:#fff;border:1px solid #e1e7eb;border-radius:12px;overflow:hidden;box-shadow:0 2px 5px #1c334102}.phone-image{display:block;aspect-ratio:390/844;background:#f0f3f5;border-bottom:1px solid #e7ecf0;overflow:hidden}.phone-image>img{display:block;width:100%;height:100%;object-fit:contain;object-position:top center}.phone-caption{padding:14px 15px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px}.phone-caption h3{font-size:13px}.phone-caption .open-link{font-size:10px}.phone-caption .open-link>svg{width:12px;height:12px}footer{border-top:1px solid #e2e7eb;margin-top:36px;padding:19px 0 6px;font-size:11px;line-height:1.9;color:#9aa3ab}
@media(max-width:1050px){.phone-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.screen-caption{padding:15px 16px 17px;min-height:99px;gap:10px}.screen-caption p{font-size:11px}.phone-caption{padding:13px 14px 15px}.intro h1{font-size:31px}}
@media(max-width:720px){.topbar-inner{padding:15px 20px}.brand{font-size:20px;gap:8px}.brand>svg{width:23px;height:23px}.brand>span{font-size:11px;margin-left:4px;padding-left:12px}.primary-link{font-size:11px;min-height:34px;padding:7px 10px;gap:5px}.primary-link>svg{width:13px;height:13px}main{padding:30px 20px 22px}.intro{margin-bottom:29px}.intro h1{font-size:29px;margin:9px 0}.intro p{font-size:13px}.quick-links{gap:6px;margin-top:20px}.quick-links>a{font-size:11px;min-height:33px;padding:7px 10px;gap:6px}.section-heading h2{font-size:18px}.section-heading p{font-size:11px}.screen-grid{grid-template-columns:minmax(0,1fr);gap:19px}.screen-caption{min-height:83px;padding:16px 17px 17px}.screen-caption p{font-size:12px}.mobile-section{margin-top:34px;padding-top:25px}.phone-grid{gap:12px}.phone-caption{padding:12px;gap:6px}.phone-caption h3{font-size:12px}.phone-caption .open-link{font-size:9px}footer{margin-top:28px;font-size:10px}}
@media(max-width:460px){.topbar-inner{padding:13px 16px;gap:10px}.brand>span{display:none}.primary-link{min-height:33px}main{padding:26px 16px 20px}.intro h1{font-size:28px}.intro p{font-size:12px}.eyebrow{font-size:10px}.quick-links{gap:6px}.quick-links>a{padding:7px 9px;gap:5px}.quick-links>a>span{font-size:9px}.section-heading p{font-size:10px}.screen-caption{padding:14px 15px 16px;gap:11px}.screen-caption h3{font-size:14px}.screen-caption p{font-size:11px}.open-link{font-size:10px}.screen-card{border-radius:10px}.phone-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.phone-card{border-radius:10px}.phone-caption{padding:12px;gap:7px}.phone-caption .open-link{font-size:9px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><a class="brand" href="./board-v3.html" aria-label="FRAME 전체 디자인 검토">${logo}FRAME<span>디자인 검토</span></a><a class="primary-link" href="${escape(route(screens[0]))}" target="_blank" rel="noopener">실제 시안 열기${icon}<span class="sr-only"> · 내 설정, 새 탭</span></a></div></header>
<main>
<section class="intro" aria-labelledby="board-title"><div class="eyebrow">계정과 이용 환경</div><h1 id="board-title">내 설정</h1><p>다섯 가지 설정 화면을 PC와 모바일에서 비교해 보세요.</p><nav class="quick-links" aria-label="설정 화면 바로가기">${screens.map((item,index)=>`<a href="#${item.id}"><span>0${index+1}</span>${item.title}</a>`).join('')}</nav></section>
<section aria-labelledby="desktop-title"><div class="section-heading"><h2 id="desktop-title">PC 화면</h2><p>5개 화면</p></div><div class="screen-grid">${screens.map(desktopCard).join('')}</div></section>
<section class="mobile-section" aria-labelledby="mobile-title"><div class="section-heading"><h2 id="mobile-title">모바일 화면</h2><p>5개 화면 · 390px</p></div><div class="phone-grid">${screens.map(mobileCard).join('')}</div></section>
<footer>실제 인증·보안 설정이 동작하지 않는 로컬 디자인 시안이며, 연결 계정과 기기 정보는 fixture.test 기반의 검토용 데이터입니다.</footer>
</main>
</body></html>`;

await fs.writeFile(path.join(dist, 'settings-board.html'), html, 'utf8');
const imageSources = Array.from(html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), match => match[1]);
if (imageSources.length !== 10 || new Set(imageSources).size !== 10) throw new Error('Expected ten unique settings screenshots.');
const internalLinks = Array.from(html.matchAll(/href="(\.\/index\.html\?[^"]+)"/g), match => match[1].replaceAll('&amp;', '&'));
for (const href of internalLinks) {
  const url = new URL(href, 'http://fixture.test/');
  const device = url.searchParams.get('device');
  if (!['desktop','mobile'].includes(device)) throw new Error(`Invalid device: ${href}`);
  const item = screens.find(item => item.screen === url.searchParams.get('screen') && (item.section || null) === url.searchParams.get('section'));
  if (!item) throw new Error(`Invalid settings route: ${href}`);
}
const missing = [];
for (const source of imageSources) {
  try { await fs.access(path.resolve(dist, source)); } catch { missing.push(source); }
}
console.log(`Created dist/settings-board.html: ${imageSources.length} images, ${internalLinks.length} valid prototype links.`);
if (missing.length) console.log(`Screenshots pending (${missing.length}):\n${missing.join('\n')}`);
else console.log('All ten screenshot files are present.');
