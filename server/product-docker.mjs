// Local Docker dependencies only. No application server, data migration or volume deletion.
// node server/product-docker.mjs prepare|check|start|status|stop
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(process.env.FRAME_DOCKER_DIR || (process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Frame', 'product-docker') : join(homedir(), '.frame', 'product-docker')));
const CONFIG = join(DIR, 'config.json');
const perUserDocker = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
const docker = perUserDocker && existsSync(perUserDocker) ? perUserDocker : 'docker';
const inRepo = relative(ROOT, DIR);
if (!inRepo || (!isAbsolute(inRepo) && inRepo !== '..' && !inRepo.startsWith('..' + sep))) throw Error('Docker secrets must be prepared outside the repository.');
const command = process.argv[2] || 'status';
const commands = ['prepare', 'check', 'start', 'status', 'stop'];
if (!commands.includes(command)) throw Error('Usage: node server/product-docker.mjs prepare|check|start|status|stop');
const files = { admin: 'postgres-admin-password.txt', app: 'postgres-app-password.txt', redis: 'redis-password.txt', acl: 'redis-users.acl' };
const read = name => readFileSync(join(DIR, name), 'utf8');
const secret = name => read(name).replace(/\r?\n$/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
function json(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw Error('Local configuration is unreadable; no credentials were printed or changed.'); } }
function write(name, value) { writeFileSync(join(DIR, name), value, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }

function prepare() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (existsSync(CONFIG)) return configuration();
  // Refuse to rotate credentials if a previous preparation is incomplete.
  if (Object.values(files).some(name => existsSync(join(DIR, name)))) throw Error('Private Docker files are incomplete. Preserve them and inspect the folder; no password was replaced.');
  let appPassword;
  const nativeConfig = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Frame', 'product', 'config.json');
  if (nativeConfig && existsSync(nativeConfig)) {
    const native = json(nativeConfig);
    if (typeof native.dbPassword === 'string' && native.dbPassword.length > 0 && !/[\r\n\0]/.test(native.dbPassword)) appPassword = native.dbPassword;
  }
  appPassword ||= randomBytes(24).toString('base64url');
  const redisPassword = randomBytes(32).toString('hex');
  write(files.admin, randomBytes(32).toString('hex') + '\n');
  write(files.app, appPassword + '\n');
  write(files.redis, redisPassword + '\n');
  write(files.acl, `user default on #${hash(redisPassword)} ~* &* +@all\n`);
  write('config.json', JSON.stringify({ version: 1, runtime: 'docker', enabled: true,
    dbUrl: 'jdbc:postgresql://127.0.0.1:25432/frame_product', verifyDbUrl: 'jdbc:postgresql://127.0.0.1:25432/frame_product_verify',
    dbUsername: 'frame_app', dbPassword: appPassword, redisHost: '127.0.0.1', redisPort: 26379, redisPassword,
    redisNamespace: 'frame:product:docker:sessions', publicOrigin: 'http://127.0.0.1:5360', cookieSecure: false }, null, 2) + '\n');
  return configuration();
}
function configuration() {
  if (!existsSync(CONFIG)) throw Error('Run node server/product-docker.mjs prepare first.');
  const c = json(CONFIG);
  if (c.version !== 1 || c.runtime !== 'docker' || c.enabled !== true
    || c.dbUrl !== 'jdbc:postgresql://127.0.0.1:25432/frame_product' || c.verifyDbUrl !== 'jdbc:postgresql://127.0.0.1:25432/frame_product_verify'
    || c.dbUsername !== 'frame_app' || c.redisHost !== '127.0.0.1' || c.redisPort !== 26379 || c.redisNamespace !== 'frame:product:docker:sessions'
    || c.publicOrigin !== 'http://127.0.0.1:5360' || c.cookieSecure !== false || !/^[a-f0-9]{64}$/.test(c.redisPassword)
    || !c.dbPassword || /[\r\n\0]/.test(c.dbPassword) || secret(files.app) !== c.dbPassword || secret(files.redis) !== c.redisPassword
    || !/^[a-f0-9]{64}$/.test(secret(files.admin)) || read(files.acl) !== `user default on #${hash(c.redisPassword)} ~* &* +@all\n`) {
    throw Error('Docker configuration or secret files do not match. No credentials were printed or changed.');
  }
  return c;
}
function compose(args) {
  const exe = process.env.FRAME_COMPOSE_BINARY || docker;
  const prefix = process.env.FRAME_COMPOSE_BINARY ? [] : ['compose'];
  try {
    return execFileSync(exe, [...prefix, '--project-name', 'frame-product-dev', '--file', join(ROOT, 'deploy', 'compose.yaml'), ...args], {
      cwd: ROOT, env: { ...process.env, FRAME_DOCKER_DIR: DIR.replaceAll('\\', '/') }, windowsHide: true, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: args[0] === 'up' ? 180000 : 15000,
    });
  } catch (failure) {
    if (failure.code === 'ENOENT') throw Error('Docker Desktop with Linux containers and Docker Compose is required. No existing service was changed.');
    throw Error('Docker Compose did not complete. Check Docker Desktop, the selected context, ports 25432/26379 and private file access. Existing data volumes were preserved.');
  }
}
function localEngine() {
  // Avoid sending a local development command to a selected remote Docker daemon.
  try {
    const options = { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 };
    const context = process.env.DOCKER_CONTEXT;
    const endpoint = !context && process.env.DOCKER_HOST ? process.env.DOCKER_HOST
      : JSON.parse(execFileSync(docker, ['context', 'inspect', ...(context ? [context] : []), '--format', '{{json .Endpoints.docker.Host}}'], options).trim());
    if (!/^(npipe:\/\/\/\/\.\/pipe\/|unix:\/\/\/|tcp:\/\/(127\.0\.0\.1|localhost):\d+$)/.test(endpoint)) throw Error('Remote Docker context');
    if (execFileSync(docker, ['info', '--format', '{{.OSType}}'], options).trim() !== 'linux') throw Error('Linux containers required');
  } catch { throw Error('A local Docker engine running Linux containers is required. Install/start Docker Desktop; no existing service was changed.'); }
}

try {
  const c = command === 'prepare' || command === 'start' ? prepare() : configuration();
  if (command === 'prepare') {
    console.log(JSON.stringify({ prepared: true, configPath: CONFIG, postgresPort: 25432, redisPort: c.redisPort, existingDatabaseUntouched: true }, null, 2));
  } else if (command === 'check') {
    compose(['config', '--quiet']);
    console.log(JSON.stringify({ composeValid: true, configPath: CONFIG, engineStarted: false }));
  } else {
    localEngine();
    if (command === 'start') { compose(['up', '--detach', '--wait', '--wait-timeout', '90']); console.log(JSON.stringify({ running: true, configPath: CONFIG, postgresPort: 25432, redisPort: c.redisPort })); }
    if (command === 'status') console.log(compose(['ps', '--format', 'json']).trim());
    if (command === 'stop') { compose(['stop', 'postgres', 'redis']); console.log('Stopped only the frame-product-dev PostgreSQL and Redis; data volumes were preserved.'); }
  }
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
