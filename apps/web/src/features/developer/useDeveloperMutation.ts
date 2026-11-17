import { useEffect, useRef, useState } from 'react';
import { developerFailure, uncertainMutation } from './developer-client';

export type DeveloperAccessError = (failure: unknown) => boolean;
export function useDeveloperMutation<T>({ run, verify, onSaved, onAccessError }: {
  run: (requestId: string) => Promise<{ item: T; secret?: string }>;
  verify: (requestId: string) => Promise<T>;
  onSaved: (item: T) => void;
  onAccessError: DeveloperAccessError;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<'idle' | 'busy' | 'uncertain' | 'absent' | 'done'>('idle');
  const [error, setError] = useState(''), [secret, setSecret] = useState(''), [recovered, setRecovered] = useState(false);
  const active = useRef(true), pending = useRef(false), callbacks = useRef({ run, verify, onSaved, onAccessError });
  callbacks.current = { run, verify, onSaved, onAccessError };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function check() {
    if (pending.current) return;
    pending.current = true; setPhase('busy'); setError('');
    try {
      const item = await callbacks.current.verify(requestId);
      if (!active.current) return;
      callbacks.current.onSaved(item); setRecovered(true); setPhase('done');
    } catch (failure) {
      if (!active.current || callbacks.current.onAccessError(failure)) return;
      const problem = developerFailure(failure);
      setPhase(problem.status === 404 ? 'absent' : 'uncertain');
      setError(problem.status === 404 ? '이 요청의 처리 내역을 아직 찾지 못했어요. 결과를 다시 확인하거나, 같은 요청 번호로 다시 시도할 수 있어요.' : '결과를 확인하지 못했어요. 연결을 확인한 뒤 결과 확인을 다시 눌러 주세요.');
    } finally { pending.current = false; }
  }
  async function submit() {
    if (pending.current || (phase !== 'idle' && phase !== 'absent')) return;
    pending.current = true; setPhase('busy'); setError('');
    try {
      const result = await callbacks.current.run(requestId);
      if (!active.current) return;
      callbacks.current.onSaved(result.item); setSecret(result.secret ?? ''); setPhase('done');
    } catch (failure) {
      if (!active.current || callbacks.current.onAccessError(failure)) return;
      if (uncertainMutation(failure)) { setPhase('uncertain'); setError('서버가 요청을 처리했는지 확인이 필요해요. 중복 요청을 보내기 전에 결과를 확인해 주세요.'); }
      else { setPhase('idle'); setError(developerFailure(failure).message); }
    } finally { pending.current = false; }
  }
  return { phase, error, secret, recovered, busy: phase === 'busy', locked: ['uncertain', 'absent'].includes(phase), submit, check };
}
