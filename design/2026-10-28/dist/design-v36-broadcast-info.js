/* Broadcast metadata drafts only. No publishing permission or media/encoder behavior. */
(()=>{
  const F=window.F;if(!F?.studioDraft)return;
  const studio=F.studio,details=F.modals['broadcast-details'],navigate=F.navigate;
  const copy=data=>Object.fromEntries(['title','category','visibility','tags'].map(key=>[key,String(data?.[key]||'')]));
  const same=(a,b)=>JSON.stringify(copy(a))===JSON.stringify(copy(b));
  const S=F.v36BroadcastInfo={saved:copy(F.studioDraft),startIntent:false};
  const dirty=()=>!same(F.studioDraft,S.saved);
  S.isDirty=dirty;
  const syncCatalog=()=>{if(F.broadcasts?.[0]){F.broadcasts[0].title=S.saved.title;F.broadcasts[0].category=S.saved.category;}};
  function commit(data){
    S.saved=copy(data);S.saved.title=S.saved.title.trim();F.studioDraft=copy(S.saved);F.studioTitleError=false;syncCatalog();
  }
  function footer(scope){
    const form=scope.querySelector('#v3-studio-info');if(!form)return;
    const bottom=form.querySelector('.v3-studio-form-bottom'),save=form.querySelector('[data-action="v3-studio-save"]');if(!bottom||!save)return;
    const changed=dirty();save.type='button';save.disabled=!changed;
    let cancel=bottom.querySelector('[data-action="v36-info-cancel"]');
    if(changed&&!cancel){const h=document.createElement('div');h.innerHTML=F.btn('취소','v36-info-cancel','','small');cancel=h.firstElementChild;cancel.type='button';save.before(cancel);}
    if(!changed)cancel?.remove();
    const note=bottom.querySelector(':scope>span');if(note){note.classList.add('v36-info-note');note.setAttribute('role','status');note.textContent=changed?'저장하지 않은 변경사항이 있어요.':'';}
    bottom.classList.add('v36-info-footer');
  }
  function modalFooter(scope){
    const save=scope.querySelector('[data-action="v3-studio-save-details"]');if(save)save.disabled=same(F.studioModalDraft||S.saved,S.saved);
  }
  function focusHeading(){const heading=F.root.querySelector('.v3-studio-broadcast-info h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
  function validate(data,modal){
    if(data?.title.trim())return true;
    F.studioTitleError=true;modal?F.renderModal():F.render();
    (modal?F.dialog:F.root).querySelector('[data-v3-studio-field="title"]')?.focus();return false;
  }
  F.studio=viewState=>{
    const active=viewState==='방송 중'||(viewState!=='방송 전'&&F.broadcasting),draft=F.studioDraft,titleError=F.studioTitleError;
    let html;
    if(active)F.studioDraft=copy(S.saved);
    if(F.screen==='broadcast-details')F.studioTitleError=false;
    try{html=studio(viewState);}finally{F.studioDraft=draft;F.studioTitleError=titleError;}
    const h=document.createElement('div');h.innerHTML=html;footer(h);return h.innerHTML;
  };
  F.modals['broadcast-details']=viewState=>{
    if(!F.studioModalDraft)F.studioModalDraft=copy(S.saved);
    const cfg=details(viewState),h=document.createElement('div');h.innerHTML=cfg.footer;modalFooter(h);
    return {...cfg,footer:h.innerHTML};
  };
  F.navigate=(id,viewState,replace=false)=>{
    if(id==='broadcast-details'&&F.screen!=='broadcast-details')F.studioModalDraft=copy(S.saved);
    // A start intent reaches this transition only after the existing source/connection guards.
    if(S.startIntent&&id==='studio'&&viewState==='방송 중'&&F.studioDraft.title.trim())commit(F.studioDraft);
    return navigate(id,viewState,replace);
  };
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  window.addEventListener('click',event=>{
    const button=event.target.closest?.('button[data-action]');if(!button||button.disabled)return;
    const action=button.dataset.action;
    if(['v3-studio-start','start-broadcast'].includes(action)){
      if(!validate(F.studioDraft,false)){stop(event);return;}
      S.startIntent=true;setTimeout(()=>S.startIntent=false,0);return;
    }
    if(action==='v3-studio-save'){
      stop(event);if(!validate(F.studioDraft,false))return;commit(F.studioDraft);F.render();focusHeading();F.toast('방송 정보를 저장했어요.');
    }
    if(action==='v36-info-cancel'){
      stop(event);F.studioDraft=copy(S.saved);F.studioTitleError=false;F.render();focusHeading();
    }
    if(action==='v3-studio-save-details'){
      stop(event);if(!validate(F.studioModalDraft,true))return;commit(F.studioModalDraft);F.studioModalDraft=null;F.closeModal();F.toast('방송 정보를 저장했어요.');
    }
  },true);
  window.addEventListener('input',event=>{
    if(!event.target.matches?.('[data-v3-studio-field]'))return;
    // The original field listener owns the draft; update its controls after that listener runs.
    footer(F.root);modalFooter(F.dialog);
  });
  syncCatalog();
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  F.render();
})();
