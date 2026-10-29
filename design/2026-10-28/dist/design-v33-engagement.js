/* Local engagement prototypes. No payment, cast, moderation or media API is called. */
(() => {
  const F = window.F;
  if (!F?.modals?.donate) return;
  const e = F.e, icon = F.icon, prefix = 'v33-engage-';
  const owned = new Set(['donate','membership','mission','poll','rewards','report-content','clip-create','devices','raid']);
  const originals = Object.fromEntries([...owned].map(id => [id, F.modals[id]]));
  const defaults = {
    donate: () => ({kind:'메시지',amount:'5000',message:'',video:'',start:'00:00',payment:'',consent:false}),
    membership: () => ({gift:false,recipient:'',count:'1',payment:'',consent:false}),
    mission: () => ({type:'무료 미션',title:'',condition:'',time:'방송 종료 전',amount:'10000',payment:'',consent:false,submitted:false}),
    poll: () => ({tab:'투표',selected:null,voted:null,question:'',sent:false}),
    rewards: () => ({selected:null,confirm:false,history:false}),
    'report-content': () => ({reason:'',detail:'',busy:false}),
    'clip-create': () => ({title:'',start:'00:18:30',end:'00:19:12',duration:42}),
    devices: () => ({selected:'living',searching:false,connecting:false,connected:false}),
    raid: () => ({search:'',selected:null})
  };
  const S = F.v33Engagement = {drafts:{},errors:{},points:3400,ledger:[],lastReward:null,lastClip:null,dropClaimed:false};
  for (const id of owned) S.drafts[id] = defaults[id]();
  let nextFocus = '', jobToken = 0;
  const draft = id => S.drafts[id], fmt = n => Number(n || 0).toLocaleString('ko-KR');
  const digits = value => String(value ?? '').replace(/\D/g,'').replace(/^0+(?=\d)/,'').slice(0,9);
  const fieldId = (id,key) => `${prefix}${id}-${key}`;
  const btn = (text,action,cls='',attrs='') => F.btn(text,prefix+action,'',cls,attrs);
  const close = () => F.btn('닫기','close-modal');
  const cancel = () => F.btn('취소','close-modal');
  const form = (id,body) => `<form id="${prefix}form-${id}" data-v33-engage-form="${id}" novalidate>${body}</form>`;
  const submit = (id,text,action,attrs='') => `<button type="submit" form="${prefix}form-${id}" data-action="${prefix}${action}" class="primary" ${attrs}>${e(text)}</button>`;
  const err = (id,key) => S.errors[id]?.[key] || '';
  function field(id,key,label,control,help='') {
    const error = err(id,key), controlId = fieldId(id,key), helpId = controlId+'-help';
    return `<div class="v33-engage-field${error?' invalid':''}" data-engage-field="${key}"><label for="${controlId}">${e(label)}</label>${control(controlId, helpId, error)}${error||help?`<small id="${helpId}" class="${error?'v33-engage-error':''}"${error?' role="alert"':''}>${e(error||help)}</small>`:''}</div>`;
  }
  function input(id,key,label,opts={}) {
    const d=draft(id), isArea=opts.area, value=d[key]??'';
    return field(id,key,label,(cid,hid,error)=>{
      const attrs=`id="${cid}" name="${cid}" data-engage-key="${key}" aria-label="${e(label)}"${error?' aria-invalid="true"':''}${error||opts.help?` aria-describedby="${hid}"`:''} ${opts.attrs||''}`;
      return isArea?`<textarea ${attrs} rows="${opts.rows||3}" maxlength="${opts.max||500}" placeholder="${e(opts.placeholder||'')}">${e(value)}</textarea>`:`<input ${attrs} type="text" value="${e(opts.money&&value?fmt(value):value)}" maxlength="${opts.max||100}" placeholder="${e(opts.placeholder||'')}"${opts.money?' inputmode="numeric" autocomplete="off" data-engage-money="true"':''}>`;
    },opts.help||'');
  }
  function choice(id,key,label,options,placeholder='선택') {
    const value=draft(id)[key];
    return field(id,key,label,(cid,hid,error)=>`<button type="button" id="${cid}" class="choice-button" data-action="${prefix}choice" data-engage-key="${key}" data-options="${e(JSON.stringify(options))}" aria-haspopup="listbox" aria-expanded="false" aria-label="${e(label)}"${error?` aria-invalid="true" aria-describedby="${hid}"`:''}><span>${e(value||placeholder)}</span>${icon('chevron')}</button>`);
  }
  function consent(id,text) {
    const cid=fieldId(id,'consent'),error=err(id,'consent');
    return `<div class="v33-engage-consent${error?' invalid':''}"><label for="${cid}"><input id="${cid}" type="checkbox" data-engage-key="consent"${draft(id).consent?' checked':''}${error?` aria-invalid="true" aria-describedby="${cid}-help"`:''}><span>${e(text)}</span></label>${error?`<small class="v33-engage-error" id="${cid}-help" role="alert">${e(error)}</small>`:''}</div>`;
  }
  const notice=(text,cls='error')=>`<div class="v33-engage-notice ${cls}" role="${cls==='error'?'alert':'status'}">${icon(cls==='error'?'alert':'info')}<span>${e(text)}</span></div>`;
  const result=(title,detail='',kind='check')=>`<div class="v33-engage-result${kind==='alert'?' is-error':''}" role="status"><span class="v33-engage-result-icon">${icon(kind)}</span><h3>${e(title)}</h3>${detail?`<p>${e(detail)}</p>`:''}</div>`;
  const busy=(title)=>`<div class="v33-engage-result" role="status" aria-live="polite" aria-busy="true"><span class="spinner" aria-hidden="true"></span><h3>${e(title)}</h3></div>`;
  const summary=rows=>`<dl class="v33-engage-summary">${rows.map(([label,value])=>`<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>`;
  const recipient=()=>{const b=F.broadcasts?.[F.selectedBroadcast]||F.broadcasts?.[0];return {name:b?.name||'개발하는 봄',initial:b?.initial||'봄'};};
  const identity=extra=>{const b=recipient();return `<div class="v33-engage-identity">${F.avatar(b.initial,'round')}<div><strong>${e(b.name)}</strong>${extra?`<span>${e(extra)}</span>`:''}</div></div>`;};
  function modal(id,title,body,footer='',extra='') {return {title,body:`<section class="v33-engage-content" data-engage-screen="${id}">${body}</section>`,footer,cls:`v33-engagement v33-engage-${id} ${extra}`};}
  function tabs(id,labels,selected) {return `<div class="v33-engage-tabs" role="tablist" aria-label="${id==='donate'?'후원 방식':'참여 방식'}">${labels.map(label=>`<button type="button" role="tab" aria-selected="${label===selected}" aria-controls="${prefix}${id}-panel" id="${prefix}${id}-tab-${labels.indexOf(label)}" tabindex="${label===selected?0:-1}" data-action="${prefix}tab" data-tab="${e(label)}">${e(label)}</button>`).join('')}</div>`;}
  function panel(id,labels,selected,body) {return `<div role="tabpanel" id="${prefix}${id}-panel" aria-labelledby="${prefix}${id}-tab-${labels.indexOf(selected)}">${body}</div>`;}
  function refresh(focus='') {nextFocus=focus;F.renderModal();}
  function invalid(id,errors) {S.errors[id]=errors;if(!Object.keys(errors).length)return false;refresh('#'+fieldId(id,Object.keys(errors)[0]));return true;}
  function run(id,work,delay=1000) {const token=++jobToken;setTimeout(()=>{if(token===jobToken&&F.screen===id)work();},delay);}
  function validAmount(value) {return Number.isSafeInteger(Number(value))&&Number(value)>=1000;}

  F.modals.donate=state=>{
    const id='donate',d=draft(id);
    if(state==='완료')return modal(id,'후원하기',result('후원을 완료했어요.',`${recipient().name} · ${fmt(d.amount)}원`,'heart'),close());
    if(state==='처리 중')return modal(id,'후원하기',busy('결제를 확인하고 있어요.'),close());
    const labels=['메시지','음성','영상'];
    const amounts=`<div class="v33-engage-amounts">${['1000','5000','10000'].map(n=>btn(fmt(n)+'원','amount',d.amount===n?'selected':'',`data-amount="${n}" aria-pressed="${d.amount===n}"`)).join('')}${btn('직접 입력','amount','', 'data-amount="manual"')}</div>`;
    const media=d.kind==='영상'?`${input(id,'video','영상 주소',{max:500,placeholder:'https://',attrs:'inputmode="url"'})}${input(id,'start','재생 시작',{max:8,placeholder:'00:00',help:'분:초 또는 시:분:초'})}`:'';
    const body=`${identity()}${tabs(id,labels,d.kind)}${panel(id,labels,d.kind,form(id,`${amounts}${input(id,'amount','금액',{money:true,max:11,help:'1,000원부터'})}${media}${input(id,'message',d.kind==='음성'?'읽어줄 메시지':'메시지'+(d.kind==='메시지'?' (선택)':''),{area:true,max:300,placeholder:d.kind==='음성'?'음성으로 읽을 내용을 입력하세요.':'메시지를 입력하세요.'})}${choice(id,'payment','결제 방법',['카드','간편결제'],'결제 방법 선택')}${state==='결제 실패'?notice('결제를 완료하지 못했어요. 결제 방법을 확인한 뒤 다시 시도하세요.'):''}${consent(id,'결제 내용과 취소·환불 기준을 확인했어요.')}`))}`;
    return modal(id,'후원하기',body,`${cancel()}${submit(id,fmt(d.amount)+'원 후원하기','donate-submit')}`);
  };

  F.modals.membership=state=>{
    const id='membership',d=draft(id),price=4900*Number(d.count||1);
    if(state==='가입 완료')return modal(id,'멤버십',result(d.gift?'멤버십을 선물했어요.':'멤버십에 가입했어요.',d.gift?`${d.recipient} · ${d.count}개`:`${recipient().name} · 월 4,900원`,'gift'),close());
    const benefits=`<div class="v33-engage-benefits">${[['shield','멤버십 배지'],['heart','전용 이모티콘'],['video','멤버십 방송']].map(([i,t])=>`<div>${icon(i)}<span>${t}</span></div>`).join('')}</div>`;
    const gift=d.gift?`${input(id,'recipient','받는 사람',{max:30,placeholder:'닉네임'})}${choice(id,'count','수량',['1','5','10'])}`:'';
    const body=`${identity(d.gift?'1개 · 4,900원':'월 4,900원')}${benefits}${form(id,`${gift}${choice(id,'payment','결제 방법',['카드','간편결제'],'결제 방법 선택')}${state==='결제 실패'?notice('결제를 완료하지 못했어요. 결제 방법을 확인하세요.'):''}${consent(id,d.gift?'선물할 대상·수량과 취소·환불 기준을 확인했어요.':'매월 4,900원 정기 결제와 해지 기준을 확인했어요.')}`)}`;
    return modal(id,d.gift?'멤버십 선물':'멤버십 가입',body,`${btn(d.gift?'가입으로 돌아가기':'멤버십 선물','membership-mode')}${submit(id,d.gift?fmt(price)+'원 선물하기':'월 4,900원 가입하기','membership-submit')}`);
  };

  F.modals.mission=state=>{
    const id='mission',d=draft(id),title=d.title||'오늘의 기능 완성하기';
    if(['완료','실패'].includes(state))return modal(id,'미션',result(state==='완료'?'미션을 완료했어요.':'미션을 완료하지 못했어요.',title,state==='완료'?'check':'alert'),close());
    if(state==='진행 중'||d.submitted)return modal(id,d.submitted?'제안한 미션':'진행 중인 미션',`<h3 class="v33-engage-title">${e(title)}</h3>${summary([['유형',d.type],['상태',d.submitted?'수락 대기':'진행 중'],[d.submitted?'제한 시간':'남은 시간',d.submitted?d.time:'24분 32초'],...(d.type==='미션 후원'?[['후원 금액',fmt(d.amount)+'원']]:[])])}${d.condition?`<p class="v33-engage-description">${e(d.condition)}</p>`:''}`,close());
    const paid=d.type==='미션 후원';
    return modal(id,'미션 제안',form(id,`${choice(id,'type','미션 유형',['무료 미션','미션 후원'])}${input(id,'title','미션 제목',{max:80,placeholder:'도전할 내용'})}${input(id,'condition','완료 조건',{area:true,max:500,placeholder:'완료 여부를 판단할 수 있게 작성하세요.'})}${choice(id,'time','제한 시간',['30분','1시간','방송 종료 전'])}${paid?`${input(id,'amount','후원 금액',{money:true,max:11,help:'1,000원부터'})}${choice(id,'payment','결제 방법',['카드','간편결제'],'결제 방법 선택')}${consent(id,'미션 조건과 후원 금액을 확인했어요.')}`:''}`),`${cancel()}${submit(id,'제안하기','mission-submit')}`);
  };

  const pollOptions=[['플레이어 개선',58],['채팅 기능',29],['모바일 화면',13]];
  F.modals.poll=state=>{
    const id='poll',d=draft(id),labels=['투표','질문'],closed=state==='마감',voted=state==='투표 완료'||d.voted!==null,displayVote=d.voted??(state==='투표 완료'?0:null);
    let body,footer=close();
    if(d.tab==='질문') {
      body=d.sent?result('질문을 보냈어요.',d.question,'chat'):form(id,input(id,'question','방송자에게 질문',{area:true,max:300,placeholder:'질문을 입력하세요.'}));
      footer=d.sent?`${btn('다른 질문 쓰기','question-again')}${close()}`:`${cancel()}${submit(id,'질문 보내기','question-submit')}`;
    } else {
      body=`<h3 class="v33-engage-title">다음 작업은 무엇으로 할까요?</h3><div class="v33-engage-poll-options" role="${voted||closed?'group':'radiogroup'}" aria-label="투표 선택지">${pollOptions.map(([name,pct],i)=>`<button type="button" class="v33-engage-poll-option${d.selected===i||displayVote===i?' selected':''}" data-action="${prefix}poll-option" data-option="${i}"${voted||closed?' disabled':` role="radio" aria-checked="${d.selected===i}" tabindex="${(d.selected??0)===i?0:-1}"`}>${voted||closed?`<span class="v33-engage-poll-fill" style="width:${pct}%" aria-hidden="true"></span>`:''}<span>${e(name)}${displayVote===i?'<small>내 선택</small>':''}</span>${voted||closed?`<strong>${pct}%</strong>`:''}</button>`).join('')}</div><div class="v33-engage-poll-meta"><span>128명 참여</span><span>${closed?'마감됨':voted?'투표 완료':'2분 남음'}</span></div>${err(id,'selected')?notice(err(id,'selected')):''}`;
      if(!voted&&!closed)footer=`${cancel()}${btn('투표하기','poll-submit','primary',d.selected===null?'disabled':'')}`;
    }
    return modal(id,'투표 및 질문',`${tabs(id,labels,d.tab)}${panel(id,labels,d.tab,body)}`,footer);
  };

  const rewardItems=[{id:'suggest',name:'다음 작업 제안',cost:1000,icon:'target'},{id:'theme',name:'화면 테마 선택',cost:2000,icon:'sun'},{id:'cheer',name:'응원 보내기',cost:500,icon:'heart'}];
  F.modals.rewards=state=>{
    const id='rewards',d=draft(id),balance=state==='포인트 부족'?200:S.points,item=rewardItems.find(x=>x.id===d.selected)||rewardItems[0];
    if(state==='교환 완료')return modal(id,'포인트 보상',result('보상을 신청했어요.',S.lastReward?.name||item.name,'gift')+summary([['사용 포인트',fmt(S.lastReward?.cost||item.cost)+' P'],['남은 포인트',fmt(S.lastReward?S.points:S.points-item.cost)+' P']]),`${btn('포인트 기록','reward-history')}${close()}`);
    if(d.history)return modal(id,'포인트 기록',S.ledger.length?`<div class="v33-engage-history">${S.ledger.map(row=>`<div><strong>${e(row.name)}</strong><span>−${fmt(row.cost)} P</span></div>`).join('')}</div>`:result('사용 내역이 없어요.','', 'history'),`${btn('보상 목록','reward-list')}${close()}`);
    if(d.confirm)return modal(id,'보상을 신청할까요?',`<h3 class="v33-engage-title">${e(item.name)}</h3>${summary([['필요 포인트',fmt(item.cost)+' P'],['신청 후 포인트',fmt(balance-item.cost)+' P']])}`,`${btn('취소','reward-cancel')}${btn('신청하기','reward-confirm','primary',balance<item.cost?'disabled':'')}`);
    const list=`<div class="v33-engage-reward-grid">${rewardItems.map(r=>`<button type="button" data-action="${prefix}reward-select" data-reward="${r.id}"${balance<r.cost?' disabled':''}>${icon(r.icon)}<strong>${e(r.name)}</strong><span>${fmt(r.cost)} P</span>${balance<r.cost?`<small>${fmt(r.cost-balance)} P 부족</small>`:''}</button>`).join('')}</div>`;
    return modal(id,'포인트 보상',`<div class="v33-engage-balance"><span>내 포인트</span><strong>${fmt(balance)} P</strong></div>${list}`,`${btn('포인트 기록','reward-history')}${close()}`);
  };

  F.modals['report-content']=state=>{
    const id='report-content',d=draft(id);
    if(state==='접수 완료')return modal(id,'신고하기',result('신고가 접수됐어요.',d.reason||'부적절한 콘텐츠','shield'),close());
    if(d.busy)return modal(id,'신고하기',busy('신고를 접수하고 있어요.'),close());
    return modal(id,'신고하기',form(id,`${choice(id,'reason','신고 사유',['부적절한 콘텐츠','도배 및 광고','권리 침해','개인정보 노출','기타'],'사유 선택')}${input(id,'detail',d.reason==='기타'?'상세 내용':'상세 내용 (선택)',{area:true,max:1000,rows:4,placeholder:'문제가 된 내용을 알려주세요.'})}`),`${cancel()}${submit(id,'신고 접수','report-submit')}`);
  };

  const toSeconds=value=>{const parts=String(value).trim().split(':');if(parts.length<2||parts.length>3||parts.some(x=>!/^\d{1,2}$/.test(x)))return NaN;if(parts.slice(1).some(x=>Number(x)>59))return NaN;return parts.reduce((n,x)=>n*60+Number(x),0);};
  const timeText=seconds=>[Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60].map(n=>String(n).padStart(2,'0')).join(':');
  F.modals['clip-create']=state=>{
    const id='clip-create',d=draft(id);
    if(state==='생성 완료')return modal(id,'클립 만들기',result('클립이 만들어졌어요.',S.lastClip?.title||d.title||'작은 기능 완성하는 순간','clip'),`${close()}${F.go('clip-watch','클립 보기','','primary')}`,'medium');
    if(state==='처리 중')return modal(id,'클립 만들기',busy('클립을 만들고 있어요.'),close(),'medium');
    const original=originals[id]('기본'),preview=original.body.match(/<div class="studio-preview"[\s\S]*?<\/div>/)?.[0]||'';
    return modal(id,'클립 만들기',`${preview}${form(id,`<div class="v33-engage-time-pair">${input(id,'start','시작',{max:8,placeholder:'00:00:00'})}${input(id,'end','종료',{max:8,placeholder:'00:00:00'})}</div><label class="v33-engage-duration" for="${fieldId(id,'duration')}"><span>구간 길이</span><output id="${prefix}clip-duration">${d.duration}초</output></label><input id="${fieldId(id,'duration')}" data-engage-key="duration" type="range" min="1" max="60" value="${d.duration}" aria-label="클립 구간 길이"><p class="v33-engage-helper">최대 60초 · 시:분:초</p>${input(id,'title','클립 제목',{max:80,placeholder:'제목을 입력하세요.'})}`)}`,`${cancel()}${submit(id,'클립 만들기','clip-submit')}`,'medium');
  };

  const deviceItems=[{id:'living',name:'거실 TV'},{id:'meeting',name:'회의실 화면'}];
  F.modals.devices=state=>{
    const id='devices',d=draft(id),device=deviceItems.find(x=>x.id===d.selected)||deviceItems[0];
    if(d.searching||d.connecting)return modal(id,'다른 기기에서 보기',busy(d.searching?'기기를 찾고 있어요.':device.name+'에 연결하고 있어요.'),close());
    if(d.connected)return modal(id,'다른 기기에서 보기',result(device.name+'에 연결했어요.','','cast'),`${btn('연결 해제','device-disconnect')}${close()}`);
    if(state==='기기 없음')return modal(id,'다른 기기에서 보기',result('연결할 기기가 없어요.','기기의 전원과 연결 상태를 확인하세요.','cast'),`${close()}${btn('다시 찾기','device-search','primary')}`);
    const error=state==='연결 실패'?notice('기기에 연결하지 못했어요. 전원과 연결 상태를 확인하세요.'):'';
    return modal(id,'다른 기기에서 보기',`${error}<div class="v33-engage-device-list">${deviceItems.map(item=>`<div>${icon('cast')}<strong>${e(item.name)}</strong>${btn(state==='연결 실패'&&d.selected===item.id?'다시 연결':'연결','device-connect','',`data-device-id="${item.id}" aria-label="${e(item.name)} 연결"`)}</div>`).join('')}</div>`,close());
  };

  const raidCandidate=()=>F.broadcasts?.[1]||{name:'서재',title:'오늘도 한 장씩, 디자인 작업',initial:'서재'};
  F.modals.raid=state=>{
    const id='raid',d=draft(id),b=raidCandidate();
    if(state==='완료')return modal(id,'다른 방송으로 연결',result('다음 방송을 안내했어요.',`${b.name} · 이동은 시청자가 선택해요.`,'users'),close());
    if(state==='이동 확인')return modal(id,'다음 방송을 안내할까요?',`<div class="v33-engage-identity">${F.avatar(b.initial,'round')}<div><strong>${e(b.name)}</strong><span>${e(b.title)}</span></div></div><p class="v33-engage-description">현재 채팅에 다음 방송 안내가 표시돼요. 시청자를 강제로 이동시키지 않아요.</p>`,`${btn('다시 선택','raid-back')}${btn('안내하기','raid-confirm','primary')}`);
    const match=(b.name+' '+b.title).toLocaleLowerCase().includes(d.search.trim().toLocaleLowerCase());
    return modal(id,'다른 방송으로 연결',`${input(id,'search','채널 검색',{max:100,placeholder:'채널 이름 또는 방송 제목'})}<div class="v33-engage-raid-list"><button type="button" data-action="${prefix}raid-select" class="v33-engage-raid-channel${d.selected?' selected':''}" aria-pressed="${!!d.selected}"${match?'':' hidden'}>${F.avatar(b.initial,'round')}<span><strong>${e(b.name)}</strong><small>${e(b.title)}</small></span>${icon(d.selected?'check':'right')}</button><p class="v33-engage-raid-empty"${match?' hidden':''}>검색 결과가 없어요.</p></div>`,`${cancel()}${btn('이 방송 선택','raid-next','primary',!d.selected||!match?'disabled':'')}`,'medium');
  };

  F.pages['drop-rewards']=state=>{
    const ready=state==='수령 가능',claimed=state==='수령 완료'||S.dropClaimed,minutes=ready||claimed?30:18;
    return F.page('시청 보상',`<section class="v33-engagement-page v33-engage-drop"><div class="v33-engage-drop-heading"><span class="v33-engage-drop-icon">${icon('gift')}</span><div><h2>작업실 함께 보기</h2><p>30분 시청 · 기념 배지</p></div></div><div class="v33-engage-drop-progress"><span>${minutes} / 30분</span><strong>${claimed?'수령 완료':ready?'수령 가능':'12분 남음'}</strong></div><div class="progress-track" role="progressbar" aria-label="시청 보상 진행률" aria-valuemin="0" aria-valuemax="30" aria-valuenow="${minutes}"><span style="width:${minutes/30*100}%"></span></div><div class="v33-engage-drop-actions">${btn(claimed?'수령 완료':'보상 받기','drop-claim','primary',!ready||claimed?'disabled':'')}</div>${claimed?'<p class="v33-engage-drop-status" role="status">기념 배지를 받았어요.</p>':''}</section>`);
  };

  function submitAction(action) {
    const id=F.screen,d=draft(id);if(!d)return;
    if((id==='donate'&&['처리 중','완료'].includes(F.viewState))||(id==='membership'&&F.viewState==='가입 완료')||(id==='mission'&&d.submitted)||(id==='report-content'&&(d.busy||F.viewState==='접수 완료'))||(id==='clip-create'&&['처리 중','생성 완료'].includes(F.viewState)))return;
    const errors={};
    if(action==='donate-submit') {
      if(!validAmount(d.amount))errors.amount='1,000원 이상 입력하세요.';
      if(d.kind==='음성'&&!d.message.trim())errors.message='읽어줄 메시지를 입력하세요.';
      if(d.kind==='영상') {try {const u=new URL(d.video);if(!['http:','https:'].includes(u.protocol))throw 0;}catch{errors.video='올바른 영상 주소를 입력하세요.';}if(!Number.isFinite(toSeconds(d.start)))errors.start='분:초 또는 시:분:초로 입력하세요.';}
      if(!d.payment)errors.payment='결제 방법을 선택하세요.';
      if(!d.consent)errors.consent='결제 내용과 환불 기준을 확인하세요.';
      if(invalid(id,errors))return;F.setState('처리 중');run(id,()=>F.setState('완료'));return;
    }
    if(action==='membership-submit') {
      if(d.gift&&!d.recipient.trim())errors.recipient='선물할 사람을 입력하세요.';
      if(!d.payment)errors.payment='결제 방법을 선택하세요.';
      if(!d.consent)errors.consent=d.gift?'선물 내용과 환불 기준을 확인하세요.':'정기 결제와 해지 기준을 확인하세요.';
      if(invalid(id,errors))return;F.setState('가입 완료');return;
    }
    if(action==='mission-submit') {
      if(!d.title.trim())errors.title='미션 제목을 입력하세요.';
      if(!d.condition.trim())errors.condition='완료 조건을 입력하세요.';
      if(d.type==='미션 후원') {if(!validAmount(d.amount))errors.amount='1,000원 이상 입력하세요.';if(!d.payment)errors.payment='결제 방법을 선택하세요.';if(!d.consent)errors.consent='미션 조건과 후원 금액을 확인하세요.';}
      if(invalid(id,errors))return;d.submitted=true;refresh();return;
    }
    if(action==='question-submit') {if(!d.question.trim())errors.question='질문을 입력하세요.';if(invalid(id,errors))return;d.sent=true;refresh();return;}
    if(action==='report-submit') {if(!d.reason)errors.reason='신고 사유를 선택하세요.';if(d.reason==='기타'&&!d.detail.trim())errors.detail='신고 내용을 입력하세요.';if(invalid(id,errors))return;d.busy=true;refresh();run(id,()=>{d.busy=false;F.setState('접수 완료');},700);return;}
    if(action==='clip-submit') {
      const start=toSeconds(d.start),end=toSeconds(d.end);
      if(!Number.isFinite(start))errors.start='시:분:초로 입력하세요.';
      if(!Number.isFinite(end))errors.end='시:분:초로 입력하세요.';
      else if(Number.isFinite(start)&&(end<=start||end-start>60))errors.end='종료는 시작보다 늦고, 구간은 60초 이내여야 해요.';
      if(!d.title.trim())errors.title='클립 제목을 입력하세요.';
      if(invalid(id,errors))return;d.duration=end-start;S.lastClip={title:d.title.trim(),start:d.start,end:d.end};F.setState('처리 중');run(id,()=>F.setState('생성 완료'));return;
    }
  }

  document.addEventListener('click',event=>{
    const b=event.target.closest?.('button'),action=b?.dataset.action;
    if(!action?.startsWith(prefix))return;
    event.preventDefault();event.stopImmediatePropagation();if(b.disabled)return;
    const name=action.slice(prefix.length),id=F.screen,d=draft(id);
    if(name.endsWith('-submit')&&name!=='poll-submit'){submitAction(name);return;}
    if(name==='drop-claim'){if(F.screen==='drop-rewards'&&F.viewState==='수령 가능'&&!S.dropClaimed){S.dropClaimed=true;F.setState('수령 완료');}return;}
    if(!d)return;
    if(name==='choice'){const key=b.dataset.engageKey;F.openChoice(b,JSON.parse(b.dataset.options),d[key],value=>{d[key]=value;delete S.errors[id]?.[key];refresh('#'+fieldId(id,key));});return;}
    if(name==='tab'){if(id==='donate')d.kind=b.dataset.tab;else d.tab=b.dataset.tab;S.errors[id]={};refresh(`[data-action="${prefix}tab"][data-tab="${b.dataset.tab}"]`);return;}
    if(name==='amount'){if(b.dataset.amount==='manual'){F.dialog.querySelector('#'+fieldId(id,'amount'))?.focus();return;}d.amount=b.dataset.amount;delete S.errors[id]?.amount;refresh('#'+fieldId(id,'amount'));return;}
    if(name==='membership-mode'){d.gift=!d.gift;d.consent=false;S.errors[id]={};refresh();return;}
    if(name==='question-again'){d.sent=false;d.question='';refresh('#'+fieldId(id,'question'));return;}
    if(name==='poll-option'){if(F.viewState==='마감'||F.viewState==='투표 완료'||d.voted!==null)return;d.selected=Number(b.dataset.option);refresh(`[data-option="${d.selected}"]`);return;}
    if(name==='poll-submit'){if(d.selected===null||d.voted!==null||F.viewState==='마감')return;d.voted=d.selected;F.setState('투표 완료');return;}
    if(name==='reward-select'){const item=rewardItems.find(x=>x.id===b.dataset.reward);if(!item||(F.viewState==='포인트 부족'?200:S.points)<item.cost)return;d.selected=item.id;d.confirm=true;refresh();return;}
    if(name==='reward-cancel'){d.confirm=false;refresh(`[data-reward="${d.selected}"]`);return;}
    if(name==='reward-confirm'){const item=rewardItems.find(x=>x.id===d.selected);if(!d.confirm||!item||F.viewState==='포인트 부족'||S.points<item.cost)return;S.points-=item.cost;S.lastReward={...item};S.ledger.unshift({...item});d.confirm=false;F.setState('교환 완료');return;}
    if(name==='reward-history'){d.history=true;F.viewState='기본';F.writeUrl(true);refresh();return;}
    if(name==='reward-list'){d.history=false;d.confirm=false;refresh();return;}
    if(name==='device-search'){d.searching=true;refresh();run(id,()=>{d.searching=false;F.setState('기본');},850);return;}
    if(name==='device-connect'){d.selected=b.dataset.deviceId;d.connecting=true;refresh();run(id,()=>{d.connecting=false;d.connected=true;refresh();},950);return;}
    if(name==='device-disconnect'){d.connected=false;F.setState('기본');return;}
    if(name==='raid-select'){d.selected=1;refresh(`[data-action="${prefix}raid-select"]`);return;}
    if(name==='raid-next'){if(d.selected!==null)F.setState('이동 확인');return;}
    if(name==='raid-back'){F.setState('방송 선택');return;}
    if(name==='raid-confirm'){F.setState('완료');return;}
  },true);

  document.addEventListener('submit',event=>{
    const id=event.target.dataset?.v33EngageForm;if(!id)return;
    event.preventDefault();event.stopImmediatePropagation();
    const actions={donate:'donate-submit',membership:'membership-submit',mission:'mission-submit',poll:'question-submit','report-content':'report-submit','clip-create':'clip-submit'};
    if(actions[id])submitAction(actions[id]);
  },true);

  function collect(event) {
    const target=event.target,key=target.dataset?.engageKey;
    if(!key||!target.closest('.v33-engagement'))return;
    const id=F.screen,d=draft(id);if(!d)return;
    d[key]=target.type==='checkbox'?target.checked:target.value;
    if(target.dataset.engageMoney&&!event.isComposing){
      const caret=target.selectionStart??target.value.length,before=digits(target.value.slice(0,caret)).length;
      d[key]=digits(target.value);target.value=d[key]?fmt(d[key]):'';let pos=0,count=0;while(pos<target.value.length&&count<before)if(/\d/.test(target.value[pos++]))count++;target.setSelectionRange(pos,pos);
      if(id==='donate'){const submitButton=F.dialog.querySelector(`[data-action="${prefix}donate-submit"]`);if(submitButton)submitButton.textContent=fmt(d.amount)+'원 후원하기';F.dialog.querySelectorAll('[data-amount]').forEach(button=>{const active=button.dataset.amount===d.amount;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});}
    }
    if(S.errors[id]?.[key]){delete S.errors[id][key];target.removeAttribute('aria-invalid');target.removeAttribute('aria-describedby');const field=target.closest('.v33-engage-field,.v33-engage-consent');field?.classList.remove('invalid');field?.querySelector('.v33-engage-error')?.remove();}
    if(id==='clip-create'&&['start','end','duration'].includes(key)){
      const start=toSeconds(d.start),end=toSeconds(d.end);
      if(key==='duration'&&Number.isFinite(start)){d.duration=Number(target.value);d.end=timeText(start+d.duration);F.dialog.querySelector('#'+fieldId(id,'end')).value=d.end;}
      else if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=60){d.duration=end-start;F.dialog.querySelector('#'+fieldId(id,'duration')).value=d.duration;}
      const output=F.dialog.querySelector('#'+prefix+'clip-duration');if(output)output.textContent=d.duration+'초';
      const nextEnd=toSeconds(d.end);
      if(Number.isFinite(start)&&Number.isFinite(nextEnd)&&nextEnd>start&&nextEnd-start<=60&&S.errors[id]?.end){
        delete S.errors[id].end;
        const endInput=F.dialog.querySelector('#'+fieldId(id,'end'));
        endInput.removeAttribute('aria-invalid');endInput.removeAttribute('aria-describedby');
        endInput.closest('.v33-engage-field')?.classList.remove('invalid');endInput.closest('.v33-engage-field')?.querySelector('.v33-engage-error')?.remove();
      }
    }
    if(id==='raid'&&key==='search'){
      const b=raidCandidate(),match=(b.name+' '+b.title).toLocaleLowerCase().includes(d.search.trim().toLocaleLowerCase());
      F.dialog.querySelector('.v33-engage-raid-channel').hidden=!match;F.dialog.querySelector('.v33-engage-raid-empty').hidden=match;
      F.dialog.querySelector(`[data-action="${prefix}raid-next"]`).disabled=!match||d.selected===null;
    }
  }
  document.addEventListener('input',collect,true);document.addEventListener('change',collect,true);document.addEventListener('compositionend',collect,true);
  document.addEventListener('keydown',event=>{
    const b=event.target.closest?.('button');if(!b?.closest('.v33-engagement'))return;
    if(b.dataset.action===prefix+'tab'&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();const buttons=[...b.parentElement.querySelectorAll('[role="tab"]')],i=buttons.indexOf(b),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].click();
    }
    if(b.getAttribute('role')==='radio'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();const buttons=[...b.parentElement.querySelectorAll('[role="radio"]')],i=buttons.indexOf(b),next=(i+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;buttons[next].click();
    }
  },true);

  const navigate=F.navigate,renderModal=F.renderModal;
  F.navigate=(id,state,replace=false)=>{
    if(id!==F.screen){++jobToken;if(owned.has(id)){if(!['poll','rewards'].includes(id))S.drafts[id]=defaults[id]();S.errors[id]={};}}
    return navigate(id,state,replace);
  };
  F.renderModal=(...args)=>{
    const value=renderModal(...args);if(!owned.has(F.screen)||!F.dialog?.classList.contains('v33-engagement'))return value;
    const target=nextFocus?F.dialog.querySelector(nextFocus):F.dialog.querySelector('.v33-engage-result h3,.v33-engage-title,.v33-engage-content input,.v33-engage-content textarea,.v33-engage-content [role="tab"][aria-selected="true"],.v33-engage-content button');nextFocus='';
    if(target){if(!target.matches('button,input,textarea'))target.tabIndex=-1;target.focus({preventScroll:true});}
    return value;
  };
  if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
  if(owned.has(F.screen))F.renderModal();else if(F.screen==='drop-rewards')F.render();
})();
