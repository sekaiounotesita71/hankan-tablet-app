const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'accounts-receivable-closing-payment-migration.sql'),'utf8');
const base=fs.readFileSync(path.join(root,'accounts-receivable-migration.sql'),'utf8');
const html=fs.readFileSync(path.join(root,'order-entry-beta.html'),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const options={skip:!process.env.PGLITE_PATH};
const schema=`create role anon;create role authenticated;create schema auth;
create function auth.uid() returns uuid language sql as $$select '${id(99)}'::uuid$$;
create function is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.internal',true),'true')='true'$$;
create function is_master_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
create function canonical_importer_code(text) returns text language sql as $$select case when upper($1) in ('DIM','01') then '01' else upper($1) end$$;
create table accounts_receivable_settings(singleton boolean,operation_start_date date);
insert into accounts_receivable_settings values(true,'2026-08-01');
create table accounts_receivable_closings(id uuid primary key,importer_code text,status text,period_from date,period_to date,closed_at timestamptz,closing_balance_jpy numeric,snapshot jsonb);
create table accounts_receivable(id uuid primary key,importer_code text,source_type text,invoice_date date,amount_jpy numeric,created_at timestamptz,closing_id uuid);
create table accounts_receivable_payments(id uuid primary key default gen_random_uuid(),receivable_id uuid references accounts_receivable(id),payment_date date,amount_jpy numeric constraint accounts_receivable_payments_amount_jpy_check check(amount_jpy>0),bank_fee_jpy numeric default 0 check(bank_fee_jpy>=0),reference_no text,memo text,created_by uuid,updated_by uuid,closing_id uuid);
insert into accounts_receivable_closings values('${id(10)}','01','closed','2026-08-01','2026-08-31','2026-09-01',30000,'{"charges":[{"id":"${id(2)}"}]}');
insert into accounts_receivable values
 ('${id(1)}','DIM','opening','2026-07-31',10000,'2026-08-01',null),
 ('${id(2)}','01','sales','2026-08-15',20000,'2026-08-15','${id(10)}'),
 ('${id(3)}','01','sales','2026-09-02',5000,'2026-09-02',null),
 ('${id(4)}','02','sales','2026-08-03',9999,'2026-08-03',null),
 ('${id(5)}','01','sales','2026-07-01',99999,'2026-07-01',null),
 ('${id(6)}','01','manual','2026-08-10',7777,'2026-09-12',null);`;
async function database(){
  const {PGlite}=require(process.env.PGLITE_PATH);const db=new PGlite();await db.exec(schema);
  const start=base.indexOf('create or replace function public.protect_closed_receivable_payment()');
  const end=base.indexOf('alter table public.accounts_receivable enable row level security;',start);
  await db.exec(base.slice(start,end));await db.exec(sql);return db;
}
async function pay(db,overrides={}){
  const args={request:id(20),closing:id(10),receivable:null,date:'2026-09-15',cash:29780,fee:220,reference:'BANK',memo:'receipt',balance:30000,...overrides};
  return(await db.query('select record_receivable_grouped_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) result',Object.values(args))).rows[0].result;
}
async function payments(db){return(await db.query('select * from accounts_receivable_payments order by receivable_id')).rows}
function source(from,to){return html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)))}
function model(rows,pays,closings){
  const ctx={receivableRows:rows,receivablePayments:pays,receivableClosings:closings,
    salesReferenceImporterIndex:null,salesRefBuildImporterIndex:()=>({}),
    arNumber:v=>Number(v)||0,arRound:v=>Math.round(v*100)/100,today:()=> '2026-09-29',
    arSameImporter:(r,c)=>['DIM','01'].includes(r.importer_code||r)&&['DIM','01'].includes(c),
    arIsOperationRow:r=>r.source_type==='opening'||String(r.invoice_date).slice(0,10)>='2026-08-01'};
  vm.runInNewContext(source('function arSettlementFor(','function arIsOperationRow(')+source('function arClosingPaymentTargets(','function arRenderClosingPaymentTable('),ctx);return ctx;
}
async function state(db,closingId=id(10)){
  const rows=(await db.query('select * from accounts_receivable')).rows;
  const closings=(await db.query('select * from accounts_receivable_closings')).rows;
  for(const r of [...rows,...closings])for(const field of ['invoice_date','period_to','period_from'])if(r[field] instanceof Date)r[field]=r[field].toISOString().slice(0,10);
  const ps=await payments(db);for(const p of ps)if(p.payment_date instanceof Date)p.payment_date=p.payment_date.toISOString().slice(0,10);
  return model(rows,ps,closings).arClosingPaymentState(closings.find(c=>c.id===closingId));
}
test('export closing allocates carryover and invoices atomically; aliases, fees, double submit and UI balance agree',options,async()=>{
  const db=await database();try{
    assert.equal((await state(db)).balance,30000);
    const before=(await db.query('select * from accounts_receivable order by id')).rows;
    assert.equal((await pay(db)).payment_count,2);
    const ps=await payments(db);assert.deepEqual(ps.map(p=>[p.receivable_id,Number(p.amount_jpy),Number(p.bank_fee_jpy)]),[[id(1),10000,0],[id(2),19780,220]]);
    assert.equal((await state(db)).balance,0);assert.equal((await pay(db)).already_recorded,true);
    assert.equal((await payments(db)).length,2);
    await assert.rejects(()=>pay(db,{cash:1}),/同じ受付番号/);
    assert.deepEqual((await db.query('select * from accounts_receivable order by id')).rows,before);
  }finally{await db.close()}
});
test('partial and legacy payments count once, stale request rejected, negative credit limits collection',options,async()=>{
  const db=await database();try{
    await db.exec(`insert into accounts_receivable_payments(receivable_id,payment_date,amount_jpy,bank_fee_jpy) values('${id(1)}','2026-09-02',1000,220)`);
    assert.equal((await state(db)).balance,28780);
    await pay(db,{cash:12000,fee:0,balance:28780});
    assert.equal((await state(db)).balance,16780);
    await assert.rejects(()=>pay(db,{request:id(21),cash:12000,fee:0,balance:28780}),/残額が変わって/);
    await db.exec(`insert into accounts_receivable values('${id(7)}','01','adjustment','2026-08-15',-500,'2026-08-15','${id(10)}')`);
    assert.equal((await state(db)).balance,16280);
    await pay(db,{request:id(21),cash:16280,fee:0,balance:16280});
    assert.equal((await state(db)).balance,0);
  }finally{await db.close()}
});
test('fee-only final invoice, individual opening, old payments, repeat migration preserve amounts',options,async()=>{
  const db=await database();try{
    await pay(db,{cash:10000,fee:20000});
    assert.deepEqual((await payments(db)).map(p=>[Number(p.amount_jpy),Number(p.bank_fee_jpy)]),[[10000,0],[0,20000]]);
    const before=await payments(db);await db.exec(sql);assert.deepEqual(await payments(db),before);
    await pay(db,{request:id(21),closing:null,receivable:id(3),cash:5000,fee:0,balance:5000});
    assert.equal((await payments(db)).length,3);
  }finally{await db.close()}
});
test('invalid, forbidden, reopened, overpaid and backdated requests never write',options,async()=>{
  const db=await database();try{
    for(const bad of [{closing:id(90)},{cash:-1},{fee:-1},{cash:'NaN'},{cash:null},{cash:0,fee:0},{cash:30001,fee:0},{cash:1.001},{date:null},{date:'2026-08-31'},{receivable:id(1)},{request:null},{balance:null}])await assert.rejects(()=>pay(db,bad));
    await db.exec("select set_config('test.internal','false',false)");await assert.rejects(()=>pay(db),/社内権限/);
    await db.exec("select set_config('test.internal','true',false);update accounts_receivable_closings set status='reopened'");await assert.rejects(()=>pay(db),/請求締め/);
    assert.equal((await payments(db)).length,0);
  }finally{await db.close()}
});
test('failure in a later allocation rolls back every insert; cancellation is whole-group and admin-only',options,async()=>{
  const db=await database();try{
    await db.exec(`create function fail_second() returns trigger language plpgsql as $$begin if new.receivable_id='${id(2)}' then raise exception 'second failed';end if;return new;end$$;create trigger fail_second before insert on accounts_receivable_payments for each row execute function fail_second()`);
    await assert.rejects(()=>pay(db),/second failed/);assert.equal((await payments(db)).length,0);
    await db.exec('drop trigger fail_second on accounts_receivable_payments');await pay(db);
    await db.exec("select set_config('test.admin','false',false)");await assert.rejects(()=>db.query('select delete_receivable_payment_group($1)',[id(20)]),/管理者/);
    await db.exec("select set_config('test.admin','true',false)");
    await db.query('select delete_receivable_payment_group($1)',[id(20)]);
    assert.equal((await payments(db)).length,0);assert.equal((await state(db)).balance,30000);
  }finally{await db.close()}
});
test('later closed period prevents edits/cancellation; overlapping carryover cannot be collected twice',options,async()=>{
  const db=await database();try{
    await pay(db,{cash:10000,fee:0});
    await db.exec(`insert into accounts_receivable_closings values('${id(11)}','DIM','closed','2026-09-01','2026-09-30','2026-10-01',25000,'{}');update accounts_receivable_payments set closing_id='${id(11)}'`);
    await assert.rejects(()=>pay(db,{request:id(21),cash:20000,fee:0,balance:20000}),/締め済み/);
    await assert.rejects(()=>db.query('select delete_receivable_payment_group($1)',[id(20)]),/締め済み/);
    assert.equal((await payments(db)).length,1);
    await pay(db,{request:id(21),cash:20000,fee:0,balance:20000,date:'2026-10-15'});
    assert.equal((await state(db)).balance,0);
    // The later closing also includes the backdated manual invoice; its cap stays at the billed amount.
    assert.equal((await state(db,id(11))).balance,5000);
    await assert.rejects(()=>pay(db,{request:id(22),cash:1,fee:0,balance:0,date:'2026-10-15'}),/未回収額/);
  }finally{await db.close()}
});
test('UI provides closing-level entry and retry persistence, detail links route to closing; no direct insert remains',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  assert.match(html,/data-ar-view="payments"/);
  assert.match(source('function renderClosingHistory(','function arClosingSnapshotPayload('),/selectReceivableClosingForPayment/);
  assert.match(source('function selectReceivableForPayment(','function clearReceivablePaymentForm('),/return selectReceivableClosingForPayment/);
  const save=source('async function saveReceivablePayment(','async function deleteReceivablePayment(');
  assert.match(save,/if\(receivablePaymentSaving\)return/);
  assert.ok(save.indexOf('receivablePaymentSaving=true')<save.indexOf('await ensureCurrentUser'));
  assert.match(save,/rpc\("record_receivable_grouped_payment",receivablePaymentAttempt\)/);
  assert.match(save,/sessionStorage.setItem/);assert.doesNotMatch(save,/\.insert\(/);
  assert.match(html,/function restoreReceivablePaymentAttempt/);
  assert.match(sql,/for update/);assert.match(sql,/pg_advisory_xact_lock/);
});
test('UI rejects double clicks before authentication resolves and resends the same request after an uncertain result',async()=>{
  const fields=new Map(Object.entries({'ar-payment-closing-id':id(10),'ar-payment-receivable-id':'','ar-payment-date':'2026-09-15','ar-payment-amount':'29780','ar-payment-fee':'220','ar-payment-reference':'BANK','ar-payment-memo':''}).map(([key,value])=>[key,{value}]));
  const element=id=>{if(!fields.has(id))fields.set(id,{value:''});return fields.get(id)};
  let releaseAuth,calls=[],outcome={error:{message:'network failed'}},saved=new Map(),alerts=[];
  const context={receivablePaymentAttempt:null,receivablePaymentSaving:false,receivablesLoaded:true,currentUser:{id:id(99)},
    document:{getElementById:element},val:id=>element(id).value,arNumber:v=>Number(v)||0,arRound:v=>Math.round(v*100)/100,
    arSelectedPaymentBalance:()=>30000,renderReceivablePaymentTotal:()=>{},setAppBusy:()=>{},salesRefMoney:String,
    arDbErrorMessage:e=>e.message,crypto:{randomUUID:()=>id(20)},alert:s=>alerts.push(s),
    sessionStorage:{setItem:(k,v)=>saved.set(k,v),getItem:k=>saved.get(k),removeItem:k=>saved.delete(k)},
    ensureCurrentUser:()=>new Promise(resolve=>{releaseAuth=resolve}),initSupabase:()=>({rpc:async(name,args)=>{calls.push(JSON.parse(JSON.stringify(args)));return outcome}}),
    loadReceivables:async()=>{},renderReceivablePaymentHistory:()=>{}};
  vm.runInNewContext(source('function arPaymentAttemptKey(','function restoreReceivablePaymentAttempt(')+source('async function saveReceivablePayment(','async function deleteReceivablePayment('),context);
  const first=context.saveReceivablePayment();await context.saveReceivablePayment();assert.equal(calls.length,0);
  releaseAuth(context.currentUser);await first;
  assert.equal(calls.length,1);assert.equal(context.receivablePaymentAttempt.p_request_id,id(20));assert.equal(saved.size,1);
  assert.equal(element('ar-payment-amount').readOnly,true);
  context.ensureCurrentUser=async()=>context.currentUser;outcome={data:{already_recorded:true},error:null};
  await context.saveReceivablePayment();assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
  assert.equal(context.receivablePaymentAttempt,null);assert.equal(saved.size,0);assert.equal(context.receivablePaymentSaving,false);
  assert.equal(element('ar-payment-amount').readOnly,false);assert.equal(element('ar-payment-amount').value,'');
});
test('one importer index is reused for every invoice in the closing',()=>{
  const rows=Array.from({length:3000},(_,i)=>({id:id(i+100),importer_code:'01',source_type:'sales',invoice_date:'2026-08-15',amount_jpy:10,created_at:'2026-08-15'}));
  const closing={id:id(10),importer_code:'01',period_to:'2026-08-31',closed_at:'2026-09-01',closing_balance_jpy:30000};
  const ctx=model(rows,[],[closing]);let builds=0;ctx.salesRefBuildImporterIndex=()=>{builds++;return {}};
  assert.equal(ctx.arClosingPaymentState(closing).balance,30000);assert.equal(builds,1);
});
