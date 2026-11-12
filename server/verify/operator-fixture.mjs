// Grants/revokes only throwaway operator_ui_* users in the separate local verification DB.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, id] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(action) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? '')) throw Error('Use grant|revoke with an exact fixture UUID.');
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (config.verifyDbUrl === config.dbUrl || !/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '')) throw Error('Only the separate local verification database is allowed.');
const database = new URL(config.verifyDbUrl.slice(5));
// UUID is strictly validated above; the fixture prefix prevents promoting unrelated verification accounts.
const sql = `UPDATE product_accounts SET is_operator=${action === 'grant'} WHERE id='${id}'::uuid AND email ~ '^operator_ui_[a-z0-9_]+@example[.]invalid$' RETURNING id`;
const output = execFileSync(join(process.env.FRAME_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin', 'psql.exe'),
  ['-h', database.hostname, '-p', database.port, '-U', config.dbUsername, '-d', database.pathname.slice(1), '-At', '-c', sql],
  { env: { ...process.env, PGPASSWORD: config.dbPassword }, windowsHide: true, encoding: 'utf8' });
if (!output.split(/\r?\n/).includes(id)) throw Error('The test operator account was not found; no other account was changed.');
console.log(JSON.stringify({ action, fixtureOnly: true, changed: 1 }));
