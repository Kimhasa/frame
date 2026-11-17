export type MembershipCallback = { membershipId: string; requestId: string; authKey: string; customerKey: string; cancelled: boolean };
// Holds the redirect values only while its result route is mounted. Never browser storage.
let captured: MembershipCallback | null = null;
export function captureMembershipCallback(): MembershipCallback | null {
  if (!/\/payments\/(?:success|fail)\/?$/.test(location.pathname)) { clearMembershipCallback(); return null; }
  const query = new URLSearchParams(location.search), membershipId = query.get('membershipId') ?? '', requestId = query.get('requestId') ?? '';
  if (!membershipId && !requestId) { clearMembershipCallback(); history.replaceState(history.state, '', location.pathname); return null; }
  if (!captured || captured.membershipId !== membershipId || captured.requestId !== requestId || query.has('authKey')) {
    captured = { membershipId, requestId, authKey: query.get('authKey') ?? '', customerKey: query.get('customerKey') ?? '', cancelled: query.get('code') === 'PAY_PROCESS_CANCELED' };
  }
  const safe = new URLSearchParams(); if (/^[0-9a-f-]{36}$/i.test(membershipId)) safe.set('membershipId', membershipId); if (/^[0-9a-f-]{36}$/i.test(requestId)) safe.set('requestId', requestId);
  history.replaceState(history.state, '', `${location.pathname}${safe.size ? `?${safe}` : ''}`);
  return captured;
}
export function clearMembershipCallback(value?: MembershipCallback | null) { if (!value || captured === value) { if (captured) { captured.authKey = ''; captured.customerKey = ''; } captured = null; } }
