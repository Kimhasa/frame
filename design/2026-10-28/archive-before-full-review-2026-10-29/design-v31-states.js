/* Compact, actionable empty states for the design prototype. */
(()=>{
'use strict';
const F=window.F,e=F.e;
const copy={
 '로그인하고 팔로우한 방송을 만나보세요':{kind:'login',title:'팔로잉을 보려면 로그인하세요',description:'팔로우한 채널의 방송을 한곳에서 볼 수 있어요.',button:'로그인',action:'go:login',icon:'user'},
 '진행 중인 방송이 없어요':{kind:'empty',title:'지금은 방송 중인 채널이 없어요',description:'',button:'다시 확인',action:'v31-states-retry',icon:'live'},
 '방송 목록을 불러오지 못했어요':{kind:'error',title:'방송 목록을 불러오지 못했어요',description:'연결 상태를 확인한 뒤 다시 시도해 주세요.',button:'다시 시도',action:'v31-states-retry',icon:'refresh'},
 '팔로우한 채널이 없어요':{kind:'empty',title:'아직 팔로우한 채널이 없어요',description:'마음에 드는 채널을 팔로우하고 새 방송을 만나보세요.',button:'라이브 둘러보기',action:'go:live',icon:'heart'},
 '검색 결과가 없어요':{kind:'search',title:'검색 결과가 없어요',description:'검색어의 철자를 확인하거나 다른 단어로 검색해 보세요.',button:'검색어 수정',action:'v31-states-search-focus',icon:'search'},
 '어떤 방송을 찾고 있나요?':{kind:'search',title:'어떤 방송을 찾고 있나요?',description:'방송 제목이나 채널 이름으로 검색해 보세요.',button:'검색하기',action:'v31-states-search-focus',icon:'search'},
 '등록된 다시보기가 없어요':{kind:'empty',title:'아직 공개된 다시보기가 없어요',description:'',button:'라이브 둘러보기',action:'go:live',icon:'video'},
 '등록된 클립이 없어요':{kind:'empty',title:'아직 공개된 클립이 없어요',description:'',button:'라이브 둘러보기',action:'go:live',icon:'clip'},
 '아직 시청 기록이 없어요':{kind:'empty',title:'아직 시청한 방송이 없어요',description:'',button:'라이브 둘러보기',action:'go:live',icon:'history'},
 '추천할 방송을 준비하고 있어요':{kind:'empty',title:'추천할 방송을 찾고 있어요',description:'라이브 목록에서 먼저 마음에 드는 방송을 찾아보세요.',button:'라이브 둘러보기',action:'go:live',icon:'live'},
 '새로운 알림이 없어요':{kind:'empty',title:'새로운 알림이 없어요',description:'',button:'',action:'',icon:'bell'},
 '조건에 맞는 기록이 없어요':{kind:'empty',title:'조건에 맞는 기록이 없어요',description:'선택한 조건을 바꾸거나 초기화해 주세요.',button:'조건 초기화',action:'retry',icon:'history'}
};
const inferKind=(title,action)=>action==='go:login'?'login':/실패|불러오지 못|연결하지 못/.test(title)?'error':/검색/.test(title)?'search':'empty';
F.empty=(title,description='',button='새로고침',action='retry',ico='monitor')=>{
 const item=copy[title]||{kind:inferKind(title,action),title,description,button,action,icon:ico};
 const failure=item.kind==='error';
 const actionIcon=item.action==='v31-states-search-focus'?'edit':failure||item.action==='v31-states-retry'?'refresh':item.action==='go:login'?'user':'';
 return `<section class="empty-state v31-empty v31-empty-${item.kind}" data-v31-state="${item.kind}" role="${failure?'alert':'status'}" aria-live="${failure?'assertive':'polite'}" aria-atomic="true"><span class="v31-empty-icon" aria-hidden="true">${F.icon(item.icon)}</span><h2>${e(item.title)}</h2>${item.description?`<p>${e(item.description)}</p>`:''}${item.button?`<div class="v31-empty-actions">${F.btn(e(item.button),item.action,actionIcon,`v31-empty-action${item.kind==='login'?' primary':''}`)}</div>`:''}</section>`;
};
// Keep the existing result renderer and search form; only replace its introductory state.
const search=F.v3Search;
if(search)F.v3Search=state=>{
 const html=search(state);
 if((F.searchQuery||'').trim())return html;
 const holder=document.createElement('div');holder.innerHTML=html;
 const intro=holder.querySelector('.v3-search-intro');
 if(intro){
  const suggestions=`<div class="v31-search-suggestions" aria-label="추천 검색어"><span>추천 검색어</span>${['개발','게임','그림'].map(word=>F.btn(e(word),'v3-search-suggestion','','v31-suggestion',`data-query="${e(word)}"`)).join('')}</div>`;
  intro.outerHTML=`<div class="v31-search-intro">${F.empty('어떤 방송을 찾고 있나요?')}${suggestions}</div>`;
 }
 return holder.innerHTML;
};
function focusSearch(){
 const candidates=Array.from(document.querySelectorAll('#header-search input[name="query"],#catalog-search input[name="query"],.v3-mobile-search input[type="search"]'));
 const input=candidates.find(node=>!node.disabled&&!node.closest('[hidden], [inert]')&&node.getClientRects().length);
 if(input){
  input.focus({preventScroll:true});input.select();input.scrollIntoView({block:'nearest',behavior:'smooth'});
  return;
 }
 // This path only occurs when a search state is rendered outside the search page.
 F.navigate('search');
 requestAnimationFrame(()=>{
  const field=Array.from(document.querySelectorAll('#header-search input[name="query"],#catalog-search input[name="query"]')).find(node=>node.getClientRects().length);
  if(field){field.focus({preventScroll:true});field.select();field.scrollIntoView({block:'nearest'});}
 });
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-action^="v31-states-"]');if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 if(button.dataset.action==='v31-states-search-focus')focusSearch();
 else if(button.dataset.action==='v31-states-retry'){
  const screen=F.data.screens.find(item=>item.id===F.screen);
  if(screen)F.setState(screen.states[0]);
 }
},true);
})();
