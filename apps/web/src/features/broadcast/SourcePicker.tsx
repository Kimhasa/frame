import { Check, Monitor, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { broadcastSources } from './broadcast-preview';
import { EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './SourcePicker.module.css';

const tabs = [{ kind: 'window', label: '프로그램 창' }, { kind: 'monitor', label: '전체 화면' }] as const;

export function SourcePicker({ sourceId, live, onApply, onDismiss }: {
  sourceId: string | null;
  live: boolean;
  onApply: (id: string) => void;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [tab, setTab] = useState<'window' | 'monitor'>(() => broadcastSources.find(source => source.id === sourceId)?.kind ?? 'window');
  const [pending, setPending] = useState(sourceId);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const sources = broadcastSources.filter(source => source.kind === tab && `${source.name} ${source.detail}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => sort === 'recent'
      ? Number(b.id === sourceId) - Number(a.id === sourceId)
      : a.name.localeCompare(b.name, 'ko') || a.detail.localeCompare(b.detail, 'ko'));
  const selected = broadcastSources.find(source => source.id === pending);
  const canApply = sources.some(source => source.id === pending);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    search.current?.focus();
    return () => element?.close();
  }, []);

  useEffect(() => { if (confirming) applyButton.current?.focus(); }, [confirming]);

  function dismiss() { dialog.current?.close(); onDismiss(); }

  function apply() {
    if (!selected) return;
    dialog.current?.close();
    onApply(selected.id);
  }

  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.findIndex(item => item.kind === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next].kind);
    setQuery('');
    tabButtons.current[next]?.focus();
    setNotice('');
  }

  function refresh() {
    setQuery('');
    setNotice('공유할 화면 목록을 새로고침했어요.');
  }

  return <dialog ref={dialog} className={`${styles.dialog} ${confirming ? styles.confirmDialog : ''}`} aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={`${id}-title`}>{confirming ? '방송 화면을 변경할까요?' : '공유할 화면'}</h2>
      <button type="button" className="icon-button" aria-label="화면 선택 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    {confirming && selected ? <>
      <p className={styles.confirmCopy}>선택한 화면이 시청자에게 표시됩니다.</p>
      <div className={styles.confirmSource}><strong>{selected.name}</strong><span>{selected.detail}</span></div>
      <footer className={styles.footer}>
        <button type="button" className={ui.button} onClick={() => {
          setConfirming(false);
          requestAnimationFrame(() => selectButton.current?.focus());
        }}>다시 선택</button>
        <button ref={applyButton} type="button" className={`${ui.button} ${ui.primary}`} onClick={apply}>화면 변경</button>
      </footer>
    </> : <>
      <div className={ui.tabs} role="tablist" aria-label="공유할 화면 종류" onKeyDown={handleTabKey}>
        {tabs.map((item, index) => <button key={item.kind} ref={element => { tabButtons.current[index] = element; }}
          type="button" role="tab" id={`${id}-tab-${item.kind}`} aria-controls={`${id}-results`} aria-selected={tab === item.kind}
          tabIndex={tab === item.kind ? 0 : -1} onClick={() => { setTab(item.kind); setQuery(''); setNotice(''); }}>
          <Monitor size={17} aria-hidden="true" />{item.label}
        </button>)}
      </div>
      <div className={styles.tools}>
        <label className={`${styles.search} ${ui.search}`}><Search size={18} aria-hidden="true" /><input ref={search} type="search" name="source-search"
          aria-label="공유 대상 검색" maxLength={100} placeholder="창 이름, 구분 정보 검색" value={query} onChange={event => { setQuery(event.target.value); setNotice(''); }} /></label>
        <select className={ui.control} aria-label="공유 대상 정렬" value={sort} onChange={event => setSort(event.target.value)}><option value="name">이름순</option><option value="recent">최근 사용순</option></select>
      </div>
      <div id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
        {sources.length > 0 ? <div className={styles.grid}>
          {sources.map(source => <button key={source.id} type="button" className={styles.source} aria-pressed={pending === source.id}
            aria-label={`${source.name} · ${source.detail}`} onClick={() => { setPending(source.id); setNotice(''); }}>
            <span className={styles.thumbnail}><img src={source.image} alt="" />{pending === source.id && <span className={styles.check}><Check size={16} aria-hidden="true" /></span>}</span>
            <span className={styles.sourceName}><Monitor size={18} aria-hidden="true" /><span><strong>{source.name}</strong><small>{source.detail}</small></span></span>
          </button>)}
        </div> : <EmptyState icon={<Monitor size={28} />} title={needle ? '검색한 화면이 없어요' : '공유할 수 있는 화면이 없어요'}
          action={<button type="button" className={ui.button} onClick={refresh}>{needle ? '검색어 지우기' : '새로고침'}</button>} />}
      </div>
      <p className={styles.notice} role="status">{notice}</p>
      <footer className={styles.footer}>
        <button type="button" className={`${ui.button} ${styles.refresh}`} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />새로고침</button>
        <button type="button" className={ui.button} onClick={dismiss}>취소</button>
        <button ref={selectButton} type="button" className={`${ui.button} ${ui.primary}`} disabled={!canApply} onClick={() => {
          if (!canApply) return;
          if (live && pending !== sourceId) setConfirming(true);
          else apply();
        }}>선택</button>
      </footer>
    </>}
  </dialog>;
}
