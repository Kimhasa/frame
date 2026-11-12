/* History UX prototype. Fictional local records only; no account, media or server changes. */
(()=>{
  'use strict';
  const F=window.F,e=F.e,original={catalog:F.catalog,navigate:F.navigate,render:F.render,read:F.readUrl,write:F.writeUrl,close:F.closeModal};
  const key='frame.design.history.v37',pageSize=24,kinds=['전체','라이브','다시보기','클립'];
  const dayKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today=()=>dayKey(new Date()),dateOf=s=>new Date(s+'T12:00:00'),normalize=s=>String(s).normalize('NFKC').toLocaleLowerCase('ko-KR');
  const titles=['플레이어 마무리와 작은 기능 다듬기','빛과 색을 담는 드로잉','비 오는 밤, 천천히 달려요','새로운 지역에서 함께하는 모험','작업실을 정리하는 차분한 오후','화면 공유와 오디오 점검','오늘의 프로젝트를 함께 만들어요','주말에 다시 찾은 오래된 게임','하나씩 완성하는 채널 디자인','음악과 함께하는 저녁 작업','코드를 읽고 고치는 시간','작은 도시를 걸으며 이야기해요'];
  function fixtures(count=180){
    const now=Date.now();return Array.from({length:count},(_,i)=>{
      const at=new Date(now-i*130*60000-Math.floor(i/6)*22*3600000),index=i%F.broadcasts.length,kind=i%7===3?'클립':i%11===0?'라이브':'다시보기';
      const duration=kind==='클립'?42:[8076,6492,11325,3720][i%4],status=i===8?'private':i===17?'deleted':kind==='라이브'&&dayKey(at)!==today()?'ended':'available';
      return {id:'history-'+i,videoId:`video-${index}-${Math.floor(i/F.broadcasts.length)%9}-${kind}`,channelIndex:index,title:titles[(i*5)%titles.length]+(i%8===4?' — 오늘의 작업 과정과 다음에 이어갈 이야기':''),channel:F.broadcasts[index].name,kind,watchedAt:at.toISOString(),duration,position:Math.round(duration*[.38,.67,.22,1][i%4]),status};
    });
  }
  let stored=null;try{stored=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
  if(stored?.version===1&&Array.isArray(stored.records)){
    const seen=new Set();stored.records=stored.records.filter(r=>r&&typeof r.id==='string'&&!seen.has(r.id)&&seen.add(r.id)&&typeof r.videoId==='string'&&typeof r.title==='string'&&typeof r.channel==='string'&&kinds.includes(r.kind)&&r.kind!=='전체'&&['available','private','deleted','ended'].includes(r.status)&&Number.isInteger(r.channelIndex)&&r.channelIndex>=0&&r.channelIndex<F.broadcasts.length&&typeof r.watchedAt==='string'&&!Number.isNaN(Date.parse(r.watchedAt))&&Number.isFinite(r.duration)&&r.duration>0&&Number.isFinite(r.position)&&r.position>=0).map(r=>({...r,position:Math.min(r.position,r.duration)}));
  }
  const S=F.v37History={records:stored?.version===1&&Array.isArray(stored.records)?stored.records:fixtures(),paused:stored?.paused===true,query:'',draft:'',kind:'전체',from:'',to:'',period:'전체 기간',page:0,selected:new Set(),selecting:false,dialog:null,calendar:null,undo:null,mode:null,fault:null,pageError:false,pendingPage:null,scroll:0,focusId:null,restore:false,visited:false,resumeIntent:null,composing:false,returnContext:null,mainScroll:0,loginReturn:false};
  const btn=(label,action,icon='',cls='',attrs='')=>F.btn(label,'v37-history-'+action,icon,cls,attrs);
  const persist=()=>{try{sessionStorage.setItem(key,JSON.stringify({version:1,records:S.records,paused:S.paused}));}catch{F.toast('이 탭에서만 변경 내용을 유지해요.');}if(F.v33Viewer)F.v33Viewer.history=new Set(S.records.map(r=>r.channelIndex));};
  const filtered=()=>{
    if(S.returnContext?.key===filterKey()){const present=new Set(S.records.map(r=>r.id));return S.returnContext.rows.filter(r=>present.has(r.id));}
    const tokens=normalize(S.query.trim()).split(/\s+/).filter(Boolean);
    return S.records.filter(r=>(S.kind==='전체'||r.kind===S.kind)&&(!S.from||dayKey(new Date(r.watchedAt))>=S.from)&&(!S.to||dayKey(new Date(r.watchedAt))<=S.to)&&tokens.every(t=>normalize(r.title+' '+r.channel).includes(t))).sort((a,b)=>Date.parse(b.watchedAt)-Date.parse(a.watchedAt)||a.id.localeCompare(b.id));
  };
  const filterKey=()=>JSON.stringify([S.query,S.kind,S.from,S.to]);
  const loadedRows=()=>filtered().slice(0,(S.page+1)*pageSize);
  function syncSelectionControl(){
    const check=F.root.querySelector('#v37-history-page-check');if(!check)return;
    const rows=[...F.root.querySelectorAll('[data-history-check]')],count=rows.filter(input=>input.checked).length;
    check.indeterminate=count>0&&count<rows.length;check.checked=rows.length>0&&count===rows.length;
    check.setAttribute('aria-checked',check.indeterminate?'mixed':String(check.checked));
  }
  function focusRecord(id){
    const row=id&&F.root.querySelector(`[data-history-id="${CSS.escape(id)}"]`);
    const target=row?.querySelector(S.selecting?'[data-history-check]':'[data-action="v37-history-remove"],.v37-history-title:not(:disabled),.v37-history-channel')
      ||F.root.querySelector('.v37-history-entry '+(S.selecting?'[data-history-check]':'.v37-history-title:not(:disabled),.v37-history-channel'))
      ||F.root.querySelector('.v37-history-list .empty button,.v37-history-list .empty a')||F.root.querySelector('.v37-history h1');
    if(target){if(target.tagName==='H1')target.tabIndex=-1;target.focus({preventScroll:true});}
  }
  function rememberList(focusId){
    if(!S.returnContext||S.returnContext.key!==filterKey())S.returnContext={key:filterKey(),rows:filtered().map(r=>({...r}))};
    S.scroll=scrollY;S.mainScroll=F.root.querySelector('#main-content')?.scrollTop||0;
    if(focusId)S.focusId=focusId;
  }
  const clock=seconds=>seconds>=3600?`${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  function dateLabel(key){const d=dateOf(key),yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);if(key===today())return '오늘';if(key===dayKey(yesterday))return '어제';return new Intl.DateTimeFormat('ko-KR',{...(d.getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{}),month:'long',day:'numeric',weekday:'long'}).format(d);}
  function syncUrl(replace=false){original.write(replace);const u=new URL(location.href);for(const [name,value]of Object.entries({hq:S.query,hkind:S.kind==='전체'?'':S.kind,hfrom:S.from,hto:S.to,hpage:S.page?String(S.page+1):''})){value?u.searchParams.set(name,value):u.searchParams.delete(name);}history.replaceState({},'',u);}
  function readFilters(){if(F.screen!=='history')return;const p=new URL(location.href).searchParams;S.query=(p.get('hq')||'').slice(0,120);S.draft=S.query;S.kind=kinds.includes(p.get('hkind'))?p.get('hkind'):'전체';const valid=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!Number.isNaN(dateOf(s).getTime())&&dayKey(dateOf(s))===s&&s<=today();S.from=valid(p.get('hfrom'))?p.get('hfrom'):'';S.to=valid(p.get('hto'))?p.get('hto'):'';if(S.from&&S.to&&S.from>S.to)S.from=S.to='';S.period=S.from||S.to?'선택한 기간':'전체 기간';const page=Number(p.get('hpage')||1);S.page=Number.isFinite(page)?Math.max(0,Math.floor(page)-1):0;}
  function redraw(focus,keepScroll=true){const y=scrollY,top=F.root.querySelector('#main-content')?.scrollTop||0;F.render();if(keepScroll){window.scrollTo({top:y,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top});}if(focus)document.getElementById(focus)?.focus({preventScroll:true});}
  function redrawResults(){
    const host=document.createElement('div');host.innerHTML=renderHistory(F.viewState);
    const current=F.root.querySelector('#v37-history-result-region'),next=host.querySelector('#v37-history-result-region');if(current&&next)current.replaceWith(next);
    const count=F.root.querySelector('.v37-history-count'),newCount=host.querySelector('.v37-history-count');if(count&&newCount){count.hidden=newCount.hidden;count.textContent=newCount.textContent;}
    const reset=F.root.querySelector('[data-history-reset-filter]'),newReset=host.querySelector('[data-history-reset-filter]');if(reset&&newReset)reset.hidden=newReset.hidden;
    const clear=F.root.querySelector('[data-action="v37-history-clear-query"]');if(clear)clear.hidden=!S.draft;
    syncSelectionControl();
    window.FRAME_UI52?.install(F.root);
  }
  function applyFilters(focus='v37-history-search',partial=false){S.query=S.draft;S.returnContext=null;S.page=0;S.selected.clear();S.pageError=false;S.mode=null;F.viewState='기본';syncUrl(partial);if(partial)redrawResults();else{redraw(focus,false);window.scrollTo({top:0,behavior:'instant'});}}
  function resetFilters(){S.query=S.draft='';S.kind='전체';S.from=S.to='';S.period='전체 기간';applyFilters();}
  function entry(r){
    const b=F.broadcasts[r.channelIndex]||F.broadcasts[0],available=r.status==='available',checked=S.selected.has(r.id),progress=Math.min(100,Math.round(r.position/r.duration*100));
    const unavailable={private:'비공개 영상',deleted:'삭제된 영상',ended:'종료된 방송'}[r.status];
    return `<article class="v37-history-entry${available?'':' is-unavailable'}" data-history-id="${e(r.id)}">${S.selecting?`<label class="v37-history-check"><input type="checkbox" data-history-check="${e(r.id)}" ${checked?'checked':''} aria-label="${e(r.title)} 선택"></label>`:''}<button type="button" class="v37-history-thumb" id="v37-history-thumb-${e(r.id)}" data-action="v37-history-play" data-id="${e(r.id)}" ${!available?'disabled':''} aria-label="${e(r.title)} 재생">${available?F.v2Visual(b,r.channelIndex):`<span class="v37-history-unavailable">${F.icon(r.status==='private'?'shield':'video')}<span>${unavailable}</span></span>`}${available?`<span class="duration">${clock(r.duration)}</span><span class="v37-history-progress"><i style="width:${progress}%"></i></span>`:''}</button><div class="v37-history-copy"><button type="button" class="v37-history-title" id="v37-history-play-${r.id}" data-action="v37-history-play" data-id="${e(r.id)}" ${!available?'disabled':''} title="${e(r.title)}">${e(r.title)}</button><button type="button" class="v37-history-channel" id="v37-history-channel-${e(r.id)}" data-action="v37-history-channel" data-id="${e(r.id)}" title="${e(r.channel)}">${e(r.channel)}</button><div class="v37-history-meta"><span>${e(r.kind)}</span><time datetime="${e(r.watchedAt)}">${new Intl.DateTimeFormat('ko-KR',{hour:'numeric',minute:'2-digit'}).format(new Date(r.watchedAt))}</time>${!available?`<span>${unavailable}</span>`:''}</div></div>${!S.selecting?btn('','remove','close','v37-history-remove',`data-id="${e(r.id)}" aria-label="${e(r.title)} 시청 기록에서 삭제" title="시청 기록에서 삭제"`):''}</article>`;
  }
  function renderHistory(viewState){
    if(!F.sessionLoggedIn)return `<section class="v37-history"><h1>시청 기록</h1>${F.empty('로그인하고 시청 기록을 확인하세요','','로그인','v37-history-login','user')}</section>`;
    const forceEmpty=viewState==='기록 없음'||S.mode==='empty',all=forceEmpty?[]:filtered(),maxPage=Math.max(0,Math.ceil(all.length/pageSize)-1);S.page=Math.min(S.page,maxPage);
    const rows=all.slice(0,(S.page+1)*pageSize),hasFilters=!!(S.query.trim()||S.from||S.to||S.kind!=='전체'),ready=!['loading','load-error'].includes(S.mode);
    const head=`<div class="v37-history-heading"><h1>시청 기록</h1>${!S.selecting?`<div>${btn('선택','selection','','ghost','id="v37-history-selection" '+(!S.records.length?'disabled':''))}${btn('기록 관리','manage','gear','ghost','id="v37-history-manage" aria-haspopup="listbox"')}</div>`:''}</div>`;
    const periodLabel=S.period==='선택한 기간'?`${S.from.replaceAll('-','.')} – ${S.to.replaceAll('-','.')}`:S.period;
    const toolbar=`<div class="v37-history-tools"><form id="v37-history-search-form" class="v37-history-search" role="search"><label class="sr-only" for="v37-history-search">시청 기록 검색</label>${F.icon('search')}<input id="v37-history-search" name="history-query" type="search" maxlength="120" placeholder="시청 기록 검색" autocomplete="off" value="${e(S.draft)}">${btn('','clear-query','close','icon ghost',`aria-label="검색어 지우기" ${S.draft?'':'hidden'}`)}<button type="submit">검색</button></form>${btn(e(periodLabel),'period','calendar','v37-history-period',`id="v37-history-period" aria-label="시청한 날짜: ${e(periodLabel)}" aria-haspopup="listbox"`)}</div><div class="v37-history-filter-row"><div class="v37-history-tabs" role="tablist" aria-label="시청 기록 종류">${kinds.map(kind=>`<button type="button" role="tab" id="v37-history-kind-${kinds.indexOf(kind)}" aria-controls="v37-history-results" data-action="v37-history-kind" data-kind="${kind}" aria-selected="${S.kind===kind}" tabindex="${S.kind===kind?0:-1}">${kind}</button>`).join('')}</div><div class="v37-history-filter-actions"><span class="v37-history-count" role="status" aria-live="polite" ${ready&&S.records.length&&!forceEmpty?'':'hidden'}>${ready&&S.records.length&&!forceEmpty?`${S.query.trim()?'검색 결과 ':''}${all.length.toLocaleString()}개`:''}</span>${btn('초기화','reset','','ghost small',`data-history-reset-filter ${hasFilters?'':'hidden'}`)}</div></div>`;
    const paused=S.paused?`<div class="v37-history-paused" role="status">${F.icon('pause')}<span>시청 기록 저장이 일시중지됐어요.</span>${btn('다시 저장','resume','','ghost small')}</div>`:'';
    const selected=rows.length&&rows.every(r=>S.selected.has(r.id));
    const selection=S.selecting?`<div class="v37-history-selection-bar"><label><input id="v37-history-page-check" type="checkbox" data-history-page-check ${selected?'checked':''} ${!rows.length?'disabled':''} aria-label="표시된 ${rows.length.toLocaleString()}개 기록 모두 선택" title="표시된 ${rows.length.toLocaleString()}개 기록 모두 선택"><span>전체 선택</span></label>${S.selected.size?`<span class="v37-history-selected-count" role="status">${S.selected.size.toLocaleString()}개 선택</span>`:''}<div class="v37-history-selection-actions">${btn('취소','selection','','ghost small','id="v37-history-selection"')}${btn('삭제','delete-selected','','danger small','id="v37-history-delete-selected" '+(!S.selected.size?'disabled':''))}</div></div>`:'';
    if(S.mode==='loading')return `<section class="v37-history">${head}${paused}${toolbar}<div id="v37-history-result-region"><div id="v37-history-results" class="v37-history-loading" role="status" aria-busy="true"><span class="spinner"></span>시청 기록을 불러오고 있어요.</div></div></section>`;
    if(S.mode==='load-error')return `<section class="v37-history">${head}${paused}${toolbar}<div id="v37-history-result-region"><div id="v37-history-results" role="alert">${F.empty('시청 기록을 불러오지 못했어요','','다시 시도','v37-history-retry','alert')}</div></div></section>`;
    let groups='',last='';for(const r of rows){const date=dayKey(new Date(r.watchedAt));if(date!==last){if(last)groups+='</section>';groups+=`<section class="v37-history-day" aria-label="${dateLabel(date)}"><h2><time datetime="${date}">${dateLabel(date)}</time></h2>`;last=date;}groups+=entry(r);}if(last)groups+='</section>';
    const empty=!rows.length?F.empty(hasFilters?'조건에 맞는 시청 기록이 없어요':'아직 시청 기록이 없어요',hasFilters?'검색어나 기간을 바꿔보세요.':'',hasFilters?'필터 초기화':'방송 둘러보기',hasFilters?'v37-history-reset':'go:live',hasFilters?'search':'history'):'';
    const paging=rows.length&&rows.length<all.length&&!S.pageError?`<div class="v37-history-pagination">${btn('기록 더 보기','load-more','','','id="v37-history-more"')}</div>`:'';
    const failure=S.pageError?`<div class="v37-history-page-error" role="alert"><span>기록을 불러오지 못했어요.</span>${btn('다시 시도','retry-page','','small','id="v37-history-retry-more"')}</div>`:'';
    return `<section class="v37-history">${head}${paused}${toolbar}<div id="v37-history-result-region">${selection}<div id="v37-history-results" class="v37-history-list" role="tabpanel" aria-labelledby="v37-history-kind-${kinds.indexOf(S.kind)}">${groups}${empty}</div>${failure}${paging}</div></section>`;
  }
  function resumeCards(html){
    const h=document.createElement('div');h.innerHTML=html;const section=h.querySelector('.v3-recent'),grid=section?.querySelector('.v3-resume-grid');if(!grid)return html;
    if(!F.sessionLoggedIn){section.remove();return h.innerHTML;}
    const seen=new Set(),recent=S.records.slice().sort((a,b)=>Date.parse(b.watchedAt)-Date.parse(a.watchedAt)).filter(r=>r.status==='available'&&r.position>0&&r.position<r.duration&&!seen.has(r.videoId)&&seen.add(r.videoId)).slice(0,4);
    if(!recent.length){section.remove();return h.innerHTML;}
    grid.innerHTML=recent.map(r=>{const b=F.broadcasts[r.channelIndex]||F.broadcasts[0],host=document.createElement('div');host.innerHTML=F.card(b,r.channelIndex,'resume');host.querySelectorAll('.thumb,.card-title').forEach(button=>{button.removeAttribute('data-go');button.dataset.action='v37-history-play';button.dataset.id=r.id;});host.querySelector('.card-title').textContent=r.title;host.querySelector('.thumb').setAttribute('aria-label',r.title+' 재생');host.querySelector('.duration').textContent=clock(r.duration);host.querySelector('.v3-resume i').style.width=Math.round(r.position/r.duration*100)+'%';host.querySelector('.card-category')?.remove();return host.innerHTML;}).join('');return h.innerHTML;
  }
  F.catalog=(id,viewState)=>id==='history'?renderHistory(viewState):id==='live'?resumeCards(original.catalog(id,viewState)):original.catalog(id,viewState);
  function openDialog(title,body,footer,context){context.returnFocusId=context.returnFocusId||(context.type==='calendar'&&S.calendar?.purpose!=='delete'?'v37-history-period':S.selecting?'v37-history-selection':'v37-history-manage');S.dialog=context;F.genericDialog(title,body,'확인');F.dialog.classList.add('v37-history-dialog');if(context.type==='delete')F.dialog.classList.add('v37-history-delete-dialog');F.dialog.querySelector('.modal-footer').innerHTML=footer;F.labelControls(F.dialog);F.dialog.querySelector('input,.modal-footer button')?.focus({preventScroll:true});}
  function closeDialog(){F.closeModal();}
  function confirmDelete(ids,scope='selected'){
    const items=S.records.filter(r=>ids.includes(r.id));if(!items.length){F.toast('삭제할 기록이 없어요.');return;}
    const count=items.length.toLocaleString(),title=scope==='selected'?`선택한 기록 ${count}개를 삭제할까요?`:scope==='all'?`전체 시청 기록 ${count}개를 삭제할까요?`:`${scope} 기록 ${count}개를 삭제할까요?`;
    openDialog(title,'<p id="v37-history-dialog-error" class="v37-history-error" role="alert" hidden></p>',`${btn('취소','cancel')}${btn('삭제','confirm-delete','','danger')}`,{type:'delete',ids:items.map(r=>r.id),returnFocusId:scope==='selected'?'v37-history-delete-selected':'v37-history-manage'});
  }
  let undoTimer;
  function feedback(message,undo=null){
    document.getElementById('v37-history-feedback')?.remove();clearTimeout(undoTimer);S.undo=undo;
    const host=document.createElement('div');host.id='v37-history-feedback';host.className='v37-history-feedback';host.innerHTML=`<span role="status">${e(message)}</span>${undo?btn('실행 취소','undo','','ghost'):''}${btn('','dismiss','close','icon ghost','aria-label="알림 닫기"')}`;document.body.append(host);
    undoTimer=setTimeout(()=>{host.remove();S.undo=null;},10000);
  }
  function remove(ids){
    const removed=new Set(ids),rows=loadedRows(),index=rows.findIndex(r=>removed.has(r.id)),next=rows.slice(index+1).find(r=>!removed.has(r.id))||rows.slice(0,index).reverse().find(r=>!removed.has(r.id));
    const gone=S.records.filter(r=>removed.has(r.id));if(!gone.length)return;S.records=S.records.filter(r=>!removed.has(r.id));gone.forEach(r=>S.selected.delete(r.id));if(!S.records.length)S.selecting=false;
    S.page=Math.min(S.page,Math.max(0,Math.ceil(filtered().length/pageSize)-1));S.pageError=false;S.pendingPage=null;persist();syncUrl(true);redraw();focusRecord(next?.id);feedback(`${gone.length.toLocaleString()}개의 기록을 삭제했어요.`,gone);
  }
  function openCalendar(purpose='filter',saved=null){
    if(purpose==='filter')S.focusId='v37-history-period';
    const end=today(),month=new Date();month.setDate(1);S.calendar=saved||{purpose,from:S.from||'',to:S.to||'',month:dayKey(month).slice(0,7),error:''};drawCalendar();
  }
  function drawCalendar(focusSelector){
    const c=S.calendar,month=dateOf(c.month+'-01'),year=month.getFullYear(),m=month.getMonth(),offset=month.getDay(),days=new Date(year,m+1,0).getDate();
    const cells=Array.from({length:offset},()=>'<span></span>');for(let n=1;n<=days;n++){const date=`${c.month}-${String(n).padStart(2,'0')}`,inRange=c.from&&c.to&&date>=c.from&&date<=c.to;cells.push(`<button type="button" data-action="v37-history-calendar-day" data-date="${date}" class="${date===c.from||date===c.to?'selected':inRange?'in-range':''}" ${date>today()?'disabled':''} aria-label="${year}년 ${m+1}월 ${n}일${date===c.from?' 시작일':date===c.to?' 종료일':''}" aria-pressed="${date===c.from||date===c.to}">${n}</button>`);}
    const body=`<div class="v37-history-date-fields"><label for="v37-history-from">시작일<input id="v37-history-from" name="history-from" inputmode="numeric" placeholder="YYYY-MM-DD" maxlength="10" value="${e(c.from)}"></label><label for="v37-history-to">종료일<input id="v37-history-to" name="history-to" inputmode="numeric" placeholder="YYYY-MM-DD" maxlength="10" value="${e(c.to)}"></label></div><div class="v37-history-calendar-head">${btn('','month-prev','arrow','icon ghost','aria-label="이전 달"')}<strong>${year}년 ${m+1}월</strong>${btn('','month-next','right','icon ghost',`aria-label="다음 달" ${c.month>=today().slice(0,7)?'disabled':''}`)}</div><div class="v37-history-calendar-week" aria-hidden="true">${['일','월','화','수','목','금','토'].map(x=>`<span>${x}</span>`).join('')}</div><div class="v37-history-calendar-days">${cells.join('')}</div><p id="v37-history-dialog-error" class="v37-history-error" role="alert" ${c.error?'':'hidden'}>${e(c.error)}</p>`;
    openDialog(c.purpose==='delete'?'삭제할 기간 선택':'기간 선택',body,`${btn('취소','cancel')}${btn(c.purpose==='delete'?'다음':'적용','date-apply','','primary')}`,{type:'calendar'});
    if(focusSelector)F.dialog.querySelector(focusSelector)?.focus({preventScroll:true});
  }
  function dateApply(){
    const c=S.calendar;for(const field of ['from','to'])c[field]=F.dialog.querySelector('#v37-history-'+field).value.trim().replaceAll('.','-');
    const valid=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(dateOf(s).getTime())&&dayKey(dateOf(s))===s;
    if(!valid(c.from)||!valid(c.to)||c.from>c.to||c.to>today()){const p=F.dialog.querySelector('#v37-history-dialog-error');p.hidden=false;p.textContent=!valid(c.from)||!valid(c.to)?'날짜를 YYYY-MM-DD 형식으로 입력하세요.':c.from>c.to?'종료일은 시작일 이후로 선택하세요.':'오늘 이후의 날짜는 선택할 수 없어요.';F.dialog.querySelector('#v37-history-from').focus();return;}
    if(c.purpose==='delete'){const ids=S.records.filter(r=>{const d=dayKey(new Date(r.watchedAt));return d>=c.from&&d<=c.to;}).map(r=>r.id);if(!ids.length){const p=F.dialog.querySelector('#v37-history-dialog-error');p.hidden=false;p.textContent='선택한 기간에 시청 기록이 없어요.';return;}const label=`${c.from.replaceAll('-','.')} – ${c.to.replaceAll('-','.')}`;S.calendar=null;confirmDelete(ids,label);}
    else{const chosen={query:S.draft,from:c.from,to:c.to};const commit=()=>{if(F.screen!=='history')return;S.query=S.draft=chosen.query;S.returnContext=null;S.from=chosen.from;S.to=chosen.to;S.period='선택한 기간';S.page=0;S.selected.clear();syncUrl(true);redraw('v37-history-period');};if(F.v39Mobile?.afterDialogClose){F.v39Mobile.afterDialogClose(commit);closeDialog();}else{closeDialog();commit();}}
  }
  function pageChange(page){
    const all=filtered(),max=Math.max(0,Math.ceil(all.length/pageSize)-1),previousCount=loadedRows().length,y=scrollY,main=F.root.querySelector('#main-content'),top=main?.scrollTop||0;
    page=Math.max(0,Math.min(page,max));if(page<=S.page&&!S.pageError)return;
    if(S.fault==='page'){S.fault=null;S.pendingPage=page;S.pageError=true;redrawResults();F.root.querySelector('#v37-history-retry-more')?.focus({preventScroll:true});return;}
    S.page=page;S.pageError=false;S.pendingPage=null;syncUrl(true);redrawResults();window.scrollTo({top:y,behavior:'instant'});main?.scrollTo({top});focusRecord(all[previousCount]?.id);
  }
  function recordWatch(record){
    if(S.paused||!F.sessionLoggedIn)return false;const now=new Date(),same=S.records.find(r=>r.videoId===record.videoId&&dayKey(new Date(r.watchedAt))===dayKey(now));
    if(same){same.watchedAt=now.toISOString();same.position=record.position??same.position;}else S.records.unshift({...record,id:'visit-'+now.getTime()+'-'+Math.random().toString(36).slice(2,6),watchedAt:now.toISOString()});persist();return true;
  }
  Object.assign(S,{fixtures,filtered,recordWatch,setMode(mode){S.mode=mode;F.render();},setFault(fault){S.fault=fault;},reset(count=180){S.returnContext=null;S.composing=false;S.loginReturn=false;S.records=fixtures(count);S.paused=false;S.query=S.draft=S.from=S.to='';S.kind='전체';S.period='전체 기간';S.page=0;S.selected.clear();S.selecting=false;S.mode=S.fault=null;persist();if(F.screen==='history')F.render();}});
  window.addEventListener('submit',event=>{if(event.target.id!=='v37-history-search-form')return;event.preventDefault();event.stopImmediatePropagation();if(!S.composing&&!event.isComposing)applyFilters(null,true);},true);
  window.addEventListener('input',event=>{if(event.target.id==='v37-history-search'){S.draft=event.target.value;const clear=F.root.querySelector('[data-action="v37-history-clear-query"]');if(clear)clear.hidden=!S.draft;if(!S.composing&&!event.isComposing)applyFilters(null,true);}if(S.calendar&&['v37-history-from','v37-history-to'].includes(event.target.id))S.calendar[event.target.id.endsWith('from')?'from':'to']=event.target.value;},true);
  window.addEventListener('compositionstart',event=>{if(event.target.id==='v37-history-search')S.composing=true;},true);
  window.addEventListener('compositionend',event=>{if(event.target.id==='v37-history-search'){S.composing=false;S.draft=event.target.value;applyFilters(null,true);}},true);
  window.addEventListener('change',event=>{
    const input=event.target;if(input.dataset?.historyCheck){const id=input.dataset.historyCheck;input.checked?S.selected.add(id):S.selected.delete(id);redrawResults();F.root.querySelector(`[data-history-check="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}
    if(input.hasAttribute?.('data-history-page-check')){loadedRows().forEach(r=>input.checked?S.selected.add(r.id):S.selected.delete(r.id));redrawResults();F.root.querySelector('#v37-history-page-check')?.focus({preventScroll:true});}
  },true);
  window.addEventListener('keydown',event=>{const tab=event.target.closest?.('.v37-history-tabs [role="tab"]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopImmediatePropagation();const index=kinds.indexOf(S.kind),next=event.key==='Home'?0:event.key==='End'?3:(index+(event.key==='ArrowRight'?1:3))%4;S.kind=kinds[next];applyFilters(null);F.root.querySelector(`.v37-history-tabs [data-kind="${S.kind}"]`)?.focus();},true);
  window.addEventListener('click',event=>{
    const b=event.target.closest?.('button[data-action^="v37-history-"]');if(!b||b.disabled)return;event.preventDefault();event.stopImmediatePropagation();const action=b.dataset.action.slice('v37-history-'.length),r=S.records.find(x=>x.id===b.dataset.id);
    if(action==='play'&&r){if(S.selecting){S.selected.has(r.id)?S.selected.delete(r.id):S.selected.add(r.id);redrawResults();document.getElementById(b.id)?.focus({preventScroll:true});return;}S.focusId=b.id||'v37-history-play-'+r.id;if(F.screen==='history')rememberList(S.focusId);S.resumeIntent={videoId:r.videoId,position:r.position,recordId:r.id};F.selectedBroadcast=r.channelIndex;F.v33Viewer.record={index:r.channelIndex,title:r.title};recordWatch(r);F.navigate(r.kind==='클립'?'clip-watch':r.kind==='라이브'?'watch':'vod-watch');}
    else if(action==='channel'&&r){S.focusId=b.id;if(F.screen==='history')rememberList(S.focusId);F.selectedBroadcast=r.channelIndex;F.navigate('channel');}
    else if(action==='login'){S.loginReturn=true;F.authReturn='history';F.navigate('login');}
    else if(action==='remove'&&r)remove([r.id]);
    else if(action==='undo'&&S.undo){const ids=new Set(S.records.map(x=>x.id));S.records.push(...S.undo.filter(x=>!ids.has(x.id)));persist();feedback('시청 기록을 복원했어요.');redraw();}
    else if(action==='dismiss'){clearTimeout(undoTimer);S.undo=null;document.getElementById('v37-history-feedback')?.remove();}
    else if(action==='selection'){S.selecting=!S.selecting;S.selected.clear();redraw('v37-history-selection');}
    else if(action==='delete-selected')confirmDelete([...S.selected]);
    else if(action==='manage')F.openChoice(b,['선택해서 삭제','기간별 삭제','전체 시청 기록 삭제',S.paused?'시청 기록 다시 저장':'시청 기록 저장 일시중지'],null,value=>{if(value==='선택해서 삭제'){S.selecting=true;S.selected.clear();redraw('v37-history-selection');}else if(value==='기간별 삭제')openCalendar('delete');else if(value==='전체 시청 기록 삭제')confirmDelete(S.records.map(x=>x.id),'all');else if(S.paused){S.paused=false;persist();redraw('v37-history-manage');feedback('시청 기록을 다시 저장해요.');}else openDialog('시청 기록 저장을 일시중지할까요?','<p class="v37-history-confirm">기존 기록은 유지하고, 이후 시청 기록을 저장하지 않아요.</p>',`${btn('취소','cancel')}${btn('일시중지','confirm-pause','','primary')}`,{type:'pause'});});
    else if(action==='confirm-pause'){S.paused=true;persist();closeDialog();feedback('시청 기록 저장을 일시중지했어요.');}
    else if(action==='resume'){S.paused=false;persist();redraw('v37-history-manage');}
    else if(action==='confirm-delete'&&S.dialog?.type==='delete'){if(S.fault==='delete'){S.fault=null;const error=F.dialog.querySelector('#v37-history-dialog-error');error.hidden=false;error.textContent='기록을 삭제하지 못했어요. 다시 시도해 주세요.';return;}const ids=S.dialog.ids;S.dialog.returnFocusId=null;const commit=()=>{if(F.screen==='history')remove(ids);};if(F.v39Mobile?.afterDialogClose){F.v39Mobile.afterDialogClose(commit);closeDialog();}else{closeDialog();commit();}}
    else if(action==='cancel')closeDialog();
    else if(action==='clear-query'){S.query=S.draft='';applyFilters();}
    else if(action==='reset')resetFilters();
    else if(action==='kind'){S.kind=b.dataset.kind;applyFilters(null);F.root.querySelector(`.v37-history-tabs [data-kind="${S.kind}"]`)?.focus();}
    else if(action==='period')F.openChoice(b,['전체 기간','오늘','최근 7일','최근 30일','기간 직접 선택'],S.period,value=>{if(value==='기간 직접 선택'){if(F.v39Mobile?.afterChoice)F.v39Mobile.afterChoice(()=>openCalendar());else openCalendar();return;}S.period=value;S.to=value==='전체 기간'?'':today();const start=new Date();start.setDate(start.getDate()-(value==='최근 7일'?6:value==='최근 30일'?29:0));S.from=value==='전체 기간'?'':dayKey(start);applyFilters('v37-history-period');});
    else if(action==='month-prev'||action==='month-next'){const c=S.calendar;if(!c)return;const d=dateOf(c.month+'-01');d.setMonth(d.getMonth()+(action==='month-prev'?-1:1));c.month=dayKey(d).slice(0,7);drawCalendar(`[data-action="v37-history-${action}"]:not(:disabled)`);}
    else if(action==='calendar-day'){const c=S.calendar;if(!c)return;const d=b.dataset.date;if(!c.from||c.to){c.from=d;c.to='';}else if(d<c.from){c.to=c.from;c.from=d;}else c.to=d;drawCalendar(`[data-date="${d}"]`);}
    else if(action==='date-apply')dateApply();
    else if(action==='load-more')pageChange(S.page+1);
    else if(action==='retry-page')pageChange(S.pendingPage??S.page+1);
    else if(action==='retry'){S.mode=null;redraw('v37-history-search');}
  },true);
  F.navigate=(id,state,replace=false)=>{const from=F.screen;if(from==='history'&&id!=='history'&&!F.modalScreens.has(id)){rememberList();S.selecting=false;S.selected.clear();}if(from==='login'&&S.loginReturn&&id==='history'&&F.sessionLoggedIn){S.loginReturn=false;state='기본';}else if(S.loginReturn&&id!=='login'&&id!=='history'){if(F.authReturn==='history')F.authReturn=null;S.loginReturn=false;}if(id==='history'&&from!=='history'&&!F.modalScreens.has(from))S.restore=S.visited;return original.navigate(id,state,replace);};
  F.readUrl=(...args)=>{const result=original.read(...args);if(F.screen==='history'){readFilters();S.restore=S.visited;}return result;};
  F.writeUrl=replace=>{if(F.screen==='history')syncUrl(replace);else original.write(replace);};
  F.closeModal=()=>{const returnFocusId=S.dialog?.returnFocusId;if(S.dialog){S.dialog=null;S.calendar=null;}const result=original.close();if(returnFocusId)requestAnimationFrame(()=>{const trigger=document.getElementById(returnFocusId);(trigger&&!trigger.disabled?trigger:document.getElementById('v37-history-manage'))?.focus({preventScroll:true});});return result;};
  F.render=()=>{original.render();if(F.screen==='history'){syncSelectionControl();S.visited=true;if(S.restore){S.restore=false;requestAnimationFrame(()=>{if(F.screen!=='history')return;window.scrollTo({top:S.scroll,behavior:'instant'});F.root.querySelector('#main-content')?.scrollTo({top:S.mainScroll});const target=[S.focusId&&document.getElementById(S.focusId),F.root.querySelector('#v37-history-search'),F.root.querySelector('.v37-history h1')].find(node=>node&&!node.disabled&&node.getClientRects().length);if(target){if(target.tagName==='H1')target.tabIndex=-1;target.focus({preventScroll:true});}});}}};
  readFilters();persist();if(window.FRAME_PROTOTYPE)window.FRAME_PROTOTYPE.navigate=F.navigate;F.render();
})();
