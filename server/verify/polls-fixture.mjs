// Shortens one newly created polls_ui_* poll deadline in the separate verification database only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, id] = process.argv.slice(2);
if (action !== 'expire' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? '')) throw Error('Use expire with the exact newly created fixture poll UUID.');
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (config.verifyDbUrl === config.dbUrl || !/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '')) throw Error('Only the separate native local verification database is allowed.');
const database = new URL(config.verifyDbUrl.slice(5));
const sql = `UPDATE product_polls p SET ends_at_ms=p.created_at_ms+1 FROM product_channels c,product_accounts a
WHERE p.id='${id}'::uuid AND p.channel_id=c.id AND c.owner_id=a.id AND a.email ~ '^polls_ui_[a-z0-9_]+@example[.]invalid$'
AND p.closed_at_ms IS NULL AND p.ends_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint
AND p.created_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint-3600000
AND p.created_at_ms+1<(extract(epoch FROM clock_timestamp())*1000)::bigint RETURNING p.id`;
const output = execFileSync(join(process.env.FRAME_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin', 'psql.exe'),
  ['-h', database.hostname, '-p', database.port, '-U', config.dbUsername, '-d', database.pathname.slice(1), '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { env: { ...process.env, PGPASSWORD: config.dbPassword }, windowsHide: true, encoding: 'utf8' });
if (!output.split(/\r?\n/).includes(id)) throw Error('The exact recent active fixture poll was not found; unrelated data was not changed.');
console.log(JSON.stringify({ action, fixtureOnly: true, changed: 1 }));
