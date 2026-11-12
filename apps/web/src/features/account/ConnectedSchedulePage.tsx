import { CalendarDays } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { SchedulePage } from '../schedule/SchedulePage';
import { AccountError, accountApi } from './account-client';
import type { AccountSession, ScheduleChanges, ScheduledBroadcast } from './account-client';
import styles from './ConnectedAccount.module.css';

export function ConnectedSchedulePage({ session, onRequireLogin }: { session: AccountSession; onRequireLogin: () => void }) {
  const [items, setItems] = useState<ScheduledBroadcast[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  function requireLogin(failure: unknown) {
    if (active.current && failure instanceof AccountError && failure.status === 401 && ['UNAUTHENTICATED', 'SESSION_REQUIRED'].includes(failure.code)) onRequireLogin();
  }
  useEffect(() => {
    const abort = new AbortController();
    setPhase('loading'); setError('');
    accountApi.scheduleList(abort.signal).then(value => {
      if (!abort.signal.aborted) { setItems(value); setPhase('ready'); }
    }).catch(failure => {
      if (abort.signal.aborted) return;
      requireLogin(failure);
      setError(failure instanceof Error ? failure.message : '방송 예약을 불러오지 못했어요.');
      setPhase('error');
    });
    return () => abort.abort();
  }, [attempt, session.user?.id]);

  async function save(changes: ScheduleChanges, id?: string) {
    try {
      const saved = id ? await accountApi.updateSchedule(id, changes, session.csrfToken) : await accountApi.createSchedule(changes, session.csrfToken);
      if (active.current) setItems(rows => [saved, ...rows.filter(row => row.id !== saved.id)]);
    } catch (failure) { requireLogin(failure); throw failure; }
  }
  async function cancel(id: string) {
    try {
      await accountApi.cancelSchedule(id, session.csrfToken);
      if (active.current) setItems(rows => rows.filter(row => row.id !== id));
    } catch (failure) { requireLogin(failure); throw failure; }
  }

  if (phase !== 'ready') return <ManagementPage title="방송 예약" titleId="schedule-title">
    {phase === 'loading' ? <p role="status">방송 예약을 불러오는 중이에요.</p> : <>
      <p className={styles.error} role="alert">{error}</p>
      <EmptyState icon={<CalendarDays size={23} />} title="방송 예약을 불러오지 못했어요"
        action={<button className={ui.button} type="button" onClick={() => setAttempt(value => value + 1)}>다시 시도</button>} />
    </>}
  </ManagementPage>;
  return <SchedulePage items={items} onSave={save} onCancelReservation={cancel} />;
}
