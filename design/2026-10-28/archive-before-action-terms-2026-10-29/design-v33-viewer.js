/* Viewer prototype flows. Media renderers, quality controls and media values are retained. */
(()=>{
  const F=window.F,e=F.e;
  const catalog=F.catalog,channel=F.channel,render=F.render,sidebar=F.sidebar,header=F.header,chat=F.chat,share=F.modals.share,info=F.modals.info;
  const S=F.v33Viewer={following:new Set([0,1,2,3]),history:new Set([0,1,2]),read:new Set(),reminders:new Set(),sort:{},record:null};
  const chosen=()=>Number.isInteger(F.selectedBroadcast)?F.selectedBroadcast:0;
  const cardIndex=node=>Number(node.querySelector('[data-broadcast]')?.dataset.broadcast||0);
  const action=(label,name,icon='',cls='',attrs='')=>F.btn(label,'v33-viewer-'+name,icon,cls,attrs);
  const normal=state=>['기본','방송 중'].includes(state);
  F.sidebar=active=>{
    const groups={scenes:'studio',integrations:'studio',reports:'moderation','missions-manage':'moderation','polls-manage':'moderation','rewards-manage':'moderation',members:'revenue'};
    if(['service-health','service-reports','audit','verification','developer'].includes(active))return `<aside class="sidebar v3-sidebar"><div class="v3-side-context"><span><strong>운영 관리</strong></span></div>${[['service-health','서비스 상태','chart'],['service-reports','서비스 신고','shield'],['audit','활동 기록','history'],['developer','개발자 설정','gear'],['verification','기술 검증','check']].map(([id,label,icon])=>F.go(id,`<span class="nav-label">${label}</span>`,icon,id===active?'nav-active':'')).join('')}<div class="sidebar-bottom">${F.go('live','<span class="nav-label">홈으로</span>','arrow')}</div></aside>`;
    const base=groups[active]||active;
    const h=document.createElement('div');h.innerHTML=sidebar(base);
    const subgroups={studio:[['scenes','장면 관리'],['integrations','외부 도구 연결']],moderation:[['reports','신고 관리'],['missions-manage','미션 관리'],['polls-manage','투표 및 질문'],['rewards-manage','포인트 및 보상']],revenue:[['members','멤버십 관리']]};
    if(subgroups[base]){
      const parent=h.querySelector(`.sidebar [data-go="${base}"]`);
      if(parent){
        parent.setAttribute('aria-expanded','true');if(active!==base)parent.classList.remove('nav-active');
        parent.insertAdjacentHTML('afterend',`<nav class="v33-side-subnav" aria-label="${base==='studio'?'방송 도구':base==='moderation'?'커뮤니티 관리':'수익 관리'}">${subgroups[base].map(([id,label])=>F.go(id,`<span class="nav-label">${label}</span>`,'',id===active?'nav-active':'')).join('')}</nav>`);
      }
    }
    const group=h.querySelector('.followed-navigation');
    if(group){
      if(!S.following.size)group.remove();
      else group.innerHTML=`<div class="side-heading">팔로우한 채널</div>${[...S.following].map(index=>{const b=F.broadcasts[index];return b?`<button type="button" class="side-channel" data-go="channel" data-broadcast="${index}">${F.avatar(b.initial,'round')}<span class="side-channel-name">${e(b.name)}</span><span class="channel-live-dot" aria-label="방송 중"></span></button>`:'';}).join('')}`;
    }
    return h.innerHTML;
  };
  F.header=()=>{
    const h=document.createElement('div');h.innerHTML=header();
    const settings=h.querySelector('.v3-profile-menu [data-go="profile"]');
    settings?.insertAdjacentHTML('afterend',F.go('transactions','결제 내역','wallet'));
    return h.innerHTML;
  };
  F.catalog=(id,state)=>{
    const h=document.createElement('div');h.innerHTML=catalog(id,state);
    const page=h.querySelector('.v3-catalog');if(!page)return h.innerHTML;
    page.classList.add('v33-viewer-catalog');page.dataset.catalog=id;
    const grid=page.querySelector('.v3-grid:not(.v3-resume-grid)');
    if(id==='following'&&normal(state)){
      if(!F.sessionLoggedIn)return `<div class="v3-catalog v33-viewer-catalog"><div class="v3-section-heading"><h1>팔로잉</h1></div>${F.empty('로그인하고 팔로우한 방송을 만나보세요')}</div>`;
      grid?.querySelectorAll('.broadcast-card').forEach(node=>{if(!S.following.has(cardIndex(node)))node.remove();});
      if(!grid?.children.length)grid?.replaceWith(document.createRange().createContextualFragment(F.empty('팔로우한 채널이 없어요')));
    }
    if(id==='live'&&normal(state)&&grid&&!grid.children.length){
      grid.innerHTML=F.empty('이 카테고리에는 방송이 없어요','','전체 방송 보기','v33-viewer-clear-filter','live');
    }
    if(id==='history'){
      page.querySelector('.v3-section-heading')?.insertAdjacentHTML('beforeend',action('기록 삭제','clear-history','trash','ghost',S.history.size&&normal(state)?'':'disabled'));
      if(normal(state)&&grid){
        grid.querySelectorAll('.broadcast-card').forEach(node=>{
          const index=cardIndex(node);if(!S.history.has(index)){node.remove();return;}
          node.classList.add('v33-history-card');
          const b=F.broadcasts[index];node.insertAdjacentHTML('beforeend',action('','remove-history','close','v33-history-remove',`data-index="${index}" aria-label="${e(b.title)} 시청 기록 삭제" title="시청 기록 삭제"`));
        });
        if(!grid.children.length)grid.innerHTML=F.empty('아직 시청 기록이 없어요');
      }
    }
    if(['vod','clips','recommendations'].includes(id)){
      const sort=page.querySelector('.v3-sort');
      if(sort){sort.dataset.action='v33-viewer-sort';sort.dataset.catalog=id;sort.innerHTML=`${e(S.sort[id]||'최신순')}${F.icon('chevron')}`;sort.setAttribute('aria-label',`${id==='clips'?'클립':id==='vod'?'다시보기':'추천 방송'} 정렬`);}
      if(grid&&S.sort[id]==='인기순'){
        [...grid.children].sort((a,b)=>(F.broadcasts[cardIndex(b)]?.viewers||0)-(F.broadcasts[cardIndex(a)]?.viewers||0)).forEach(node=>grid.append(node));
      }
    }
    return h.innerHTML;
  };
  F.channel=state=>{
    const h=document.createElement('div');h.innerHTML=channel(state);
    const titles={code:['작은 기능 하나씩 완성하기','함께 만드는 화면, 첫 번째 테스트','작업실 정리와 다음 목표'],design:['빛과 색을 담는 드로잉','새로운 브러시로 그려보는 오후','한 장의 그림이 완성되기까지'],night:['비 오는 도시의 밤','음악과 함께 달리는 길','차분한 저녁 플레이리스트'],game:['새로운 지역을 찾아서','함께 도전하는 오늘의 목표','모험을 마치고 돌아오는 길']};
    const list=titles[(F.broadcasts[chosen()]||F.broadcasts[0]).scene]||titles.code;
    h.querySelectorAll('.v2-recent .broadcast-card,.search-section .broadcast-card').forEach((card,index)=>{
      const title=list[index%list.length];const button=card.querySelector('.card-title');if(button)button.textContent=title;
      card.querySelector('.thumb')?.setAttribute('aria-label',title+' 재생하기');
      card.querySelectorAll('[data-go="vod-watch"],[data-go="clip-watch"]').forEach(node=>node.dataset.recordTitle=title);
      const meta=card.querySelector('.card-category');if(meta)meta.textContent=`조회 ${[1284,846,593][index%3].toLocaleString()}회 · ${[2,5,9][index%3]}일 전`;
    });
    h.querySelectorAll('[data-action="v2-remind"]').forEach((button,index)=>{
      const key=`${chosen()}:${index}`,on=S.reminders.has(key);
      button.dataset.action='v33-viewer-remind';button.dataset.reminder=key;
      button.setAttribute('aria-pressed',String(on));button.innerHTML=F.icon(on?'check':'bell')+(on?'알림 취소':'알림 받기');
    });
    return h.innerHTML;
  };
  const alerts=[
    {index:0,kind:'watch',title:'개발하는 봄 님이 방송을 시작했어요.',detail:'조용히 개발해요. 오늘은 플레이어 마무리하는 날',time:'지금'},
    {index:1,kind:'vod-watch',title:'서재 님이 다시보기를 공개했어요.',detail:'그림 그리면서 이야기해요, 봄의 색을 담는 오후',time:'1시간 전'},
    {index:3,kind:'channel',title:'초록 님의 방송이 곧 시작돼요.',detail:'오늘 오후 8시',time:'2시간 전'}
  ];
  F.pages.notifications=state=>{
    if(!F.sessionLoggedIn)return F.page('알림',F.empty('알림을 보려면 로그인하세요','','로그인','go:login','user'));
    return F.page('알림',state==='알림 없음'?F.empty('새로운 알림이 없어요'): `<div class="v33-notification-list">${alerts.map((item,index)=>`<button type="button" class="v33-notification${S.read.has(index)?' is-read':''}" data-action="v33-viewer-notification" data-index="${index}" aria-label="${e(item.title)} ${S.read.has(index)?'읽음':'읽지 않음'}">${F.avatar(F.broadcasts[item.index].initial,'round')}<span class="v33-notification-copy"><strong>${e(item.title)}</strong><span>${e(item.detail)}</span><time>${e(item.time)}</time></span>${S.read.has(index)?'':'<i class="v33-unread" aria-hidden="true"></i>'}${F.icon('right')}</button>`).join('')}</div>`,action('모두 읽음','read-all','','ghost',S.read.size===alerts.length||state==='알림 없음'?'disabled':''));
  };
  F.modals.share=state=>{
    const config=share(state),h=document.createElement('div');h.innerHTML=config.body;
    const input=h.querySelector('#share-link'),choice=h.querySelector('[data-key="share-option"]');
    if(input&&choice){
      const value=F.values['share-option']||'현재 방송';choice.querySelector('span').textContent=value;
      if(value==='현재 재생 시점부터'){const seconds=Number(F.root.querySelector('#timeline')?.value||0);if(seconds>0){const url=new URL(input.value);url.searchParams.set('t',String(Math.round(seconds)));input.value=url.toString();input.setAttribute('value',input.value);}}
    }
    if(S.record?.index===chosen()&&['vod-watch','clip-watch'].includes(F.currentBase))h.querySelector('.v31-share-summary strong').textContent=S.record.title;
    config.body=h.innerHTML;return config;
  };
  F.modals.info=state=>{
    const config=info(state);
    if(S.record?.index===chosen()&&['vod-watch','clip-watch'].includes(F.currentBase)){const h=document.createElement('div');h.innerHTML=config.body;const title=h.querySelector('.v31-viewer-info-content>h3');if(title)title.textContent=S.record.title;config.body=h.innerHTML;}
    return config;
  };
  F.chat=()=>{
    const html=chat();if(F.sessionLoggedIn)return html;
    const h=document.createElement('div');h.innerHTML=html;
    const form=h.querySelector('.chat-form');
    if(form)form.outerHTML=`<div class="v33-chat-login">${F.go('login','로그인하고 채팅하기','user','primary')}</div>`;
    return h.innerHTML;
  };
  function refreshFollow(){
    const on=S.following.has(chosen());
    F.root.querySelectorAll('[data-action="follow"]').forEach(button=>{
      button.dataset.action='v33-viewer-follow';button.classList.toggle('primary',!on);button.setAttribute('aria-pressed',String(on));button.innerHTML=F.icon(on?'check':'heart')+(on?'팔로잉':'팔로우');
    });
    F.root.querySelectorAll('[data-action="v33-viewer-follow"]').forEach(button=>{
      button.classList.toggle('primary',!on);button.setAttribute('aria-pressed',String(on));button.innerHTML=F.icon(on?'check':'heart')+(on?'팔로잉':'팔로우');
    });
  }
  F.render=()=>{render();refreshFollow();if(S.record?.index===chosen()&&['vod-watch','clip-watch'].includes(F.currentBase)){const heading=F.root.querySelector('.v3-watch-meta h1');if(heading)heading.textContent=S.record.title;}};
  document.addEventListener('click',async event=>{
    const button=event.target.closest?.('button');if(!button)return;
    if(['watch','vod-watch','clip-watch'].includes(button.dataset.go))S.record=button.dataset.recordTitle?{index:Number(button.dataset.broadcast||0),title:button.dataset.recordTitle}:null;
    const name=button.dataset.action||'';
    if(name==='copy-link'){
      event.preventDefault();event.stopImmediatePropagation();const input=F.dialog.querySelector('#share-link');if(!input)return;
      try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(input.value);F.setState('복사 완료');}
      catch{input.focus();input.select();F.toast('주소를 선택했어요. 복사해 주세요.');}
      return;
    }
    if(button.dataset.key==='share-option'&&button.hasAttribute('data-choices')){
      event.preventDefault();event.stopImmediatePropagation();
      F.openChoice(button,['현재 방송','현재 재생 시점부터'],F.values['share-option']||'현재 방송',value=>{
        F.values['share-option']=value;button.querySelector('span').textContent=value;
        const input=F.dialog.querySelector('#share-link');if(!input)return;
        const url=new URL(input.value);url.searchParams.delete('t');
        if(value==='현재 재생 시점부터'){
          const seconds=Number(F.root.querySelector('#timeline')?.value||0);if(seconds>0)url.searchParams.set('t',String(Math.round(seconds)));
        }
        input.value=url.toString();F.dialog.querySelector('[data-action="copy-link"]').textContent='복사';
      });return;
    }
    if(!name.startsWith('v33-viewer-'))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(name==='v33-viewer-follow'){
      if(!F.sessionLoggedIn){F.authReturn=F.screen;F.navigate('login');return;}
      S.following.has(chosen())?S.following.delete(chosen()):S.following.add(chosen());refreshFollow();
      const side=F.root.querySelector('.sidebar');if(side){const h=document.createElement('div');h.innerHTML=F.sidebar(F.currentBase);side.replaceWith(h.firstElementChild);}
    }else if(name==='v33-viewer-clear-filter'){F.v2Category='전체';F.render();}
    else if(name==='v33-viewer-sort')F.openChoice(button,['최신순','인기순'],S.sort[button.dataset.catalog]||'최신순',value=>{S.sort[button.dataset.catalog]=value;F.render();F.root.querySelector('[data-action="v33-viewer-sort"]')?.focus({preventScroll:true});});
    else if(name==='v33-viewer-remind'){
      const key=button.dataset.reminder;S.reminders.has(key)?S.reminders.delete(key):S.reminders.add(key);const on=S.reminders.has(key);button.setAttribute('aria-pressed',String(on));button.innerHTML=F.icon(on?'check':'bell')+(on?'알림 취소':'알림 받기');
    }else if(name==='v33-viewer-read-all'){alerts.forEach((_,index)=>S.read.add(index));F.render();F.root.querySelector('h1')?.focus({preventScroll:true});}
    else if(name==='v33-viewer-notification'){
      const index=Number(button.dataset.index),item=alerts[index];if(!item)return;S.read.add(index);F.selectedBroadcast=item.index;if(item.kind==='channel')F.channelTab='방송 일정';F.navigate(item.kind);
    }else if(name==='v33-viewer-remove-history'){S.history.delete(Number(button.dataset.index));F.render();F.root.querySelector('[data-action="v33-viewer-clear-history"]')?.focus({preventScroll:true});}
    else if(name==='v33-viewer-clear-history'){
      F.genericDialog('시청 기록을 삭제할까요?','<p class="v33-confirm-copy">이 기기에 표시된 시청 기록이 삭제돼요.</p>','기록 삭제');
      const confirm=F.dialog.querySelector('[data-action="confirm-generic"]');confirm.dataset.action='v33-viewer-confirm-clear';confirm.classList.remove('primary');confirm.classList.add('danger');
    }else if(name==='v33-viewer-confirm-clear'){S.history.clear();F.closeModal();F.render();}
  },true);
  if(F.currentBase)F.render();
})();
