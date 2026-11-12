/* UIF-001: local follow interaction study. No account or media service is called. */
(()=>{
  'use strict';
  const F=window.F,old={render:F.render,navigate:F.navigate},store=F.v33Viewer.following;
  const S=F.v41Follow={pending:new Map(),transport:null,loginIntent:null,feedback:null,followerRooms:new Set()};
  const current=()=>Number.isInteger(F.selectedBroadcast)?F.selectedBroadcast:0;
  const label=on=>on?'팔로우 취소':'팔로우';
  const name=index=>F.broadcasts[index]?.name||'채널';
  let timer;
  const feedback=document.createElement('div');
  feedback.id='v41-follow-feedback';feedback.hidden=true;document.body.append(feedback);
  function clearFeedback(){clearTimeout(timer);S.feedback=null;feedback.hidden=true;feedback.replaceChildren();}
  function showFeedback(message,action,index,target,error=false){
    clearFeedback();S.feedback={message,action,index,target,screen:F.screen,error};
    feedback.setAttribute('role',error?'alert':'status');
    feedback.innerHTML='<span>'+F.e(message)+'</span>'+(action?F.btn(error?'다시 시도':'실행 취소','v41-follow-feedback-action','','ghost small'):'')+F.btn('','v41-follow-feedback-close','close','icon ghost','aria-label="알림 닫기"');
    feedback.hidden=false;if(!error)timer=setTimeout(clearFeedback,6000);
  }
  function paint(){
    const index=current(),on=!!F.sessionLoggedIn&&store.has(index),busy=S.pending.has(index);
    F.root.querySelectorAll('[data-action="follow"],[data-action="v33-viewer-follow"],[data-action="v41-follow"]').forEach((button,ordinal)=>{
      button.id='v41-follow-'+index+'-'+ordinal;
      button.dataset.action='v41-follow';button.dataset.followIndex=index;button.dataset.following=String(on);
      if(button.parentElement.classList.contains('row'))button.parentElement.classList.add('v41-follow-actions');
      button.classList.add('v41-follow-button');button.classList.toggle('primary',!on);button.disabled=busy;
      button.setAttribute('aria-label',name(index)+' '+label(on)+(busy?' 처리 중':''));
      button.setAttribute('aria-busy',String(busy));button.removeAttribute('aria-pressed');
      button.innerHTML=F.icon('heart')+'<span>'+label(on)+'</span>';
    });
    F.root.querySelectorAll('[data-action="v38-viewer-chat-follow"],[data-action="v41-follow-chat"]').forEach(button=>{
      button.dataset.action='v41-follow-chat';button.disabled=busy;button.setAttribute('aria-busy',String(busy));
      button.setAttribute('aria-label',name(index)+' 팔로우');
    });
    if(S.feedback&&S.feedback.screen!==F.screen)clearFeedback();
  }
  function sync(index,on){
    if(on)store.add(index);else store.delete(index);
    const room=F.v38Viewer?.chatRoom(String(index)),previousMode=room?.mode;
    if(room?.mode==='followers')S.followerRooms.add(index);
    if(on&&room?.mode==='followers')room.mode='open';
    else if(!on&&room?.mode==='open'&&S.followerRooms.has(index))room.mode='followers';
    if(F.currentBase==='following'){F.render();return;}
    const side=F.root.querySelector('.sidebar');
    if(side){const host=document.createElement('div');host.innerHTML=F.sidebar(F.currentBase);side.replaceWith(host.firstElementChild);}
    // Keep chat logs, drafts, scroll position and their existing observers mounted.
    if(index===current()&&previousMode!==room?.mode){
      const chat=F.root.querySelector('.chat-panel');
      const input=chat?.querySelector('#chat-message'),form=input?.closest('form');
      if(input&&form){
        chat.querySelector('.v38-chat-notice')?.remove();
        input.disabled=room.mode!=='open';input.placeholder=input.disabled?'팔로워만 채팅할 수 있어요':'메시지 보내기';
        const send=form.querySelector('button[type="submit"]');if(send)send.disabled=input.disabled||input.readOnly||!input.value.trim()||input.value.length>1000;
        if(input.disabled)form.insertAdjacentHTML('beforebegin','<div class="v38-chat-notice" role="status">팔로워만 채팅할 수 있어요'+F.btn('팔로우','v41-follow-chat','heart','ghost small')+'</div>');
      }
    }
    F.v39Viewer?.polish();F.v39Copy?.polish();paint();
  }
  function focusFollow(index){
    if(current()===index)F.root.querySelector('[data-action="v41-follow"]')?.focus({preventScroll:true});
  }
  function login(index,source){
    const intent={index,source,screen:F.screen,state:F.viewState,content:F.v38Viewer?.activeId,tab:F.channelTab,x:scrollX,y:scrollY};
    F.genericDialog('로그인이 필요해요','<div class="v41-follow-channel">'+F.avatar(F.broadcasts[index].initial,'round')+'<strong>'+F.e(name(index))+'</strong></div>','로그인');
    F.dialog.dataset.mobilePresentation='sheet';F.dialog.classList.add('v41-follow-login');
    const confirm=F.dialog.querySelector('[data-action="confirm-generic"]');confirm.dataset.action='v41-follow-login';
    S.offeredIntent=intent;F.v39Mobile?.polish();
  }
  async function setFollowing(index,on,source='button'){
    if(!F.broadcasts[index]||S.pending.has(index))return false;
    if(!F.sessionLoggedIn){login(index,source);return false;}
    if(store.has(index)===on){sync(index,on);return true;}
    const origin=document.activeElement;
    clearFeedback();S.pending.set(index,on);paint();
    try{
      // A replaceable local fixture allows pending/failure designs to be reviewed.
      // This is not a production follow API or persistence implementation.
      if(S.transport)await S.transport({index,following:on});
      else await Promise.resolve();
      if(!F.sessionLoggedIn)return false;
      sync(index,on);
      if(index===current())showFeedback(on?name(index)+' 님을 팔로우했어요.':'팔로우를 취소했어요.',on?null:'undo',index,!on);
      if(source==='chat'&&index===current())F.root.querySelector('#chat-message:not(:disabled)')?.focus({preventScroll:true});
      return true;
    }catch{
      if(index===current())showFeedback(on?'팔로우하지 못했어요.':'팔로우를 취소하지 못했어요.','retry',index,on,true);
      return false;
    }finally{
      S.pending.delete(index);paint();
      if(origin?.matches('.v41-follow-button')&&current()===index&&[origin,document.body,F.root].includes(document.activeElement))focusFollow(index);
    }
  }
  Object.assign(S,{setFollowing,refresh:paint,setTransport(fn){S.transport=typeof fn==='function'?fn:null;},clearFeedback});
  F.render=()=>{old.render();paint();};
  F.navigate=(id,...args)=>{
    const intent=S.loginIntent,returning=F.screen==='login'&&intent&&F.sessionLoggedIn&&id===intent.screen;
    if(returning){F.selectedBroadcast=intent.index;F.channelTab=intent.tab;if(args[0]===undefined)args[0]=intent.state;if(F.v38Viewer){F.v38Viewer.activeId=intent.content;F.v38Viewer.intent=intent.content;}}
    const result=old.navigate(id,...args);paint();
    if(returning){S.loginIntent=null;window.scrollTo({left:intent.x,top:intent.y,behavior:'instant'});setFollowing(intent.index,true,intent.source).then(()=>focusFollow(intent.index));}
    else if(intent&&id!=='login'){if(F.authReturn===intent.screen)F.authReturn=null;S.loginIntent=null;}
    return result;
  };
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-action^="v41-follow"]');if(!button||button.disabled)return;
    event.preventDefault();event.stopImmediatePropagation();
    const action=button.dataset.action;
    if(action==='v41-follow'||action==='v41-follow-chat'){
      const index=Number(button.dataset.followIndex??current());
      setFollowing(index,action==='v41-follow-chat'||!store.has(index),action==='v41-follow-chat'?'chat':'button');
    }else if(action==='v41-follow-login'){
      const intent=S.offeredIntent;S.offeredIntent=null;if(!intent)return;
      const proceed=()=>{S.loginIntent=intent;F.authReturn=intent.screen;F.navigate('login');};
      if(F.v39Mobile?.isMobile()){F.v39Mobile.afterDialogClose(proceed);F.closeModal();}else{F.closeModal();proceed();}
    }else if(action==='v41-follow-feedback-action'){
      const f=S.feedback;if(f)setFollowing(f.index,f.target,'feedback').then(()=>focusFollow(f.index));
    }else if(action==='v41-follow-feedback-close'){const i=S.feedback?.index;clearFeedback();focusFollow(i);}
  },true);
  const close=F.closeModal;
  F.closeModal=()=>{
    if(!F.dialog.classList.contains('v41-follow-login'))return close();
    const index=S.offeredIntent?.index;
    if(Number.isInteger(index)&&F.v39Mobile?.isMobile())F.v39Mobile.afterDialogClose(()=>focusFollow(index));
    // This short prompt does not navigate: cancelling must keep the current video alive.
    F.closeDropdown();F.dialog.close();F.root.inert=false;
    const backdrop=document.querySelector('.modal-backdrop');if(backdrop)backdrop.hidden=true;
    F.dialog.classList.remove('v41-follow-login');delete F.dialog.dataset.mobilePresentation;S.offeredIntent=null;
    F.v39Mobile?.polish();
    if(Number.isInteger(index))focusFollow(index);
  };
  paint();
})();
