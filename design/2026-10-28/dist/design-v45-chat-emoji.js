/* UIF-013: eight local Unicode choices for viewer chat. No message is sent here. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.genericDialog||F.v45ChatEmoji)return;
  const D=F.dialog,old={render:F.render,navigate:F.navigate,close:F.closeModal};
  const screens=new Set(['watch','vod-watch','clip-watch']);
  const choices=[['😀','활짝 웃는 얼굴'],['😊','미소 짓는 얼굴'],['👏','박수'],['💚','초록색 하트'],['👍','좋아요'],['🎉','축하'],['👀','눈'],['☕','커피']];
  const S=F.v45ChatEmoji={opened:false,closing:false,status:'closed',error:'',selected:null,target:null};
  let captured=null,generation=0;
  const supported=()=>screens.has(F.screen);
  const ownDialog=()=>S.opened&&D.open&&D.classList.contains('v45-chat-emoji');
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const inputNode=()=>F.root.querySelector('.watch-layout .chat-panel #chat-message');
  const triggerNode=()=>F.root.querySelector('#v45-chat-emoji-trigger');
  const currentId=()=>F.v38Viewer?.current()?.id||F.screen+':'+F.selectedBroadcast;
  function editable(input){
    if(!supported()||!F.sessionLoggedIn||F.chatOpen===false||!input?.isConnected||input.disabled||input.readOnly)return false;
    const panel=input.closest('.chat-panel');if(!panel||panel.hidden||!panel.getClientRects().length)return false;
    const key=panel.dataset.v38Room;
    return !key||!F.v38Viewer?.chatRoom||F.v38Viewer.chatRoom(key).mode==='open';
  }
  function polish(){
    if(!supported())return;
    const input=inputNode(),button=F.root.querySelector('.watch-layout [data-action="v38-viewer-emoji"],.watch-layout [data-action="v45-chat-emoji-open"]');
    if(!button)return;
    button.id='v45-chat-emoji-trigger';button.type='button';button.dataset.action='v45-chat-emoji-open';
    button.classList.add('v45-chat-emoji-trigger');button.disabled=!editable(input);
    if(!button.querySelector('[data-v45-smile]'))button.innerHTML='<svg data-v45-smile viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r=".7" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".7" fill="currentColor" stroke="none"/><path d="M8.5 14a4 4 0 0 0 7 0"/></svg>';
    button.setAttribute('aria-label','이모티콘 선택');button.title='이모티콘 선택';
    button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls',D.id);
    button.setAttribute('aria-expanded',String(ownDialog()));
  }
  // Expand a boundary inside a UTF-16 surrogate pair instead of splitting an emoji.
  function range(value,start,end){
    const inside=index=>index>0&&index<value.length&&/[\uD800-\uDBFF]/.test(value[index-1])&&/[\uDC00-\uDFFF]/.test(value[index]);
    start=Math.max(0,Math.min(value.length,start));end=Math.max(start,Math.min(value.length,end));
    if(start===end&&inside(start))return {start:start+1,end:end+1};
    return {start:inside(start)?start-1:start,end:inside(end)?end+1:end};
  }
  function snapshot(trigger,input){
    const panel=input.closest('.chat-panel'),list=panel.querySelector('.chat-messages'),scrollRoom=F.v34Chat?.rooms.get(panel.dataset.v34ChatRoom);
    return {screen:F.screen,channelIndex:Number(F.selectedBroadcast)||0,contentId:currentId(),room:panel.dataset.v38Room,trigger,input,panel,list,value:input.value,
      start:input.selectionStart??input.value.length,end:input.selectionEnd??input.value.length,direction:input.selectionDirection||'none',
      top:list?.scrollTop||0,follow:typeof scrollRoom?.follow==='boolean'?scrollRoom.follow:true,latestHidden:panel.querySelector('.v34-chat-latest')?.hidden??true};
  }
  function sameTarget(target){
    return !!target&&supported()&&F.screen===target.screen&&currentId()===target.contentId&&Number(F.selectedBroadcast||0)===target.channelIndex&&
      inputNode()===target.input&&target.panel.isConnected&&target.input.closest('.chat-panel')===target.panel&&target.panel.dataset.v38Room===target.room;
  }
  function restoreLog(target){
    if(!sameTarget(target)||!target.list?.isConnected)return;
    const list=target.list,state=F.v34Chat?.rooms.get(target.panel.dataset.v34ChatRoom);
    list.scrollTop=target.follow?list.scrollHeight:Math.max(0,Math.min(target.top,list.scrollHeight-list.clientHeight));
    if(state){state.follow=target.follow;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;}
    const latest=target.panel.querySelector('.v34-chat-latest');if(latest)latest.hidden=target.latestHidden;
  }
  function restore(target,kind){
    if(!sameTarget(target))return;
    if(kind==='trigger'){
      if(target.input.value===target.value)target.input.setSelectionRange(target.start,target.end,target.direction);
      if(target.trigger.isConnected&&!target.trigger.disabled)target.trigger.focus({preventScroll:true});
      else target.list?.focus({preventScroll:true});
    }
    restoreLog(target);requestAnimationFrame(()=>restoreLog(target));
  }
  function position(){
    if(!ownDialog()||F.v39Mobile?.isMobile())return;
    const anchor=captured?.trigger;if(!anchor?.isConnected)return;
    const rect=anchor.getBoundingClientRect(),box=D.getBoundingClientRect(),viewport=window.visualViewport;
    const leftEdge=(viewport?.offsetLeft||0)+12,topEdge=(viewport?.offsetTop||0)+12;
    const width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
    const left=Math.max(leftEdge,Math.min(rect.left,leftEdge+width-box.width-24));
    const above=rect.top-box.height-8,top=above>=topEdge?above:Math.max(topEdge,Math.min(rect.bottom+8,topEdge+height-box.height-24));
    D.style.setProperty('--v45-emoji-left',left+'px');D.style.setProperty('--v45-emoji-top',top+'px');
  }
  function showError(message){
    S.status='error';S.error=message;const error=D.querySelector('#v45-chat-emoji-error');
    if(error){error.textContent=message;error.hidden=false;}position();
  }
  function open(trigger=triggerNode()){
    polish();const input=inputNode();
    if(S.closing||ownDialog()||D.open||!trigger?.isConnected||!editable(input))return false;
    const target=captured=snapshot(trigger,input),ticket=++generation;
    trigger.focus({preventScroll:true});
    S.opened=true;S.status='open';S.error='';S.selected=null;
    S.target={screen:target.screen,channelIndex:target.channelIndex,contentId:target.contentId,room:target.room};
    const body='<div class="v45-emoji-grid" role="group" aria-label="이모티콘 선택">'+choices.map(([emoji,label],index)=>
      '<button type="button" data-action="v45-chat-emoji-select" data-emoji="'+emoji+'" aria-label="'+label+'" title="'+label+'" tabindex="'+(index===0?'0':'-1')+'"><span aria-hidden="true">'+emoji+'</span></button>').join('')+
      '</div><p id="v45-chat-emoji-error" class="v45-emoji-error" role="alert" hidden></p>';
    F.genericDialog('이모티콘',body,'');D.classList.add('v45-chat-emoji');D.dataset.mobilePresentation='sheet';
    const close=D.querySelector('.modal-head>button');if(close){close.dataset.action='v45-chat-emoji-close';close.id='v45-chat-emoji-close';close.setAttribute('aria-label','이모티콘 닫기');}
    const footer=D.querySelector('.modal-footer');if(footer){footer.replaceChildren();footer.hidden=true;}
    document.body.classList.add('v45-chat-emoji-open');trigger.setAttribute('aria-expanded','true');
    F.v39Mobile?.polish();position();
    requestAnimationFrame(()=>{if(ticket!==generation||!ownDialog())return;position();D.querySelector('[data-emoji]')?.focus({preventScroll:true});restoreLog(target);});
    return true;
  }
  function close(options={}){
    if(!S.opened)return false;
    const target=captured,ticket=++generation;captured=null;S.opened=false;S.status=options.selected?'selected':'closed';S.error='';
    const deferred=!!(F.v39Mobile?.isMobile()&&F.v39Mobile.history?.owned);S.closing=deferred;
    const finish=()=>{if(ticket!==generation)return;S.closing=false;if(typeof options.after==='function')options.after(target);else if(options.focus!==false)restore(target,'trigger');};
    if(deferred)F.v39Mobile.afterDialogClose(finish);
    if(D.open)D.close();F.root.inert=false;const backdrop=document.querySelector('.modal-backdrop');if(backdrop)backdrop.hidden=true;
    delete D.dataset.mobilePresentation;D.classList.remove('v45-chat-emoji');D.style.removeProperty('--v45-emoji-left');D.style.removeProperty('--v45-emoji-top');
    document.body.classList.remove('v45-chat-emoji-open');target?.trigger?.setAttribute('aria-expanded','false');
    F.v39Mobile?.polish();if(!deferred)finish();return true;
  }
  function select(emoji){
    if(!ownDialog()||!choices.some(choice=>choice[0]===emoji))return false;
    const target=captured;if(!sameTarget(target)||!editable(target.input)){close({focus:false});return false;}
    if(target.input.value!==target.value){showError('입력 내용이 바뀌었어요. 다시 열어 선택하세요.');return false;}
    const selectedRange=range(target.value,target.start,target.end),limit=Math.min(1000,target.input.maxLength>0?target.input.maxLength:1000);
    if(target.value.length-(selectedRange.end-selectedRange.start)+emoji.length>limit){showError('이모티콘을 넣으려면 메시지를 조금 줄여 주세요.');return false;}
    S.selected=emoji;
    return close({selected:true,focus:false,after:saved=>{
      if(!sameTarget(saved)||!editable(saved.input)||saved.input.value!==saved.value)return;
      saved.input.setRangeText(emoji,selectedRange.start,selectedRange.end,'end');
      saved.input.dispatchEvent(new Event('input',{bubbles:true}));
      saved.input.focus({preventScroll:true});restoreLog(saved);requestAnimationFrame(()=>{
        restoreLog(saved);
        if(!D.open&&!S.opened&&sameTarget(saved)&&editable(saved.input)&&[saved.trigger,saved.input,document.body].includes(document.activeElement))saved.input.focus({preventScroll:true});
      });
    }});
  }
  F.closeModal=(...args)=>ownDialog()?close():old.close(...args);
  F.navigate=(...args)=>{if(ownDialog()){close({focus:false,after:()=>old.navigate(...args)});return;}if(S.closing){generation++;S.closing=false;}return old.navigate(...args);};
  F.render=(...args)=>{if(ownDialog())close({focus:false});else if(S.closing){generation++;S.closing=false;}const result=old.render(...args);polish();return result;};
  window.addEventListener('click',event=>{
    const button=event.target.closest?.('button');if(!button||button.disabled)return;
    const action=button.dataset.action;if(!action?.startsWith('v45-chat-emoji-'))return;stop(event);
    if(action==='v45-chat-emoji-open')open(button);else if(action==='v45-chat-emoji-close')close();else if(action==='v45-chat-emoji-select')select(button.dataset.emoji);
  },true);
  window.addEventListener('keydown',event=>{
    const trigger=event.target.closest?.('[data-action="v45-chat-emoji-open"]');
    if(trigger&&supported()&&(event.code==='Space'||[' ','Spacebar','Enter'].includes(event.key))){event.stopImmediatePropagation();return;}
    if(!ownDialog()||!D.contains(event.target))return;
    if(event.key==='Escape'){stop(event);close();return;}
    if(event.key==='Tab'){
      event.stopImmediatePropagation();const buttons=[...D.querySelectorAll('button:not(:disabled)')].filter(button=>button.tabIndex>=0&&button.getClientRects().length),index=buttons.indexOf(document.activeElement);
      if(event.shiftKey&&index<=0){event.preventDefault();buttons.at(-1)?.focus({preventScroll:true});}
      else if(!event.shiftKey&&index===buttons.length-1){event.preventDefault();buttons[0]?.focus({preventScroll:true});}return;
    }
    const button=event.target.closest('[data-emoji]');
    if(button&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)){
      stop(event);const buttons=[...D.querySelectorAll('[data-emoji]')],index=buttons.indexOf(button);
      const next={ArrowLeft:(index+7)%8,ArrowRight:(index+1)%8,ArrowUp:(index+4)%8,ArrowDown:(index+4)%8,Home:0,End:7}[event.key];
      buttons.forEach((item,i)=>item.tabIndex=i===next?0:-1);buttons[next].focus({preventScroll:true});return;
    }
    if(event.code==='Space'||[' ','Spacebar','Enter'].includes(event.key))event.stopImmediatePropagation();
  },true);
  window.addEventListener('resize',position);window.visualViewport?.addEventListener('resize',position);
  Object.assign(S,{open,close,select,getState(){const input=captured?.input?.isConnected?captured.input:inputNode();return {supported:supported(),opened:ownDialog(),closing:S.closing,status:S.status,error:S.error,selected:S.selected,target:S.target?{...S.target}:null,draft:input?.value??null,selectionStart:input?.selectionStart??null,selectionEnd:input?.selectionEnd??null};}});
  polish();
})();
