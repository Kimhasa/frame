import { ChevronDown, Link2, Mic, Settings2, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { BroadcastSettingsValues } from './broadcast-preview';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './BroadcastSettings.module.css';

const tabs = [{ id: 'video', label: '영상' }, { id: 'audio', label: '오디오' }, { id: 'recording', label: '녹화' }] as const;
const resolutions = ['360p', '480p', '720p', '1080p', '1440p', '2160p (4K)'];
const frameRates = ['30 fps', '60 fps', '90 fps', '120 fps', '144 fps', '165 fps'];

function automaticBitrate(resolution: string, fps: string) {
  const pixels: Record<string, number> = { '360p': 640 * 360, '480p': 854 * 480, '720p': 1280 * 720, '1080p': 1920 * 1080, '1440p': 2560 * 1440, '2160p (4K)': 3840 * 2160 };
  return Math.round(8 * (pixels[resolution] ?? 1920 * 1080) / (1920 * 1080) * Math.pow(Number.parseInt(fps) / 60, .8) * 2) / 2;
}

export function BroadcastSettings({ settings, onSave, onDismiss, onConnectionStatus }: {
  settings: BroadcastSettingsValues;
  onSave: (settings: BroadcastSettingsValues) => void;
  onDismiss: () => void;
  onConnectionStatus: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const bitrate = useRef<HTMLInputElement>(null);
  const storage = useRef<HTMLInputElement>(null);
  const id = useId();
  const [draft, setDraft] = useState(() => ({ ...settings }));
  const [tab, setTab] = useState<typeof tabs[number]['id']>('video');
  const [advanced, setAdvanced] = useState(!settings.autoBitrate);
  const [bitrateInput, setBitrateInput] = useState(String(settings.bitrate));
  const [storageChoice, setStorageChoice] = useState([50, 100, 200].includes(settings.storageGb) ? String(settings.storageGb) : 'custom');
  const [storageInput, setStorageInput] = useState(String(settings.storageGb));
  const [error, setError] = useState<{ field: 'bitrate' | 'storage'; message: string } | null>(null);
  const autoRate = automaticBitrate(draft.resolution, draft.fps);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    tabList.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    return () => element?.close();
  }, []);

  function dismiss() { dialog.current?.close(); onDismiss(); }

  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex(item => item.id === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next].id);
    tabList.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(id + '-tab-' + tabs[next].id)}`)?.focus();
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rate = draft.autoBitrate ? autoRate : Number(bitrateInput);
    if (!draft.autoBitrate && (!bitrateInput.trim() || !Number.isFinite(rate) || rate < .5 || rate > 200)) {
      setTab('video'); setAdvanced(true); setError({ field: 'bitrate', message: '0.5~200 Mbps 사이의 값을 입력해 주세요.' });
      requestAnimationFrame(() => bitrate.current?.focus());
      return;
    }
    const limit = storageChoice === 'custom' ? Number(storageInput) : Number(storageChoice);
    const validStorage = (storageChoice !== 'custom' || Boolean(storageInput.trim())) && Number.isInteger(limit) && limit >= 1 && limit <= 100_000;
    if (draft.recording && !validStorage) {
      setTab('recording'); setError({ field: 'storage', message: '저장 한도는 1~100,000 GB 사이의 정수로 입력해 주세요.' });
      requestAnimationFrame(() => storage.current?.focus());
      return;
    }
    dialog.current?.close();
    onSave({ ...draft, bitrate: rate, storageGb: validStorage ? limit : settings.storageGb });
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={`${id}-title`}>방송 설정</h2>
      <button type="button" className="icon-button" aria-label="방송 설정 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <form noValidate onSubmit={save}>
      <div ref={tabList} className={ui.tabs} role="tablist" aria-label="방송 설정 항목" onKeyDown={handleTabKey}>
        {tabs.map(item => <button key={item.id} id={`${id}-tab-${item.id}`} type="button" role="tab"
          aria-selected={tab === item.id} aria-controls={`${id}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <section id={`${id}-panel-video`} className={styles.panel} role="tabpanel" aria-labelledby={`${id}-tab-video`} hidden={tab !== 'video'} tabIndex={0}>
        <div className={styles.fieldPair}>
          <label className={styles.field}>해상도<select className={ui.control} name="resolution" value={draft.resolution} onChange={event => setDraft({ ...draft, resolution: event.target.value })}>{resolutions.map(value => <option key={value}>{value}</option>)}</select></label>
          <label className={styles.field}>프레임률<select className={ui.control} name="fps" value={draft.fps} onChange={event => setDraft({ ...draft, fps: event.target.value })}>{frameRates.map(value => <option key={value}>{value}</option>)}</select></label>
        </div>
        <button type="button" className={styles.advancedToggle} aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)}>
          <Settings2 size={17} aria-hidden="true" />고급 설정<ChevronDown size={16} aria-hidden="true" />
        </button>
        <div id={`${id}-advanced`} className={styles.advanced} hidden={!advanced}>
          <div className={styles.field}>
            <div className={styles.fieldHeading}><label htmlFor={`${id}-bitrate`}>비트레이트</label><label className={styles.check}><input className={ui.checkbox} name="autoBitrate" type="checkbox" checked={draft.autoBitrate} onChange={event => {
              setDraft({ ...draft, autoBitrate: event.target.checked });
              if (!event.target.checked) setBitrateInput(String(autoRate));
              setError(null);
            }} />자동</label></div>
            <div className={styles.unitField}><input className={ui.control} ref={bitrate} id={`${id}-bitrate`} name="bitrate" type="number" min="0.5" max="200" step="0.5" value={draft.autoBitrate ? autoRate : bitrateInput} disabled={draft.autoBitrate}
              aria-invalid={error?.field === 'bitrate'} aria-describedby={error?.field === 'bitrate' ? `${id}-error` : `${id}-bitrate-help`}
              onChange={event => { setBitrateInput(event.target.value); setError(null); }} /><span>Mbps</span></div>
            <p id={`${id}-bitrate-help`} className={styles.help}>{draft.autoBitrate ? '송출 해상도와 프레임률을 기준으로 계산해요.' : '직접 입력한 값을 유지해요.'}</p>
            {error?.field === 'bitrate' && <p id={`${id}-error`} className={styles.error} role="alert">{error.message}</p>}
          </div>
          <div className={styles.fieldPair}>
            <label className={styles.field}>코덱<select className={ui.control} name="codec" value={draft.codec} onChange={event => setDraft({ ...draft, codec: event.target.value })}>{['H.264', 'HEVC', 'AV1'].map(value => <option key={value}>{value}</option>)}</select></label>
            <label className={styles.field}>인코더<select className={ui.control} name="encoder" value={draft.encoder} onChange={event => setDraft({ ...draft, encoder: event.target.value })}>{['자동 (하드웨어 우선)', 'NVENC', 'QSV', 'AMF', '소프트웨어'].map(value => <option key={value}>{value}</option>)}</select></label>
          </div>
        </div>
      </section>
      <section id={`${id}-panel-audio`} className={styles.panel} role="tabpanel" aria-labelledby={`${id}-tab-audio`} hidden={tab !== 'audio'} tabIndex={0}>
        <div className={styles.audioRow}>
          <div className={styles.audioHeading}><Volume2 size={18} aria-hidden="true" /><label htmlFor={`${id}-system-volume`}>시스템 소리</label><span>{draft.systemVolume}%</span>
            <button className={styles.muteButton} type="button" aria-label="시스템 소리 음소거" aria-pressed={draft.systemMuted} onClick={() => setDraft({ ...draft, systemMuted: !draft.systemMuted })}>{draft.systemMuted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}</button>
          </div>
          <input id={`${id}-system-volume`} name="systemVolume" type="range" min="0" max="100" value={draft.systemVolume} aria-label="시스템 소리 음량" onChange={event => setDraft({ ...draft, systemVolume: Number(event.target.value) })} />
          <div className={styles.meter} aria-hidden="true"><span style={{ width: `${draft.systemMuted ? 0 : draft.systemVolume}%` }} /></div>
        </div>
        <div className={styles.audioRow}>
          <div className={styles.audioHeading}><Mic size={18} aria-hidden="true" /><span>마이크</span><span>{draft.micVolume}%</span>
            <button className={styles.muteButton} type="button" aria-label="마이크 음소거" aria-pressed={draft.micMuted} onClick={() => setDraft({ ...draft, micMuted: !draft.micMuted })}>{draft.micMuted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}</button>
          </div>
          <label className={styles.field}>마이크 장치<select className={ui.control} name="microphone" value={draft.microphone} onChange={event => setDraft({ ...draft, microphone: event.target.value })}><option>기본 마이크</option><option>마이크 사용 안 함</option></select></label>
          <label className={styles.srOnly} htmlFor={`${id}-mic-volume`}>마이크 음량</label>
          <input id={`${id}-mic-volume`} name="micVolume" type="range" min="0" max="100" value={draft.micVolume} disabled={draft.microphone === '마이크 사용 안 함'} onChange={event => setDraft({ ...draft, micVolume: Number(event.target.value) })} />
          <div className={styles.meter} aria-hidden="true"><span style={{ width: `${draft.micMuted || draft.microphone === '마이크 사용 안 함' ? 0 : draft.micVolume}%` }} /></div>
        </div>
      </section>
      <section id={`${id}-panel-recording`} className={styles.panel} role="tabpanel" aria-labelledby={`${id}-tab-recording`} hidden={tab !== 'recording'} tabIndex={0}>
        <label className={`${styles.check} ${styles.recordingCheck}`}><span>방송 녹화</span><input className={ui.checkbox} name="recording" type="checkbox" role="switch" checked={draft.recording} onChange={event => { setDraft({ ...draft, recording: event.target.checked }); setError(null); }} /></label>
        <label className={styles.field}>저장 한도<select className={ui.control} name="storageChoice" value={storageChoice} disabled={!draft.recording} onChange={event => { setStorageChoice(event.target.value); setError(null); }}><option value="50">50 GB</option><option value="100">100 GB</option><option value="200">200 GB</option><option value="custom">직접 입력</option></select></label>
        {storageChoice === 'custom' && <label className={styles.field}>저장 한도 (GB)<input className={ui.control} ref={storage} name="storageGb" type="number" min="1" max="100000" step="1" inputMode="numeric" value={storageInput} disabled={!draft.recording}
          aria-invalid={error?.field === 'storage'} aria-describedby={error?.field === 'storage' ? `${id}-error` : undefined}
          onChange={event => { setStorageInput(event.target.value); setError(null); }} /></label>}
        {error?.field === 'storage' && <p id={`${id}-error`} className={styles.error} role="alert">{error.message}</p>}
      </section>
      <footer className={ui.dialogActions}><button type="button" className={`${ui.button} ${styles.connectionButton}`} aria-haspopup="dialog" onClick={onConnectionStatus}><Link2 size={16} aria-hidden="true" />연결 상태</button><button type="button" className={ui.button} onClick={dismiss}>취소</button><button type="submit" className={`${ui.button} ${ui.primary}`}>저장</button></footer>
    </form>
  </dialog>;
}
