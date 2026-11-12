// Minimal WHEP receiver: only for a browser that can play no HLS at all (never as a way around a refused HLS request).
// recvonly audio + video, one POST with the complete offer, the Location kept for DELETE on close.
import { RelayError, call, classifyStatus } from './api';
import { logRequest } from './runtime';

export type WhepSession = { pc: RTCPeerConnection; stream: MediaStream; resource: string | null; closed: boolean };

function gathered(pc: RTCPeerConnection, timeoutMs: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => { pc.removeEventListener('icegatheringstatechange', done); resolve(); }, timeoutMs);
    pc.addEventListener('icegatheringstatechange', done);
  });
}

export async function openWhep(url: string, iceServers: RTCIceServer[], signal: AbortSignal): Promise<WhepSession> {
  if (typeof RTCPeerConnection !== 'function') throw new RelayError('unsupported');
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const stream = new MediaStream();
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addEventListener('track', event => stream.addTrack(event.track));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 2000);
    if (signal.aborted) throw new RelayError('cancelled');
    const answer = await call(url, {
      method: 'POST', signal, timeoutMs: 20_000,
      headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription?.sdp ?? '',
    }, async response => {
      const body = await response.text();
      if (response.status !== 201) {
        const error = classifyStatus(response.status, body, response.headers.get('Retry-After'));
        if (error.kind === 'busy') error.cap = true;
        throw error;
      }
      const location = response.headers.get('Location');
      return { sdp: body, resource: location ? new URL(location, new URL(url, window.location.href)).pathname : null };
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    return { pc, stream, resource: answer.resource, closed: false };
  } catch (error) {
    pc.close();
    throw error;
  }
}

export function closeWhep(session: WhepSession | null) {
  if (!session || session.closed) return;
  session.closed = true;
  const close = () => { try { session.pc.close(); } catch { /* ignore */ } };
  if (!session.resource) { close(); return; }
  // DELETE first: closing the peer connection first makes MediaMTX drop the session by itself, and the DELETE then gets
  // 404. The picture is detached by the caller already; the connection closes when the DELETE is answered (at most 1 s).
  for (const track of session.stream.getTracks()) track.enabled = false;
  logRequest(session.resource);
  let done: Promise<unknown> = Promise.resolve();
  try { done = fetch(session.resource, { method: 'DELETE', keepalive: true, cache: 'no-store', credentials: 'same-origin' }).catch(() => undefined); } catch { /* ignore */ }
  void Promise.race([done, new Promise(resolve => window.setTimeout(resolve, 1000))]).then(close);
}
