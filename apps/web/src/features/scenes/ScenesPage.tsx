import { Layers, Mic, Monitor, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import workspace from '../../preview/assets/code-workspace.svg';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './ScenesPage.module.css';

const sourceTypes = ['프로그램 창', '브라우저 오버레이', '마이크'] as const;
type SceneSource = { id: string; name: string; type: typeof sourceTypes[number]; enabled: boolean };
type PreviewScene = { id: string; name: string; sources: SceneSource[] };
type ScenesPreview = { scenes: PreviewScene[]; activeId: string | null };
type Editor = { kind: 'scene' } | { kind: 'source'; sceneId: string } | { kind: 'delete'; sceneId: string; source: SceneSource };

function previewId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPreviewScenes(): ScenesPreview {
  return {
    activeId: 'scene-1',
    scenes: [{ id: 'scene-1', name: '기본 화면', sources: [
      { id: 'source-1', name: 'Visual Studio Code', type: '프로그램 창', enabled: true },
      { id: 'source-2', name: '알림 · 후원', type: '브라우저 오버레이', enabled: true },
      { id: 'source-3', name: '기본 장치', type: '마이크', enabled: true },
    ] }],
  };
}

function ScenePreview({ scene }: { scene: PreviewScene }) {
  const enabled = scene.sources.filter(source => source.enabled);
  const program = enabled.find(source => source.type === '프로그램 창');
  const overlays = enabled.filter(source => source.type === '브라우저 오버레이');
  const microphones = enabled.filter(source => source.type === '마이크');
  return <section className={styles.previewCard} aria-label={`${scene.name} 장면 미리보기`}>
    <div className={styles.canvas}>
      {program ? <img src={workspace} alt={`${program.name} 화면`} /> : <div className={styles.canvasEmpty}>
        <Monitor size={30} aria-hidden="true" /><p>표시할 화면 소스가 없어요</p>
      </div>}
      {overlays.length > 0 && <div className={styles.overlays} aria-label="사용 중인 오버레이">
        {overlays.map(source => <span key={source.id}>{source.name}</span>)}
      </div>}
    </div>
    <div className={styles.previewCaption}>
      <h2>{scene.name}</h2>
      <span>{enabled.length}개 소스 사용 중</span>
      {microphones.length > 0 && <p><Mic size={15} aria-hidden="true" />{microphones.map(source => source.name).join(', ')}</p>}
    </div>
  </section>;
}

function SceneDialog({ editor, cloneAvailable, onDismiss, onScene, onSource, onDelete }: {
  editor: Editor;
  cloneAvailable: boolean;
  onDismiss: () => void;
  onScene: (name: string, clone: boolean) => string | null;
  onSource: (sceneId: string, name: string, type: SceneSource['type']) => void;
  onDelete: (sceneId: string, sourceId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const errorId = useId();
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    if (editor.kind === 'delete') cancel.current?.focus();
    else input.current?.focus();
    return () => element?.close();
  }, []);

  function dismiss() { dialog.current?.close(); onDismiss(); }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editor.kind === 'delete') return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const maximum = editor.kind === 'scene' ? 40 : 80;
    if (!name || name.length > maximum) { setError(`이름을 ${maximum}자 이내로 입력해 주세요.`); return; }
    if (editor.kind === 'scene') {
      const message = onScene(name, form.get('mode') === 'clone');
      if (message) { setError(message); return; }
      dialog.current?.close();
    } else {
      const type = sourceTypes.find(type => type === form.get('type'));
      if (!type) { setError('소스 종류를 선택해 주세요.'); return; }
      dialog.current?.close();
      onSource(editor.sceneId, name, type);
    }
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>{editor.kind === 'scene' ? '장면 추가' : editor.kind === 'source' ? '소스 추가' : '이 장면에서 소스를 삭제할까요?'}</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    {editor.kind === 'delete' ? <>
      <p className={styles.deleteName}>{editor.source.name}</p>
      <div className={ui.dialogActions}>
        <button ref={cancel} type="button" className={ui.button} onClick={dismiss}>취소</button>
        <button type="button" className={`${ui.button} ${ui.danger}`} onClick={() => {
          dialog.current?.close();
          onDelete(editor.sceneId, editor.source.id);
        }}>소스 삭제</button>
      </div>
    </> : <form className={styles.editor} noValidate onSubmit={submit}>
      <label>이름<input className={ui.control} ref={input} name="name" maxLength={editor.kind === 'scene' ? 40 : 80} required aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onInput={() => setError('')} /></label>
      {editor.kind === 'scene'
        ? <label>초기 구성<select className={ui.control} name="mode" defaultValue="empty"><option value="empty">빈 장면</option><option value="clone" disabled={!cloneAvailable}>현재 장면 복제</option></select></label>
        : <label>종류<select className={ui.control} name="type">{sourceTypes.map(type => <option key={type}>{type}</option>)}</select></label>}
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} onClick={dismiss}>취소</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>추가</button>
      </div>
    </form>}
  </dialog>;
}

