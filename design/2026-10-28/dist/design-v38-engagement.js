/* v38 local engagement/detail design. No payment, network, cast or media API. */
(() => {
'use strict';
const F=window.F;if(!F?.modals||!F.managementDesign)return;
const M=F.managementDesign,E=F.v33Engagement,e=F.e;
const D=F.v38Shared=F.v38Shared||{};
const uid=prefix=>prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
const channel=()=>F.currentBase==='studio'?0:Number(F.selectedBroadcast||0);
const viewer=()=>String(F.accountDesign?.savedProfile?.id||'viewer-self');
const now=()=>new Date().toISOString();
D.polls||=M.polls.map((p,i)=>({...p,id:p.id||'poll-'+i,channelId:0,voters:{},createdAt:now(),options:p.options.map((o,n)=>typeof o==='string'?{id:'option-'+n,text:o,votes:0}:o)}));
D.missions||=M.missions.map((m,i)=>({...m,id:m.id||'mission-'+i,channelId:0,amount:0,createdAt:now()}));
D.rewards||=M.rewards.map((r,i)=>({...r,id:r.id||'reward-'+(i+1),channelId:0,cost:r.points}));
D.questions||=[];D.predictions||=[];D.donations||=[];D.memberships||=[];D.redemptions||=[];D.ledger||=[];D.wallets||={};D.refunds||=[];D.gifts||=[];
D.limits||={minPayment:1000,maxPayment:10000000};D.devices||={active:null,pending:null,error:false};
D.drops||={minutes:18,required:30,eligible:true,claimed:false,error:false};D.earning||={watchPoints:10,watchMinutes:5,attendance:100,attendanceClaimed:false};
if(!Object.getOwnPropertyDescriptor(D,'benefits'))Object.defineProperty(D,'benefits',{get:()=>M.benefits,set:v=>{M.benefits=v;},configurable:true});
const wallet=(c=channel())=>D.wallets[c]??(D.wallets[c]=3400);
const addPoints=(amount,label,requestId,c=channel())=>{
  D.wallets[c]=wallet(c)+amount;
  D.ledger.unshift({id:uid('ledger'),channelId:c,amount,label,requestId,createdAt:now(),balance:D.wallets[c]});
  if(E)E.points=D.wallets[c];return D.wallets[c];
};
D.balance=wallet;D.adjustPoints=addPoints;
D.resolveRedemption=(id,status,reason='')=>{
 const r=D.redemptions.find(r=>r.id===id);if(!r)return false;
 if(!['신청 대기','처리 중'].includes(r.status))return false;
 if(!['제공 완료','거절','취소','처리 중'].includes(status))return false;
 r.status=status;r.reason=reason;r.updatedAt=now();
 if(['거절','취소'].includes(status)&&!r.refunded){addPoints(r.cost,'보상 신청 포인트 반환',r.id,r.channelId);r.refunded=true;}
 return true;
};
D.transitionMission=(id,status,reason='')=>{
 const r=D.missions.find(r=>r.id===id);if(!r)return false;
 const allowed={'접수':['진행 중','거절','취소','기한 만료'],'진행 중':['완료','실패','취소','기한 만료']};
 if(!(allowed[r.status]||[]).includes(status))return false;
 r.status=status;r.reason=reason;r.updatedAt=now();
 if(r.amount>0)r.paymentStatus=['거절','취소','기한 만료'].includes(status)?'결제 취소 확인 대기':status==='완료'?'정산 확인 대기':'결제 확인 대기';
 return true;
};
D.resolvePrediction=(id,result)=>{
 const p=D.predictions.find(p=>p.id===id);if(!p||['결과 확정','취소'].includes(p.status))return false;
 if(result!=='취소'&&!p.options.some(o=>o.id===result))return false;
 const entries=p.entries||[],pool=entries.reduce((n,r)=>n+r.points,0),win=entries.filter(r=>r.optionId===result).reduce((n,r)=>n+r.points,0);
 entries.forEach(r=>{if(r.settled)return;const amount=result==='취소'?r.points:r.optionId===result&&win?Math.floor(pool*r.points/win):0;
 if(amount)addPoints(amount,result==='취소'?'예측 취소 포인트 반환':'예측 결과 포인트',r.id,r.channelId);r.settled=true;r.returned=amount;r.status=result==='취소'?'취소':'결과 확정';});
 p.status=result==='취소'?'취소':'결과 확정';p.result=result;p.updatedAt=now();return true;
};
D.normalizePolls=()=>{
 D.polls.forEach((p,i)=>{p.id||='poll-'+i;p.channelId??=0;p.voters||={};p.options=p.options.map((o,n)=>typeof o==='string'?{id:'option-'+n,text:o,votes:0}:o);});
};
D.pollPercentages=p=>{
 const values=p.options.map(o=>Math.max(0,Number(o.votes||0))),total=values.reduce((n,v)=>n+v,0);if(!total)return values.map(()=>0);
 const exact=values.map(v=>v/total*100),out=exact.map(Math.floor),order=exact.map((n,i)=>({i,f:n-Math.floor(n)})).sort((a,b)=>b.f-a.f||a.i-b.i);
 const remaining=100-out.reduce((a,b)=>a+b,0);for(let n=0;n<remaining;n++)out[order[n].i]++;return out;
};
D.setMembershipStatus=(id,status,reason='')=>{
 const m=D.memberships.find(m=>m.id===id);if(!m||!['이용 중','가입 확인 대기','갱신 예정','해지 예약','만료','갱신 실패'].includes(status))return false;
 m.status=status;m.reason=reason;m.updatedAt=now();return true;
};
D.claimGift=(id)=>{
 const g=D.gifts.find(g=>g.id===id);if(!g||g.status!=='수령 대기')return {error:'이미 수령했거나 사용할 수 없는 선물이에요.'};
 if(g.recipient.toLocaleLowerCase()!==String(F.nickname).toLocaleLowerCase())return {error:'이 선물의 수령 대상이 아니에요.'};
 let m=D.memberships.find(m=>m.channelId===g.channelId&&m.user===viewer());
 if(!m){m={id:uid('membership-gift'),channelId:g.channelId,user:viewer(),userName:F.nickname,createdAt:now(),kind:'멤버십 선물',amount:0};D.memberships.push(m);}
 const previous=/^\d{4}\.\d{2}\.\d{2}$/.test(m.endsAt||'')?new Date(m.endsAt.replaceAll('.','-')+'T00:00:00Z'):new Date('2026-11-02T00:00:00Z');
 const start=previous>new Date('2026-11-02T00:00:00Z')?previous:new Date('2026-11-02T00:00:00Z');start.setUTCMonth(start.getUTCMonth()+1);
 Object.assign(m,{status:'이용 중',endsAt:start.toISOString().slice(0,10).replaceAll('-','.'),renewsAt:'자동 갱신 없음'});g.status='수령 완료';g.claimedAt=now();return {ok:true,membership:m};
};
const owned=new Set(['donate','membership','mission','poll','rewards','devices']);
const original={navigate:F.navigate,render:F.render,modal:F.renderModal,close:F.closeModal,setState:F.setState};
const S=F.v38Engagement={drafts:{},errors:{},subview:{},busy:new Set(),job:0,mode:{},list:{},dialog:null,fixture:new Set(),lastReward:null,lastDonation:null,lastMembership:null,preview:null};
const draft=id=>{const key=id+':'+channel();return S.drafts[key]||(S.drafts[key]={kind:'메시지',amount:'5000',message:'',video:'',start:'00:00',payment:'',consent:false,type:'무료 미션',title:'',condition:'',time:'30분',tab:'투표',question:'',recipient:'',count:'1',gift:false});};
const btn=(label,action,attrs='',cls='')=>F.btn(cls.includes('choice-button')?'<span>'+e(label)+'</span>'+F.icon('chevron'):e(label),'v38-engage-'+action,'',cls,attrs);
const close=()=>F.btn('닫기','close-modal'),cancel=()=>F.btn('취소','close-modal');
const money=n=>Number(n||0).toLocaleString('ko-KR')+'원';
function parseAmount(value,min=D.limits.minPayment,max=D.limits.maxPayment){
 const s=String(value??'').trim();
 if(!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(s))return {error:'금액은 소수 없이 원 단위 정수로 입력하세요.'};
 const n=Number(s.replaceAll(',',''));if(!Number.isSafeInteger(n)||n<min||n>max)return {error:money(min)+'부터 '+money(max)+'까지 입력하세요.'};return {value:n};
}
S.parseAmount=parseAmount;
const err=(id,key)=>S.errors[id]?.[key]||'';
function field(id,key,label,opts={}){
 const d=draft(id),error=err(id,key),cid='v38-'+id+'-'+key;
 const attrs=' id="'+cid+'" name="'+e(key)+'" data-v38-field="'+e(key)+'" aria-label="'+e(label)+'" maxlength="'+(opts.max||100)+'"'+(error?' aria-invalid="true" aria-describedby="'+cid+'-error"':'')+(opts.numeric?' inputmode="numeric"':'');
 const value=key==='amount'&&!parseAmount(d[key]).error?parseAmount(d[key]).value.toLocaleString('ko-KR'):d[key]??'';
 const input='<input'+attrs+' type="'+(opts.type||'text')+'" value="'+e(value)+'" placeholder="'+e(opts.placeholder||'')+'">';
 const control=opts.area?'<textarea'+attrs+' rows="3" placeholder="'+e(opts.placeholder||'')+'">'+e(d[key]||'')+'</textarea>':key==='amount'?'<div class="v38-currency-input">'+input+'<span aria-hidden="true">원</span></div>':input;
 return '<div class="v38-field"><label for="'+cid+'">'+e(label)+'</label>'+control+(error?'<small role="alert" id="'+cid+'-error">'+e(error)+'</small>':'')+'</div>';
}
function choice(id,key,label,options){
 const d=draft(id),error=err(id,key),cid='v38-'+id+'-'+key;
 return '<div class="v38-field"><label for="'+cid+'">'+e(label)+'</label>'+btn(d[key]||'선택','choice','id="'+cid+'" data-scope="'+id+'" data-key="'+key+'" data-options="'+e(JSON.stringify(options))+'" aria-label="'+e(label)+'" aria-haspopup="listbox" aria-expanded="false"'+(error?' aria-invalid="true" aria-describedby="'+cid+'-error"':''),'choice-button')+(error?'<small id="'+cid+'-error" role="alert">'+e(error)+'</small>':'')+'</div>';
}
const consent=id=>'<label class="v38-consent"><input id="v38-'+id+'-consent" type="checkbox" data-v38-field="consent"'+(draft(id).consent?' checked':'')+(err(id,'consent')?' aria-invalid="true" aria-describedby="v38-'+id+'-consent-error"':'')+'>'+(id==='settlement'?'정산 정보와 본인 확인 기준을 확인했어요.':'결제 내용과 취소·환불 기준을 확인했어요.')+'</label>'+(id==='settlement'?'':btn('취소·환불 기준','policy','','ghost small'))+(err(id,'consent')?'<p class="v38-error" id="v38-'+id+'-consent-error" role="alert">'+e(err(id,'consent'))+'</p>':'');
const summary=rows=>'<dl class="v38-summary">'+rows.map(([a,b])=>'<div><dt>'+e(a)+'</dt><dd>'+e(b)+'</dd></div>').join('')+'</dl>';
const state=(title,detail='')=>{
 const empty=/없어요|권한|자격/.test(title),busy=/확인하고|연결하고|찾고/.test(title),error=/실패|못했/.test(title);
 const icon=empty?(/멤버|회원/.test(title)?'users':/검색|조건/.test(title)?'search':'folder'):error?'alert':'check';
 return '<section class="v38-state'+(empty?' is-empty':error?' is-error':busy?' is-busy':'')+'" role="status"'+(busy?' aria-busy="true"':'')+'>'+(busy?'<span class="spinner" aria-hidden="true"></span>':F.icon(icon))+'<h3 tabindex="-1">'+e(title)+'</h3>'+(detail?'<p>'+e(detail)+'</p>':'')+'</section>';
};
const notice=(text)=>'<p class="v38-error" role="alert">'+e(text)+'</p>';
const form=(id,body,action,label)=>'<form id="v38-engage-'+id+'" data-scope="'+id+'" data-submit="'+action+'" novalidate>'+body+'<button type="submit" class="primary">'+e(label)+'</button></form>';
const modal=(id,title,body,footer=close())=>{
 const h=document.createElement('div');h.innerHTML=body;
 if(['donate','membership','mission'].includes(id)&&h.querySelector('form')){const r=F.broadcasts[channel()]||F.broadcasts[0],identity=document.createElement('div');identity.className='v38-recipient';identity.innerHTML=F.avatar(r.initial,'round')+'<strong>'+e(r.name)+'</strong>';h.prepend(identity);}
 const list=h.querySelector('.v38-tabs');if(list){const panel=document.createElement('section');panel.id='v38-'+id+'-panel';panel.setAttribute('role','tabpanel');list.querySelectorAll('[role="tab"]').forEach((tab,i)=>{tab.id='v38-'+id+'-tab-'+i;tab.setAttribute('aria-controls',panel.id);if(tab.getAttribute('aria-selected')==='true')panel.setAttribute('aria-labelledby',tab.id);});let next=list.nextElementSibling;while(next){const following=next.nextElementSibling;panel.append(next);next=following;}list.after(panel);}
 h.querySelectorAll('form>button[type="submit"]').forEach(button=>{button.setAttribute('form',button.closest('form').id);footer+=button.outerHTML;button.remove();});
 return {title,body:'<section class="v38-engage" data-v38-scope="'+id+'">'+h.innerHTML+'</section>',footer,cls:'v33-engagement v38-engagement'};
};
const tabs=(id,labels,selected)=>'<div class="page-tabs v38-tabs" role="tablist" aria-label="참여 메뉴">'+labels.map(t=>btn(t,'tab','data-scope="'+id+'" data-tab="'+e(t)+'" role="tab" aria-selected="'+(t===selected)+'" tabindex="'+(t===selected?0:-1)+'"',t===selected?'active':'')).join('')+'</div>';
const who=()=>F.broadcasts[channel()]?.name||'개발하는 봄';
const refresh=(focus='')=>{if(S.dialog)rerenderDialog();else F.modalScreens.has(F.screen)?F.renderModal():F.render();if(focus)F.dialog.querySelector(focus)?.focus({preventScroll:true});};
const invalidate=(id,errors)=>{S.errors[id]=errors;if(!Object.keys(errors).length)return false;refresh('#v38-'+id+'-'+Object.keys(errors)[0]);return true;};
function request(id,work){
 if(S.busy.has(id))return;S.busy.add(id);refresh();const token=++S.job;
 setTimeout(()=>{if(token!==S.job){S.busy.delete(id);return;}S.busy.delete(id);work();if(F.screen===id)refresh();},400);
}
function fixture(id,viewState){
 const key=channel()+':'+id+':'+viewState;if(S.fixture.has(key))return;
 if(id==='donate'&&viewState==='완료'){
  let r=D.donations.find(r=>r.channelId===channel());if(!r){r={id:uid('donation-fixture'),channelId:channel(),user:viewer(),userName:F.nickname,type:'메시지',amount:5000,message:'',status:'결제 확인 대기',createdAt:now(),source:'design-state-fixture'};D.donations.unshift(r);D.transactions?.unshift({...r,kind:'메시지 후원'});}
  S.lastDonation=r;S.subview.donate='receipt';S.fixture.add(key);
 }
 if(id==='rewards'&&viewState==='포인트 부족'){D.wallets[channel()]=200;S.fixture.add(key);}
 if(id==='rewards'&&viewState==='교환 완료'&&(!S.lastReward||S.lastReward.channelId!==channel())){
   let r=D.rewards.find(r=>(r.channelId??0)===channel());if(!r){r={id:'reward-fixture-'+channel(),channelId:channel(),name:'다음 작업 제안',points:1000,cost:1000};D.rewards.push(r);}
   if(wallet()<r.points)D.wallets[channel()]=3400;
   const row={id:uid('redemption'),channelId:channel(),rewardId:r.id,name:r.name,user:viewer(),userName:F.nickname,cost:r.points,status:'신청 대기',createdAt:now()};
   D.redemptions.push(row);addPoints(-row.cost,row.name,row.id);S.lastReward=row;S.subview.rewards='receipt';S.fixture.add(key);
 }
}
F.modals.donate=viewState=>{
 fixture('donate',viewState);const d=draft('donate');if(S.busy.has('donate')||viewState==='처리 중')return modal('donate','후원하기',state('후원 내용을 확인하고 있어요.'));
 if((S.subview.donate==='receipt'||viewState==='완료')&&S.lastDonation){const r=S.lastDonation;return modal('donate','후원 내역',state('후원 신청이 등록됐어요.')+summary([['채널',who()],['금액',money(r.amount)],['상태',r.status],['메시지',r.message||'없음']]),btn('다른 후원하기','donate-again')+close());}
 if(S.preview)return modal('donate',d.kind+' 후원 확인',summary([['유형',d.kind],['금액',d.amount],['내용',d.message||d.video],['시작',d.kind==='영상'?d.start:'처음부터']])+'<div class="v38-preview" role="status">'+e(d.kind==='음성'?d.message:'선택한 영상과 시작 시점을 확인하세요.')+'</div>',btn('수정','preview-back')+btn('확인','preview-back','','primary'));
 const media=d.kind==='영상'?field('donate','video','영상 주소',{max:500,placeholder:'https://'})+field('donate','start','재생 시작',{max:8,placeholder:'00:00'}):'';
 return modal('donate','후원하기',tabs('donate',['메시지','음성','영상'],d.kind)+form('donate','<div class="v38-amounts">'+[1000,5000,10000].map(a=>btn(money(a),'amount','data-amount="'+a+'" aria-pressed="'+(!d.manualAmount&&Number(String(d.amount).replaceAll(',',''))===a)+'"')).join('')+btn('직접 입력','amount','data-amount="manual" aria-pressed="'+!!d.manualAmount+'"')+'</div>'+field('donate','amount','금액',{max:32,numeric:true})+media+field('donate','message',d.kind==='음성'?'읽어줄 메시지':'메시지 (선택)',{area:true,max:300})+(d.kind!=='메시지'?btn('내용 미리보기','preview'):'' )+choice('donate','payment','결제 방법',['카드','간편결제'])+consent('donate')+(viewState==='결제 실패'?notice('결제를 확인하지 못했어요. 입력 내용을 확인하고 다시 시도하세요.'):''),
 'donate-submit',(parseAmount(d.amount).error?'':money(parseAmount(d.amount).value)+' ')+'후원 신청'),cancel());
};
F.modals.membership=viewState=>{
 const d=draft('membership'),member=D.memberships.find(m=>m.channelId===channel()&&m.user===viewer()),sub=S.subview.membership;
 if(S.busy.has('membership'))return modal('membership','멤버십',state('가입 내용을 확인하고 있어요.'));
 if(member&&member.status!=='가입 준비'&&!d.gift){
  if(member.status==='가입 확인 대기')return modal('membership','멤버십 신청 내역',summary([['채널',who()],['상태','가입 확인 대기'],['이용 시작','결제 확인 후 안내']]),btn('신청 취소','membership-pending-cancel')+btn('멤버십 선물','membership-gift')+close());
  const cancelled=member.status==='해지 예약',expired=member.status==='만료';
  if(sub==='cancel')return modal('membership','자동 갱신을 해지할까요?',summary([['이용 종료일',member.endsAt],['해지 후',member.endsAt+'까지 혜택 유지']]),btn('이전으로','membership-back')+btn('자동 갱신 해지','membership-cancel','','danger'));
  return modal('membership','내 멤버십',summary([['채널',who()],['상태',member.status],['다음 결제일',cancelled||expired?'자동 결제 없음':member.renewsAt],['이용 종료일',member.endsAt]])+'<div class="v38-benefits">'+e(D.benefits).replaceAll('\n','<br>')+'</div>',(expired?btn('다시 가입','membership-renew','','primary'):cancelled?btn('자동 갱신 다시 켜기','membership-restore'):btn('자동 갱신 해지','membership-cancel-open'))+btn('멤버십 선물','membership-gift')+close());
 }
 if(sub==='gift-receipt')return modal('membership','멤버십 선물',state('선물 신청이 등록됐어요.',d.recipient)+summary([['상태','수령 대기'],['금액',money(4900*Number(d.count))]]),btn('멤버십으로','membership-back')+close());
 return modal('membership',d.gift?'멤버십 선물':'멤버십 가입','<div class="v38-benefits">'+e(D.benefits).replaceAll('\n','<br>')+'</div>'+form('membership',(d.gift?field('membership','recipient','받는 사람',{max:200,placeholder:'닉네임을 쉼표로 구분'})+choice('membership','count','수량',['1','5','10']):'')+choice('membership','payment','결제 방법',['카드','간편결제'])+consent('membership')+(viewState==='결제 실패'?notice('결제 내용을 확인하지 못했어요. 다시 시도하세요.'):''),
 'membership-submit',d.gift?money(4900*Number(d.count))+' 선물 신청':'월 4,900원 가입 신청'),btn(d.gift?'가입으로':'멤버십 선물','membership-gift')+close());
};
F.modals.mission=viewState=>{
 const d=draft('mission'),mine=D.missions.filter(m=>m.channelId===channel()&&m.user===viewer()).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))),selected=D.missions.find(m=>m.id===S.subview.mission)||mine[0];
 if(S.subview.mission==='list')return modal('mission','내 미션',mine.map(m=>'<article class="v38-row"><strong>'+e(m.title)+'</strong><span>'+e(m.status)+'</span>'+btn('상세','mission-current','data-id="'+m.id+'"')+'</article>').join('')||state('제안한 미션이 없어요.'),btn('새 미션 제안','mission-new')+close());
 if(selected&&!d.new)return modal('mission','제안한 미션',summary([['제목',selected.title],['상태',selected.status],['유형',selected.type],['기한',selected.limit],['사유',selected.reason||'없음'],...(selected.amount?[['금액',money(selected.amount)],['결제 상태',selected.paymentStatus||'결제 확인 대기']]:[])])+'<p class="v38-description">'+e(selected.condition||'')+'</p>',(['접수','진행 중'].includes(selected.status)?btn('제안 취소','mission-cancel','data-id="'+selected.id+'"'):'' )+btn('내 미션 목록','mission-list')+btn('새 미션 제안','mission-new')+close());
 return modal('mission','미션 제안',form('mission',choice('mission','type','미션 유형',['무료 미션','미션 후원'])+field('mission','title','미션 제목',{max:80})+field('mission','condition','완료 조건',{area:true,max:500})+choice('mission','time','제한 시간',['30분','1시간','방송 종료 전'])+(d.type==='미션 후원'?field('mission','amount','후원 금액',{max:32,numeric:true})+choice('mission','payment','결제 방법',['카드','간편결제'])+consent('mission'):''),'mission-submit','제안하기'),cancel());
};
F.modals.poll=viewState=>{
 D.normalizePolls();const d=draft('poll'),ps=D.polls.filter(p=>(p.channelId??0)===channel()),p=ps.find(p=>p.id===d.pollId)||ps.find(p=>p.open)||ps.at(-1);
 let body='',footer=close();const tab=d.tab||'투표';
 if(tab==='질문'){
  const rows=D.questions.filter(q=>q.channelId===channel()&&q.user===viewer());
  body=form('poll',field('poll','question','방송자에게 질문',{area:true,max:300}),'question-submit','질문 보내기')+rows.map(q=>'<article class="v38-row"><span>'+e(q.text)+'</span><small>'+e(q.pinned?'고정 · '+q.status:q.status)+'</small>'+(q.answer?'<p>'+e(q.answer)+'</p>':'')+'</article>').join('');
 }else if(tab==='예측'){
  const p=D.predictions.filter(p=>(p.channelId??0)===channel()).at(-1),entry=p?.entries?.find(r=>r.user===viewer());
  body=!p?state('진행 중인 예측이 없어요.'):summary([['예측',p.title],['상태',p.status],['내 포인트',wallet()+' P']])+p.options.map(o=>btn(o.text,'predict-option','data-id="'+p.id+'" data-option="'+o.id+'"'+(p.status!=='진행 중'||entry?' disabled':''),d.predictionOption===o.id?'selected':'')).join('')+(entry?summary([['내 참여',p.options.find(o=>o.id===entry.optionId)?.text||''],['사용 포인트',entry.points+' P'],['결과',entry.status||'결과 대기']]):p.status==='진행 중'?form('poll',field('poll','stake','참여 포인트',{max:12,numeric:true}),'predict-submit','예측 참여'):'')+(err('poll','predictionOption')?notice(err('poll','predictionOption')):'');
  if(p&&['결과 확정','취소'].includes(p.status))body+=summary([['확정 결과',p.status==='취소'?'예측 취소':p.options.find(o=>o.id===p.result)?.text||'결과 없음'],['반환 포인트',(entry?.returned||0)+' P']]);
 }else if(!p)body=state('진행 중인 투표가 없어요.');
 else{
  const vote=p.voters[viewer()],total=p.options.reduce((n,o)=>n+Number(o.votes||0),0),closed=!p.open||viewState==='마감',ratios=D.pollPercentages(p);
  body='<h3>'+e(p.question)+'</h3><div class="v38-poll-options" role="'+(vote||closed?'group':'radiogroup')+'">'+p.options.map((o,i)=>{
   const pct=ratios[i];
   return btn(o.text+(vote===o.id?' · 내 선택':'')+(vote||closed?' '+pct+'%':''),'poll-option','data-id="'+p.id+'" data-option="'+o.id+'"'+(vote||closed?' disabled':' role="radio" aria-checked="'+(d.selected===o.id)+'"'),d.selected===o.id?'selected':'');}).join('')+'</div><p class="v38-meta">'+total+'명 참여 · '+(closed?'마감':vote?'투표 완료':'진행 중')+'</p>';
  if(!vote&&!closed)footer=btn('투표하기','poll-vote','data-id="'+p.id+'"'+(!d.selected?' disabled':''),'primary')+close();
 }
 return modal('poll','투표 및 질문',tabs('poll',['투표','질문','예측'],tab)+(tab==='투표'&&ps.length>1?btn(p.question,'poll-picker','aria-label="투표 선택" aria-haspopup="listbox"','choice-button'):'')+body,footer);
};
F.modals.rewards=viewState=>{
 fixture('rewards',viewState);const sub=S.lastReward&&S.lastReward.channelId!==channel()&&S.subview.rewards==='receipt'?'list':S.subview.rewards||'list',r=D.rewards.find(r=>r.id===draft('rewards').selected);
 if(sub==='requests'){const rows=D.redemptions.filter(r=>r.channelId===channel()&&r.user===viewer());return modal('rewards','보상 신청 내역',rows.length?rows.map(r=>'<article class="v38-row"><strong>'+e(r.name)+'</strong><span>'+e(r.status)+'</span>'+btn('상세','reward-detail','data-id="'+r.id+'"')+'</article>').join(''):state('신청한 보상이 없어요.'),btn('보상 목록','reward-list')+close());}
 if(sub==='receipt'&&S.lastReward){const x=S.lastReward;return modal('rewards','신청 내역',state('보상 신청이 등록됐어요.')+summary([['보상',x.name],['사용 포인트',x.cost+' P'],['잔액',wallet()+' P'],['상태',x.status],['사유',x.reason||'없음']]),(x.status==='신청 대기'?btn('신청 취소','reward-cancel-request','data-id="'+x.id+'"'):'' )+btn('포인트 기록','reward-history')+close());}
 if(sub==='history')return modal('rewards','포인트 기록',D.ledger.filter(r=>r.channelId===channel()).map(r=>'<article class="v38-row"><strong>'+e(r.label)+'</strong><span>'+ (r.amount>0?'+':'')+r.amount.toLocaleString()+' P</span><small>잔액 '+r.balance.toLocaleString()+' P</small></article>').join('')||state('포인트 기록이 없어요.'),btn('보상 목록','reward-list')+close());
 if(sub==='confirm'&&r)return modal('rewards','보상을 신청할까요?',summary([['보상',r.name],['필요 포인트',r.points+' P'],['신청 후',wallet()-r.points+' P']]),btn('취소','reward-list')+btn('신청하기','reward-confirm','data-id="'+r.id+'"'+(wallet()<r.points?' disabled':''),'primary'));
 const rows=D.rewards.filter(r=>(r.channelId??0)===channel());
 return modal('rewards','포인트 보상',summary([['내 포인트',wallet().toLocaleString()+' P']])+'<div class="v38-reward-grid">'+rows.map(r=>btn(r.name+' · '+r.points.toLocaleString()+' P','reward-select','data-id="'+r.id+'"'+(wallet()<r.points?' disabled':''))).join('')+'</div>'+(!rows.length?state('등록된 보상이 없어요.'):'')+btn('포인트 적립 안내','earning-info'),btn('신청 내역','reward-requests')+btn('포인트 기록','reward-history')+close());
};
F.modals.devices=viewState=>{
 const d=D.devices;if(d.pending)return modal('devices','다른 기기에서 보기',state('기기에 연결하고 있어요.'));
 if(d.active)return modal('devices','다른 기기에서 보기',state(d.active.name+' 연결 중')+summary([['연결 상태','유지됨']]),btn('연결 해제','device-disconnect')+close());
 return modal('devices','다른 기기에서 보기',(d.error||viewState==='연결 실패'?notice('기기에 연결하지 못했어요. 전원과 연결 상태를 확인하세요.'):'')+(viewState==='기기 없음'?state('연결할 기기가 없어요.'):['거실 TV','회의실 화면'].map((name,i)=>'<article class="v38-row"><strong>'+name+'</strong>'+btn(d.error?'다시 연결':'연결','device-connect','data-id="'+i+'" data-name="'+name+'"')+'</article>').join('')),btn('다시 찾기','device-search')+close());
};
F.pages['drop-rewards']=viewState=>{
 const x=D.drops;if(viewState==='수령 가능')x.minutes=Math.max(x.minutes,x.required);if(viewState==='수령 완료')x.claimed=true;
 return F.page('시청 보상','<section class="v38-engage v38-drop"><h2>작업실 함께 보기</h2><p>30분 시청 · 기념 배지</p>'+summary([['시청 시간',x.minutes+' / '+x.required+'분'],['상태',!x.eligible?'참여 자격 없음':x.claimed?'수령 완료':x.minutes>=x.required?'수령 가능':'진행 중']])+(x.error?notice('보상을 수령하지 못했어요. 다시 시도하세요.'):'')+btn(x.claimed?'수령 완료':x.error?'다시 받기':'보상 받기','drop-claim',(!x.eligible||x.claimed||x.minutes<x.required?'disabled':''),'primary')+(!x.eligible?'<p>이 보상의 참여 조건을 충족하지 않았어요.</p>':'')+'</section>');
};


