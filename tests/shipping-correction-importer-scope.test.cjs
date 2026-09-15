const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const sql = fs.readFileSync(path.join(__dirname, '../shipping-correction-importer-scope-migration.sql'), 'utf8');
const session = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000007';
const other = '00000000-0000-4000-8000-000000000002';
const closing = '00000000-0000-4000-8000-000000000003';
const fixture = `
create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$
  select case when coalesce(current_setting('test.logged_out',true),'')='yes' then null
  else '00000000-0000-4000-8000-000000000099'::uuid end $$;
create function is_master_admin() returns boolean language sql as $$
  select coalesce(current_setting('test.not_admin',true),'') <> 'yes' $$;
create function canonical_importer_code(text) returns text language sql immutable as $$
  select case upper(trim($1)) when 'JKT' then '07' when 'DIM' then '01' else upper(trim($1)) end $$;
create table work_sessions (id uuid primary key, shipping_fee numeric, shipping_fees jsonb);
create table sales_records (session_id uuid, importer_code text, importer_id text, is_stockout boolean);
create table accounts_receivable (id uuid primary key, source_session_id uuid, source_type text,
  importer_code text, closing_id uuid, invoice_date date, currency text,
  net_sales_jpy numeric, shipping_amount_jpy numeric, adjustment_amount_jpy numeric,
  amount_jpy numeric, updated_by uuid);
create table accounts_receivable_closings (id uuid, importer_code text, status text,
  period_from date, period_to date);
create table accounts_receivable_payments (receivable_id uuid, amount_jpy numeric);
create table sales_correction_log (action_type text, session_id uuid, importer_code text,
  old_values jsonb, new_values jsonb, reason text, changed_by uuid);
insert into work_sessions values ('${session}',250,'{"01":50,"07":200}');
insert into sales_records values ('${session}','07',null,false),('${session}','01',null,false);
insert into accounts_receivable values
  ('${target}','${session}','sales','07',null,'2026-08-10','JPY',1000,200,25,1225,null),
  ('${other}','${session}','sales','01','${closing}','2026-08-10','JPY',300,50,0,350,null),
  ('00000000-0000-4000-8000-000000000008',null,'adjustment','07',null,'2026-08-10','JPY',0,0,-30,-30,null);
insert into accounts_receivable_closings values ('${closing}','01','closed','2026-08-01','2026-08-31');
insert into accounts_receivable_payments values ('${other}',350);
`;
async function snapshot(db) {
  const out = {};
  for (const table of ['work_sessions','accounts_receivable','accounts_receivable_closings',
    'accounts_receivable_payments','sales_correction_log']) {
    out[table] = (await db.query(`select to_jsonb(t) as data from ${table} t order by to_jsonb(t)::text`)).rows;
  }
  return out;
}
async function run(name, setup='', error=null, code='07', amount='150') {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    await db.exec(sql);
    if (setup) await db.exec(setup);
    const before = await snapshot(db);
    const call = () => db.query('select admin_update_session_shipping_fee($1,$2,$3,$4)',
      [session,code,amount,'Supplier-specific shipping correction']);
    if (error) {
      await assert.rejects(call(),error);
      assert.deepEqual(await snapshot(db),before,'Rejected correction must be atomic');
    } else {
      await call();
      const after = await snapshot(db);
      const fee = Number((await db.query('select round($1::numeric,0) as fee',[amount])).rows[0].fee);
      const ar = after.accounts_receivable.map(r=>r.data).find(r=>r.id===target);
      assert.equal(ar.shipping_amount_jpy,fee);
      assert.equal(ar.net_sales_jpy,1000);
      assert.equal(ar.adjustment_amount_jpy,25);
      assert.equal(ar.amount_jpy,1025+fee);
      assert.equal(after.work_sessions[0].data.shipping_fee,50+fee);
      assert.equal(after.work_sessions[0].data.shipping_fees['07'],fee);
      assert.equal(after.work_sessions[0].data.shipping_fees['01'],50);
      assert.deepEqual(after.accounts_receivable.filter(r=>r.data.id!==target),
        before.accounts_receivable.filter(r=>r.data.id!==target));
      assert.deepEqual(after.accounts_receivable_closings,before.accounts_receivable_closings);
      assert.deepEqual(after.accounts_receivable_payments,before.accounts_receivable_payments);
      assert.equal(after.sales_correction_log.length,1);
      await call();
      assert.deepEqual((await snapshot(db)).accounts_receivable,after.accounts_receivable,
        'Repeated submission must not subtract shipping twice');
    }
    console.log(`PASS ${name}`);
  } finally { await db.close(); }
}
(async()=>{
  await run('other importer closed and paid; only target shipping changes');
  await run('alias input and existing alias row preserved',
    `update accounts_receivable set importer_code='JKT' where id='${target}';
     update work_sessions set shipping_fees='{"01":50,"JKT":200,"07":200}'`,null,'JKT');
  await run('target closing blocks correction',
    `update accounts_receivable set closing_id='${closing}' where id='${target}'`,/締め済み/);
  await run('target period closed under alias blocks correction',
    `insert into accounts_receivable_closings values (gen_random_uuid(),'JKT','closed','2026-08-01','2026-08-31')`,/締め済み/);
  await run('target payment blocks correction',
    `insert into accounts_receivable_payments values ('${target}',10)`,/入金登録済み/);
  await run('duplicate canonical/alias receivable rejected',
    `insert into accounts_receivable select gen_random_uuid(),source_session_id,source_type,'JKT',closing_id,
     invoice_date,currency,net_sales_jpy,shipping_amount_jpy,adjustment_amount_jpy,amount_jpy,updated_by
     from accounts_receivable where id='${target}'`,/重複/);
  await run('missing receivable does not rebuild other importers',
    `delete from accounts_receivable where id='${target}'`,/未連携/);
  await run('non-admin rejected',"set test.not_admin='yes'",/管理者/);
  await run('unauthenticated rejected',"set test.logged_out='yes'",/管理者/);
  await run('negative amount rejected','',/0以上/,'07','-1');
  await run('NaN rejected','',/0以上/,'07','NaN');
  await run('unknown importer rejected','',/指定輸入社/,'99');
  await run('JPY rounding consistent', '',null,'07','150.5');
  await run('zero shipping retains existing receivable', '',null,'07','0');
  await run('audit failure rolls back receivable and session',
    `create function reject_audit() returns trigger language plpgsql as $$begin raise exception 'audit failed'; end$$;
     create trigger audit_fail before insert on sales_correction_log for each row execute function reject_audit()`,/audit failed/);
})().catch(error=>{console.error(error);process.exitCode=1;});
