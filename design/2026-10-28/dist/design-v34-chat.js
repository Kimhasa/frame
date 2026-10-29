/* Local chat UI detail. Existing media and account identity are not reconfigured. */
(() => {
  const F=window.F;
  if(!F?.chat||!F.modals?.nickname)return;
  const chat=F.chat,nickname=F.modals.nickname,render=F.render,renderModal=F.renderModal,navigate=F.navigate;
  const S=F.v34Chat={rooms:new Map(),channels:new Map(),activeChannel:null,authors:[],session:F.sessionMessages,name:{draft:'',error:'',editing:false,selectOnOpen:false},composing:false};
  let mounted=null,mutationObserver=null,resizeObserver=null;
  const roomKey=()=>`${F.currentBase==='studio'?'studio':F.currentBase||F.screen}:${F.currentBase==='studio'?0:F.selectedBroadcast||0}`;
  const channelKey=()=>String(F.currentBase==='studio'?0:F.selectedBroadcast||0);
  const room=key=>{if(!S.rooms.has(key))S.rooms.set(key,{top:0,follow:true,lastHeight:0});return S.rooms.get(key);};
  const nearBottom=(list,height=list.scrollHeight)=>height-list.clientHeight-list.scrollTop<=24;
  const holder=html=>{const h=document.createElement('div');h.innerHTML=html;return h;};
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  function bindChannel(){
    const key=channelKey();
    if(S.activeChannel!==null){
      const previous=S.channels.get(S.activeChannel);
      // A deliberate external replacement resets the channel currently bound to the UI.
      if(previous&&Array.isArray(F.sessionMessages)&&F.sessionMessages!==previous.messages){previous.messages=F.sessionMessages;previous.authors=[];}
    }
    if(!S.channels.has(key))S.channels.set(key,{messages:S.activeChannel===null&&Array.isArray(F.sessionMessages)?F.sessionMessages:[],authors:[]});
    const current=S.channels.get(key);
    S.activeChannel=key;S.session=current.messages;S.authors=current.authors;F.sessionMessages=current.messages;
    return current;
  }
  function authors(){
    bindChannel();
    S.authors.length=Math.min(S.authors.length,F.sessionMessages.length);
    while(S.authors.length<F.sessionMessages.length)S.authors.push(F.nickname);
  }

  F.chat=()=>{
    authors();
    const h=holder(chat()),panel=h.querySelector('.chat-panel');
    if(!panel)return h.innerHTML;
    panel.classList.add('v34-chat');panel.dataset.v34ChatRoom=roomKey();
    const log=panel.querySelector('.chat-messages');if(log){log.tabIndex=0;log.setAttribute('aria-label','채팅 메시지');}
    panel.querySelectorAll('.chat-head [data-go="nickname"]').forEach(button=>button.remove());
    const form=panel.querySelector('#chat-form'),input=form?.querySelector('textarea');
    if(form&&input){
      form.noValidate=true;form.classList.add('v34-chat-form');
      input.setAttribute('aria-label','채팅 메시지');input.setAttribute('enterkeyhint','send');
      input.setAttribute('aria-describedby','v34-chat-input-error');
      const nameButton=form.querySelector('[data-go="nickname"],.nickname-action');
      if(nameButton){
        nameButton.removeAttribute('data-go');nameButton.dataset.action='v34-chat-name-open';
        nameButton.id='v34-chat-name-trigger';
        nameButton.className='v34-chat-name-change';
        nameButton.setAttribute('aria-label',`채팅 닉네임 변경, 현재 ${F.nickname}`);nameButton.title=`채팅 닉네임 변경 · ${F.nickname}`;
        nameButton.innerHTML=`${F.icon('edit')}<span class="v34-chat-current-name">${F.e(F.nickname)}</span><span class="v34-chat-name-action">변경</span>`;
      }
      const send=form.querySelector('button[type="submit"]');
      if(send){send.textContent='보내기';send.setAttribute('aria-label','메시지 보내기');send.disabled=input.disabled||input.readOnly||!input.value.trim();}
      const error=document.createElement('p');error.id='v34-chat-input-error';error.className='v34-chat-input-error';error.setAttribute('role','alert');error.hidden=true;input.after(error);
    }
    authors();const lines=[...panel.querySelectorAll('.chat-line')],start=lines.length-F.sessionMessages.length;
    F.sessionMessages.forEach((_,index)=>{const line=lines[start+index];if(!line)return;const name=line.querySelector('strong');if(name)name.textContent=S.authors[index];line.dataset.v34Self='true';});
    const latest=document.createElement('button');latest.type='button';latest.className='v34-chat-latest';latest.dataset.action='v34-chat-latest';latest.hidden=true;
    latest.innerHTML=`${F.icon('chevron')}<span>최신 메시지로</span>`;latest.setAttribute('aria-label','최신 채팅 메시지로 이동');panel.append(latest);
    return h.innerHTML;
  };

  F.modals.nickname=viewState=>{
    const original=nickname(viewState),name=S.name;
    if(!name.editing){name.draft=viewState==='입력 오류'?'':F.nickname||'';name.error=viewState==='입력 오류'?'닉네임은 1~20자로 입력하세요.':'';name.editing=true;name.selectOnOpen=true;}
    const help=name.error||'채팅에 표시할 닉네임을 1~20자로 입력하세요.';
    const unchanged=name.draft.trim()===String(F.nickname||'').trim();
    return {...original,title:'채팅 닉네임 변경',cls:`${original.cls||''} v34-chat-name-dialog`,body:`<form id="v34-chat-name-form" novalidate><div class="v34-chat-name-field${name.error?' invalid':''}"><label for="v34-chat-name">닉네임</label><input id="v34-chat-name" name="nickname" type="text" value="${F.e(name.draft)}" maxlength="20" autocomplete="nickname" aria-describedby="v34-chat-name-help"${name.error?' aria-invalid="true"':''}><small id="v34-chat-name-help"${name.error?' class="v34-chat-name-error" role="alert"':''}>${F.e(help)}</small></div></form>`,footer:`${F.btn('취소','close-modal')}<button type="submit" class="primary" form="v34-chat-name-form"${unchanged?' disabled':''}>변경하기</button>`};
  };

  function updateLatest(panel,list,state){
    const latest=panel.querySelector('.v34-chat-latest');if(latest)latest.hidden=state.follow||list.scrollHeight-list.clientHeight<=24;
    const composer=panel.querySelector('.chat-form,.v33-chat-login');
    panel.style.setProperty('--v34-composer-height',`${composer?.getBoundingClientRect().height||0}px`);
  }
  function remember(){
    const panel=F.root.querySelector('.v34-chat'),list=panel?.querySelector('.chat-messages');
    if(!list||!list.getClientRects().length)return;
    const state=room(panel.dataset.v34ChatRoom);state.top=list.scrollTop;state.follow=nearBottom(list);state.lastHeight=list.scrollHeight;
  }
  function detach(){mutationObserver?.disconnect();resizeObserver?.disconnect();mutationObserver=null;resizeObserver=null;mounted=null;}
  function autoSize(input){
    if(!input)return;const list=input.closest('.v34-chat')?.querySelector('.chat-messages');
    const state=room(input.closest('.v34-chat')?.dataset.v34ChatRoom||roomKey()),top=list?.scrollTop||0,follow=state.follow;
    input.style.height='auto';input.style.height=`${Math.min(120,Math.max(58,input.scrollHeight))}px`;input.style.overflowY=input.scrollHeight>120?'auto':'hidden';
    if(list){list.scrollTop=follow?list.scrollHeight:top;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;updateLatest(input.closest('.v34-chat'),list,state);}
  }
  function bind(){
    const panel=F.root.querySelector('.v34-chat'),list=panel?.querySelector('.chat-messages');
    if(!list){detach();return;}
    if(mounted===list)return;detach();mounted=list;
    const state=room(panel.dataset.v34ChatRoom),savedTop=state.top;
    autoSize(panel.querySelector('#chat-message'));
    list.scrollTop=state.follow?list.scrollHeight:savedTop;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;
    updateLatest(panel,list,state);
    list.addEventListener('scroll',()=>{if(!list.isConnected)return;state.top=list.scrollTop;state.follow=nearBottom(list);state.lastHeight=list.scrollHeight;updateLatest(panel,list,state);},{passive:true});
    mutationObserver=new MutationObserver(records=>{
      if(!list.isConnected)return;
      const added=records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&node.matches('.chat-line')));
      if(!added)return;
      const follow=state.follow&&nearBottom(list,state.lastHeight||list.scrollHeight),top=list.scrollTop;
      state.follow=follow;list.scrollTop=follow?list.scrollHeight:top;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;updateLatest(panel,list,state);
    });
    mutationObserver.observe(list,{childList:true});
    resizeObserver=new ResizeObserver(()=>{
      if(!list.isConnected)return;
      list.scrollTop=state.follow?list.scrollHeight:state.top;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;updateLatest(panel,list,state);
    });
    resizeObserver.observe(list);const composer=panel.querySelector('.chat-form,.v33-chat-login');if(composer)resizeObserver.observe(composer);
  }
  function inputState(input){
    const form=input.closest('#chat-form');if(!form)return;
    F.chatDraft=input.value;const tooLong=input.value.length>1000,error=form.querySelector('.v34-chat-input-error');
    if(error){error.hidden=!tooLong;error.textContent=tooLong?'메시지는 1,000자까지 입력할 수 있어요.':'';}
    if(tooLong)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');
    const send=form.querySelector('button[type="submit"]');if(send)send.disabled=input.disabled||input.readOnly||!input.value.trim()||tooLong;
    autoSize(input);
  }

  window.addEventListener('click',event=>{
    const button=event.target.closest?.('button');if(!button||button.disabled)return;
    if(button.dataset.action==='v34-chat-name-open'){
      stop(event);button.focus({preventScroll:true});F.navigate('nickname');return;
    }
    if(button.dataset.action==='v34-chat-latest'){
      stop(event);const panel=button.closest('.v34-chat'),list=panel.querySelector('.chat-messages'),state=room(panel.dataset.v34ChatRoom);
      state.follow=true;list.scrollTop=list.scrollHeight;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;updateLatest(panel,list,state);
      const input=panel.querySelector('#chat-message');if(input&&!input.disabled)input.focus({preventScroll:true});else list.focus({preventScroll:true});
    }
  },true);
  window.addEventListener('input',event=>{
    const input=event.target;
    if(input.id==='v34-chat-name'){
      S.name.draft=input.value;S.name.error='';input.removeAttribute('aria-invalid');
      const help=F.dialog.querySelector('#v34-chat-name-help');if(help){help.classList.remove('v34-chat-name-error');help.removeAttribute('role');help.textContent='채팅에 표시할 닉네임을 1~20자로 입력하세요.';}
      input.closest('.v34-chat-name-field')?.classList.remove('invalid');
      const save=F.dialog.querySelector('[form="v34-chat-name-form"]');if(save)save.disabled=input.value.trim()===String(F.nickname||'').trim();
      if(F.viewState==='입력 오류'){F.viewState='기본';F.writeUrl(true);}return;
    }
    if(input.id==='chat-message'&&input.closest('.v34-chat'))inputState(input);
  },true);
  window.addEventListener('compositionstart',event=>{if(event.target.id==='chat-message')S.composing=true;},true);
  window.addEventListener('compositionend',event=>{if(event.target.id==='chat-message'){S.composing=false;inputState(event.target);}},true);
  window.addEventListener('keydown',event=>{
    if(event.target.closest?.('.v34-chat .chat-messages')){
      if(event.code==='Space'||event.key===' '||event.key==='Spacebar'||['k','m','t','f'].includes(String(event.key).toLowerCase()))event.stopImmediatePropagation();
      return;
    }
    if(event.target.id!=='chat-message'||!event.target.closest('.v34-chat')||event.key!=='Enter'||event.shiftKey)return;
    if(event.isComposing||S.composing||F.composing||event.keyCode===229){event.stopImmediatePropagation();return;}
    stop(event);event.target.closest('form').requestSubmit();
  },true);
  window.addEventListener('submit',event=>{
    const form=event.target;
    if(form.id==='v34-chat-name-form'){
      stop(event);const input=form.querySelector('#v34-chat-name'),value=input.value.trim();S.name.draft=input.value;
      if(!value||value.length>20){S.name.error='닉네임은 1~20자로 입력하세요.';F.setState('입력 오류');return;}
      authors();F.nickname=value;S.name.editing=false;F.closeModal();F.toast('닉네임을 변경했어요.');return;
    }
    if(form.id!=='chat-form'||!form.closest('.v34-chat'))return;
    stop(event);const input=form.querySelector('textarea'),text=input.value.trim();
    if(input.disabled||input.readOnly||!text)return;
    if(input.value.length>1000){inputState(input);input.focus({preventScroll:true});return;}
    const panel=form.closest('.v34-chat'),list=panel.querySelector('.chat-messages'),state=room(panel.dataset.v34ChatRoom),follow=nearBottom(list),top=list.scrollTop;
    authors();F.sessionMessages.push(text);S.authors.push(F.nickname);
    const line=document.createElement('div'),name=document.createElement('strong'),message=document.createElement('span');
    line.className='chat-line';line.dataset.v34Self='true';name.textContent=F.nickname;message.textContent=text;line.append(name,message);list.append(line);
    input.value='';F.chatDraft='';state.follow=follow;state.top=top;inputState(input);
    list.scrollTop=follow?list.scrollHeight:top;state.top=list.scrollTop;state.lastHeight=list.scrollHeight;updateLatest(panel,list,state);
  },true);

  F.navigate=(id,viewState,replace=false)=>{
    if(id==='nickname'&&F.screen!=='nickname')S.name={draft:F.nickname||'',error:'',editing:false,selectOnOpen:true};
    else if(F.screen==='nickname'&&id!=='nickname')S.name.editing=false;
    return navigate(id,viewState,replace);
  };
  F.render=()=>{remember();render();bind();};
  F.renderModal=(...args)=>{
    const value=renderModal(...args);
    if(F.screen==='nickname'){
      const input=F.dialog.querySelector('#v34-chat-name');input?.focus({preventScroll:true});
      if(S.name.selectOnOpen){input?.select();S.name.selectOnOpen=false;}
    }
    return value;
  };
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  F.render();
})();
