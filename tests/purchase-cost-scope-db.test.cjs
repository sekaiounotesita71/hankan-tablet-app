const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const migration = read('purchase-cost-scope-migration.sql');
const migrationBody = () => migration.replace(/^begin;\s*/i,'').replace(/commit;\s*$/i,'');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STAFF = id(1);
const EXTERNAL = id(2);

function functionSql(filename, name) {
  const sql = read(filename);
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${filename}: ${name} must exist`);
  const end = sql.indexOf('$$;', sql.indexOf('as $$', start));
  assert.ok(end > start, `${filename}: ${name} must have a complete body`);
  return sql.slice(start, end + 3);
}

// Only dependencies not owned by this migration are fixtures. The tax, JPY,
// confirmation and confirmed-receipt guards below are the real repo routines.
const schema = `
create role anon; create role authenticated;
create schema auth;
create table auth.users(id uuid primary key, staff boolean not null);
insert into auth.users values ('${STAFF}',true),('${EXTERNAL}',false);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.user_id',true),'')::uuid;
$$;
create function public.is_internal_user() returns boolean language sql stable security definer as $$
  select coalesce((select staff from auth.users where id=auth.uid()),false);
$$;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid(),public.is_internal_user() to authenticated,anon;
create table public.importer_master(
  importer_code text primary key, importer_name text not null,
  aliases text[] not null default '{}', is_active boolean not null default true
);
insert into importer_master values
  ('01','DIM',array['DIM Fresh'],true),('03','FBI',array['FBI Fresh'],true),
  ('07','JKT',array['Jakarta'],true),('09','INACTIVE','{}',false),
  ('EN','EN EXPORT','{}',true),('11','Ambiguous',array['AMB'],true),
  ('12','Ambiguous',array['AMB'],true);
create table public.site_master(site_code text primary key,is_active boolean not null default true);
insert into site_master values ('OSA',true),('TYO',true),('OLD',false);
create table public.supplier_master(
  supplier_code text primary key,supplier_name text not null,is_active boolean not null default true
);
insert into supplier_master values ('51','Supplier 51',true),('99','Inactive supplier',false);
create table public.sales_records(
  id uuid primary key default gen_random_uuid(),importer_code text,importer_id text,
  work_date date default '2026-10-15',site_code text default 'OSA'
);
create table public.external_work_assignment_lines(
  id uuid primary key default gen_random_uuid(),importer_code text
);
create table public.purchase_receipts(
  id uuid primary key default gen_random_uuid(),
  receipt_type text not null check(receipt_type in ('order','advance','credit_note')),
  status text not null check(status in ('expected','invoice_received','confirmed','cancelled')),
  site_code text references site_master,supplier_code text references supplier_master,
  supplier_name_snapshot text,purchase_date date,supplier_invoice_no text,invoice_date date,
  subtotal numeric not null default 0,shipping_fee numeric not null default 0,
  other_fee numeric not null default 0,tax_amount numeric not null default 0,
  tax_override boolean not null default false,total_amount numeric not null default 0,
  note text,created_by uuid references auth.users,created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),confirmed_at timestamptz,confirmed_by uuid,
  correction_unlocked boolean not null default false,correction_count integer not null default 0,
  last_correction_reason text,accounts_payable_id uuid
);
create table public.purchase_receipt_lines(
  id uuid primary key default gen_random_uuid(),receipt_id uuid not null references purchase_receipts on delete cascade,
  source_assignment_line_id uuid unique references external_work_assignment_lines,
  product_code text,product_name text,origin text,actual_qty numeric,actual_unit text,
  unit_price numeric,price_unit text,tax_rate smallint not null default 8 check(tax_rate in (0,8,10)),
  line_amount numeric not null default 0,track_inventory boolean not null default false,note text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.purchase_sales_links(
  sales_record_id uuid primary key references sales_records on delete cascade,
  purchase_receipt_id uuid not null references purchase_receipts on delete cascade,
  purchase_line_id uuid not null references purchase_receipt_lines on delete cascade,
  created_by uuid references auth.users,created_at timestamptz not null default now()
);
create table public.purchase_correction_log(
  id uuid primary key default gen_random_uuid(),receipt_id uuid references purchase_receipts,
  action text,reason text,receipt_snapshot jsonb,created_by uuid
);
create table public.inventory_lots(
  purchase_line_id uuid unique references purchase_receipt_lines,site_code text,supplier_code text,
  product_code text,product_name text,origin text,received_date date,received_qty numeric,
  available_qty numeric,unit text,unit_cost numeric,note text,updated_at timestamptz default now()
);
create table public.accounts_payable_closings(
  id uuid primary key default gen_random_uuid(),status text,period_from date,period_to date,supplier_code text
);
create table public.accounts_payable(
  id uuid primary key,purchase_receipt_id uuid unique references purchase_receipts,
  supplier_code text,source_type text default 'purchase',invoice_date date,
  subtotal_jpy numeric default 0,shipping_amount_jpy numeric default 0,other_amount_jpy numeric default 0,
  tax_amount_jpy numeric default 0,adjustment_amount_jpy numeric default 0,amount_jpy numeric default 0,
  paid_amount_jpy numeric default 0,balance_jpy numeric default 0,
  closing_id uuid references accounts_payable_closings,status text default 'unpaid'
);
create table public.accounts_payable_payments(
  id uuid primary key default gen_random_uuid(),payable_id uuid references accounts_payable,
  amount_jpy numeric,payment_date date,source_key text
);
create table public.test_confirmation_calls(id integer primary key,calls integer not null);
insert into test_confirmation_calls values(1,0);
create function public.sync_confirmed_purchases_to_payables() returns void language plpgsql as $$
begin
  update test_confirmation_calls set calls=calls+1 where id=1;
  insert into accounts_payable(id,purchase_receipt_id,supplier_code,invoice_date,
    subtotal_jpy,shipping_amount_jpy,other_amount_jpy,tax_amount_jpy,amount_jpy,balance_jpy)
  select id,id,supplier_code,invoice_date,subtotal,shipping_fee,other_fee,tax_amount,total_amount,total_amount
    from purchase_receipts where status='confirmed'
  on conflict(id) do update set subtotal_jpy=excluded.subtotal_jpy,
    shipping_amount_jpy=excluded.shipping_amount_jpy,other_amount_jpy=excluded.other_amount_jpy,
    tax_amount_jpy=excluded.tax_amount_jpy,amount_jpy=excluded.amount_jpy;
end;
$$;
create sequence public.purchase_internal_reference_seq;
`;

let db;
let setupError;
test.before(async () => {
  db = new PGlite();
  try {
    await db.exec(schema);
    const tax = read('purchase-tax-rate-migration.sql');
    await db.exec(tax.slice(tax.indexOf('create or replace function public.purchase_receipt_calculated_tax('),
      tax.indexOf('create or replace function public.create_purchase_batch_v3(')));
    const jpy = read('purchase-jpy-rounding-migration.sql');
    await db.exec(jpy.slice(jpy.indexOf('create or replace function public.normalize_purchase_receipt_line_jpy_amount('),
      jpy.indexOf('create or replace function public.normalize_accounts_payable_jpy_amount(')));
    await db.exec(functionSql('purchase-jpy-rounding-migration.sql','normalize_accounts_payable_jpy_amount'));
    await db.exec(`create trigger test_normalize_payable before insert or update on accounts_payable
      for each row execute function normalize_accounts_payable_jpy_amount()`);
    const correction = read('purchase-correction-migration.sql');
    await db.exec(correction.slice(correction.indexOf('create or replace function public.guard_confirmed_purchase_receipt('),
      correction.indexOf('create or replace function public.unlock_purchase_receipt_for_correction(')));
    await db.exec(functionSql('purchase-auto-reference-migration.sql','next_purchase_internal_reference'));
    await db.exec(functionSql('purchase-correction-migration.sql','confirm_purchase_receipt'));
    await db.exec(functionSql('purchase-credit-note-migration.sql','purchase_receipt_calculated_tax'));
    await db.exec(functionSql('purchase-no-inventory-migration.sql','force_purchase_inventory_disabled'));
    await db.exec(`create trigger test_no_inventory before insert or update of track_inventory
      on purchase_receipt_lines for each row execute function force_purchase_inventory_disabled()`);
    await db.exec(functionSql('purchase-tax-rate-migration.sql','create_purchase_batch_v3'));
    await db.exec(functionSql('purchase-immediate-confirmation-migration.sql','create_confirmed_purchase_batch_v4'));
    await db.exec(functionSql('purchase-credit-note-migration.sql','create_confirmed_purchase_batch_v5'));
    await db.exec(`revoke all on function create_purchase_batch_v3(date,text,text,text,text,jsonb),
      create_confirmed_purchase_batch_v4(date,text,text,text,text,jsonb),
      create_confirmed_purchase_batch_v5(date,text,text,text,text,text,jsonb) from public,anon;
      grant execute on function create_purchase_batch_v3(date,text,text,text,text,jsonb),
      create_confirmed_purchase_batch_v4(date,text,text,text,text,jsonb),
      create_confirmed_purchase_batch_v5(date,text,text,text,text,text,jsonb) to authenticated`);
    await db.exec(migration);
  } catch (error) {
    setupError = new Error(`SQL fixture/migration setup failed${error.code ? ` [${error.code}]` : ''}: ${error.message}`);
    if (error.position) setupError.message += ` (SQL position ${error.position})`;
    throw setupError;
  }
});
test.after(async () => { if (db) await db.close(); });
test.beforeEach(async () => {
  if (setupError) throw setupError;
  await db.exec(`begin; select set_config('test.user_id','${STAFF}',true);
    select set_config('app.purchase_correction','off',true)`);
});
test.afterEach(async () => { if (db && !setupError) await db.exec('rollback'); });

async function rows(sql, params = []) { return (await db.query(sql,params)).rows; }
async function one(sql, params = []) { return (await rows(sql,params))[0]; }
async function count(table) { return (await one(`select count(*)::integer n from ${table}`)).n; }
async function rejectSql(sql, params, expected = /./, code) {
  await db.exec('savepoint expected_failure');
  let error;
  try { await db.query(sql,params); } catch (caught) { error = caught; }
  await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure');
  assert.ok(error,'statement must be rejected');
  assert.match(error.message,expected);
  if (code) assert.equal(error.code,code);
  return error;
}
async function sale(importerCode, importerId = null) {
  return (await one('insert into sales_records(importer_code,importer_id) values($1,$2) returning id',
    [importerCode,importerId])).id;
}
async function external(importerCode) {
  return (await one('insert into external_work_assignment_lines(importer_code) values($1) returning id',
    [importerCode])).id;
}
async function receipt({date='2026-10-15',site='OSA',shipping=0,other=0} = {}) {
  return (await one(`insert into purchase_receipts(receipt_type,status,site_code,supplier_code,
    supplier_name_snapshot,purchase_date,shipping_fee,other_fee,created_by)
    values('advance','expected',$1,'51','Supplier 51',$2,$3,$4,auth.uid()) returning id`,
  [site,date,shipping,other])).id;
}
async function line(receiptId, {sources=[],externalId=null,qty=1,price=100,product='Same product',tax=8} = {}) {
  const lineId = (await one(`insert into purchase_receipt_lines(receipt_id,source_assignment_line_id,
    product_code,product_name,actual_qty,actual_unit,unit_price,price_unit,tax_rate,line_amount)
    values($1,$2,'1001',$3,$4,'Kg',$5,'Kg',$6,999999) returning id`,
  [receiptId,externalId,product,qty,price,tax])).id;
  for (const source of sources) await db.query(`insert into purchase_sales_links
    (sales_record_id,purchase_receipt_id,purchase_line_id,created_by) values($1,$2,$3,auth.uid())`,
  [source,receiptId,lineId]);
  return lineId;
}
async function scopes(ids) {
  return rows('select * from get_purchase_line_cost_scopes($1::uuid[]) order by purchase_line_id',
    [`{${ids.join(',')}}`]);
}
async function scope(lineId) { return (await scopes([lineId]))[0]; }
function classification(row) {
  return [row.scope,row.importer_code,row.assignment_method,row.editable];
}
async function setScope(lineId, kind, importer = null) {
  await db.query('select set_purchase_line_cost_scope($1,$2,$3)',[lineId,kind,importer]);
}
async function confirm(receiptId) {
  await db.query('select confirm_purchase_receipt($1)',[receiptId]);
}
const input = overrides => ({product_code:'1001',product_name:'Same product',actual_qty:1,
  actual_unit:'Kg',unit_price:100,price_unit:'Kg',tax_rate:8,cost_scope:'shared',...overrides});
function batchParams(lines, overrides = {}) {
  const args = {date:'2026-10-15',site:'OSA',supplier:'51',invoice:null,note:null,
    type:'purchase',lines:JSON.stringify(lines),...overrides};
  return Object.values(args);
}
const createSql = 'select create_confirmed_purchase_batch_v6($1::date,$2,$3,$4,$5,$6,$7::jsonb) id';
async function batch(lines, overrides) { return (await one(createSql,batchParams(lines,overrides))).id; }
async function financialSnapshot() {
  return one(`select
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from purchase_receipts t) receipts,
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from purchase_receipt_lines t) lines,
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from accounts_payable t) payables,
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from accounts_payable_payments t) payments,
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from accounts_payable_closings t) closings,
    (select coalesce(jsonb_agg(to_jsonb(t) order by purchase_line_id),'[]') from inventory_lots t) inventory,
    (select calls from test_confirmation_calls where id=1) confirmation_calls`);
}
async function summary(from = null, to = null, site = null) {
  return (await rows('select * from get_purchase_cost_scope_summary($1::date,$2::date,$3)',[from,to,site]))
    .map(row => ({...row,amount:Number(row.amount),line_count:Number(row.line_count)}));
}
function bucket(result, kind, importer = null) {
  return result.find(row => row.scope === kind && row.importer_code === importer);
}

test('legacy exact links derive a single importer without writing manual classifications',async () => {
  const r = await receipt();
  const l = await line(r,{sources:[await sale('01'),await sale('1'),await sale(null,'DIM Fresh')]});
  assert.deepEqual(classification(await scope(l)),['importer','01','auto_sales',false]);
  assert.equal(await count('purchase_line_cost_scopes'),0);
  assert.equal(await count('purchase_cost_scope_log'),0);
});

test('mixed importer links are shared, but any unresolved source makes the whole line unassigned',async () => {
  const r = await receipt();
  const mixed = await line(r,{sources:[await sale('01'),await sale('03')]});
  const unknown = await line(r,{sources:[await sale('01'),await sale('NOT-A-CODE')]});
  const allUnknown = await line(r,{sources:[await sale(null),await sale('AMB')]});
  assert.deepEqual(classification(await scope(mixed)),['shared',null,'auto_sales',false]);
  assert.deepEqual(classification(await scope(unknown)),['unassigned',null,'auto_sales',false]);
  assert.deepEqual(classification(await scope(allUnknown)),['unassigned',null,'auto_sales',false]);
});

test('getter uses current sales links and corrected importer, never a stale manual snapshot',async () => {
  const r = await receipt(); const s = await sale('01'); const l = await line(r);
  await setScope(l,'importer','07');
  await db.query(`insert into purchase_sales_links(sales_record_id,purchase_receipt_id,purchase_line_id)
    values($1,$2,$3)`,[s,r,l]);
  assert.equal((await scope(l)).importer_code,'01');
  await db.query('update sales_records set importer_code=$1 where id=$2',['03',s]);
  assert.deepEqual(classification(await scope(l)),['importer','03','auto_sales',false]);
  await db.query('delete from purchase_sales_links where sales_record_id=$1',[s]);
  assert.deepEqual(classification(await scope(l)),['importer','07','manual',true]);
});

test('external assignment classification is automatic, current and secondary to exact sales links',async () => {
  const r = await receipt(); const e = await external('Jakarta');
  const l = await line(r,{externalId:e});
  const u = await line(r,{externalId:await external('UNKNOWN')});
  assert.deepEqual(classification(await scope(l)),['importer','07','auto_external',false]);
  assert.deepEqual(classification(await scope(u)),['unassigned',null,'auto_external',false]);
  await db.query('update external_work_assignment_lines set importer_code=$1 where id=$2',['03',e]);
  assert.equal((await scope(l)).importer_code,'03');
  await db.query(`insert into purchase_sales_links(sales_record_id,purchase_receipt_id,purchase_line_id)
    values($1,$2,$3)`,[await sale('01'),r,l]);
  assert.deepEqual(classification(await scope(l)),['importer','01','auto_sales',false]);
});

test('legacy unlinked purchases stay editable and unassigned; unknown and duplicate requests are safe',async () => {
  const r = await receipt(); const l = await line(r);
  assert.deepEqual(classification(await scope(l)),['unassigned',null,'unassigned',true]);
  assert.equal((await scopes([l,l,id(999)])).length,1);
  assert.deepEqual(await scopes([]),[]);
  assert.deepEqual(await rows('select * from get_purchase_line_cost_scopes(null::uuid[])'),[]);
});

test('resolver accepts exact/numeric/unique names and aliases without guessing ambiguous names',async () => {
  const l = await line(await receipt());
  for (const value of ['01','1','001',' DIM ','dim fresh']) {
    await setScope(l,'importer',value);
    assert.equal((await scope(l)).importer_code,'01');
  }
  await setScope(l,'importer','EN');
  assert.equal((await scope(l)).importer_code,'EN');
  for (const value of ['AMB','Ambiguous','DIM other','',null,'NOPE']) {
    await rejectSql('select set_purchase_line_cost_scope($1,$2,$3)',[l,'importer',value],/Active importer not found/);
  }
});

test('inactive legacy source importer remains identifiable although new manual assignment is forbidden',async () => {
  const r = await receipt(); const l = await line(r,{sources:[await sale('09')]});
  assert.deepEqual(classification(await scope(l)),['importer','09','auto_sales',false]);
  const direct = await line(r);
  await rejectSql('select set_purchase_line_cost_scope($1,$2,$3)',[direct,'importer','09'],/Active importer not found/);
});

test('paid and closed confirmed purchase classification edits leave all financial data byte-for-byte unchanged',async () => {
  const r = await batch([input({cost_scope:'importer',cost_importer_code:'01',actual_qty:1.13,unit_price:3050})]);
  const l = (await one('select id from purchase_receipt_lines where receipt_id=$1',[r])).id;
  const closing = (await one(`insert into accounts_payable_closings(status,period_from,period_to,supplier_code)
    values('closed','2026-10-01','2026-10-31','51') returning id`)).id;
  await db.query(`update accounts_payable set closing_id=$1,status='paid',paid_amount_jpy=amount_jpy,
    balance_jpy=0 where id=$2`,[closing,r]);
  await db.query(`insert into accounts_payable_payments(payable_id,amount_jpy,payment_date,source_key)
    select id,amount_jpy,'2026-10-31','bank:paid' from accounts_payable where id=$1`,[r]);
  const before = await financialSnapshot();
  await db.exec('set local role authenticated');
  await setScope(l,'shared');
  await setScope(l,'domestic');
  await setScope(l,'importer','FBI');
  await db.exec('reset role');
  assert.deepEqual(await financialSnapshot(),before);
  assert.deepEqual(classification(await scope(l)),['importer','03','manual',true]);
  const logs = await rows('select * from purchase_cost_scope_log where purchase_line_id=$1 order by id',[l]);
  assert.equal(logs.length,4);
  assert.equal(logs[0].before_scope,null);
  assert.equal(logs[1].before_scope.importer_code,'01');
  assert.equal(logs[1].after_scope.scope,'shared');
  assert.equal(logs[2].after_scope.scope,'domestic');
  assert.equal(logs[3].before_scope.scope,'domestic');
  assert.equal(logs[3].after_scope.importer_code,'03');
  assert.ok(logs.every(log => log.created_by === STAFF && log.after_scope.updated_by === STAFF));
  await rejectSql('update purchase_receipt_lines set unit_price=999 where id=$1',[l],/locked/);
  await rejectSql('update purchase_receipts set subtotal=999 where id=$1',[r],/locked/);
});

test('setter rejects linked sales/external purchases, invalid/inactive importer, cancelled and missing lines',async () => {
  const r = await receipt(); const l = await line(r);
  const linked = await line(r,{sources:[await sale('01')]});
  const ext = await line(r,{externalId:await external('01')});
  for (const target of [linked,ext]) await rejectSql('select set_purchase_line_cost_scope($1,$2,$3)',
    [target,'shared',null],/classification is automatic/);
  for (const args of [[l,null,null],[l,'unassigned',null],[l,'other',null],
    [l,'importer','09'],[l,'shared','01'],[l,'domestic','01']]) {
    await rejectSql('select set_purchase_line_cost_scope($1,$2,$3)',args,/Select an importer|Active importer|must be empty/);
  }
  await db.query("update purchase_receipts set status='cancelled' where id=$1",[r]);
  for (const target of [l,id(999)]) await rejectSql('select set_purchase_line_cost_scope($1,$2,$3)',
    [target,'shared',null],/Purchase line not found/);
  assert.equal(await count('purchase_line_cost_scopes'),0);
  assert.equal(await count('purchase_cost_scope_log'),0);
});

test('audit insertion failure atomically restores the preceding manual classification',async () => {
  const l = await line(await receipt()); await setScope(l,'importer','01');
  const before = await rows('select * from purchase_line_cost_scopes order by purchase_line_id');
  const logs = await rows('select * from purchase_cost_scope_log order by id');
  await db.exec(`create function test_fail_scope_log() returns trigger language plpgsql as $$
    begin raise exception 'audit deliberately failed'; end;
    $$; create trigger test_fail_scope_log before insert on purchase_cost_scope_log
    for each row execute function test_fail_scope_log()`);
  await rejectSql('select set_purchase_line_cost_scope($1,$2,$3)',[l,'shared',null],/audit deliberately failed/);
  assert.deepEqual(await rows('select * from purchase_line_cost_scopes order by purchase_line_id'),before);
  assert.deepEqual(await rows('select * from purchase_cost_scope_log order by id'),logs);
});

test('metadata constraints allow only manual valid scopes with consistent importer references',async () => {
  const l = await line(await receipt());
  for (const args of [['unassigned',null,'manual'],['importer',null,'manual'],['shared','01','manual'],
    ['domestic','01','manual'],['shared',null,'auto_sales'],['importer','NOPE','manual']]) {
    await rejectSql(`insert into purchase_line_cost_scopes(purchase_line_id,scope,importer_code,assignment_method)
      values($1,$2,$3,$4)`,[l,...args],/check constraint|foreign key constraint/);
  }
  assert.equal(await count('purchase_line_cost_scopes'),0);
});

test('v6 keeps same-product manual rows separate and confirms totals/AP using real tax and JPY triggers',async () => {
  const r = await batch([
    input({actual_qty:1.13,unit_price:3050,cost_scope:'importer',cost_importer_code:'01'}),
    input({actual_qty:1.13,unit_price:3050,cost_scope:'importer',cost_importer_code:'03'}),
    input({unit_price:0,cost_scope:'domestic'}),input({unit_price:100,tax_rate:10})
  ]);
  const details = await rows('select * from purchase_receipt_lines where receipt_id=$1 order by id',[r]);
  assert.equal(details.length,4);
  assert.deepEqual(details.map(row => Number(row.line_amount)).sort((a,b)=>a-b),[0,100,3447,3447]);
  const classified = await scopes(details.map(row=>row.id));
  assert.deepEqual(classified.map(row=>row.importer_code).filter(Boolean).sort(),['01','03']);
  const saved = await one('select * from purchase_receipts where id=$1',[r]);
  assert.equal(saved.status,'confirmed'); assert.equal(saved.receipt_type,'advance');
  assert.equal(Number(saved.subtotal),6994); assert.equal(Number(saved.tax_amount),561);
  assert.equal(Number(saved.total_amount),7555);
  assert.match(saved.supplier_invoice_no,/^PUR-20261015-51-/);
  assert.equal(saved.confirmed_by,STAFF);
  assert.equal(Number((await one('select amount_jpy from accounts_payable where id=$1',[r])).amount_jpy),7555);
  assert.equal(await count('inventory_lots'),0);
});

test('v6 trusts source DB codes rather than forged client importer or scope, including mixed and unknown sources',async () => {
  const a = await sale('01'); const b = await sale('03'); const c = await sale('01');
  const unknown = await sale('UNKNOWN');
  const r = await batch([
    input({source_sales_ids:[a],cost_scope:'importer',cost_importer_code:'07'}),
    input({source_sales_ids:[b,c],cost_scope:'importer',cost_importer_code:'01'}),
    input({source_sales_ids:[unknown],cost_scope:'shared'})
  ]);
  const details = await rows(`select l.id,link.sales_record_id from purchase_receipt_lines l
    join purchase_sales_links link on link.purchase_line_id=l.id where l.receipt_id=$1`,[r]);
  assert.deepEqual(classification(await scope(details.find(x=>x.sales_record_id===a).id)),['importer','01','auto_sales',false]);
  assert.deepEqual(classification(await scope(details.find(x=>x.sales_record_id===b).id)),['shared',null,'auto_sales',false]);
  assert.deepEqual(classification(await scope(details.find(x=>x.sales_record_id===unknown).id)),['unassigned',null,'auto_sales',false]);
  assert.equal(await count('purchase_line_cost_scopes'),0);
  assert.equal((await one('select receipt_type from purchase_receipts where id=$1',[r])).receipt_type,'order');
});

test('v6 missing direct classification or a bad later row rolls back receipt, earlier lines, scopes, logs and AP',async () => {
  const s = await sale('01');
  const before = await financialSnapshot();
  for (const bad of [input({cost_scope:null}),input({cost_scope:undefined}),
    input({cost_scope:'importer',cost_importer_code:null}),
    input({product_name:''}),input({actual_qty:0}),input({unit_price:-1}),input({tax_rate:7})]) {
    await rejectSql(createSql,batchParams([input({source_sales_ids:[s]}),input(),bad]),/./);
    assert.deepEqual(await financialSnapshot(),before);
    assert.equal(await count('purchase_sales_links'),0);
    assert.equal(await count('purchase_line_cost_scopes'),0);
    assert.equal(await count('purchase_cost_scope_log'),0);
  }
});

test('v6 rejects duplicate sources within and across rows or an already imported sale, atomically',async () => {
  const s = await sale('01'); const other = await sale('03');
  for (const lines of [[input({source_sales_ids:[s,s]})],
    [input({source_sales_ids:[s]}),input({source_sales_ids:[s]})]]) {
    await rejectSql(createSql,batchParams(lines),/already been imported/,'23505');
    assert.equal(await count('purchase_receipts'),0);
    assert.equal(await count('purchase_sales_links'),0);
  }
  await batch([input({source_sales_ids:[s]})]);
  const before = await financialSnapshot();
  await rejectSql(createSql,batchParams([input({source_sales_ids:[other]}),input({source_sales_ids:[s]})]),
    /already been imported/,'23505');
  assert.deepEqual(await financialSnapshot(),before);
  assert.equal(await count('purchase_sales_links'),1);
});

test('v6 validates every header, JSON shape, source existence, amount and allowed unit before commit',async () => {
  const payloads = [[],Array.from({length:501},()=>input()),[null],[1],['invalid'],
    [input({source_sales_ids:null})],[input({source_sales_ids:'bad'})],
    [input({source_sales_ids:[id(999)]})],[input({source_sales_ids:[null]})],
    [input({source_sales_ids:[{}]})],[input({source_sales_ids:['not-a-uuid']})],
    [input({actual_qty:'NaN'})],[input({actual_qty:'Infinity'})],
    [input({unit_price:'NaN'})],[input({unit_price:'Infinity'})],
    [input({actual_qty:-1})],[input({actual_qty:null})],[input({actual_qty:''})],
    [input({actual_qty:'\t'})],[input({actual_qty:true})],[input({unit_price:null})],
    [input({unit_price:''})],[input({unit_price:'\t'})],[input({product_name:null})],
    [input({cost_scope:'\nshared'})],[input({cost_scope:'importer',cost_importer_code:'01\n'})],
    [input({actual_unit:'box'})],[input({price_unit:'pcs'})]];
  for (const payload of payloads) await rejectSql(createSql,batchParams(payload),/./);
  for (const override of [{date:null},{site:'OLD'},{site:'MISSING'},{supplier:'99'},{supplier:'MISSING'},
    {type:null},{type:'other'},{lines:null},{lines:'null'},{lines:'{}'},
    {lines:'['},{lines:'[{"actual_qty":NaN}]'},{lines:'[{"product_name":"\\u0000"}]'}]) {
    await rejectSql(createSql,batchParams([input()],override),/./);
  }
  assert.equal(await count('purchase_receipts'),0);
  assert.equal(await count('purchase_receipt_lines'),0);
  assert.equal(await count('purchase_cost_scope_log'),0);
});

test('v6 credit notes retain zero and negative yen totals with symmetric JPY rounding and no inventory',async () => {
  const r = await batch([
    input({actual_qty:1.13,unit_price:3050,cost_scope:'importer',cost_importer_code:'01'}),
    input({actual_qty:1,unit_price:0,cost_scope:'domestic'}),
    input({actual_qty:0.5,unit_price:1,tax_rate:0})
  ],{type:'credit_note'});
  const saved = await one('select * from purchase_receipts where id=$1',[r]);
  const details = await rows('select * from purchase_receipt_lines where receipt_id=$1',[r]);
  assert.equal(saved.receipt_type,'credit_note'); assert.equal(saved.status,'confirmed');
  assert.deepEqual(details.map(row=>Number(row.line_amount)).sort((a,b)=>a-b),[-3447,-1,0]);
  assert.ok(details.every(row=>Number(row.actual_qty)<0 && !row.track_inventory));
  assert.equal(Number(saved.subtotal),-3448); assert.equal(Number(saved.tax_amount),-275);
  assert.equal(Number(saved.total_amount),-3723);
  assert.equal(Number((await one('select amount_jpy from accounts_payable where id=$1',[r])).amount_jpy),-3723);
  assert.equal((await scope(details.find(row=>Number(row.line_amount)===-3447).id)).importer_code,'01');
  assert.equal(await count('inventory_lots'),0);
});

test('v6 confirmation failure rolls back links, classifications and financial rows after all lines were inserted',async () => {
  await db.exec(`create function test_fail_confirmation() returns trigger language plpgsql as $$
    begin if new.status='confirmed' then raise exception 'confirmation deliberately failed'; end if; return new; end;
    $$; create trigger test_fail_confirmation before update on purchase_receipts
    for each row execute function test_fail_confirmation()`);
  await rejectSql(createSql,batchParams([input({source_sales_ids:[await sale('01')]}),input()]),/deliberately failed/);
  for (const table of ['purchase_receipts','purchase_receipt_lines','purchase_sales_links',
    'purchase_line_cost_scopes','purchase_cost_scope_log','accounts_payable']) assert.equal(await count(table),0,table);
});

test('summary reconciles subtotal plus fees, explicit shared/domestic, credits, unknown and orphan residuals',async () => {
  const r = await receipt({shipping:20,other:5});
  const importer = await line(r,{sources:[await sale('01')],price:100});
  const shared = await line(r,{price:200}); await setScope(shared,'shared');
  const domestic = await line(r,{price:300}); await setScope(domestic,'domestic');
  await line(r,{price:400});
  await confirm(r);
  await batch([input({unit_price:50,cost_scope:'importer',cost_importer_code:'01'})],{type:'credit_note'});
  const orphan = await receipt({shipping:7});
  await db.exec("select set_config('app.purchase_correction','on',true)");
  await db.query("update purchase_receipts set status='confirmed',subtotal=30 where id=$1",[orphan]);
  const residual = await receipt(); await line(residual,{price:80}); await confirm(residual);
  await db.query('update purchase_receipts set subtotal=75 where id=$1',[residual]);
  await db.exec("select set_config('app.purchase_correction','off',true)");
  const result = await summary();
  assert.equal(bucket(result,'importer','01').amount,50);
  assert.equal(bucket(result,'shared').amount,200);
  assert.equal(bucket(result,'domestic').amount,300);
  assert.equal(bucket(result,'unassigned').amount,505);
  assert.equal(bucket(result,'fees').amount,32);
  const totals = await one("select sum(subtotal+shipping_fee+other_fee) total from purchase_receipts where status='confirmed'");
  assert.equal(result.reduce((sum,row)=>sum+row.amount,0),Number(totals.total));
  assert.equal((await scope(importer)).importer_code,'01');
});

test('summary period and site boundaries are inclusive and exclude unconfirmed/cancelled receipts',async () => {
  for (const [date,site,price] of [['2026-09-30','OSA',1],['2026-10-01','OSA',10],
    ['2026-10-31','OSA',20],['2026-11-01','OSA',2],['2026-10-15','TYO',100]]) {
    await batch([input({unit_price:price})],{date,site});
  }
  const expected = await receipt(); await line(expected,{price:999});
  const cancelled = await receipt(); await line(cancelled,{price:888});
  await db.query("update purchase_receipts set status='cancelled' where id=$1",[cancelled]);
  assert.equal(bucket(await summary('2026-10-01','2026-10-31','OSA'),'shared').amount,30);
  assert.equal(bucket(await summary('2026-10-01','2026-10-31','TYO'),'shared').amount,100);
  assert.equal(bucket(await summary('2026-10-01','2026-10-31',''),'shared').amount,130);
  assert.equal(bucket(await summary(null,'2026-10-01','OSA'),'shared').amount,11);
  assert.equal(bucket(await summary('2026-10-31',null,'OSA'),'shared').amount,22);
  assert.equal((await summary(null,null,'MISSING')).reduce((sum,row)=>sum+row.amount,0),0);
  await rejectSql('select * from get_purchase_cost_scope_summary($1,$2,$3)',
    ['2026-10-31','2026-10-01',null],/Invalid purchase period/);
});

test('getter and summary have no 1000-row truncation and zero prices remain counted',async () => {
  const r = await receipt();
  await db.query(`insert into purchase_receipt_lines(receipt_id,product_name,actual_qty,actual_unit,unit_price,price_unit)
    select $1,'Bulk row',1,'Kg',case when n=1205 then 0 else 1 end,'Kg' from generate_series(1,1205) n`,[r]);
  await confirm(r);
  const ids = (await rows('select id from purchase_receipt_lines where receipt_id=$1',[r])).map(row=>row.id);
  assert.equal((await scopes(ids)).length,1205);
  const unassigned = bucket(await summary(),'unassigned');
  assert.equal(unassigned.line_count,1205); assert.equal(unassigned.amount,1204);
});

test('migration is idempotent and never backfills or rewrites legacy financial data',async () => {
  const r = await batch([input()]); const l = (await one('select id from purchase_receipt_lines where receipt_id=$1',[r])).id;
  const before = await financialSnapshot(); const logs = await count('purchase_cost_scope_log');
  // Remove only migration transaction boundaries to preserve per-test isolation.
  await db.exec(migrationBody());
  assert.deepEqual(await financialSnapshot(),before);
  assert.equal(await count('purchase_cost_scope_log'),logs);
  assert.deepEqual(classification(await scope(l)),['shared',null,'manual',true]);
});

test('old v3/v4/v5 browsers still save without classification and their definitions and grants survive migration',async () => {
  const definitions = () => rows(`select proname,pg_get_functiondef(oid) definition,proacl::text grants
    from pg_proc where proname in ('create_purchase_batch_v3','create_confirmed_purchase_batch_v4',
      'create_confirmed_purchase_batch_v5') order by proname`);
  const before = await definitions();
  await db.exec(migrationBody());
  assert.deepEqual(await definitions(),before);
  const direct = input({cost_scope:undefined,track_inventory:true});
  await db.exec('set local role authenticated');
  const pending = (await one('select create_purchase_batch_v3($1,$2,$3,$4,$5,$6::jsonb) id',
    ['2026-10-15','OSA','51',null,null,JSON.stringify([direct])])).id;
  const purchase = (await one('select create_confirmed_purchase_batch_v4($1,$2,$3,$4,$5,$6::jsonb) id',
    ['2026-10-15','OSA','51',null,null,JSON.stringify([direct])])).id;
  const credit = (await one('select create_confirmed_purchase_batch_v5($1,$2,$3,$4,$5,$6,$7::jsonb) id',
    ['2026-10-15','OSA','51',null,null,'credit_note',JSON.stringify([direct])])).id;
  await db.exec('reset role');
  assert.equal((await one('select status from purchase_receipts where id=$1',[pending])).status,'expected');
  for (const [r,amount] of [[purchase,100],[credit,-100]]) {
    const saved = await one('select status,subtotal from purchase_receipts where id=$1',[r]);
    assert.equal(saved.status,'confirmed'); assert.equal(Number(saved.subtotal),amount);
    const l = (await one('select id from purchase_receipt_lines where receipt_id=$1',[r])).id;
    assert.deepEqual(classification(await scope(l)),['unassigned',null,'unassigned',true]);
  }
  assert.equal(await count('inventory_lots'),0);
});

test('authenticated internal staff can create v6 purchases and summaries through definer RPCs without base-table grants',async () => {
  await db.exec('set local role authenticated');
  const r = await batch([input({cost_scope:'importer',cost_importer_code:'01'})]);
  const result = await summary('2026-10-01','2026-10-31','OSA');
  assert.equal(bucket(result,'importer','01').amount,100);
  await rejectSql('select * from purchase_receipts',[],/permission denied/,'42501');
  await db.exec('reset role');
  assert.equal((await one('select status from purchase_receipts where id=$1',[r])).status,'confirmed');
});

test('optional snapshot extension includes links/manual scopes/audit, preserves authorization and is idempotent',async () => {
  const r = await batch([input()]);
  await db.exec(`create function public.create_business_snapshot(p_reason text) returns jsonb
    language plpgsql security definer set search_path=public,pg_temp as $$
    declare v_table text; v_data jsonb; v_result jsonb:='{}';
    begin
      if not public.is_internal_user() then raise exception 'snapshot internal only'; end if;
      foreach v_table in array array['purchase_receipts','purchase_receipt_lines','accounts_payable'] loop
        execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from public.%I t',v_table) into v_data;
        v_result:=v_result||jsonb_build_object(v_table,v_data);
      end loop;
      return v_result||jsonb_build_object('reason',p_reason);
    end;
    $$;
    revoke all on function public.create_business_snapshot(text) from public,anon;
    grant execute on function public.create_business_snapshot(text) to authenticated`);
  const permissions = () => one(`select prosecdef,proacl::text grants,proconfig
    from pg_proc where oid='create_business_snapshot(text)'::regprocedure`);
  const beforePermissions = await permissions(); const financial = await financialSnapshot();
  await db.exec(migrationBody()); await db.exec(migrationBody());
  assert.deepEqual(await permissions(),beforePermissions);
  assert.deepEqual(await financialSnapshot(),financial);
  const snapshot = (await one("select create_business_snapshot('scope-backup') result")).result;
  assert.equal(snapshot.reason,'scope-backup');
  assert.equal(snapshot.purchase_receipts[0].id,r);
  assert.equal(snapshot.purchase_receipt_lines.length,1);
  assert.equal(snapshot.purchase_line_cost_scopes.length,1);
  assert.equal(snapshot.purchase_cost_scope_log.length,1);
  assert.deepEqual(snapshot.purchase_sales_links,[]);
  const definition = (await one("select pg_get_functiondef('create_business_snapshot(text)'::regprocedure) definition")).definition;
  for (const table of ['purchase_sales_links','purchase_line_cost_scopes','purchase_cost_scope_log']) {
    assert.equal(definition.split(`'${table}'`).length-1,1,`${table} should be included exactly once`);
  }
  await db.exec(`select set_config('test.user_id','${EXTERNAL}',true); set local role authenticated`);
  await rejectSql("select create_business_snapshot('forbidden')",[],/snapshot internal only/);
});

test('anon has no RPC/table access; external authenticated users cannot read scopes or audit or invoke RPCs',async () => {
  const r = await batch([input()]); const l = (await one('select id from purchase_receipt_lines where receipt_id=$1',[r])).id;
  const functions = [
    ['get_purchase_line_cost_scopes(uuid[])','select * from get_purchase_line_cost_scopes($1::uuid[])',[`{${l}}`]],
    ['set_purchase_line_cost_scope(uuid,text,text)','select set_purchase_line_cost_scope($1,$2,$3)',[l,'domestic',null]],
    ['get_purchase_cost_scope_summary(date,date,text)','select * from get_purchase_cost_scope_summary(null,null,null)',[]],
    ['create_confirmed_purchase_batch_v6(date,text,text,text,text,text,jsonb)',createSql,batchParams([input()])]
  ];
  await db.exec('set local role anon');
  for (const [,sql,params] of functions) await rejectSql(sql,params,/permission denied/,'42501');
  for (const table of ['purchase_line_cost_scopes','purchase_cost_scope_log']) {
    await rejectSql(`select * from ${table}`,[],/permission denied/,'42501');
  }
  await db.exec(`reset role; select set_config('test.user_id','${EXTERNAL}',true); set local role authenticated`);
  assert.equal((await rows('select * from purchase_line_cost_scopes')).length,0);
  assert.equal((await rows('select * from purchase_cost_scope_log')).length,0);
  for (const [,sql,params] of functions) await rejectSql(sql,params,/Internal access is required/);
  await rejectSql('select resolve_purchase_cost_importer($1)',['01'],/permission denied/,'42501');
  await db.exec(`reset role; select set_config('test.user_id','',true); set local role authenticated`);
  await rejectSql('select * from get_purchase_line_cost_scopes($1::uuid[])',[`{${l}}`],/Internal access is required/);
  assert.equal((await rows('select * from purchase_line_cost_scopes')).length,0);
});

test('authenticated staff are read-only on metadata tables and cannot bypass auditing or update classification directly',async () => {
  const r = await batch([input()]); const l = (await one('select id from purchase_receipt_lines where receipt_id=$1',[r])).id;
  await db.exec('set local role authenticated');
  assert.equal((await rows('select * from purchase_line_cost_scopes')).length,1);
  assert.equal((await rows('select * from purchase_cost_scope_log')).length,1);
  for (const sql of [
    `insert into purchase_line_cost_scopes(purchase_line_id,scope) values('${l}','domestic')`,
    `update purchase_line_cost_scopes set scope='domestic' where purchase_line_id='${l}'`,
    `delete from purchase_line_cost_scopes where purchase_line_id='${l}'`,
    `insert into purchase_cost_scope_log(purchase_line_id,after_scope) values('${l}','{}')`,
    `update purchase_cost_scope_log set after_scope='{}'`,
    'delete from purchase_cost_scope_log',
    'truncate purchase_line_cost_scopes',
    'truncate purchase_cost_scope_log'
  ]) await rejectSql(sql,[],/permission denied/,'42501');
  await setScope(l,'domestic');
  assert.equal((await rows('select * from purchase_cost_scope_log')).length,2);
  await db.exec('reset role');
  const tables = await rows(`select relname,relrowsecurity from pg_class
    where oid in ('purchase_line_cost_scopes'::regclass,'purchase_cost_scope_log'::regclass)`);
  assert.ok(tables.every(row=>row.relrowsecurity));
  const policies = await rows(`select tablename,cmd from pg_policies
    where tablename in ('purchase_line_cost_scopes','purchase_cost_scope_log')`);
  assert.equal(policies.length,2); assert.ok(policies.every(row=>row.cmd==='SELECT'));
  const rpc = await rows(`select proname,prosecdef,proconfig from pg_proc
    where proname in ('get_purchase_line_cost_scopes','set_purchase_line_cost_scope',
      'get_purchase_cost_scope_summary','create_confirmed_purchase_batch_v6')`);
  assert.equal(rpc.length,4);
  assert.ok(rpc.every(row=>row.prosecdef && row.proconfig.includes('search_path=public, pg_temp')));
});
