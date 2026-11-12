/* UIF-012: viewer chat visibility only. Studio, messages, media and account preferences are not reconfigured. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.render||F.v44ChatVisibility)return;
  const render=F.render,S=F.v44ChatVisibility={snapshots:new Map()},screens=new Set(['watch','vod-watch','clip-watch']);
  let generation=0,mounted=null;
  const supported=()=>screens.has(F.screen);
  const panel=()=>F.root.querySelector('.watch-layout .chat-panel');
  const key=node=>node?.dataset.v34ChatRoom||F.screen+':'+(F.selectedBroadcast||0);
  const room=node=>F.v34Chat?.rooms.get(key(node));
  function remember(node){
    if(!node||node.hidden||!node.getClientRects().length||getComputedStyle(node).display==='none')return;
    const list=node.querySelector('.chat-messages'),input=node.querySelector('#chat-message'),state=room(node);if(!list)return;
    S.snapshots.set(key(node),{top:list.scrollTop,follow:typeof state?.follow==='boolean'?state.follow:list.scrollHeight-list.clientHeight-list.scrollTop<=24,latestHidden:node.querySelector('.v34-chat-latest')?.hidden??true,draft:input?.value,selection:input?{start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}:null});
  }
  function restore(node){
    const saved=S.snapshots.get(key(node));if(!saved)return;
    const list=node.querySelector('.chat-messages'),state=room(node),input=node.querySelector('#chat-message');if(!list)return;
    if(state){state.top=saved.top;state.follow=saved.follow;state.lastHeight=list.scrollHeight;}
    list.scrollTop=saved.follow?list.scrollHeight:Math.max(0,Math.min(saved.top,list.scrollHeight-list.clientHeight));
    if(state){state.top=list.scrollTop;state.lastHeight=list.scrollHeight;}
    const latest=node.querySelector('.v34-chat-latest');if(latest)latest.hidden=saved.latestHidden;
    if(input&&saved.selection&&input.value===saved.draft)try{input.setSelectionRange(saved.selection.start,saved.selection.end,saved.selection.direction||'none');}catch{}
  }
  function controls(layout,node){
    const main=layout.querySelector('.v3-watch-main');if(!main)return null;
    node.id='v44-chat-panel-'+key(node).replace(/[^\w-]/g,'-');
    let collapse=node.querySelector('.chat-head [data-action="chat-toggle"],.chat-head [data-action="v44-chat-toggle"]');
    if(collapse){collapse.dataset.action='v44-chat-toggle';collapse.id='v44-chat-collapse';collapse.classList.add('v44-chat-collapse');collapse.setAttribute('aria-label','채팅 접기');collapse.title='채팅 접기';collapse.innerHTML=F.icon('right');collapse.setAttribute('aria-expanded',String(F.chatOpen!==false));collapse.setAttribute('aria-controls',node.id);}
    let dock=main.querySelector('.v44-chat-reopen');
    if(!dock){dock=document.createElement('div');dock.className='v44-chat-reopen';dock.innerHTML=F.btn('채팅 열기','v44-chat-toggle','chat','','id="v44-chat-expand"');const meta=main.querySelector('.v3-watch-meta');if(meta)meta.before(dock);else main.append(dock);}
    const expand=dock.querySelector('button');expand.setAttribute('aria-expanded',String(F.chatOpen!==false));expand.setAttribute('aria-controls',node.id);expand.setAttribute('aria-label','채팅 열기');
    layout.querySelectorAll('.v3-watch-actions [data-action="chat-toggle"]').forEach(button=>button.remove());
    return {dock,expand,collapse};
  }
  function apply(focus=false,restorePosition=false){
    if(!supported())return false;
    const layout=F.root.querySelector('.watch-layout'),node=panel();if(!layout||!node)return false;
    const fresh=mounted!==node;mounted=node;layout.classList.add('v44-chat-layout');
    const buttons=controls(layout,node);if(!buttons)return false;
    const open=F.chatOpen!==false;layout.classList.toggle('chat-hidden',!open);
    node.hidden=!open;node.inert=!open;node.setAttribute('aria-hidden',String(!open));buttons.dock.hidden=open;
    buttons.expand.setAttribute('aria-expanded',String(open));buttons.collapse?.setAttribute('aria-expanded',String(open));
    if(open&&(restorePosition||fresh)){
      const token=++generation;restore(node);
      requestAnimationFrame(()=>{if(token===generation&&supported()&&F.chatOpen!==false&&node.isConnected)restore(node);});
    }
    if(focus)(open?buttons.collapse:buttons.expand)?.focus({preventScroll:true});
    F.v39Viewer?.polish();return true;
  }
  function setOpen(value,options={}){
    if(!supported())return false;
    const open=!!value,node=panel();if(!node)return false;
    if(!open&&F.chatOpen!==false)remember(node);
    generation++;F.chatOpen=open;return apply(options.focus!==false,open);
  }
  F.render=(...args)=>{const previous=panel(),previousKey=previous?key(previous):null,focus=['v44-chat-collapse','v44-chat-expand'].includes(document.activeElement?.id)?document.activeElement.id:null;remember(previous);const value=render(...args);if(supported()){apply(false,true);if(focus&&key(panel())===previousKey){const target=document.getElementById(focus);if(target?.getClientRects().length)target.focus({preventScroll:true});}}else mounted=null;return value;};
  window.addEventListener('click',event=>{
    if(!supported())return;
    const button=event.target.closest?.('button');if(!button||button.disabled||!['chat-toggle','v44-chat-toggle'].includes(button.dataset.action))return;
    if(!button.closest('.watch-layout,.watch-top'))return;
    event.preventDefault();event.stopImmediatePropagation();setOpen(F.chatOpen===false);
  },true);
  window.addEventListener('keydown',event=>{if(!supported()||!event.target.closest?.('button[data-action="v44-chat-toggle"]'))return;if(event.code==='Space'||event.key===' '||event.key==='Spacebar'||event.key==='Enter')event.stopImmediatePropagation();},true);
  Object.assign(S,{setOpen,toggle(options){return setOpen(F.chatOpen===false,options);},refresh(){return apply(false,true);},getState(){const node=panel(),list=node?.querySelector('.chat-messages'),input=node?.querySelector('#chat-message');return {supported:supported(),open:F.chatOpen!==false,key:node?key(node):null,panelHidden:node?.hidden??null,scrollTop:list?.scrollTop??null,followingLatest:node?room(node)?.follow??null:null,latestHidden:node?.querySelector('.v34-chat-latest')?.hidden??null,draft:input?.value??null,selectionStart:input?.selectionStart??null,selectionEnd:input?.selectionEnd??null};}});
  if(supported())apply(false,true);
})();