/* Finance and subscription detail prototypes share the same local rows. */
D.transactions||=Array.from({length:146},(_,i)=>({id:'txn-'+(i+1),channelId:i%4,user:'사용자 '+String(i+1).padStart(3,'0'),kind:['메시지 후원','음성 후원','영상 후원','멤버십','미션 후원'][i%5],amount:[5000,1000,10000,4900,2000][i%5],status:i%8===0?'환불 완료':'결제 완료',createdAt:new Date(Date.UTC(2026,10,2-(i%31),14,i%60)).toISOString()}));
D.settlement||={type:'개인',name:'',bank:'',last4:'',status:'미등록',reason:'',details:[{id:'payout-1',amount:128400,date:'2026-11-10',status:'지급 예정'},{id:'payout-2',amount:94600,date:'2026-10-10',status:'지급 완료'},{id:'payout-3',amount:24000,date:'2026-09-10',status:'지급 실패',reason:'지급 계좌 확인 필요'}]};
D.sponsors||=[{id:'sponsor-1',title:'작업실 장비 소개',type:'스폰서',status:'검토 중',amount:300000,period:'2026.11.01 – 11.30',terms:'방송 중 제품 소개 · 광고 표시 필수'},{id:'ad-1',title:'방송 시작 광고',type:'광고',status:'집계 중',amount:12000,period:'2026.11.01 – 11.02',terms:'확정 금액은 정산 내역에서 확인'}];
const date=s=>String(s||'').slice(0,10).replaceAll('-','.');
const settingsFor=id=>S.list[id]||(S.list[id]={q:'',status:'전체',kind:'전체',from:'',to:'',sort:'최신순',page:0});
function listRows(id,all){
 const f=settingsFor(id);return all.filter(r=>(!f.q||Object.values(r).filter(v=>typeof v==='string').join(' ').toLocaleLowerCase().includes(f.q.toLocaleLowerCase()))&&(f.status==='전체'||r.status===f.status)&&(f.kind==='전체'||r.kind===f.kind)&&(!f.from||String(r.createdAt).slice(0,10)>=f.from)&&(!f.to||String(r.createdAt).slice(0,10)<=f.to)).sort((a,b)=>f.sort==='금액순'?b.amount-a.amount:f.sort==='오래된순'?String(a.createdAt).localeCompare(String(b.createdAt)):String(b.createdAt).localeCompare(String(a.createdAt)));
}
S.filteredRows=(id)=>listRows(id,id==='members'?D.memberships:D.transactions);
function tools(id,all){
 const f=settingsFor(id),statuses=['전체',...new Set(all.map(r=>r.status))],kinds=['전체',...new Set(all.map(r=>r.kind).filter(Boolean))];
 return '<form id="v38-list-form" data-scope="'+id+'" class="v38-list-tools" novalidate><label class="sr-only" for="v38-list-query">내역 검색</label><input id="v38-list-query" name="q" type="search" maxlength="100" value="'+e(f.q)+'" placeholder="이름 또는 내역 검색"><label class="sr-only" for="v38-list-from">시작일</label><input id="v38-list-from" name="from" type="date" value="'+e(f.from)+'" aria-label="시작일"><input name="to" type="date" value="'+e(f.to)+'" aria-label="종료일"><button class="primary" type="submit">검색</button>'+btn('초기화','list-reset','data-scope="'+id+'"')+'</form><div class="v38-list-filters">'+[['status',statuses],['kind',kinds],['sort',['최신순','오래된순','금액순']]].map(([key,options])=>btn(f[key],'list-filter','data-scope="'+id+'" data-key="'+key+'" data-options="'+e(JSON.stringify(options))+'"','choice-button')).join('')+'</div>'+(S.errors[id]?.range?notice(S.errors[id].range):'');
}
function paginated(id,all,renderRow,headers){
 const f=settingsFor(id),rows=listRows(id,all),size=20,pages=Math.max(1,Math.ceil(rows.length/size));f.page=Math.min(f.page,pages-1);
 const section=rows.slice(f.page*size,(f.page+1)*size);
 const filtered=!!(f.q||f.from||f.to||f.status!=='전체'||f.kind!=='전체'),toolbar=all.length||filtered?tools(id,all):'';
 const content=section.length?'<div class="table-panel v38-table"><table><thead><tr>'+headers.map(t=>'<th scope="col">'+e(t)+'</th>').join('')+'</tr></thead><tbody>'+section.map(renderRow).join('')+'</tbody></table></div>':state(filtered?'조건에 맞는 내역이 없어요.':id==='members'?'가입한 멤버가 없어요.':'아직 내역이 없어요.');
 const footer=rows.length?'<div class="v38-pagination"><span>'+rows.length.toLocaleString()+'개 · '+(f.page+1)+' / '+pages+'</span>'+btn('이전','page','data-scope="'+id+'" data-page="'+(f.page-1)+'"'+(f.page<=0?' disabled':''))+btn('다음','page','data-scope="'+id+'" data-page="'+(f.page+1)+'"'+(f.page>=pages-1?' disabled':''))+'</div>':'';
 return toolbar+content+footer;
}
const cell=(label,value)=>'<td data-label="'+label+'">'+value+'</td>';
F.pages.transactions=viewState=>{
 const all=viewState==='내역 없음'?[]:D.transactions;
 return F.page('결제 내역','<section class="v38-finance">'+paginated('transactions',all,r=>'<tr>'+cell('결제일',date(r.createdAt))+cell('내용',e(r.kind))+cell('금액',money(r.amount))+cell('상태',e(D.refunds.find(x=>x.transactionId===r.id)?.status||r.status))+cell('관리',btn('상세','transaction','data-id="'+r.id+'"','small'))+'</tr>',['결제일','내용','금액','상태','관리'])+'</section>');
};
F.pages.members=viewState=>{
 const all=viewState==='가입자 없음'?[]:D.memberships;
 return F.page('멤버십 관리','<section class="v38-finance">'+paginated('members',all,r=>'<tr>'+cell('가입일',date(r.createdAt))+cell('닉네임',e(r.userName||(r.user===viewer()?F.nickname:r.user)))+cell('가입 상태',e(r.status))+cell('기간',e(r.endsAt))+cell('관리',btn('상세','member-detail','data-id="'+r.id+'"','small'))+'</tr>',['가입일','닉네임','가입 상태','기간','관리'])+'<section class="v38-benefits"><h2>멤버십 혜택</h2><p>'+e(D.benefits).replaceAll('\n','<br>')+'</p>'+btn('혜택 수정','benefits')+'</section></section>');
};
F.pages.revenue=viewState=>{
 const tab=S.mode.revenueTab||'수익 내역',st=D.settlement;
 let body='';
 if(tab==='정산')body='<section class="v38-finance-card"><h2>정산 정보</h2>'+summary([['유형',st.type],['등록 상태',st.status],...(st.last4?[['지급 계좌',st.bank+' · ****'+st.last4]]:[]),...(st.reason?[['확인할 내용',st.reason]]:[])])+btn(st.status==='미등록'?'정산 정보 등록':st.status==='보완 요청'?'정보 보완':'정보 수정','settlement-open','','primary')+'</section><section class="v38-finance-card"><h2>정산 내역</h2>'+st.details.map(r=>'<article class="v38-row"><span>'+r.date+'</span><strong>'+money(r.amount)+'</strong><span>'+e(r.status)+'</span>'+btn('상세','payout-detail','data-id="'+r.id+'"')+'</article>').join('')+'</section>';
 else if(tab==='광고·스폰서')body=D.sponsors.map(r=>'<article class="v38-finance-card"><div class="row"><h2>'+e(r.title)+'</h2><span>'+e(r.type)+'</span></div>'+summary([['기간',r.period],['상태',r.status],['금액',money(r.amount)]])+btn('상세','sponsor-detail','data-id="'+r.id+'"')+'</article>').join('');
 else if(tab==='후원 대기열')body=D.donations.length?D.donations.map(r=>'<article class="v38-finance-card"><h2>'+e(r.type)+' 후원</h2><p>'+e(r.message||r.url||'메시지 없음')+'</p>'+summary([['금액',money(r.amount)],['상태',r.status]])+btn('내용 확인','donation-detail','data-id="'+r.id+'"')+'</article>').join(''):state('확인할 후원 신청이 없어요.');
 else if(tab==='환불 검토')body=D.refunds.length?D.refunds.map(r=>'<article class="v38-row"><strong>'+e(r.transactionId)+'</strong><span>'+money(r.amount)+' · '+e(r.status)+'</span>'+btn('검토','refund-review','data-id="'+r.id+'"')+'</article>').join(''):state('검토할 환불 요청이 없어요.');
 else body=paginated('revenue',D.transactions,r=>'<tr>'+cell('일시',date(r.createdAt))+cell('구분',e(r.kind))+cell('이용자',e(r.userName||(r.user===viewer()?F.nickname:r.user)))+cell('금액',money(r.amount))+cell('상태',e(r.status))+cell('관리',btn('상세','transaction','data-id="'+r.id+'"','small'))+'</tr>',['일시','구분','이용자','금액','상태','관리']);
 return F.page('수익 및 정산','<section class="v38-finance">'+tabs('revenue',['수익 내역','정산','광고·스폰서','후원 대기열','환불 검토'],tab)+body+'</section>',tab==='수익 내역'?btn('현재 페이지 다운로드','csv','data-scope="revenue"'):'');
};
function openDialog(title,body,footer,context){
 S.dialog=context;F.genericDialog(title,'<section class="v38-engage">'+body+'</section>','');
 F.dialog.classList.add('v38-engagement');F.dialog.querySelector('.modal-footer').innerHTML=footer||btn('닫기','dialog-close');
 F.dialog.querySelectorAll('form>button[type="submit"]').forEach(button=>{button.setAttribute('form',button.closest('form').id);F.dialog.querySelector('.modal-footer').append(button);});
 const x=F.dialog.querySelector('.modal-head button');if(x)x.dataset.action='v38-engage-dialog-close';
 F.dialog.querySelector('input:not([disabled]),textarea,button')?.focus({preventScroll:true});
}
function transaction(id){
 const r=D.transactions.find(x=>x.id===id);if(!r)return;
 const refund=D.refunds.find(x=>x.transactionId===id);
 openDialog('결제 상세',summary([['거래 번호',r.id],['결제일',date(r.createdAt)],['내용',r.kind],['금액',money(r.amount)],['상태',refund?.status||r.status]])+(refund?summary([['요청 사유',refund.reason],['결과 사유',refund.decision||'검토 결과 대기'],['환불 금액',money(refund.amount)]]):''),
 (refund?btn('환불 요청 내역','refund-detail','data-id="'+refund.id+'"'):r.status==='결제 완료'?btn('환불 요청','refund-open','data-id="'+r.id+'"'):'')+btn('닫기','dialog-close'),{kind:'transaction',id});
}
function refundForm(id){
 const r=D.transactions.find(x=>x.id===id),d=draft('refund');if(!r)return;
 openDialog('환불 요청',summary([['대상',r.kind],['금액',money(r.amount)]])+form('refund',field('refund','reason','요청 사유',{area:true,max:500})+consent('refund'),'refund-submit','환불 요청'),btn('취소','dialog-close'),{kind:'refund',id,parent:{kind:'transaction',id}});
}
function refundDetail(id){
 const r=D.refunds.find(x=>x.id===id);if(!r)return;
 openDialog('환불 요청 내역',summary([['접수 번호',r.id],['상태',r.status],['대상 거래',r.transactionId],['금액',money(r.amount)],['사유',r.reason],['결과 안내',r.decision||'검토 중에는 원래 결제 상태를 유지해요.']]),(r.status==='접수'?btn('요청 취소','refund-withdraw','data-id="'+r.id+'"'):'')+btn('결제 상세','transaction','data-id="'+r.transactionId+'"')+btn('닫기','dialog-close'),{kind:'refund-detail',id,parent:{kind:'transaction',id:r.transactionId}});
}
function refundReview(id){
 const r=D.refunds.find(r=>r.id===id);if(!r)return;
 const d=draft('refund-review');d.decision||='승인';d.note??='';
 openDialog('환불 요청 검토',summary([['거래',r.transactionId],['금액',money(r.amount)],['사유',r.reason],['상태',r.status]])+
 (r.status==='검토 중'?form('refund-review',choice('refund-review','decision','검토 결과',['승인','거절'])+field('refund-review','note','검토 사유',{area:true,max:500}),'refund-review-submit','검토 결과 저장'):r.status==='승인'?'<p>승인된 요청은 환불 결과 확인을 기다리고 있어요.</p>':r.decision?'<p>'+e(r.decision)+'</p>':''),
 (r.status==='접수'?btn('검토 시작','refund-start','data-id="'+id+'"','primary'):'')+btn('닫기','dialog-close'),{kind:'refund-review',id});
}
function settlementForm(){
 const st=D.settlement,d=draft('settlement');d.type||=st.type;d.name??=st.name;d.bank||=st.bank||'은행 선택';d.account??='';d.business??='';
 openDialog('정산 정보 등록',form('settlement',choice('settlement','type','정산 유형',['개인','사업자'])+field('settlement','name','예금주',{max:30})+choice('settlement','bank','은행',['국민은행','신한은행','우리은행','하나은행','농협은행'])+field('settlement','account','계좌번호',{max:24,numeric:true})+(d.type==='사업자'?field('settlement','business','사업자등록번호',{max:12,numeric:true}):'')+consent('settlement'),'settlement-submit','등록 내용 제출'),btn('취소','dialog-close'),{kind:'settlement'});
}
function closeDialog(){
 const context=S.dialog,parent=context?.parent;S.dialog=null;
 if(context?.kind==='policy'){S.dialog=context.returnDialog||null;if(S.dialog)rerenderDialog();else refresh();return;}
 if(parent?.kind==='transaction'){transaction(parent.id);return;}
 original.close();
}
D.resolveRefund=(id,status,reason='')=>{
 const r=D.refunds.find(r=>r.id===id);if(!r||['완료','거절','취소'].includes(r.status))return false;
 const allowed={'접수':['검토 중','취소'],'검토 중':['승인','거절'],'승인':['완료','지급 실패'],'지급 실패':['검토 중']};
 if(!(allowed[r.status]||[]).includes(status))return false;
 r.status=status;r.decision=reason;r.updatedAt=now();
 if(status==='완료'){const t=D.transactions.find(t=>t.id===r.transactionId);if(t)t.status='환불 완료';}return true;
};
S.openRefund=refundDetail;S.openTransaction=transaction;S.openSettlement=settlementForm;
S.setScenario=(screen,value)=>{
 if(screen==='drop-rewards')Object.assign(D.drops,value);
 else if(screen==='settlement')Object.assign(D.settlement,value);
 else if(screen==='refund'){const r=D.refunds.find(x=>x.id===value.id);if(r)Object.assign(r,value);}
 else S.mode[screen]=value;
 F.render();
};

