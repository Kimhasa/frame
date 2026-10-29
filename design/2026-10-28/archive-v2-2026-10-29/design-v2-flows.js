(() => {
  const { e, icon } = F;
  const baseCatalog = F.catalog;
  const baseHeader = F.header;
  const baseSidebar = F.sidebar;
  F.channelTab = '홈';
  F.searchQuery = '';
  F.searchType = '전체';
  F.selectedBroadcast = 0;
  const selected = () => F.broadcasts[F.selectedBroadcast] || F.broadcasts[0];
  const indexOf = b => Math.max(0, F.broadcasts.indexOf(b));
  const channelButton = (b, label, cls = '') => `<button type="button" class="${cls}" data-go="channel" data-broadcast="${indexOf(b)}" aria-label="${e(b.name)} 채널 보기">${label}</button>`;

  // Separate watch and channel targets; avoid nested buttons inside a card.
  F.card = (b, index = 0, mode = 'live') => {
    const target = mode === 'vod' ? 'vod-watch' : mode === 'clip' ? 'clip-watch' : 'watch';
    const attrs = `data-go="${target}" data-broadcast="${indexOf(b)}"`;
    const label = `${e(b.title)} ${mode === 'live' ? '시청하기' : '재생하기'}`;
    return `<article class="broadcast-card v2-card">
      <button type="button" class="thumb" ${attrs} aria-label="${label}">${F.v2Visual(b,index)}<span class="v2-play">${icon('play')}</span>${mode === 'live' ? `<span class="v2-live-badge"><span></span>라이브</span><span class="v2-viewers">${b.viewers.toLocaleString()}명 시청 중</span>` : `<span class="duration">${mode === 'clip' ? '00:42' : ['2:14:36','1:48:12','3:08:45'][index%3]}</span>`}</button>
      <div class="card-info">${channelButton(b,F.avatar(b.initial,'round'),'card-profile')}<div class="card-text"><button type="button" class="card-title" ${attrs}>${e(b.title)}</button>${channelButton(b,e(b.name),'card-sub')}<span class="card-category">${e(mode === 'live' ? b.category : mode === 'clip' ? '조회 312회 · 1일 전' : '조회 1.2천회 · 2일 전')}</span></div></div>
    </article>`;
  };

  F.header = () => {
    const holder = document.createElement('div');
    holder.innerHTML = baseHeader();
    holder.querySelector('input[name=query]').setAttribute('value',F.currentBase === 'search' ? F.searchQuery : '');
    holder.querySelector('.header-profile').setAttribute('aria-label','내 프로필');
    return holder.innerHTML;
  };

  F.sidebar = active => {
    const holder=document.createElement('div');holder.innerHTML=baseSidebar(active);
    holder.querySelectorAll('.side-channel').forEach((b,i)=>b.setAttribute('data-broadcast',i));
    return holder.innerHTML;
  };

  F.catalog = (id,state) => {
    if(id !== 'search') return baseCatalog(id,state);
    const query = F.searchQuery || '작업';
    const q = query.replaceAll(' ','').toLowerCase();
    const hits = F.broadcasts.filter(b => `${b.title}${b.name}${b.category}`.replaceAll(' ','').toLowerCase().includes(q));
    const tabs = `<div class="category-rail" aria-label="검색 결과 유형">${['전체','라이브','채널','다시보기','클립'].map(t=>`<button data-action="v2-search-type" data-type="${t}" class="${F.searchType===t?'active':''}" aria-pressed="${F.searchType===t}">${t}</button>`).join('')}</div>`;
    const heading = `<form class="search-field v2-mobile-search" id="catalog-search">${icon('search')}<input name="query" type="search" aria-label="방송 제목, 채널 검색" placeholder="방송, 채널 검색" value="${e(F.searchQuery)}"><button type="submit" aria-label="검색">${icon('right')}</button></form><div class="v2-catalog-heading"><h1>‘${e(query)}’ 검색 결과</h1></div>${tabs}`;
    if(state === '검색 결과 없음' || !hits.length) return heading + F.empty('검색 결과가 없어요','다른 제목이나 채널 이름으로 찾아보세요.','라이브 둘러보기','go:live','search');
    const channels = `<section class="search-section"><h2>채널</h2><div class="search-channel-list">${hits.slice(0,3).map(b=>channelButton(b,`${F.avatar(b.initial,'round')}<span><strong>${e(b.name)}</strong><small>${e(b.category)} · 팔로워 1.2천명</small></span><span class="search-channel-live">방송 중</span>`,'search-channel')).join('')}</div></section>`;
    const section = (name,mode) => `<section class="search-section"><h2>${name}</h2><div class="catalog-grid">${hits.map((b,i)=>F.card(b,i,mode)).join('')}</div></section>`;
    return heading + (['전체','채널'].includes(F.searchType)?channels:'') + (['전체','라이브'].includes(F.searchType)?section('라이브','live'):'') + (F.searchType==='다시보기'?section('다시보기','vod'):'') + (F.searchType==='클립'?section('클립','clip'):'');
  };

  F.channel = state => {
    const b = selected(), tab = F.channelTab;
    const tabs = `<div class="page-tabs" aria-label="채널 메뉴">${['홈','다시보기','클립','방송 일정','정보'].map(t=>`<button data-action="v2-channel-tab" data-tab="${t}" class="${t===tab?'active':''}" aria-pressed="${t===tab}">${t}</button>`).join('')}</div>`;
    const videos = mode => `<div class="catalog-grid">${[0,1,2].map((_,i)=>F.card(b,i,mode)).join('')}</div>`;
    const replays = `<section class="v2-recent"><div class="v2-section-heading"><h2>최근 다시보기</h2>${F.btn('모두 보기','v2-channel-tab','right','ghost small','data-tab="다시보기"')}</div>${videos('vod')}</section>`;
    let content;
    if(state==='접근 제한') content=F.empty('접근할 수 없는 채널이에요','채널의 공개 범위를 확인해 주세요.','라이브로 이동','go:live','shield');
    else if(tab==='정보') content=`<section class="v2-public-about"><h2>${e(b.name)}의 채널</h2><p>좋아하는 것을 만들고, 배우고, 이야기하는 시간을 나눕니다.</p><dl><div><dt>주요 콘텐츠</dt><dd>${e(b.category)}</dd></div><div><dt>방송 일정</dt><dd>화·목 오후 8시</dd></div><div><dt>채널 시작일</dt><dd>2026년 8월 12일</dd></div></dl></section>`;
    else if(tab==='방송 일정') content=`<section class="v2-public-schedule"><div class="v2-section-heading"><h2>다가오는 방송</h2><span>2026년 10월</span></div>${[['29','목요일 · 오후 8:00','함께 만드는 작은 기능'],['31','토요일 · 오후 3:00','한 주의 작업, 같이 정리해요']].map(([day,time,title])=>`<article><time><span>10월</span><strong>${day}</strong></time><div><small>${time}</small><h3>${title}</h3><p>${e(b.name)}</p></div>${F.btn('알림 받기','v2-remind','bell','','aria-pressed="false"')}</article>`).join('')}</section>`;
    else if(tab==='다시보기'||tab==='클립') content=`<section class="search-section"><h2>${tab}</h2>${videos(tab==='클립'?'clip':'vod')}</section>`;
    else content=(state==='오프라인'?`<div class="v2-channel-offline"><span>${icon('video')}</span><div><h2>지금은 쉬어가는 중이에요</h2><p>팔로우하고 다음 방송 소식을 받아보세요.</p></div>${F.btn('다시보기 보기','v2-channel-tab','right','','data-tab="다시보기"')}</div>`:`<div class="v2-channel-feature"><div><div class="v2-section-heading"><h2>라이브</h2>${F.pill('방송 중')}</div>${F.card(b)}</div><aside class="v2-channel-about"><h2>채널 소개</h2><p>작은 진전을 함께 나누는 시간. 편하게 들렀다 가세요.</p><div class="channel-schedule">${icon('calendar')}화·목 오후 8시</div>${F.btn('방송 일정 보기','v2-channel-tab','right','ghost small','data-tab="방송 일정"')}</aside></div>`)+replays;
    return `<div class="v2-channel-cover"><img src="./assets/editorial/creative-studio.png" alt="채널 작업실"><div></div><span>작은 진전을, 함께.</span></div><div class="v2-channel-profile">${F.avatar(b.initial,'round')}<div class="channel-copy"><h1>${e(b.name)}</h1><div class="channel-meta"><span>@${['spring','seojae','slow-night','green','moa','jido'][F.selectedBroadcast]}</span><span>팔로워 1,284명</span></div><p>만들고 배우는 시간을 나누는 작은 작업실. 편하게 들렀다 가세요.</p></div><div class="row">${F.btn('팔로우','follow','heart','primary','aria-pressed="false"')}${F.go('membership','멤버십','','v2-membership')}${F.btn('후원하기','go:donate','gift','')}</div></div>${tabs}${content}`;
  };

  document.addEventListener('click',ev=>{
    const b=ev.target.closest('button');if(!b)return;
    if(b.dataset.broadcast!==undefined){F.selectedBroadcast=Number(b.dataset.broadcast);if(b.dataset.go==='channel')F.channelTab='홈';}
    if(b.dataset.action==='v2-channel-tab'){F.channelTab=b.dataset.tab;F.render();}
    if(b.dataset.action==='v2-search-type'){F.searchType=b.dataset.type;F.render();}
    if(b.dataset.action==='v2-remind'){const on=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',String(on));b.innerHTML=icon(on?'check':'bell')+(on?'알림 설정됨':'알림 받기');}
  },true);
  document.addEventListener('submit',ev=>{
    if(['header-search','catalog-search'].includes(ev.target.id)){F.searchQuery=String(new FormData(ev.target).get('query')||'').trim();F.searchType='전체';}
  },true);
})();
