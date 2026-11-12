/* UIF-010: one local share overlay. URLs point at this prototype origin, not an Internet publishing service. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.genericDialog||F.v43Share)return;
  const old={navigate:F.navigate,close:F.closeModal,modal:F.renderModal},D=F.dialog,e=F.e;
  const S=F.v43Share={opened:false,target:null,status:'idle',error:'',includeTime:false,copyTransport:null,token:0,direct:false,origin:null};
  let copyFocus=null;
  const btn=(label,action,icon='',cls='',attrs='')=>F.btn(label,'v43-share-'+action,icon,cls,attrs);
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const valid=index=>Number.isInteger(index)&&!!F.broadcasts[index];
  const baseScreen=()=>F.modalScreens.has(F.screen)?F.currentBase:F.screen;
  const clock=value=>{const n=Math.max(0,Math.floor(value));return n>=3600?Math.floor(n/3600)+':'+String(Math.floor(n/60)%60).padStart(2,'0')+':'+String(n%60).padStart(2,'0'):Math.floor(n/60)+':'+String(n%60).padStart(2,'0');};
  const ownDialog=()=>S.opened&&D.open&&D.classList.contains('v43-share');
  function snapshot(options={}){
    const base=baseScreen(),studio=options.kind==='studio'||(!options.kind&&base==='studio'),viewer=F.v38Viewer,current=viewer?.current();
    let index=studio?0:Number(options.channelIndex??current?.channelIndex??F.selectedBroadcast??0);if(!valid(index))index=0;
    const b=F.broadcasts[index],kind=studio?'studio':options.kind||(F.screen==='share'&&current?.kind?current.kind:['watch','vod-watch','clip-watch'].includes(base)?{watch:'live','vod-watch':'vod','clip-watch':'clip'}[base]:current?.kind||'live');
    const contentKind=kind==='studio'?'live':kind;
    const matching=current?.channelIndex===index&&current.kind===contentKind?current:null;
    const id=studio?(viewer?.contentIdFor('live',0)||'live-0'):options.id||matching?.id||viewer?.contentIdFor(contentKind,index)||'live-'+index;
    const record=viewer?.contentMap.get(id)||matching;
    const title=String(studio?(F.studioDraft?.title||b.title):(options.title||record?.title||b.title));
    const channel=String(studio?(F.accountDesign?.savedChannel?.name||b.name):b.name);
    const u=new URL(location.href);u.search='';u.hash='';
    for(const [key,value]of Object.entries({screen:contentKind==='vod'?'vod-watch':contentKind==='clip'?'clip-watch':'watch',device:'desktop',state:'기본',channel:'channel-'+index,content:id}))u.searchParams.set(key,value);
    let position=null;
    if(kind==='vod'&&base==='vod-watch'&&(!matching||matching.id===id)){
      const input=F.root.querySelector('#timeline'),value=input?Number(input.value):NaN;
      if(Number.isFinite(value)){const duration=Number(record?.duration);position=Math.max(0,Math.floor(Number.isFinite(duration)?Math.min(value,duration):value));}
    }
    return Object.freeze({kind,channelIndex:index,id,title,channel,initial:studio?'봄':b.initial,baseUrl:u.toString(),position});
  }
  function url(){if(!S.target)return '';const u=new URL(S.target.baseUrl);if(S.target.kind==='vod'&&S.includeTime&&Number.isFinite(S.target.position))u.searchParams.set('t',String(S.target.position));return u.toString();}
  function body(){const t=S.target;return '<div class="v31-share-summary">'+F.avatar(t.initial,'round')+'<div><strong>'+e(t.title)+'</strong><p>'+e(t.channel)+'</p></div></div><label class="sr-only" for="share-link">공유 링크</label><div class="share-url"><input id="share-link" type="text" inputmode="url" readonly value="'+e(url())+'" aria-label="공유 링크"><button type="button" class="primary v43-share-copy" data-action="v43-share-copy">'+F.icon('copy')+'<span>복사</span></button></div>'+(t.kind==='vod'?'<label class="v43-share-time"><input type="checkbox" id="v43-share-time" '+(t.position===null?'disabled':'')+'><span>현재 재생 위치부터 공유</span>'+(t.position===null?'':'<time>'+clock(t.position)+'</time>')+'</label>':'')+'<div class="v43-share-error" hidden><p role="alert"></p>'+btn('주소 선택','select','','ghost small')+'</div><p class="sr-only v43-share-status" role="status" aria-live="polite" aria-atomic="true"></p>';}
  function styleDialog(){
    D.classList.add('v31-share','v43-share');D.dataset.mobilePresentation='sheet';D.setAttribute('aria-modal','true');
    const close=D.querySelector('.modal-head>button');if(close){close.dataset.action='v43-share-close';close.id='v43-share-close';close.setAttribute('aria-label','공유 닫기');}
    const footer=D.querySelector('.modal-footer');if(footer){footer.replaceChildren();footer.hidden=true;}
    F.v39Mobile?.polish();
  }
  function paint(){
    if(!ownDialog())return;
    const busy=S.status==='copying',input=D.querySelector('#share-link'),copy=D.querySelector('[data-action="v43-share-copy"]'),time=D.querySelector('#v43-share-time');
    if(input)input.value=url();
    if(copy){copy.disabled=busy;copy.setAttribute('aria-busy',String(busy));copy.innerHTML=F.icon(S.status==='success'?'check':'copy')+'<span>'+({copying:'복사 중',success:'복사됨'}[S.status]||'복사')+'</span>';}
    if(time){time.checked=S.includeTime;time.disabled=busy||S.target.position===null;}
    const error=D.querySelector('.v43-share-error');if(error){error.hidden=S.status!=='error';error.querySelector('p').textContent=S.status==='error'?S.error:'';}
    D.querySelector('.v43-share-status').textContent=S.status==='copying'?'링크를 복사하고 있어요.':S.status==='success'?'링크를 복사했어요.':'';
  }
  function remember(){return {screen:F.screen,x:scrollX,y:scrollY,mainTop:F.root.querySelector('#main-content')?.scrollTop||0,trigger:document.activeElement?.closest?.('button,a')};}
  function restore(origin){
    if(!origin||F.screen!==origin.screen)return;
    window.scrollTo({left:origin.x,top:origin.y,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top:origin.mainTop});
    const target=origin.trigger?.isConnected&&!origin.trigger.disabled?origin.trigger:F.root.querySelector('[data-go="share"]');target?.focus({preventScroll:true});
  }
  function open(options={}){
    const already=ownDialog();if(!already){if(D.open)return false;S.origin=remember();}
    const direct=already&&S.direct&&F.screen==='share';copyFocus=null;S.token++;S.target=snapshot(options);S.opened=true;S.direct=direct;S.status='idle';S.error='';S.includeTime=false;
    F.genericDialog('공유',body(),'');styleDialog();paint();
    requestAnimationFrame(()=>{if(ownDialog()&&S.status==='idle')D.querySelector('[data-action="v43-share-copy"]')?.focus({preventScroll:true});});
    return true;
  }
  function close(after){
    if(!S.opened)return;
    const direct=S.direct,origin=S.origin;copyFocus=null;S.token++;S.opened=false;S.direct=false;S.origin=null;S.status='idle';S.error='';
    const finish=()=>{if(typeof after==='function')after();else restore(origin);};
    if(direct){const target=S.target;if(target){F.selectedBroadcast=target.channelIndex;F.currentBase=target.kind==='vod'?'vod-watch':target.kind==='clip'?'clip-watch':'watch';if(F.v38Viewer){F.v38Viewer.activeId=target.id;F.v38Viewer.intent=target.id;}}delete D.dataset.mobilePresentation;D.classList.remove('v43-share');old.close();if(typeof after==='function')after();return;}
    const deferred=!!(F.v39Mobile?.isMobile()&&F.v39Mobile.history?.owned);
    if(deferred)F.v39Mobile.afterDialogClose(finish);
    F.closeDropdown();if(D.open)D.close();F.root.inert=false;const backdrop=document.querySelector('.modal-backdrop');if(backdrop)backdrop.hidden=true;
    delete D.dataset.mobilePresentation;D.classList.remove('v43-share');F.v39Mobile?.polish();
    if(!deferred)finish();
  }
  function selectAddress(){const input=D.querySelector('#share-link');if(input){input.focus({preventScroll:true});input.select();try{input.setSelectionRange(0,input.value.length);}catch{}}}
  async function copy(){
    if(!ownDialog()||S.status==='copying')return;
    const focusedCopy=document.activeElement===D.querySelector('[data-action="v43-share-copy"]');
    const token=++S.token,target=S.target,value=url();S.status='copying';S.error='';paint();
    if(focusedCopy){const input=D.querySelector('#share-link');copyFocus={token,node:input,untouched:true};input?.focus({preventScroll:true});}
    try{
      let result;
      if(S.copyTransport)result=await S.copyTransport(value,target);
      else{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');result=await navigator.clipboard.writeText(value);}
      if(result===false)throw new Error('Copy fixture rejected');
      if(!ownDialog()||S.token!==token||S.target!==target)return;S.status='success';paint();
      if(copyFocus?.token===token&&copyFocus.untouched&&document.activeElement===copyFocus.node)D.querySelector('[data-action="v43-share-copy"]')?.focus({preventScroll:true});
      copyFocus=null;
    }catch{
      if(!ownDialog()||S.token!==token||S.target!==target)return;copyFocus=null;S.status='error';S.error='복사하지 못했어요. 주소를 선택해 직접 복사하세요.';paint();selectAddress();
    }
  }
  // The historical screen=share entry remains usable. UI buttons use the overlay above.
  F.modals.share=()=>{if(!S.opened||!S.direct){S.token++;S.target=snapshot();S.includeTime=false;S.status='idle';S.error='';S.opened=true;S.direct=true;S.origin=null;}return {title:'공유',body:body(),footer:'',cls:'v31-share v43-share'};};
  F.renderModal=(...args)=>{const value=old.modal(...args);if(F.screen==='share'){styleDialog();paint();if(D.open&&!D.contains(document.activeElement))(D.querySelector('[data-action="v43-share-copy"]:not(:disabled)')||D.querySelector('.modal-head>button'))?.focus({preventScroll:true});}return value;};
  F.navigate=(id,...args)=>{
    if(id==='share'){open();return;}
    if(ownDialog()){close(()=>old.navigate(id,...args));return;}
    if(S.opened){S.opened=false;S.token++;}
    return old.navigate(id,...args);
  };
  F.closeModal=(...args)=>{if(ownDialog()){close();return;}return old.close(...args);};
  window.addEventListener('click',event=>{const b=event.target.closest?.('button');if(!b||b.disabled)return;const action=b.dataset.action||'';if(!action.startsWith('v43-share-'))return;stop(event);if(action==='v43-share-copy')copy();else if(action==='v43-share-select')selectAddress();else if(action==='v43-share-close')close();},true);
  window.addEventListener('change',event=>{if(event.target.id!=='v43-share-time'||!ownDialog())return;S.token++;S.includeTime=event.target.checked;S.status='idle';S.error='';paint();},true);
  D.addEventListener('focusin',event=>{if(copyFocus&&event.target!==copyFocus.node)copyFocus.untouched=false;},true);
  for(const name of ['pointerdown','keydown'])D.addEventListener(name,()=>{if(copyFocus)copyFocus.untouched=false;},true);
  Object.assign(S,{open,close,copy,setCopyTransport(fn){S.copyTransport=typeof fn==='function'?fn:null;},getState(){return {opened:ownDialog(),direct:S.direct,status:S.status,target:S.target?{...S.target}:null,url:url(),includeTime:S.includeTime,error:S.error};}});
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  if(F.screen==='share')F.renderModal();
})();