function donationDetail(id){
 const r=D.donations.find(r=>r.id===id);if(!r)return;
 openDialog('후원 내용 확인',summary([['유형',r.type],['금액',money(r.amount)],['상태',r.status],['내용',r.message||'메시지 없음'],...(r.url?[['영상 주소',r.url],['재생 시작',r.start]]:[])]),
 (['승인 대기','결제 확인 대기'].includes(r.status)?btn('승인','donation-state','data-id="'+id+'" data-state="재생 대기"','primary')+btn('거절','donation-reject','data-id="'+id+'"','danger'):r.status==='재생 대기'?btn('재생 시작','donation-state','data-id="'+id+'" data-state="재생 중"','primary'):r.status==='재생 중'?btn('다음으로','donation-state','data-id="'+id+'" data-state="건너뜀"'):'' )+btn('닫기','dialog-close'),{kind:'donation',id});
}
function rerenderDialog(){
 const c=S.dialog;if(!c)return;
 if(c.kind==='refund')refundForm(c.id);else if(c.kind==='settlement')settlementForm();else if(c.kind==='donation')donationDetail(c.id);
 else if(c.kind==='transaction')transaction(c.id);else if(c.kind==='refund-detail')refundDetail(c.id);else if(c.kind==='refund-review')refundReview(c.id);
 else if(c.kind==='benefits')openDialog('멤버십 혜택 수정',form('benefits',field('benefits','benefits','혜택',{area:true,max:500}),'benefits-submit','저장'),btn('취소','dialog-close'),c);
}
function submitForm(id,action){
 const d=draft(id),errors={};
 if(['donate','membership','mission','poll','refund'].includes(id)&&!F.sessionLoggedIn){F.authReturn=F.screen;F.navigate('login');return;}
 if(['settlement-submit','benefits-submit'].includes(action)&&F.v38Access&&F.v38Access.role!=='owner')return;
 if(action==='donate-submit'||action==='membership-submit'||(action==='mission-submit'&&d.type==='미션 후원')){
  if(!d.payment)errors.payment='결제 방법을 선택하세요.';if(!d.consent)errors.consent='결제 내용과 기준을 확인하세요.';
 }
 if(action==='donate-submit'||action==='mission-submit'&&d.type==='미션 후원'){
  const parsed=parseAmount(d.amount);if(parsed.error)errors.amount=parsed.error;
 }
 if(action==='donate-submit'){
  if(d.kind==='음성'&&!d.message.trim())errors.message='읽어줄 메시지를 입력하세요.';
  if(d.kind==='영상'){try{const u=new URL(d.video);if(u.protocol!=='https:'||!u.hostname||u.username||u.password)throw Error();}catch{errors.video='https://로 시작하는 영상 주소를 입력하세요.';}
   if(!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(d.start)||d.start.split(':').slice(1).some(v=>Number(v)>59))errors.start='분:초 또는 시:분:초로 입력하세요.';}
  if(invalidate(id,errors))return;
  request(id,()=>{const r={id:uid('donation'),channelId:channel(),user:viewer(),userName:F.nickname,type:d.kind,amount:parseAmount(d.amount).value,message:d.message,url:d.video,start:d.start,status:'결제 확인 대기',createdAt:now()};
   D.donations.unshift(r);D.transactions.unshift({...r,kind:d.kind+' 후원'});S.lastDonation=r;S.subview.donate='receipt';});return;
 }
 if(action==='membership-submit'){
  if(d.gift){
   const recipients=d.recipient.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean),unique=new Set(recipients.map(x=>x.toLocaleLowerCase()));
   if(recipients.length!==Number(d.count))errors.recipient='선물 수량과 받는 사람 수를 맞추세요.';
   else if(unique.size!==recipients.length)errors.recipient='받는 사람이 중복됐어요.';
   else if(recipients.some(name=>D.gifts.some(g=>g.channelId===channel()&&g.recipient.toLocaleLowerCase()===name.toLocaleLowerCase()&&g.status!=='취소')))errors.recipient='이미 선물 신청이 있는 대상이에요. 다른 사람을 선택하세요.';
   else if(recipients.some(name=>name===F.nickname))errors.recipient='자신에게는 선물할 수 없어요.';
  }
  if(invalidate(id,errors))return;
  request(id,()=>{if(d.gift){d.recipient.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean).forEach(recipient=>D.gifts.push({id:uid('gift'),channelId:channel(),recipient,status:'수령 대기',createdAt:now()}));S.subview.membership='gift-receipt';}
   else{const old=D.memberships.find(m=>m.channelId===channel()&&m.user===viewer()),m={id:old?.id||uid('membership'),channelId:channel(),user:viewer(),userName:F.nickname,status:'가입 확인 대기',renewsAt:'결제 확인 후 안내',endsAt:'결제 확인 후 안내',createdAt:now(),amount:4900,kind:'멤버십'};if(old)Object.assign(old,m);else D.memberships.push(m);S.lastMembership=m;}
   D.transactions.unshift({id:uid('txn'),channelId:channel(),user:viewer(),userName:F.nickname,kind:d.gift?'멤버십 선물':'멤버십',amount:4900*Number(d.gift?d.count:1),status:'결제 확인 대기',createdAt:now()});});return;
 }
 if(action==='mission-submit'){
  if(!d.title.trim())errors.title='미션 제목을 입력하세요.';if(!d.condition.trim())errors.condition='완료 조건을 입력하세요.';if(invalidate(id,errors))return;
  const r={id:uid('mission'),channelId:channel(),user:viewer(),userName:F.nickname,title:d.title.trim(),condition:d.condition.trim(),type:d.type,limit:d.time,status:'접수',amount:d.type==='미션 후원'?parseAmount(d.amount).value:0,paymentStatus:d.type==='미션 후원'?'결제 확인 대기':'해당 없음',createdAt:now()};
  D.missions.unshift(r);S.subview.mission=r.id;d.new=false;refresh();return;
 }
 if(action==='question-submit'){
  if(!d.question.trim())errors.question='질문을 입력하세요.';if(invalidate(id,errors))return;
  D.questions.unshift({id:uid('question'),channelId:channel(),user:viewer(),userName:F.nickname,text:d.question.trim(),status:'대기',pinned:false,answer:'',createdAt:now()});d.question='';refresh();return;
 }
 if(action==='predict-submit'){
  const p=D.predictions.filter(p=>(p.channelId??0)===channel()).at(-1),n=parseAmount(d.stake,1,wallet());
  if(!p||p.status!=='진행 중'||p.entries?.some(r=>r.user===viewer()))return;
  if(!p.options.some(o=>o.id===d.predictionOption))errors.predictionOption='예측 결과를 선택하세요.';if(n.error)errors.stake='보유 포인트 이내의 정수를 입력하세요.';if(invalidate(id,errors))return;
  const r={id:uid('prediction-entry'),user:viewer(),userName:F.nickname,optionId:d.predictionOption,points:n.value,channelId:channel(),status:'결과 대기'};p.entries||=[];p.entries.push(r);const o=p.options.find(o=>o.id===r.optionId);o.total=(o.total||0)+r.points;addPoints(-r.points,'예측 참여',r.id);refresh();return;
 }
 if(action==='refund-submit'){
  if(!d.reason?.trim()||d.reason.trim().length<5)errors.reason='요청 사유를 5자 이상 입력하세요.';if(!d.consent)errors.consent='취소·환불 기준을 확인하세요.';if(invalidate(id,errors))return;
  const t=D.transactions.find(t=>t.id===S.dialog?.id);if(!t||D.refunds.some(r=>r.transactionId===t.id&&!['거절','취소'].includes(r.status)))return;
  const r={id:uid('refund'),transactionId:t.id,reason:d.reason.trim(),amount:t.amount,status:'접수',createdAt:now()};D.refunds.unshift(r);refundDetail(r.id);return;
 }
 if(action==='settlement-submit'){
  if(!d.name?.trim())errors.name='예금주를 입력하세요.';if(!d.bank||d.bank==='은행 선택')errors.bank='은행을 선택하세요.';
  if(!/^\d{8,16}$/.test(d.account?.replaceAll('-','')||''))errors.account='계좌번호는 숫자 8~16자로 입력하세요.';
  if(d.type==='사업자'&&!/^\d{10}$/.test(d.business?.replaceAll('-','')||''))errors.business='사업자등록번호 10자리를 입력하세요.';
  if(!d.consent)errors.consent='정산 정보 확인 기준에 동의하세요.';if(invalidate(id,errors))return;
  Object.assign(D.settlement,{type:d.type,name:d.name.trim(),bank:d.bank,last4:d.account.slice(-4),status:'검토 중',reason:''});d.account='';d.business='';S.dialog=null;original.close();F.render();return;
 }
 if(action==='benefits-submit'){if(!d.benefits?.trim())errors.benefits='혜택을 입력하세요.';if(invalidate(id,errors))return;D.benefits=d.benefits.trim();S.dialog=null;original.close();F.render();}
 if(action==='refund-review-submit'){
  if(F.v38Access&&F.v38Access.role!=='owner')return;if(!d.note?.trim()||d.note.trim().length<5)errors.note='검토 사유를 5자 이상 입력하세요.';if(invalidate(id,errors))return;
  const rid=S.dialog?.id;if(D.resolveRefund(rid,d.decision,d.note.trim()))refundReview(rid);return;
 }
}
window.addEventListener('submit',event=>{
 const form=event.target;
 if(form.id==='v38-list-form'){
  event.preventDefault();event.stopImmediatePropagation();const id=form.dataset.scope,f=settingsFor(id),data=new FormData(form);f.q=String(data.get('q')||'').trim();f.from=String(data.get('from')||'');f.to=String(data.get('to')||'');
  if(f.from&&f.to&&f.from>f.to){S.errors[id]={range:'종료일은 시작일 이후로 선택하세요.'};F.render();return;}S.errors[id]={};f.page=0;F.render();return;
 }
 if(!form.id?.startsWith('v38-engage-'))return;
 event.preventDefault();event.stopImmediatePropagation();submitForm(form.dataset.scope,form.dataset.submit);
},true);
window.addEventListener('input',event=>{
 const input=event.target,key=input.dataset.v38Field;if(!key)return;
 const id=input.closest('[data-scope]')?.dataset.scope||input.closest('[data-v38-scope]')?.dataset.v38Scope;if(!id)return;
 draft(id)[key]=input.type==='checkbox'?input.checked:input.value;
 if(id==='donate'&&key==='amount'){draft(id).manualAmount=true;F.dialog.querySelectorAll('[data-action="v38-engage-amount"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.amount==='manual')));const submit=F.dialog.querySelector('[form="v38-engage-donate"][type="submit"]'),amount=parseAmount(input.value);if(submit)submit.textContent=(amount.error?'':money(amount.value)+' ')+'후원 신청';}
 if(S.errors[id]?.[key]){delete S.errors[id][key];input.removeAttribute('aria-invalid');input.closest('.v38-field')?.querySelector('[role="alert"]')?.remove();}
},true);
window.addEventListener('change',event=>{
 const input=event.target,key=input.dataset.v38Field;if(key&&input.type==='checkbox'){const id=input.closest('[data-scope]')?.dataset.scope;if(id)draft(id)[key]=input.checked;}
},true);
const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
window.addEventListener('click',event=>{
 const b=event.target.closest?.('button[data-action^="v38-engage-"]');if(!b||b.disabled)return;stop(event);
 const action=b.dataset.action.slice(11),id=b.dataset.scope||F.screen,d=draft(id);
 if(!F.sessionLoggedIn&&['poll-vote','reward-confirm','attendance','gift-claim','drop-claim'].includes(action)){F.authReturn=F.screen;F.navigate('login');return;}
 if(F.v38Access&&F.v38Access.role!=='owner'&&['settlement-open','payout-detail','sponsor-detail','donation-state','donation-reject','benefits','refund-review','refund-start','csv'].includes(action))return;
 if(action==='choice'){
  F.openChoice(b,JSON.parse(b.dataset.options),d[b.dataset.key],value=>{d[b.dataset.key]=value;refresh();});return;
 }
 if(action==='tab'){if(id==='revenue')S.mode.revenueTab=b.dataset.tab;else d[id==='donate'?'kind':'tab']=b.dataset.tab;refresh();return;}
 if(action==='amount'){const d=draft('donate');if(b.dataset.amount==='manual'){d.manualAmount=true;refresh('#v38-donate-amount');F.dialog.querySelector('#v38-donate-amount')?.select();}else{d.manualAmount=false;d.amount=b.dataset.amount;refresh('#v38-donate-amount');}return;}
 if(action==='preview'){const d=draft('donate'),errors={};if(d.kind==='음성'&&!d.message.trim())errors.message='읽어줄 메시지를 입력하세요.';if(d.kind==='영상'){try{const u=new URL(d.video);if(u.protocol!=='https:')throw Error();}catch{errors.video='https://로 시작하는 영상 주소를 입력하세요.';}}if(invalidate('donate',errors))return;S.preview=true;refresh();return;}if(action==='preview-back'){S.preview=null;refresh();return;}
 if(action==='donate-again'){S.subview.donate=null;S.lastDonation=null;refresh();return;}
 if(action==='policy'){const returnDialog=S.dialog;openDialog('취소·환불 기준',summary([['결제 확인 전','신청 내용을 취소할 수 있어요.'],['서비스 이용 후','거래와 제공 여부를 확인해 검토해요.'],['처리 결과','결제 내역의 환불 요청에서 확인하세요.']]),btn('돌아가기','policy-back'),{kind:'policy',returnScreen:F.screen,returnDialog});return;}
 if(action==='policy-back'){closeDialog();return;}
 if(action==='membership-gift'){draft('membership').gift=!draft('membership').gift;S.subview.membership=null;refresh();return;}
 if(action==='membership-back'){S.subview.membership=null;draft('membership').gift=false;refresh();return;}
 if(action==='membership-cancel-open'){S.subview.membership='cancel';refresh();return;}
 if(action==='membership-pending-cancel'){const m=D.memberships.find(m=>m.channelId===channel()&&m.user===viewer());if(m)m.status='가입 준비';D.transactions.filter(t=>t.channelId===channel()&&t.user===viewer()&&t.kind==='멤버십'&&t.status==='결제 확인 대기').forEach(t=>t.status='신청 취소');refresh();return;}
 if(['membership-cancel','membership-restore','membership-renew'].includes(action)){
  const m=D.memberships.find(m=>m.channelId===channel()&&m.user===viewer());if(!m)return;
  m.status=action==='membership-cancel'?'해지 예약':action==='membership-renew'?'가입 준비':'이용 중';S.subview.membership=null;refresh();return;
 }
 if(action==='mission-new'){draft('mission').new=true;S.subview.mission=null;refresh();return;}
 if(action==='mission-list'){S.subview.mission='list';refresh();return;}
 if(action==='mission-current'){S.subview.mission=b.dataset.id;draft('mission').new=false;refresh();return;}
 if(action==='mission-cancel'){const m=D.missions.find(m=>m.id===b.dataset.id);if(m)openDialog('미션 제안을 취소할까요?',summary([['미션',m.title],['현재 상태',m.status],['후원 처리',m.amount?'결제 취소 여부 확인 대기':'결제 없음']]),btn('돌아가기','mission-cancel-back')+btn('제안 취소','mission-cancel-confirm','data-id="'+m.id+'"','danger'),{kind:'mission-cancel'});return;}
 if(action==='mission-cancel-back'){S.dialog=null;refresh();return;}if(action==='mission-cancel-confirm'){D.transitionMission(b.dataset.id,'취소','제안자가 취소했어요.');S.dialog=null;refresh();return;}
 if(action==='poll-option'){draft('poll').selected=b.dataset.option;refresh();return;}
 if(action==='poll-picker'){const rows=D.polls.filter(p=>(p.channelId??0)===channel()),labels=rows.map((p,i)=>(i+1)+'. '+p.question);F.openChoice(b,labels,labels[rows.findIndex(p=>p.id===draft('poll').pollId)],value=>{draft('poll').pollId=rows[labels.indexOf(value)].id;draft('poll').selected=null;refresh();});return;}
 if(action==='poll-vote'){
  const p=D.polls.find(p=>p.id===b.dataset.id),d=draft('poll'),o=p?.options.find(o=>o.id===d.selected);
  if(p?.open&&o&&!p.voters[viewer()]){p.voters[viewer()]=o.id;o.votes=(o.votes||0)+1;}refresh();return;
 }
 if(action==='predict-option'){draft('poll').predictionOption=b.dataset.option;refresh();return;}
 if(action==='reward-select'){draft('rewards').selected=b.dataset.id;S.subview.rewards='confirm';refresh();return;}
 if(action==='reward-history'){S.subview.rewards='history';refresh();return;}
 if(action==='reward-list'){S.subview.rewards='list';refresh();return;}
 if(action==='reward-requests'){S.subview.rewards='requests';refresh();return;}
 if(action==='reward-detail'){const r=D.redemptions.find(r=>r.id===b.dataset.id&&r.channelId===channel()&&r.user===viewer());if(r){S.lastReward=r;S.subview.rewards='receipt';refresh();}return;}
 if(action==='reward-confirm'){
  const r=D.rewards.find(r=>r.id===b.dataset.id);if(!r||wallet()<r.points||r.channelId!==undefined&&r.channelId!==channel())return;
  if(r.limit==='방송당 1회'&&D.redemptions.some(x=>x.channelId===channel()&&x.rewardId===r.id&&x.user===viewer()&&!['거절','취소'].includes(x.status))){openDialog('신청할 수 없어요.','<p>이 보상은 방송당 한 번 신청할 수 있어요.</p>',btn('보상 목록','reward-dialog-back'),{kind:'reward-limit'});return;}
  const x={id:uid('redemption'),channelId:channel(),rewardId:r.id,name:r.name,cost:Number(r.points),user:viewer(),userName:F.nickname,status:'신청 대기',createdAt:now()};D.redemptions.unshift(x);addPoints(-x.cost,x.name,x.id);S.lastReward=x;S.subview.rewards='receipt';refresh();return;
 }
 if(action==='reward-dialog-back'){S.dialog=null;S.subview.rewards='list';refresh();return;}
 if(action==='reward-cancel-request'){D.resolveRedemption(b.dataset.id,'취소','신청자가 취소했어요.');refresh();return;}
 if(action==='earning-info'){openDialog('포인트 적립',summary([['시청 적립',D.earning.watchMinutes+'분당 '+D.earning.watchPoints+' P'],['출석 보상',D.earning.attendance+' P'],['시청 조건','로그인 상태에서 시청할 때 적립'],['현재 출석',D.earning.attendanceClaimed?'수령 완료':'수령 가능']]),btn(D.earning.attendanceClaimed?'수령 완료':'출석 보상 받기','attendance',D.earning.attendanceClaimed?'disabled':'')+btn('돌아가기','earning-back'),{kind:'earning'});return;}
 if(action==='attendance'){if(!D.earning.attendanceClaimed){D.earning.attendanceClaimed=true;addPoints(D.earning.attendance,'출석 보상',uid('attendance'));}b.disabled=true;b.textContent='수령 완료';return;}
 if(action==='earning-back'){S.dialog=null;refresh();return;}
 if(action==='device-connect'){
  if(D.devices.pending)return;D.devices.pending={id:b.dataset.id,name:b.dataset.name};const token=(D.devices.operation||0)+1;D.devices.operation=token;refresh();
  setTimeout(()=>{if(D.devices.operation!==token)return;const target=D.devices.pending;D.devices.pending=null;if(S.mode.deviceFailure){D.devices.error=true;S.mode.deviceFailure=false;}else{D.devices.error=false;D.devices.active=target;}if(F.screen==='devices')refresh();},450);return;
 }
 if(action==='device-disconnect'){D.devices.active=null;D.devices.pending=null;++D.devices.operation;refresh();return;}
 if(action==='device-search'){D.devices.error=false;F.viewState='기본';refresh();return;}
 if(action==='drop-claim'){const x=D.drops;if(!x.eligible||x.claimed||x.minutes<x.required)return;if(S.mode.dropFailure){x.error=true;S.mode.dropFailure=false;}else{x.error=false;x.claimed=true;}F.render();return;}
 if(action==='list-reset'){S.list[b.dataset.scope]={q:'',status:'전체',kind:'전체',from:'',to:'',sort:'최신순',page:0};S.errors[b.dataset.scope]={};F.render();return;}
 if(action==='list-filter'){const id=b.dataset.scope,f=settingsFor(id);F.openChoice(b,JSON.parse(b.dataset.options),f[b.dataset.key],value=>{f[b.dataset.key]=value;f.page=0;F.render();});return;}
 if(action==='page'){settingsFor(b.dataset.scope).page=Number(b.dataset.page);F.render();F.root.querySelector('.v38-list-tools input')?.focus({preventScroll:true});return;}
 if(action==='transaction'){transaction(b.dataset.id);return;}if(action==='refund-open'){refundForm(b.dataset.id);return;}if(action==='refund-detail'){refundDetail(b.dataset.id);return;}
 if(action==='refund-withdraw'){D.resolveRefund(b.dataset.id,'취소','사용자가 요청을 취소했어요.');refundDetail(b.dataset.id);return;}
 if(action==='refund-review'){refundReview(b.dataset.id);return;}
 if(action==='refund-start'){if(D.resolveRefund(b.dataset.id,'검토 중'))refundReview(b.dataset.id);return;}
 if(action==='settlement-open'){settlementForm();return;}if(action==='dialog-close'){closeDialog();return;}
 if(action==='payout-detail'){const r=D.settlement.details.find(x=>x.id===b.dataset.id);if(r)openDialog('정산 상세',summary([['정산 번호',r.id],['지급일',r.date],['금액',money(r.amount)],['상태',r.status],['사유',r.reason||'없음'],['재지급','계좌 보완 후 재검토']]),btn('닫기','dialog-close'),{kind:'payout',id:r.id});return;}
 if(action==='sponsor-detail'){const r=D.sponsors.find(x=>x.id===b.dataset.id);if(r)openDialog(r.type+' 상세',summary([['이름',r.title],['기간',r.period],['금액',money(r.amount)],['상태',r.status],['조건',r.terms]]),btn('닫기','dialog-close'),{kind:'sponsor',id:r.id});return;}
 if(action==='donation-detail'){donationDetail(b.dataset.id);return;}
 if(action==='donation-state'){const r=D.donations.find(x=>x.id===b.dataset.id);if(r){r.status=b.dataset.state;donationDetail(r.id);}return;}
 if(action==='donation-reject'){const r=D.donations.find(x=>x.id===b.dataset.id);if(r)openDialog('후원을 거절할까요?',summary([['내용',r.message||r.url],['금액',money(r.amount)],['결제 처리','취소 여부 확인 대기']]),btn('돌아가기','donation-detail','data-id="'+r.id+'"')+btn('거절','donation-state','data-id="'+r.id+'" data-state="거절"','danger'),{kind:'donation',id:r.id});return;}
 if(action==='benefits'){draft('benefits').benefits=D.benefits;openDialog('멤버십 혜택 수정',form('benefits',field('benefits','benefits','혜택',{area:true,max:500}),'benefits-submit','저장'),btn('취소','dialog-close'),{kind:'benefits'});return;}
 if(action==='gift-list'){S.subview.membership='gifts';refresh();return;}
 if(action==='gift-confirm'){S.subview.membership='gift-confirm';draft('membership').giftId=b.dataset.id;refresh();return;}
 if(action==='gift-claim'){const result=D.claimGift(b.dataset.id);S.errors.membership=result.error?{gift:result.error}:{};S.subview.membership='gifts';refresh();return;}
 if(action==='member-detail'){const r=D.memberships.find(m=>m.id===b.dataset.id);if(r)openDialog('멤버십 상세',summary([['닉네임',r.user],['상태',r.status],['다음 결제일',r.renewsAt||'없음'],['이용 종료일',r.endsAt||'없음']]),btn('닫기','dialog-close'),{kind:'member',id:r.id});return;}
 if(action==='csv'){
  const id=b.dataset.scope,csv='\ufeff'+S.buildCsv(id);
  const a=document.createElement('a'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.href=url;a.download='frame-'+id+'-page-'+(settingsFor(id).page+1)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),100);return;
 }
},true);
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&F.activeSelect)return;
 if(event.key==='Escape'&&S.dialog){stop(event);closeDialog();return;}
 const b=event.target.closest?.('.v38-tabs [role="tab"]');if(!b||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;stop(event);
 const all=[...b.parentElement.querySelectorAll('[role="tab"]')],i=all.indexOf(b),n=event.key==='Home'?0:event.key==='End'?all.length-1:(i+(event.key==='ArrowRight'?1:-1)+all.length)%all.length;all[n].click();
},true);
S.csvRows=id=>{const all=id==='members'?D.memberships:D.transactions,f=settingsFor(id);return listRows(id,all).slice(f.page*20,f.page*20+20);};
S.buildCsv=id=>[['일시','구분','사용자','금액','상태'],...S.csvRows(id).map(r=>[r.createdAt,r.kind,r.user,r.amount,r.status])].map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
S.applyFixture=fixture;S.submit=submitForm;S.draft=draft;
F.navigate=(id,viewState,replace=false)=>{
 if(id!==F.screen){S.dialog=null;S.preview=null;S.busy.clear();++S.job;if(owned.has(id)&&!['poll','devices'].includes(id))S.subview[id]=null;}
 return original.navigate(id,viewState,replace);
};
F.closeModal=()=>{if(S.dialog){closeDialog();return;}return original.close();};
F.renderModal=(...args)=>{const value=original.modal(...args);if(F.dialog.querySelector('.v38-engage'))F.dialog.classList.add('v38-engagement');return value;};
for(const id of ['revenue','members']){
 const page=F.pages[id];F.pages[id]=state=>F.v38Access&&F.v38Access.role!=='owner'?F.page(id==='revenue'?'수익 및 정산':'멤버십 관리',F.empty('이 화면을 볼 권한이 없어요.','','홈으로','go:live','shield')):page(state);
}
const extraStates={membership:['가입 확인 대기','갱신 예정','해지 예약','만료','갱신 실패','선물 수령 가능'],revenue:['검토 중','보완 요청','등록 완료','지급 실패'],mission:['거절','취소','기한 만료'], 'drop-rewards':['참여 자격 없음','수령 실패']};
Object.entries(extraStates).forEach(([id,states])=>{const screen=F.data.screens.find(s=>s.id===id);if(screen)states.forEach(state=>{if(!screen.states.includes(state))screen.states.push(state);});});
S.appliedScenes=new Set();
function applyScene(id,state){
 const key=channel()+':'+id+':'+state;if(S.appliedScenes.has(key)||['기본','금액 선택','방송 중'].includes(state))return;S.appliedScenes.add(key);
 if(id==='membership'&&['가입 완료','가입 확인 대기','갱신 예정','해지 예약','만료','갱신 실패'].includes(state)){
  let m=D.memberships.find(m=>m.channelId===channel()&&m.user===viewer());
  if(!m){m={id:uid('membership-fixture'),channelId:channel(),user:viewer(),userName:F.nickname,kind:'멤버십',amount:4900,createdAt:now()};D.memberships.push(m);}
  Object.assign(m,{status:state==='가입 완료'?'이용 중':state,renewsAt:state==='만료'?'없음':'2026.12.02',endsAt:state==='만료'?'2026.11.01':'2026.12.02'});
 }
 if(id==='mission'&&['진행 중','완료','실패','거절','취소','기한 만료'].includes(state)){
  let r=D.missions.find(m=>m.channelId===channel()&&m.user===viewer());if(!r){r={id:uid('mission-fixture'),channelId:channel(),user:viewer(),userName:F.nickname,title:'함께 만드는 작은 기능',type:'무료 미션',limit:'30분',amount:0,createdAt:now()};D.missions.push(r);}
  r.status=state;r.reason=['실패','거절','기한 만료'].includes(state)?'완료 조건을 충족하지 못했어요.':'';S.subview.mission=r.id;
 }
 if(id==='revenue'&&['정산 대기','검토 중','보완 요청','등록 완료','지급 실패'].includes(state)){
  S.mode.revenueTab='정산';D.settlement.status=state==='정산 대기'?'검토 중':state;
  D.settlement.reason=state==='보완 요청'?'예금주와 제출 정보가 일치하는지 확인하세요.':state==='지급 실패'?'지급 계좌를 확인한 뒤 정보를 보완하세요.':'';
 }
 if(id==='drop-rewards'&&state==='참여 자격 없음')D.drops.eligible=false;
 if(id==='drop-rewards'&&state==='수령 실패'){D.drops.minutes=30;D.drops.eligible=true;D.drops.claimed=false;D.drops.error=true;}
 if(id==='membership'&&state==='선물 수령 가능'){D.gifts.push({id:uid('gift-fixture'),channelId:channel(),recipient:F.nickname,status:'수령 대기',createdAt:now()});S.subview.membership='gifts';}
 if(id==='poll'&&['투표 완료','마감'].includes(state)){const p=D.polls.find(p=>(p.channelId??0)===channel()&&p.open)||D.polls.filter(p=>(p.channelId??0)===channel()).at(-1);if(p){D.normalizePolls();if(state==='마감')p.open=false;else if(!p.voters[viewer()]&&p.options[0]){p.voters[viewer()]=p.options[0].id;p.options[0].votes++;}}}
}
for(const id of ['membership','mission','poll']){const render=F.modals[id];F.modals[id]=state=>{applyScene(id,state);return render(state);};}
const membershipRenderer=F.modals.membership;
F.modals.membership=viewState=>{
 applyScene('membership',viewState);
 if(['gifts','gift-confirm'].includes(S.subview.membership)){
  const rows=D.gifts.filter(g=>g.recipient.toLocaleLowerCase()===String(F.nickname).toLocaleLowerCase()),g=rows.find(g=>g.id===draft('membership').giftId);
  if(S.subview.membership==='gift-confirm'&&g)return modal('membership','선물을 받을까요?',summary([['채널',F.broadcasts[g.channelId]?.name||'채널'],['받는 사람',g.recipient],['이용 기간','1개월 · 자동 갱신 없음']]),btn('이전으로','gift-list')+btn('선물 받기','gift-claim','data-id="'+g.id+'"','primary'));
  return modal('membership','받은 선물',(err('membership','gift')?notice(err('membership','gift')):'')+(rows.length?rows.map(g=>'<article class="v38-row"><strong>'+e(F.broadcasts[g.channelId]?.name||'채널')+'</strong><span>'+e(g.status)+'</span>'+btn(g.status==='수령 대기'?'선물 받기':'수령 완료','gift-confirm','data-id="'+g.id+'"'+(g.status!=='수령 대기'?' disabled':''))+'</article>').join(''):state('받은 선물이 없어요.')),btn('멤버십으로','membership-back')+close());
 }
 const config=membershipRenderer(viewState);config.footer=btn('받은 선물','gift-list')+config.footer;return config;
};
for(const id of ['revenue','drop-rewards']){const render=F.pages[id];F.pages[id]=state=>{applyScene(id,state);return render(state);};}
S.applyScene=applyScene;
D.auditAPI={scope:'local prototype only',version:38,wallet,addPoints,parseAmount,resolveRedemption:D.resolveRedemption,transitionMission:D.transitionMission,resolvePrediction:D.resolvePrediction,resolveRefund:D.resolveRefund};
if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;
F.render();
})();
