/* UIF-003: local playback intent and controls only. Existing media and quality renderers are retained. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.root||!F.render||F.v48Playback)return;
  const render=F.render,screens=new Set(['watch','vod-watch','clip-watch']);
  const unavailableStates=new Set(['재연결 중','방송 종료','재생 실패','접속자 많음','삭제된 영상']);
  const S=F.v48Playback={context:null,lastSource:null,boundary:null};
  let mounted=null,feedbackTimer=null;
  const player=()=>F.root.querySelector('.watch-layout #video-player');
  const pauseButton=()=>player()?.querySelector('#locked-player-pause');
  const context=()=>screens.has(F.screen)?{screen:F.screen,channelIndex:Number(F.selectedBroadcast)||0,contentId:F.v38Viewer?.current()?.id||F.screen+':'+F.selectedBroadcast}:null;
  const supported=()=>!!context()&&!!player();
  const blocked=()=>F.dialog.open||F.review?.open||!!F.activeSelect||F.root.inert;
  const unavailable=()=>unavailableStates.has(F.viewState)||!!player()?.querySelector('.player-center');
  const icon=playing=>'<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#locked-i-'+(playing?'pause':'play')+'"/></svg>';
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  function clearFeedback(){
    clearTimeout(feedbackTimer);feedbackTimer=null;
    mounted?.classList.remove('v48-feedback-active');
    const feedback=mounted?.querySelector('.v48-playback-feedback');if(feedback)feedback.hidden=true;
  }
  function centerControl(node){
    let center=node.querySelector('.v48-center-play');
    if(!center){
      center=document.createElement('button');center.type='button';center.className='v48-center-play';center.dataset.action='v48-playback-center';
      center.setAttribute('aria-label','재생');center.setAttribute('aria-keyshortcuts','Space K');center.title='재생 (Space / K)';center.innerHTML=icon(false);node.append(center);
    }
    return center;
  }
  function paint(){
    const node=player();if(!supported()||!node)return;
    node.classList.add('v48-playback-target');node.querySelector('.locked-pause-overlay')?.remove();
    const playing=!!F.playing,disabled=unavailable(),button=pauseButton(),label=playing?'일시정지':'재생';
    node.classList.toggle('is-paused',!playing);
    if(button){
      button.setAttribute('aria-label',label);button.title=label+' (Space / K)';button.setAttribute('aria-keyshortcuts','Space K');button.disabled=disabled;
      button.setAttribute('aria-disabled',String(disabled));button.removeAttribute('aria-pressed');
      const use=button.querySelector('use');if(use)use.setAttribute('href','#locked-i-'+(playing?'pause':'play'));
      const text=button.querySelector('.locked-control-label');if(text)text.textContent=label;
    }
    const center=centerControl(node);center.hidden=playing||disabled;center.disabled=disabled;
  }
  function feedback(playing){
    const node=player();if(!node)return;clearFeedback();
    let mark=node.querySelector('.v48-playback-feedback');
    if(!mark){mark=document.createElement('span');mark.className='v48-playback-feedback';mark.setAttribute('aria-hidden','true');node.append(mark);}
    mark.innerHTML=icon(!playing);mark.hidden=false;node.classList.add('v48-feedback-active');
    feedbackTimer=setTimeout(()=>{node.classList.remove('v48-feedback-active');mark.hidden=true;feedbackTimer=null;},480);
  }
  function setPlaying(value,options={}){
    if(!supported()||blocked()||unavailable())return false;
    const next=!!value,node=player(),center=node.querySelector('.v48-center-play'),centerFocused=document.activeElement===center;
    if(next===!!F.playing){paint();return true;}
    F.playing=next;
    // A paused review fixture is the only state name that would force old renders back to pause.
    // Other states, especially a live stream's past position, are not overwritten by a toggle.
    if(next&&F.viewState==='일시정지'){F.viewState='기본';F.writeUrl(true);}
    S.lastSource=options.source||'api';S.boundary=null;paint();
    if(next&&centerFocused)node.focus({preventScroll:true});
    if(options.feedback!==false)feedback(next);
    F.showControls?.(node);return true;
  }
  const toggle=options=>setPlaying(!F.playing,options);
  function syncRender(){
    const node=player(),next=context();
    if(mounted!==node){clearFeedback();if(mounted&&!mounted.isConnected)S.boundary='player-replaced';mounted=node;}
    S.context=next;
    if(!next||!node){clearFeedback();return;}
    // The existing renderer defines initial fixtures and new-content/autoplay intent.
    F.playing=!node.classList.contains('is-paused');paint();
  }
  F.render=(...args)=>{const result=render(...args);syncRender();return result;};
  window.addEventListener('click',event=>{
    if(!supported()||event.button!==0)return;
    const node=player(),target=event.target;if(!target?.closest||!node.contains(target))return;
    const control=target.closest('#locked-player-pause,.v48-center-play');
    if(control){stop(event);if(!control.disabled&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey)toggle({source:control.classList.contains('v48-center-play')?'center':'button'});return;}
    if(target.closest('button,input,.locked-player-quality-menu,.player-center'))return;
    // Let native editing/link defaults happen while suppressing the old scene-click listener.
    if(target.closest('a,textarea,select,label,summary,[role="button"],[role="slider"],[contenteditable]:not([contenteditable="false"]),.locked-player-controls,.player-note')||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey){event.stopImmediatePropagation();return;}
    stop(event);toggle({source:'surface'});
  },true);
  window.addEventListener('keydown',event=>{
    if(!screens.has(F.screen))return;
    const target=event.target,activation=event.code==='Space'||[' ','Spacebar','Enter'].includes(event.key),control=target.closest?.('#locked-player-pause,.v48-center-play');
    if(activation&&control){
      event.stopImmediatePropagation();if(event.repeat||event.isComposing||F.composing||blocked()||unavailable()||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)event.preventDefault();return;
    }
    const shortcut=event.code==='Space'||[' ','Spacebar'].includes(event.key)||String(event.key).toLowerCase()==='k';if(!shortcut)return;
    if(!supported()){event.stopImmediatePropagation();return;}
    const editing=target.matches?.('input,textarea,select')||target.isContentEditable||!!target.closest?.('[contenteditable]:not([contenteditable="false"])');
    const otherControl=!!target.closest?.('button,a,summary,[role="button"],[role="link"],[role="slider"],[role="tab"]')&&!control;
    if(editing||otherControl||event.isComposing||F.composing||blocked()||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey){event.stopImmediatePropagation();return;}
    event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)toggle({source:'keyboard'});
  },true);
  Object.assign(S,{setPlaying,toggle,getState(){const node=player(),button=pauseButton(),center=node?.querySelector('.v48-center-play');return {supported:supported(),playing:!!F.playing,paused:node?.classList.contains('is-paused')??null,unavailable:supported()?unavailable():true,blocked:blocked(),viewState:F.viewState,context:context(),buttonLabel:button?.getAttribute('aria-label')||null,buttonDisabled:button?.disabled??null,centerVisible:!!center&&!center.hidden&&getComputedStyle(center).visibility!=='hidden',feedbackVisible:!!node?.classList.contains('v48-feedback-active'),lastSource:S.lastSource,boundary:S.boundary,fullscreenElementId:document.fullscreenElement?.id||null};}});
  syncRender();
})();
