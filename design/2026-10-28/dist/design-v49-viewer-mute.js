/* UIF-004: viewer audio preference and control state only. No audio device or media renderer is changed. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.root||!F.render||F.v49Mute)return;
  const render=F.render,screens=new Set(['watch','vod-watch','clip-watch']),fallback=80;
  const S=F.v49Mute={initialized:false,muted:false,volume:fallback,lastPositive:fallback,lastSource:null,boundary:null};
  let mounted=null;
  const player=()=>F.root.querySelector('.watch-layout #video-player');
  const button=()=>player()?.querySelector('#locked-player-mute');
  const slider=()=>player()?.querySelector('#locked-player-volume');
  const supported=()=>screens.has(F.screen)&&!!player();
  const blocked=()=>F.dialog.open||F.review?.open||!!F.activeSelect||F.root.inert||!!player()?.querySelector('.locked-player-quality-menu');
  const silent=()=>S.muted||S.volume===0;
  const normalize=value=>{const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):null;};
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  function paint(){
    const node=player(),control=button(),input=slider();if(!node||!control||!input||!S.initialized)return;
    const off=silent(),value=off?0:S.volume,label=off?'음소거 해제':'음소거';
    node.classList.add('v49-mute-target');node.classList.toggle('v49-muted',off);F.muted=off;
    control.setAttribute('aria-label',label);control.title=label+' (M)';control.setAttribute('aria-keyshortcuts','M');control.removeAttribute('aria-pressed');
    const use=control.querySelector('use');if(use)use.setAttribute('href','#locked-i-'+(off?'volume-off':'volume'));
    input.value=String(value);input.style.setProperty('--fill',value+'%');input.setAttribute('aria-valuetext',value+'%');
  }
  function initialize(){
    if(S.initialized||!player())return;
    const value=normalize(slider()?.value)??fallback;S.volume=value;S.lastPositive=value>0?value:fallback;S.muted=!!F.muted||value===0;S.initialized=true;
  }
  function clearSoundPrompt(){
    if(F.viewState!=='소리 켜기')return false;
    const focused=document.activeElement;
    F.viewState='기본';F.writeUrl(true);
    player()?.querySelectorAll('[data-action="unmute"]').forEach(control=>{const note=control.closest('.player-note');if(note)note.remove();else control.remove();});
    return !!focused&&!focused.isConnected;
  }
  function setMuted(value,options={}){
    if(!supported()||blocked())return false;
    initialize();const next=!!value;let restoreFocus=false;
    if(next){if(S.volume>0)S.lastPositive=S.volume;S.muted=true;}
    else{if(S.volume<=0)S.volume=S.lastPositive>0?S.lastPositive:fallback;S.lastPositive=S.volume;S.muted=false;restoreFocus=clearSoundPrompt();}
    S.lastSource=options.source||'api';S.boundary=null;paint();if(restoreFocus)button()?.focus({preventScroll:true});F.showControls?.(player());return true;
  }
  const toggle=options=>setMuted(!silent(),options);
  function setVolume(value,options={}){
    if(!supported()||blocked())return false;
    const next=normalize(value);if(next===null)return false;initialize();S.volume=next;S.muted=next===0;let restoreFocus=false;
    if(next>0){S.lastPositive=next;restoreFocus=clearSoundPrompt();}
    S.lastSource=options.source||'volume';S.boundary=null;paint();if(restoreFocus)button()?.focus({preventScroll:true});F.showControls?.(player());return true;
  }
  function syncRender(){
    const node=player();if(node!==mounted){if(mounted&&!mounted.isConnected)S.boundary='player-replaced';mounted=node;}
    if(!node)return;initialize();
    // This review fixture explicitly starts silent; all other viewer renders retain the user's preference.
    if(F.viewState==='소리 켜기')S.muted=true;
    paint();
  }
  F.render=(...args)=>{const result=render(...args);syncRender();return result;};
  window.addEventListener('click',event=>{
    if(!supported()||event.button!==0)return;
    const control=event.target.closest?.('#locked-player-mute,[data-action="unmute"]');if(!control||!player()?.contains(control))return;
    stop(event);if(control.disabled||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
    const prompt=control.dataset.action==='unmute',focused=document.activeElement===control;
    const applied=prompt?setMuted(false,{source:'sound-prompt'}):toggle({source:'button'});
    if(applied&&prompt&&focused&&!control.isConnected)button()?.focus({preventScroll:true});
  },true);
  window.addEventListener('input',event=>{
    if(event.target!==slider()||!supported())return;
    // Reuse the native range control; only its mute/zero boundary and fill are synchronized here.
    if(!setVolume(event.target.value,{source:'volume-input'}))paint();
  },true);
  window.addEventListener('keydown',event=>{
    if(!screens.has(F.screen))return;
    const target=event.target,own=target.closest?.('#locked-player-mute,[data-action="unmute"]'),activation=event.code==='Space'||[' ','Spacebar','Enter'].includes(event.key);
    if(own&&activation&&player()?.contains(own)){
      event.stopImmediatePropagation();
      if(event.repeat||event.isComposing||F.composing||blocked()||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)event.preventDefault();
      return;
    }
    if(String(event.key).toLowerCase()!=='m')return;
    const editing=target.matches?.('input,textarea,select')||target.isContentEditable||!!target.closest?.('[contenteditable]:not([contenteditable="false"])');
    const other=!!target.closest?.('button,a,summary,[role="button"],[role="link"],[role="slider"],[role="tab"]')&&!own;
    if(!supported()||editing||other||event.isComposing||F.composing||event.keyCode===229||blocked()||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey){event.stopImmediatePropagation();return;}
    stop(event);if(!event.repeat)toggle({source:'keyboard'});
  },true);
  Object.assign(S,{setMuted,toggle,setVolume,getState(){const control=button(),input=slider();return {supported:supported(),blocked:blocked(),initialized:S.initialized,muted:silent(),configuredVolume:S.volume,lastPositive:S.lastPositive,effectiveVolume:silent()?0:S.volume,fallbackVolume:fallback,sliderVolume:input?Number(input.value):null,sliderValueText:input?.getAttribute('aria-valuetext')||null,buttonLabel:control?.getAttribute('aria-label')||null,buttonPressed:control?.getAttribute('aria-pressed')??null,icon:control?.querySelector('use')?.getAttribute('href')||null,viewState:F.viewState,playing:!!F.playing,fullscreenElementId:document.fullscreenElement?.id||null,lastSource:S.lastSource,boundary:S.boundary};}});
  syncRender();
})();
