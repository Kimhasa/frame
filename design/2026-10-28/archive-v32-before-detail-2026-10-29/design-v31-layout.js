/* A second UI review: tab semantics, context-aware copy, and layout consistency. */
(()=>{
  const {e}=F,render=F.render,navigate=F.navigate,writeUrl=F.writeUrl,modalBackground=F.modalBackground,search=F.v3Search,share=F.modals.share;
  const entryQuery=new URLSearchParams(location.search).get('q');
  if(F.screen==='search'&&entryQuery!==null)F.searchQuery=entryQuery.trim().slice(0,200);
  F.writeUrl=replace=>{writeUrl(replace);const u=new URL(location.href);if(F.screen==='search'&&F.searchQuery)u.searchParams.set('q',F.searchQuery);else u.searchParams.delete('q');try{history.replaceState({},'',u);}catch{}};
  const sharedModals=new Set(['share','info','nickname','donate','membership','report-content','clip-create','mission','poll','rewards','devices','raid']);
  F.modalBackground=id=>sharedModals.has(id)&&F.v31ModalOrigin?F.v31ModalOrigin:modalBackground(id);
  F.navigate=(id,state,replace=false)=>{
    if(id==='info'&&F.screen!=='info')F.v31ViewerInfoContext={index:F.selectedBroadcast,state:F.viewState,base:F.currentBase};
    if(F.modalScreens.has(id)&&!F.modalScreens.has(F.screen)&&F.screen!=='quality'){F.v31ModalOrigin=F.screen;F.v31ModalOriginState=F.viewState;}
    else if(!F.modalScreens.has(id)){if(F.modalScreens.has(F.screen)&&id===F.v31ModalOrigin&&!state)state=F.v31ModalOriginState;F.v31ModalOrigin=null;F.v31ModalOriginState=null;}
    return navigate(id,state,replace);
  };
  F.v3Search=state=>{
    const h=document.createElement('div');h.innerHTML=search(state);
    h.querySelector('[aria-label="검색 결과 유형"]')?.classList.add('v31-result-tabs');
    return h.innerHTML;
  };
  F.modals.share=state=>{
    const config=share(state),studio=F.currentBase==='studio',b=F.broadcasts[F.selectedBroadcast]||F.broadcasts[0];
    const channel=studio?F.accountDesign.savedChannel.name:b.name,title=studio?F.studioDraft.title:b.title;
    const handle=studio||F.selectedBroadcast===0?F.accountDesign.savedChannel.handle:['spring','seojae','slow-night','green','moa','jido','afternoon','walk'][F.selectedBroadcast]||'channel';
    config.title='공유';config.cls=(config.cls||'')+' v31-share';
    config.body=`<div class="v31-share-summary">${F.avatar(studio?'봄':b.initial,'round')}<div><strong>${e(title)}</strong><p>${e(channel)}</p></div></div><label class="sr-only" for="share-link">시청 주소</label><div class="share-url"><input id="share-link" readonly value="https://frame.example/@${e(handle)}/live" aria-label="시청 주소">${F.btn(state==='복사 완료'?'복사됨':'복사','copy-link',state==='복사 완료'?'check':'copy')}</div>${studio?'':`<div class="v31-share-position"><label>공유할 위치</label>${F.choice('share-option','현재 방송',['현재 방송','현재 재생 시점부터'])}</div>`}`;
    config.footer=F.btn('닫기','close-modal');return config;
  };
  const members=F.pages.members;
  F.pages.members=state=>{
    const h=document.createElement('div');h.innerHTML=members(state);
    if(state==='가입자 없음')h.querySelector('.stats-grid')?.remove();
    return h.innerHTML;
  };
  F.pages.policy=()=>F.page('이용 안내',F.empty('이용 안내를 준비하고 있어요','안내가 등록되면 이곳에서 확인할 수 있어요.','홈으로','go:live','info'));
  const identityKeys=['action','tab','section','type','key','scope','field'];
  const matching=(token,root=F.root)=>[...root.querySelectorAll('button')].find(b=>identityKeys.every(key=>token[key]===b.dataset[key]));
  const tokenOf=b=>b?Object.fromEntries(identityKeys.map(key=>[key,b.dataset[key]])):null;
  function tablist(list,index){
    const buttons=[...list.children].filter(n=>n.matches('button'));if(!buttons.length)return;
    list.setAttribute('role','tablist');
    const selected=buttons.find(b=>b.classList.contains('active')||b.getAttribute('aria-pressed')==='true')||buttons[0];
    const panel=document.createElement('section');panel.className='v31-tab-panel';panel.id='v31-tab-panel-'+index;panel.setAttribute('role','tabpanel');
    let sibling=list.nextElementSibling;while(sibling){const next=sibling.nextElementSibling;panel.append(sibling);sibling=next;}
    list.after(panel);
    buttons.forEach((b,i)=>{b.id=`v31-tab-${index}-${i}`;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(b===selected));b.setAttribute('aria-controls',panel.id);b.removeAttribute('aria-pressed');b.tabIndex=b===selected?0:-1;});
    panel.setAttribute('aria-labelledby',selected.id);
  }
  const duplicateParagraphs=new Set(['나에게 맞는 이용 환경을 설정하세요.','시청자가 만나는 내 채널을 꾸며보세요.','화면을 선택하고, 오늘의 방송을 시작하세요.','방송 화면과 시청자 반응을 한곳에서 확인하세요.','좋아하는 채널과 함께하는 시간을 이어가세요.','계정 정보를 입력해 주세요.']);
  function cleanCopy(){
    F.root.querySelectorAll('.v3-page-heading p,.v3-studio-heading p,.v3-login-title p').forEach(p=>{if(duplicateParagraphs.has(p.textContent.trim()))p.remove();});
    F.root.querySelector('.v3-studio-eyebrow')?.remove();F.root.querySelector('.v3-login-welcome>p')?.remove();F.root.querySelector('.v3-login-browse')?.remove();
    const loginHeading=F.root.querySelector('.v3-login-panel h1');if(loginHeading?.textContent==='계속할 계정을 선택하세요')loginHeading.textContent='사용할 계정을 확인하세요';
    F.root.querySelector('.v2-channel-feature .v2-section-heading .badge')?.remove();
    const about=F.root.querySelector('.v2-channel-about');if(about){about.querySelector('h2').textContent='방송 일정';about.querySelector('p')?.remove();}
    if(F.channelTab==='정보'&&F.currentBase==='channel'){
      F.root.querySelector('.channel-copy>p')?.remove();const section=F.root.querySelector('.v2-public-about');
      if(section){section.querySelector('h2').textContent='채널 소개';if(F.selectedBroadcast===0)section.querySelector('p').textContent=F.accountDesign.savedChannel.bio;}
    }
    const line=F.root.querySelector('.v3-watch-channel small');
    if(line&&F.currentBase!=='watch'||line&&['방송 종료','삭제된 영상','재생 실패','재연결 중','접속자 많음'].includes(F.viewState))line.textContent=(F.broadcasts[F.selectedBroadcast]||F.broadcasts[0]).category;
  }
  function recentControls(){
    const rail=F.root.querySelector('.v3-resume-grid');if(!rail)return;
    rail.id='v31-recent-rail';rail.setAttribute('aria-label','이어서 시청하기');
    const head=rail.previousElementSibling,controls=document.createElement('div');controls.className='v31-recent-controls';
    controls.innerHTML=F.btn('','v31-layout-recent-prev','arrow','','aria-label="이전 영상" aria-controls="v31-recent-rail"')+F.btn('','v31-layout-recent-next','right','','aria-label="다음 영상" aria-controls="v31-recent-rail"');
    const more=head?.querySelector('[data-go="history"]');if(more)more.before(controls);else head?.append(controls);
    const update=()=>{const distance=rail.scrollWidth-rail.clientWidth;controls.hidden=distance<3;controls.children[0].disabled=rail.scrollLeft<2;controls.children[1].disabled=rail.scrollLeft>distance-2;};
    rail.addEventListener('scroll',update,{passive:true});rail._v31Update=update;requestAnimationFrame(update);
  }
  F.render=()=>{
    const anchor=F.activeSelect?.anchor;
    const focused=document.activeElement?.closest?.('.page-tabs button,.v3-account-tabs button,.v31-result-tabs button,.v3-settings-nav button,[role="switch"][data-action]')||(anchor&&F.root.contains(anchor)&&!anchor.closest('.player')?anchor:null),token=tokenOf(focused);
    if(F.screen==='search'&&F.viewState==='검색 결과 없음'&&!F.searchQuery.trim()){F.searchQuery='123';F.writeUrl(true);}
    render();
    if(!['watch','vod-watch','clip-watch'].includes(F.currentBase))F.root.classList.remove('wide-mode');
    cleanCopy();F.root.querySelectorAll('.page-tabs:has([data-action="v2-channel-tab"]),.v3-account-tabs,.v31-result-tabs').forEach((list,i)=>tablist(list,i));recentControls();
    const skeletons=F.root.querySelectorAll('.skeleton-card');if(skeletons.length){const main=F.root.querySelector('main');main.setAttribute('aria-busy','true');skeletons.forEach(n=>n.setAttribute('aria-hidden','true'));const announcement=document.createElement('span');announcement.className='sr-only';announcement.setAttribute('role','status');announcement.textContent='방송 목록을 불러오는 중입니다.';main.prepend(announcement);}
    if(token){const b=matching(token);b?.focus({preventScroll:true});b?.scrollIntoView({block:'nearest',inline:'nearest'});}
  };
  document.addEventListener('click',event=>{
    const b=event.target.closest?.('[data-action^="v31-layout-recent-"]');if(!b)return;
    event.preventDefault();event.stopImmediatePropagation();const rail=F.root.querySelector('.v3-resume-grid');if(!rail)return;
    rail.scrollBy({left:(b.dataset.action.endsWith('next')?1:-1)*(rail.clientWidth+parseFloat(getComputedStyle(rail).columnGap)),behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});
  },true);
  document.addEventListener('keydown',event=>{
    const b=event.target.closest?.('[role="tablist"]>[role="tab"]');if(!b||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopImmediatePropagation();const buttons=[...b.parentElement.querySelectorAll(':scope>button')],i=buttons.indexOf(b),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    const token=tokenOf(buttons[next]);buttons[next].click();const target=matching(token);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});
  },true);
  window.addEventListener('resize',()=>F.root.querySelector('.v3-resume-grid')?._v31Update?.(),{passive:true});
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  F.render();
})();
