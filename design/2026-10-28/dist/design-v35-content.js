/* Public content metadata. Counts are prototype content fixtures, never live viewer counts. */
(()=>{
  const F=window.F;if(!F)return;
  const card=F.card,channel=F.channel,catalog=F.catalog,render=F.render;
  const S=F.v35Content={records:new Map()};
  const formatViews=value=>Number.isFinite(value)&&value>=0?'조회수 '+Math.floor(value).toLocaleString('ko-KR')+'회':'';
  function read(node){
    const meta=node.querySelector('.card-category');if(!meta)return null;
    const parts=[...meta.children].filter(x=>!x.hasAttribute('aria-hidden')).map(x=>x.textContent.trim());
    const source=parts.length?parts.join(' '):meta.textContent.trim();
    const count=source.match(/조회(?:수)?\s*([\d,]+(?:\.\d+)?)\s*(천|만|억)?\s*회?/);
    if(!count)return null;
    const value=Number(count[1].replaceAll(',',''))*({'천':1000,'만':10000,'억':100000000}[count[2]]||1);
    const age=parts.length>1?parts.at(-1):source.slice(count.index+count[0].length).replace(/^[\s·•]+/,'');
    const channelIndex=Number(node.querySelector('[data-broadcast]')?.dataset.broadcast||0);
    const title=node.querySelector('.card-title')?.textContent.trim()||'';
    const kind=node.dataset.cardMode==='clip'||node.querySelector('[data-go="clip-watch"]')?'clip':'vod';
    return {meta,record:{id:kind+':'+channelIndex+':'+title,channelIndex,kind,title,viewCount:value,publishedLabel:age,source:'existing-prototype-fixture'}};
  }
  function normalize(scope){
    scope?.querySelectorAll('.v3-card').forEach(node=>{
      if(node.dataset.cardMode==='live'||node.querySelector('.v2-live-badge'))return;
      const data=read(node);if(!data)return;
      const {record,meta}=data;S.records.set(record.id,record);node.dataset.contentId=record.id;node.dataset.viewCount=String(record.viewCount);
      meta.classList.add('v35-content-meta');
      const count=document.createElement('span');count.textContent=formatViews(record.viewCount);
      const elements=[count];
      if(record.publishedLabel){const separator=document.createElement('span');separator.className='v35-meta-separator';separator.textContent='·';separator.setAttribute('aria-hidden','true');const time=document.createElement('span');time.textContent=record.publishedLabel;elements.push(separator,time);}
      meta.replaceChildren(...elements);
    });
  }
  F.card=(...args)=>{const h=document.createElement('div');h.innerHTML=card(...args);normalize(h);return h.innerHTML;};
  F.channel=(...args)=>{const h=document.createElement('div');h.innerHTML=channel(...args);normalize(h);return h.innerHTML;};
  F.catalog=(id,state)=>{
    const selected=F.v33Viewer?.sort[id],popular=['vod','clips'].includes(id)&&selected==='인기순';
    let html;
    if(popular)F.v33Viewer.sort[id]='최신순';
    try{html=catalog(id,state);}finally{if(popular)F.v33Viewer.sort[id]=selected;}
    const h=document.createElement('div');h.innerHTML=html;normalize(h);
    if(popular){
      h.querySelectorAll('.v3-grid').forEach(grid=>[...grid.children].filter(x=>x.matches('.v3-card')).sort((a,b)=>Number(b.dataset.viewCount??-1)-Number(a.dataset.viewCount??-1)).forEach(node=>grid.append(node)));
      const sort=h.querySelector('[data-action="v33-viewer-sort"]');if(sort)sort.innerHTML='인기순'+F.icon('chevron');
    }
    return h.innerHTML;
  };
  F.render=()=>{render();normalize(F.root);};
  S.formatViews=formatViews;
  F.render();
})();
