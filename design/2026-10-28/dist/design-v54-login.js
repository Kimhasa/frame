/* Local login presentation. No network, OAuth, email or credential persistence is performed here. */
(()=>{
  'use strict';
  const F=window.F,A=F?.accountDesign;if(!F?.pages?.login||!A||F.v54Login)return;
  const old={header:F.header,navigate:F.navigate,render:F.render,read:F.readUrl};
  const watch=new Set(['watch','vod-watch','clip-watch']),steps=new Set(['options','email','provider','recovery']);
  const S=F.v54Login={step:'options',email:'',provider:'Google',showPassword:false,remember:false,errors:{},busy:false,recoveryEmail:'',recoveryDone:false,fault:null,origin:null};
  let overlay=null,suspended=[],timer=null,token=0,session=0,depth=0,finishing=false,completion=null,infoDialog=null,infoTrigger=null,infoBackPending=false,infoContextPending=false,preserveInfoRender=false;
  const e=F.e,button=(text,action,cls='',attrs='')=>'<button type="button" class="'+cls+'" data-action="v54-login-'+action+'" '+attrs+'>'+text+'</button>';
  const icon=name=>name==='eye'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>':name==='eye-off'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.2 4M6.2 6.3A22 22 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5-1.1M10 10a3 3 0 0 0 4 4"/></svg>':F.icon(name);
  const google='<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.7-.4-4H24v7.6h11a9.4 9.4 0 0 1-4.1 6.2v5h6.6c3.8-3.5 6.1-8.6 6.1-14.8Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.2A20.4 20.4 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.6 27.8A12 12 0 0 1 12 24c0-1.3.2-2.6.6-3.8V15H5.8A20.2 20.2 0 0 0 3.6 24c0 3.2.8 6.2 2.2 9l6.8-5.2Z"/><path fill="#EA4335" d="M24 11.8c3 0 5.6 1 7.7 3l5.8-5.8A19.5 19.5 0 0 0 24 4 20.4 20.4 0 0 0 5.8 15l6.8 5.2c1.6-4.8 6.1-8.4 11.4-8.4Z"/></svg>';
  const naver='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#03C75A" d="M2 2h20v20H2z"/><path fill="#fff" d="M6.3 6.5h3.6l4.2 6.1V6.5h3.6v11h-3.6l-4.2-6.1v6.1H6.3z"/></svg>';
  const providerIcon=()=>S.provider==='네이버'?naver:google;
  const currentPanel=()=>overlay?.querySelector('.v54-login')||F.root.querySelector('.v54-login');
  const currentInput=name=>currentPanel()?.querySelector('[name="'+name+'"]');
  function infoTraversal(){const url=new URL(location.href),step=url.searchParams.get('loginStep'),next=steps.has(step)?step:'options';return F.screen==='login'&&url.searchParams.get('screen')==='login'&&S.step===next&&!!(infoDialog||infoBackPending||infoContextPending||history.state?.__v54Login===session&&history.state.__v54LoginInfo);}
  const backLabel=()=>S.step==='options'?'이전 화면으로':'로그인 방법으로 돌아가기';
  function header(){return '<header class="v54-login-header"><div class="v54-login-header-inner">'+button(icon('arrow'),'back','v54-login-back','aria-label="'+backLabel()+'"')+'<span class="v54-login-header-spacer" aria-hidden="true"></span></div></header>';}
  function footer(){return '<footer class="v54-login-footer"><nav aria-label="서비스 안내">'+[['terms','이용약관'],['privacy','개인정보 처리방침'],['support','고객지원'],['company','회사정보']].map(([key,label])=>button(label,'info','v54-login-footer-link','data-login-info="'+key+'" aria-haspopup="dialog"'+(S.busy?' disabled':''))).join('')+'</nav><p><span>주식회사 프레임</span><span>help@frame.example</span></p><small>© 2026 FRAME</small></footer>';}
  function closeInfo(restoreFocus=true){const dialog=infoDialog,trigger=infoTrigger;if(!dialog)return;infoDialog=infoTrigger=null;if(dialog.open)dialog.close();dialog.remove();if(restoreFocus){if(history.state?.__v54Login===session&&history.state.__v54LoginInfo){infoBackPending=true;history.back();}if(trigger?.isConnected)trigger.focus({preventScroll:true});}}
  function openInfo(key,trigger,push=true){
    const content={
      terms:['이용약관','<section><h3>서비스 이용</h3><p>다른 이용자의 권리를 존중하고, 계정과 비밀번호를 안전하게 관리해 주세요.</p></section><section><h3>콘텐츠와 권리</h3><p>방송과 영상은 저작권자의 허락 없이 복제하거나 배포할 수 없습니다.</p></section><section><h3>이용 관련 문의</h3><p>help@frame.example</p></section>'],
      privacy:['개인정보 처리방침','<section><h3>계정 정보</h3><p>이메일과 닉네임은 로그인과 채널 이용을 위한 계정 정보입니다.</p></section><section><h3>내 정보 관리</h3><p>로그인 후 내 설정에서 계정 정보와 개인정보 관련 설정을 확인할 수 있습니다.</p></section><section><h3>개인정보 관련 문의</h3><p>help@frame.example</p></section>'],
      support:['고객지원','<dl><div><dt>문의 이메일</dt><dd>help@frame.example</dd></div><div><dt>문의 항목</dt><dd>계정, 방송, 영상 및 서비스 이용</dd></div></dl>'],
      company:['회사정보','<dl><div><dt>회사명</dt><dd>주식회사 프레임</dd></div><div><dt>대표자</dt><dd>김민준</dd></div><div><dt>문의 이메일</dt><dd>help@frame.example</dd></div></dl>']
    }[key];if(!content)return;closeInfo(false);infoContextPending=true;infoTrigger=trigger;const dialog=infoDialog=document.createElement('dialog');dialog.className='v54-login-info';dialog.setAttribute('aria-labelledby','v54-login-info-title');dialog.innerHTML='<div class="v54-login-info-head"><h2 id="v54-login-info-title">'+content[0]+'</h2>'+button(icon('close'),'info-close','v54-login-info-x','aria-label="닫기"')+'</div><div class="v54-login-info-body">'+content[1]+'</div><div class="v54-login-info-foot">'+button('닫기','info-close','v54-login-info-done')+'</div>';document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();closeInfo();});dialog.addEventListener('close',()=>{if(infoDialog===dialog)closeInfo();});if(push){depth++;history.pushState({...history.state,__v54Login:session,depth,step:S.step,__v54LoginInfo:key},'',location.href);}dialog.showModal();dialog.querySelector('.v54-login-info-x').focus({preventScroll:true});
  }
  function field(name,label,type,value,autocomplete){return '<div class="v54-login-field"><label for="v54-login-'+name+'">'+label+'</label><div class="v54-login-input-wrap"><input id="v54-login-'+name+'" name="'+name+'" type="'+type+'" value="'+e(value)+'" placeholder="'+e(label)+'" autocomplete="'+autocomplete+'"'+(name==='password'?'':' inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254"')+' aria-required="true" aria-describedby="v54-login-'+name+'-error"'+(S.errors[name]?' aria-invalid="true"':'')+(S.busy?' readonly':'')+'>'+ (name==='password'?button(icon(S.showPassword?'eye-off':'eye'),'password','v54-login-password','aria-label="비밀번호 '+(S.showPassword?'숨기기':'표시')+'"'+(S.busy?' disabled':'')):'')+'</div><p id="v54-login-'+name+'-error" class="v54-login-error"'+(S.errors[name]?'':' hidden')+'>'+e(S.errors[name]||'')+'</p></div>';}
  const submit=(text,disabled=false)=>'<button type="submit" class="v54-login-primary'+(S.busy?' is-busy':'')+'"'+(disabled||S.busy?' disabled':'')+' aria-busy="'+S.busy+'">'+(S.busy?'<span class="v54-login-spinner" aria-hidden="true"></span><span>확인 중</span>':text)+'</button>';
  function page(){
    let body='';const error='<p id="v54-login-form-error" class="v54-login-form-error" role="alert" tabindex="-1"'+(S.errors.form?'':' hidden')+'>'+e(S.errors.form||'')+'</p>';
    const needsConsent=F.viewState==='동의 필요',blocked=needsConsent&&!F.v33Account?.consent;
    const consent=needsConsent?'<label class="v54-login-consent"><input type="checkbox" data-v54-login-consent'+(F.v33Account?.consent?' checked':'')+'><span>'+button('이용약관','info','v54-login-inline','data-login-info="terms" aria-haspopup="dialog"')+' · '+button('개인정보 처리방침','info','v54-login-inline','data-login-info="privacy" aria-haspopup="dialog"')+'에 동의합니다.</span></label>':'';
    if(S.step==='email'||S.step==='options')body='<div class="v54-login-form-brand" role="img" aria-label="FRAME">'+(F.v55Brand?.lockup?F.v55Brand.lockup():'<span>FRAME</span>')+'</div><h1 class="v54-login-sr" tabindex="-1">로그인</h1><form id="v54-login-email-form" data-ui54-login novalidate aria-busy="'+S.busy+'">'+field('email','이메일','email',S.email,'email')+field('password','비밀번호',S.showPassword?'text':'password','','current-password')+'<label class="v54-login-remember"><input type="checkbox" data-v54-login-remember'+(S.remember?' checked':'')+'><span>로그인 상태 유지</span></label>'+consent+error+submit('로그인',blocked)+'</form><div class="v54-login-links">'+button('비밀번호 찾기','recovery','v54-login-text')+'</div><div class="v54-login-divider"><span>또는</span></div><div class="v54-login-social">'+button(google,'provider','v54-login-social-provider','data-provider="Google" aria-label="Google로 계속하기" title="Google로 계속하기"'+(blocked?' disabled':''))+button(naver,'provider','v54-login-social-provider is-naver','data-provider="네이버" aria-label="네이버로 계속하기" title="네이버로 계속하기"'+(blocked?' disabled':''))+'</div>';
    else if(S.step==='provider')body='<div class="v54-login-heading"><span class="v54-login-provider-mark">'+providerIcon()+'</span><h1>'+e(S.provider)+'로 계속하기</h1></div><div class="v54-login-account">'+F.avatar(A.savedProfile?.nickname||F.nickname,'round')+'<div><strong>'+e(A.savedProfile?.nickname||F.nickname)+'</strong><span>spring@example.test</span></div>'+F.icon('check')+'</div>'+error+button(S.busy?'<span class="v54-login-spinner" aria-hidden="true"></span><span>확인 중</span>':'계속','complete','v54-login-primary'+(S.busy?' is-busy':''),(S.busy?'disabled ':'')+'aria-busy="'+S.busy+'"')+'<div class="v54-login-links">'+button('다른 방법으로 로그인','options','v54-login-text')+'</div>';
    else if(S.step==='recovery')body=S.recoveryDone?'<div class="v54-login-heading"><h1>복구 요청 확인</h1></div><div class="v54-login-recovery-result"><span>입력한 이메일</span><strong>'+e(S.recoveryEmail)+'</strong></div>'+button('로그인으로 돌아가기','email','v54-login-primary'):'<div class="v54-login-heading"><h1>로그인 복구</h1></div><form id="v54-login-recovery-form" data-ui54-login novalidate aria-busy="'+S.busy+'">'+field('recovery-email','계정 이메일','email',S.recoveryEmail||S.email,'email')+error+submit('계속')+'</form>';
    return '<section class="v54-login-page"><div class="v54-login-main"><div class="v54-login" data-ui54-step="'+S.step+'">'+body.replaceAll('<h1>','<h1 tabindex="-1">')+'</div></div>'+footer()+'</section>';
  }
  function update(){
    const panel=currentPanel();if(!panel)return;
    panel.querySelectorAll('form').forEach(form=>form.setAttribute('aria-busy',String(S.busy)));
    panel.querySelectorAll('input').forEach(input=>{if(input.type==='checkbox')input.disabled=S.busy;else input.readOnly=S.busy;});
    panel.querySelectorAll('[data-action="v54-login-password"],[data-action="v54-login-recovery"],[data-action="v54-login-info"]').forEach(button=>button.disabled=S.busy);
    const emailStep=S.step==='email'||S.step==='options',consentBlocked=S.step!=='recovery'&&F.viewState==='동의 필요'&&!F.v33Account?.consent;
    panel.querySelectorAll('[data-action="v54-login-provider"]').forEach(button=>button.disabled=S.busy||consentBlocked);
    F.root.querySelectorAll('.v54-login-footer-link').forEach(button=>button.disabled=S.busy);
    const control=panel.querySelector('button[type="submit"],[data-action="v54-login-complete"]');
    if(control){control.disabled=S.busy||consentBlocked;control.classList.toggle('is-busy',S.busy);control.setAttribute('aria-busy',String(S.busy));control.innerHTML=S.busy?'<span class="v54-login-spinner" aria-hidden="true"></span><span>확인 중</span>':emailStep?'로그인':'계속';}
  }
  function paint(focus){
    if(F.screen!=='login')return;
    closeInfo(false);
    if(overlay)overlay.innerHTML=header()+page();else{const node=F.root.querySelector('.v54-login-page');if(node){const holder=document.createElement('div');holder.innerHTML=page();node.replaceWith(holder.firstElementChild);}}
    F.root.querySelectorAll('[data-action="v54-login-back"]').forEach(button=>button.setAttribute('aria-label',backLabel()));
    update();const target=focus&&F.root.querySelector(focus);target?.focus({preventScroll:true});
  }
  function stopPending(){clearTimeout(timer);timer=null;token++;S.busy=false;}
  function markStep(replace){const url=new URL(location.href),state={...history.state};delete state.__v54LoginInfo;if(S.step==='options')url.searchParams.delete('loginStep');else url.searchParams.set('loginStep',S.step);history[replace?'replaceState':'pushState']({...state,__v54Login:session,depth,step:S.step},'',url);}
  function setStep(step,replace=false){if(!steps.has(step))return;stopPending();S.step=step;A.loginStep=step;if(step==='email'||step==='options')S.showPassword=false;S.errors={};if(step!=='recovery')S.recoveryDone=false;if(!replace)depth++;markStep(replace);paint(step==='email'||step==='options'?'#v54-login-email':step==='recovery'&&!S.recoveryDone?'#v54-login-recovery-email':'.v54-login h1');}
  function hydrate(){const step=new URL(location.href).searchParams.get('loginStep');S.step=steps.has(step)?step:steps.has(A.loginStep)?A.loginStep:'options';A.loginStep=S.step;if(F.viewState==='연동 실패'){S.errors.form='로그인을 완료하지 못했어요. 다시 시도해 주세요.';S.fault=S.step==='email'||S.step==='options'?'login':S.step==='recovery'?'recovery':'provider';}}
  function capture(){const input=F.root.querySelector('#chat-message'),list=F.root.querySelector('.chat-messages'),seek=F.root.querySelector('#timeline');return {screen:F.screen,state:F.viewState,base:F.currentBase,previous:F.previous,url:location.href,title:document.title,entryOwned:true,selectedBroadcast:F.selectedBroadcast,content:F.v38Viewer?.activeId,playing:F.playing,chatOpen:F.chatOpen,chatDraft:input?.value??F.chatDraft,chatTop:list?.scrollTop,chatSelection:input?{start:input.selectionStart,end:input.selectionEnd}:null,position:seek?.value,positionLabel:F.root.querySelector('#position-label')?.textContent,x:scrollX,y:scrollY,mainTop:F.root.querySelector('#main-content')?.scrollTop||0,focus:document.activeElement};}
  function prepare(origin){stopPending();session++;depth=0;S.origin=origin;S.step='options';A.loginStep='options';S.email='';S.provider='Google';S.showPassword=false;S.remember=false;S.errors={};S.recoveryEmail='';S.recoveryDone=false;S.fault=null;}
  function geometry(){if(!overlay)return;const rect=F.root.getBoundingClientRect();overlay.style.setProperty('--v54-login-left',Math.max(0,rect.left)+'px');overlay.style.setProperty('--v54-login-width',rect.width+'px');}
  function enterOverlay(origin){
    origin.entryOwned=true;prepare(origin);if(!F.authReturn)F.authReturn=origin.screen;
    F.closeDropdown();suspended=[...F.root.children].map(node=>({node,inert:node.hasAttribute('inert')}));suspended.forEach(({node})=>node.setAttribute('inert',''));
    overlay=document.createElement('div');overlay.className='v54-login-route';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','로그인');F.root.append(overlay);document.body.classList.add('v54-login-open');
    F.previous=origin.screen;F.screen=F.currentBase='login';F.viewState='기본';F.writeUrl(false);markStep(true);geometry();paint('.v54-login h1');return true;
  }
  function detach(){closeInfo(false);overlay?.remove();overlay=null;suspended.forEach(({node,inert})=>{if(!inert)node.removeAttribute('inert');});suspended=[];document.body.classList.remove('v54-login-open');}
  function restoreOverlay(){const origin=S.origin;if(!origin)return;stopPending();detach();Object.assign(F,{screen:origin.screen,currentBase:origin.base,viewState:origin.state,previous:origin.previous});F.authReturn=null;if(F.v41Follow?.loginIntent)F.v41Follow.loginIntent=null;S.origin=null;S.email='';S.recoveryEmail='';A.loginStep=S.step='options';F.renderReview?.();document.title=origin.title;window.scrollTo({left:origin.x,top:origin.y,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top:origin.mainTop});if(origin.focus?.isConnected)origin.focus.focus({preventScroll:true});else F.root.querySelector('#video-player')?.focus({preventScroll:true});}
  function cancel(){if(completion)return;stopPending();const password=currentInput('password');if(password)password.value='';F.authReturn=null;if(S.origin?.entryOwned&&history.state?.__v54Login===session){history.go(-(depth+1));return;}const destination=S.origin?.screen||'live';F.navigate(destination,undefined,true);}
  function back(){if(S.step==='options'){cancel();return;}stopPending();if(history.state?.__v54Login===session&&history.state.depth>0)history.back();else setStep('options',true);}
  function error(name,message){S.errors[name]=message;const node=currentInput(name),hint=currentPanel()?.querySelector('#v54-login-'+name+'-error');if(node){message?node.setAttribute('aria-invalid','true'):node.removeAttribute('aria-invalid');}if(hint){hint.textContent=message||'';hint.hidden=!message;}}
  function formError(message){S.errors.form=message;const node=currentPanel()?.querySelector('#v54-login-form-error');if(node){node.textContent=message||'';node.hidden=!message;}return node;}
  function validEmail(name){const value=currentInput(name)?.value.trim()||'',message=!value?'이메일 주소를 입력하세요.':!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)?'이메일 주소를 확인하세요.':'';error(name,message);return !message;}
  function finishNow(origin,destination){
    F.sessionLoggedIn=true;F.authReturn=null;A.loginStep='options';A.loginError='';S.email='';S.recoveryEmail='';
    if(overlay)detach();if(origin&&watch.has(origin.screen)&&destination===origin.screen&&F.v38Viewer){F.selectedBroadcast=origin.selectedBroadcast;F.v38Viewer.activeId=origin.content;F.v38Viewer.intent=origin.content;}
    finishing=true;F.navigate(destination,origin&&watch.has(origin.screen)&&destination===origin.screen?origin.state:undefined,true);finishing=false;
    if(origin&&watch.has(origin.screen)&&destination===origin.screen){F.v48Playback?.setPlaying(origin.playing,{feedback:false,source:'login-return'});F.v44ChatVisibility?.setOpen(origin.chatOpen,{focus:false});F.chatOpen=origin.chatOpen;F.chatDraft=origin.chatDraft;const input=F.root.querySelector('#chat-message'),list=F.root.querySelector('.chat-messages'),seek=F.root.querySelector('#timeline');if(input){input.value=origin.chatDraft||'';if(origin.chatSelection)input.setSelectionRange(origin.chatSelection.start,origin.chatSelection.end);}if(list&&origin.chatTop!==undefined)list.scrollTop=origin.chatTop;if(seek&&origin.position!==undefined){seek.value=origin.position;seek.style.setProperty('--fill',((Number(seek.value)-Number(seek.min))/(Number(seek.max)-Number(seek.min)||1)*100)+'%');const label=F.root.querySelector('#position-label');if(label)label.textContent=origin.positionLabel||label.textContent;}window.scrollTo({left:origin.x,top:origin.y,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top:origin.mainTop});}
    S.origin=null;S.errors={};S.step='options';
  }
  function finish(){const origin=S.origin,destination=F.authReturn||origin?.screen||'live';const password=currentInput('password');if(password)password.value='';if(origin?.entryOwned&&history.state?.__v54Login===session){completion={origin,destination};S.busy=true;update();history.go(-(depth+1));}else finishNow(origin,destination);}
  function run(kind){
    if(S.busy)return;S.busy=true;formError('');update();const ticket=++token;
    timer=setTimeout(()=>{timer=null;if(ticket!==token||F.screen!=='login')return;S.busy=false;const fail=S.fault===kind;S.fault=null;update();if(fail){formError(kind==='recovery'?'복구 요청을 확인하지 못했어요. 다시 시도해 주세요.':'로그인을 완료하지 못했어요. 다시 시도해 주세요.')?.focus({preventScroll:true});return;}if(kind==='recovery'){S.recoveryDone=true;paint('.v54-login h1');}else finish();},650);
  }
  F.pages.login=()=>page();
  F.header=()=>F.currentBase==='login'?header():old.header();
  F.render=(...args)=>{if(preserveInfoRender){preserveInfoRender=false;return;}if(overlay&&F.screen==='login'){paint();return;}closeInfo(false);const result=old.render(...args);F.root.classList.toggle('v54-login-active',F.currentBase==='login');if(F.screen==='login')update();return result;};
  F.navigate=(id,...args)=>{
    const from=F.screen,before=from!=='login'?capture():null;if(before)before.entryOwned=args[1]!==true;
    if(id==='login'&&watch.has(from)&&!F.dialog.open&&!F.review?.open)return enterOverlay(before);
    if(from==='login'&&id!=='login'){closeInfo(false);stopPending();if(overlay)detach();}
    const result=old.navigate(id,...args);
    if(from!=='login'&&F.screen==='login'){prepare(before);hydrate();markStep(true);paint('.v54-login h1');}
    else if(from==='login'&&F.screen!=='login'&&!finishing){S.origin=null;S.email='';S.recoveryEmail='';S.errors={};S.step=A.loginStep='options';}
    return result;
  };
  F.readUrl=(...args)=>{if(infoTraversal()){preserveInfoRender=true;return;}const from=F.screen,result=old.read(...args);if(F.screen==='login')hydrate();else if(from==='login'){stopPending();S.origin=null;S.email='';S.recoveryEmail='';S.errors={};S.step=A.loginStep='options';F.authReturn=null;}return result;};
  window.addEventListener('click',event=>{
    const control=event.target.closest?.('[data-action^="v54-login-"]');if(!control||control.disabled)return;event.preventDefault();event.stopImmediatePropagation();const action=control.dataset.action.slice(10);
    if(action==='info')openInfo(control.dataset.loginInfo,control);else if(action==='info-close')closeInfo();else if(action==='back')back();else if(action==='cancel')cancel();else if(action==='provider'){S.provider=control.dataset.provider;A.loginProvider=S.provider;setStep('provider');}else if(['options','email','recovery'].includes(action))setStep(action);else if(action==='complete')run('provider');else if(action==='password'){const input=currentInput('password');if(!input)return;const start=input.selectionStart,end=input.selectionEnd;S.showPassword=!S.showPassword;input.type=S.showPassword?'text':'password';control.innerHTML=icon(S.showPassword?'eye-off':'eye');control.setAttribute('aria-label','비밀번호 '+(S.showPassword?'숨기기':'표시'));input.focus({preventScroll:true});if(start!==null)input.setSelectionRange(start,end);}
  },true);
  window.addEventListener('submit',event=>{
    if(!event.target.matches?.('form[data-ui54-login]'))return;event.preventDefault();event.stopImmediatePropagation();if(S.busy)return;
    if(S.step==='email'||S.step==='options'){if(F.viewState==='동의 필요'&&!F.v33Account?.consent)return;const valid=validEmail('email'),password=currentInput('password');error('password',password?.value?'':'비밀번호를 입력하세요.');if(!valid||!password?.value){currentPanel()?.querySelector('[aria-invalid="true"]')?.focus();return;}S.email=currentInput('email').value.trim();run('login');}
    else if(S.step==='recovery'){if(!validEmail('recovery-email')){currentInput('recovery-email')?.focus();return;}S.recoveryEmail=currentInput('recovery-email').value.trim();run('recovery');}
  },true);
  window.addEventListener('input',event=>{const input=event.target;if(!input.closest?.('form[data-ui54-login]')||!['email','password','recovery-email'].includes(input.name))return;if(input.name==='email')S.email=input.value;else if(input.name==='recovery-email')S.recoveryEmail=input.value;error(input.name,'');formError('');update();},true);
  window.addEventListener('change',event=>{if(event.target.matches?.('[data-v54-login-consent]')){if(F.v33Account)F.v33Account.consent=event.target.checked;update();}else if(event.target.matches?.('[data-v54-login-remember]'))S.remember=event.target.checked;},true);
  window.addEventListener('focusout',event=>{const input=event.target;if(!input.closest?.('form[data-ui54-login]')||S.busy||event.relatedTarget?.closest?.('button,a,input[type="checkbox"]'))return;if((input.name==='email'||input.name==='recovery-email')&&input.value.trim())validEmail(input.name);},true);
  window.addEventListener('keydown',event=>{
    if(infoDialog?.open)return;
    if(!overlay||F.screen!=='login'||event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();back();return;}
    if(event.key==='Tab'){const controls=[...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]')].filter(node=>node.getClientRects().length),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  },true);
  window.addEventListener('popstate',event=>{
    const url=new URL(location.href),step=url.searchParams.get('loginStep'),sameLoginStep=F.screen==='login'&&url.searchParams.get('screen')==='login'&&S.step===(steps.has(step)?step:'options');
    if(infoBackPending||infoContextPending&&sameLoginStep){event.stopImmediatePropagation();const trigger=infoTrigger;closeInfo(false);infoBackPending=infoContextPending=false;depth=history.state?.__v54Login===session?Number(history.state.depth)||0:0;if(trigger?.isConnected)trigger.focus({preventScroll:true});return;}
    infoContextPending=false;
    closeInfo(false);
    if(completion){event.stopImmediatePropagation();const next=completion;completion=null;S.busy=false;finishNow(next.origin,next.destination);return;}
    if(overlay&&url.searchParams.get('screen')!=='login'){event.stopImmediatePropagation();restoreOverlay();return;}
    if(F.screen==='login'&&url.searchParams.get('screen')==='login'){event.stopImmediatePropagation();depth=history.state?.__v54Login===session?Number(history.state.depth)||0:0;const info=history.state?.__v54Login===session&&history.state.__v54LoginInfo,step=url.searchParams.get('loginStep'),next=steps.has(step)?step:'options';if(info&&S.step===next){openInfo(info,F.root.querySelector('[data-login-info="'+info+'"]'),false);return;}stopPending();S.step=next;A.loginStep=S.step;S.errors={};paint(S.step==='email'?'#v54-login-email':'.v54-login h1');if(info)openInfo(info,F.root.querySelector('[data-login-info="'+info+'"]'),false);}
  },true);
  window.addEventListener('resize',geometry);window.addEventListener('pagehide',()=>{stopPending();const input=currentInput('password');if(input)input.value='';});
  Object.assign(S,{setStep,setFault(value){S.fault=['login','provider','recovery'].includes(value)?value:null;},cancel,getState(){const input=currentInput('password');return {active:F.screen==='login',step:S.step,provider:S.provider,busy:S.busy,remember:S.remember,passwordVisible:S.showPassword,passwordLength:input?.value.length||0,errors:{...S.errors},recoveryDone:S.recoveryDone,returnTo:F.authReturn||S.origin?.screen||'live',preservedWatch:!!overlay,originContent:S.origin?.content||null};}});
  if(F.screen==='login'){session++;hydrate();markStep(true);}F.render();
})();
