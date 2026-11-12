// Verifies only the owning harness's private fixture state after the immutable API restarts.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, liveBroadcast } from './rewards-client.mjs';
const directory = path.resolve(process.env.FRAME_REWARDS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_REWARDS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('An external private reward fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'rewards-checkpoint.json'), 'utf8'));
if (!/^obs-reward-[0-9a-f]{12}$/.test(checkpoint.path)) throw Error('Only the dedicated reward fixture path is allowed.');
const results = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
try {
  const owner = new Client(checkpoint.owner), viewer = new Client(checkpoint.viewer), session = await owner.request('GET', '/session');
  check(session.status === 200 && session.data.user?.id === checkpoint.owner.userId, 'The reward owner session survives the API restart');
  const ledger = await viewer.request('GET', '/me/points?' + new URLSearchParams({ channelId: checkpoint.channelId, limit: '100' }));
  check(ledger.status === 200 && ledger.data.userId === checkpoint.viewer.userId && ledger.data.balance === checkpoint.expectedBalance && ledger.data.items.length === checkpoint.ledger.length
    && checkpoint.ledger.every(saved => ledger.data.items.some(item => item.id === saved.id && item.kind === saved.kind && item.delta === saved.delta && item.balanceAfter === saved.balanceAfter)), 'Actual earned points, both debits and both exact refunds survive with the same durable ledger identities');
  const reward = await owner.request('GET', `/me/rewards/${checkpoint.rewardId}`), redemption = await owner.request('GET', `/me/redemptions/${checkpoint.redemptionId}`);
  check(reward.status === 200 && redemption.status === 200 && redemption.data.item.status === 'rejected' && redemption.data.item.reason === checkpoint.reason, 'The reward catalog and terminal owner handling remain stored after restart');
  const receipt = await viewer.request('POST', `/rewards/${checkpoint.requestRewardId}/redemptions`, checkpoint.requestBody);
  check(receipt.status === 200 && receipt.data.item.id === checkpoint.redemptionId && receipt.data.item.status === 'rejected' && receipt.data.balance === checkpoint.expectedBalance
    && (await viewer.request('GET', '/me/points?' + new URLSearchParams({ channelId: checkpoint.channelId, limit: '100' }))).data.items.length === checkpoint.ledger.length, 'The saved request UUID confirms its refunded receipt after restart without charging or refunding it again');
  const current = await liveBroadcast(checkpoint.path, checkpoint.broadcastId), fresh = await viewer.request('GET', '/rewards/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: current.id }));
  check(fresh.status === 200 && fresh.data.balance === checkpoint.expectedBalance && fresh.data.mine.length === 0, 'The new live instance keeps channel points while separating its redemption history from the previous broadcast');
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length }));
} catch (failure) { results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally { await writeFile(path.resolve('verification/product/rewards-restart-result.json'), JSON.stringify({ verificationDatabaseOnly: true, results }, null, 2)); }
