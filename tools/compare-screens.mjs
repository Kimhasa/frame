// Pixel comparison of approved reference screenshots against captures of the running app.
// Images are decoded and compared inside a headless Edge (DevTools port 9444) so JPEG references need no extra tools.
// usage: node tools/compare-screens.mjs verification/compare-plan.json [verification/compare-results.json]
// plan: [{ name, reference, actual, masks: [[x, y, w, h], ...], locate?: true }]
//   locate: the reference is a crop; it is found inside "actual" (a full-page capture) before comparing.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { connect } from './cdp.mjs';

const root = new URL('../', import.meta.url);
const plan = JSON.parse(await readFile(new URL(process.argv[2] || 'verification/compare-plan.json', root), 'utf8'));
const c = await connect(9444, t => t.type === 'page' && !t.url.startsWith('edge://'));
const dataUrl = async path => (path.endsWith('.png') ? 'data:image/png;base64,' : 'data:image/jpeg;base64,') + (await readFile(new URL(path, root))).toString('base64');
await mkdir(new URL('verification/diff/', root), { recursive: true });
const results = [];
for (const item of plan) {
  const r = await c.evaluate(`(async () => {
    const load = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
    const pixels = (img, x = 0, y = 0, w = img.naturalWidth, h = img.naturalHeight) => { const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d'); cx.drawImage(img, x, y, w, h, 0, 0, w, h); return cx.getImageData(0, 0, w, h).data; };
    const ref = await load(${JSON.stringify(await dataUrl(item.reference))}), act = await load(${JSON.stringify(await dataUrl(item.actual))});
    const W = ref.naturalWidth, H = ref.naturalHeight;
    let ox = 0, oy = 0;
    if (${!!item.locate}) {
      // Coarse-to-fine search for the crop position (sum of absolute differences on a sparse grid).
      const A = pixels(act), AW = act.naturalWidth, AH = act.naturalHeight, R = pixels(ref);
      const score = (x, y, step) => { let s = 0; for (let j = 0; j < H; j += step) for (let i = 0; i < W; i += step) { const a = ((y + j) * AW + x + i) * 4, b = (j * W + i) * 4; s += Math.abs(A[a] - R[b]) + Math.abs(A[a + 1] - R[b + 1]) + Math.abs(A[a + 2] - R[b + 2]); } return s; };
      let best = Infinity;
      for (let y = 0; y <= AH - H; y += 4) for (let x = 0; x <= AW - W; x += 4) { const s = score(x, y, 12); if (s < best) { best = s; ox = x; oy = y; } }
      const cx = ox, cy = oy; best = Infinity;
      for (let y = Math.max(0, cy - 4); y <= Math.min(AH - H, cy + 4); y++) for (let x = Math.max(0, cx - 4); x <= Math.min(AW - W, cx + 4); x++) { const s = score(x, y, 3); if (s < best) { best = s; ox = x; oy = y; } }
    }
    const R = pixels(ref), A = pixels(act, ox, oy, W, H);
    const masks = ${JSON.stringify(item.masks || [])};
    const masked = (x, y) => masks.some(([mx, my, mw, mh]) => x >= mx && x < mx + mw && y >= my && y < my + mh);
    const out = new OffscreenCanvas(W, H), ox2 = out.getContext('2d'), img = ox2.createImageData(W, H), d = img.data;
    let compared = 0, differing = 0, strong = 0, sum = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, delta = Math.max(Math.abs(R[i] - A[i]), Math.abs(R[i + 1] - A[i + 1]), Math.abs(R[i + 2] - A[i + 2]));
      const g = (R[i] + R[i + 1] + R[i + 2]) / 3 * 0.35 + 160;
      if (masked(x, y)) { d[i] = g * 0.6; d[i + 1] = g * 0.7; d[i + 2] = 255; d[i + 3] = 255; continue; }
      compared++; sum += delta;
      if (delta > 40) differing++;
      if (delta > 96) strong++;
      if (delta > 40) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; } else { d[i] = d[i + 1] = d[i + 2] = g; }
      d[i + 3] = 255;
    }
    ox2.putImageData(img, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' }), buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let k = 0; k < buf.length; k += 32768) bin += String.fromCharCode(...buf.subarray(k, k + 32768));
    return { width: W, height: H, offset: [ox, oy], compared, differingPct: +(differing / compared * 100).toFixed(3), strongPct: +(strong / compared * 100).toFixed(3), meanDelta: +(sum / compared).toFixed(2), diff: btoa(bin) };
  })()`);
  await writeFile(new URL(`verification/diff/${item.name}.png`, root), Buffer.from(r.diff, 'base64'));
  delete r.diff;
  results.push({ name: item.name, reference: item.reference, actual: item.actual, masks: (item.masks || []).length, ...r });
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(new URL(process.argv[3] || 'verification/compare-results.json', root), JSON.stringify(results, null, 2));
c.close();
