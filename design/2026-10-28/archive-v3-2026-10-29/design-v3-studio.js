/* FRAME studio concept. Only the surrounding preparation and live workspace. */
(()=>{
'use strict';
const F=window.F;
const esc=F.e;
const categories=['개발·작업','게임','일상·이야기','디자인·창작','지식·탐색'];
const visibility=['전체 공개','링크 공개','비공개'];
const defaults={title:'조용히 개발해요. 오늘은 플레이어 마무리하는 날',category:'개발·작업',visibility:'전체 공개',tags:'개발, 코딩, 작업실'};
F.studioDraft=Object.assign({},defaults,F.studioDraft||{});
F.studioTitleError=false;
const sources={
 editor:{kind:'editor',name:'workspace.ts — Visual Studio Code',scene:'code',type:'프로그램 창'},
 discord:{kind:'discord',name:'작업실 — Discord',scene:'board',type:'프로그램 창'},
 claude:{kind:'claude',name:'Claude',scene:'design',type:'프로그램 창'},
 chrome:{kind:'chrome',name:'프로젝트 문서 — Chrome',scene:'map',type:'프로그램 창'},
 game:{kind:'game',name:'픽셀 어드벤처',scene:'game',type:'프로그램 창'},
 night:{kind:'chrome',name:'도시의 밤 — Chrome',scene:'night',type:'프로그램 창'},
 'monitor-1':{kind:'monitor',name:'모니터 1',scene:'code',type:'전체 화면 · 2560 × 1440'},
 'monitor-2':{kind:'monitor',name:'모니터 2',scene:'design',type:'전체 화면 · 1920 × 1080'}
};
const button=(text,action,icon='',cls='',attrs='')=>F.btn(text,action,icon,cls,attrs);
const field=(label,key,value,attrs='')=>`<label class="v3-studio-field"><span>${label}</span><input name="v3-studio-${key}" data-v3-studio-field="${key}" value="${esc(value)}" ${attrs}></label>`;
const choice=(label,key,value,items,modal=false)=>`<div class="v3-studio-field"><span id="v3-${modal?'modal-':''}${key}-label">${label}</span>${button(esc(value),'v3-studio-choice','chevron','v3-studio-choice',`data-field="${key}" data-modal="${modal}" data-options="${esc(JSON.stringify(items))}" aria-labelledby="v3-${modal?'modal-':''}${key}-label" aria-haspopup="listbox"`)}</div>`;
function infoForm(draft,modal=false){
 return `<div class="v3-studio-info-form${modal?' v3-studio-modal-form':''}">
  <label class="v3-studio-field v3-studio-title-field"><span>방송 제목 <b aria-hidden="true">*</b></span><input name="v3-studio-title" data-v3-studio-field="title" value="${esc(draft.title)}" maxlength="100" placeholder="어떤 방송을 시작할까요?" ${F.studioTitleError?'aria-invalid="true" aria-describedby="v3-studio-title-error"':''}>${F.studioTitleError?'<small id="v3-studio-title-error" class="v3-studio-error-text">방송 제목을 입력해 주세요.</small>':''}</label>
  <div class="v3-studio-field-row">${choice('카테고리','category',draft.category,categories,modal)}${choice('공개 설정','visibility',draft.visibility,visibility,modal)}</div>
  ${field('태그','tags',draft.tags,'placeholder="방송을 설명하는 태그를 입력하세요" maxlength="100"')}
 </div>`;
}
function sourceCard(source,disconnected){
 return `<div class="v3-studio-source">${F.appIcon(source.kind)}<div class="v3-studio-source-copy"><span>${disconnected?'선택한 창을 확인해 주세요':source.type}</span><strong title="${esc(source.name)}">${esc(source.name)}</strong></div>${F.go('sources',disconnected?'다른 화면 선택':'화면 변경','monitor','v3-studio-source-button')}</div>`;
}
function activeInfo(draft){
 return `<section class="v3-studio-card v3-studio-broadcast-info"><div class="v3-studio-section-head"><h2>방송 정보</h2><div class="v3-studio-information-actions">${button('방송 상태','v3-studio-status','info','ghost small')}${button('수정','v3-studio-details','edit','ghost small')}</div></div><div class="v3-studio-current-info"><strong>${esc(draft.title)}</strong><div class="v3-studio-information-meta"><span>${F.icon('folder')}${esc(draft.category)}</span><span>${F.icon(draft.visibility==='전체 공개'?'globe':'shield')}${esc(draft.visibility)}</span>${draft.tags?`<span class="v3-studio-tags">${draft.tags.split(',').map(t=>t.trim()).filter(Boolean).slice(0,3).map(t=>`#${esc(t)}`).join(' ')}</span>`:''}</div><div class="v3-studio-live-summary"><span>${F.icon('users')}128명 시청 중</span><span>${F.icon('history')}01:24:36</span></div></div></section>`;
}
F.studio=state=>{
 const active=state==='방송 중'||F.broadcasting;
 const disconnected=state==='화면 연결 끊김';
 const failed=state==='방송 연결 실패';
 const noSource=state==='화면 선택 전';
 const source=sources[F.source]||sources.editor;
 const draft=F.studioDraft;
 const chatOpen=F.chatOpen!==false;
 const format=F.values?.resolution||'1080p';
 const fps=F.values?.fps||'60 fps';
 return `<div class="v3-studio${active?' is-live':' is-preparing'}${chatOpen?'':' chat-is-closed'}">
  <div class="v3-studio-heading"><div class="v3-studio-heading-copy"><div class="v3-studio-eyebrow">크리에이터 스튜디오</div><h1>${active?'방송 중':'방송 준비'}</h1><p>${active?'방송 화면과 시청자 반응을 한곳에서 확인하세요.':'화면을 선택하고, 오늘의 방송을 시작하세요.'}</p></div><div class="v3-studio-heading-actions">${!chatOpen?button('채팅','chat-toggle','chat','v3-studio-chat-open'):''}${active?F.go('share','방송 링크','share','v3-studio-link-button'):''}${F.go('broadcast-settings','방송 설정','gear','v3-studio-settings-button')}${active?F.go('broadcast-end','방송 종료','', 'v3-studio-primary danger'):button('방송 시작','v3-studio-start','live','v3-studio-primary primary')}</div></div>
  ${disconnected?`<div class="v3-studio-notice" role="alert">${F.icon('alert')}<span>공유하던 창이 닫혔어요. 방송할 화면을 다시 선택해 주세요.</span>${F.go('sources','화면 선택','right','ghost small')}</div>`:failed?`<div class="v3-studio-notice" role="alert">${F.icon('alert')}<span>방송 서버에 연결하지 못했어요. 연결 설정을 확인해 주세요.</span>${F.go('connection','연결 설정','right','ghost small')}</div>`:''}
  <div class="v3-studio-workspace"><div class="v3-studio-main">
   <section class="v3-studio-card v3-studio-preview-card" aria-label="방송 미리보기"><div class="v3-studio-section-head"><h2>미리보기</h2><div class="v3-studio-preview-actions"><span>${esc(format)}<i></i>${esc(fps)}</span>${button('','preview-fullscreen','expand','icon ghost','aria-label="미리보기 전체 화면"')}</div></div><div class="v3-studio-preview" id="studio-preview">${noSource?`<div class="v3-studio-no-source">${F.icon('monitor')}<strong>어떤 화면을 방송할까요?</strong>${F.go('sources','방송할 화면 선택','plus','primary')}</div>`:disconnected?`<div class="v3-studio-no-source">${F.icon('monitor')}<strong>화면 연결이 끊겼어요</strong>${F.go('sources','다른 화면 선택','refresh')}</div>`:F.scene(source.scene,'방송 미리보기')}</div>${sourceCard(source,disconnected)}</section>
   ${active?`${activeInfo(draft)}<section class="v3-studio-card v3-studio-activity"><div class="v3-studio-section-head"><h2>최근 활동</h2><span class="v3-studio-activity-caption">오늘 방송</span></div><div class="v3-studio-activity-row"><span class="v3-studio-activity-icon">${F.icon('heart')}</span><p><strong>산책하는 고양이</strong> 님이 팔로우했어요.</p><time>방금</time></div></section>`:`<section class="v3-studio-card v3-studio-broadcast-info"><div class="v3-studio-section-head"><h2>방송 정보</h2><span class="v3-studio-required-note"><b>*</b> 필수 항목</span></div><form id="v3-studio-info" novalidate>${infoForm(draft)}<div class="v3-studio-form-bottom"><span>${F.icon(draft.visibility==='전체 공개'?'globe':'shield')}${draft.visibility==='전체 공개'?'방송을 시작하면 라이브 목록에 표시돼요.':draft.visibility==='링크 공개'?'방송 링크를 받은 사람만 시청할 수 있어요.':'나만 볼 수 있는 방송으로 시작해요.'}</span>${button('저장','v3-studio-save','','small')}</div></form></section>`}
  </div>${chatOpen?`<div class="v3-studio-chat">${F.chat()}</div>`:''}</div>
 </div>`;
};
// Retain the existing modal host and navigation; this form edits the same draft.
F.modals['broadcast-details']=()=>{
 const draft=F.studioModalDraft||(F.studioModalDraft={...F.studioDraft});
 return {title:'방송 정보 수정',body:`<div class="v3-studio v3-studio-details-modal">${infoForm(draft,true)}</div>`,footer:`${button('취소','v3-studio-cancel-details')}${button('저장','v3-studio-save-details','','primary')}`,cls:'medium'};
};
document.addEventListener('input',event=>{
 const input=event.target.closest('[data-v3-studio-field]');
 if(!input)return;
 const key=input.dataset.v3StudioField;
 const inModal=!!input.closest('.v3-studio-details-modal');
 (inModal?(F.studioModalDraft||(F.studioModalDraft={...F.studioDraft})):F.studioDraft)[key]=input.value;
 if(key==='title'&&input.value.trim()){
  F.studioTitleError=false;input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');
  input.parentElement.querySelector('.v3-studio-error-text')?.remove();
 }
},true);
document.addEventListener('click',event=>{
 const target=event.target.closest('[data-action^="v3-studio-"]');
 if(!target)return;
 event.preventDefault();event.stopImmediatePropagation();
 const action=target.dataset.action;
 if(action==='v3-studio-choice'){
  const key=target.dataset.field;
  const inModal=target.dataset.modal==='true';
  const draft=inModal?(F.studioModalDraft||(F.studioModalDraft={...F.studioDraft})):F.studioDraft;
  F.openChoice(target,JSON.parse(target.dataset.options),draft[key],value=>{draft[key]=value;inModal?F.renderModal():F.render();});
 }else if(action==='v3-studio-start'){
  if(!F.studioDraft.title.trim()){
   F.studioTitleError=true;F.render();document.querySelector('.v3-studio [data-v3-studio-field="title"]')?.focus();return;
  }
  F.broadcasting=true;F.navigate('studio','방송 중');
 }else if(action==='v3-studio-save'){
  if(!F.studioDraft.title.trim()){F.studioTitleError=true;F.render();document.querySelector('.v3-studio [data-v3-studio-field="title"]')?.focus();return;}
  F.toast('방송 정보를 저장했어요.');
 }else if(action==='v3-studio-status'){
  F.genericDialog('방송 상태',F.dl([['실제 프레임','60 fps'],['비트레이트',`${F.values?.bitrate||'8'} Mbps`],['송출 해상도',F.values?.resolution||'1080p']]),'닫기');
 }else if(action==='v3-studio-details'){
  F.studioModalDraft={...F.studioDraft};F.studioTitleError=false;F.navigate('broadcast-details');
 }else if(action==='v3-studio-cancel-details'){
  F.studioModalDraft=null;F.studioTitleError=false;F.closeModal();
 }else if(action==='v3-studio-save-details'){
  if(!F.studioModalDraft?.title.trim()){F.studioTitleError=true;F.renderModal();document.querySelector('.v3-studio-details-modal [data-v3-studio-field="title"]')?.focus();return;}
  F.studioDraft={...F.studioModalDraft};F.studioModalDraft=null;F.studioTitleError=false;F.closeModal();F.toast('방송 정보를 수정했어요.');
 }
},true);
document.addEventListener('submit',event=>{
 if(event.target.id!=='v3-studio-info')return;
 event.preventDefault();event.stopImmediatePropagation();
 document.querySelector('[data-action="v3-studio-save"]')?.click();
},true);
})();