export function ScenesPage({ preview, onChange }: { preview: ScenesPreview; onChange: (preview: ScenesPreview) => void }) {
  const [params, setParams] = useSearchParams();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState('');
  const scenes = params.get('state') === 'empty' ? [] : preview.scenes;
  const selected = scenes.find(scene => scene.id === preview.activeId) ?? scenes[0];

  function addScene(name: string, clone: boolean) {
    if (preview.scenes.some(scene => scene.name === name)) return '다른 장면 이름을 입력해 주세요.';
    if (clone && !selected) return '복제할 장면을 선택해 주세요.';
    const scene = {
      id: previewId('scene'), name,
      sources: clone ? selected!.sources.map(source => ({ ...source, id: previewId('source') })) : [],
    };
    onChange({ scenes: [...preview.scenes, scene], activeId: scene.id });
    setEditor(null);
    const next = new URLSearchParams(params);
    next.delete('state');
    setParams(next, { replace: true });
    setNotice(`‘${name}’ 장면을 추가했어요.`);
    return null;
  }

  function addSource(sceneId: string, name: string, type: SceneSource['type']) {
    const source = { id: previewId('source'), name, type, enabled: true };
    onChange({ ...preview, scenes: preview.scenes.map(scene => scene.id === sceneId ? { ...scene, sources: [...scene.sources, source] } : scene) });
    setEditor(null);
    setNotice(`‘${name}’ 소스를 추가했어요.`);
  }

  function toggleSource(sceneId: string, sourceId: string) {
    onChange({ ...preview, scenes: preview.scenes.map(scene => scene.id === sceneId
      ? { ...scene, sources: scene.sources.map(source => source.id === sourceId ? { ...source, enabled: !source.enabled } : source) } : scene) });
  }

  function deleteSource(sceneId: string, sourceId: string) {
    onChange({ ...preview, scenes: preview.scenes.map(scene => scene.id === sceneId
      ? { ...scene, sources: scene.sources.filter(source => source.id !== sourceId) } : scene) });
    setEditor(null);
    setNotice('소스를 삭제했어요.');
    requestAnimationFrame(() => document.getElementById('add-scene-source')?.focus());
  }

  return <ManagementPage title="장면 관리" titleId="scenes-title" actions={<button type="button" className={`${ui.button} ${ui.primary}`} aria-haspopup="dialog" onClick={() => setEditor({ kind: 'scene' })}><Plus size={17} aria-hidden="true" />장면 추가</button>}>
    {selected ? <>
      <div className={styles.sceneList} role="group" aria-label="장면 선택">
        {scenes.map(scene => <button key={scene.id} type="button" className={ui.button} aria-pressed={scene.id === selected.id}
          onClick={() => { onChange({ ...preview, activeId: scene.id }); setNotice(''); }}>{scene.name}</button>)}
      </div>
      <div className={styles.layout}>
        <ScenePreview scene={selected} />
        <section className={styles.sources} aria-labelledby="scene-sources-title">
          <header className={styles.sourcesHeader}><h2 id="scene-sources-title">소스</h2>
            <button id="add-scene-source" type="button" className={ui.button} aria-haspopup="dialog" onClick={() => setEditor({ kind: 'source', sceneId: selected.id })}><Plus size={16} aria-hidden="true" />소스 추가</button>
          </header>
          {selected.sources.length ? <ul className={styles.sourceList}>
            {selected.sources.map(source => <li key={source.id}>
              <div className={styles.sourceCopy}><h3>{source.name}</h3><p>{source.type}</p><StatusBadge tone={source.enabled ? 'positive' : 'neutral'}>{source.enabled ? '사용 중' : '사용 중지'}</StatusBadge></div>
              <div className={styles.sourceActions}>
                <button type="button" className={ui.button} aria-label={`${source.name} ${source.enabled ? '사용 중지' : '사용'}`} onClick={() => toggleSource(selected.id, source.id)}>{source.enabled ? '사용 중지' : '사용'}</button>
                <button type="button" className={ui.button} aria-label={`${source.name} 삭제`} aria-haspopup="dialog" onClick={() => setEditor({ kind: 'delete', sceneId: selected.id, source })}>삭제</button>
              </div>
            </li>)}
          </ul> : <div className={styles.sourceEmpty}>이 장면에 소스가 없어요.</div>}
        </section>
      </div>
    </> : <EmptyState icon={<Layers size={26} />} title="등록된 장면이 없어요" />}
    <p className={styles.notice} role="status">{notice}</p>
    {editor && <SceneDialog editor={editor} cloneAvailable={Boolean(selected)} onDismiss={() => setEditor(null)}
      onScene={addScene} onSource={addSource} onDelete={deleteSource} />}
  </ManagementPage>;
}
