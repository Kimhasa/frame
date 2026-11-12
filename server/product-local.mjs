// FRAME-only local PostgreSQL and Redis. Never changes existing Windows services or shared database instances.
// node server/product-local.mjs start|status|stop
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw Error('This local launcher requires Windows and LOCALAPPDATA.');
const DIR = resolve(process.env.LOCALAPPDATA, 'Frame', 'product');
const CONFIG = join(DIR, 'config.json'), ADMIN = join(DIR, 'admin.json'), STATE = join(DIR, 'runtime.json'), LOCK = join(DIR, 'operation.lock');
const PGDATA = join(DIR, 'postgres'), PGPORT = 15432, REDISPORT = 16379;
const PGBIN = process.env.FRAME_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin';
const REDIS_VERSION = '8.10.3', REDIS_NAME = `Redis-${REDIS_VERSION}-Windows-x64-cygwin.zip`;
const REDIS_SHA256 = '8000848c48668c8cd32f21386ce951d0e02c1aefae39443ab9d3de11ff8ebf9e';
const REDISDIR = join(DIR, 'deps', 'redis-' + REDIS_VERSION), REDISCONF = join(DIR, 'redis.conf');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
function write(file, value) { const temp = file + '.tmp'; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, file); }
function identity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try { return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString() || 'null'); } catch { return null; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
const normalized = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const cygwinPath = value => value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => '/cygdrive/' + drive.toLowerCase() + '/').replaceAll('\\', '/');
function record(pid, marker, name) { const p = identity(pid); if (!p?.CreationDate || p.Name?.toLowerCase() !== name) throw Error('Cannot verify local database process identity.'); return { pid, marker, name, createdAt: p.CreationDate }; }
function owned(value) {
  const p = identity(value?.pid);
  return !!(p && p.CreationDate === value.createdAt && p.Name?.toLowerCase() === value.name && normalized(p.CommandLine).includes(normalized(value.marker)));
}
function lock() {
  const self = identity(process.pid), nonce = randomBytes(16).toString('hex');
  if (!self?.CreationDate) throw Error('Cannot verify local launcher identity.');
  for (let n = 0; n < 3; n++) {
    let fd;
    try { fd = openSync(LOCK, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = read(LOCK), owner = identity(old?.pid);
      if (!old?.nonce || !old.createdAt) throw Error('An incomplete product runtime lock exists; no process was changed.');
      if (owner && owner.CreationDate === old.createdAt) throw Error('Another product runtime operation is running.');
      if (!owner && alive(old.pid)) throw Error('Cannot verify the operation lock owner; no process was changed.');
      if (read(LOCK)?.nonce === old.nonce) unlinkSync(LOCK);
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: self.CreationDate, nonce })); } finally { closeSync(fd); }
    const release = () => { if (read(LOCK)?.nonce === nonce) try { unlinkSync(LOCK); } catch {} };
    process.once('exit', release);
    return release;
  }
  throw Error('Could not acquire local product runtime lock.');
}
async function portFree(port) { return new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); }); }
function listenerMatches(port, value) {
  if (!owned(value)) return false;
  try {
    const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object LocalAddress,OwningProcess) | ConvertTo-Json -Compress`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString() || '[]');
    const list = Array.isArray(rows) ? rows : [rows];
    return list.some(row => row.LocalAddress === '127.0.0.1' && row.OwningProcess === value.pid) && list.every(row => row.LocalAddress === '127.0.0.1' && row.OwningProcess === value.pid);
  } catch { return false; }
}
function configuration() {
  const c = read(CONFIG);
  if (!c || c.version !== 1 || c.enabled !== true || c.dbUrl !== `jdbc:postgresql://127.0.0.1:${PGPORT}/frame_product` || c.dbUsername !== 'frame_app' || typeof c.dbPassword !== 'string' || !c.dbPassword || /[\r\n\0]/.test(c.dbPassword)
    || c.redisHost !== '127.0.0.1' || c.redisPort !== REDISPORT || !/^[a-f0-9]{64}$/.test(c.redisPassword) || c.redisNamespace !== 'frame:product:sessions') {
    throw Error('Prepare the FRAME-only private product/config.json first; it was not overwritten and no credentials were printed.');
  }
  return c;
}
function sql(user, password, database, statement) {
  try {
    return execFileSync(join(PGBIN, 'psql.exe'), ['-X', '-w', '-h', '127.0.0.1', '-p', String(PGPORT), '-U', user, '-d', database, '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      windowsHide: true, env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '3' }, input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    }).trim();
  } catch { throw Error('Local PostgreSQL operation failed; no credentials or SQL were printed.'); }
}
function redis(password, command = ['PING']) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: REDISPORT });
    let bytes = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    const encode = parts => '*' + parts.length + '\r\n' + parts.map(p => '$' + Buffer.byteLength(String(p)) + '\r\n' + p + '\r\n').join('');
    socket.setTimeout(2500);
    socket.on('connect', () => socket.write(encode(['AUTH', password]) + encode(command)));
    socket.on('data', data => { bytes += data.toString(); if (bytes.startsWith('-')) finish(Error('Local Redis authentication failed.')); else if (bytes.startsWith('+OK\r\n') && bytes.slice(5).includes('\r\n')) finish(null, bytes.slice(5).trim()); });
    socket.on('timeout', () => finish(Error('Local Redis timed out.')));
    socket.on('error', () => finish(Error('Local Redis is unavailable.')));
    socket.on('end', () => command[0] === 'SHUTDOWN' ? finish(null, 'stopped') : finish(Error('Local Redis closed unexpectedly.')));
  });
}
async function healthy(c) {
  try { return sql(c.dbUsername, c.dbPassword, 'frame_product', 'SELECT 1;') === '1' && await redis(c.redisPassword) === '+PONG'; } catch { return false; }
}
async function wait(fn, ms) { for (const until = Date.now() + ms; Date.now() < until;) { if (await fn()) return true; await sleep(250); } return false; }
function findRedis(folder) {
  if (!existsSync(folder)) return null;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'redis-server.exe') return file;
    if (entry.isDirectory()) { const found = findRedis(file); if (found) return found; }
  }
  return null;
}
async function redisBinary() {
  let found = findRedis(REDISDIR);
  if (found) {
    const archive = join(DIR, 'deps', REDIS_NAME);
    if (!existsSync(archive) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== REDIS_SHA256) throw Error('Existing Redis archive does not match its pinned checksum.');
    write(join(DIR, 'deps', 'redis-source.json'), { version: REDIS_VERSION, source: `https://github.com/redis-windows/redis-windows/releases/download/${REDIS_VERSION}/${REDIS_NAME}`, sha256: REDIS_SHA256, communityWindowsBuild: true });
    return found;
  }
  const release = await fetch(`https://api.github.com/repos/redis-windows/redis-windows/releases/tags/${REDIS_VERSION}`, { headers: { 'User-Agent': 'frame-local-runtime' }, signal: AbortSignal.timeout(20000) });
  if (!release.ok) throw Error('Cannot verify the pinned Redis Windows release.');
  const data = await release.json(), asset = data.assets?.find(a => a.name === REDIS_NAME);
  if (data.tag_name !== REDIS_VERSION || data.prerelease || asset?.digest !== 'sha256:' + REDIS_SHA256 || !data.body?.toLowerCase().includes(REDIS_SHA256)) throw Error('Redis release metadata does not match the pinned checksum.');
  const expected = `https://github.com/redis-windows/redis-windows/releases/download/${REDIS_VERSION}/${REDIS_NAME}`;
  if (asset.browser_download_url !== expected) throw Error('Unexpected Redis download origin.');
  const response = await fetch(expected, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Could not download the pinned Redis Windows build.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== REDIS_SHA256) throw Error('Redis archive checksum mismatch; it was not executed.');
  const archive = join(DIR, 'deps', REDIS_NAME); mkdirSync(join(DIR, 'deps'), { recursive: true }); writeFileSync(archive, bytes);
  mkdirSync(REDISDIR, { recursive: true });
  execFileSync('tar.exe', ['-xf', archive, '-C', REDISDIR], { windowsHide: true, stdio: 'ignore' });
  found = findRedis(REDISDIR);
  if (!found) throw Error('Pinned Redis archive does not contain redis-server.exe.');
  write(join(DIR, 'deps', 'redis-source.json'), { version: REDIS_VERSION, source: expected, sha256: REDIS_SHA256, communityWindowsBuild: true });
  return found;
}
function initializePostgres() {
  if (existsSync(join(PGDATA, 'PG_VERSION'))) return;
  if (existsSync(PGDATA) && readdirSync(PGDATA).length) throw Error('The FRAME PostgreSQL directory is nonempty; it was not initialized or overwritten.');
  const admin = { username: 'frame_admin', password: randomBytes(32).toString('hex') };
  if (existsSync(ADMIN)) throw Error('Admin metadata exists without a cluster; no credentials were overwritten.');
  write(ADMIN, admin);
  const passwordFile = join(DIR, 'init-password.private');
  try {
    writeFileSync(passwordFile, admin.password + '\n', { mode: 0o600, flag: 'wx' });
    execFileSync(join(PGBIN, 'initdb.exe'), ['-D', PGDATA, '-U', admin.username, '--auth=scram-sha-256', '--pwfile=' + passwordFile, '--encoding=UTF8', '--locale=C'], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
  } catch { throw Error('FRAME PostgreSQL initialization failed; only its isolated directory may contain partial data.'); }
  finally { if (resolve(passwordFile).startsWith(DIR + '\\') && existsSync(passwordFile)) unlinkSync(passwordFile); }
  writeFileSync(join(PGDATA, 'postgresql.auto.conf'), [
    "# FRAME local product database only", "listen_addresses = '127.0.0.1'", `port = ${PGPORT}`, "shared_buffers = '32MB'", 'max_connections = 30',
    "timezone = 'UTC'", "log_timezone = 'UTC'", "password_encryption = 'scram-sha-256'", "log_statement = 'none'", '',
  ].join('\n'));
}
function prepareDatabase(c) {
  const admin = read(ADMIN);
  if (!admin?.username || !admin.password) throw Error('Missing isolated PostgreSQL admin metadata.');
  const role = sql(admin.username, admin.password, 'postgres', "SELECT rolname FROM pg_roles WHERE rolname='frame_app';");
  if (!role) sql(admin.username, admin.password, 'postgres', `CREATE ROLE frame_app LOGIN PASSWORD '${c.dbPassword.replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE;`);
  const database = sql(admin.username, admin.password, 'postgres', "SELECT datname FROM pg_database WHERE datname='frame_product';");
  if (!database) sql(admin.username, admin.password, 'postgres', 'CREATE DATABASE frame_product OWNER frame_app;');
  if (!c.verifyDbUrl) {
    const preferred = 'frame_product_verify';
    const existing = sql(admin.username, admin.password, 'postgres', `SELECT datname FROM pg_database WHERE datname='${preferred}';`);
    const verifyName = existing ? preferred + '_' + randomBytes(5).toString('hex') : preferred;
    sql(admin.username, admin.password, 'postgres', `CREATE DATABASE ${verifyName} OWNER frame_app;`);
    c.verifyDbUrl = `jdbc:postgresql://127.0.0.1:${PGPORT}/${verifyName}`;
    write(CONFIG, c);
  }
  // Verify existing credentials rather than resetting roles or databases during a repeat start.
  sql(c.dbUsername, c.dbPassword, 'frame_product', 'SELECT 1;');
}
async function stopOwned(state, c) {
  if (owned(state?.redis)) {
    if (!listenerMatches(REDISPORT, state.redis)) throw Error('Cannot verify the owned Redis listener; no process was killed.');
    try { await redis(c.redisPassword, ['SHUTDOWN', 'SAVE']); } catch {}
    if (!await wait(async () => !owned(state.redis), 8000)) throw Error('Owned Redis did not shut down; its runtime record was preserved.');
  }
  if (owned(state?.postgres)) {
    if (!listenerMatches(PGPORT, state.postgres)) throw Error('Cannot verify the owned PostgreSQL listener; no process was killed.');
    try { execFileSync(join(PGBIN, 'pg_ctl.exe'), ['-D', PGDATA, '-m', 'fast', '-w', '-t', '10', 'stop'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }); } catch { throw Error('Owned PostgreSQL did not shut down; no process was killed.'); }
  }
}

const command = process.argv[2] || 'status';
if (!['start', 'status', 'stop'].includes(command)) throw Error('Usage: node server/product-local.mjs start|status|stop');
mkdirSync(DIR, { recursive: true });
const release = command === 'status' ? null : lock();
try {
  const c = configuration(); let state = read(STATE);
  const running = listenerMatches(PGPORT, state?.postgres) && listenerMatches(REDISPORT, state?.redis) && await healthy(c);
  if (command === 'status') {
    console.log(JSON.stringify({ running, configPath: CONFIG, postgres: { host: '127.0.0.1', port: PGPORT, database: 'frame_product' }, redis: { host: '127.0.0.1', port: REDISPORT, namespace: c.redisNamespace }, versions: { postgres: existsSync(join(PGDATA, 'PG_VERSION')) ? readFileSync(join(PGDATA, 'PG_VERSION'), 'utf8').trim() : null, redis: REDIS_VERSION } }, null, 2));
    if (!running) process.exitCode = 1;
  } else if (command === 'stop') {
    await stopOwned(state, c); write(STATE, { stoppedAt: new Date().toISOString() });
    console.log('Stopped only the FRAME-owned local PostgreSQL and Redis.');
  } else if (running) {
    console.log(JSON.stringify({ running: true, alreadyRunning: true, configPath: CONFIG, ports: { postgres: PGPORT, redis: REDISPORT } }, null, 2));
  } else {
    if (owned(state?.postgres) || owned(state?.redis)) throw Error('A partial FRAME product runtime is running; inspect status and stop it before retrying.');
    for (const port of [PGPORT, REDISPORT]) if (!await portFree(port)) throw Error(`Port ${port} is occupied; no existing process was stopped.`);
    for (const exe of ['initdb.exe', 'pg_ctl.exe', 'psql.exe']) if (!existsSync(join(PGBIN, exe))) throw Error('PostgreSQL 17 binaries were not found.');
    const redisExe = await redisBinary();
    initializePostgres();
    state = { marker: DIR, phase: 'starting', startedAt: new Date().toISOString() };
    try {
      execFileSync(join(PGBIN, 'pg_ctl.exe'), ['-D', PGDATA, '-l', join(DIR, 'postgres.log'), '-w', '-t', '15', 'start'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
      const pgPid = Number(readFileSync(join(PGDATA, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
      state.postgres = record(pgPid, PGDATA, 'postgres.exe'); write(STATE, state);
      if (!listenerMatches(PGPORT, state.postgres)) throw Error('PostgreSQL listener ownership did not match the FRAME instance.');
      prepareDatabase(c);
      const redisData = join(DIR, 'redis-data'); mkdirSync(redisData, { recursive: true });
      // The Cygwin build resolves paths inside its POSIX namespace, not as drive-letter paths.
      writeFileSync(REDISCONF, [
        'bind 127.0.0.1', 'protected-mode yes', `port ${REDISPORT}`, 'daemonize no', `requirepass ${c.redisPassword}`, 'maxmemory 128mb', 'maxmemory-policy noeviction',
        `dir "${cygwinPath(redisData)}"`, 'appendonly yes', 'appendfsync everysec', 'save 60 100', 'loglevel notice', '',
      ].join('\n'), { mode: 0o600 });
      const fd = openSync(join(DIR, 'redis.log'), 'a');
      let child;
      try { child = spawn(redisExe, [cygwinPath(REDISCONF)], { cwd: dirnameRedis(redisExe), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); child.on('error', () => {}); child.unref(); } finally { closeSync(fd); }
      if (!await wait(async () => { try { return identity(child.pid)?.CreationDate; } catch { return false; } }, 3000)) throw Error('Redis process did not start.');
      state.redis = record(child.pid, cygwinPath(REDISCONF), basename(redisExe).toLowerCase()); write(STATE, state);
      if (!await wait(async () => listenerMatches(REDISPORT, state.redis) && await healthy(c), 15000)) throw Error('Local PostgreSQL/Redis did not become healthy; inspect FRAME-only logs.');
      state.phase = 'running'; write(STATE, state);
      console.log(JSON.stringify({ running: true, configPath: CONFIG, ports: { postgres: PGPORT, redis: REDISPORT }, redisArchiveSha256: REDIS_SHA256 }, null, 2));
    } catch (error) { await stopOwned(state, c); state.phase = 'failed'; state.failedAt = new Date().toISOString(); write(STATE, state); throw error; }
  }
} finally { release?.(); }

function dirnameRedis(file) { return resolve(file, '..'); }
