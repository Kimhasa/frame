/* UIF-005: native viewer range presentation only; v49 remains the audio preference owner. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.root||!F.render||!F.v49Mute||F.v50Volume)return;
  const render=F.render,S=F.v50Volume={dragging:false,observerAttached:false,observerError:null};
  let range=null,wrap=null,hint=null,observer=null,queued=0;
  const player=()=>F.root.querySelector('.watch-layout #video-player');
  const currentRange=()=>player()?.querySelector('#locked-player-volume');
  function unbind(){
    observer?.disconnect();observer=null;if(queued)cancelAnimationFrame(queued);queued=0;
    wrap?.classList.remove('is-dragging');range=null;wrap=null;hint=null;S.dragging=false;S.observerAttached=false;
  }
  function schedule(){if(!queued)queued=requestAnimationFrame(()=>{queued=0;refresh();});}
  function refresh(){
    const input=currentRange(),node=player();if(!input||!node){unbind();return false;}
    if(range!==input){
      unbind();range=input;S.observerError=null;node.classList.add('v50-volume-target');
      wrap=input.parentElement;
      if(!wrap.classList.contains('v50-volume-range')){wrap=document.createElement('span');wrap.className='v50-volume-range';input.before(wrap);wrap.append(input);}
      hint=wrap.querySelector('.v50-volume-value');
      if(!hint){hint=document.createElement('span');hint.className='v50-volume-value';hint.setAttribute('aria-hidden','true');wrap.append(hint);}
      // Observe only the existing model's value output and native disabled attribute, never our own visual changes.
      if(input instanceof HTMLInputElement&&input.ownerDocument===document&&typeof MutationObserver==='function'){
        try{observer=new MutationObserver(schedule);observer.observe(input,{attributes:true,attributeFilter:['aria-valuetext','disabled']});S.observerAttached=true;}
        catch{observer?.disconnect();observer=null;S.observerError='volume-observer-unavailable';}
      }
    }
    const model=F.v49Mute.getState(),text=String(model.effectiveVolume)+'%',position=String(model.effectiveVolume)+'%';
    if(hint.textContent!==text)hint.textContent=text;
    if(wrap.style.getPropertyValue('--v50-volume-position')!==position)wrap.style.setProperty('--v50-volume-position',position);
    const hide=range.disabled||model.blocked;if(hint.hidden!==hide)hint.hidden=hide;
    if(range.disabled&&S.dragging){S.dragging=false;wrap.classList.remove('is-dragging');}
    return true;
  }
  function endDrag(){if(!S.dragging)return;S.dragging=false;wrap?.classList.remove('is-dragging');refresh();}
  function setDisabled(value){if(!refresh())return false;range.disabled=!!value;if(range.disabled)endDrag();refresh();return true;}
  F.render=(...args)=>{const result=render(...args);refresh();return result;};
  window.addEventListener('input',event=>{if(event.target===currentRange())refresh();},true);
  window.addEventListener('pointerover',event=>{if(event.target===currentRange())refresh();},true);
  window.addEventListener('pointerdown',event=>{
    if(event.target!==currentRange()||event.button!==0||event.target.disabled||F.v49Mute.getState().blocked)return;
    refresh();S.dragging=true;wrap.classList.add('is-dragging');
  },true);
  window.addEventListener('pointerup',endDrag,true);window.addEventListener('pointercancel',endDrag,true);window.addEventListener('blur',endDrag);
  document.addEventListener('focusin',event=>{if(event.target===currentRange())refresh();});
  document.addEventListener('focusout',event=>{if(event.target===range)endDrag();});
  window.addEventListener('resize',schedule);window.addEventListener('pagehide',event=>{if(!event.persisted)unbind();});
  Object.assign(S,{refresh,setDisabled,getState(){
    const input=currentRange(),model=F.v49Mute.getState(),output=input?.parentElement.querySelector('.v50-volume-value'),style=output?getComputedStyle(output):null;
    return {supported:model.supported,blocked:model.blocked,disabled:input?.disabled??null,value:model.sliderVolume,muted:model.muted,rememberedVolume:model.lastPositive,tooltipText:output?.textContent||null,tooltipVisible:!!output&&!output.hidden&&style?.visibility!=='hidden'&&Number(style?.opacity)>0,hovered:!!input?.matches(':hover'),focused:document.activeElement===input,focusVisible:!!input?.matches(':focus-visible'),dragging:S.dragging,rangeRect:input?.getBoundingClientRect().toJSON()||null,icon:model.icon,observerAttached:S.observerAttached,observerError:S.observerError};
  }});
  refresh();
})();
