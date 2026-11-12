/* Viewer sidebar only. Existing navigation, authentication, follow and theater owners retain their actions. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.sidebar||!F.header||!F.render||F.v53Sidebar)return;
  const old={sidebar:F.sidebar,header:F.header,render:F.render},e=F.e;
  const first=[['live','홈','home','홈'],['vod','다시보기','video','다시보기'],['clips','클립','clip','클립']];
  const second=[['following','팔로잉','heart','팔로잉'],['history','시청 기록','history','기록']];
  const S=F.v53Sidebar={scrollTop:0};let pending=false,restoreScroll=false;
  const navIcon=name=>name==='home'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10.5 9-7.5 9 7.5M5 9v12h5v-7h4v7h5V9"/></svg>':F.icon(name);
  const side=()=>F.root.querySelector('.v53-sidebar');
  const isLive=index=>F.v42Following?.isLive?F.v42Following.isLive(index):F.broadcasts[index]?.live!==false&&!['offline','ended','오프라인','방송 종료','종료'].includes(F.broadcasts[index]?.status);
  const members=()=>F.sessionLoggedIn&&!(F.screen==='following'&&F.viewState==='로그인 필요')?[...(F.v33Viewer?.following||[])].filter(index=>Number.isInteger(index)&&!!F.broadcasts[index]).sort((a,b)=>Number(isLive(b))-Number(isLive(a))||(Number(F.broadcasts[b].viewers)||0)-(Number(F.broadcasts[a].viewers)||0)||a-b):[];
  const collapsed=()=>F.root.classList.contains('v2-navigation-compact')||!!F.wide;
  function nav(items,active,label){
    return '<nav class="v53-navigation" aria-label="'+label+'">'+items.map(([id,name,icon,short])=>'<button type="button" id="v53-nav-'+id+'" data-go="'+id+'" class="'+(id===active?'nav-active':'')+'" aria-label="'+name+'"'+(id===active?' aria-current="page"':'')+'>'+navIcon(icon)+'<span class="nav-label">'+name+'</span><span class="v53-nav-short" aria-hidden="true">'+short+'</span></button>').join('')+'</nav>';
  }
  function following(){
    const list=members();if(!list.length)return '';
    return '<section class="followed-navigation v53-followed" aria-label="팔로우한 채널"><div class="side-heading">팔로우한 채널</div>'+list.slice(0,5).map(index=>{
      const b=F.broadcasts[index],live=isLive(index),value=Number(b.viewers),count=Number.isFinite(value)?Math.max(0,value).toLocaleString('ko-KR'):null;
      const status=live?(count===null?'방송 중':count+'명 시청'):'오프라인';
      return '<button type="button" class="side-channel" data-go="channel" data-broadcast="'+index+'" aria-label="'+e(b.name)+' 채널, '+status+'">'+F.avatar(b.initial,'round')+'<span class="side-channel-name" title="'+e(b.name)+'">'+e(b.name)+'</span><span class="v53-channel-status'+(live?' is-live':'')+'">'+(live?'<span class="channel-live-dot" aria-hidden="true"></span>':'')+'<span>'+e(status)+'</span></span></button>';
    }).join('')+(list.length>5?'<button type="button" class="side-more" data-action="v53-sidebar-more">'+F.icon('chevron')+'<span>더 보기</span></button>':'')+'</section>';
  }
  function sync(){
    pending=false;const node=side(),managed=!!node;
    F.root.classList.toggle('v53-viewer-navigation',managed);
    if(!node)return;
    if(restoreScroll){node.scrollTop=S.scrollTop;restoreScroll=false;}
    const compact=collapsed();
    F.root.querySelectorAll('[data-action="v3-menu"],[data-action="v2-menu"]').forEach(button=>{
      const label=compact?'메뉴 펼치기':'메뉴 접기';button.setAttribute('aria-label',label);button.setAttribute('aria-expanded',String(!compact));button.setAttribute('aria-controls','v53-viewer-sidebar');
      button.title=label;button.dataset.ui52Tooltip=label;
    });
  }
  function schedule(){if(!pending){pending=true;queueMicrotask(sync);}}
  F.sidebar=active=>{
    const html=old.sidebar(active),host=document.createElement('div');host.innerHTML=html;
    const previous=host.querySelector('.sidebar');
    if(!previous||previous.dataset.v35Navigation==='creator'||previous.querySelector('.v3-side-context'))return html;
    const current=side();if(current)S.scrollTop=current.scrollTop;restoreScroll=true;
    const aside=document.createElement('aside');aside.className='sidebar v3-sidebar v53-sidebar';aside.id='v53-viewer-sidebar';aside.setAttribute('aria-label','기본 메뉴');
    aside.innerHTML=nav(first,active,'둘러보기')+nav(second,active,'내 활동')+following();
    previous.replaceWith(aside);schedule();return host.innerHTML;
  };
  F.header=()=>{
    const host=document.createElement('div');host.innerHTML=old.header();
    const menu=host.querySelector('#v3-profile-menu');
    if(menu&&!menu.querySelector('[data-go="policy"]')){
      const settings=menu.querySelector('[data-go="profile"]');
      if(settings)settings.insertAdjacentHTML('afterend',F.go('policy','도움말','info'));
    }
    return host.innerHTML;
  };
  F.render=(...args)=>{const result=old.render(...args);sync();return result;};
  document.addEventListener('scroll',event=>{if(event.target?.matches?.('.v53-sidebar'))S.scrollTop=event.target.scrollTop;},true);
  window.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-action="v53-sidebar-more"]');if(!button||button.disabled)return;
    event.preventDefault();event.stopImmediatePropagation();F.navigate('following');F.v42Following?.setTab('channels');
  },true);
  // Theater and manual collapse already update this class without rendering the player.
  if(F.root instanceof Element)new MutationObserver(records=>{if(records.some(record=>record.target===F.root&&record.attributeName==='class'))schedule();}).observe(F.root,{attributes:true,attributeFilter:['class']});
  Object.assign(S,{refresh:sync,getState(){const node=side();return {supported:!!node,collapsed:collapsed(),manualCollapsed:F.root.classList.contains('v2-navigation-compact'),wide:!!F.wide,width:node?.getBoundingClientRect().width??null,scrollTop:node?.scrollTop??null,navOrder:[...node?.querySelectorAll('.v53-navigation [data-go]')||[]].map(button=>button.dataset.go),active:node?.querySelector('[aria-current="page"]')?.dataset.go||null,followed:members(),visibleFollowed:[...node?.querySelectorAll('.side-channel')||[]].map(button=>Number(button.dataset.broadcast)),moreVisible:!!node?.querySelector('[data-action="v53-sidebar-more"]')};}});
  F.render();
})();
