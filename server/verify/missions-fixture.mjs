// Controlled deadline fixture only: shifts one fresh isolated received mission and its initial history together.
// It does not represent fifteen real minutes of elapsed viewing or change production data.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, missionId] = process.argv.slice(2), uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (action !== 'expire' || !uuid.test(missionId ?? '')) throw Error('Use expire with one exact isolated mission UUID.');
const config = JSON.parse(readFileSync(process.env.FRAME_PRODUCT_TEST_CONFIG || join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (config.verifyDbUrl === config.dbUrl || !/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '')) throw Error('Only the separate local verification database is allowed.');
const database = new URL(config.verifyDbUrl.slice(5));
const sql = `WITH target AS (
 SELECT m.id,(m.duration_minutes*60000::bigint+1000) AS shift FROM product_missions m
 JOIN product_accounts a ON a.id=m.author_id JOIN product_channels c ON c.id=m.channel_id JOIN product_accounts owner ON owner.id=c.owner_id
 WHERE m.id='${missionId}'::uuid AND m.status='received' AND m.version=0
 AND a.email ~ '^missions_ui_restricted_[0-9a-f]{10}@example[.]invalid$'
 AND owner.email='missions_ui_owner_'||substring(a.email from '_([0-9a-f]{10})@example[.]invalid$')||'@example.invalid'
 AND m.created_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint-3600000
 AND (SELECT count(*) FROM product_mission_history h WHERE h.mission_id=m.id)=1
 FOR UPDATE OF m
), shifted AS (
 UPDATE product_missions m SET created_at_ms=m.created_at_ms-t.shift,updated_at_ms=m.updated_at_ms-t.shift,deadline_at_ms=m.deadline_at_ms-t.shift
 FROM target t WHERE m.id=t.id RETURNING m.id,t.shift
), history_shift AS (
 UPDATE product_mission_history h SET created_at_ms=h.created_at_ms-s.shift FROM shifted s WHERE h.mission_id=s.id RETURNING h.mission_id
) SELECT mission_id FROM history_shift`;
let output;
try { output = execFileSync(join(process.env.FRAME_POSTGRES_BIN || 'C:/Program Files/PostgreSQL/17/bin', 'psql.exe'),
 ['-X','-w','-h',database.hostname,'-p',database.port,'-U',config.dbUsername,'-d',database.pathname.slice(1),'-At','-v','ON_ERROR_STOP=1'],
 { env:{...process.env,PGPASSWORD:config.dbPassword},input:sql,windowsHide:true,encoding:'utf8',stdio:['pipe','pipe','pipe'] }); }
catch { throw Error('The controlled verification deadline shift failed; private SQL and credentials remain hidden.'); }
if (!output.split(/\r?\n/).includes(missionId)) throw Error('Only the exact fresh received mission fixture may be shifted; unrelated rows were untouched.');
console.log(JSON.stringify({fixtureOnly:true,changed:1,controlledDeadline:true,actualElapsedMinutes:false}));
