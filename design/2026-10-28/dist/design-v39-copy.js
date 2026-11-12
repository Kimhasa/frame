/* Exact, product-facing copy cleanup. No global help removal; protected media is excluded. */
(() => {
  'use strict';
  const F=window.F;
  if(!F?.render||F.v39Copy)return;
  const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
  const protectedSelector=[
    '.player','.preserved-player','#video-player','#studio-preview','.v3-studio-preview',
    '.locked-player-quality-menu','.locked-player-overlay','.locked-player-toolbar',
    '#review-bar','#review-outline','#review-dialog','textarea','input','select','button','label',
    '[contenteditable="true"]','.chat-line','.card-title','.channel-copy','.v38-channel-notice',
    '.v31-viewer-info-description','.v38-description','.v38-benefits','.v3-role-descriptions',
    '[role="alert"]','[aria-live="assertive"]','.has-error','.invalid','.v38-error',
    '.v3-inline-error','.v33-manage-inline-error','.inline-notice.error','.v38-inline-status'
  ].join(',');
  const excludedScreens=new Set(['quality','broadcast-settings','policy','verification']);
  const rules=[];
  const remove=(id,screens,selector,texts,source)=>rules.push({id,operation:'remove',screens,selector,texts,source});
  const replace=(id,screens,selector,texts,value,source)=>rules.push({id,operation:'replace',screens,selector,texts,value,source});
  remove('account-page-intro',['profile','preferences','security','channel-edit'],
    '.v3-page-heading p,.v3-section-heading>p',[
      '나에게 맞는 이용 환경을 설정하세요.',
      '채팅과 채널에 표시되는 내 정보를 관리하세요.',
      '로그인에 사용할 계정을 관리하세요.',
      '내 계정의 로그인 상태를 확인하세요.',
      '방송을 시청하는 방식을 선택하세요.',
      '받고 싶은 소식만 선택하세요.',
      '시청자가 만나는 내 채널을 꾸며보세요.'
    ],'design-v3-account.js:37-82; v31/v32에서 이미 제거된 경우 그대로 유지');
  remove('account-branding-intro',['channel-edit'],
    '.v3-branding-block .v3-subsection-title p,.v3-permissions>.v3-subsection-title p',[
      '채널과 채팅에서 나를 보여주는 이미지예요.',
      '채널 상단에 표시돼요.',
      '역할에 따라 관리할 수 있는 범위가 달라요.'
    ],'design-v3-account.js:79-80; 구체 역할별 권한 설명은 유지');
  remove('login-repeated-intro',['login'],'.v3-login-title>p,.v3-login-welcome>p',[
      '계정 정보를 입력해 주세요.',
      'FRAME에서 사용할 프로필을 확인해 주세요.',
      '좋아하는 채널과 함께하는 시간을 이어가세요.',
      '어디에서든 이어지는 라이브와 이야기.'
    ],'design-v3-account.js:65-68; 약관·개인정보 동의 영역은 제외');
  remove('studio-page-intro',['studio'],'.v3-studio-heading-copy>p',[
      '화면을 선택하고, 오늘의 방송을 시작하세요.',
      '방송 화면과 시청자 반응을 한곳에서 확인하세요.'
    ],'design-v3-studio.js:48; 공개 범위·중단·저장 영향 안내는 유지');
  remove('studio-context-repeat',['studio'],'.v3-studio-eyebrow',
    ['크리에이터 스튜디오'],'design-v3-studio.js:48; 같은 화면의 방송 준비/방송 중 제목 유지');
  remove('channel-static-tagline',['channel'],'.v2-channel-cover>span',
    ['작은 진전을, 함께.'],'design-v2-flows.js:63; 사용자 소개·공지·배너 이미지는 유지');
  remove('following-empty-repeat',['following'],'.v31-empty>p',[
      '팔로우한 채널의 방송을 한곳에서 볼 수 있어요.',
      '마음에 드는 채널을 팔로우하고 새 방송을 만나보세요.'
    ],'design-v31-states.js:6,9; 빈 상태 제목과 로그인/둘러보기 동작 유지');
  remove('search-obvious-instructions',['search'],
    '.v31-search-intro .v31-empty>p,.v31-empty.v31-empty-search>p,.v3-search-intro>p',[
      '방송 제목이나 채널 이름으로 검색해 보세요.',
      '검색어의 철자를 확인하거나 다른 단어로 검색해 보세요.'
    ],'design-v31-states.js:10-11; 검색 입력·검색어 수정·조건 초기화 유지');
  remove('recommendation-empty-repeat',['recommendations'],'.v31-empty>p',
    ['라이브 목록에서 먼저 마음에 드는 방송을 찾아보세요.'],
    'design-v31-states.js:15; 같은 의미의 라이브 둘러보기 버튼 유지');
  remove('preference-obvious-descriptions',['preferences'],
    '.v3-setting>div>p',[
      '마지막으로 본 위치에서 다시 시작해요.',
      '방송을 시청할 때 채팅을 함께 표시해요.',
      '내 콘텐츠에 새로운 반응이 있으면 알려드려요.',
      '새로운 기능과 서비스 소식을 알려드려요.'
    ],'design-v3-account.js:57-58; 자동 재생·멘션 범위·움직임 줄이기 설명은 유지');
  remove('channel-notifications-location-repeat',['preferences'],
    '.v3-notification-foot>span',
    ['채널별 방송 알림은 팔로잉에서 설정할 수 있어요.'],
    'design-v3-account.js:58; 채널별 알림 설정 버튼 유지');
  replace('nickname-limit-compact',['profile','nickname'],
    '#v3-profile-nickname-help,#v34-chat-name-help',
    ['1~20자 이내로 입력하세요.','채팅에 표시할 닉네임을 1~20자로 입력하세요.'],
    '1–20자','design-v3-account.js:42 / design-v34-chat.js; 입력 오류는 제외');
  replace('security-provider-location',['profile','preferences','security'],
    '.v38-account>p',
    ['비밀번호 변경과 2단계 인증은 로그인 제공자에서 설정합니다.'],
    '비밀번호·2단계 인증은 로그인 제공자에서 설정해요.',
    'design-v38-account.js:44; 설정 위치라는 필요한 정보는 유지');
  remove('video-preview-placeholder',['donate'],'.v38-preview',
    ['선택한 영상과 시작 시점을 확인하세요.'],
    'design-v38-engagement.js:137; 바로 위의 영상 주소·시작 시점 요약은 유지');
  remove('prototype-implementation-notes',['*'],
    '.help,.hint,.field-help,.v38-help',[
      '본 화면은 디자인 시안입니다.',
      '디자인 시안입니다.',
      '본 화면은 시안입니다.',
      '디자인 검토용 화면입니다.',
      '데모 화면입니다.',
      '시안에서는 실제 결제가 진행되지 않아요.',
      '실제 결제는 진행되지 않아요.',
      '실제 API는 연결되지 않았어요.',
      '실제 API와 연결되지 않았어요.',
      '실제 서비스와 연결되지 않습니다.',
      '로컬 시안에서만 동작합니다.',
      '실제 등록은 본인 확인과 금융 정보 보호가 연결된 별도 절차에서 진행해야 합니다.'
    ],'기존 제품 도움말에 들어간 정확한 구현 안내만 제거. 검토 도구/정책 본문/보호 구역은 제외');
  const quietToasts=new Set([
    '변경사항을 저장했어요.','변경 사항을 저장했어요.','설정을 저장했어요.',
    '방송 정보를 저장했어요.','방송 설정을 저장했어요.','프로필을 저장했어요.',
    '닉네임을 저장했어요.','변경 내용을 저장했어요.'
  ].map(normalize));
  const S=F.v39Copy={rules,quietToasts,disabled:false,stats:{removed:0,shortened:0,quietToasts:0,byRule:{}}};
  function protectedNode(node,scope,operation){
    if(!node?.isConnected||node.closest(protectedSelector)||node.childElementCount)return true;
    if(node.id){
      const escaped=window.CSS?.escape?CSS.escape(node.id):node.id.replace(/[^a-z0-9_-]/gi,'');
      if(scope.querySelector('[aria-describedby~="'+escaped+'"]')&&operation==='remove')return true;
      if(scope.querySelector('[aria-invalid="true"][aria-describedby~="'+escaped+'"]'))return true;
    }
    return false;
  }
  function compact(parent){
    if(parent?.matches('.v3-page-heading>div,.v3-section-heading,.v3-studio-heading-copy,.v3-login-title,.v3-subsection-title>div')
      &&!parent.querySelector(':scope>p'))parent.classList.add('v39-copy-heading');
  }
  function polish(){
    if(S.disabled)return;
    for(const scope of [F.root,F.dialog]){
      if(!scope)continue;
      const screen=scope===F.dialog?F.screen:F.currentBase||F.screen;
      if(excludedScreens.has(screen))continue;
      for(const rule of rules){
        if(!rule.screens.includes('*')&&!rule.screens.includes(screen))continue;
        const exact=new Set(rule.texts.map(normalize));
        scope.querySelectorAll(rule.selector).forEach(node=>{
          if(protectedNode(node,scope,rule.operation)||!exact.has(normalize(node.textContent)))return;
          if(rule.operation==='replace'){
            if(node.textContent===rule.value)return;node.textContent=rule.value;S.stats.shortened++;
          }else{const parent=node.parentElement;node.remove();compact(parent);S.stats.removed++;}
          S.stats.byRule[rule.id]=(S.stats.byRule[rule.id]||0)+1;
        });
      }
    }
  }
  let queued=false;
  function schedule(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;polish();});}
  for(const key of ['render','renderModal','genericDialog']){
    const previous=F[key];if(typeof previous!=='function')continue;
    F[key]=function(...args){const result=previous.apply(this,args);schedule();return result;};
  }
  if(typeof F.toast==='function'){
    const previous=F.toast;
    F.toast=function(message,...args){
      if(!S.disabled&&!excludedScreens.has(F.screen)&&!F.review?.open&&quietToasts.has(normalize(message))){
        S.stats.quietToasts++;return previous.call(this,'저장했어요.',...args);
      }
      return previous.call(this,message,...args);
    };
  }
  Object.assign(S,{polish,schedule});
  polish();
})();

