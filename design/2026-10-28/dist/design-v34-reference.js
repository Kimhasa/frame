/* Reference detail pass: content cards, plain lists and scroll containers only. */
(()=>{
  const F=window.F;if(!F)return;
  const card=F.card,render=F.render;
  F.card=(broadcast,index=0,mode='live')=>{
    const h=document.createElement('div');h.innerHTML=card(broadcast,index,mode);
    const node=h.querySelector('.v3-card');
    if(node){node.dataset.cardMode=mode;if(mode==='live')node.querySelector('.card-category')?.remove();}
    return h.innerHTML;
  };
  function detail(scope){
    if(!scope)return;
    scope.querySelectorAll('.v3-card').forEach(node=>{
      const remove=node.querySelector('.v33-history-remove'),info=node.querySelector('.card-info');
      if(remove&&info&&remove.parentElement!==info)info.append(remove);
      const meta=node.querySelector('.card-category');
      if(node.dataset.cardMode==='live'||node.querySelector('.v2-live-badge')){meta?.remove();return;}
      if(meta&&!meta.children.length){
        const parts=meta.textContent.split(/\s*[·•]\s*/).filter(Boolean);
        if(parts.length>1){meta.classList.add('v34-card-meta');meta.replaceChildren(...parts.map(text=>{const span=document.createElement('span');span.textContent=text;return span;}));}
      }
    });
    scope.querySelectorAll('ul:not([role])').forEach(list=>{
      if(list.closest('.player,.preserved-player,.studio-preview,.locked-player-quality-menu,.sidebar,.mobile-nav'))return;
      list.classList.add('v34-detail-list');
    });
  }
  F.render=()=>{render();detail(F.root);detail(F.dialog);};
  new MutationObserver(()=>detail(F.dialog)).observe(F.dialog,{childList:true,subtree:true});
  F.render();
})();
