// Uses only the owning harness's private fixture checkpoint after its immutable API JAR restarts.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, liveBroadcast } from './questions-client.mjs';

const directory = path.resolve(process.env.FRAME_QUESTIONS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_QUESTIONS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('An external private question fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'questions-checkpoint.json'), 'utf8'));
if (!/^obs-question-[0-9a-f]{12}$/.test(checkpoint.path)) throw Error('Only the dedicated question fixture path is allowed.');
const results = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
try {
  const owner = new Client(checkpoint.owner), viewer = new Client(checkpoint.viewer), anonymous = new Client();
  const session = await owner.request('GET', '/session');
  check(session.status === 200 && session.data.user?.id === checkpoint.owner.userId, 'The private question owner session survives the API restart');
  const detail = await owner.request('GET', `/me/questions/${checkpoint.answeredQuestionId}`), ownerList = await owner.request('GET', '/me/questions?limit=100');
  check(detail.status === 200 && detail.data.userId === checkpoint.owner.userId && detail.data.item.answer === checkpoint.answer && !detail.data.item.broadcastActive
    && ownerList.data.items.some(item => item.id === checkpoint.answeredQuestionId) && ownerList.data.pinnedQuestionId === null,
    'The stored answer and owner history survive while the restarted broadcast instance has no inherited public pin');
  const oldRoute = '/questions/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: checkpoint.broadcastId, limit: '100' });
  const oldView = await viewer.request('GET', oldRoute), oldGuest = await anonymous.request('GET', oldRoute);
  check(oldView.status === 200 && oldView.data.userId === checkpoint.viewer.userId && oldView.data.pinned === null && !oldView.data.canSubmit
    && checkpoint.viewerQuestions.every(saved => oldView.data.mine.some(item => item.id === saved.id && item.clientRequestId === saved.clientRequestId && item.text === saved.text))
    && oldGuest.data.mine.length === 0 && oldGuest.data.pinned === null,
    'Old-broadcast private submissions persist for their author without leaking a pin or any private history to anonymous viewers');
  const receipt = await viewer.request('POST', '/questions', checkpoint.receiptBody);
  check(receipt.status === 200 && receipt.data.item.id === checkpoint.receiptQuestionId && (await viewer.request('GET', oldRoute)).data.mine.length === checkpoint.viewerQuestions.length,
    'The original client request UUID still confirms one saved receipt after restart without creating a second question');
  const current = await liveBroadcast(checkpoint.path, checkpoint.broadcastId);
  const fresh = await viewer.request('GET', '/questions/current?' + new URLSearchParams({ path: checkpoint.path, broadcastId: current.id }));
  check(fresh.status === 200 && fresh.data.pinned === null && fresh.data.mine.length === 0, 'The new current broadcast does not inherit private submissions or a public pin from the old instance');
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length }));
} catch (failure) { results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally { await writeFile(path.resolve('verification/product/questions-restart-result.json'), JSON.stringify({ verificationDatabaseOnly: true, results }, null, 2)); }
