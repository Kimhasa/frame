/* Management design flows only. No network, payment, installer, security or media operations. */
(() => {
  const F = window.F;
  if (!F?.pages) return;
  const ids = ['recordings','schedule','scenes','moderation','reports','creator-stats','revenue','transactions','integrations','missions-manage','polls-manage','rewards-manage','members','service-health','service-reports','audit','policy','update','developer','verification'];
  const owned = new Set(ids), original = {}, e = F.e;
  const S = F.managementDesign = {
    tabs:{}, changed:{}, toggles:{}, period:'최근 7일', auditFilter:'전체 작업', scene:0,
    schedules:[{title:'함께 만드는 작은 기능',date:'2026-10-29',time:'20:00'},{title:'한 주의 작업 정리',date:'2026-10-31',time:'15:00'}],
    scenes:['기본 화면'], sources:[], moderators:['모아'], blocked:['사용자 012'], removedMessages:false,pinned:false, bannedWords:'',slowInterval:5,
    reports:{reports:[{who:'사용자 012',reason:'도배 및 광고',date:'10.28 14:25',status:'검토 대기'},{who:'사용자 008',reason:'부적절한 표현',date:'10.27 18:42',status:'처리 완료',decision:'경고',note:'반복 여부를 확인했습니다.'}], 'service-reports':[{who:'채널 004',reason:'콘텐츠 신고',date:'10.28 14:25',status:'검토 대기'},{who:'사용자 008',reason:'채팅 신고',date:'10.27 18:42',status:'검토 대기'}]},
    missions:[{title:'오늘의 기능 완성하기',user:'모아',type:'무료 미션',limit:'오늘 방송 종료 전',status:'접수'},{title:'제한 시간 안에 레벨 완료',user:'초록',type:'미션 후원 · 10,000원',limit:'30분',status:'접수'}],
    polls:[{question:'다음 작업은 무엇으로 할까요?',options:['화면 개선','새 기능','오류 수정'],duration:'5분',open:true}],
    rewards:[{name:'다음 작업 제안',points:1000,limit:'방송당 1회'},{name:'화면 테마 고르기',points:2000,limit:'무제한'}],
    benefits:'멤버십 배지\n전용 이모티콘\n멤버십 방송', refund:null, bot:{command:'!방송',answer:'오늘도 함께해 주셔서 감사합니다.'}, webhook:{url:'',event:'방송 시작·종료'}, key:false
  };
  let modal = null, returnFocus = null;
  const b = (text, action, extra='', cls='') => F.btn(text,'v33-manage-'+action,'',cls,extra);
  const input = (name,value='',attrs='') => `<input name="${e(name)}" value="${e(value)}" ${attrs}>`;
  const field = (label,name,value='',attrs='') => `<div class="field"><label for="v33-manage-${e(name)}">${e(label)}</label>${input(name,value,`id="v33-manage-${e(name)}" ${attrs}`)}</div>`;
  const text = (label,name,value='',attrs='') => `<div class="field"><label for="v33-manage-${e(name)}">${e(label)}</label><textarea id="v33-manage-${e(name)}" name="${e(name)}" rows="3" ${attrs}>${e(value)}</textarea></div>`;
  const choice = (label,name,value,options) => `<div class="field"><label for="v33-manage-${e(name)}">${e(label)}</label><button type="button" id="v33-manage-${e(name)}" class="choice-button" data-action="v33-manage-choice" data-field="${e(name)}" data-options="${e(JSON.stringify(options))}" aria-label="${e(label)}" aria-haspopup="listbox" aria-expanded="false"><span>${e(value)}</span>${F.icon('chevron')}</button><input type="hidden" name="${e(name)}" value="${e(value)}"></div>`;
  const tabs = (id,labels,first=labels[0]) => `<div class="page-tabs v33-manage-tabs" role="tablist" aria-label="${e(F.data.screens.find(x=>x.id===id)?.name||'메뉴')}">${labels.map(label=>`<button type="button" role="tab" aria-selected="${(S.tabs[id]||first)===label}" class="${(S.tabs[id]||first)===label?'active':''}" data-action="v33-manage-tab" data-tab="${e(label)}" data-screen="${id}">${e(label)}</button>`).join('')}</div>`;
  const empty = (title,action='',label='') => `<div class="v33-manage-empty">${F.icon('folder')}<h2>${e(title)}</h2>${action?b(label,action,'','primary'):''}</div>`;
  const panel = (title,body,actions='') => `<section class="v33-manage-section"><div class="v33-manage-section-head"><h2>${e(title)}</h2>${actions}</div>${body}</section>`;
  const page = (title,body,actions='') => F.page(title,body,actions);
  const table = (headers,rows) => F.table(headers,rows);
  const badge = state => F.pill(state,state==='검토 대기'||state==='접수'?'orange':'green');
  const toggle = (name,key,on=true,help='') => F.setting(name,help,`<button type="button" class="switch" role="switch" aria-label="${e(name)}" aria-checked="${S.toggles[key]??on}" data-action="v33-manage-toggle" data-key="${key}"><span class="switch-track"></span></button>`);
  const redraw = (focusSelector='') => {F.render();if(focusSelector)F.root.querySelector(focusSelector)?.focus({preventScroll:true});};
  function show(title,body,submit='',label='저장',data={}) {
    returnFocus=document.activeElement;
    modal={screen:F.screen,state:F.viewState,...data};
    F.genericDialog(title,`<form id="v33-manage-form" data-submit="${e(submit)}" novalidate>${body}<p id="v33-manage-form-error" class="v33-manage-form-error" role="alert" hidden></p></form>`,label);
    F.dialog.classList.add('v33-manage-dialog');
    const footer=F.dialog.querySelector('.modal-footer');
    footer.innerHTML = submit ? `${b('취소','close')}<button type="submit" class="primary" form="v33-manage-form">${e(label)}</button>` : b('닫기','close');
    F.dialog.querySelector('.modal-head [data-action="close-modal"]').dataset.action='v33-manage-close';
    F.labelControls(F.dialog);
    F.dialog.querySelector('input:not([readonly]),textarea,select,.modal-footer button')?.focus({preventScroll:true});
  }
  function close(redrawPage=false) {
    const context=modal;modal=null;F.closeDropdown();
    F.dialog.close();F.root.inert=false;document.querySelector('.modal-backdrop').hidden=true;
    if(context){F.screen=context.screen;F.viewState=context.state;F.currentBase=context.screen;F.writeUrl(true);}
    if(redrawPage)F.render();
    if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    else {const h=F.root.querySelector('.v33-management h1');h?.setAttribute('tabindex','-1');h?.focus({preventScroll:true});}
  }
  const error = (message,name) => {const p=F.dialog.querySelector('.v33-manage-form-error');p.hidden=false;p.textContent=message;p.dataset.field=name;const input=F.dialog.querySelector(`[name="${name}"]`),el=input?.type==='hidden'?F.dialog.querySelector(`[data-field="${name}"]`):input;el?.setAttribute('aria-invalid','true');el?.setAttribute('aria-describedby',p.id);el?.focus();};
  const pageError=(el,message)=>{if(!el)return;el.setAttribute('aria-invalid','true');const field=el.closest('.field');let p=field?.querySelector('.v33-manage-inline-error');if(!p&&field){p=document.createElement('p');p.className='v33-manage-inline-error';p.setAttribute('role','alert');field.append(p);}if(p){p.hidden=false;p.textContent=message;}el.focus();};
  function confirm(title,body,action,data={}) {show(title,`<p class="v33-manage-confirm-copy">${body}</p>`,action,'확인',data);}
  function decorate(html,id) {
    const host=document.createElement('div');host.innerHTML=html;
    const p=host.querySelector('.content-page')||host.firstElementChild;
    p?.classList.add('v33-management');if(p)p.dataset.manageScreen=id;
    host.querySelectorAll('.table-panel').forEach((wrap,i)=>{
      const t=wrap.querySelector('table');if(!t)return;
      const caption=document.createElement('caption');caption.className='sr-only';caption.textContent=(p?.querySelector('h1')?.textContent||'목록')+(i?' '+(i+1):'');t.prepend(caption);
      const labels=[...t.querySelectorAll('thead th')].map(x=>x.textContent);
      t.querySelectorAll('tbody tr').forEach(row=>[...row.children].forEach((cell,j)=>cell.dataset.label=labels[j]));
      const footer=wrap.querySelector('.table-footer');if(footer)footer.innerHTML=`<span>${t.tBodies[0]?.rows.length||0}개</span>`;
    });
    host.querySelectorAll('.v33-manage-tabs button').forEach((tab,i)=>{tab.tabIndex=tab.getAttribute('aria-selected')==='true'?0:-1;});
    host.querySelectorAll('.inline-notice.error,.v33-manage-inline-error').forEach(node=>node.setAttribute('role','alert'));
    host.querySelectorAll('.chart-panel>svg').forEach(svg=>{const dates=[...svg.querySelectorAll('text')].map(node=>node.textContent);if(dates.length){const axis=document.createElement('div');axis.className='v33-manage-chart-axis';axis.innerHTML=dates.map(date=>`<span>${e(date)}</span>`).join('');svg.after(axis);}});
    host.querySelectorAll('[data-action="toggle"]').forEach(button=>{button.dataset.action='v33-manage-toggle';button.setAttribute('aria-label',button.closest('.setting-row')?.querySelector('strong')?.textContent||'설정');if(button.dataset.key in S.toggles)button.setAttribute('aria-checked',String(S.toggles[button.dataset.key]));});
    host.querySelectorAll('.setting-row+.setting-row').forEach(x=>x.classList.add('v33-manage-setting'));
    return host.innerHTML;
  }
  const custom = {
    schedule(state) {
      const past=S.tabs.schedule==='지난 예약';const rows=state==='예약 없음'&&!S.changed.schedule?[]:past?[]:S.schedules;
      return page('방송 예약',tabs('schedule',['예정된 방송','지난 예약'])+(rows.length?table(['방송 제목','시작 예정','알림','관리'],rows.map((r,i)=>[e(r.title),e(`${r.date} ${r.time}`),'켜짐',`<div class="row">${b('수정','schedule-edit',`data-index="${i}"`,'small')}${b('삭제','schedule-delete',`data-index="${i}"`,'small ghost')}</div>`])):empty(past?'지난 예약이 없어요':'예약된 방송이 없어요',past?'':'schedule-add',past?'':'예약 추가')),b('예약 추가','schedule-add','','primary'));
    },
    moderation(state) {
      const active=S.tabs.moderation||'설정';let body='';
      if(active==='설정')body=panel('채팅 설정',toggle('느린 채팅','slow',true)+field('전송 간격 (초)','slow-interval',S.slowInterval,'type="number" min="1" max="120" inputmode="numeric"')+toggle('팔로워 전용','followers-only',false)+toggle('링크 차단','links',true)+text('금칙어','banned-words',S.bannedWords,'placeholder="쉼표로 구분"')+`<div class="form-actions">${b('저장','moderation-save','','primary')}</div>`);
      if(active==='운영자'){const people=state==='운영자 없음'&&!S.changed.moderation?[]:S.moderators;body=people.length?table(['닉네임','역할','관리'],people.map((name,i)=>[e(name),'채팅 운영자',b('해제','moderator-remove',`data-index="${i}"`,'small')])):empty('등록된 운영자가 없어요');body+=`<div class="form-actions">${b('운영자 추가','moderator-add','','primary')}</div>`;}
      if(active==='차단 목록')body=S.blocked.length?table(['사용자','제한','관리'],S.blocked.map((name,i)=>[e(name),'채팅 참여 제한',b('해제','blocked-remove',`data-index="${i}"`,'small')])):empty('차단한 사용자가 없어요');
      if(active==='메시지 기록')body=S.removedMessages?empty('표시할 메시지가 없어요'):panel('최근 메시지',`<div class="v33-manage-message"><strong>파도</strong><p>오늘도 잘 보고 있어요.</p>${S.pinned?badge('고정됨'):''}</div><div class="form-actions">${b(S.pinned?'고정 해제':'메시지 고정','pin')}${b('삭제','message-delete','','ghost')}${b('참여 제한','message-restrict','','danger')}</div>`);
      return page('채팅 관리',tabs('moderation',['설정','운영자','차단 목록','메시지 기록'])+body);
    },
    reports(state,id='reports') {
      const rows=state==='신고 없음'?[]:S.reports[id];
      return page(id==='reports'?'신고 관리':'서비스 신고 관리',rows.length?table(['접수일','대상','사유','상태','관리'],rows.map((r,i)=>[e(r.date),e(r.who),e(r.reason),badge(r.status),b(r.status==='처리 완료'?'내역':'검토','report',`data-index="${i}" data-kind="${id}"`,'small')])):empty('검토할 신고가 없어요'));
    },
    'service-reports'(state){return custom.reports(state,'service-reports');},
    'missions-manage'(state) {
      const tab=S.tabs['missions-manage']||'접수';const rows=state==='미션 없음'?[]:S.missions.map((r,i)=>({...r,index:i})).filter(r=>r.status===tab);
      return page('미션 관리',tabs('missions-manage',['접수','진행 중','완료'])+(rows.length?table(['미션','제안자','유형','기한','관리'],rows.map(r=>[e(r.title),e(r.user),e(r.type),e(r.limit),b('상세','mission',`data-index="${r.index}"`,'small')])):empty(tab==='접수'?'접수된 미션이 없어요':tab==='진행 중'?'진행 중인 미션이 없어요':'완료된 미션이 없어요'))+panel('접수 설정',toggle('미션 접수','mission-open',true)+toggle('미션 후원','paid-mission',false,'결제가 포함된 제안을 받아요.')));
    },
    'polls-manage'(state) {
      const tab=S.tabs['polls-manage']||'투표';let body='';
      if(tab==='투표'){const polls=state==='진행 중 없음'&&!S.changed['polls-manage']?[]:S.polls;body=polls.length?polls.map((p,i)=>panel(p.question,`<div class="v33-manage-poll-options">${p.options.map((o,n)=>`<div><span>${e(o)}</span><strong>${[48,32,20][n]||0}%</strong></div>`).join('')}</div><div class="form-actions">${badge(p.open?'진행 중':'마감')}${p.open?b('투표 마감','poll-close',`data-index="${i}"`,'danger'):''}</div>`)).join(''):empty('진행 중인 투표가 없어요','poll-add','투표 만들기');}
      else body=empty(tab==='질문'?'접수된 질문이 없어요':'진행 중인 예측이 없어요');
      return page('투표 및 질문 관리',tabs('polls-manage',['투표','질문','예측'])+body,tab==='투표'?b('투표 만들기','poll-add','','primary'):'');
    },
    'rewards-manage'(state) {
      const rows=state==='보상 없음'&&!S.changed['rewards-manage']?[]:S.rewards;
      return page('포인트 및 보상',F.stats([['오늘 적립','12,400 P'],['오늘 사용','4,200 P']])+(rows.length?table(['보상','필요 포인트','교환 제한','관리'],rows.map((r,i)=>[e(r.name),r.points.toLocaleString('ko-KR')+' P',e(r.limit),b('수정','reward-edit',`data-index="${i}"`,'small')])):empty('등록된 보상이 없어요','reward-add','보상 추가'))+panel('적립 설정',toggle('시청 포인트 적립','earn-points',true)+toggle('출석 보상','attendance',true)),b('보상 추가','reward-add','','primary'));
    },
    integrations() {
      return page('외부 도구 연결',[
        ['monitor','방송 도구','OBS 등 외부 방송 도구를 연결해요.',F.go('connection','연결 정보','','small')],
        ['link','브라우저 오버레이','방송 도구에 추가할 위젯 주소예요.',b('주소 보기','overlay','','small')],
        ['chat','채팅봇','명령어와 자동 응답을 관리해요.',b('설정','bot','','small')],
        ['code','API 및 웹훅','외부 서비스의 이벤트 연동을 관리해요.',F.go('developer','개발자 설정','','small')]
      ].map(([ico,title,desc,action])=>`<div class="integration-card"><span class="app-icon">${F.icon(ico)}</span><div class="text"><h2>${title}</h2><p>${desc}</p></div>${action}</div>`).join(''));
    },
    audit(state) {
      const rows=[['10.28 14:32:12','운영자 A','채팅 참여 제한','사용자 012','성공'],['10.28 13:04:25','서비스 관리자','설정 변경','채팅 필터','성공'],['10.27 19:44:10','방송자','방송 종료','방송 128','성공']].filter(r=>S.auditFilter==='전체 작업'||r[2]===S.auditFilter);
      return page('활동 기록',state==='기록 없음'||!rows.length?empty('조건에 맞는 기록이 없어요','audit-reset','조건 초기화'):table(['일시','작업자','행동','대상','결과'],rows.map(r=>r.map((v,i)=>i===4?badge(v):e(v)))),b(e(S.auditFilter)+F.icon('chevron'),'audit-filter','','choice-button'));
    },
    policy() {
      const name=S.tabs.policy||'이용약관';
      return page('이용 및 콘텐츠 정책',tabs('policy',['이용약관','개인정보 처리방침','콘텐츠 정책'])+panel(name,'<div class="v33-manage-policy-pending"><h3>문서 준비 중</h3><p>서비스 운영 조건이 확정되면 게시됩니다.</p></div>')+(name==='콘텐츠 정책'?`<div class="form-actions">${F.go('report-content','권리 침해 신고')}</div>`:''));
    },
    developer(state) {
      return page('개발자 설정',panel('API 키',field('이름','key-name',S.key?.name||'방송 알림 연동')+choice('권한','key-scope',S.key?.scope||'방송 정보 읽기',['방송 정보 읽기','채팅 관리','통계 읽기'])+`<div class="v33-manage-key-status">${S.key?'발급된 키 1개':'발급된 키가 없어요.'}</div><div class="form-actions">${S.key?b('키 폐기','key-revoke','','danger'):b('키 발급','key-create','','primary')}</div>`)+panel('웹훅',field('수신 주소','webhook-url',S.webhook.url,'type="url" placeholder="https://example.test/webhook"')+choice('이벤트','webhook-event',S.webhook.event,['방송 시작·종료','후원 이벤트','채팅 이벤트'])+`<p class="v33-manage-inline-error" role="alert" hidden></p><div class="form-actions">${b('요청 미리보기','webhook-preview')}${b('저장','webhook-save','','primary')}</div>`));
    }
  };
  for(const id of ids){if(id==='update')continue;const render=F.pages[id];if(!render)continue;original[id]=render;F.pages[id]=state=>{
    let html=(custom[id]||render)(state);const host=document.createElement('div');host.innerHTML=html;
    if(id==='recordings'){
      host.querySelector('[data-action="open-folder"]')?.replaceWith((()=>{const x=document.createElement('div');x.innerHTML=b('저장 위치','recording-folder','','');return x.firstElementChild;})());
      host.querySelectorAll('[data-action="open-recording"]').forEach((x,i)=>{x.dataset.action='v33-manage-recording';x.dataset.index=i;x.textContent='파일 정보';});
      host.querySelectorAll('.help').forEach(x=>{if(x.textContent.includes('공개 다시보기와'))x.remove();});
    }
    if(id==='scenes'){
      host.querySelector('.toolbar-actions [data-action="add-scene"]').dataset.action='v33-manage-scene-add';
      const body=host.querySelector('.two-column');if(body){const nav=document.createElement('div');nav.innerHTML=`<div class="v33-manage-scene-list" aria-label="장면">${S.scenes.map((n,i)=>b(e(n),'scene-select',`data-index="${i}" aria-pressed="${S.scene===i}"`,S.scene===i?'selected':'')).join('')}</div>`;body.before(nav.firstElementChild);host.querySelector('.panel-title h2').textContent=S.scenes[S.scene];}
      host.querySelectorAll('[data-action="add-scene"],[data-action="add-source"]').forEach(x=>x.dataset.action='v33-manage-'+(x.dataset.action==='add-scene'?'scene-add':'source-add'));
      const sourcePanel=host.querySelector('.two-column>.form-panel');if(sourcePanel&&S.sources.length){const list=document.createElement('div');list.innerHTML=S.sources.map(x=>F.setting(x.name,x.type,b('삭제','source-delete',`data-index="${S.sources.indexOf(x)}"`,'small ghost'))).join('');sourcePanel.insertBefore(list,sourcePanel.querySelector('.form-actions'));}
    }
    if(id==='creator-stats'){
      host.querySelectorAll('[data-key="stats-period"],[data-key="period"]').forEach(x=>{x.removeAttribute('data-choices');x.dataset.action='v33-manage-stats-period';x.querySelector('span').textContent=S.period;});
      host.querySelector('.chart-head [data-action="v33-manage-stats-period"]')?.remove();
      if(S.period==='최근 30일'){host.querySelectorAll('.stat-tile strong').forEach((x,i)=>x.textContent=['1,126시간','82명','216명','164명'][i]);host.querySelectorAll('.chart-panel svg text').forEach((x,i)=>x.textContent=['09.29','10.04','10.09','10.14','10.19','10.24','10.28'][i]);}
    }
    if(id==='revenue'){
      const active=S.tabs.revenue||'수익 내역';const tab=host.querySelector('.page-tabs');if(tab){const x=document.createElement('div');x.innerHTML=tabs('revenue',['수익 내역','정산','광고·스폰서']);tab.replaceWith(x.firstElementChild);}
      if(active!=='수익 내역')host.querySelector('.table-panel')?.remove();
      if(active!=='정산')host.querySelector('.form-panel')?.remove();
      if(active==='광고·스폰서'){host.querySelector('.stats-grid')?.remove();host.querySelector('.form-panel')?.remove();host.querySelector('.content-page').insertAdjacentHTML('beforeend',empty('진행 중인 광고·스폰서 내역이 없어요'));}
      host.querySelector('[data-action="download"]')?.setAttribute('data-action','v33-manage-revenue-download');
      host.querySelector('[data-action="confirm"]')?.setAttribute('data-action','v33-manage-settlement');
      const register=host.querySelector('[data-action="v33-manage-settlement"]');if(register)register.textContent='등록 항목 보기';
    }
    if(id==='transactions'){
      host.querySelectorAll('[data-action="transaction-details"]').forEach(x=>x.dataset.action='v33-manage-transaction');
      host.querySelector('[data-action="refund"]')?.setAttribute('data-action','v33-manage-refund-inline');
      const cancel=host.querySelector('.form-actions [data-action="retry"]');if(cancel)cancel.dataset.action='v33-manage-refund-cancel';
      if(S.refund){host.querySelector('.content-page')?.insertAdjacentHTML('afterbegin',`<div class="inline-notice v33-manage-result" role="status">환불 요청 작성됨${b('요청 내용','refund-history','','small')}</div>`);}
    }
    if(id==='members'){
      if(state==='가입자 없음')host.querySelectorAll('.stat-tile strong').forEach((x,i)=>{if(i<3)x.textContent='0명';});
      host.querySelector('[data-action="save"]')?.setAttribute('data-action','v33-manage-benefits');
    }
    if(id==='service-health'){host.querySelector('[data-key="period"]')?.remove();host.querySelector('.toolbar-actions [data-go="verification"]')?.setAttribute('title','설계 검증 자료');}
    if(id==='verification'){host.querySelector('.toolbar h1').textContent='설계 검증 자료';host.querySelectorAll('.form-panel .help').forEach(x=>x.textContent='실제 장비와 서비스에서 별도로 검증해야 합니다.');}
    return decorate(host.innerHTML,id);
  };}

  if(F.modals?.update){
    F.modals.update=state=>({title:'앱 업데이트',cls:'v33-manage-update',body:state==='최신 버전'?`<div class="modal-success"><span class="success-icon">${F.icon('check')}</span><h3>최신 버전을 사용 중이에요.</h3><p>현재 버전 0.7.0</p></div>`:state==='다운로드 중'?`<h3>버전 0.7.0</h3><div class="progress-track" role="progressbar" aria-label="업데이트 다운로드" aria-valuenow="58" aria-valuemin="0" aria-valuemax="100"><span style="width:58%"></span></div><p class="help">다운로드 58%</p><p class="help">설치는 방송이 종료된 후 진행할 수 있습니다.</p>`:`<h3>버전 0.7.0</h3><p class="help v33-manage-release-version">현재 버전 0.6.1</p><div class="v33-manage-release-notes"><h4>업데이트 내용</h4><p>연결 복구와 창 선택의 안정성을 개선했습니다.</p><p>설정과 녹화 파일은 유지됩니다.</p></div>`,footer:state==='최신 버전'?F.btn('닫기','close-modal'):state==='다운로드 중'?`${F.btn('닫기','close-modal')}${b('다운로드 취소','update-cancel','','')}`:`${F.btn('나중에','close-modal')}${b('업데이트 안내','update-info','','primary')}`});
  }

  function scheduleForm(index=-1){const r=S.schedules[index]||{title:'',date:'2026-10-29',time:'20:00'};show(index<0?'방송 예약 추가':'방송 예약 수정',field('방송 제목','title',r.title,'maxlength="100" required')+`<div class="field-pair">${field('날짜','date',r.date,'type="date" required')}${field('시간','time',r.time,'type="time" required')}</div>`,'schedule-save','저장',{index});}
  function rewardForm(index=-1){const r=S.rewards[index]||{name:'',points:1000,limit:'방송당 1회'};show(index<0?'보상 추가':'보상 수정',field('보상 이름','name',r.name,'maxlength="40" required')+field('필요 포인트','points',r.points,'type="number" min="1" max="1000000" inputmode="numeric" required')+choice('교환 제한','limit',r.limit,['방송당 1회','무제한']),'reward-save','저장',{index});}
  function report(index,kind){const r=S.reports[kind][index];show('신고 '+(r.status==='처리 완료'?'처리 내역':'검토'),F.dl([['대상',e(r.who)],['접수일',e(r.date)],['신고 사유',e(r.reason)]])+(r.status==='처리 완료'?F.dl([['조치',e(r.decision||'조치 없음')],['검토 메모',e(r.note||'—')]]):choice('조치','decision','선택',['선택','경고','일시 제한','차단','조치 없음'])+text('검토 메모','note','','maxlength="500"')),r.status==='처리 완료'?'':'report-save','처리 확인',{index,kind});}
  function downloadRevenue(){const csv='일시,구분,내용,금액,상태\n2026-10-28 14:32,후원,메시지 후원,5000,완료\n2026-10-27 18:10,멤버십,신규 가입,4900,완료\n';const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='frame-revenue-preview.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),0);}
  const handlers={
    close:()=>close(), tab:x=>{S.tabs[x.dataset.screen]=x.dataset.tab;redraw(`[data-tab="${x.dataset.tab}"]`);},
    choice:x=>F.openChoice(x,JSON.parse(x.dataset.options),x.querySelector('span').textContent,value=>{const input=x.parentElement.querySelector('input[type="hidden"]');input.value=value;x.querySelector('span').textContent=value;x.removeAttribute('aria-invalid');input.dispatchEvent(new Event('input',{bubbles:true}));}),
    toggle:x=>{const on=x.getAttribute('aria-checked')!=='true';S.toggles[x.dataset.key]=on;x.setAttribute('aria-checked',String(on));},
    'schedule-add':()=>scheduleForm(), 'schedule-edit':x=>scheduleForm(+x.dataset.index),
    'schedule-delete':x=>confirm('예약을 삭제할까요?',e(S.schedules[+x.dataset.index].title),'schedule-remove',{index:+x.dataset.index}),
    'moderator-add':()=>show('채팅 운영자 추가',field('닉네임','name','','maxlength="20" required'),'moderator-save','추가'),
    'moderator-remove':x=>confirm('운영자 권한을 해제할까요?',e(S.moderators[+x.dataset.index])+' 님은 채팅 관리 기능을 사용할 수 없게 됩니다.','moderator-remove',{index:+x.dataset.index}),
    'blocked-remove':x=>confirm('참여 제한을 해제할까요?',e(S.blocked[+x.dataset.index])+' 님이 다시 채팅에 참여할 수 있습니다.','blocked-remove',{index:+x.dataset.index}),
    'moderation-save':()=>{const interval=F.root.querySelector('[name="slow-interval"]'),n=Number(interval.value);if(!Number.isInteger(n)||n<1||n>120)return pageError(interval,'전송 간격은 1~120초로 입력하세요.');S.slowInterval=n;const v=F.root.querySelector('[name="banned-words"]');S.bannedWords=v.value.trim();const button=F.root.querySelector('[data-action="v33-manage-moderation-save"]');button.textContent='저장됨';button.disabled=true;},
    pin:()=>{S.pinned=!S.pinned;redraw('[data-action="v33-manage-pin"]');},
    'message-delete':()=>confirm('메시지를 삭제할까요?','파도 님의 메시지가 채팅에서 사라집니다.','message-delete'),
    'message-restrict':()=>show('채팅 참여 제한',choice('제한 시간','duration','10분',['10분','1시간','방송 종료까지'])+text('사유','reason','','maxlength="300"'),'message-restrict','제한'),
    report:x=>report(+x.dataset.index,x.dataset.kind),
    mission:x=>{const i=+x.dataset.index,r=S.missions[i];show('미션 상세',`<h3>${e(r.title)}</h3>`+F.dl([['제안자',e(r.user)],['유형',e(r.type)],['기한',e(r.limit)],['상태',badge(r.status)]]),r.status==='완료'?'':r.status==='접수'?'mission-accept':'mission-complete',r.status==='접수'?'수락':'완료 처리',{index:i});},
    'poll-add':()=>show('투표 만들기',field('질문','question','','maxlength="100" required')+text('선택지','options','','placeholder="선택지를 한 줄에 하나씩 입력" required')+choice('진행 시간','duration','5분',['1분','3분','5분','10분']),'poll-save','투표 시작'),
    'poll-close':x=>confirm('투표를 마감할까요?','마감하면 더 이상 투표할 수 없습니다.','poll-close',{index:+x.dataset.index}),
    'reward-add':()=>rewardForm(),'reward-edit':x=>rewardForm(+x.dataset.index),
    overlay:()=>show('브라우저 오버레이',field('위젯 주소','overlay-url','https://frame.example/overlay/spring','readonly')+`<div class="form-actions">${b('주소 복사','overlay-copy')}</div>`),
    'overlay-copy':()=>F.copy('https://frame.example/overlay/spring'),
    bot:()=>show('채팅봇 설정',field('명령어','command',S.bot.command,'maxlength="30"')+text('자동 응답','answer',S.bot.answer,'maxlength="300"'),'bot-save','저장'),
    'audit-filter':x=>F.openChoice(x,['전체 작업','설정 변경','권한 변경','콘텐츠 삭제'],S.auditFilter,v=>{S.auditFilter=v;redraw('[data-action="v33-manage-audit-filter"]');}),
    'audit-reset':()=>{S.auditFilter='전체 작업';F.viewState='기본';F.writeUrl(true);redraw();},
    'stats-period':x=>F.openChoice(x,['최근 7일','최근 30일'],S.period,v=>{S.period=v;redraw('[data-action="v33-manage-stats-period"]');}),
    recording:x=>{const row=x.closest('tr');show('녹화 파일',F.dl([['파일 이름',e(row.cells[0].textContent)],['길이',e(row.cells[1].textContent)],['크기',e(row.cells[2].textContent)],['저장 위치','로컬 녹화 폴더']])+'<p class="help">파일 열기와 다운로드는 앱의 녹화 저장소 연결이 필요합니다.</p>');},
    'recording-folder':()=>show('녹화 저장 위치',F.dl([['저장 방식','이 PC의 로컬 폴더'],['사용량','14 GB / 100 GB']])+`<div class="form-actions">${F.go('broadcast-settings','저장 설정')}</div>`),
    'scene-add':()=>show('장면 추가',field('장면 이름','name','','maxlength="40"'),'scene-save','추가'),
    'scene-select':x=>{S.scene=+x.dataset.index;redraw(`[data-action="v33-manage-scene-select"][data-index="${S.scene}"]`);},
    'source-add':()=>show('소스 추가',field('소스 이름','name','','maxlength="40"')+choice('종류','type','프로그램 창',['프로그램 창','브라우저 오버레이','마이크']),'source-save','추가'),
    'source-delete':x=>confirm('소스를 삭제할까요?',e(S.sources[+x.dataset.index].name),'source-remove',{index:+x.dataset.index}),
    'revenue-download':downloadRevenue,
    settlement:()=>show('정산 정보 등록 항목',F.dl([['정산 유형','개인 / 사업자'],['본인 확인','정산 계정 본인 확인'],['지급 계좌','계좌 소유자 확인'],['추가 정보','유형별 세금 처리 정보']])+'<p class="help">실제 등록은 본인 확인과 금융 정보 보호가 연결된 별도 절차에서 진행해야 합니다.</p>'),
    transaction:()=>show('결제 상세',F.dl([['결제일','2026.10.28 14:32'],['내용','개발하는 봄 · 메시지 후원'],['금액','5,000원'],['상태',S.refund?'환불 요청 작성됨':'결제 완료']])+`<div class="form-actions">${b(S.refund?'요청 내용':'환불 요청',S.refund?'refund-history':'refund-form')}</div>`),
    'refund-form':()=>show('환불 요청',text('요청 사유','reason','','maxlength="500" required'),'refund-save','요청 내용 확인'),
    'refund-inline':()=>{const area=F.root.querySelector('[aria-label="환불 사유"]'),reason=area?.value.trim();if(!reason||reason.length<5)return pageError(area,'요청 사유를 5자 이상 입력하세요.');S.refund=reason;F.viewState='기본';F.writeUrl(true);redraw();},
    'refund-cancel':()=>{F.viewState='기본';F.writeUrl(true);redraw();},
    'refund-history':()=>show('환불 요청 내용',F.dl([['대상','메시지 후원 · 5,000원'],['상태','요청 작성됨'],['사유',e(S.refund||'')]])),
    benefits:()=>show('멤버십 혜택 수정',text('혜택','benefits',S.benefits,'placeholder="혜택을 한 줄에 하나씩 입력" maxlength="500"'),'benefits-save','저장'),
    'key-create':()=>{const name=F.root.querySelector('[name="key-name"]'),scope=F.root.querySelector('[name="key-scope"]').value;if(!name.value.trim())return pageError(name,'키 이름을 입력하세요.');confirm('API 키를 발급할까요?',`${e(name.value.trim())} · ${e(scope)}<br>외부 도구가 선택한 권한의 정보에 접근할 수 있습니다.`,'key-create',{keyName:name.value.trim(),keyScope:scope});},
    'key-revoke':()=>confirm('API 키를 폐기할까요?','이 키를 사용하는 외부 도구의 연결이 중단됩니다.','key-revoke'),
    'webhook-save':()=>{const url=F.root.querySelector('[name="webhook-url"]');try{const u=new URL(url.value);if(u.protocol!=='https:')throw 0;S.webhook={url:u.href,event:F.root.querySelector('[name="webhook-event"]').value};const button=F.root.querySelector('[data-action="v33-manage-webhook-save"]');button.disabled=true;button.textContent='저장됨';}catch{url.setAttribute('aria-invalid','true');const p=F.root.querySelector('.v33-manage-inline-error');p.hidden=false;p.textContent='HTTPS 수신 주소를 입력하세요.';url.focus();}},
    'webhook-preview':()=>{const u=F.root.querySelector('[name="webhook-url"]').value;show('웹훅 요청 미리보기',F.dl([['요청 방식','POST'],['수신 주소',e(u||'수신 주소 미입력')]])+'<pre>{\n  "event": "broadcast.started",\n  "channel": "spring"\n}</pre>');}
    ,'update-info':()=>{F.dialog.querySelector('.modal-body').innerHTML='<h3>업데이트 설치 안내</h3><p class="help">설치 파일을 확인한 뒤 방송을 종료하고 앱을 다시 시작하세요.</p><p class="help">설치 파일은 배포 후 제공됩니다.</p>';F.dialog.querySelector('.modal-footer').innerHTML=F.btn('닫기','close-modal');}
    ,'update-cancel':()=>{F.viewState='업데이트 있음';F.writeUrl(true);F.render();}
  };
  document.addEventListener('click',ev=>{const x=ev.target.closest('button');const action=x?.dataset.action;if(!action?.startsWith('v33-manage-')||x.disabled)return;ev.preventDefault();ev.stopImmediatePropagation();handlers[action.slice(11)]?.(x);},true);
  document.addEventListener('submit',ev=>{
    if(ev.target.id!=='v33-manage-form')return;ev.preventDefault();ev.stopImmediatePropagation();
    const form=ev.target,d=new FormData(form),v=name=>String(d.get(name)||'').trim(),action=form.dataset.submit,context=modal;
    if(!context)return;
    if(action==='schedule-save'){if(!v('title'))return error('방송 제목을 입력하세요.','title');if(!v('date')||!v('time'))return error('날짜와 시간을 입력하세요.','date');const r={title:v('title'),date:v('date'),time:v('time')};if(context.index<0)S.schedules.push(r);else S.schedules[context.index]=r;S.changed.schedule=true;context.state='기본';}
    if(action==='schedule-remove')S.schedules.splice(context.index,1);
    if(action==='moderator-save'){if(!v('name'))return error('닉네임을 입력하세요.','name');if(S.moderators.includes(v('name')))return error('이미 등록된 운영자입니다.','name');S.moderators.push(v('name'));S.changed.moderation=true;context.state='기본';}
    if(action==='moderator-remove')S.moderators.splice(context.index,1);
    if(action==='blocked-remove')S.blocked.splice(context.index,1);
    if(action==='message-delete')S.removedMessages=true;
    if(action==='message-restrict'){if(!S.blocked.includes('파도'))S.blocked.push('파도');}
    if(action==='report-save'){if(v('decision')==='선택')return error('조치를 선택하세요.','decision');Object.assign(S.reports[context.kind][context.index],{status:'처리 완료',decision:v('decision'),note:v('note')});}
    if(action==='mission-accept')S.missions[context.index].status='진행 중';
    if(action==='mission-complete')S.missions[context.index].status='완료';
    if(action==='poll-save'){const options=v('options').split('\n').map(x=>x.trim()).filter(Boolean);if(!v('question'))return error('질문을 입력하세요.','question');if(options.length<2||options.length>8)return error('선택지를 2~8개 입력하세요.','options');if(new Set(options).size!==options.length)return error('서로 다른 선택지를 입력하세요.','options');S.polls=[{question:v('question'),options,duration:v('duration'),open:true}];S.changed['polls-manage']=true;context.state='기본';}
    if(action==='poll-close')S.polls[context.index].open=false;
    if(action==='reward-save'){if(!v('name'))return error('보상 이름을 입력하세요.','name');const points=Number(v('points'));if(!Number.isInteger(points)||points<1||points>1000000)return error('포인트는 1~1,000,000 사이 정수로 입력하세요.','points');const r={name:v('name'),points,limit:v('limit')};if(context.index<0)S.rewards.push(r);else S.rewards[context.index]=r;S.changed['rewards-manage']=true;context.state='기본';}
    if(action==='bot-save'){if(!v('command').startsWith('!')||!v('answer'))return error('느낌표로 시작하는 명령어와 응답을 입력하세요.','command');S.bot={command:v('command'),answer:v('answer')};}
    if(action==='scene-save'){if(!v('name'))return error('장면 이름을 입력하세요.','name');if(S.scenes.includes(v('name')))return error('다른 장면 이름을 입력하세요.','name');S.scenes.push(v('name'));S.scene=S.scenes.length-1;context.state='기본';}
    if(action==='source-save'){if(!v('name'))return error('소스 이름을 입력하세요.','name');S.sources.push({name:v('name'),type:v('type')});}
    if(action==='source-remove')S.sources.splice(context.index,1);
    if(action==='refund-save'){if(v('reason').length<5)return error('요청 사유를 5자 이상 입력하세요.','reason');S.refund=v('reason');}
    if(action==='benefits-save'){if(!v('benefits'))return error('혜택을 입력하세요.','benefits');S.benefits=v('benefits');}
    if(action==='key-create'){S.key={name:context.keyName,scope:context.keyScope};close(true);show('발급된 API 키',field('API 키','issued-key','frame_preview_key_not_valid','readonly')+'<p class="help">키는 이 화면에서만 확인할 수 있습니다.</p>');return;}
    if(action==='key-revoke')S.key=false;
    close(true);
  },true);
  document.addEventListener('input',ev=>{
    if(ev.target.closest('.v33-manage-dialog')){const name=ev.target.dataset.field||ev.target.name,control=ev.target.type==='hidden'?F.dialog.querySelector(`[data-field="${name}"]`):ev.target;control?.removeAttribute('aria-invalid');if(control?.getAttribute('aria-describedby')==='v33-manage-form-error')control.removeAttribute('aria-describedby');const p=F.dialog.querySelector('.v33-manage-form-error');if(p?.dataset.field===name)p.hidden=true;}
    if(ev.target.closest('.v33-management')){ev.target.removeAttribute('aria-invalid');const p=F.root.querySelector('.v33-manage-inline-error');if(p)p.hidden=true;const section=ev.target.closest('.v33-manage-section');section?.querySelectorAll('[data-action="v33-manage-webhook-save"],[data-action="v33-manage-moderation-save"]').forEach(x=>{x.disabled=false;x.textContent='저장';});}
  },true);
  document.addEventListener('keydown',ev=>{
    if(ev.key==='Escape'&&modal&&!F.activeSelect){ev.preventDefault();ev.stopImmediatePropagation();close();return;}
    const tab=ev.target.closest('.v33-manage-tabs [role="tab"]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(ev.key))return;
    ev.preventDefault();ev.stopImmediatePropagation();const all=[...tab.parentElement.children],i=all.indexOf(tab),n=ev.key==='Home'?0:ev.key==='End'?all.length-1:(i+(ev.key==='ArrowRight'?1:-1)+all.length)%all.length;all[n].click();
  },true);
  const oldClose=F.closeModal,oldRender=F.render;
  F.closeModal=()=>modal?close():oldClose();
  F.render=()=>{if(modal&&!F.dialog.open)modal=null;oldRender();};
  window.addEventListener('popstate',()=>{modal=null;});
  if(owned.has(F.currentBase))F.render();
})();
