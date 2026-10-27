(() => {
  'use strict';
  // Presentation adapters only. Catalog, monitors and DVR are supplied by the backend contracts in UI_HANDOFF.txt.
  const $ = id => document.getElementById(id), runtime = window.FrameRuntime;
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const model = { items: [], catalog: 'loading', sourceMode: 'window', monitors: [], selectedMonitor: null, timeline: null, loadId: 0, openedBy: null };
  let networkSnapshot;
  let savedName='';try{savedName=localStorage.getItem('frame.chatName')||'';}catch{}
  const makeChat = () => ({connected:false,canSend:false,broadcastId:null,messages:[],pending:null,pendingText:null,displayName:savedName,draft:'',error:'',scrollTop:0,pinToBottom:true});
  const chatRooms = {sender:makeChat(),viewer:makeChat()};
  let chatContext='viewer',chat=chatRooms.viewer;
  const roomFor=context=>context==='sender'?chatRooms.sender:context==='viewer'?chatRooms.viewer:null;
  function updateLayout() { const viewing=!$('viewer-view').hidden&&!$('viewer-stage').hidden; document.querySelector('.app-layout').classList.toggle('is-viewing',viewing); document.querySelector('.app-layout').classList.toggle('is-expanded',viewing&&$('viewer-view').classList.contains('is-wide')); if(viewing){$('tab-sender').setAttribute('aria-selected','false');$('tab-viewer').setAttribute('aria-selected','false');$('tab-viewer').tabIndex=0;}else if(!$('viewer-view').hidden){$('tab-viewer').setAttribute('aria-selected','true');$('tab-sender').setAttribute('aria-selected','false');} activateChat($('sender-view').hidden?'viewer':'sender'); }
  function showStage(show = true) {
    const entering=show&&$('viewer-stage').hidden;
    $('viewer-view').setAttribute('role',show?'region':'tabpanel');
    if(show){$('viewer-view').removeAttribute('aria-labelledby');$('viewer-view').setAttribute('aria-label','수신 영상');}else{$('viewer-view').removeAttribute('aria-label');$('viewer-view').setAttribute('aria-labelledby','tab-viewer');}
    $('broadcast-list').hidden = show; $('catalog-toolbar').hidden = show; $('viewer-stage').hidden = !show;
    if (!show) $('viewer-view').classList.remove('is-wide');
    updateLayout();
    if(entering)toggleChat(true);
  }
  function openManual(opener) {
    model.openedBy = opener;
    model.manualFromList = !$('broadcast-list').hidden;
    if (runtime.prepareManual) runtime.prepareManual();
    $('viewer-host').disabled = false; $('viewer-stream').disabled = false; $('viewer-receive-port').disabled = false;
    $('viewer-connect-error').hidden = true; $('viewer-connect-dialog').showModal();
  }
  function catalogMessage(title, description, retry = false) {
    $('catalog-empty').hidden = false; $('catalog-empty-title').textContent = title;
    $('catalog-empty-description').textContent = description; $('catalog-retry').hidden = !retry;
  }
  function safeHttp(value) {
    if (!value) return null;
    try { const url = new URL(value, location.href); return ['http:','https:'].includes(url.protocol) ? url : null; } catch { return null; }
  }
  function renderCatalog() {
    const query = $('broadcast-search').value.trim().toLocaleLowerCase();
    const items = model.items.filter(item => (item.title + ' ' + (item.publisher || '')).toLocaleLowerCase().includes(query));
    $('broadcast-count').textContent = String(model.items.length); $('broadcast-grid').replaceChildren();
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'broadcast-card';
      button.setAttribute('aria-label', item.title + ' 수신');
      const thumb = document.createElement('span'); thumb.className = 'broadcast-thumb';
      const thumbnail = safeHttp(item.thumbnailUrl);
      if (thumbnail) { const image = document.createElement('img'); image.alt = ''; image.src = thumbnail.href; image.loading = 'lazy'; image.addEventListener('error', () => { image.remove(); thumb.insertAdjacentHTML('afterbegin', icon('monitor')); }, {once:true}); thumb.append(image); }
      else thumb.innerHTML = icon('monitor');
      const live = document.createElement('span'); live.className = 'broadcast-live'; live.textContent = '실시간'; thumb.append(live);
      if (item.height) { const format = document.createElement('span'); format.className = 'broadcast-format'; format.textContent = item.height + 'p' + (item.fps ? ' / ' + item.fps + 'fps' : ''); thumb.append(format); }
      const copy = document.createElement('span'); copy.className = 'broadcast-copy';
      const avatar = document.createElement('span'); avatar.className = 'broadcast-avatar'; avatar.setAttribute('aria-hidden','true'); avatar.innerHTML = icon('monitor');
      const text = document.createElement('span'); text.className = 'broadcast-text';
      const title = document.createElement('span'); title.className = 'broadcast-title'; title.textContent = item.title;
      const owner = document.createElement('span'); owner.className = 'broadcast-owner'; owner.textContent = item.publisher || '';
      text.append(title,owner); copy.append(avatar,text); button.append(thumb,copy);
      button.addEventListener('click', () => openBroadcast(item)); $('broadcast-grid').append(button);
    }
    $('catalog-empty').hidden = items.length > 0;
    if (!items.length && model.catalog === 'ready') catalogMessage(query ? '검색 결과가 없습니다' : '송출 중인 영상이 없습니다', query ? '다른 송출명 또는 PC 이름으로 검색하십시오.' : '송출이 시작되면 이곳에 표시됩니다.');
  }
  // The page's own server lists broadcasts; inside the app that is the app's viewer server (the page itself is a local file host).
  async function refreshCatalog(quiet = false) {
    const base = runtime.catalogBase;
    if (base === null) { if (!model.items.length) catalogMessage('목록을 불러오는 중입니다', '잠시만 기다려 주십시오.'); setTimeout(() => refreshCatalog(quiet), 500); return; }
    const load = ++model.loadId; if (!quiet) $('refresh-broadcasts').disabled = true;
    if (!model.items.length && !quiet) catalogMessage('목록을 불러오는 중입니다', '잠시만 기다려 주십시오.');
    try {
      const response = await fetch(base + '/api/broadcasts', {cache:'no-store', signal:AbortSignal.timeout(7000)});
      if (!response.ok) throw new Error('catalog ' + response.status);
      const data = await response.json();
      if (load !== model.loadId) return;
      setBroadcasts(Array.isArray(data) ? data : data.items || []);
    } catch {
      if (load !== model.loadId) return;
      model.catalog = 'error'; model.items = []; renderCatalog();
      catalogMessage('영상 목록을 불러올 수 없습니다', '목록을 다시 불러오거나 수신 주소로 수동 연결하십시오.', true);
    } finally { if(load === model.loadId) $('refresh-broadcasts').disabled = false; }
  }
  function setBroadcasts(items) {
    ++model.loadId; model.items = items.filter(item => item && item.id && item.title && item.path && safeHttp(item.baseUrl) && item.running !== false);
    model.catalog = 'ready'; $('refresh-broadcasts').disabled = false; renderCatalog();
  }
  async function openBroadcast(item) {
    const target = safeHttp(item.baseUrl); if (!target) return;
    $('viewer-title').textContent = item.title; showStage();
    await runtime.connect({ base: target.origin, host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: item.path });
    if(runtime.connected) $('viewer-title').textContent = item.title;
  }
  $('broadcast-search').addEventListener('input',renderCatalog);
  $('refresh-broadcasts').addEventListener('click',refreshCatalog); $('catalog-retry').addEventListener('click',refreshCatalog);
  $('manual-connect').addEventListener('click', () => openManual($('manual-connect')));
  document.addEventListener('frame:connecting', () => { showStage(); $('connect-button').disabled = true; chatRooms.viewer.messages=[];chatRooms.viewer.pending=null;setChatState({connected:false,canSend:false},'viewer'); });
  $('viewer-connect-dialog').addEventListener('close', () => { if (!runtime.connected) { if (runtime.connecting) runtime.disconnect(); if (model.manualFromList) showStage(false); } });
  document.addEventListener('frame:receiver', ({detail}) => {
    $('connect-button').disabled = false;
    if(detail.connected) { showStage(); if ($('viewer-connect-dialog').open) $('viewer-connect-dialog').close(); }
    else if($('viewer-connect-dialog').open && detail.heading) { $('viewer-connect-error').hidden=false; $('viewer-connect-error').textContent=[detail.heading,detail.description].filter(Boolean).join(' '); }
    if(!detail.connected) setTimeline(null);
    $('chat-toggle').disabled = !detail.connected;
    if(!detail.connected) { chatRooms.viewer.messages=[];setChatState({connected:false,canSend:false},'viewer'); }
    updatePip();
  });
  $('sender-network-button').addEventListener('click', () => {
    networkSnapshot = Object.fromEntries(['server-host','stream-path','publish-port','viewer-port'].map(id => [id,$(id).value]));
    $('sender-network-dialog').showModal();
  });
  $('apply-sender-network').addEventListener('click', () => { const error = runtime.validate(true); if(error && ['server-host','stream-path','publish-port'].includes(error.field)) { $(error.field).focus(); return; } networkSnapshot=null; $('sender-network-dialog').close(); });
  $('sender-network-dialog').addEventListener('close', () => { if(networkSnapshot) { for(const [id,value] of Object.entries(networkSnapshot)) { $(id).value=value; $(id).dispatchEvent(new Event('input',{bubbles:true})); } networkSnapshot=null; } });
  function sourceMode(mode) {
    model.sourceMode=mode;
    for(const name of ['window','monitor']) { const active = mode===name; $('source-tab-'+name).setAttribute('aria-selected',String(active)); $('source-tab-'+name).tabIndex=active?0:-1; $('source-'+name+'-panel').hidden=!active; }
    if(mode==='monitor') { $('confirm-source').disabled=!model.selectedMonitor; document.dispatchEvent(new CustomEvent('frame:request-monitors')); }
    else $('confirm-source').disabled=!document.querySelector('.source-choice[aria-pressed="true"]');
  }
  function setMonitors(items) {
    model.monitors=items; model.selectedMonitor=null; $('monitor-options').replaceChildren(); $('monitor-message').hidden=items.length>0;
    for(const item of items) {
      const button=document.createElement('button'); button.type='button'; button.className='monitor-choice'; button.setAttribute('aria-pressed','false');
      const thumb=document.createElement('span'); thumb.className='monitor-thumb';
      const thumbnail=/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(item.thumbnailUrl||'')?{href:item.thumbnailUrl}:safeHttp(item.thumbnailUrl);
      if(thumbnail){const image=document.createElement('img');image.alt='';image.src=thumbnail.href;thumb.append(image);}
      else {const number=document.createElement('span'); number.className='monitor-number'; number.textContent=String(item.number); thumb.append(number);}
      const copy=document.createElement('span'); copy.className='monitor-copy'; const name=document.createElement('strong'); name.textContent='모니터 '+item.number;
      if(item.primary) { const badge=document.createElement('span'); badge.className='primary-monitor'; badge.textContent='주 모니터'; name.append(badge); }
      const details=document.createElement('small'); details.textContent=item.width+' × '+item.height+(item.scale?' / '+item.scale+'%':''); copy.append(name,details); button.append(thumb,copy);
      button.addEventListener('click',()=>{model.selectedMonitor=item.id; $('monitor-options').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button))); $('confirm-source').disabled=false;});
      $('monitor-options').append(button);
    }
    if(model.sourceMode==='monitor')$('confirm-source').disabled=true;
  }
  for(const mode of ['window','monitor']) $('source-tab-'+mode).addEventListener('click',()=>sourceMode(mode));
  document.querySelector('.source-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return; event.preventDefault(); const mode=event.key==='Home'?'window':event.key==='End'?'monitor':model.sourceMode==='window'?'monitor':'window'; sourceMode(mode); $('source-tab-'+mode).focus();});
  $('confirm-source').addEventListener('click',event=>{if(model.sourceMode!=='monitor')return; event.preventDefault(); event.stopImmediatePropagation(); if(model.selectedMonitor) document.dispatchEvent(new CustomEvent('frame:select-monitor',{detail:{id:model.selectedMonitor}}));},true);
  $('source-dialog').addEventListener('close',()=>{sourceMode('window');});
  function time(ms) { const seconds=Math.max(0,Math.floor(ms/1000)); return (seconds>=3600?String(Math.floor(seconds/3600)).padStart(2,'0')+':':'')+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'); }
  function setTimeline(data) {
    const valid=data&&Number.isFinite(data.startMs)&&Number.isFinite(data.endMs)&&data.endMs>data.startMs;
    model.timeline=valid?data:null; $('player-timeline').hidden=!valid;
    $('player-live').disabled=!valid||data.mode!=='history'; $('player-live').classList.toggle('is-history',valid&&data.mode==='history');
    if(!valid)return;
    const position=Math.max(data.startMs,Math.min(data.endMs,data.positionMs));
    $('player-seek').min=data.startMs; $('player-seek').max=data.endMs; $('player-seek').value=position;
    $('player-seek').style.setProperty('--fill',(position-data.startMs)/(data.endMs-data.startMs)*100+'%');
    $('player-position').textContent=time(position-data.startMs); $('player-duration').textContent=time(data.endMs-data.startMs);
    $('player-seek').setAttribute('aria-valuetext',time(position-data.startMs)+' / '+time(data.endMs-data.startMs));
  }
  $('player-seek').addEventListener('input',()=>{if(!model.timeline)return; const position=Number($('player-seek').value); $('player-position').textContent=time(position-model.timeline.startMs); $('player-seek').style.setProperty('--fill',(position-model.timeline.startMs)/(model.timeline.endMs-model.timeline.startMs)*100+'%');});
  $('player-seek').addEventListener('change',()=>{if(model.timeline)document.dispatchEvent(new CustomEvent('frame:seek',{detail:{positionMs:Number($('player-seek').value)}}));});
  $('player-live').addEventListener('click',()=>document.dispatchEvent(new CustomEvent('frame:live')));
  function updatePip(){const video=runtime.video; $('player-pip').disabled=!(video&&document.pictureInPictureEnabled&&video.requestPictureInPicture);}
  document.addEventListener('frame:media',updatePip);
  $('player-pip').addEventListener('click',async()=>{try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if(runtime.video)await runtime.video.requestPictureInPicture();}catch{runtime.notify('이 환경에서는 화면 속 화면을 사용할 수 없습니다.');}});
  $('viewer-info-button').addEventListener('click',()=>$('viewer-info-dialog').showModal());
  function renderChatState() {
    const enabled=chat.connected&&chat.canSend;
    $('chat-message').disabled=!enabled;
    $('chat-send').disabled=!enabled||!$('chat-message').value.trim()||!!chat.pending;
    $('chat-empty').textContent=chat.connected?'아직 메시지가 없습니다.':chatContext==='sender'&&!runtime.running?'송출을 시작하면 채팅을 사용할 수 있습니다.':'채팅을 사용할 수 없습니다.';
    $('chat-empty').hidden=chat.messages.length>0;
    $('chat-error').textContent=chat.error||'';$('chat-error').hidden=!chat.error;
  }
  function activateChat(context) {
    const slot=$(context==='sender'?'sender-chat-slot':'viewer-chat-slot');
    if(chatContext===context&&$('chat-panel').parentElement===slot)return;
    chat.draft=$('chat-message').value;chat.scrollTop=$('chat-messages').scrollTop;chat.pinToBottom=$('chat-messages').scrollHeight-chat.scrollTop-$('chat-messages').clientHeight<55;
    chatContext=context;chat=chatRooms[context];slot.append($('chat-panel'));
    $('chat-panel').classList.toggle('is-sender-chat',context==='sender');
    $('chat-panel').hidden=context==='sender'?false:!model.viewerChatOpen;
    $('chat-close').hidden=context==='sender';$('chat-message').value=chat.draft;
    renderMessages();renderChatState();$('chat-messages').scrollTop=chat.pinToBottom?$('chat-messages').scrollHeight:chat.scrollTop;
    document.dispatchEvent(new CustomEvent('frame:chat-context',{detail:{context,broadcastId:chat.broadcastId}}));
  }
  function toggleChat(open) {
    model.viewerChatOpen=open;
    if(chatContext==='viewer')$('chat-panel').hidden=!open;
    $('chat-toggle').setAttribute('aria-expanded',String(open));$('viewer-stage').classList.toggle('is-chat-open',open);
    if(open&&chatContext==='viewer'&&chat.canSend)$('chat-message').focus();
  }
  $('chat-toggle').addEventListener('click',()=>toggleChat(!model.viewerChatOpen));
  $('chat-close').addEventListener('click',()=>{toggleChat(false);$('chat-toggle').focus();});
  function setChatState(data,context='viewer') {
    const room=roomFor(context);if(!room)return;
    const changed=data.broadcastId&&data.broadcastId!==room.broadcastId;
    if(changed){room.messages=[];room.pending=null;room.pendingText=null;room.draft='';room.error='';}
    Object.assign(room,data);if(data.error)room.pending=null;
    if(room===chat){if(changed)$('chat-message').value='';renderMessages();renderChatState();}
  }
  function renderMessages() {
    const box=$('chat-messages'),atEnd=box.scrollHeight-box.scrollTop-box.clientHeight<55,scrollBefore=box.scrollTop;
    const keep=new Set(chat.messages.map(item=>String(item.id)));
    for(const row of [...box.children])if(!keep.has(row.dataset.messageId))row.remove();
    const rows=new Map([...box.children].map(row=>[row.dataset.messageId,row]));
    for(const [index,item] of chat.messages.entries()) {
      let row=rows.get(String(item.id));
      if(!row){row=document.createElement('div');row.className='chat-message';row.dataset.messageId=String(item.id);const author=document.createElement('span');author.className='chat-author';const body=document.createElement('span');body.className='chat-body';row.append(author,body);}
      if(row.children[0].textContent!==item.author)row.children[0].textContent=item.author;
      if(row.children[1].textContent!==item.text)row.children[1].textContent=item.text;
      if(box.children[index]!==row)box.insertBefore(row,box.children[index]||null);
    }
    $('chat-empty').hidden=chat.messages.length>0;box.scrollTop=atEnd?box.scrollHeight:scrollBefore;
  }
  function setMessages(items,context='viewer') {const room=roomFor(context);if(!room)return;room.messages=items.filter(item=>!item.broadcastId||item.broadcastId===room.broadcastId).slice(-200);if(room===chat)renderMessages();}
  function appendMessage(item,context='viewer') {const room=roomFor(context);if(!room||!item||!item.id||(item.broadcastId&&item.broadcastId!==room.broadcastId)||room.messages.some(message=>message.id===item.id))return;room.messages.push(item);if(room.messages.length>200)room.messages.shift();if(room===chat)renderMessages();}
  function ackMessage(data,context='viewer') {
    const room=roomFor(context);if(!room||!data||data.clientId!==room.pending)return;
    room.pending=null;
    if(data.ok){if(room.draft.trim()===room.pendingText){room.draft='';if(room===chat)$('chat-message').value='';}room.error='';}
    else room.error=data.error||'메시지를 전송할 수 없습니다.';
    room.pendingText=null;if(room===chat)renderChatState();
  }
  $('chat-message').addEventListener('input',()=>{chat.draft=$('chat-message').value;renderChatState();});
  $('chat-message').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('chat-form').requestSubmit();}});
  function openName(){ $('chat-display-name').value=chat.displayName;$('chat-name-error').hidden=true;$('chat-name-dialog').showModal();$('chat-display-name').focus(); }
  $('chat-name-button').addEventListener('click',openName);
  $('chat-name-form').addEventListener('submit',event=>{event.preventDefault();const name=$('chat-display-name').value.trim();if(!name||Array.from(name).length>20){$('chat-name-error').textContent='1~20자의 이름을 입력하십시오.';$('chat-name-error').hidden=false;$('chat-display-name').focus();return;}for(const room of Object.values(chatRooms))room.displayName=name;try{localStorage.setItem('frame.chatName',name);}catch{}document.dispatchEvent(new CustomEvent('frame:set-chat-name',{detail:{context:chatContext,broadcastId:chat.broadcastId,name}}));$('chat-name-dialog').close();if(!$('chat-message').disabled)$('chat-message').focus();});
  $('chat-form').addEventListener('submit',event=>{event.preventDefault();const text=$('chat-message').value.trim();if(!chat.connected||!chat.canSend||chat.pending||!text)return;if(!chat.displayName){openName();return;}chat.draft=$('chat-message').value;chat.pending=Array.from(crypto.getRandomValues(new Uint32Array(4)),part=>part.toString(16).padStart(8,'0')).join('');chat.pendingText=text;renderChatState();document.dispatchEvent(new CustomEvent('frame:send-message',{detail:{context:chatContext,broadcastId:chat.broadcastId,displayName:chat.displayName,text,clientId:chat.pending}}));});
  $('sender-settings-button').addEventListener('click',()=>$('sender-settings-dialog').showModal());
  $('sender-settings-done').addEventListener('click',()=>{const error=runtime.validate(true);if(error&&['custom-fps','quality'].includes(error.field)){$(error.field).focus();return;}$('sender-settings-dialog').close();});
  document.addEventListener('frame:sender-state',({detail})=>{if(!detail.running)setChatState({connected:false,canSend:false},'sender');});

  document.addEventListener('frame:view',({detail})=>{if(detail.name==='viewer'){if(runtime.connected||runtime.connecting)runtime.disconnect();showStage(false);refreshCatalog();}else updateLayout();});
  new MutationObserver(updateLayout).observe($('viewer-view'),{attributes:true,attributeFilter:['class','hidden']});
  window.FrameUI={setBroadcasts,setMonitors,setTimeline,refreshCatalog,showStage,sourceMode,setChatState,setMessages,appendMessage,ackMessage,
    setSenderChatState:data=>setChatState(data,'sender'),setSenderMessages:items=>setMessages(items,'sender'),
    appendSenderMessage:item=>appendMessage(item,'sender'),ackSenderMessage:data=>ackMessage(data,'sender')};
  showStage(false); updatePip();
  $('open-viewer').addEventListener('click',()=>{if($('sender-settings-dialog').open)$('sender-settings-dialog').close();showStage();});
  refreshCatalog();
  // Keep the list current while it is on screen (new broadcasts, ended ones, fresh thumbnails).
  setInterval(() => { if (!document.hidden && !$('viewer-view').hidden && !$('broadcast-list').hidden && model.catalog !== 'loading') refreshCatalog(true); }, 5000);
  const linkedPath=decodeURIComponent(location.pathname.split('/').filter(Boolean)[0]||'');
  if(runtime.remote&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(linkedPath)){showStage();runtime.connect();}
})();
