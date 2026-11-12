/* UIF-020: local following-list design state only. No account, list or media API is called. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.catalog||!F.v33Viewer||F.v42Following)return;
  const old={catalog:F.catalog,sidebar:F.sidebar,render:F.render,navigate:F.navigate};
  const store=F.v33Viewer.following,e=F.e;
  const S=F.v42Following={tab:'live',query:'',sorts:{live:'시청자순',channels:'이름순'},loadState:'ready',retryTransport:null,liveOverrides:new Map(),composing:false,loginReturn:null,snapshot:null,lastScreen:F.screen};
  const collator=new Intl.Collator('ko-KR',{numeric:true,sensitivity:'base'});
  let retryToken=0,restoreFrame=0;
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const button=(text,action,icon='',cls='',attrs='')=>F.btn(text,'v42-following-'+action,icon,cls,attrs);
  const valid=index=>Number.isInteger(index)&&!!F.broadcasts[index];
  const isLive=index=>S.liveOverrides.has(index)?S.liveOverrides.get(index):F.broadcasts[index]?.live!==false&&!['offline','ended','오프라인','방송 종료','종료'].includes(F.broadcasts[index]?.status);
  const members=()=>[...store].filter(valid);
  const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g,'');
  const matches=index=>!normalize(S.query)||normalize(F.broadcasts[index].name).includes(normalize(S.query));
  const signedOut=()=>!F.sessionLoggedIn||(F.screen==='following'&&F.viewState==='로그인 필요');
  const fixtureEmpty=()=>F.screen==='following'&&F.viewState==='팔로우 없음';
  const all=()=>fixtureEmpty()?[]:members();
  const options=()=>S.tab==='live'?['시청자순','이름순']:['이름순','방송 중순'];
  const canSort=()=>!signedOut()&&S.loadState==='ready'&&rows().length>1;
  function rows(){
    const result=all().filter(index=>(S.tab==='channels'||isLive(index))&&matches(index));
    return result.sort((a,b)=>{
      const byName=collator.compare(F.broadcasts[a].name,F.broadcasts[b].name)||a-b;
      if(S.tab==='live'&&S.sorts.live==='시청자순')return (Number(F.broadcasts[b].viewers)||0)-(Number(F.broadcasts[a].viewers)||0)||byName;
      if(S.tab==='channels'&&S.sorts.channels==='방송 중순')return Number(isLive(b))-Number(isLive(a))||byName;
      return byName;
    });
  }
  function empty(title,actionText,action,icon='heart',secondary=''){
    return '<section class="v42-following-empty"><span class="v42-empty-icon" aria-hidden="true">'+F.icon(icon)+'</span><h2>'+e(title)+'</h2><div class="v42-empty-actions">'+button(actionText,action,'','primary')+secondary+'</div></section>';
  }
  function liveCard(index){
    const host=document.createElement('div');host.innerHTML=F.card(F.broadcasts[index],index,'live');
    const card=host.firstElementChild,id=F.v38Viewer?.contentIdFor('live',index)||'live-'+index;
    card.id='v42-following-live-'+index;card.dataset.v42Index=index;card.dataset.v38Content=id;
    card.querySelectorAll('[data-go]').forEach((node,ordinal)=>{
      node.dataset.broadcast=index;node.id='v42-following-live-'+index+'-'+ordinal;node.dataset.v42Return=node.id;
      if(node.dataset.go==='watch')node.dataset.v38Content=id;
    });
    return host.innerHTML;
  }
  function channelCard(index){
    const b=F.broadcasts[index],live=isLive(index),count=Math.max(0,Number(b.viewers)||0).toLocaleString('ko-KR');
    return '<button type="button" class="v42-following-channel" id="v42-following-channel-'+index+'" data-v42-return="v42-following-channel-'+index+'" data-v42-index="'+index+'" data-go="channel" data-broadcast="'+index+'" aria-label="'+e(b.name)+' 채널 보기">'+F.avatar(b.initial,'round')+'<span class="v42-channel-copy"><strong title="'+e(b.name)+'">'+e(b.name)+'</strong><small>'+(live?'<span class="v42-live-mark">방송 중</span><span>'+count+'명 시청</span>':'<span class="v42-offline">오프라인</span>')+'</small></span>'+F.icon('right')+'</button>';
  }
  function loadingResults(){
    const content=S.tab==='channels'?'<div class="v42-following-channel-grid v42-channel-skeleton" aria-hidden="true">'+Array.from({length:6},()=>'<div class="v42-following-channel"><span class="v42-skeleton-avatar skeleton"></span><span class="v42-channel-copy"><span class="v42-skeleton-name skeleton"></span><span class="v42-skeleton-meta skeleton"></span></span></div>').join('')+'</div>':'<div class="v42-following-skeleton v3-grid" aria-hidden="true">'+Array.from({length:6},()=>'<div class="skeleton-card"><div class="thumb skeleton"></div><div class="lines"><span class="skeleton"></span><span class="skeleton"></span></div></div>').join('')+'</div>';
    return content+'<span class="sr-only" role="status">팔로잉을 불러오는 중이에요.</span>';
  }
  function results(){
    if(signedOut())return empty('팔로잉을 보려면 로그인하세요','로그인','login','user');
    if(S.loadState==='loading')return loadingResults();
    if(S.loadState==='error')return '<div role="alert">'+empty('팔로잉을 불러오지 못했어요','다시 시도','retry','refresh')+'</div>';
    if(!all().length)return empty('아직 팔로우한 채널이 없어요','라이브 둘러보기','browse');
    const list=rows();
    if(!list.length){
      if(normalize(S.query)){
        const offlineMatch=S.tab==='live'&&all().some(index=>!isLive(index)&&matches(index));
        return offlineMatch?empty('방송 중인 검색 결과가 없어요','전체 채널에서 찾기','channels','search',button('검색어 지우기','clear-query','','ghost')):empty('검색 결과가 없어요','검색어 지우기','clear-query','search');
      }
      return empty('지금 방송 중인 채널이 없어요','전체 채널 보기','channels','live');
    }
    return '<div class="'+(S.tab==='live'?'catalog-grid v3-grid v42-following-live-grid':'v42-following-channel-grid')+'">'+list.map(S.tab==='live'?liveCard:channelCard).join('')+'</div>';
  }
  function toolbar(){
    const total=all(),live=total.filter(isLive).length;
    return '<div class="v42-following-toolbar"><div class="v42-following-tabs" role="tablist" aria-label="팔로잉 유형">'+[['live','방송 중',live],['channels','전체 채널',total.length]].map(([id,title,count])=>button(e(title)+'<span class="v42-tab-count">'+count+'</span>','tab','','', 'id="v42-following-tab-'+id+'" role="tab" aria-controls="v42-following-results" aria-selected="'+(S.tab===id)+'" tabindex="'+(S.tab===id?0:-1)+'" data-tab="'+id+'"')).join('')+'</div><form class="v42-following-search" id="v42-following-search" role="search">'+F.icon('search')+'<label class="sr-only" for="v42-following-query">팔로우한 채널 검색</label><input id="v42-following-query" type="search" name="following-query" placeholder="팔로우한 채널 검색" value="'+e(S.query)+'" autocomplete="off" maxlength="120">'+button('','clear-query','close','icon ghost','aria-label="검색어 지우기" '+(S.query?'':'hidden'))+'</form>'+button(e(S.sorts[S.tab])+F.icon('chevron'),'sort','','v42-following-sort','aria-label="팔로잉 정렬" aria-haspopup="listbox" aria-expanded="false"')+'</div>';
  }
  function visibleTools(){return !signedOut()&&(all().length>0||S.loadState!=='ready');}
  F.catalog=(id,state)=>id!=='following'?old.catalog(id,state):'<section class="v3-catalog v42-following" aria-labelledby="v42-following-title"><div class="v3-section-heading"><h1 id="v42-following-title">팔로잉</h1></div><div id="v42-following-controls"'+(visibleTools()?'':' hidden')+'>'+toolbar()+'</div><div id="v42-following-results" role="tabpanel" aria-labelledby="v42-following-tab-'+S.tab+'" aria-busy="'+(S.loadState==='loading'&&!signedOut())+'">'+results()+'</div><p id="v42-following-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p></section>';
  F.sidebar=active=>{
    const host=document.createElement('div');host.innerHTML=old.sidebar(active);
    const group=host.querySelector('.followed-navigation');if(!group)return host.innerHTML;
    if(signedOut()||!members().length){group.remove();return host.innerHTML;}
    group.innerHTML='<div class="side-heading">팔로우한 채널</div>'+members().map(index=>{const b=F.broadcasts[index];return '<button type="button" class="side-channel" data-go="channel" data-broadcast="'+index+'" aria-label="'+e(b.name)+' 채널 보기, '+(isLive(index)?'방송 중':'오프라인')+'">'+F.avatar(b.initial,'round')+'<span class="side-channel-name">'+e(b.name)+'</span>'+(isLive(index)?'<span class="channel-live-dot" aria-hidden="true"></span>':'')+'</button>';}).join('');
    return host.innerHTML;
  };
  function refreshSidebar(){
    const side=F.root.querySelector('.sidebar');if(!side)return;
    const host=document.createElement('div');host.innerHTML=F.sidebar(F.currentBase);
    const next=host.querySelector('.followed-navigation'),existing=side.querySelector('.followed-navigation');
    if(existing){if(next)existing.replaceWith(next);else existing.remove();}
    else if(next){const bottom=side.querySelector('.sidebar-bottom');if(bottom)bottom.before(next);else side.append(next);}
  }
  function updateResults(announce=true){
    if(F.screen!=='following')return;
    const page=F.root.querySelector('.v42-following'),area=page?.querySelector('#v42-following-results');if(!area)return;
    const controls=page.querySelector('#v42-following-controls');controls.hidden=!visibleTools();
    const total=all();
    page.querySelectorAll('[role="tab"]').forEach(tab=>{const active=tab.dataset.tab===S.tab;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.querySelector('.v42-tab-count').textContent=tab.dataset.tab==='live'?total.filter(isLive).length:total.length;});
    const sort=page.querySelector('[data-action="v42-following-sort"]');sort.innerHTML=e(S.sorts[S.tab])+F.icon('chevron');sort.hidden=!canSort();
    const clear=page.querySelector('.v42-following-search [data-action="v42-following-clear-query"]');clear.hidden=!S.query;
    area.setAttribute('aria-labelledby','v42-following-tab-'+S.tab);area.setAttribute('aria-busy',String(S.loadState==='loading'&&!signedOut()));area.innerHTML=results();
    const status=page.querySelector('#v42-following-status');
    status.textContent=announce&&!signedOut()&&S.loadState==='ready'?rows().length+'개 '+(S.tab==='live'?'방송':'채널'):'';
  }
  function refresh(){
    refreshSidebar();
    if(F.screen==='following'){
      const input=F.root.querySelector('#v42-following-query');if(input&&input.value!==S.query&&!S.composing)input.value=S.query;
      updateResults(false);
    }
  }
  function setTab(value,focus=false){
    if(!['live','channels'].includes(value))return;S.tab=value;updateResults();
    if(focus)F.root.querySelector('#v42-following-tab-'+value)?.focus({preventScroll:true});
  }
  function setQuery(value){S.query=String(value??'').slice(0,120);const input=F.root.querySelector('#v42-following-query');if(input)input.value=S.query;updateResults();}
  function remember(target){
    if(F.screen!=='following')return;
    const focused=target?.closest?.('[data-v42-return]')||document.activeElement?.closest?.('[data-v42-return]');
    S.snapshot={x:scrollX,y:scrollY,mainTop:F.root.querySelector('#main-content')?.scrollTop||0,focus:focused?.dataset.v42Return||S.snapshot?.focus||'v42-following-query'};
  }
  function restore(){
    if(!S.snapshot||F.screen!=='following')return;cancelAnimationFrame(restoreFrame);
    restoreFrame=requestAnimationFrame(()=>{if(F.screen!=='following')return;const snap=S.snapshot;window.scrollTo({left:snap.x,top:snap.y,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top:snap.mainTop});const target=[document.getElementById(snap.focus),F.root.querySelector('#v42-following-query'),F.root.querySelector('#v42-following-title')].find(node=>node&&!node.disabled&&node.getClientRects().length);if(target){if(target.id==='v42-following-title')target.tabIndex=-1;target.focus({preventScroll:true});}});
  }
  async function retry(){
    if(S.loadState==='loading')return;const token=++retryToken;S.loadState='loading';updateResults();
    try{const value=S.retryTransport?await S.retryTransport({tab:S.tab,query:S.query,sort:S.sorts[S.tab]}):await Promise.resolve();if(value===false)throw new Error('local fixture error');if(token!==retryToken)return;S.loadState='ready';}
    catch{if(token!==retryToken)return;S.loadState='error';}
    updateResults();const target=F.root.querySelector(S.loadState==='error'?'[data-action="v42-following-retry"]':'#v42-following-query');target?.focus({preventScroll:true});
  }
  function beginLogin(){remember();S.loginReturn=true;F.authReturn='following';F.navigate('login');}
  F.navigate=(id,...args)=>{
    if(F.screen==='following'&&id!=='following'&&!F.modalScreens.has(id))remember();
    if(id==='channel'&&args[0]===undefined&&valid(F.selectedBroadcast)&&!isLive(F.selectedBroadcast))args[0]='오프라인';
    const returning=F.screen==='login'&&id==='following'&&S.loginReturn&&F.sessionLoggedIn;
    if(returning){S.loginReturn=null;args[0]='기본';}
    else if(S.loginReturn&&id!=='login'&&id!=='following'){if(F.authReturn==='following')F.authReturn=null;S.loginReturn=null;}
    const result=old.navigate(id,...args);if(id==='following')restore();return result;
  };
  F.render=()=>{
    const previous=S.lastScreen,input=F.screen==='following'?F.root.querySelector('#v42-following-query'):null;
    const keepInput=input===document.activeElement,selection=keepInput?{start:input.selectionStart,end:input.selectionEnd}:null;
    old.render();S.lastScreen=F.screen;
    if(F.screen==='following'){const sort=F.root.querySelector('[data-action="v42-following-sort"]');if(sort)sort.hidden=!canSort();}
    if(F.screen==='channel'&&F.viewState==='오프라인'&&store.has(F.selectedBroadcast))F.root.querySelectorAll('.v2-channel-offline p').forEach(node=>{if(node.textContent.trim()==='팔로우하고 다음 방송 소식을 받아보세요.')node.remove();});
    if(F.screen==='following'&&keepInput){const next=F.root.querySelector('#v42-following-query');next?.focus({preventScroll:true});try{next?.setSelectionRange(selection.start,selection.end);}catch{}}
    else if(F.screen==='following'&&previous!=='following')restore();
  };
  window.addEventListener('pointerdown',event=>{if(F.screen==='following'&&event.target.closest?.('[data-v42-return]'))remember(event.target);},true);
  window.addEventListener('keydown',event=>{
    if(F.screen!=='following')return;
    if(['Enter',' '].includes(event.key)&&event.target.closest?.('[data-v42-return]'))remember(event.target);
    const tab=event.target.closest?.('.v42-following-tabs [role="tab"]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    stop(event);const next=event.key==='Home'?'live':event.key==='End'?'channels':S.tab==='live'?'channels':'live';setTab(next,true);
  },true);
  window.addEventListener('click',event=>{
    const b=event.target.closest?.('button');if(!b||b.disabled)return;
    if(F.screen==='following'&&b.dataset.go==='login'){stop(event);beginLogin();return;}
    const action=b.dataset.action||'';if(!action.startsWith('v42-following-'))return;stop(event);
    const name=action.slice('v42-following-'.length);
    if(name==='tab')setTab(b.dataset.tab);
    else if(name==='sort')F.openChoice(b,options(),S.sorts[S.tab],value=>{S.sorts[S.tab]=value;updateResults();});
    else if(name==='clear-query'){S.composing=false;setQuery('');F.root.querySelector('#v42-following-query')?.focus({preventScroll:true});}
    else if(name==='channels'){setTab('channels',true);}
    else if(name==='browse')F.navigate('live');
    else if(name==='login')beginLogin();
    else if(name==='retry')retry();
  },true);
  window.addEventListener('input',event=>{if(event.target.id!=='v42-following-query')return;S.query=event.target.value;if(!S.composing&&!event.isComposing)updateResults();},true);
  window.addEventListener('compositionstart',event=>{if(event.target.id==='v42-following-query')S.composing=true;},true);
  window.addEventListener('compositionend',event=>{if(event.target.id==='v42-following-query'){S.composing=false;S.query=event.target.value;updateResults();}},true);
  window.addEventListener('submit',event=>{if(event.target.id==='v42-following-search'){stop(event);if(!S.composing)updateResults();}},true);
  Object.assign(S,{isLive,rows,refresh,setTab,setQuery,setLive(index,value){index=Number(index);if(valid(index)){S.liveOverrides.set(index,!!value);refresh();}},setLoadState(value){if(['ready','loading','error'].includes(value)){retryToken++;S.loadState=value;refresh();}},setRetryTransport(fn){S.retryTransport=typeof fn==='function'?fn:null;},setSort(value){if(options().includes(value)){S.sorts[S.tab]=value;updateResults();}}});
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  if(F.screen==='following')F.render();else refreshSidebar();
})();
