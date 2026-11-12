/* UIF-007: viewer layout state only. Media, quality and chat implementations stay mounted. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.render||F.v46Theater)return;
  const old={render:F.render},screens=new Set(['watch','vod-watch','clip-watch']);
  const S=F.v46Theater={context:null,sidebarBefore:null};
  let generation=0,labelsQueued=false;
  const mobile=()=>!!(F.v39Mobile?.isMobile()||F.device==='mobile'||matchMedia('(max-width:767px)').matches);
  // Existing @container(max-width:850px) hides the sidebar; there is no width to reclaim there.
  const available=()=>{const side=F.root.querySelector('.sidebar');return !mobile()&&!!side&&getComputedStyle(side).display!=='none'&&side.getClientRects().length>0&&side.getBoundingClientRect().width>0;};
  const wideButton=()=>F.root.querySelector('#locked-viewer-wide');
  const manualCompact=()=>F.root.classList.contains('v2-navigation-compact');
  function context(){
    let screen=F.screen;
    if(screen==='quality')screen=F.v38Viewer?.qualityOrigin||S.context?.screen||F.currentBase;
    else if(F.modalScreens.has(screen))screen=F.modalBackground(screen);
    if(!screens.has(screen))return null;
    return {screen,channelIndex:Number(F.selectedBroadcast)||0,contentId:F.v38Viewer?.current()?.id||screen+':'+F.selectedBroadcast};
  }
  const same=(a,b)=>!!a&&!!b&&a.screen===b.screen&&a.channelIndex===b.channelIndex&&a.contentId===b.contentId;
  function leave(){
    if(S.sidebarBefore!==null)F.root.classList.toggle('v2-navigation-compact',S.sidebarBefore);
    S.sidebarBefore=null;F.wide=false;F.root.classList.remove('wide-mode');generation++;
  }
  function syncContext(){
    const next=context();
    if(!next||S.context&&!same(S.context,next))leave();
    S.context=next;
    if(!available()&&F.wide)leave();
  }
  function labels(){
    if(!context())return;
    const side=F.root.querySelector('.sidebar'),compact=!!F.wide||manualCompact();
    if(side){
      if(!side.id)side.id='v46-viewer-sidebar';
      side.querySelectorAll('button').forEach(button=>{
        const name=button.getAttribute('aria-label')||button.querySelector('.nav-label,.side-channel-name')?.textContent.trim()||button.textContent.trim();
        if(!name)return;if(!button.hasAttribute('aria-label'))button.setAttribute('aria-label',name);
        if(!button.title)button.title=name;
      });
    }
    F.root.querySelectorAll('[data-action="v3-menu"],[data-action="v2-menu"]').forEach(button=>{
      const label=compact?'메뉴 펼치기':'메뉴 접기';button.setAttribute('aria-label',label);button.title=label;
      button.setAttribute('aria-expanded',String(!compact));if(side)button.setAttribute('aria-controls',side.id);
    });
  }
  function paint(){
    const current=context(),isMobile=mobile(),canExpand=!!current&&available(),active=canExpand&&!!F.wide;
    F.root.classList.toggle('wide-mode',active);F.root.classList.toggle('v46-viewer-layout',!!current);
    F.root.dataset.v46Mobile=String(!!current&&isMobile);
    F.root.dataset.v46WideAvailable=String(canExpand);
    const button=wideButton();
    if(button&&current){
      const text=active?'기본 보기':'확대 보기';
      button.hidden=!canExpand;button.tabIndex=canExpand?0:-1;
      if(!canExpand)button.setAttribute('aria-hidden','true');else button.removeAttribute('aria-hidden');
      button.setAttribute('aria-label',text);button.setAttribute('aria-pressed',String(active));button.title=text+' (T)';button.setAttribute('aria-keyshortcuts','T');
      const label=button.querySelector('.locked-control-label');if(label&&label.textContent!==text)label.textContent=text;
      if(!canExpand&&document.activeElement===button)F.root.querySelector('#video-player')?.focus({preventScroll:true});
    }
    labels();
  }
  function rememberChat(){
    const panel=F.root.querySelector('.watch-layout .chat-panel'),list=panel?.querySelector('.chat-messages');
    if(!list||panel.hidden||!list.getClientRects().length)return null;
    const state=F.v34Chat?.rooms.get(panel.dataset.v34ChatRoom);
    return {panel,list,key:panel.dataset.v34ChatRoom,top:list.scrollTop,follow:typeof state?.follow==='boolean'?state.follow:list.scrollHeight-list.clientHeight-list.scrollTop<=24,latestHidden:panel.querySelector('.v34-chat-latest')?.hidden??true};
  }
  function restoreChat(saved){
    if(!saved||!saved.list.isConnected||saved.panel.hidden||F.root.querySelector('.watch-layout .chat-panel')!==saved.panel)return;
    const list=saved.list,state=F.v34Chat?.rooms.get(saved.key);
    list.scrollTop=saved.follow?list.scrollHeight:Math.max(0,Math.min(saved.top,list.scrollHeight-list.clientHeight));
    if(state){state.follow=saved.follow;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;}
    const latest=saved.panel.querySelector('.v34-chat-latest');if(latest)latest.hidden=saved.latestHidden;
  }
  function preserveChat(saved){
    restoreChat(saved);const ticket=++generation;
    requestAnimationFrame(()=>{if(ticket===generation)restoreChat(saved);});
  }
  function setWide(value,options={}){
    if(!context())return false;
    if(!available()){if(F.wide)leave();paint();return !value;}
    if(F.dialog.open||F.review?.open||F.activeSelect)return false;
    const next=!!value,saved=rememberChat();
    if(next&&!F.wide)S.sidebarBefore=manualCompact();
    if(!next&&S.sidebarBefore!==null){F.root.classList.toggle('v2-navigation-compact',S.sidebarBefore);S.sidebarBefore=null;}
    F.wide=next;paint();preserveChat(saved);
    if(options.focus===true)wideButton()?.focus({preventScroll:true});
    F.showControls?.(F.root.querySelector('#video-player'));return true;
  }
  function toggleMenu(button){
    const saved=rememberChat();
    if(F.wide){leave();F.root.classList.remove('v2-navigation-compact');}
    else F.root.classList.toggle('v2-navigation-compact');
    paint();preserveChat(saved);button.focus({preventScroll:true});
  }
  F.render=(...args)=>{syncContext();const result=old.render(...args);syncContext();paint();return result;};
  window.addEventListener('click',event=>{
    if(!context())return;
    const button=event.target.closest?.('button');if(!button||button.disabled)return;
    if(button.id==='locked-viewer-wide'){
      event.preventDefault();event.stopImmediatePropagation();if(screens.has(F.screen)&&!F.dialog.open&&!F.review?.open)setWide(!F.wide,{focus:true});
    }else if(screens.has(F.screen)&&!F.dialog.open&&!F.review?.open&&['v3-menu','v2-menu'].includes(button.dataset.action)){
      event.preventDefault();event.stopImmediatePropagation();toggleMenu(button);
    }
  },true);
  window.addEventListener('keydown',event=>{
    if(!screens.has(F.screen))return;
    const target=event.target,button=target.closest?.('button'),activation=event.code==='Space'||[' ','Spacebar','Enter'].includes(event.key);
    if(activation&&(button?.id==='locked-viewer-wide'||['v3-menu','v2-menu'].includes(button?.dataset.action))&&!F.dialog.open&&!F.review?.open){
      event.stopImmediatePropagation();if(event.repeat)event.preventDefault();return;
    }
    if(String(event.key).toLowerCase()!=='t')return;
    const editing=target.matches?.('input,textarea,select')||target.isContentEditable||!!target.closest?.('[contenteditable]:not([contenteditable="false"])');
    if(editing||event.isComposing||F.composing||F.dialog.open||F.review?.open||F.activeSelect||event.ctrlKey||event.altKey||event.metaKey){
      // Keep typed text and other modal controls native while suppressing the old global layout shortcut.
      event.stopImmediatePropagation();return;
    }
    event.preventDefault();event.stopImmediatePropagation();if(!event.repeat&&available())setWide(!F.wide);
  },true);
  // Follow changes replace the sidebar independently of F.render. Only label those new navigation nodes.
  new MutationObserver(records=>{
    if(!context()||!records.some(record=>record.target.closest?.('.sidebar')||[...record.addedNodes].some(node=>node.nodeType===1&&(node.matches('.sidebar')||node.querySelector('.sidebar')))))return;
    if(labelsQueued)return;labelsQueued=true;queueMicrotask(()=>{labelsQueued=false;labels();});
  }).observe(F.root,{childList:true,subtree:true});
  window.addEventListener('resize',()=>{syncContext();paint();});
  Object.assign(S,{setWide,getState(){const current=context(),button=wideButton(),side=F.root.querySelector('.sidebar');return {supported:!!current,available:!!current&&available(),mobile:mobile(),wide:!!F.wide,mode:F.wide?'wide':'normal',context:current,manualSidebarCollapsed:manualCompact(),sidebarBefore:S.sidebarBefore,sidebarCollapsed:!!F.wide||manualCompact(),sidebarWidth:side?.getBoundingClientRect().width??null,chatOpen:F.chatOpen!==false,buttonLabel:button?.getAttribute('aria-label')??null,buttonPressed:button?.getAttribute('aria-pressed')??null,buttonHidden:button?.hidden??null};}});
  syncContext();paint();
})();
