// Requires Docker Compose CLI for config rendering; never starts a container or changes a real DB.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'frame-docker-check-'));
const env = { ...process.env, FRAME_DOCKER_DIR: directory };
const results = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
function run(...args) { return spawnSync(process.execPath, [join(root, 'server/product-docker.mjs'), ...args], { env, windowsHide: true, encoding: 'utf8' }); }
const files = ['config.json', 'postgres-admin-password.txt', 'postgres-app-password.txt', 'redis-password.txt', 'redis-users.acl'];
const output = join(root, 'verification/product/docker-result.json');
mkdirSync(dirname(output), { recursive: true });
try {
  let result = run('prepare');
  check(result.status === 0, 'Private Docker preparation succeeds without an engine');
  const before = files.map(name => readFileSync(join(directory, name), 'utf8'));
  const config = JSON.parse(before[0]);
  check(config.runtime === 'docker' && config.dbUrl.includes(':25432/') && config.redisPort === 26379, 'Docker endpoints are separate from existing PC databases');
  check(before[4].startsWith('user default on #') && !before[4].includes(config.redisPassword), 'Redis ACL stores a hash of its password');
  result = run('prepare');
  check(result.status === 0 && files.every((name, index) => readFileSync(join(directory, name), 'utf8') === before[index]), 'Repeated preparation preserves every credential');
  check(![config.dbPassword, config.redisPassword, before[1].trim()].some(secret => (result.stdout + result.stderr).includes(secret)), 'Preparation output contains no credentials');
  result = run('check');
  check(result.status === 0, 'Official Docker Compose validates the configuration');
  const perUserDocker = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe');
  const compose = process.env.FRAME_COMPOSE_BINARY || (perUserDocker && existsSync(perUserDocker) ? perUserDocker : 'docker');
  const prefix = process.env.FRAME_COMPOSE_BINARY ? [] : ['compose'];
  const rendered = JSON.parse(execFileSync(compose, [...prefix, '-f', join(root, 'deploy/compose.yaml'), 'config', '--format', 'json'], { env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  check(rendered.services.postgres.image === 'postgres:17.11' && rendered.services.redis.image === 'redis:8.10.3', 'Official PostgreSQL and Redis versions are explicit');
  check(Object.values(rendered.services).every(service => service.ports.every(port => port.host_ip === '127.0.0.1')), 'Every published database port binds loopback');
  check(Object.keys(rendered.volumes).length === 2 && Object.values(rendered.services).every(service => service.volumes.some(volume => volume.type === 'volume')), 'Both services keep their data in named volumes');
  check(rendered.services.postgres.environment.POSTGRES_USER === 'frame_admin' && !JSON.stringify(rendered).includes(config.dbPassword) && !JSON.stringify(rendered).includes(config.redisPassword), 'Rendered Compose contains only secret file references');
  check(rendered.services.postgres.healthcheck.test.join(' ').includes('frame_app') && rendered.services.redis.healthcheck.test.join(' ').includes('REDISCLI_AUTH'), 'Healthchecks authenticate as the application database role and Redis client');
  writeFileSync(join(directory, 'redis-users.acl'), 'invalid-acl\n');
  result = run('prepare');
  check(result.status !== 0 && readFileSync(join(directory, 'redis-users.acl'), 'utf8') === 'invalid-acl\n' && readFileSync(join(directory, 'config.json'), 'utf8') === before[0], 'Mismatched secrets fail without rotating passwords or rewriting files');
  writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), results, composeVersion: 'official CLI configuration validation', containerExecution: false, actualDatabaseChanged: false }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length, containerExecution: false }));
} catch (failure) {
  writeFileSync(output, JSON.stringify({ results, failure: failure.message, containerExecution: false }, null, 2));
  throw failure;
} finally {
  const resolved = resolve(directory), parent = resolve(tmpdir());
  if (dirname(resolved) === parent && basename(resolved).startsWith('frame-docker-check-')) rmSync(resolved, { recursive: true, force: true });
}
