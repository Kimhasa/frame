/* Nonmedia form surfaces. Existing feature handlers retain their state and submission. */
(()=>{
  'use strict';
  const F=window.F;
  if(!F?.root||F.v54Foundation)return;
  const protectedSelector='.preserved-player,.player,#video-player,#studio-preview,.studio-preview,.v3-studio-preview,[class*="locked-"],.v54-login,.v54-login-page,.v54-login-route,.v3-login,.v3-login-panel,.login-panel,form[data-ui54-login]';
  const excluded=node=>!node||!!node.closest?.(protectedSelector)||
    ((F.screen==='login'||F.currentBase==='login')&&F.root.contains(node))||
    (F.dialog?.contains(node)&&(F.screen==='quality'||!!F.dialog.querySelector('[name="bitrate"]')));
  let serial=0,queued=false;
  const each=(scope,selector,fn)=>{if(scope.matches?.(selector))fn(scope);scope.querySelectorAll?.(selector).forEach(fn);};
  function clearButton(group,input){
    let button=group.querySelector('[data-ui54-clear],[data-action*="clear-query"],[data-action*="clear-search"],[aria-label="검색어 지우기"]');
    if(!button&&!input.readOnly&&!input.disabled){
      button=document.createElement('button');button.type='button';button.dataset.ui54Clear='';
      button.className='icon ghost';button.setAttribute('aria-label','검색어 지우기');
      button.innerHTML=F.icon('close');
      const submit=group.querySelector('button[type="submit"],button:not([type])');
      if(submit)group.insertBefore(button,submit);else group.append(button);
    }
    if(!button)return;
    button.dataset.ui54SearchAction='clear';
    if(button.hasAttribute('data-ui54-clear'))button.hidden=!input.value||input.disabled||input.readOnly;
  }
  function search(group){
    if(excluded(group))return;
    const input=group.querySelector('input[type="search"],input[name="search"],input[name="history-query"]');
    if(!input||excluded(input))return;
    // Forms containing filter/date controls keep the feature's own toolbar geometry.
    if(group.querySelectorAll('input:not([type="hidden"]),select,textarea').length!==1)return;
    group.dataset.ui54Search='';input.dataset.ui54SearchInput='';delete input.dataset.ui54Field;
    if(!input.id)input.id='ui54-search-'+(++serial);
    if(!input.getAttribute('aria-label')&&!input.getAttribute('aria-labelledby')&&!group.querySelector('label[for="'+input.id+'"]')){
      input.setAttribute('aria-label',input.placeholder||'검색');
    }
    group.querySelectorAll(':scope > svg').forEach(icon=>{icon.dataset.ui54SearchIcon='';icon.setAttribute('aria-hidden','true');});
    group.querySelectorAll(':scope > button').forEach(button=>{
      button.dataset.ui54SearchAction=button.type==='submit'?'submit':'action';
      if(!button.textContent.trim()&&!button.getAttribute('aria-label'))button.setAttribute('aria-label',button.type==='submit'?'검색':'검색 옵션');
    });
    clearButton(group,input);
  }
  function install(scope){
    if(!scope||excluded(scope))return;
    each(scope,'input,textarea,select,button.choice-button',node=>{
      if(excluded(node)||(['hidden','range','file','color','image','submit','button','reset'].includes(node.type)&&!node.matches('button.choice-button')))return;
      if(node.type==='checkbox'||node.type==='radio'){node.dataset.ui54Check=node.type;return;}
      node.dataset.ui54Field=node.tagName==='TEXTAREA'?'textarea':node.tagName==='SELECT'||node.matches('.choice-button')?'choice':'input';
    });
    each(scope,'.v3-url-field',group=>{
      if(!excluded(group)&&group.querySelector('input'))group.dataset.ui54Compound='';
    });
    each(scope,'[data-ui52-kind="search"],.header-search,.search-field,.v3-mobile-search,.v2-mobile-search,.v37-history-search,.v42-following-search,.v38-search,form[role="search"],.v38-source-tools > label',search);
    each(scope,'button[data-ui52-kind="button"],button[data-ui52-kind="choice"],button[data-ui52-kind="tab"],button[data-ui52-kind="switch"]',button=>{
      if(!excluded(button)&&!button.closest('[data-ui54-search]'))button.dataset.ui54Focus='';
    });
    return scope;
  }
  function refresh(){install(F.root);if(F.dialog?.open)install(F.dialog);}
  function schedule(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;refresh();});}
  const old={render:F.render,modal:F.renderModal,label:F.labelControls,generic:F.genericDialog};
  F.render=(...args)=>{const result=old.render(...args);refresh();return result;};
  F.renderModal=(...args)=>{const result=old.modal(...args);schedule();return result;};
  F.genericDialog=(...args)=>{const result=old.generic(...args);schedule();return result;};
  F.labelControls=(scope,...args)=>{const result=old.label(scope,...args);install(scope);return result;};
  document.addEventListener('input',event=>{
    const group=event.target.closest?.('[data-ui54-search]');if(group&&!excluded(group))clearButton(group,event.target);
  },true);
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-ui54-clear]');if(!button||button.disabled||excluded(button))return;
    const group=button.closest('[data-ui54-search]'),input=group?.querySelector('[data-ui54-search-input]');
    if(!input||input.disabled||input.readOnly)return;
    event.preventDefault();event.stopImmediatePropagation();
    input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
    const current=document.getElementById(input.id);(current?.isConnected?current:input).focus({preventScroll:true});
    if(group.isConnected)clearButton(group,input);
  },true);
  F.v54Foundation={install,refresh,schedule};
  refresh();
})();
