/* UIF-006: viewer chrome visibility only. Existing media, playback, audio and quality owners are retained. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.root||!F.render||F.v51Controls)return;
  const render=F.render,oldShow=F.showControls,idleDelayMs=2200;
  const chrome='.locked-player-controls,.locked-player-quality-menu,.v39-player-back,.v48-center-play';
  let mounted=null,timer=null,queued=0,visible=false,inputMode='pointer',pointerType=null;
  let hoveredControls=false,dragging=false,dragTarget=null,reason='initial';
  const player=()=>F.root.querySelector('.watch-layout #video-player');
  const inChrome=target=>!!target?.closest?.(chrome)&&!!mounted?.contains(target);
  const menuOpen=()=>!!mounted?.classList.contains('menu-open')||!!F.v39Viewer?.sheet||document.body.classList.contains('v39-quality-open');
  const keyboardFocus=()=>inputMode==='keyboard'&&(inChrome(document.activeElement)||!!F.v39Viewer?.sheet?.shell?.contains(document.activeElement));
  function holds(){
    const result=[];if(!mounted)return result;
    if(mounted.classList.contains('is-paused'))result.push('paused');
    if(menuOpen())result.push('menu');
    if(dragging)result.push('drag');
    if(keyboardFocus())result.push('keyboard');
    if(hoveredControls)result.push('hover');
    return result;
  }
  function cancelTimer(){clearTimeout(timer);timer=null;}
  function paint(next,why){
    visible=!!next;reason=why;
    mounted?.classList.toggle('v51-controls-visible',visible);
  }
  function arm(){
    if(timer||!mounted||!visible||holds().length)return;
    timer=setTimeout(()=>{timer=null;requestHide('idle');},idleDelayMs);
  }
  function bind(){
    const next=player();if(next===mounted)return !!next;
    cancelTimer();mounted=next;hoveredControls=false;dragging=false;dragTarget=null;visible=false;
    if(!next)return false;
    next.classList.add('v51-controls-managed');paint(true,'mounted');arm();return true;
  }
  function show(why='api'){
    if(!bind())return false;
    cancelTimer();paint(true,why);arm();return true;
  }
  function requestHide(why='api'){
    if(!bind())return false;
    cancelTimer();const held=holds();
    if(held.length){paint(true,'held:'+held.join(','));return false;}
    paint(false,why);return true;
  }
  function refresh(){
    if(!bind())return false;
    if(dragTarget&&(!dragTarget.isConnected||dragTarget.disabled)){dragging=false;dragTarget=null;}
    const held=holds();
    if(held.length){cancelTimer();paint(true,'held:'+held.join(','));}
    else arm();
    return true;
  }
  function schedule(){if(!queued)queued=requestAnimationFrame(()=>{queued=0;refresh();});}
  function mouseOverChrome(event){
    if(event.pointerType!=='mouse'||!mounted)return false;
    const bar=mounted.querySelector('.locked-player-controls'),back=mounted.querySelector('.v39-player-back');
    return [bar,back].some(node=>{if(!node)return false;const r=node.getBoundingClientRect();return event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;});
  }
  function endDrag(){if(!dragging)return;dragging=false;dragTarget=null;refresh();}
  F.showControls=node=>{
    if(node&&node===player()){bind();return show('activity');}
    return oldShow?.(node);
  };
  F.render=(...args)=>{const result=render(...args);refresh();schedule();return result;};
  // Capturing before v49/v48 records input modality without changing their media actions.
  window.addEventListener('pointerdown',event=>{
    bind();inputMode='pointer';pointerType=event.pointerType||'mouse';
    if(pointerType!=='mouse')hoveredControls=false;
    if(!mounted?.contains(event.target)){refresh();return;}
    const range=event.target?.closest?.('input[type="range"]');
    if(range&&!range.disabled&&inChrome(range)){dragging=true;dragTarget=range;}
    show('pointer');
  },true);
  window.addEventListener('pointermove',event=>{
    if(!bind())return;
    pointerType=event.pointerType||'mouse';
    const inside=mounted.contains(event.target),previous=hoveredControls;
    hoveredControls=mouseOverChrome(event);
    if(inside){inputMode='pointer';show('pointermove');}
    else if(previous)refresh();
  },true);
  window.addEventListener('pointerout',event=>{
    if(!mounted||!mounted.contains(event.target)||mounted.contains(event.relatedTarget))return;
    hoveredControls=false;refresh();
  },true);
  window.addEventListener('pointerup',endDrag,true);
  window.addEventListener('pointercancel',()=>{hoveredControls=false;endDrag();refresh();},true);
  window.addEventListener('blur',()=>{hoveredControls=false;endDrag();refresh();});
  function keyboard(event){
    if(!bind()||event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
    inputMode='keyboard';hoveredControls=false;
    if(mounted.contains(document.activeElement)||F.v39Viewer?.sheet?.shell?.contains(document.activeElement))show('keyboard');
    else refresh();
  }
  window.addEventListener('keydown',keyboard,true);
  window.addEventListener('keyup',keyboard,true);
  document.addEventListener('focusin',event=>{
    if(!bind())return;
    if(inChrome(event.target)||F.v39Viewer?.sheet?.shell?.contains(event.target))show('focus');
    else refresh();
  });
  document.addEventListener('focusout',()=>queueMicrotask(refresh));
  window.addEventListener('resize',schedule);
  window.addEventListener('pagehide',()=>{cancelTimer();if(queued)cancelAnimationFrame(queued);queued=0;});
  F.v51Controls={show,requestHide,refresh,getState(){
    const node=player(),bar=node?.querySelector('.locked-player-controls'),back=node?.querySelector('.v39-player-back');
    const opacity=bar?Number(getComputedStyle(bar).opacity):null;
    return {supported:!!node,visible:!!node?.classList.contains('v51-controls-visible'),opacity,inputMode,pointerType,holds:holds(),reason,timerPending:timer!==null,idleDelayMs,keyboardFocus:keyboardFocus(),hoveredControls,dragging,paused:!!node?.classList.contains('is-paused'),menuOpen:menuOpen(),focusedId:document.activeElement?.id||document.activeElement?.className||document.activeElement?.tagName||null,backVisible:!!back&&Number(getComputedStyle(back).opacity)>0,controlsRect:bar?.getBoundingClientRect().toJSON()||null};
  }};
  refresh();schedule();
})();
