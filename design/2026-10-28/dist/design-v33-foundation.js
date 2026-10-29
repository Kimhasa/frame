/* Shared presentation safeguards and return focus for the local design prototype. */
(()=>{
  const F=window.F,render=F.render,navigate=F.navigate,generic=F.genericDialog,close=F.closeModal;
  let origin=null;
  const token=node=>node?{id:node.id,dataset:{...node.dataset},text:(node.getAttribute('aria-label')||node.textContent).trim()}:null;
  const remember=()=>({screen:F.screen,state:F.viewState,x:scrollX,y:scrollY,focus:token(document.activeElement?.closest('button,input,textarea,a'))});
  function findFocus(t){
    if(!t)return null;if(t.id){const node=document.getElementById(t.id);if(node)return node;}
    return [...F.root.querySelectorAll('button,input,textarea,a')].find(node=>Object.entries(t.dataset).every(([key,value])=>node.dataset[key]===value)&&(node.getAttribute('aria-label')||node.textContent).trim()===t.text);
  }
  F.navigate=(id,state,replace=false)=>{
    if(F.modalScreens.has(id)&&!F.modalScreens.has(F.screen)&&!F.dialog.open)origin=remember();
    else if(!F.modalScreens.has(id)&&!F.modalScreens.has(F.screen)&&!F.dialog.open)origin=null;
    return navigate(id,state,replace);
  };
  F.genericDialog=(...args)=>{
    if(!F.dialog.open){origin=remember();if(!F.modalScreens.has(F.screen))F.currentBase=F.screen;}
    const result=generic(...args);
    F.dialog.classList.add('v33-shared-dialog');
    return result;
  };
  F.closeModal=()=>{
    const returning=origin;origin=null;const result=close();
    if(returning&&!F.modalScreens.has(returning.screen)){
      if(F.screen===returning.screen&&F.viewState!==returning.state)navigate(returning.screen,returning.state,true);
      window.scrollTo({left:returning.x,top:returning.y,behavior:'instant'});
      const node=findFocus(returning.focus)||F.root.querySelector('#main-content');
      if(node){if(node.id==='main-content')node.tabIndex=-1;node.focus({preventScroll:true});}
    }
    return result;
  };
  function polish(){
    document.body.dataset.designReview=String(new URL(location.href).searchParams.get('review')==='1');
    const area=F.dialog.open?F.dialog:F.root.querySelector('main');if(!area)return;
    if(F.dialog.open&&F.screen!=='quality')F.dialog.classList.add('v33-shared-dialog');
    area.querySelectorAll('button').forEach(button=>{
      if(button.closest('.player,.preserved-player,#studio-preview,.v3-studio-preview'))return;
      if(button.closest('form')&&!button.hasAttribute('type'))button.type='button';
    });
    area.querySelectorAll('[role="tablist"]').forEach(list=>{
      const selected=list.querySelector('[aria-selected="true"]');
      if(selected)requestAnimationFrame(()=>{
        if(!selected.isConnected)return;const left=selected.offsetLeft-list.offsetLeft;
        if(left<list.scrollLeft)list.scrollLeft=left;
        else if(left+selected.offsetWidth>list.scrollLeft+list.clientWidth)list.scrollLeft=left+selected.offsetWidth-list.clientWidth;
      });
    });
    if(F.dialog.open){
      const heading=F.dialog.querySelector('.modal-head h2,.modal-head h1');
      if(heading&&!heading.id)heading.id='v33-dialog-title';
      if(heading)F.dialog.setAttribute('aria-labelledby',heading.id);
      const busy=!!F.dialog.querySelector('[aria-busy="true"],.v33-processing');
      F.dialog.setAttribute('aria-busy',String(busy));
    }
  }
  F.render=()=>{render();polish();};
  window.addEventListener('popstate',()=>{origin=null;});
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  F.render();
})();
