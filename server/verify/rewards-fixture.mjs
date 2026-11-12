// Synthetic balances for policy/transaction QA only. The real-watching viewer account is explicitly excluded.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, userId, channelId] = process.argv.slice(2), uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (action !== 'fund' || !uuid.test(userId ?? '') || !uuid.test(channelId ?? '')) throw Error('Use fund with the exact dedicated policy account and owner channel UUIDs.');
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (config.verifyDbUrl === config.dbUrl || !/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '')) throw Error('Only the separate native local verification database is allowed.');
const database = new URL(config.verifyDbUrl.slice(5));
const sql = `WITH recipient AS (
  SELECT a.id AS user_id,c.id AS channel_id FROM product_accounts a,product_channels c,product_accounts owner
  WHERE a.id='${userId}'::uuid AND c.id='${channelId}'::uuid AND c.owner_id=owner.id
  AND a.email ~ '^rewards_ui_(policy|other)_[0-9a-f]{10}@example[.]invalid$'
  AND owner.email='rewards_ui_owner_'||substring(a.email from '_([0-9a-f]{10})@example[.]invalid$')||'@example.invalid'
  AND a.created_at>clock_timestamp()-interval '1 hour' AND owner.created_at>clock_timestamp()-interval '1 hour'
  AND NOT EXISTS(SELECT 1 FROM product_point_ledger l WHERE l.user_id=a.id AND l.channel_id=c.id)
), credited AS (
  INSERT INTO product_point_wallets(channel_id,user_id,balance)
  SELECT channel_id,user_id,1000 FROM recipient WHERE true
  ON CONFLICT(channel_id,user_id) DO UPDATE SET balance=1000
    WHERE product_point_wallets.balance=0 AND product_point_wallets.pending_watch_ms=0
      AND NOT EXISTS(SELECT 1 FROM product_point_ledger l WHERE l.user_id=product_point_wallets.user_id AND l.channel_id=product_point_wallets.channel_id)
  RETURNING channel_id,user_id,balance
), recorded AS (
  INSERT INTO product_point_ledger(id,channel_id,user_id,kind,delta,balance_after,label,created_at_ms)
  SELECT gen_random_uuid(),channel_id,user_id,'watch',1000,balance,'QA fixture credit; not actual watching',(extract(epoch FROM clock_timestamp())*1000)::bigint FROM credited
  RETURNING user_id
) SELECT user_id FROM recorded`;
const output = execFileSync(join(process.env.FRAME_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin', 'psql.exe'),
  ['-h', database.hostname, '-p', database.port, '-U', config.dbUsername, '-d', database.pathname.slice(1), '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { env: { ...process.env, PGPASSWORD: config.dbPassword }, windowsHide: true, encoding: 'utf8' });
if (!output.split(/\r?\n/).includes(userId)) throw Error('The exact empty policy fixture wallet was not found; the real-watching viewer and unrelated data were not changed.');
console.log(JSON.stringify({ action, fixtureOnly: true, syntheticPoints: 1000, actualWatching: false, changed: 1 }));
