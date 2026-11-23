const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const original = read('domestic-linked-sale-correction-migration.sql');
const migration = read('delivery-export-correction-migration.sql');
const metadataMigration = read('delivery-export-migration.sql');
const baseMigration = read('domestic-sales-migration.sql').replace('create extension if not exists pgcrypto;', '');
function correction(source) {
  const match = source.match(/create or replace function public\.correct_domestic_sale\([\s\S]*?\n\$\$;/);
  assert.ok(match, 'The complete correction function is present');
  return match[0];
}
const baseFunction = correction(original);
const savedFunction = correction(migration);
const columnAddition = ',\n      external_order_no,delivery_carton_no,delivery_spec,delivery_customer_name,\n      delivery_export_revision,delivery_metadata_saved';
const valueAddition = `,
      original_lines -> original_line_id::text ->> 'external_order_no',
      original_lines -> original_line_id::text ->> 'delivery_carton_no',
      original_lines -> original_line_id::text ->> 'delivery_spec',
      original_lines -> original_line_id::text ->> 'delivery_customer_name',
      case when original_line_id is null then 0
        else (original_lines -> original_line_id::text ->> 'delivery_export_revision')::integer + 1 end,
      coalesce((original_lines -> original_line_id::text ->> 'delivery_metadata_saved')::boolean,false)`;

test('correction is the exact latest function with only delivery INSERT columns and values appended', () => {
  assert.equal(savedFunction.split(columnAddition).length, 2);
  assert.equal(savedFunction.split(valueAddition).length, 2);
  assert.equal(savedFunction.replace(columnAddition, '').replace(valueAddition, ''), baseFunction);
});

test('follow-on migration is transactional, retains grants, and does not execute a correction or backfill', () => {
  const outside = migration.replace(savedFunction, '').replace(/--[^\n]*/g, '').trim();
  assert.match(outside, /^begin;\s+revoke all on function public\.correct_domestic_sale\(uuid,date,text,numeric,text,jsonb,text\) from public,anon;\s+grant execute on function public\.correct_domestic_sale\(uuid,date,text,numeric,text,jsonb,text\) to authenticated;\s+notify pgrst, 'reload schema';\s+commit;$/);
  assert.equal((migration.match(/create or replace function/g) || []).length, 1);
  assert.match(migration, /after delivery-export-migration\.sql AND domestic-linked-sale-correction-migration\.sql/);
});

test('retained identities and all delivery data come from the server snapshot, not correction JSON', () => {
  assert.match(savedFunction, /jsonb_object_agg\(id::text,to_jsonb\(l\)\)/);
  assert.ok(savedFunction.indexOf('into original_lines') < savedFunction.indexOf('delete from public.domestic_sale_lines'));
  assert.match(savedFunction, /coalesce\(original_line_id,gen_random_uuid\(\)\)/);
  assert.match(savedFunction, /if not \(original_lines \? original_line_id::text\)/);
  assert.match(savedFunction, /if original_line_id = any\(used_line_ids\)/);
  assert.doesNotMatch(savedFunction, /line_item\s*->>?\s*'(?:external_order_no|delivery_[^']+)'/);
  for (const field of ['external_order_no', 'delivery_carton_no', 'delivery_spec', 'delivery_customer_name']) {
    assert.ok(savedFunction.includes(`original_lines -> original_line_id::text ->> '${field}'`));
  }
});

test('financial correction advances retained revisions but independently preserves the saved flag', () => {
  assert.match(savedFunction, /case when original_line_id is null then 0\s+else \(original_lines -> original_line_id::text ->> 'delivery_export_revision'\)::integer \+ 1 end/);
  assert.match(savedFunction, /coalesce\(\(original_lines -> original_line_id::text ->> 'delivery_metadata_saved'\)::boolean,false\)/);
  assert.doesNotMatch(savedFunction, /delivery_metadata_saved\s*(?:=|:=)\s*true|delivery_export_revision[^\n]*>\s*0/);
  assert.match(metadataMigration, /if new\.delivery_metadata_saved then\s+return new;/);
  assert.match(metadataMigration, /delivery_metadata_saved = true/);
});

test('same parent locking, financial guards and source isolation remain in place', () => {
  assert.match(savedFunction, /from public\.domestic_sales\s+where id = p_sale_id\s+for update;/);
  assert.match(savedFunction, /target_receivable\.paid_amount_jpy > 0/);
  assert.match(savedFunction, /public\.domestic_sale_has_closed_billing\(target_sale.customer_code,target_sale.sale_date\)/);
  assert.doesNotMatch(savedFunction, /(?:update|delete from|insert into) public\.(?:order_entry_lines|order_lines|sales_records|work_sessions|accounts_receivable)\b/);
  assert.doesNotMatch(savedFunction, /exception when|disable trigger|session_replication_role/);
});

