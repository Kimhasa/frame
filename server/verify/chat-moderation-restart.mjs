// Runs only after the owning harness restarts the same private JAR/DB/Redis namespace.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, joinAccount, sendMessage, liveBroadcast } from './chat-moderation-client.mjs';

const directory = path.resolve(process.env.FRAME_CHAT_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_CHAT_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external chat fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'chat-moderation-checkpoint.json'), 'utf8'));
if (!/^obs-chat-[0-9a-f]{12}$/.test(checkpoint.path)) throw Error('Only the dedicated chat fixture path is allowed.');
const results = [], sockets = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
try {
  const owner = new Client(checkpoint.owner), viewer = new Client(checkpoint.blockedViewer), broadcast = await liveBroadcast(checkpoint.path);
  const joined = await joinAccount(viewer, broadcast); sockets.push(joined.socket);
  check(joined.state?.authenticated && joined.state.userId === checkpoint.blockedViewer.userId && joined.state.canSend === false, 'A persisted block still identifies the real account and restricts its new socket after restart');
  const blocked = await sendMessage(joined.socket, '재시작 뒤에도 차단된 계정은 보낼 수 없어요');
  check(blocked?.ok === false && blocked.code === 'CHAT_BLOCKED', 'The real WebSocket send path enforces the persisted account block after restart');
  const broadcaster = await joinAccount(owner, broadcast); sockets.push(broadcaster.socket);
  const rejected = await sendMessage(broadcaster.socket, 'BLOCKME');
  check(rejected?.ok === false && rejected.code === 'CHAT_WORD_BLOCKED', 'The persisted banned-word policy still applies to the broadcaster after restart');
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length }));
} catch (failure) { results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally {
  for (const socket of sockets) socket.destroy();
  await writeFile(path.resolve('verification/product/chat-moderation-restart-result.json'), JSON.stringify({ verificationDatabaseOnly: true, results }, null, 2));
}
