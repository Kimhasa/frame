/* Selected B identity. Media and functional icon renderers stay delegated. */
(()=>{
  'use strict';
  const F=window.F;
  if(!F?.icon||F.v55Brand)return;
  const previousIcon=F.icon,previousHeader=F.header;
  const path='M6 14c2-5 6-5 9-6 3-1 5-5 9-4 5 1 6 7 6 13 0 6-2 8-5 9l1 3c.4 1.5-.6 2-2 2h-4c-1.1 0-1.8-.5-2-1.5L17 27h-3l-.6 2.5c-.2 1-1 1.5-2 1.5H9c-2.5 0-3-1.4-2-5-4-1-5-3-4-7 .8-2.2 1.8-3.8 3-5ZM12 16v2a2 2 0 0 0 4 0v-2a2 2 0 0 0-4 0Zm8-1v2a2 2 0 0 0 4 0v-2a2 2 0 0 0-4 0Z';
  const wordPaths='<path d="M3 2h20q2 0 2 2v3q0 2-2 2H9v5h12q2 0 2 2v3q0 2-2 2H9v8q0 2-2 2H3q-2 0-2-2V4q0-2 2-2Z"/><path transform="translate(30)" fill-rule="evenodd" d="M2 2h11c9 0 14 4 14 11 0 5-3 8-6 9l7 7q1 2-2 2h-5q-1 0-2-1l-7-8H9v7q0 2-2 2H2q-2 0-2-2V4q0-2 2-2Zm7 7v8h5c4 0 5-1.5 5-4s-1-4-5-4Z"/><path transform="translate(62)" fill-rule="evenodd" d="m12 3 1-1h6l1 1 12 25q1 3-2 3h-5q-1.5 0-2-2l-2-4H10l-2 4q-.5 2-2 2H2q-3 0-2-3Zm1 15h6l-3-8Z"/><path transform="translate(99)" d="M2 2h6q1 0 2 2l7 12 7-12q1-2 2-2h6q2 0 2 2v25q0 2-2 2h-4q-2 0-2-2V16l-6 9q-1 2-3 2t-3-2l-6-9v13q0 2-2 2H2q-2 0-2-2V4q0-2 2-2Z"/><path transform="translate(138)" d="M2 2h21q2 0 2 2v3q0 2-2 2H9v5h12q2 0 2 2v2q0 2-2 2H9v4h14q2 0 2 2v3q0 2-2 2H2q-2 0-2-2V4q0-2 2-2Z"/>';
  const svg=(className='')=>'<svg xmlns="http://www.w3.org/2000/svg" class="v55-brand-mark '+F.e(className)+'" viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-ui55-brand><path transform="translate(-.5 -1.5)" fill="currentColor" stroke="none" fill-rule="evenodd" clip-rule="evenodd" d="'+path+'"/></svg>';
  const wordmark=()=>'<svg xmlns="http://www.w3.org/2000/svg" class="v55-brand-wordmark" viewBox="0 0 138 32" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><g transform="scale(.84 1)">'+wordPaths+'</g></svg>';
  const lockup=()=>'<span class="v55-brand-lockup" aria-hidden="true" data-ui55-lockup>'+svg()+wordmark()+'</span>';
  F.icon=function(name,className=''){
    return name==='frame'?svg(className):previousIcon.apply(this,arguments);
  };
  function brand(node,isLogin=false){
    if(!node.querySelector('[data-ui55-lockup]'))node.innerHTML=lockup();
    node.setAttribute('aria-label',isLogin?'FRAME':'FRAME 홈');
    if(isLogin)node.setAttribute('role','img');
  }
  if(previousHeader)F.header=function(...args){
    const host=document.createElement('div');host.innerHTML=previousHeader.apply(this,args);
    host.querySelectorAll('.app-header .brand').forEach(node=>brand(node));
    return host.innerHTML;
  };
  function refresh(){
    const scope=F.root;if(!scope)return;
    scope.querySelectorAll('.app-header .brand').forEach(node=>brand(node));
    scope.querySelectorAll('.v54-login-form-brand').forEach(node=>brand(node,true));
  }
  F.v55Brand={svg,wordmark,lockup,refresh,asset:'./design-v55-brand.svg'};
  refresh();
})();