// Optional SQL tests use a fresh in-memory database only, never a connection URL.
// With no local runtime these are explicitly skipped, not counted as SQL passes.
let pglitePath;
if (process.env.PGLITE_PATH) pglitePath = require.resolve(process.env.PGLITE_PATH);
else {
  try { pglitePath = require.resolve('@electric-sql/pglite'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
const sqlOptions = { skip: pglitePath ? false : 'No local PGlite runtime; static verification only.' };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fields = ['external_order_no', 'delivery_carton_no', 'delivery_spec', 'delivery_customer_name'];
async function database() {
  const { PGlite } = require(pglitePath);
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key); insert into auth.users values('${id(99)}');
      create function auth.uid() returns uuid language sql as $$select '${id(99)}'::uuid$$;
      create function public.is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.internal',true),'true')='true'$$;
      create function public.is_master_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
      grant usage on schema auth to authenticated;
      create table public.product_master(product_id text primary key,product_name text,is_active boolean default true);
      insert into public.product_master values('P1','Product one',true),('P2','Product two',true);
      create table public.work_sessions(id uuid primary key,data jsonb);
      create table public.order_entry_lines(id uuid primary key,data jsonb);
      create table public.order_lines(id uuid primary key,session_id uuid,source_row_no integer,source_order_line_id uuid,unique(session_id,source_row_no));
      create table public.sales_records(id uuid primary key,session_id uuid,source_row_no integer,data jsonb,unique(session_id,source_row_no));
    `);
    await db.exec(baseMigration);
    await db.exec(`
      alter table public.domestic_sales add source_type text default 'manual',add source_session_id uuid,add source_importer_code text,add source_key text unique;
      alter table public.domestic_sale_lines add source_sales_record_id uuid references public.sales_records(id) on delete restrict;
      create table public.domestic_billing_closings(id uuid primary key default gen_random_uuid(),customer_code text,status text,period_from date,period_to date);
    `);
    await db.exec(original);
    await db.exec(metadataMigration);
    await db.exec(migration);
    await db.exec(`
      insert into public.work_sessions values('${id(50)}','{"locked":true,"amount":2000}');
      insert into public.order_entry_lines(id,data,external_order_no) values('${id(20)}','{"quantity":2}','SOURCE-001');
      insert into public.order_lines values('${id(21)}','${id(50)}',1,'${id(20)}',null);
      insert into public.sales_records(id,session_id,source_row_no,data) values('${id(10)}','${id(50)}',1,'{"amount":2000,"box_no":"8"}');
      insert into public.domestic_customer_master(customer_code,customer_name) values('A','Customer A'),('B','Customer B');
      insert into public.domestic_sales(id,sale_no,sale_date,customer_code,customer_name_snapshot,product_subtotal_8_jpy,total_net_jpy,tax_8_jpy,tax_total_jpy,total_amount_jpy,source_type,source_session_id,source_importer_code,source_key)
        values('${id(1)}','DOM-TEST','2026-08-10','A','Customer A',2000,2000,160,160,2160,'export_intermediary','${id(50)}','08','export:test');
      insert into public.domestic_sale_lines(id,sale_id,line_no,product_code,product_name_snapshot,quantity,unit,unit_price_jpy,tax_rate,net_amount_jpy,source_sales_record_id)
        values('${id(2)}','${id(1)}',1,'P1','Product one',2,'Kg',1000,8,2000,'${id(10)}');
      insert into public.domestic_receivables(id,source_key,source_type,sale_id,customer_code,customer_name_snapshot,invoice_date,due_date,amount_jpy,balance_jpy)
        values('${id(3)}','sale:test','sale','${id(1)}','A','Customer A','2026-08-10','2026-09-30',2160,2160);
    `);
    return db;
  } catch (error) { await db.close(); throw error; }
}
async function rows(db, table) { return (await db.query(`select * from public.${table} order by id`)).rows; }
async function detail(db) { return (await rows(db, 'domestic_sale_lines'))[0]; }
async function snapshot(db) {
  const result = {};
  for (const table of ['work_sessions', 'order_entry_lines', 'order_lines', 'sales_records', 'domestic_sales', 'domestic_sale_lines', 'domestic_receivables', 'domestic_receivable_payments']) {
    result[table] = await rows(db, table);
  }
  return result;
}
function correctionLine(changes = {}) {
  return { original_line_id: id(2), product_code: 'P1', product_name: 'Product one', quantity: 2, unit: 'Kg', unit_price: 1200, tax_rate: 8, memo: 'domestic only', ...changes };
}
async function correct(db, lines = [correctionLine()]) {
  return (await db.query('select public.correct_domestic_sale($1,$2,$3,$4,$5,$6::jsonb,$7) result',
    [id(1), '2026-08-10', 'A', 100, 'Correction', JSON.stringify(lines), 'Test correction'])).rows[0].result;
}
async function save(db, changes = {}, revision) {
  const line = await detail(db);
  const payload = [{ id: line.id, expected_revision: revision ?? line.delivery_export_revision, ...changes }];
  return (await db.query('select public.save_domestic_delivery_metadata($1,$2::jsonb) result',
    [id(1), JSON.stringify(payload)])).rows[0].result;
}
const savedValues = { external_order_no: 'CLIENT-009', delivery_carton_no: 'CTN-0008', delivery_spec: '2 packs', delivery_customer_name: 'Store Z' };

test('SQL: explicit cleared numbers survive work and sales upserts without restoring source order numbers', sqlOptions, async () => {
  const db = await database();
  try {
    await db.exec(`update public.order_lines set external_order_no=null where id='${id(21)}';
      insert into public.order_lines(id,session_id,source_row_no,source_order_line_id,external_order_no)
      values('${id(21)}','${id(50)}',1,'${id(20)}','')
      on conflict(session_id,source_row_no) do update set external_order_no=excluded.external_order_no;
      insert into public.sales_records(id,session_id,source_row_no,data,external_order_no)
      values('${id(10)}','${id(50)}',1,'{"amount":2000,"box_no":"8"}','')
      on conflict(session_id,source_row_no) do update set external_order_no=excluded.external_order_no;`);
    assert.equal((await rows(db,'order_lines'))[0].external_order_no,'');
    assert.equal((await rows(db,'sales_records'))[0].external_order_no,'');
    assert.equal((await rows(db,'order_entry_lines'))[0].external_order_no,'SOURCE-001');
  } finally { await db.close(); }
});

test('SQL: metadata save -> financial correction -> stale rejection -> fresh metadata save preserves money and sources', sqlOptions, async () => {
  const db = await database();
  try {
    const before = await snapshot(db);
    const saved = (await save(db, savedValues)).lines[0];
    assert.equal(saved.delivery_metadata_saved, true);
    const result = await correct(db);
    assert.equal(Number(result.total_amount_jpy), 2702);
    const line = await detail(db);
    assert.equal(line.id, id(2)); assert.equal(line.source_sales_record_id, id(10));
    for (const field of fields) assert.equal(line[field], savedValues[field]);
    assert.equal(line.delivery_metadata_saved, true);
    assert.equal(line.delivery_export_revision, saved.delivery_export_revision + 1);
    const corrected = await snapshot(db);
    for (const table of ['work_sessions', 'order_entry_lines', 'order_lines', 'sales_records']) assert.deepEqual(corrected[table], before[table]);
    await assert.rejects(() => save(db, { external_order_no: 'STALE' }, saved.delivery_export_revision), error => error.code === '40001');
    assert.deepEqual(await snapshot(db), corrected);
    const fresh = (await save(db, { delivery_spec: '3 packs' })).lines[0];
    assert.equal(fresh.delivery_export_revision, line.delivery_export_revision + 1);
    const after = await snapshot(db);
    for (const table of Object.keys(corrected).filter(table => table !== 'domestic_sale_lines')) assert.deepEqual(after[table], corrected[table]);
    const omitMetadata = value => Object.fromEntries(Object.entries(value).filter(([key]) => ![...fields, 'delivery_export_revision', 'delivery_metadata_saved', 'updated_at'].includes(key)));
    assert.deepEqual(omitMetadata(after.domestic_sale_lines[0]), omitMetadata(corrected.domestic_sale_lines[0]));
  } finally { await db.close(); }
});

test('SQL: explicit clears stay null through correction even when the export source has an order number', sqlOptions, async () => {
  const db = await database();
  try {
    await save(db, { external_order_no: '   ', delivery_carton_no: null, delivery_spec: '', delivery_customer_name: null });
    await correct(db);
    const line = await detail(db);
    for (const field of fields) assert.equal(line[field], null);
    assert.equal(line.delivery_metadata_saved, true); assert.equal(line.delivery_export_revision, 2);
    assert.equal((await rows(db, 'sales_records'))[0].external_order_no, 'SOURCE-001');
  } finally { await db.close(); }
});

test('SQL: pre-metadata financial correction advances revision without marking metadata saved', sqlOptions, async () => {
  const db = await database();
  try {
    await correct(db);
    const line = await detail(db);
    assert.equal(line.delivery_export_revision, 1); assert.equal(line.delivery_metadata_saved, false);
    assert.equal(line.external_order_no, 'SOURCE-001');
    await assert.rejects(() => save(db, savedValues, 0), error => error.code === '40001');
  } finally { await db.close(); }
});

test('SQL: retained lines preserve metadata while new, duplicated or replacement lines start empty', sqlOptions, async () => {
  const db = await database();
  try {
    await save(db, savedValues);
    const newLine = correctionLine({ original_line_id: null, product_code: 'P2', product_name: 'New product', ...savedValues, delivery_metadata_saved: true });
    await correct(db, [newLine, correctionLine()]);
    const lines = await rows(db, 'domestic_sale_lines');
    const retained = lines.find(line => line.id === id(2));
    const added = lines.find(line => line.id !== id(2));
    assert.equal(retained.line_no, 2); assert.equal(retained.delivery_carton_no, savedValues.delivery_carton_no);
    assert.equal(added.source_sales_record_id, null); assert.equal(added.delivery_export_revision, 0);
    assert.equal(added.delivery_metadata_saved, false);
    for (const field of fields) assert.equal(added[field], null);
    await correct(db, [newLine]);
    const replacement = await detail(db);
    assert.notEqual(replacement.id, retained.id); assert.notEqual(replacement.id, added.id);
    for (const field of fields) assert.equal(replacement[field], null);
    assert.equal(replacement.delivery_metadata_saved, false); assert.equal(replacement.delivery_export_revision, 0);
  } finally { await db.close(); }
});

test('SQL: foreign/duplicate identities and late validation failure roll back metadata, revisions and financial rows', sqlOptions, async () => {
  const db = await database();
  try {
    await save(db, savedValues);
    const before = await snapshot(db);
    for (const lines of [[correctionLine({ original_line_id: id(88) })], [correctionLine(), correctionLine()], [correctionLine(), correctionLine({ original_line_id: null, quantity: 0 })]]) {
      await assert.rejects(() => correct(db, lines));
      assert.deepEqual(await snapshot(db), before);
    }
    await db.exec('update public.domestic_sale_lines set delivery_export_revision=2147483647');
    const exhausted = await snapshot(db);
    await assert.rejects(() => correct(db), error => error.code === '22003');
    assert.deepEqual(await snapshot(db), exhausted);
  } finally { await db.close(); }
});

test('SQL: existing administrator, paid and closed-billing correction restrictions remain atomic', sqlOptions, async () => {
  const db = await database();
  try {
    await save(db, savedValues);
    let before = await snapshot(db);
    await db.exec("select set_config('test.admin','false',false)");
    await assert.rejects(() => correct(db), error => error.code === '42501');
    assert.deepEqual(await snapshot(db), before);
    await db.exec("select set_config('test.admin','true',false);update public.domestic_receivables set paid_amount_jpy=1,balance_jpy=2159");
    before = await snapshot(db); await assert.rejects(() => correct(db)); assert.deepEqual(await snapshot(db), before);
    await db.exec("update public.domestic_receivables set paid_amount_jpy=0,balance_jpy=2160;insert into public.domestic_billing_closings(customer_code,status,period_from,period_to) values('A','closed','2026-09-01','2026-09-30')");
    before = await snapshot(db); await assert.rejects(() => correct(db)); assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});

test('SQL: migration reapplication changes no rows and metadata saving remains a definer-only internal-user path', sqlOptions, async () => {
  const db = await database();
  try {
    await save(db, savedValues);
    const before = await snapshot(db);
    await db.exec(metadataMigration); await db.exec(migration);
    assert.deepEqual(await snapshot(db), before);
    await db.exec("select set_config('test.internal','false',false)");
    await assert.rejects(() => save(db, savedValues), error => error.code === '42501');
    assert.deepEqual(await snapshot(db), before);
    await db.exec("select set_config('test.internal','true',false);set role authenticated");
    await assert.rejects(() => db.exec('update public.domestic_sale_lines set delivery_metadata_saved=true'));
    const result = await save(db, { delivery_spec: 'Internal staff edit' });
    assert.equal(result.lines[0].delivery_metadata_saved, true);
    await db.exec('reset role');
    const grants = (await db.query("select has_function_privilege('anon','public.save_domestic_delivery_metadata(uuid,jsonb)','execute') as metadata,has_function_privilege('anon','public.correct_domestic_sale(uuid,date,text,numeric,text,jsonb,text)','execute') as correction")).rows[0];
    assert.equal(grants.metadata, false); assert.equal(grants.correction, false);
  } finally { await db.close(); }
});
