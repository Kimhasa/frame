// Worker thread of the HLS receiver pool (lib/hls-pool.mjs): holds its share of the viewers (lib/hls-client.mjs Host) and
// answers add / remove / quality / snapshot requests. Its event-loop delay is reported with every snapshot: a busy worker
// delays its viewers' requests, which is generator saturation, not the target's.
import { parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Host } from './hls-client.mjs';

const host = new Host(workerData.options);
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();

parentPort.on('message', async m => {
  let result;
  try {
    if (m.op === 'add') result = await host.add(m.name, m.spec);
    else if (m.op === 'remove') result = await host.remove(m.name);
    else if (m.op === 'quality') result = await host.setQuality(m.name, m.quality);
    else if (m.op === 'snapshot') { result = { ...host.snapshot(), lagP99Ms: lag.percentile(99) / 1e6, lagMaxMs: lag.max / 1e6 }; lag.reset(); }
    else if (m.op === 'stop') { await host.stopAll(); result = true; }
  } catch (e) { result = { error: e.message }; }
  parentPort.postMessage({ id: m.id, result });
});
parentPort.postMessage({ id: 0, result: 'ready' });
