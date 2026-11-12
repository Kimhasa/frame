// Broadcast-scoped viewer routes of the relay: /<path>/b/<broadcastId>/<route>. A link that names its broadcast must never
// play, record or count for the next broadcast on the same path, so every scoped answer first checks that the broadcast
// on the path is still the one in the prefix. The route table itself stays in relay.mjs; this module holds the parsing and
// the binding rules so they can be checked without starting the relay.

// The prefix: the stream path (config.mjs validPath), "b", the broadcast id (32 lowercase hex), then the route.
export const SCOPE = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/b\/([0-9a-f]{32})(\/.*)$/;
// The routes a prefix may carry (names of relay.mjs's route table): live.m3u8, HLS playlists and media, the DVR index,
// dvr.m3u8, dvr/file and viewer sessions. Everything else (info, WHEP, chat, stats, dvr/media) stays path-scoped.
export const SCOPED_ROUTES = ['live', 'hls', 'dvr', 'dvrPlaylist', 'dvrFile', 'session'];

// { path, id, route, m } for a scoped request (m: the route's match on "/<path>/<route>", so the path-scoped handlers read
// the same groups), { path, id, route: '' } for a prefix with a route it does not carry, or null when not scoped.
export function matchScoped(pathname, routes) {
  const s = SCOPE.exec(pathname);
  if (!s) return null;
  const [, path, id, rest] = s, inner = `/${path}${rest}`;
  for (const route of SCOPED_ROUTES) {
    const m = routes[route].exec(inner);
    if (m && m[1] === path) return { path, id, route, m };
  }
  return { path, id, route: '', m: null };
}

// null while `entry` (the registry entry on the path, or null) is broadcast `id`, else [status, error] for the JSON answer:
// 404 not-running (nothing on the path), 409 broadcast-changed (another broadcast took the path: reload from /info).
export function binding(entry, id) {
  if (!entry) return [404, 'not-running'];
  return entry.id === id ? null : [409, 'broadcast-changed'];
}

// The MediaMTX path `p` does not carry a publisher session older than the broadcast (the previous broadcast on the path
// still publishing): the same rule as relay.mjs observe(), a session up to 10 s before the broadcast's start (the
// announced start's clock skew) counts as its own. A path that is not ready, or a time that is unknown, is not refused here.
export const OWN_MEDIA_SLACK_MS = 10000;
export function ownMedia(entry, p) {
  if (!p?.ready || !p.readyMs || !entry?.startedAtRelayMs) return true;
  return p.readyMs >= entry.startedAtRelayMs - OWN_MEDIA_SLACK_MS;
}

// The publisher session of the MediaMTX path `p` began before the broadcast's last announcement (same host clock). A sender
// announces every 2 s while it sends, so its own new session (the broadcast's start, a reconnect) is confirmed by its next
// announcement. Until then the session may be the next broadcast's sender, which took the path before its first
// announcement while the previous broadcast's "bye" was lost (FRAME_DESIGN.md 5.3: announcement and media may arrive in
// either order); an old link must not get its media meanwhile.
export function announced(entry, p) {
  if (!p?.ready || !p.readyMs || !entry?.lastAnnounceMs) return true;
  return p.readyMs <= entry.lastAnnounceMs;
}
// The media on the broadcast's source path is its own: not an older publisher session, not one it has not announced since.
export const ownSource = (entry, p) => ownMedia(entry, p) && announced(entry, p);
