(() => {
const {root,dialog,review,outline,e,icon}=F;
const A={
 'chat-tools':b=>F.openChoice(b,['미션 제안','투표 및 질문','포인트 보상','클립 만들기','다른 기기에서 보기'],null,name=>F.navigate({'미션 제안':'mission','투표 및 질문':'poll','포인트 보상':'rewards','클립 만들기':'clip-create','다른 기기에서 보기':'devices'}[name])),
 'close-modal':()=>F.closeModal(),'close-review':()=>review.close(),'close-outline':()=>{outline.hidden=true;document.getElementById('outline-button').setAttribute('aria-expanded','false');},
 'coverage':F.coverage,'design-notes':F.notes,
 'retry':()=>F.setState(F.data.screens.find(s=>s.id===F.screen).states[0]),'refresh':()=>{F.setState('기본');F.toast('목록을 새로고침했어요.');},
 'chat-toggle':()=>{F.chatOpen=!F.chatOpen;F.render();},'pause':()=>{F.playing=!F.playing;F.viewState=F.playing?'기본':'일시정지';F.writeUrl(true);F.render();F.showControls(root.querySelector('#video-player'));},
 'mute':()=>{F.muted=!F.muted;F.render();F.showControls(root.querySelector('#video-player'));},'unmute':()=>{F.muted=false;F.setState('기본');},
 'wide':()=>{F.wide=!F.wide;F.render();F.showControls(root.querySelector('#video-player'));},'fullscreen':()=>F.fullscreen(root.querySelector('#video-player')),'preview-fullscreen':()=>F.fullscreen(root.querySelector('#studio-preview')),
 'pip':()=>F.toast('이 화면에서는 PIP 모드를 열 수 없어요.'),'go-live':()=>{F.playing=true;F.setState('기본');F.showControls(root.querySelector('#video-player'));},
 'source-tab':b=>{F.sourceTab=b.dataset.tab;F.setState(b.dataset.tab);},'source-select':b=>{F.source=b.dataset.source;F.renderModal();dialog.querySelector(`[data-source="${F.source}"]`)?.focus({preventScroll:true});},
 'source-refresh':()=>{F.setState(F.sourceTab);F.toast('공유할 화면 목록을 새로고침했어요.');},'source-retry':()=>F.setState(F.sourceTab),'source-confirm':()=>{F.closeModal();F.toast('공유할 화면을 선택했어요.');},
 'start-broadcast':()=>{F.broadcasting=true;F.navigate('studio','방송 중');},'finish-broadcast':()=>{F.broadcasting=false;F.setState('종료 요약');},
 'advanced':b=>{const body=b.nextElementSibling;body.hidden=!body.hidden;b.setAttribute('aria-expanded',String(!body.hidden));},
 'toggle':b=>{const on=b.getAttribute('aria-checked')!=='true';b.setAttribute('aria-checked',String(on));if(b.dataset.key==='bitrate-auto'){F.bitrateAuto=on;F.recalcBitrate();F.viewState=on?'기본':'수동 비트레이트';F.writeUrl(true);F.renderModal();}},
 'apply-settings':()=>{const input=dialog.querySelector('[name=bitrate]');if(!F.bitrateAuto&&input){const n=Number(input.value);if(n<.5||n>200){F.setState('지원 범위 오류');return;}F.values.bitrate=String(n);}F.closeModal();F.toast('방송 설정을 저장했어요.');},
 'connection-test':()=>F.setState('연결 확인 중'),'manual-connect':()=>{const server=dialog.querySelector('[name=viewer-server]'),port=dialog.querySelector('[name=viewer-port]');if(!server.value.trim()||Number(port.value)<1||Number(port.value)>65535){F.setState('연결 실패');return;}F.navigate('watch');},
 'save-connection':()=>{F.closeModal();F.toast('연결 설정을 저장했어요.');},'save-broadcast-details':()=>{if(!dialog.querySelector('[name=broadcast-title]').value.trim()){F.setState('입력 오류');return;}F.closeModal();F.toast('방송 정보를 저장했어요.');},
 'show-key':b=>{const input=b.parentElement.querySelector('input');input.type=input.type==='password'?'text':'password';},
 'quality-select':b=>{F.quality=b.dataset.quality;F.closeModal();F.toast(`화질: ${F.quality}`);},'copy-link':()=>{F.copy('https://frame.example/@spring/live');F.setState('복사 완료');},'copy':()=>F.copy('https://frame.example/overlay/sample'),
 'embed-code':()=>F.genericDialog('임베드 코드',`<textarea rows="4" readonly aria-label="임베드 코드">${e('<iframe src="https://frame.example/embed/spring" allowfullscreen></iframe>')}</textarea>`,'복사'),
 'social-login':()=>F.navigate('profile'),'email-login':()=>F.genericDialog('이메일로 로그인',F.field('이메일',F.input('email','','name@example.test','email')),'계속'),
 'follow':b=>{const on=b.textContent.trim()==='팔로우';b.innerHTML=icon('heart')+(on?'팔로잉':'팔로우');b.setAttribute('aria-pressed',String(on));b.classList.toggle('primary',!on);},
 'amount':b=>{if(b.dataset.amount==='직접 입력'){dialog.querySelector('[name=donation-amount]')?.focus();return;}dialog.querySelector('[name=donation-amount]').value=b.dataset.amount.replaceAll(',','');dialog.querySelectorAll('[data-amount]').forEach(x=>x.classList.toggle('selected',x===b));dialog.querySelector('[data-action=donate]').textContent=b.dataset.amount+'원 후원하기';},
 'donate':()=>{if(!dialog.querySelector('#payment-consent')?.checked){F.toast('결제 내용을 확인하고 동의해 주세요.');return;}F.setState('처리 중');},'donation-complete':()=>F.setState('완료'),
 'join-membership':()=>F.setState('가입 완료'),'gift-membership':()=>F.genericDialog('멤버십 선물',`${F.field('받는 사람',F.input('gift-recipient','','닉네임 입력'))}${F.field('수량',F.choice('gift-count','1개',['1개','5개','10개']))}`,'선물하기'),
 'send-mission':()=>F.setState('진행 중'),'vote':()=>{if(F.screen==='poll')F.setState('투표 완료');else F.toast('선택했어요.');},'close-poll':()=>F.toast('투표를 마감했어요.'),
 'redeem-reward':()=>F.setState(F.viewState==='포인트 부족'?'포인트 부족':'교환 완료'),'claim-drop':()=>F.setState('수령 완료'),
 'submit-report':()=>F.setState('접수 완료'),'create-clip':()=>F.setState('생성 완료'),'download-update':()=>F.setState('다운로드 중'),'confirm-raid':()=>F.setState('이동 확인'),'finish-raid':()=>F.setState('완료'),
 'connect-device':()=>F.setState('연결 실패'),'cancel-reconnect':()=>F.navigate('live'),
 'save':()=>F.toast('변경 사항을 저장했어요.'),'confirm-generic':()=>{F.closeModal();F.toast('반영했어요.');},
 'add-moderator':()=>F.genericDialog('채팅 운영자 추가',F.field('닉네임',F.input('moderator-name','','추가할 닉네임 입력')),'추가'),
 'add-schedule':()=>root.querySelector('[name=scheduled-title]')?.focus(),'add-reward':()=>F.genericDialog('보상 추가',`${F.field('보상 이름',F.input('reward-name'))}${F.field('필요 포인트',F.input('reward-price','1000','','number'))}`,'저장'),
 'add-poll':()=>root.querySelector('[name=poll-question]')?.focus(),'add-scene':()=>F.genericDialog('장면 추가',F.field('장면 이름',F.input('scene-name','','새 장면')),'추가'),'add-source':()=>F.navigate('sources'),
 'confirm':b=>F.genericDialog(b.textContent.trim()+' 확인',`<p class="help">선택한 항목에 ${e(b.textContent.trim())} 작업을 진행할까요?</p>`),
 'clear-history':()=>F.setState('기록 없음'),'read-all':()=>F.toast('모든 알림을 읽음으로 표시했어요.'),'pin-message':()=>F.toast('메시지를 고정했어요.'),'session-revoke':()=>F.toast('선택한 기기를 로그아웃했어요.'),
 'review-report':()=>F.genericDialog('신고 검토',`${F.dl([['사유','부적절한 콘텐츠'],['접수일','2026.10.28'],['상태',F.pill('검토 대기','orange')]])}${F.field('처리',F.choice('report-result','조치 선택',['경고','일시 제한','차단','조치 없음']))}${F.field('메모','<textarea aria-label="검토 메모" rows="3"></textarea>')}`,'처리'),
 'transaction-details':()=>F.setState('환불 요청'),'refund':()=>F.toast('환불 요청을 접수했어요.'),'send-question':()=>F.toast('질문을 보냈어요.'),'accept-mission':()=>F.toast('미션을 수락했어요.'),
 'point-history':()=>F.genericDialog('포인트 기록',F.dl([['오늘 시청 보상','+ 200 P'],['출석 보상','+ 100 P'],['다음 작업 제안','− 1,000 P']])),'speed':b=>F.openChoice(b,['0.5×','1.0×','1.25×','1.5×','2.0×'],b.textContent,q=>b.textContent=q),
 'open-recording':()=>F.navigate('vod-watch'),'open-folder':()=>F.toast('녹화 폴더 열기'),'download':()=>F.toast('내역 다운로드'),'webhook-test':()=>F.toast('전송 결과를 확인해 주세요.'),'avatar-change':()=>F.genericDialog('프로필 사진 변경','<label class="field">사진 선택<input type="file" accept="image/*" aria-label="프로필 사진 선택"></label>','적용'),'upload-banner':()=>F.genericDialog('채널 배너 변경','<label class="field">사진 선택<input type="file" accept="image/*" aria-label="배너 사진 선택"></label>','적용'),'reset-profile':()=>F.render(),
 'local-tab':b=>{const parent=b.closest('.page-tabs');parent.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));const label=b.textContent.trim();if(F.screen==='donate'){const field=dialog.querySelector('[name=donation-message]');if(label==='영상')F.genericDialog('영상 후원',`${F.field('영상 주소',F.input('video-url','','https://','url'))}${F.field('재생 시작',F.input('video-start','00:00'))}${F.field('메시지','<textarea rows="2" aria-label="영상 후원 메시지"></textarea>')}`,'후원하기');else if(field)field.placeholder=label==='음성'?'읽어드릴 메시지를 입력해 주세요.':'응원의 메시지를 남겨주세요.';}else if(label==='질문'&&F.screen==='poll')dialog.querySelector('[name=question]')?.focus();}
};
F.actions=A;
document.addEventListener('click',ev=>{
 const b=ev.target.closest('button');if(!b){if(F.activeSelect&&!ev.target.closest('.choice-options'))F.closeDropdown();return;}if(b.disabled)return;
 if(b.dataset.reviewGo){review.close();F.navigate(b.dataset.reviewGo);return;}if(b.dataset.go){F.navigate(b.dataset.go);return;}
 if(b.dataset.device){F.device=b.dataset.device;F.writeUrl(true);F.renderReview();F.closeDropdown();return;}
 if(b.id==='outline-button'){outline.hidden=!outline.hidden;b.setAttribute('aria-expanded',String(!outline.hidden));if(!outline.hidden)outline.querySelector('input')?.focus();return;}
 if(b.id==='terms-button'){F.terms();return;}if(b.id==='state-control'){const def=F.data.screens.find(s=>s.id===F.screen);F.openChoice(b,def.states,F.viewState,s=>{if(s==='기본')F.playing=true;else if(s==='일시정지')F.playing=false;F.setState(s);});return;}
 if(b.hasAttribute('data-choices')){F.openChoice(b,JSON.parse(b.dataset.choices),b.querySelector('span')?.textContent||b.textContent,q=>{F.values[b.dataset.key]=q;b.querySelector('span').textContent=q;if(b.dataset.key==='resolution'||b.dataset.key==='fps'){F.recalcBitrate();const input=dialog.querySelector('[name=bitrate]');if(input&&F.bitrateAuto)input.value=F.values.bitrate;}if(b.dataset.key==='mission-type'){const fee=dialog.querySelector('#mission-fee');if(fee)fee.hidden=q!=='미션 후원';}});return;}
 if(/^v[23]-/.test(b.dataset.action||''))return;
 if(b.dataset.action){if(A[b.dataset.action])A[b.dataset.action](b);else F.toast('선택했어요.');}
});
document.addEventListener('submit',ev=>{ev.preventDefault();const form=ev.target;if(form.id==='chat-form'){const input=form.querySelector('textarea');if(!input.value.trim())return;F.sessionMessages.push(input.value.trim());const list=root.querySelector('.chat-messages'),line=document.createElement('div'),name=document.createElement('strong'),text=document.createElement('span');line.className='chat-line';name.textContent=F.nickname;text.textContent=input.value.trim();line.append(name,text);list.append(line);input.value='';F.chatDraft='';list.scrollTop=list.scrollHeight;return;}if(form.id==='nickname-form'){const v=new FormData(form).get('nickname').trim();if(v.length<1||v.length>20){F.setState('입력 오류');return;}F.nickname=v;F.closeModal();F.toast('닉네임을 저장했어요.');return;}if(form.id==='header-search'||form.id==='catalog-search'){F.navigate('search');return;}if(form.id==='profile-form'){const v=new FormData(form).get('nickname').trim();if(v.length<1){F.setState('닉네임 오류');return;}F.nickname=v;F.toast('프로필을 저장했어요.');return;}F.toast('변경 사항을 저장했어요.');});
document.addEventListener('input',ev=>{if(ev.target.id==='screen-search'){const needle=ev.target.value.toLocaleLowerCase();outline.querySelectorAll('[data-find]').forEach(b=>b.hidden=!b.dataset.find.toLocaleLowerCase().includes(needle));outline.querySelectorAll('.outline-group').forEach(g=>g.hidden=![...g.querySelectorAll('[data-find]')].some(b=>!b.hidden));}if(ev.target.id==='timeline'){const n=Number(ev.target.value),minutes=Math.floor(n/60),seconds=n%60;root.querySelector('#position-label').textContent=`${minutes}:${String(seconds).padStart(2,'0')}`;root.querySelector('.live-dot')?.classList.toggle('behind',n<3598);}if(ev.target.name==='donation-amount'){const b=dialog.querySelector('[data-action=donate]');if(b)b.textContent=(Number(ev.target.value)||0).toLocaleString('ko-KR')+'원 후원하기';}});
document.addEventListener('change',ev=>{if(ev.target.id==='timeline'&&F.screen==='watch'){F.setState(Number(ev.target.value)<3598?'지난 구간':'기본');F.showControls(root.querySelector('#video-player'));}});
document.addEventListener('keydown',ev=>{
 if(F.activeSelect){const buttons=[...F.activeSelect.menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();buttons[(i+(ev.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();return;}if(ev.key==='Escape'){ev.preventDefault();const anchor=F.activeSelect.anchor;F.closeDropdown();anchor?.focus();return;}}
 if(ev.key==='Escape'){if(review.open)return;if(dialog.open){ev.preventDefault();F.closeModal();return;}if(!outline.hidden){outline.hidden=true;return;}}
 if(ev.key==='Escape'&&F.screen==='quality'){ev.preventDefault();F.navigate('watch',undefined,true);return;}
 if(dialog.open&&ev.key==='Tab'&&!review.open){const els=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href]')].filter(el=>el.getClientRects().length);if(!els.length)return;const first=els[0],last=els[els.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}return;}
 if(ev.isComposing||ev.target.matches('input,textarea')||dialog.open||review.open)return;
 if(['watch','vod-watch','clip-watch'].includes(F.screen)){if(ev.code==='Space'||ev.key.toLowerCase()==='k'){ev.preventDefault();A.pause();}else if(ev.key.toLowerCase()==='m')A.mute();else if(ev.key.toLowerCase()==='t')A.wide();else if(ev.key.toLowerCase()==='f')A.fullscreen();}
});
document.addEventListener('compositionstart',()=>F.composing=true);document.addEventListener('compositionend',()=>F.composing=false);document.addEventListener('keydown',ev=>{if(ev.target.id==='chat-message'&&ev.key==='Enter'&&!ev.shiftKey&&!ev.isComposing&&!F.composing){ev.preventDefault();ev.target.closest('form').requestSubmit();}});
})();


