// The broadcast recording as HLS (dvr.m3u8, server/lib/dvr.mjs): every segment carries its PROGRAM-DATE-TIME on the
// relay clock, the same axis as /info startedAtMs and the /dvr index ranges, so a wall-clock position maps to a media time.

export type DvrSegment = { pdt: number; start: number; dur: number };

export function parseDvrPlaylist(text: string): DvrSegment[] {
  const map: DvrSegment[] = [];
  let pdt: number | null = null, dur: number | null = null, start = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const value = Date.parse(line.slice(25));
      pdt = Number.isFinite(value) ? value : null;
    } else if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice(8));
      dur = Number.isFinite(value) ? value : null;
    } else if (line && !line.startsWith('#') && dur !== null) {
      if (pdt !== null) map.push({ pdt, start, dur });
      start += dur;
      pdt = pdt !== null ? pdt + dur * 1000 : null;
      dur = null;
    }
  }
  return map;
}

// Media time of a wall-clock moment; inside a gap (the sender was away) the next recorded moment.
export function mediaAt(map: readonly DvrSegment[], wallMs: number): number | null {
  let index = -1;
  for (let k = 0; k < map.length && map[k].pdt <= wallMs; k++) index = k;
  if (index < 0) return map.length ? map[0].start : null;
  const entry = map[index];
  if (wallMs < entry.pdt + entry.dur * 1000) return entry.start + (wallMs - entry.pdt) / 1000;
  return index + 1 < map.length ? map[index + 1].start : entry.start + entry.dur;
}

export function wallAt(map: readonly DvrSegment[], mediaTime: number): number | null {
  let entry: DvrSegment | null = null;
  for (let k = 0; k < map.length && map[k].start <= mediaTime + 1e-3; k++) entry = map[k];
  return entry ? entry.pdt + (mediaTime - entry.start) * 1000 : null;
}

export const mapEnd = (map: readonly DvrSegment[]) => {
  const last = map[map.length - 1];
  return last ? last.pdt + last.dur * 1000 : 0;
};
