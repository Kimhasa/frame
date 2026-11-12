// Reads only the owning harness's external fixture checkpoint after its immutable JAR restarts.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, liveBroadcast } from './polls-client.mjs';

const directory = path.resolve(process.env.FRAME_POLLS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_POLLS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('An external private poll fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'polls-checkpoint.json'), 'utf8'));
if (!/^obs-poll-[0-9a-f]{12}$/.test(checkpoint.path)) throw Error('Only the dedicated poll fixture path is allowed.');
const results = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
try {
  const owner = new Client(checkpoint.owner), viewer = new Client(checkpoint.viewer), session = await owner.request('GET', '/session');
  check(session.status === 200 && session.data.user?.id === checkpoint.owner.userId, 'The poll owner session survives the API restart');
  const detail = await owner.request('GET', `/me/polls/${checkpoint.activePoll.id}`);
  check(detail.status === 200 && detail.data.userId === checkpoint.owner.userId && detail.data.poll.status === 'closed' && detail.data.poll.closeReason === 'broadcast_ended'
    && detail.data.poll.totalVotes === checkpoint.activePoll.totalVotes && detail.data.poll.myOptionId === checkpoint.ownerOptionId, 'The old broadcast instance closes its active poll while preserving owner history and vote totals');
  const previous = await viewer.request('GET', '/polls/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: checkpoint.broadcastId }));
  check(previous.status === 200 && previous.data.userId === checkpoint.viewer.userId && previous.data.poll?.id === checkpoint.activePoll.id
    && previous.data.poll.status === 'closed' && previous.data.poll.myOptionId === checkpoint.viewerOptionId && previous.data.poll.totalVotes === checkpoint.activePoll.totalVotes,
    'The viewer retains its own selected option and closed result after restart');
  const confirmed = await viewer.request('POST', `/polls/${checkpoint.activePoll.id}/votes`, { optionId: checkpoint.viewerOptionId, broadcastId: checkpoint.broadcastId, path: checkpoint.path });
  check(confirmed.status === 200 && confirmed.data.poll?.status === 'closed' && confirmed.data.poll.myOptionId === checkpoint.viewerOptionId
    && confirmed.data.poll.totalVotes === checkpoint.activePoll.totalVotes, 'Retrying the same old vote confirms its receipt without adding a new vote after closure');
  const current = await liveBroadcast(checkpoint.path, checkpoint.broadcastId);
  const next = await viewer.request('GET', '/polls/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: current.id }));
  check(next.status === 200 && next.data.poll === null, 'The replacement registry instance does not inherit an old poll on the same path');
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length }));
} catch (failure) { results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally { await writeFile(path.resolve('verification/product/polls-restart-result.json'), JSON.stringify({ verificationDatabaseOnly: true, results }, null, 2)); }
