// Reads the owning harness's private fixture after its immutable API JAR restarts.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, liveBroadcast } from './missions-client.mjs';

const directory = path.resolve(process.env.FRAME_MISSIONS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_MISSIONS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('An external private mission fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'missions-checkpoint.json'), 'utf8'));
if (!/^obs-mission-[0-9a-f]{12}$/.test(checkpoint.path)) throw Error('Only the dedicated mission fixture stream is allowed.');
const results = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
function history(item, statuses, actors) { return item && item.version === statuses.length - 1 && item.history.length === statuses.length && item.history.every((entry, index) => entry.status === statuses[index] && entry.actor === actors[index] && (!index || entry.createdAtMs >= item.history[index - 1].createdAtMs)) && item.history.at(-1).status === item.status; }
try {
  const owner = new Client(checkpoint.owner), viewer = new Client(checkpoint.viewer), anonymous = new Client();
  const session = await owner.request('GET', '/session');
  check(session.status === 200 && session.data.user?.id === checkpoint.owner.userId, 'The private mission owner session survives the real API process restart');
  const terminal = await owner.request('GET', `/me/missions/${checkpoint.terminalMissionId}`);
  check(terminal.status === 200 && terminal.data.userId === checkpoint.owner.userId && terminal.data.item.reason === checkpoint.terminalReason
    && !terminal.data.item.broadcastActive && history(terminal.data.item, ['received', 'running', 'completed'], ['viewer', 'owner', 'owner']),
    'A completed mission and its three chronological history events persist unchanged across restart');
  const expired = await owner.request('GET', `/me/missions/${checkpoint.editableMissionId}`), repeated = await owner.request('GET', `/me/missions/${checkpoint.editableMissionId}`);
  check(expired.status === 200 && expired.data.item.status === 'expired' && !expired.data.item.broadcastActive
    && history(expired.data.item, ['received', 'expired'], ['viewer', 'system']) && JSON.stringify(expired.data.item) === JSON.stringify(repeated.data.item),
    'The previously active received mission expires durably after restart with one system event and repeated reads add nothing');
  const oldRoute = '/missions/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: checkpoint.broadcastId, limit: '100' });
  const oldView = await viewer.request('GET', oldRoute), oldGuest = await anonymous.request('GET', oldRoute);
  check(oldView.status === 200 && oldView.data.userId === checkpoint.viewer.userId && !oldView.data.canSubmit && oldView.data.reason === 'broadcast_unavailable'
    && checkpoint.viewerMissions.every(saved => oldView.data.mine.some(item => item.id === saved.id && item.clientRequestId === saved.clientRequestId && item.title === saved.title
      && (saved.status === 'received' ? history(item, ['received', 'expired'], ['viewer', 'system']) : item.status === saved.status)))
    && oldGuest.data.mine.length === 0,
    'Authors retain old-broadcast private proposals and system expiry while anonymous users receive no private history');
  const receipt = await viewer.request('POST', '/missions', checkpoint.receiptBody);
  check(receipt.status === 200 && receipt.data.item.id === checkpoint.receiptMissionId && receipt.data.item.status === 'expired'
    && (await viewer.request('GET', oldRoute)).data.mine.length === checkpoint.viewerMissions.length,
    'The original request UUID confirms the expired saved receipt after restart without creating another proposal');
  const current = await liveBroadcast(checkpoint.path, checkpoint.broadcastId), fresh = await viewer.request('GET', '/missions/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: current.id }));
  check(fresh.status === 200 && fresh.data.mine.length === 0 && fresh.data.reason !== 'broadcast_unavailable', 'A fresh current broadcast does not inherit private missions from the prior API instance');
  const finalTerminal = (await owner.request('GET', `/me/missions/${checkpoint.terminalMissionId}`)).data.item;
  check(JSON.stringify(finalTerminal) === JSON.stringify(terminal.data.item), 'Confirming an old receipt and reading a new broadcast never mutate completed mission history');
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length }));
} catch (failure) { results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally { await writeFile(path.resolve('verification/product/missions-restart-result.json'), JSON.stringify({ verificationDatabaseOnly: true, actualProcessRestart: true, results }, null, 2)); }
