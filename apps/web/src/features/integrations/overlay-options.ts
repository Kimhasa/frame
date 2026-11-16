export type OverlayOptions = {
  theme: 'dark' | 'light';
  fontSize: number;
  maxMessages: number;
  hideAfterSeconds: number;
};

export const defaultOverlayOptions: OverlayOptions = {
  theme: 'dark', fontSize: 20, maxMessages: 8, hideAfterSeconds: 30,
};

function bounded(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || !/^\d{1,3}$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

export function parseOverlayOptions(params: URLSearchParams): OverlayOptions {
  return {
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
    fontSize: bounded(params.get('fontSize'), defaultOverlayOptions.fontSize, 14, 32),
    maxMessages: bounded(params.get('maxMessages'), defaultOverlayOptions.maxMessages, 1, 20),
    hideAfterSeconds: bounded(params.get('hideAfterSeconds'), defaultOverlayOptions.hideAfterSeconds, 0, 120),
  };
}

export function overlayUrl(channelId: string, options: OverlayOptions, preview = false): string {
  const params = new URLSearchParams({ theme: options.theme, fontSize: String(options.fontSize),
    maxMessages: String(options.maxMessages), hideAfterSeconds: String(options.hideAfterSeconds) });
  if (preview) params.set('preview', '1');
  return new URL(`${import.meta.env.BASE_URL}overlay/chat/${encodeURIComponent(channelId)}?${params}`, window.location.origin).href;
}
