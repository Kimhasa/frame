(() => {
  const navigate=F.navigate,render=F.render,publicChannel=F.channel;
  F.channel=state=>{
    let html=publicChannel(state).replace('@undefined',F.selectedBroadcast===6?'@afternoon':'@walk');
    if(F.selectedBroadcast!==0)return html;
    const account=F.accountDesign,channel=account.savedChannel,h=document.createElement('div');h.innerHTML=html;
    h.querySelector('.channel-copy h1').textContent=channel.name;
    h.querySelector('.channel-copy p').textContent=channel.bio;
    h.querySelector('.channel-meta>span').textContent='@'+channel.handle;
    const banner=h.querySelector('.v2-channel-cover>img');banner.src=account.savedAppearance.uploadedBanner||`./assets/editorial/${account.savedAppearance.banner}.png`;
    return h.innerHTML;
  };
  const owned=new Set(['profile','preferences','security','channel-edit','studio','recordings','schedule','moderation','creator-stats','revenue']);
  F.navigate=(id,state,replace=false)=>{
    if(!F.sessionLoggedIn&&owned.has(id)){F.authReturn=id;id='login';state=undefined;}
    const changed=F.currentBase!==id&&!F.modalScreens.has(id);
    F.profileMenuOpen=false;navigate(id,state,replace);
    if(changed){window.scrollTo({top:0,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top:0});}
  };
  F.render=()=>{F.broadcasts[0].name=F.accountDesign.savedChannel.name;render();F.root.classList.toggle('v3-login-shell',F.currentBase==='login');};
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  const closeProfile=()=>{
    F.profileMenuOpen=false;document.getElementById('v3-profile-menu')?.setAttribute('hidden','');
    document.querySelector('[data-action="v3-profile-menu"]')?.setAttribute('aria-expanded','false');
  };
  const rootActions=new Set(['v3-profile-menu','v3-menu','v3-logout','v3-my-channel','v3-filter','v3-sort','v3-search-type','v3-search-suggestion']);
  document.addEventListener('click',ev=>{
    const b=ev.target.closest('button'),action=b?.dataset.action;
    if(b?.dataset.go==='channel'&&b.closest('.v3-account')){F.selectedBroadcast=0;F.channelTab='홈';}
    if(F.profileMenuOpen&&!ev.target.closest('.v3-profile-anchor'))closeProfile();
    if(!rootActions.has(action))return;
    ev.preventDefault();ev.stopImmediatePropagation();
    if(action==='v3-profile-menu'){
      F.profileMenuOpen=!F.profileMenuOpen;const menu=document.getElementById('v3-profile-menu');
      menu.hidden=!F.profileMenuOpen;b.setAttribute('aria-expanded',String(F.profileMenuOpen));
      if(F.profileMenuOpen)menu.querySelector('button')?.focus({preventScroll:true});
    }
    if(action==='v3-menu'){F.root.classList.toggle('v2-navigation-compact');b.setAttribute('aria-label',F.root.classList.contains('v2-navigation-compact')?'메뉴 펼치기':'메뉴 접기');}
    if(action==='v3-logout'){F.sessionLoggedIn=false;F.navigate('live');F.toast('로그아웃했어요.');}
    if(action==='v3-my-channel'){F.selectedBroadcast=0;F.channelTab='홈';F.navigate('channel');}
    if(action==='v3-filter'){F.v2Category=b.dataset.category;F.render();F.root.querySelector(`[data-category="${F.v2Category}"]`)?.focus({preventScroll:true});}
    if(action==='v3-sort')F.openChoice(b,['추천순','시청자순','최신순'],F.v2Sort,value=>{F.v2Sort=value;F.render();F.root.querySelector('[data-action="v3-sort"]')?.focus({preventScroll:true});});
    if(action==='v3-search-type'){F.searchType=b.dataset.type;F.render();F.root.querySelector(`[data-type="${F.searchType}"]`)?.focus({preventScroll:true});}
    if(action==='v3-search-suggestion'){F.searchQuery=b.dataset.query;F.searchType='전체';F.navigate('search');}
  },true);
  document.addEventListener('submit',ev=>{
    if(!['header-search','catalog-search'].includes(ev.target.id))return;
    ev.preventDefault();ev.stopImmediatePropagation();
    F.searchQuery=String(new FormData(ev.target).get('query')||'').trim();F.searchType='전체';F.navigate('search');
    if(!F.searchQuery)F.root.querySelector('#catalog-search input,.header-search input')?.focus({preventScroll:true});
  },true);
  document.addEventListener('keydown',ev=>{
    const menu=document.getElementById('v3-profile-menu');
    if(!F.profileMenuOpen||!menu)return;
    if(ev.key==='Escape'){ev.preventDefault();ev.stopImmediatePropagation();closeProfile();document.querySelector('[data-action="v3-profile-menu"]')?.focus();}
    if(['ArrowDown','ArrowUp'].includes(ev.key)){ev.preventDefault();const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);buttons[(i+(ev.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  },true);
  F.notes=()=>F.reviewDialog('시안 검토 기준',`${F.dl([['시안 버전','3.0 · 2026.10.29'],['이번 상세 화면','홈 · 로그인 · 내 설정 · 채널 관리 · 방송 준비 · 방송 중'],['기존 유지','영상·플레이어·화질 제어 원본'],['개발 상태','디자인 시안 · 실제 앱 코드 변경 없음']])}<p class="help" style="margin-top:18px">인증·방송·결제·통계는 로컬 디자인 검토용 동작입니다. 실제 서비스와 연결되지 않습니다.</p>`);
  const entryTab=new URLSearchParams(location.search).get('tab');
  if(F.screen==='channel-edit'&&['branding','permissions'].includes(entryTab))F.accountDesign.channelTab=entryTab==='branding'?'브랜딩':'권한';
  F.render();
})();
