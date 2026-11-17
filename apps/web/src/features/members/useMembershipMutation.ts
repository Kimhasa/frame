import { useEffect, useRef, useState } from 'react';
import { membershipFailure, membershipUncertain } from './membership-client';
export type MembershipAccessError = (failure: unknown) => boolean;
export function useMembershipMutation<T>({ run, verify, onSaved, onAccessError }: { run: (requestId: string, signal: AbortSignal) => Promise<T>; verify: (requestId: string, signal: AbortSignal) => Promise<T>; onSaved: (value: T) => void; onAccessError: MembershipAccessError }) {
  const [requestId] = useState(() => crypto.randomUUID()), [phase, setPhase] = useState<'idle' | 'busy' | 'uncertain' | 'absent' | 'done'>('idle'), [error, setError] = useState('');
  const generation = useRef(0), active = useRef(true), pending = useRef(false), request = useRef<AbortController | null>(null), callbacks = useRef({ run, verify, onSaved, onAccessError }); callbacks.current = { run, verify, onSaved, onAccessError };
  useEffect(() => { active.current = true; generation.current += 1; return () => { active.current = false; generation.current += 1; pending.current = false; request.current?.abort(); }; }, []);
  async function act(check: boolean) {
    if (pending.current || (!check && phase !== 'idle' && phase !== 'absent')) return;
    const visit = generation.current, abort = new AbortController(); request.current = abort; pending.current = true; setPhase('busy'); setError('');
    const current = () => active.current && generation.current === visit && !abort.signal.aborted;
    try { const result = await (check ? callbacks.current.verify(requestId, abort.signal) : callbacks.current.run(requestId, abort.signal)); if (current()) { callbacks.current.onSaved(result); setPhase('done'); } }
    catch (failure) {
      if (!current() || callbacks.current.onAccessError(failure)) return;
      const problem = membershipFailure(failure);
      if (check) { setPhase(problem.status === 404 ? 'absent' : 'uncertain'); setError(problem.status === 404 ? '처리 내역을 아직 찾지 못했어요. 다시 확인하거나 같은 요청 번호로 다시 시도할 수 있어요.' : '처리 결과를 확인하지 못했어요. 연결 후 다시 확인해 주세요.'); }
      else if (membershipUncertain(failure)) { setPhase('uncertain'); setError('처리 결과를 확인해야 해요. 중복 요청을 보내기 전에 결과 확인을 눌러 주세요.'); }
      else { setPhase('idle'); setError(problem.message); }
    } finally { if (generation.current === visit) { pending.current = false; request.current = null; } }
  }
  return { requestId, phase, error, busy: phase === 'busy', locked: phase === 'uncertain' || phase === 'absent', submit: () => act(false), check: () => act(true) };
}
