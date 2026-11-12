/* Mobile settings presentation only. Existing account fields and actions remain in charge. */
(()=>{
 'use strict';
 const F=window.F,A=F?.accountDesign;if(!A)return;
 const ids=new Set(['profile','security','preferences']);
 const original={pages:Object.fromEntries([...ids].map(id=>[id,F.pages[id]])),render:F.render,navigate:F.navigate,read:F.readUrl,write:F.writeUrl};
 const mobile=()=>innerWidth<=767||F.device==='mobile'||document.body.dataset.device==='mobile';
 const query=()=>new URL(location.href).searchParams;
 const initialMode=()=>query().get('settingsView')==='hub'?'hub':query().get('settingsView')==='detail'||F.screen!=='profile'?'detail':'hub';
 const S=F.v39AccountMobile={mode:initialMode(),internal:false,fromHub:false,lastMobile:mobile()};
 const entries=[['계정 연결','security','link'],['보안 및 기기','security','shield'],['알림','preferences','bell'],['재생','preferences','play']];
 const btn=(label,action,icon='',cls='',attrs='')=>F.btn(label,'v39-settings-'+action,icon,cls,attrs);
 const holder=html=>{const node=document.createElement('div');node.innerHTML=html;return node;};
 function avatar(){const url=A.savedAppearance.avatarUrl;return url?`<span class="v39-settings-avatar"><img src="${F.e(url)}" alt=""></span>`:F.avatar(A.savedProfile.nickname,'round');}
 function hub(){return `<section class="v39-settings-hub"><h1>내 설정</h1><button type="button" class="v39-settings-profile" data-action="v39-settings-open" data-section="프로필" data-page="profile">${avatar()}<span><strong>${F.e(A.savedProfile.nickname)}</strong><small>@${F.e(A.savedProfile.handle)}</small></span>${F.icon('right')}</button><nav class="v39-settings-menu" aria-label="내 설정 항목">${entries.map(([label,page,icon])=>`<button type="button" data-action="v39-settings-open" data-section="${label}" data-page="${page}"><span class="v39-settings-menu-icon">${F.icon(icon)}</span><span>${label}</span>${F.icon('right')}</button>`).join('')}</nav></section>`;}
 function detail(html,id){
  const h=holder(html),page=h.querySelector('.v3-settings');if(!page)return html;
  page.classList.add('v39-settings-detail');page.classList.remove('v39-settings-hub');
  page.querySelector('.v3-page-heading')?.remove();page.querySelector('.v3-settings-nav')?.remove();
  const heading=page.querySelector('.v3-settings-body>.v3-section-heading'),channel=heading?.querySelector('[data-go="channel"]');
  const title=id==='profile'?'프로필':A.section;
  const bar=document.createElement('header');bar.className='v39-settings-pagebar';bar.innerHTML=btn('','back','arrow','v39-settings-back','aria-label="내 설정으로 돌아가기"')+`<h1>${F.e(title)}</h1><span class="v39-settings-page-actions"></span>`;
  if(channel){channel.classList.remove('v32-settings-channel-link');channel.classList.add('v39-settings-channel');channel.innerHTML='내 채널';bar.querySelector('.v39-settings-page-actions').append(channel);}
  heading?.querySelector('h2')?.remove();heading?.querySelector('p')?.remove();if(heading&&!heading.children.length)heading.remove();
  page.prepend(bar);return h.innerHTML;
 }
 for(const id of ids)F.pages[id]=state=>{const html=original.pages[id](state);if(!mobile())return html;if(state&&state!=='기본')S.mode='detail';return S.mode==='hub'?hub():detail(html,id);};
 function presentation(){
  const active=mobile()&&ids.has(F.currentBase),detail=active&&S.mode==='detail';
  F.root.classList.toggle('v39-settings-mobile-active',active);F.root.classList.toggle('v39-settings-detail-active',detail);F.root.classList.toggle('v39-settings-hub-active',active&&!detail);
  const viewport=window.visualViewport,height=viewport?viewport.height:innerHeight;
  F.root.style.setProperty('--v39-settings-height',height+'px');
 }
 function focusTitle(){const title=F.root.querySelector('.v39-settings-pagebar h1,.v39-settings-hub h1');if(title){title.tabIndex=-1;title.style.outline='none';title.focus({preventScroll:true});}}
 S.open=(section,page)=>{A.section=section;S.mode='detail';S.fromHub=true;S.internal=true;F.navigate(page);S.internal=false;focusTitle();};
 window.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-action^="v39-settings-"]');if(!button||button.disabled)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(button.dataset.action==='v39-settings-open')S.open(button.dataset.section,button.dataset.page);
  if(button.dataset.action==='v39-settings-back'){
   if(S.fromHub){S.fromHub=false;history.back();}
   else{S.mode='hub';S.internal=true;F.navigate('profile',undefined,true);S.internal=false;focusTitle();}
  }
 },true);
 F.navigate=(id,state,replace=false)=>{
  if(ids.has(id)&&!S.internal&&mobile()){
   if(!ids.has(F.currentBase)&&id==='profile'){S.mode='hub';S.fromHub=false;}
   else if(id!=='profile'&&!ids.has(F.currentBase))S.mode='detail';
  }
  return original.navigate(id,state,replace);
 };
 F.writeUrl=replace=>{original.write(replace);const u=new URL(location.href);if(ids.has(F.screen))u.searchParams.set('settingsView',S.mode);else u.searchParams.delete('settingsView');history.replaceState({},'',u);};
 F.readUrl=(...args)=>{const result=original.read(...args);S.mode=initialMode();return result;};
 F.render=()=>{const active=document.activeElement,finishing=mobile()&&S.mode==='detail'&&active?.closest?.('[data-v3-form="profile"]')&&(active.matches('[type="submit"]')||active.dataset.action==='v3-account-reset'||(!A.dirty.profile&&active.matches('input,textarea')));original.render();presentation();if(finishing&&!Object.keys(A.errors).length)focusTitle();};
 let resizeFrame;
 function resize(){cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{const changed=S.lastMobile!==mobile();S.lastMobile=mobile();if(changed&&ids.has(F.currentBase))F.render();else presentation();});}
 window.addEventListener('resize',resize,{passive:true});
 window.addEventListener('popstate',()=>{if(mobile()&&ids.has(F.screen))requestAnimationFrame(focusTitle);});
 window.visualViewport?.addEventListener('resize',()=>{presentation();const input=document.activeElement;if(input?.matches('input,textarea')&&input.closest('.v39-settings-detail'))requestAnimationFrame(()=>{const bottom=window.visualViewport.height-94;if(input.getBoundingClientRect().bottom>bottom)input.scrollIntoView({block:'center',behavior:'instant'});});},{passive:true});
 if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
 F.render();
})();
