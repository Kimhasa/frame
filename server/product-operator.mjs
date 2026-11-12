// Explicit local administration of an existing FRAME account. Never creates accounts or promotes future signups.
// node server/product-operator.mjs status|grant|revoke --email <existing-account-email>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [action = 'status', flag, input] = process.argv.slice(2);
if (!['status', 'grant', 'revoke'].includes(action) || flag !== '--email' || !input || process.argv.length !== 5) throw Error('Usage: status|grant|revoke --email <existing-account-email>');
const email = input.trim().toLowerCase();
if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) throw Error('Enter the exact registered email.');
const file = process.env.FRAME_PRODUCT_CONFIG || join(process.env.LOCALAPPDATA, 'Frame/product/config.json');
const config = JSON.parse(readFileSync(file, 'utf8'));
if (config.enabled !== true || !/^jdbc:postgresql:\/\/127\.0\.0\.1:\d+\/frame_product(?:_[a-z0-9_]+)?$/.test(config.dbUrl ?? '')) throw Error('An enabled, local FRAME database configuration is required.');
const database = new URL(config.dbUrl.slice(5));
function sql(query) {
  try {
    return execFileSync(join(process.env.FRAME_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin', 'psql.exe'),
      ['-h', database.hostname, '-p', database.port, '-U', config.dbUsername, '-d', database.pathname.slice(1), '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
      { env: { ...process.env, PGPASSWORD: config.dbPassword }, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw Error('Could not access the FRAME operator setting. Check the local database and apply Flyway V6 first; no credentials were printed.'); }
}
// Hex encoding keeps user input out of SQL syntax, including quoted email local parts.
const hex = Buffer.from(email, 'utf8').toString('hex');
const row = sql(`SELECT id || ':' || is_operator::text FROM product_accounts WHERE email=convert_from(decode('${hex}','hex'),'UTF8')`);
if (!row) {
  console.log(JSON.stringify({ accountExists: false, changed: false, message: 'Sign up first. No future account was granted access.' }));
  if (action !== 'status') process.exitCode = 1;
} else {
  const [id, current] = row.split(':');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw Error('The account identity could not be verified.');
  const wanted = action === 'status' ? current === 'true' : action === 'grant';
  let changed = false;
  if (action !== 'status' && wanted !== (current === 'true')) {
    const result = sql(`UPDATE product_accounts SET is_operator=${wanted} WHERE id='${id}'::uuid RETURNING is_operator`);
    if (result.split(/\r?\n/)[0] !== (wanted ? 't' : 'f')) throw Error('The account changed before the update. No other account was selected.');
    changed = true;
  }
  console.log(JSON.stringify({ accountExists: true, isOperator: wanted, changed, existingAccountOnly: true }));
}
