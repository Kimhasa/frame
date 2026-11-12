/* Shared UI primitives for the design prototype. Media nodes and their owners are excluded. */
(()=>{
  'use strict';
  const F=window.F;
  const protectedSelector='.preserved-player,.player,.studio-preview,.v3-studio-preview,#studio-preview,[class*="locked-"]';
  const contentButtonSelector='.brand,.mobile-only,.desktop-only,.sidebar,.mobile-nav,.side-nav,[role="tablist"],[role="radiogroup"],.source-grid,.v37-history-calendar-days,.v37-history-calendar-head,.v37-history-thumb,.v37-history-title,.v37-history-channel,.v37-history-remove,.thumb,.card-title,.card-channel,.v3-profile-menu';
  let serial=0,pending=false,standalone=null,tooltip=null,tooltipAnchor=null,tooltipTimer,typeBuffer='',typeTimer;
  const excluded=node=>!node||!!node.closest?.(protectedSelector)||!!(F?.screen==='quality'&&F.dialog?.contains(node));
  const mark=(node,kind)=>{node.dataset.ui52Kind=kind;};
  const each=(scope,selector,fn)=>{if(scope.matches?.(selector))fn(scope);scope.querySelectorAll?.(selector).forEach(fn);};
  function install(scope){
    if(!scope||excluded(scope))return;
    if(scope.nodeType===1)scope.setAttribute('data-ui52','');
    each(scope,'input,textarea,select',node=>{
      if(excluded(node)||node.type==='hidden'||node.type==='range')return;
      if(node.type==='checkbox'||node.type==='radio'){
        if(node.closest('[role="switch"],.switch,.v3-switch'))return;
        mark(node,node.type);
        const label=node.closest('label');if(label&&!label.closest(protectedSelector))label.classList.add('ui52-check-hit');
      }else if(node.type==='file')mark(node,'file');
      else if(node.tagName==='TEXTAREA'){mark(node,'textarea');if(node.closest('.chat-form'))node.dataset.ui52Context='chat';}
      else mark(node,'input');
    });
    each(scope,'.header-search,.search-field,.v37-history-search,.v38-search',group=>{
      if(excluded(group)||!group.querySelector('input[type="search"],input[name="search"],input[name="history-query"]'))return;
      mark(group,'search');
      group.querySelectorAll('input:not([type="hidden"])').forEach(input=>mark(input,'search-input'));
    });
    each(scope,'button',button=>{
      if(excluded(button))return;
      if(button.matches('[role="switch"],.switch,.v3-switch')){
        mark(button,'switch');
        let track=button.querySelector('.ui52-switch-track,.switch-track');
        if(!track){track=document.createElement('span');track.setAttribute('aria-hidden','true');button.prepend(track);}
        track.classList.add('ui52-switch-track');track.setAttribute('aria-hidden','true');
        [...button.children].filter(n=>n!==track&&n.tagName==='SPAN').forEach(n=>n.classList.add('ui52-switch-label'));
        return;
      }
      if(button.matches('[role="tab"]')){mark(button,'tab');return;}
      if(button.matches('.choice-button,[data-ui52-kind="choice"]')){mark(button,'choice');return;}
      if(button.closest(contentButtonSelector))return;
      if(button.classList.length&&!button.matches('.primary,.danger,.danger-outline,.ghost,.small,.icon,[data-ui52-kind="button"]'))return;
      mark(button,'button');
      button.dataset.ui52Variant=button.classList.contains('primary')?'primary':button.classList.contains('danger')||button.classList.contains('danger-outline')?'danger':button.classList.contains('icon')?'icon':button.classList.contains('ghost')?'ghost':'secondary';
    });
    each(scope,'.field,.v38-field',field=>{
      if(excluded(field))return;
      const input=field.querySelector('input:not([type="hidden"]),textarea,select,.choice-button');
      const label=field.querySelector('label');
      if(!input)return;
      if(label){
        if(!label.id)label.id='ui52-label-'+(++serial);
        if(!input.getAttribute('aria-label')&&!input.getAttribute('aria-labelledby'))input.setAttribute('aria-labelledby',label.id);
        if(input.matches('input,textarea,select')){if(!input.id)input.id='ui52-field-'+(++serial);label.htmlFor=input.id;}
      }
      const description=[...field.querySelectorAll('.error,.help,.field-error,.v38-error,.v38-field-error,[role="alert"]')].filter(n=>n!==input&&!n.contains(input));
      if(description.length){
        const ids=new Set((input.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));
        description.forEach(n=>{if(!n.id)n.id='ui52-help-'+(++serial);ids.add(n.id);});
        input.setAttribute('aria-describedby',[...ids].join(' '));
      }
    });
    each(scope,'button[title],button[data-tooltip],button[aria-label]',button=>{
      if(excluded(button)||button.matches('[role="switch"],[role="tab"]')||button.closest('[role="listbox"],[role="menu"]'))return;
      if(button.textContent.trim())return;
      const text=button.dataset.tooltip||button.getAttribute('title')||button.getAttribute('aria-label')||button.dataset.ui52Tooltip;
      if(!text)return;
      button.dataset.ui52Tooltip=text;
      if(!button.getAttribute('aria-label'))button.setAttribute('aria-label',text);
      if(button.hasAttribute('title'))button.removeAttribute('title');
    });
    each(scope,'.inline-notice,.v38-error,.field-error',node=>{if(!excluded(node))mark(node,'alert');});
    if(scope===F?.dialog&&scope.open){
      const explicit=scope.classList.contains('v37-history-delete-dialog')?'confirm':null;
      if(!scope.dataset.ui52Dialog||explicit)scope.dataset.ui52Dialog=explicit||'form';
    }
    const toast=document.getElementById('toast');if(toast)toast.setAttribute('data-ui52-toast','');
    return scope;
  }
  function installApp(){
    if(F){install(F.root);if(F.dialog?.open)install(F.dialog);}
    document.querySelectorAll('.ui52-sandbox').forEach(install);
  }
  function schedule(){if(pending)return;pending=true;queueMicrotask(()=>{pending=false;installApp();});}
  const active=()=>F?.activeSelect?.menu?.matches('.ui52-choice,.ui52-menu')?F.activeSelect:standalone;
  function closeChoice(returnFocus=true){
    const a=active();if(!a)return;
    const mobile=!!F?.v39Mobile?.choice;
    if(F?.activeSelect===a)F.closeDropdown();else{a.menu.remove();a.anchor.setAttribute('aria-expanded','false');standalone=null;}
    a.anchor.removeAttribute('aria-controls');
    if(returnFocus&&!mobile&&a.anchor.isConnected)a.anchor.focus({preventScroll:true});
  }
  function decorateChoice(a,kind='listbox'){
    if(!a?.menu||excluded(a.anchor))return;
    typeBuffer='';clearTimeout(typeTimer);
    const menu=a.menu;menu.classList.add(kind==='menu'?'ui52-menu':'ui52-choice');menu.setAttribute('role',kind);
    menu.id=menu.id||'ui52-options-'+(++serial);
    const label=a.anchor.getAttribute('aria-label')||a.anchor.textContent.trim()||'선택';menu.setAttribute('aria-label',label);
    a.anchor.setAttribute('aria-haspopup',kind);a.anchor.setAttribute('aria-controls',menu.id);
    [...menu.querySelectorAll('button')].forEach(button=>{
      button.setAttribute('role',kind==='menu'?'menuitem':'option');button.tabIndex=-1;
      if(kind==='menu')button.removeAttribute('aria-selected');
      if(button.disabled)button.setAttribute('aria-disabled','true');
    });
    if(!menu.closest('.v39-choice-overlay')){
      const r=a.anchor.getBoundingClientRect();
      menu.style.maxWidth='calc(100vw - 24px)';menu.style.maxHeight=Math.min(360,innerHeight-32)+'px';
      const width=menu.getBoundingClientRect().width;menu.style.left=Math.max(12,Math.min(r.left,innerWidth-width-12))+'px';
      const height=menu.getBoundingClientRect().height;
      menu.style.top=(r.bottom+height+8<=innerHeight-12?r.bottom+6:Math.max(12,r.top-height-6))+'px';
    }
    const chosen=menu.querySelector('[aria-selected="true"]:not(:disabled)')||menu.querySelector('button:not(:disabled)');chosen?.focus({preventScroll:true});
  }
  function openChoice(anchor,items,value,onChoose,options={}){
    if(F)return F.openChoice(anchor,items,value,onChoose,options);
    closeChoice(false);
    const menu=document.createElement('div');menu.className='choice-options';
    for(const item of items){const row=typeof item==='string'?{label:item}:item,button=document.createElement('button');button.type='button';button.textContent=row.label;button.disabled=!!row.disabled;button.dataset.choiceValue=row.label;button.setAttribute('aria-selected',String(row.label===value));menu.append(button);}
    document.body.append(menu);anchor.setAttribute('aria-expanded','true');standalone={menu,anchor,onChoose};
    menu.style.minWidth=Math.min(Math.max(anchor.getBoundingClientRect().width,180),innerWidth-24)+'px';
    menu.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;onChoose?.(button.dataset.choiceValue);closeChoice();});
    decorateChoice(standalone,options.kind||'listbox');return standalone;
  }
  function hideTooltip(){
    clearTimeout(tooltipTimer);tooltip?.remove();tooltip=null;
    if(tooltipAnchor){const ids=(tooltipAnchor.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!=='ui52-tooltip');ids.length?tooltipAnchor.setAttribute('aria-describedby',ids.join(' ')):tooltipAnchor.removeAttribute('aria-describedby');}
    tooltipAnchor=null;
  }
  function showTooltip(anchor){
    hideTooltip();if(!anchor?.isConnected||anchor.disabled||excluded(anchor)||!anchor.dataset.ui52Tooltip)return;
    tooltipAnchor=anchor;tooltip=document.createElement('div');tooltip.id='ui52-tooltip';tooltip.className='ui52-tooltip';tooltip.setAttribute('role','tooltip');tooltip.textContent=anchor.dataset.ui52Tooltip;document.body.append(tooltip);
    const ids=new Set((anchor.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));ids.add(tooltip.id);anchor.setAttribute('aria-describedby',[...ids].join(' '));
    const r=anchor.getBoundingClientRect(),tip=tooltip.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(r.left+(r.width-tip.width)/2,innerWidth-tip.width-8))+'px';tooltip.style.top=(r.bottom+tip.height+8<innerHeight?r.bottom+7:Math.max(8,r.top-tip.height-7))+'px';
  }
  document.addEventListener('pointerover',event=>{if(!matchMedia('(hover:hover)').matches)return;const button=event.target.closest?.('[data-ui52-tooltip]');if(button&&!button.contains(event.relatedTarget)){clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>showTooltip(button),300);}},true);
  document.addEventListener('pointerout',event=>{if(tooltipAnchor&&!tooltipAnchor.contains(event.relatedTarget))hideTooltip();else if(event.target.closest?.('[data-ui52-tooltip]')&&!event.target.closest('[data-ui52-tooltip]').contains(event.relatedTarget))clearTimeout(tooltipTimer);},true);
  document.addEventListener('focusin',event=>{const anchor=event.target.closest?.('[data-ui52-tooltip]');if(anchor){clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>{if(anchor.matches(':focus-visible'))showTooltip(anchor);},160);}},true);
  document.addEventListener('focusout',hideTooltip,true);
  document.addEventListener('pointerdown',event=>{const a=active();if(a&&!a.menu.contains(event.target)&&!a.anchor.contains(event.target))closeChoice(false);hideTooltip();},true);
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing)return;
    const a=active();
    if(a&&a.menu.contains(event.target)){
      const buttons=[...a.menu.querySelectorAll('button')].filter(b=>!b.disabled&&b.getAttribute('aria-disabled')!=='true');
      if(!buttons.length)return;const index=buttons.indexOf(document.activeElement);
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();event.stopImmediatePropagation();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next].focus({preventScroll:true});buttons[next].scrollIntoView({block:'nearest'});return;
      }
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeChoice();return;}
      if(event.key==='Tab'){closeChoice();return;}
      if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopImmediatePropagation();document.activeElement?.click();return;}
      if(event.key.length===1&&!event.ctrlKey&&!event.altKey&&!event.metaKey){clearTimeout(typeTimer);typeBuffer+=event.key.toLocaleLowerCase();typeTimer=setTimeout(()=>typeBuffer='',650);const found=buttons.find(b=>b.textContent.trim().toLocaleLowerCase().startsWith(typeBuffer));if(found){event.preventDefault();found.focus({preventScroll:true});found.scrollIntoView({block:'nearest'});}}
      return;
    }
    if(event.key==='Escape'&&tooltip){event.preventDefault();event.stopImmediatePropagation();hideTooltip();return;}
    const tab=event.target.closest?.('[data-ui52-kind="tab"][role="tab"]'),list=tab?.closest('[role="tablist"]');
    if(tab&&list&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      const tabs=[...list.querySelectorAll('[role="tab"]')].filter(n=>!n.disabled&&n.getAttribute('aria-disabled')!=='true'),index=tabs.indexOf(tab);if(index<0)return;
      event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus({preventScroll:true});tabs[next].click();
    }
  },true);
  window.addEventListener('resize',()=>{hideTooltip();if(standalone)closeChoice(false);});
  window.addEventListener('scroll',hideTooltip,true);
  const API=window.FRAME_UI52={install,openChoice,closeChoice,hideTooltip,schedule,version:52};
  if(F){
    const old={render:F.render,modal:F.renderModal,generic:F.genericDialog,label:F.labelControls,choice:F.openChoice};
    F.render=(...args)=>{hideTooltip();const r=old.render(...args);installApp();schedule();return r;};
    F.renderModal=(...args)=>{const r=old.modal(...args);delete F.dialog.dataset.ui52Dialog;schedule();return r;};
    F.genericDialog=(...args)=>{const r=old.generic(...args);delete F.dialog.dataset.ui52Dialog;schedule();return r;};
    F.labelControls=(scope,...args)=>{const r=old.label(scope,...args);install(scope);return r;};
    F.openChoice=(anchor,items,value,onChoose,options={})=>{hideTooltip();const r=old.choice(anchor,items,value,onChoose);if(!excluded(anchor)){const action=anchor.id==='v37-history-manage'||anchor.matches('.v38-chat-line-menu,[data-action="v40-schedule-more"],[aria-haspopup="menu"],[data-ui52-menu]');decorateChoice(F.activeSelect,options.kind||(action?'menu':'listbox'));}return r;};
  }
  installApp();
})();
