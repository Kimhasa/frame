import { useState } from 'react';
import ui from '../../components/management/ManagementUI.module.css';
import { membershipClient } from './membership-client';
import type { Membership } from './membership-client';
import { MembershipDetails, MembershipModal } from './MembershipUI';
import { useMembershipMutation } from './useMembershipMutation';
import type { MembershipAccessError } from './useMembershipMutation';
import styles from './Membership.module.css';
export function MembershipCancelDialog({ item, api, online, onClose, onSaved, onAccessError }: { item: Membership; api: ReturnType<typeof membershipClient>; online: boolean; onClose: () => void; onSaved: (item: Membership) => void; onAccessError: MembershipAccessError }) {
  const [saved, setSaved] = useState<Membership | null>(null);
  const mutation = useMembershipMutation({ run: (id, signal) => api.cancel(item, id, signal), verify: (id, signal) => api.cancelReceipt(item.id, id, signal), onSaved: value => { setSaved(value); onSaved(value); }, onAccessError });
  return <MembershipModal title={saved ? '멤버십 해지를 확인했어요' : '멤버십을 해지할까요?'} busy={mutation.busy} locked={mutation.locked} onClose={onClose}><MembershipDetails item={saved ?? item} />{!saved && <p>다음 월 자동결제를 중지해요. 이미 결제한 이용 기간은 유지되며, 결제 금액은 환불되지 않아요. 진행 중인 결제는 먼저 결과 확인이 필요할 수 있어요.</p>}{mutation.error && <p className={styles.error} role="alert">{mutation.error}</p>}<div className={ui.dialogActions}>{saved ? <button type="button" className={`${ui.button} ${ui.primary}`} onClick={onClose}>확인</button> : <>{!mutation.locked && <button type="button" className={ui.button} disabled={mutation.busy} onClick={onClose}>유지하기</button>}{mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy} onClick={() => void mutation.check()}>결과 확인</button>}{(!mutation.locked || mutation.phase === 'absent') && <button type="button" className={`${ui.button} ${ui.danger}`} disabled={!online || mutation.busy} onClick={() => void mutation.submit()}>{mutation.busy ? '해지 확인 중…' : mutation.phase === 'absent' ? '같은 요청으로 다시 시도' : '해지 확인'}</button>}</>}</div></MembershipModal>;
}
