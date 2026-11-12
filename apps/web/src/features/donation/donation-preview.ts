export const donationKinds = ['메시지', '음성', '영상'] as const;
export type DonationKind = typeof donationKinds[number];
export type DonationDraft = {
  kind: DonationKind;
  amount: string;
  message: string;
  videoUrl: string;
  start: string;
  payment: '' | '카드' | '간편결제';
  consent: boolean;
};
export function parseDonationAmount(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text)) return null;
  const amount = Number(text.replaceAll(',', ''));
  return Number.isSafeInteger(amount) && amount >= 1000 && amount <= 10_000_000 ? amount : null;
}

export function validVideoUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return value.trim().length <= 500 && url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function validVideoStart(value: string) {
  const text = value.trim();
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) && text.split(':').slice(1).every(part => Number(part) <= 59);
}
