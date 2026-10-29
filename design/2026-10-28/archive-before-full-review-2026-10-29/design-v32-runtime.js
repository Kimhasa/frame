/* Settings section URLs are view state only; no account API calls. */
(()=>{
  const readUrl=F.readUrl,writeUrl=F.writeUrl,navigate=F.navigate,genericDialog=F.genericDialog,render=F.render;
  const sections={profile:{profile:'프로필'},security:{account:'계정 연결',security:'보안 및 기기'},preferences:{notifications:'알림',playback:'재생'}};
  const defaults={profile:'profile',security:'account',preferences:'notifications'};
  const normalizeSection=()=>{if(F.screen==='preferences'&&F.viewState==='알림 차단')F.accountDesign.section='알림';if(F.screen==='security'&&F.viewState==='재인증 필요')F.accountDesign.section='보안 및 기기';};
  const applyLocation=()=>{
    const allowed=sections[F.screen];if(!allowed)return;
    const key=new URLSearchParams(location.search).get('section');
    F.accountDesign.section=allowed[key]||allowed[defaults[F.screen]];
    normalizeSection();
  };
  F.readUrl=()=>{F.v32SettingsDialog=null;readUrl();applyLocation();};
  F.writeUrl=replace=>{
    normalizeSection();
    const allowed=sections[F.screen];let section;
    if(allowed){section=Object.keys(allowed).find(key=>allowed[key]===F.accountDesign.section)||defaults[F.screen];F.accountDesign.section=allowed[section];}
    writeUrl(replace);
    const url=new URL(location.href);if(section)url.searchParams.set('section',section);else url.searchParams.delete('section');
    try{history.replaceState({},'',url);}catch{}
  };
  F.genericDialog=(...args)=>{
    F.v32SettingsDialog=sections[F.screen]?{screen:F.screen,state:F.viewState,section:F.accountDesign.section}:null;
    return genericDialog(...args);
  };
  F.navigate=(id,state,replace=false)=>{
    const context=F.v32SettingsDialog;
    if(context&&!F.modalScreens.has(id)){
      if(id===context.screen&&!state){state=context.state;F.accountDesign.section=context.section;}
      F.v32SettingsDialog=null;
    }
    return navigate(id,state,replace);
  };
  const revealSelected=()=>{
    const nav=F.root.querySelector('.v32-settings .v3-settings-nav'),selected=nav?.querySelector('[aria-selected="true"]');
    if(!selected||nav.scrollWidth<=nav.clientWidth)return;
    const n=nav.getBoundingClientRect(),s=selected.getBoundingClientRect();
    if(s.left<n.left)nav.scrollLeft-=n.left-s.left;else if(s.right>n.right)nav.scrollLeft+=s.right-n.right;
  };
  F.render=()=>{render();revealSelected();};
  window.addEventListener('resize',()=>requestAnimationFrame(revealSelected),{passive:true});
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  applyLocation();F.writeUrl(true);F.render();
})();
