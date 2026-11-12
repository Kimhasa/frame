/* UIF-008: native viewer fullscreen UI only. No fake fullscreen or media renderer is introduced. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.root||!F.render||F.v47Fullscreen)return;
  const render=F.render,screens=new Set(['watch','vod-watch','clip-watch']);
  const S=F.v47Fullscreen={status:'idle',pending:false,error:'',boundary:null};
  let origin=null,operation=null,token=0,wasActive=false,restoreVersion=0,lastScope=null;
  const player=()=>F.root.querySelector('.watch-layout #video-player');
  const button=()=>player()?.querySelector('#locked-viewer-fullscreen');
  const context=()=>({screen:F.screen,channelIndex:Number(F.selectedBroadcast)||0,contentId:F.v38Viewer?.current()?.id||F.screen+':'+F.selectedBroadcast});
  function scopeContext(){
    let screen=F.screen;
    if(screen==='quality')screen=F.v38Viewer?.qualityOrigin||F.currentBase;
    else if(F.modalScreens.has(screen))screen=F.modalBackground(screen);
    return screens.has(screen)?{screen,channelIndex:Number(F.selectedBroadcast)||0,contentId:F.v38Viewer?.current()?.id||screen+':'+F.selectedBroadcast}:null;
  }
  const sameScope=(a,b)=>a===b||!!a&&!!b&&a.screen===b.screen&&a.channelIndex===b.channelIndex&&a.contentId===b.contentId;
  const supported=()=>screens.has(F.screen)&&!!player();
  const active=()=>!!document.fullscreenElement&&(document.fullscreenElement===player()||document.fullscreenElement===origin?.player);
  const available=()=>typeof player()?.requestFullscreen==='function'&&typeof document.exitFullscreen==='function'&&document.fullscreenEnabled!==false;
  const blocked=()=>F.dialog.open||F.review?.open||!!F.activeSelect;
  function sameTarget(saved){
    const current=context();return !!saved&&saved.player.isConnected&&player()===saved.player&&screens.has(current.screen)&&
      current.screen===saved.context.screen&&current.channelIndex===saved.context.channelIndex&&current.contentId===saved.context.contentId;
  }
  function snapshot(){
    const node=player(),panel=F.root.querySelector('.watch-layout .chat-panel'),list=panel?.querySelector('.chat-messages'),input=panel?.querySelector('#chat-message');
    const scrollRoom=F.v34Chat?.rooms.get(panel?.dataset.v34ChatRoom),main=F.root.querySelector('#main-content'),sidebar=F.root.querySelector('.sidebar');
    return {player:node,button:button(),context:context(),main,mainTop:main?.scrollTop||0,sidebar,sidebarTop:sidebar?.scrollTop||0,x:scrollX,y:scrollY,
      panel,list,chatKey:panel?.dataset.v34ChatRoom,chatTop:list?.scrollTop||0,follow:typeof scrollRoom?.follow==='boolean'?scrollRoom.follow:true,
      latestHidden:panel?.querySelector('.v34-chat-latest')?.hidden??true,input,draft:input?.value,start:input?.selectionStart,end:input?.selectionEnd,direction:input?.selectionDirection,
      entered:false};
  }
  function restorePosition(saved){
    if(!sameTarget(saved)||document.fullscreenElement)return;
    window.scrollTo({left:saved.x,top:saved.y,behavior:'instant'});
    if(saved.main?.isConnected)saved.main.scrollTop=saved.mainTop;
    if(saved.sidebar?.isConnected)saved.sidebar.scrollTop=saved.sidebarTop;
    if(saved.list?.isConnected&&saved.panel===F.root.querySelector('.watch-layout .chat-panel')&&!saved.panel.hidden){
      const list=saved.list,state=F.v34Chat?.rooms.get(saved.chatKey);
      list.scrollTop=saved.follow?list.scrollHeight:Math.max(0,Math.min(saved.chatTop,list.scrollHeight-list.clientHeight));
      if(state){state.follow=saved.follow;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;}
      const latest=saved.panel.querySelector('.v34-chat-latest');if(latest)latest.hidden=saved.latestHidden;
    }
    if(saved.input?.isConnected&&saved.input.value===saved.draft&&saved.start!==undefined)try{saved.input.setSelectionRange(saved.start,saved.end,saved.direction||'none');}catch{}
  }
  function restore(saved){
    if(!sameTarget(saved)||document.fullscreenElement)return;
    const version=++restoreVersion;restorePosition(saved);saved.button?.focus({preventScroll:true});
    requestAnimationFrame(()=>{
      if(version!==restoreVersion||!sameTarget(saved)||document.fullscreenElement)return;
      restorePosition(saved);const focused=document.activeElement;
      if(focused===document.body||focused===document.documentElement||focused===saved.player||focused===saved.button)saved.button?.focus({preventScroll:true});
    });
  }
  function paint(){
    const node=player(),control=button();if(!node||!control)return;
    node.classList.add('v47-fullscreen-target');const on=active(),label=on?'전체 화면 종료':'전체 화면';
    control.setAttribute('aria-label',label);control.title=label+' (F)';control.setAttribute('aria-pressed',String(on));control.setAttribute('aria-keyshortcuts','F');
    control.setAttribute('aria-busy',String(S.pending));control.setAttribute('aria-disabled',String(S.pending));
    // Keep the button and its SVG node; only the glyph changes with actual native state.
    const svg=control.querySelector('svg');
    if(svg&&control.dataset.v47Icon!==String(on)){
      svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
      svg.innerHTML=on?'<path d="M3 8h5V3m8 0v5h5m0 8h-5v5m-8 0v-5H3"/>':'<use href="#locked-i-expand"/>';control.dataset.v47Icon=String(on);
    }
  }
  function syncNative(){
    const on=active();
    if(on){
      if(!origin&&supported())origin=snapshot();
      if(origin)origin.entered=true;if(operation?.kind==='enter')operation.observedActive=true;
      wasActive=true;S.pending=false;S.status='active';S.error='';paint();F.showControls?.(document.fullscreenElement);return;
    }
    if(wasActive||origin?.entered){
      const saved=origin;origin=null;wasActive=false;S.pending=false;S.status='idle';S.error='';operation=null;paint();
      if(saved&&!saved.player.isConnected)S.boundary='player-replaced';
      if(!document.fullscreenElement)restore(saved);return;
    }
    if(!S.pending&&!['error','unsupported'].includes(S.status))S.status='idle';paint();
  }
  function failure(message,current,status='error'){
    if(current&&current.id!==token)return false;
    // Native Escape or browser UI can complete the exit before its Promise settles.
    if(current?.kind==='exit'&&!active()){syncNative();return false;}
    if(current?.kind==='enter'&&current.observedActive){syncNative();return false;}
    if(current?.reported)return false;if(current)current.reported=true;
    S.pending=false;S.status=status;S.error=message;F.toast(message);paint();
    if(!active()&&current?.kind==='enter'){const saved=origin;origin=null;restore(saved);}return false;
  }
  async function enter(){
    if(!supported()||blocked()||S.pending)return false;
    if(active()){syncNative();return true;}
    if(document.fullscreenElement)return failure('다른 전체 화면을 종료한 뒤 다시 시도하세요.');
    if(!available())return failure('이 브라우저에서는 전체 화면을 사용할 수 없어요.',null,'unsupported');
    restoreVersion++;origin=snapshot();S.boundary=null;S.status='entering';S.pending=true;S.error='';
    const current=operation={id:++token,kind:'enter',player:origin.player,observedActive:false,reported:false};paint();
    try{
      // Call native fullscreen in the initiating user gesture, before any await.
      await current.player.requestFullscreen();
      if(current.id!==token)return false;
      if(!current.player.isConnected){S.boundary='player-replaced';origin=null;S.pending=false;S.status='idle';operation=null;paint();return false;}
      if(current.reported)return false;S.pending=false;operation=null;syncNative();return active();
    }catch{
      if(current.id!==token)return false;
      if(!current.player.isConnected||player()!==current.player){origin=null;operation=null;S.pending=false;S.status='idle';S.boundary='player-replaced';paint();return false;}
      return failure('전체 화면을 열지 못했어요. 다시 시도하세요.',current);
    }
  }
  async function exit(){
    if(!active()){syncNative();return true;}
    if(S.pending&&operation?.kind==='exit')return false;
    if(typeof document.exitFullscreen!=='function')return failure('이 브라우저에서는 전체 화면을 종료할 수 없어요.');
    S.status='exiting';S.pending=true;S.error='';const current=operation={id:++token,kind:'exit',player:document.fullscreenElement,observedActive:true,reported:false};paint();
    try{
      await document.exitFullscreen();if(current.id!==token)return false;if(current.reported)return false;
      S.pending=false;operation=null;syncNative();return !active();
    }catch{
      if(current.id!==token)return false;
      if(!active()){S.pending=false;operation=null;syncNative();return true;}
      return failure('전체 화면을 종료하지 못했어요. 다시 시도하세요.',current);
    }
  }
  const toggle=()=>active()?exit():enter();
  F.render=(...args)=>{
    const previous=origin?.player,result=render(...args);
    const nextScope=scopeContext(),changed=!sameScope(lastScope,nextScope);lastScope=nextScope;
    if(previous&&!previous.isConnected){token++;restoreVersion++;origin=null;operation=null;wasActive=false;S.pending=false;S.status='idle';S.error='';S.boundary='player-replaced';}
    else if(!active()&&(changed||!nextScope)){token++;restoreVersion++;origin=null;operation=null;wasActive=false;S.pending=false;S.status='idle';S.error='';}
    paint();return result;
  };
  window.addEventListener('click',event=>{
    const control=event.target.closest?.('#locked-viewer-fullscreen');if(!control||control.disabled||control!==button())return;
    event.preventDefault();event.stopImmediatePropagation();if(active()||supported()&&!blocked())toggle();
  },true);
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&active()&&!blocked()){
      // Do not prevent the browser's native Escape action. A duplicate completed exit is harmless.
      event.stopImmediatePropagation();exit();return;
    }
    if(!screens.has(F.screen))return;
    const target=event.target,activation=event.code==='Space'||[' ','Spacebar','Enter'].includes(event.key);
    if(activation&&target.closest?.('#locked-viewer-fullscreen')&&!blocked()){
      event.stopImmediatePropagation();if(event.repeat)event.preventDefault();return;
    }
    if(String(event.key).toLowerCase()!=='f')return;
    const editing=target.matches?.('input,textarea,select')||target.isContentEditable||!!target.closest?.('[contenteditable]:not([contenteditable="false"])');
    if(editing||event.isComposing||F.composing||blocked()||event.ctrlKey||event.altKey||event.metaKey){event.stopImmediatePropagation();return;}
    event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)toggle();
  },true);
  document.addEventListener('fullscreenchange',syncNative);
  document.addEventListener('fullscreenerror',event=>{
    const current=operation;if(!current||event.target!==document&&event.target!==current.player)return;
    failure(current.kind==='exit'?'전체 화면을 종료하지 못했어요. 다시 시도하세요.':'전체 화면을 열지 못했어요. 다시 시도하세요.',current);
  });
  Object.assign(S,{enter,exit,toggle,getState(){const control=button();return {supported:supported(),nativeAvailable:available(),active:active(),pending:S.pending,status:S.status,error:S.error,fullscreenElementId:document.fullscreenElement?.id||null,targetId:origin?.player?.id||player()?.id||null,context:supported()?context():null,buttonLabel:control?.getAttribute('aria-label')||null,buttonPressed:control?.getAttribute('aria-pressed')||null,wide:!!F.wide,manualSidebarCollapsed:F.root.classList.contains('v2-navigation-compact'),chatOpen:F.chatOpen!==false,boundary:S.boundary};}});
  lastScope=scopeContext();paint();
})();
