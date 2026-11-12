/* Mobile page/sheet presentation for local design only. Existing form transactions stay with their owners. */
(()=>{
  'use strict';
  const F=window.F;if(!F?.dialog||!F.root)return;
  const Q=matchMedia('(max-width:767px)'),D=F.dialog,B=document.body;
  const old={render:F.render,modal:F.renderModal,generic:F.genericDialog,choice:F.openChoice,closeChoice:F.closeDropdown,navigate:F.navigate,close:F.closeModal};
  const S=F.v39Mobile={active:false,presentation:null,choice:null,origin:null,history:null,restoring:false,checks:[]};
  const savedButtons=new WeakMap();let queued=false,polishing=false;const popCleanups=[];
  const cssClass=(node,name,on)=>{if(node.classList.contains(name)!==on)node.classList.toggle(name,on);};
  const protectedNode=node=>!!node?.closest?.('.preserved-player,.player,[class*="locked-"],#review-dialog,.review-bar');
  const isMobile=()=>Q.matches||F.device==='mobile';
  const token=node=>node?{id:node.id,action:node.dataset?.action,go:node.dataset?.go,key:node.dataset?.key,name:node.getAttribute('name'),text:(node.getAttribute('aria-label')||node.textContent||'').trim()}:null;
  const find=(t,scope=F.root)=>{if(!t)return null;if(t.id){const n=document.getElementById(t.id);if(n&&scope.contains(n))return n;}return [...scope.querySelectorAll('button,input,textarea,a')].find(n=>(!t.action||n.dataset.action===t.action)&&(!t.go||n.dataset.go===t.go)&&(!t.key||n.dataset.key===t.key)&&(!t.name||n.name===t.name)&&(n.getAttribute('aria-label')||n.textContent||'').trim()===t.text);};
  const remember=()=>({screen:F.screen,state:F.viewState,x:scrollX,y:scrollY,focus:token(document.activeElement),fields:[...F.root.querySelectorAll('main input:not([type=file]):not([type=password]),main textarea')].filter(n=>n.id||n.name).map(n=>({id:n.id,name:n.name,value:n.value,checked:n.checked}))});
  function restore(origin,fields=false){if(!origin||F.screen!==origin.screen)return;if(fields)origin.fields.forEach(v=>{const n=v.id?document.getElementById(v.id):F.root.querySelector(`[name="${CSS.escape(v.name)}"]`);if(!n)return;n.value=v.value;if(n.type==='checkbox'||n.type==='radio')n.checked=v.checked;});window.scrollTo({left:origin.x,top:origin.y,behavior:'instant'});find(origin.focus)?.focus({preventScroll:true});}
  function geometry(){const r=F.root.getBoundingClientRect(),preview=F.device==='mobile'&&!Q.matches,bar=document.querySelector('.review-bar'),barRect=bar?.getBoundingClientRect(),top=preview&&barRect&&getComputedStyle(bar).display!=='none'?Math.max(0,barRect.bottom):0,v=window.visualViewport;
    B.style.setProperty('--v39-left',preview?Math.max(0,r.left)+'px':'0px');B.style.setProperty('--v39-width',preview?Math.min(r.width,767)+'px':'100%');B.style.setProperty('--v39-top',top+'px');B.style.setProperty('--v39-height',Math.max(220,(v?.height||innerHeight)-top)+'px');}
  function shortDialog(){return !!D.querySelector('.v38-participants,.v38-emoji,.v34-chat-participants,.v34-chat-emoji')||D.dataset.mobilePresentation==='sheet';}
  function restoreHeader(){D.querySelectorAll('.v39-mobile-back').forEach(b=>{const s=savedButtons.get(b);if(s){b.innerHTML=s.html;if(s.label===null)b.removeAttribute('aria-label');else b.setAttribute('aria-label',s.label);if(s.title===null)b.removeAttribute('title');else b.title=s.title;if(s.action===undefined)delete b.dataset.action;else b.dataset.action=s.action;}b.classList.remove('v39-mobile-back');});}
  function invokeCancel(button){const saved=savedButtons.get(button);if(!saved||!button.classList.contains('v39-mobile-back')){button?.click();return;}const current=button.dataset.action;if(saved.action===undefined)delete button.dataset.action;else button.dataset.action=saved.action;button.click();if(button.isConnected)button.dataset.action=current;}
  function backTarget(){const sourceBack=D.querySelector('[data-action="v38-account-source-back"],[data-action="v36-source-back"]');return sourceBack||D.querySelector('.modal-head>button:not([disabled])');}
  function currentKind(){if(!D.open)return null;if(F.screen==='sources'&&!!F.v38Account?.source.confirming)return 'source-confirm';if(F.v38Management?.modal.length>1)return 'management-nested';if(F.v38Engagement?.dialog?.kind==='refund')return 'refund';return 'dialog';}
  function pushMarker(kind,origin,url=location.href){if(!isMobile()||S.history)return;const previous=history.state;try{history.pushState({...previous,__frameMobileDialog:true},'',url);S.history={kind,url,origin,owned:true};}catch{}}
  function consumeHistory(url,state=history.state,focus=null,dialog=false,after=null){popCleanups.push({url,state,focus,dialog,after});history.back();}
  function removeMarker(){if(!S.history?.owned)return;const after=S.afterDialog;S.afterDialog=null;S.history=null;consumeHistory(location.href,history.state,null,false,after);}
  function syncHistory(){if(!D.open&&S.history&&!S.restoring){const origin=S.history.origin;if(origin&&F.screen===origin.screen){removeMarker();requestAnimationFrame(()=>restore(origin));}else S.history=null;}if(!D.open){S.origin=null;}}
  function polish(){if(polishing)return;polishing=true;try{
    const mobile=isMobile();S.active=mobile;B.dataset.v39Mobile=String(mobile);geometry();
    if(!mobile||!D.open||F.screen==='quality'){
      if(!mobile&&S.choice)F.closeDropdown();
      cssClass(D,'v39-mobile-page',false);cssClass(D,'v39-mobile-sheet',false);cssClass(D,'v39-mobile-confirm',false);cssClass(B,'v39-modal-open',false);delete B.dataset.v39Presentation;restoreHeader();syncHistory();if(!D.open)S.wasOpen=false;return;
    }
    const confirm=D.classList.contains('v37-history-delete-dialog'),sheet=!confirm&&shortDialog();S.presentation=confirm?'confirm':sheet?'sheet':'page';cssClass(D,'v39-mobile-page',!confirm&&!sheet);cssClass(D,'v39-mobile-sheet',sheet);cssClass(D,'v39-mobile-confirm',confirm);if(!S.wasOpen)cssClass(D,'v39-mobile-enter',true);S.wasOpen=true;B.dataset.v39Presentation=S.presentation;cssClass(B,'v39-modal-open',true);if(D.getAttribute('aria-modal')!=='true')D.setAttribute('aria-modal','true');S.dialogUrl=location.href;
    const head=D.querySelector('.modal-head'),button=head?.querySelector(':scope>button');
    if(confirm)restoreHeader();
    if(button&&!sheet&&!confirm){if(!savedButtons.has(button))savedButtons.set(button,{html:button.innerHTML,label:button.getAttribute('aria-label'),title:button.getAttribute('title'),action:button.dataset.action});if(!button.classList.contains('v39-mobile-back')){button.classList.add('v39-mobile-back');button.innerHTML=F.icon('arrow');button.setAttribute('aria-label','뒤로');button.title='뒤로';}}
    const footer=D.querySelector('.modal-footer');if(footer){const buttons=[...footer.querySelectorAll(':scope>button')];cssClass(footer,'v39-mobile-footer-empty',!footer.textContent.trim()||buttons.length===1&&/^(닫기|돌아가기)$/.test(buttons[0].textContent.trim())&&!footer.querySelector('input,textarea'));}
    const nested=currentKind();if(S.history?.kind==='generic'&&nested!=='dialog')S.history.nested=nested;
  }finally{polishing=false;}}
  function schedule(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;polish();});}
  function cleanupChoice(){const c=S.choice;if(!c)return;S.choice=null;c.shell.remove();if(c.dialog)D.inert=false;B.classList.remove('v39-choice-open');if(c.entry&&!S.restoring)consumeHistory(location.href,c.parentState,token(c.anchor),c.dialog,c.afterClose);else c.afterClose?.();}
  function mobileChoice(){const a=F.activeSelect;if(!a||!isMobile()||protectedNode(a.anchor)||F.screen==='quality')return;
    geometry();const shell=document.createElement('div');shell.className='v39-choice-overlay';shell.setAttribute('role','dialog');shell.setAttribute('aria-modal','true');shell.setAttribute('aria-labelledby','v39-choice-title');const title=a.anchor.getAttribute('aria-label')||a.anchor.closest('.field,.v38-field')?.querySelector('label,span')?.textContent?.trim()||'선택';
    shell.innerHTML=`<section class="v39-choice-panel"><div class="v39-sheet-handle" aria-hidden="true"></div><div class="v39-choice-head"><h2 id="v39-choice-title">${F.e(title)}</h2><button type="button" class="icon ghost" aria-label="선택 닫기">${F.icon('close')}</button></div></section>`;
    shell.querySelector('section').append(a.menu);a.menu.classList.add('v39-choice-options');document.body.append(shell);S.choice={shell,dialog:D.open,anchor:a.anchor,parentState:history.state,entry:false};try{history.pushState({...history.state,__frameMobileChoice:true},'',location.href);S.choice.entry=true;}catch{}if(D.open)D.inert=true;B.classList.add('v39-choice-open');
    shell.querySelector('.v39-choice-head button').addEventListener('click',()=>{F.closeDropdown();a.anchor?.focus({preventScroll:true});});shell.addEventListener('click',ev=>{if(ev.target===shell){F.closeDropdown();a.anchor?.focus({preventScroll:true});}});(a.menu.querySelector('[aria-selected=true]')||a.menu.querySelector('button'))?.focus({preventScroll:true});
  }
  F.render=(...args)=>{const r=old.render(...args);schedule();return r;};F.renderModal=(...args)=>{const r=old.modal(...args);schedule();return r;};
  F.genericDialog=(...args)=>{const first=!D.open,origin=first?remember():S.origin;const r=old.generic(...args);if(first){S.origin=origin;pushMarker('generic',origin);}schedule();return r;};
  F.openChoice=(...args)=>{const r=old.choice(...args);mobileChoice();schedule();return r;};
  F.closeDropdown=(...args)=>{const r=old.closeChoice(...args);cleanupChoice();return r;};
  F.navigate=(...args)=>{const first=isMobile()&&!D.open&&F.modalScreens.has(args[0]),origin=first?remember():null;if(first)S.origin=origin;if(S.choice?.entry){S.choice.entry=false;args[2]=true;}const r=old.navigate(...args);if(first&&D.open&&F.screen===args[0])S.history={kind:'route',url:location.href,origin,owned:!args[2]};schedule();return r;};
  F.closeModal=(...args)=>{const origin=S.origin,r=old.close(...args);schedule();if(!D.open&&origin)requestAnimationFrame(()=>restore(origin));return r;};
  // Use the existing cancellation/back action. No form value, source transaction, or media action is committed here.
  window.addEventListener('click',ev=>{if(!isMobile()||!D.open||F.screen!=='sources'||!F.v38Account?.source.confirming)return;const button=ev.target.closest?.('.modal-head>.v39-mobile-back');if(!button)return;const target=D.querySelector('[data-action="v38-account-source-back"],[data-action="v36-source-back"]');if(target){ev.preventDefault();ev.stopImmediatePropagation();target.click();}},true);
  window.addEventListener('keydown',ev=>{const c=S.choice;if(!c)return;if(ev.key==='Tab'){const list=[...c.shell.querySelectorAll('button:not(:disabled)')],at=list.indexOf(document.activeElement);if(ev.shiftKey&&at<=0){ev.preventDefault();ev.stopImmediatePropagation();list.at(-1)?.focus();}else if(!ev.shiftKey&&at===list.length-1){ev.preventDefault();ev.stopImmediatePropagation();list[0]?.focus();}}},true);
  function handlePopState(ev){
    if(popCleanups.length){const cleanup=popCleanups.shift();ev.stopImmediatePropagation();try{history.replaceState(cleanup.state,'',cleanup.url);}catch{}if(cleanup.after)queueMicrotask(cleanup.after);else if(cleanup.focus)requestAnimationFrame(()=>find(cleanup.focus,cleanup.dialog&&D.open?D:F.root)?.focus({preventScroll:true}));return true;}
    if(isMobile()&&S.choice){ev.stopImmediatePropagation();S.choice.entry=false;S.restoring=true;const anchor=S.choice.anchor;F.closeDropdown();S.restoring=false;anchor?.focus({preventScroll:true});return true;}
    if(!isMobile()||!D.open||F.screen==='quality')return false;
    ev.stopImmediatePropagation();if(F.activeSelect){F.closeDropdown();return true;}
    const entry=S.history,url=S.dialogUrl;S.history=null;S.restoring=true;const origin=S.origin||entry?.origin,target=backTarget();if(target)invokeCancel(target);else F.closeModal();S.restoring=false;if(D.open){pushMarker(entry?.kind||'generic',origin,url);}schedule();if(!D.open&&origin)requestAnimationFrame(()=>restore(origin,true));
    return true;
  }
  window.addEventListener('popstate',handlePopState,true);
  new MutationObserver(schedule).observe(D,{attributes:true,attributeFilter:['open','class'],childList:true,subtree:true});
  new MutationObserver(schedule).observe(B,{attributes:true,attributeFilter:['data-device']});
  Q.addEventListener('change',schedule);window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);
  Object.assign(S,{polish,isMobile,backTarget,handlePopState,afterDialogClose(callback){if(S.history?.owned)S.afterDialog=callback;else requestAnimationFrame(callback);},afterChoice(callback){if(S.choice){S.choice.afterClose=callback;F.closeDropdown();}else{F.closeDropdown();callback();}}});schedule();
})();
