import ui from '../../components/management/ManagementUI.module.css';
import styles from '../vod/VodPages.module.css';
import type { useArchiveWatchHistory } from './useArchiveWatchHistory';

export function archivePosition(ms: number) {
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return (hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes)) + ':' + String(seconds % 60).padStart(2, '0');
}

export function ArchiveHistoryControls({ history, online }: { history: ReturnType<typeof useArchiveWatchHistory>; online: boolean }) {
  if (!history.signedIn || !history.enabled) return null;
  const saved = history.receipt?.item, error = history.phase === 'error' || history.phase === 'conflict';
  if (history.phase === 'loading') return <p className={styles.historyStatus} role="status">시청 기록을 확인하는 중이에요.</p>;
  if (error) return <div className={styles.historyControls}><p role="status">{history.message}</p><button className={ui.button} type="button" disabled={!online} onClick={history.reconnect}>기록 다시 연결</button></div>;
  if (saved && !history.started && (saved.positionMs > 0 || saved.completed)) return <div className={styles.historyControls}>
    <p>{saved.completed ? '시청을 완료한 영상이에요.' : `저장한 위치 ${archivePosition(saved.positionMs)}`}</p>
    {!saved.completed && <button className={ui.button + ' ' + ui.primary} type="button" disabled={!online || history.busy} onClick={history.resume}>이어보기</button>}
    <button className={ui.button} type="button" disabled={!online || history.busy} onClick={history.start}>처음부터 보기</button>
    {history.message && <span role="status">{history.message}</span>}
  </div>;
  return history.busy || history.message ? <p className={styles.historyStatus} role="status">{history.message || '시청 위치를 저장하고 있어요.'}</p> : null;
}
