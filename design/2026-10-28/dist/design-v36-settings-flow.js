/* Local prototype only: transactional settings and return-to-origin. Media renderers stay intact. */
(()=>{
  'use strict';
  const F=window.F,clone=value=>JSON.parse(JSON.stringify(value));
  const state=F.v36Settings={session:null,saved:{audio:[80,60],recording:true},origin:null,connectionProtocol:null};
  const original={navigate:F.navigate,close:F.closeModal,background:F.modalBackground,settings:F.modals['broadcast-settings'],readUrl:F.readUrl};
  const scoped=new Set(['connection','broadcast-settings']);
  function begin(){
    if(!state.session)state.session={values:clone(F.values),auto:F.bitrateAuto,extra:clone(state.saved)};
  }
  function finish(commit=false){
    const session=state.session;if(!session)return;
    if(commit)state.saved=clone(session.extra);
    else{Object.keys(F.values).forEach(key=>delete F.values[key]);Object.assign(F.values,session.values);F.bitrateAuto=session.auto;}
    state.session=null;
  }
  F.modalBackground=id=>scoped.has(id)&&state.origin?state.origin.screen:original.background(id);
  F.navigate=(id,viewState,replace=false)=>{
    if(scoped.has(id)&&!F.modalScreens.has(F.screen))state.origin={screen:F.screen,state:F.viewState};
    if(id==='broadcast-settings'&&F.screen!=='broadcast-settings')begin();
    if(id==='connection'&&F.screen!=='connection')state.connectionProtocol=F.values.protocol;
    if(F.screen==='broadcast-settings'&&id!=='broadcast-settings')finish();
    if(state.origin&&id===state.origin.screen&&!viewState)viewState=state.origin.state;
    const result=original.navigate(id,viewState,replace);
    if(!F.modalScreens.has(id))state.origin=null;
    return result;
  };
  F.closeModal=()=>{
    if(F.screen==='broadcast-settings')finish();
    if(F.screen==='connection'&&!F.v33Account?.connectionAccepted){
      if(state.connectionProtocol===undefined)delete F.values.protocol;else F.values.protocol=state.connectionProtocol;
    }
    return original.close();
  };
  F.readUrl=(...args)=>{
    const previous=F.screen,result=original.readUrl(...args);
    if(previous==='broadcast-settings'&&F.screen!=='broadcast-settings')finish();
    if(!scoped.has(F.screen))state.origin=null;
    return result;
  };
  F.modals['broadcast-settings']=viewState=>{
    begin();const cfg=original.settings(viewState),holder=document.createElement('div');holder.innerHTML=cfg.body;
    holder.querySelectorAll('.audio-row input[type="range"]').forEach((input,index)=>{
      const value=state.session.extra.audio[index];input.value=String(value);input.setAttribute('value',String(value));
      input.dataset.v36Audio=String(index);const label=input.closest('.audio-row')?.querySelector('.audio-head span');if(label)label.textContent=value+'%';
    });
    const recording=holder.querySelector('[data-key="recording"]');if(recording)recording.setAttribute('aria-checked',String(state.session.extra.recording));
    for(const [key,fallback] of [['microphone','기본 마이크'],['storage','100 GB']]){
      const span=holder.querySelector(`[data-key="${key}"] span`);if(span)span.textContent=F.values[key]||fallback;
    }
    return {...cfg,body:holder.innerHTML};
  };
  window.addEventListener('input',event=>{
    const input=event.target;if(F.screen!=='broadcast-settings'||!input.hasAttribute?.('data-v36-audio'))return;
    begin();const value=Number(input.value);state.session.extra.audio[Number(input.dataset.v36Audio)]=value;
    const label=input.closest('.audio-row')?.querySelector('.audio-head span');if(label)label.textContent=value+'%';
  },true);
  window.addEventListener('click',event=>{
    if(F.screen!=='broadcast-settings')return;
    const button=event.target.closest?.('button');if(!button||button.disabled)return;
    if(button.dataset.action==='toggle'&&button.dataset.key==='recording'){
      begin();state.session.extra.recording=button.getAttribute('aria-checked')!=='true';return;
    }
    if(button.dataset.action!=='apply-settings')return;
    const input=F.dialog.querySelector('[name="bitrate"]');
    if(input&&!input.disabled){const value=Number(input.value);if(!input.value.trim()||!Number.isFinite(value)||value<.5||value>200)return;F.values.bitrate=String(value);}
    event.preventDefault();event.stopImmediatePropagation();finish(true);F.closeModal();F.toast('방송 설정을 저장했어요.');
  },true);
  if(F.screen==='broadcast-settings')begin();
  if(F.screen==='connection')state.connectionProtocol=F.values.protocol;
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
})();
