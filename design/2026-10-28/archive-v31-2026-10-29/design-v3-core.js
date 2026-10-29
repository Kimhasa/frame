/* FRAME v3: catalog and navigation. Media renderers and controls stay intact. */
(() => {
  const {e}=F, oldIcon=F.icon, oldShell=F.shell, oldCatalog=F.catalog;
  const paths={
    gear:'M9.7 3.5h4.6l.7 2.4 2 .9 2.3-.6 2.3 4-1.7 1.8v2.1l1.7 1.8-2.3 4-2.3-.6-2 .9-.7 2.3H9.7L9 20.2l-2-.9-2.3.6-2.3-4 1.7-1.8V12L2.4 10.2l2.3-4 2.3.6 2-.9.7-2.4ZM15.5 12.7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
    link:'m9.5 14.5 5-5M7.5 16.5 6 18a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m4 8a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-1.5 1.5',
    refresh:'M20 10a8 8 0 0 0-13.7-4L3 9m0-6v6h6M4 14a8 8 0 0 0 13.7 4L21 15m0 6v-6h-6',
    edit:'m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z',
    chat:'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 2V11.5A8.5 8.5 0 0 1 11.5 3h1a8.5 8.5 0 0 1 8.5 8.5ZM8 10h8m-8 4h5',
    live:'M5.6 5.6a9 9 0 0 0 0 12.8m12.8-12.8a9 9 0 0 1 0 12.8M8.4 8.4a5 5 0 0 0 0 7.2m7.2-7.2a5 5 0 0 1 0 7.2M12 10v4',
    menu:'M4 6h16M4 12h16M4 18h16',
    share:'M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8',
    bell:'M18 8a6 6 0 0 0-12 0v4l-2 5h16l-2-5V8ZM10 21h4',
    search:'m20 20-4.3-4.3M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0'
  };
  const iconStroke='fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  F.icon=(name,cls='')=>paths[name]?`<svg ${iconStroke} class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`:oldIcon(name,cls).replace('<svg ',`<svg ${iconStroke} `);
  F.btn=(text,action,ico='',cls='',attr='')=>`<button type="button" ${action?.startsWith('go:')?`data-go="${e(action.slice(3))}"`:`data-action="${e(action||'')}"`} class="${cls}" ${attr}>${ico?F.icon(ico):''}${text}</button>`;
  F.go=(id,text,ico='',cls='')=>F.btn(text,'go:'+id,ico,cls,text?'':`aria-label="${e(F.data.screens.find(s=>s.id===id)?.name||id)}"`);
  F.sessionLoggedIn=true; F.profileMenuOpen=false;
  F.broadcasts.push(
    {title:'오늘의 플레이리스트와 함께, 차분한 오후',name:'오후의 틈',initial:'밤',category:'음악 · 이야기',scene:'night',viewers:182,quality:'1080p / 60fps',cls:''},
    {title:'낯선 숲에서 시작하는 새로운 모험',name:'산책',initial:'초',category:'게임',scene:'game',viewers:305,quality:'1080p / 60fps',cls:''}
  );
  const ownName=()=>F.accountDesign?.savedChannel?.name || '개발하는 봄';
  const profileMenu=()=>`<div class="v3-profile-menu" id="v3-profile-menu" ${F.profileMenuOpen?'':'hidden'}><div class="v3-profile-summary">${F.avatar('봄','round')}<div><strong>${e(ownName())}</strong><span>@spring</span></div></div><div class="v3-menu-group">${F.btn('내 채널','v3-my-channel','user')}${F.go('channel-edit','채널 관리','edit')}${F.go('studio','방송 스튜디오','live')}</div><div class="v3-menu-group">${F.go('profile','내 설정','gear')}${F.btn('로그아웃','v3-logout','logout')}</div></div>`;
  F.header=()=>`<header class="app-header v2-header v3-header"><div class="header-brand">${F.btn('','v3-menu','menu','icon ghost','aria-label="메뉴 접기"')}${F.go('live',`${F.icon('frame')}<span>FRAME</span>`,'','brand ghost')}</div>${F.currentBase==='login'?'<span></span>':`<form class="header-search" id="header-search" role="search"><input name="query" type="search" placeholder="방송 및 채널 검색" aria-label="방송 및 채널 검색" value="${e(F.searchQuery)}" autocomplete="off"><button type="submit" aria-label="검색">${F.icon('search')}</button></form>`}<div class="header-actions">${F.currentBase==='login'?F.go('live','둘러보기','arrow','ghost'): `${F.go('search','','search','icon ghost mobile-only')}${F.currentBase==='studio'?'':F.go('studio','방송하기','plus','header-create')}${F.go('notifications','','bell','icon ghost')}${F.sessionLoggedIn?`<div class="v3-profile-anchor">${F.btn(F.avatar('봄','round'),'v3-profile-menu','','header-profile',`aria-label="내 계정" aria-expanded="${F.profileMenuOpen}" aria-controls="v3-profile-menu"`)}${profileMenu()}</div>`:F.go('login','로그인','user','v3-login-button')}</div>`}</header>`;
  const nav=(items,active)=>items.map(([id,label,ico])=>F.go(id,`<span class="nav-label">${label}</span>`,ico,id===active?'nav-active':'')).join('');
  F.sidebar=active=>{
    if(active==='login')return '';
    const creator=['studio','recordings','schedule','moderation','creator-stats','revenue','channel-edit'].includes(active);
    if(creator)return `<aside class="sidebar v3-sidebar"><div class="v3-side-context">${F.avatar('봄','round')}<span><strong>${e(ownName())}</strong><small>방송 스튜디오</small></span></div>${nav([['studio','방송하기','live'],['channel-edit','채널 관리','user'],['recordings','콘텐츠 관리','folder'],['schedule','방송 일정','calendar'],['moderation','커뮤니티 관리','chat'],['creator-stats','분석','chart'],['revenue','수익 관리','wallet']],active)}<div class="sidebar-bottom">${F.go('live','<span class="nav-label">FRAME으로 돌아가기</span>','arrow')}${F.go('profile','<span class="nav-label">내 설정</span>','gear')}</div></aside>`;
    return `<aside class="sidebar v3-sidebar"><nav class="primary-navigation" aria-label="탐색">${nav([['live','홈','live'],['following','팔로잉','heart']],active)}</nav><nav class="secondary-navigation" aria-label="보관함">${nav([['vod','다시보기','video'],['clips','클립','clip'],['history','시청 기록','history']],active)}</nav><div class="followed-navigation"><div class="side-heading">팔로우한 채널</div>${F.broadcasts.slice(0,4).map((b,i)=>`<button class="side-channel" data-go="channel" data-broadcast="${i}">${F.avatar(b.initial,'round')}<span class="side-channel-name">${e(b.name)}</span><span class="channel-live-dot" aria-label="방송 중"></span></button>`).join('')}${F.go('following','<span class="nav-label">모두 보기</span>','chevron','side-more')}</div><div class="sidebar-bottom">${F.go('profile','<span class="nav-label">내 설정</span>','gear')}${F.go('policy','<span class="nav-label">도움말</span>','info')}</div></aside>`;
  };
  F.card=(b,index=0,mode='live')=>{
    const bi=Math.max(0,F.broadcasts.indexOf(b)),target=mode==='live'?'watch':mode==='clip'?'clip-watch':'vod-watch';
    const attrs=`data-go="${target}" data-broadcast="${bi}"`;
    return `<article class="broadcast-card v2-card v3-card"><button class="thumb" ${attrs} aria-label="${e(b.title)} ${mode==='live'?'시청하기':'재생하기'}">${F.v2Visual(b,index)}<span class="v2-play">${F.icon('play')}</span>${mode==='live'?`<span class="v2-live-badge">LIVE</span><span class="v2-viewers">${b.viewers.toLocaleString()}명 시청</span>`:`<span class="duration">${mode==='clip'?'00:42':['2:14:36','1:48:12','3:08:45'][index%3]}</span>${mode==='resume'?`<span class="v3-resume"><i style="width:${[38,67,22,48][index%4]}%"></i></span>`:''}`}</button><div class="card-info"><button class="card-profile" data-go="channel" data-broadcast="${bi}" aria-label="${e(b.name)} 채널">${F.avatar(b.initial,'round')}</button><div class="card-text"><button class="card-title" ${attrs}>${e(b.title)}</button><button class="card-sub" data-go="channel" data-broadcast="${bi}">${e(b.name)}</button><span class="card-category">${e(mode==='live'?b.category:'조회 1.2천회 · 2일 전')}</span></div></div></article>`;
  };
  const rail=()=>`<div class="category-rail" aria-label="방송 카테고리">${['전체','게임','개발·작업','그림·디자인','일상·이야기','지식'].map(c=>`<button data-action="v3-filter" data-category="${c}" class="${F.v2Category===c?'active':''}" aria-pressed="${F.v2Category===c}">${c}</button>`).join('')}</div>`;
  const heading=(name,sort=true)=>`<div class="v3-section-heading"><h1>${name}</h1>${sort?F.btn(`${e(F.v2Sort)}${F.icon('chevron')}`,'v3-sort','','v3-sort','aria-label="방송 정렬" aria-haspopup="listbox"'):''}</div>`;
  const grid=(items,mode='live',cls='')=>`<div class="catalog-grid v3-grid ${cls}">${items.map((b,i)=>F.card(b,i,mode)).join('')}</div>`;
  F.catalog=(id,state)=>{
    if(id==='search')return F.v3Search(state);
    const names={live:'지금 라이브',following:'팔로잉',vod:'다시보기',clips:'클립',history:'시청 기록',recommendations:'추천 방송'};
    const top=(id==='live'?rail():'')+heading(names[id]||'라이브',id!=='history');
    if(!['기본','방송 중'].includes(state)){
      const h=document.createElement('div');h.innerHTML=oldCatalog(id,state);h.querySelectorAll('.toolbar,.v2-catalog-heading,.category-rail').forEach(x=>x.remove());
      return `<div class="v3-catalog">${top}${h.innerHTML}</div>`;
    }
    let items=F.broadcasts.slice();
    if(id==='live'&&F.v2Category!=='전체'){
      const map={'게임':['game'],'개발·작업':['code','board'],'그림·디자인':['design','map'],'일상·이야기':['night'],'지식':['board']};items=items.filter(b=>(map[F.v2Category]||[]).includes(b.scene));
    }
    if(F.v2Sort==='시청자순')items.sort((a,b)=>b.viewers-a.viewers);if(F.v2Sort==='최신순')items.reverse();
    return `<div class="v3-catalog">${top}${grid(items,id==='vod'||id==='history'?'vod':id==='clips'?'clip':'live',id==='live'?'v3-home-live':'')}${id==='live'&&F.v2Category==='전체'?`<section class="v3-recent"><div class="v3-section-heading"><h2>이어서 시청하기</h2>${F.go('history','모두 보기','right','ghost small')}</div>${grid(F.broadcasts.slice(0,4),'resume','v3-resume-grid')}</section>`:''}</div>`;
  };
  F.v3Search=state=>{
    const q=F.searchQuery.trim(),hits=F.broadcasts.filter(b=>`${b.title}${b.name}${b.category}`.replaceAll(' ','').toLowerCase().includes(q.replaceAll(' ','').toLowerCase()));
    const form=`<form class="v3-mobile-search" id="catalog-search" role="search"><input name="query" type="search" aria-label="방송 및 채널 검색" placeholder="방송 및 채널 검색" value="${e(q)}"><button aria-label="검색" type="submit">${F.icon('search')}</button></form>`;
    if(!q)return `<div class="v3-catalog">${form}${heading('검색',false)}<div class="v3-search-intro"><h2>어떤 방송을 찾고 있나요?</h2><p>방송 제목이나 채널 이름으로 검색해 보세요.</p><div class="category-rail">${['개발','게임','그림'].map(t=>F.btn(t,'v3-search-suggestion','search','','data-query="'+t+'"')).join('')}</div></div></div>`;
    const tabs=`<div class="category-rail" aria-label="검색 결과 유형">${['전체','라이브','채널','다시보기','클립'].map(t=>F.btn(t,'v3-search-type','',F.searchType===t?'active':'',`data-type="${t}" aria-pressed="${F.searchType===t}"`)).join('')}</div>`;
    const channels=`<section class="search-section"><h2>채널</h2><div class="search-channel-list">${hits.slice(0,3).map(b=>`<button class="search-channel" data-go="channel" data-broadcast="${F.broadcasts.indexOf(b)}">${F.avatar(b.initial,'round')}<span><strong>${e(b.name)}</strong><small>${e(b.category)}</small></span><span class="search-channel-live">LIVE</span></button>`).join('')}</div></section>`;
    return `<div class="v3-catalog">${form}${heading(`‘${e(q)}’ 검색 결과`,false)}${tabs}${state==='검색 결과 없음'||!hits.length?F.empty('검색 결과가 없어요','다른 제목이나 채널 이름으로 검색해 보세요.','홈으로','go:live','search'):(['전체','채널'].includes(F.searchType)?channels:'')+(F.searchType==='채널'?'':`<section class="search-section"><h2>${['다시보기','클립'].includes(F.searchType)?F.searchType:'라이브'}</h2>${grid(hits,F.searchType==='다시보기'?'vod':F.searchType==='클립'?'clip':'live')}</section>`)}</div>`;
  };
  // Relocate surrounding watch actions without touching the frozen media renderer.
  F.shell=(active,body,extra='')=>{
    const isWatch=['watch','vod-watch','clip-watch'].includes(active);
    if(isWatch){
      const holder=document.createElement('div');holder.innerHTML=body;
      holder.querySelector('.watch-top')?.remove();
      const layout=holder.querySelector('.watch-layout'),player=layout?.querySelector('#video-player');
      if(player){const b=F.broadcasts[F.selectedBroadcast]||F.broadcasts[0],main=document.createElement('div');main.className='v3-watch-main';player.before(main);main.append(player);const meta=document.createElement('section');meta.className='v3-watch-meta';meta.innerHTML=`<h1>${e(b.title)}</h1><div class="v3-watch-details"><button class="v3-watch-channel" data-go="channel" data-broadcast="${F.selectedBroadcast}">${F.avatar(b.initial,'round')}<span><strong>${e(b.name)}</strong><small>${e(b.category)} · ${b.viewers.toLocaleString()}명 시청</small></span></button><div class="v3-watch-actions">${F.btn('팔로우','follow','heart','primary','aria-pressed="false"')}${F.go('share','공유','share','')}${F.go('info','방송 정보','info','')}${!F.chatOpen?F.btn('채팅','chat-toggle','chat',''):''}</div></div>`;main.append(meta);}
      body=holder.innerHTML;
    }
    let html=oldShell(active,body,extra);
    html=html.replace(/<nav class="mobile-nav"[^>]*>[\s\S]*?<\/nav>/,`<nav class="mobile-nav" aria-label="기본 메뉴">${[['live','홈','live'],['following','팔로잉','heart'],['studio','방송하기','live'],['profile','내 설정','user']].map(([id,label,ico])=>`<button data-go="${id}" class="${id===active?'active':''}">${F.icon(ico)}<span>${label}</span></button>`).join('')}</nav>`);
    if(active==='login'){const h=document.createElement('div');h.innerHTML=html;h.querySelector('.app-layout')?.classList.add('v3-login-layout');h.querySelector('.mobile-nav')?.remove();html=h.innerHTML;}
    return html;
  };
})();
