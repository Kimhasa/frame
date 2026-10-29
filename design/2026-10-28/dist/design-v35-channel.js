/* Local channel-form prototype only. No account, network or publishing API. */
(()=>{
  const F=window.F,A=F?.accountDesign;if(!A)return;
  const edit=F.pages['channel-edit'],channel=F.channel;
  const copy=links=>(Array.isArray(links)?links:[]).map(link=>({title:String(link.title||''),url:String(link.url||'')}));
  A.channel.socialLinks=copy(A.channel.socialLinks);A.savedChannel.socialLinks=copy(A.savedChannel.socialLinks);
  const S=F.v35Channel={errors:{},limit:5};
  const canEdit=()=>['소유자','채널 관리자'].includes(A.channelRole);
  const escape=F.e;
  const safeUrl=value=>{try{const url=new URL(value.trim());return ['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password?value.trim():null;}catch{return null;}};
  const changed=()=>JSON.stringify(A.channel)!==JSON.stringify(A.savedChannel)||['channelAvatarUrl','uploadedBanner','banner'].some(key=>A[key]!==A.savedAppearance[key]);
  function sync(){
    if(F.currentBase!=='channel-edit')return;
    A.dirty.channel=changed()||F.viewState==='저장 오류';
    F.root.querySelectorAll('[data-v3-form="channel"] .v3-save-bar button[type="submit"]').forEach(button=>button.disabled=!canEdit()||!A.dirty.channel);
    F.root.querySelectorAll('[data-v3-form="channel"] .v3-save-note').forEach(note=>note.textContent=A.dirty.channel?'저장하지 않은 변경사항이 있어요.':'');
  }
  function field(index,key,label,value,disabled){
    const id=`v35-social-${key}-${index}`,error=S.errors[index+':'+key];
    return `<div class="v35-social-field"><label for="${id}">${label}</label><input id="${id}" name="social-${key}-${index}" data-v35-social-index="${index}" data-v35-social-key="${key}" value="${escape(value)}" type="${key==='url'?'url':'text'}" ${key==='title'?'maxlength="30"':'inputmode="url"'} autocomplete="off" ${disabled?'disabled':''} ${error?`aria-invalid="true" aria-describedby="${id}-error"`:''}>${error?`<small id="${id}-error" class="v35-social-error" role="alert">${escape(error)}</small>`:''}</div>`;
  }
  function socialForm(){
    const links=A.channel.socialLinks,disabled=!canEdit();
    return `<section class="v35-channel-social" aria-labelledby="v35-social-heading"><div class="v35-social-heading"><h3 id="v35-social-heading">소셜 링크</h3><span>${links.length} / 5</span></div><div class="v35-social-rows">${links.map((link,index)=>`<div class="v35-social-row">${field(index,'title','제목',link.title,disabled)}${field(index,'url','URL',link.url,disabled)}${F.btn('','v35-channel-remove','trash','v35-social-remove',`data-index="${index}" aria-label="${index+1}번 링크 삭제" ${disabled?'disabled':''}`)}</div>`).join('')}</div>${F.btn('링크 추가','v35-channel-add','plus','v35-social-add',disabled||links.length>=S.limit?'disabled':'')}</section>`;
  }
  F.pages['channel-edit']=viewState=>{
    if(A.channel.socialLinks===A.savedChannel.socialLinks)A.channel.socialLinks=copy(A.channel.socialLinks);
    A.channel.socialLinks=copy(A.channel.socialLinks);A.dirty.channel=changed()||viewState==='저장 오류';
    const h=document.createElement('div');h.innerHTML=edit(viewState);
    const form=h.querySelector('#v3-account-channel-form');
    if(form){const section=document.createElement('div');section.innerHTML=socialForm();form.querySelector('.v3-save-bar')?.before(section.firstElementChild);}
    h.querySelectorAll('[data-v3-form="channel"] .v3-save-bar button[type="submit"]').forEach(button=>button.disabled=!canEdit()||!A.dirty.channel);
    return h.innerHTML;
  };
  const linksMarkup=()=>A.savedChannel.socialLinks.filter(link=>link.title.trim()&&safeUrl(link.url)).map(link=>`<a href="${escape(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer" aria-label="${escape(link.title.trim())} (새 창)">${F.icon('link')}<span>${escape(link.title.trim())}</span></a>`).join('');
  F.channel=(...args)=>{
    const h=document.createElement('div');h.innerHTML=channel(...args);if(F.selectedBroadcast!==0)return h.innerHTML;
    const saved=A.savedChannel;
    h.querySelectorAll('.v2-public-about>p,.v2-channel-about>p').forEach(p=>{p.textContent=saved.bio;p.classList.add('v35-channel-intro');});
    const about=h.querySelector('.v2-public-about')||h.querySelector('.v2-channel-about');
    if(about){const links=linksMarkup();if(links){const list=document.createElement('div');list.className='v35-channel-public-links';list.setAttribute('aria-label','채널 소셜 링크');list.innerHTML=links;about.append(list);}}
    return h.innerHTML;
  };
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  window.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-action]');if(!button)return;
    if(button.dataset.action==='v3-account-reset'&&button.dataset.scope==='channel'){S.errors={};if(F.viewState==='저장 오류'){F.viewState='기본';F.writeUrl?.(true);}queueMicrotask(()=>{A.channel.socialLinks=copy(A.channel.socialLinks);sync();});return;}
    if(!button.dataset.action.startsWith('v35-channel-')||button.disabled)return;stop(event);if(!canEdit())return;
    if(button.dataset.action==='v35-channel-add'&&A.channel.socialLinks.length<S.limit){A.channel.socialLinks.push({title:'',url:''});S.errors={};F.render();F.root.querySelector(`#v35-social-title-${A.channel.socialLinks.length-1}`)?.focus();}
    if(button.dataset.action==='v35-channel-remove'){A.channel.socialLinks.splice(Number(button.dataset.index),1);S.errors={};F.render();F.root.querySelector('[data-action="v35-channel-add"]')?.focus();}
  },true);
  window.addEventListener('input',event=>{
    const input=event.target,index=input.dataset?.v35SocialIndex,key=input.dataset?.v35SocialKey;
    if(index!==undefined&&key&&canEdit()){
      const link=A.channel.socialLinks[Number(index)];if(!link)return;link[key]=input.value;delete S.errors[index+':'+key];input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');input.closest('.v35-social-field')?.querySelector('.v35-social-error')?.remove();sync();
    }else if(input.dataset?.v3Scope==='channel')queueMicrotask(sync);
  },true);
  window.addEventListener('submit',event=>{
    if(event.target.dataset?.v3Form!=='channel'||!canEdit())return;
    S.errors={};A.channel.socialLinks.forEach((link,index)=>{
      if(!link.title.trim()||link.title.trim().length>30)S.errors[index+':title']='제목을 1~30자로 입력하세요.';
      if(!safeUrl(link.url))S.errors[index+':url']='http:// 또는 https://로 시작하는 URL을 입력하세요.';
    });
    if(Object.keys(S.errors).length){stop(event);A.channelTab='기본 정보';F.render();F.root.querySelector('.v35-channel-social [aria-invalid="true"]')?.focus();return;}
    queueMicrotask(()=>{A.savedChannel.socialLinks=copy(A.savedChannel.socialLinks);A.channel.socialLinks=copy(A.channel.socialLinks);sync();});
  },true);
  F.render();
})();
