const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'domestic-closing-payment-migration.sql'),'utf8');
const html=fs.readFileSync(path.join(root,'domestic-sales.html'),'utf8');
const model=require('../domestic-payment-model.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const schema=`
create role anon;create role authenticated;create schema auth;
create function auth.uid() returns uuid language sql as $$select '${id(99)}'::uuid$$;
create function is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.internal',true),'true')='true'$$;
create table domestic_billing_closings(id uuid primary key,customer_code text,status text,period_from date,period_to date,closed_at timestamptz,billing_amount_jpy numeric,snapshot jsonb);
create table domestic_receivables(id uuid primary key,customer_code text,status text,invoice_date date,amount_jpy numeric,paid_amount_jpy numeric default 0,balance_jpy numeric,created_at timestamptz,updated_by uuid);
create table domestic_receivable_payments(id uuid primary key default gen_random_uuid(),receivable_id uuid references domestic_receivables(id),payment_date date,amount_jpy numeric check(amount_jpy>0),bank_fee_jpy numeric default 0,reference_no text,memo text,created_by uuid);
insert into domestic_receivables values
 ('${id(1)}','A','unpaid','2026-08-03',10000,0,10000,'2026-08-03',null),
 ('${id(2)}','A','unpaid','2026-08-15',20000,0,20000,'2026-08-15',null),
 ('${id(3)}','A','unpaid','2026-09-02',5000,0,5000,'2026-09-02',null),
 ('${id(4)}','B','unpaid','2026-08-03',9999,0,9999,'2026-08-03',null);
insert into domestic_billing_closings values('${id(10)}','A','closed','2026-08-01','2026-08-31','2026-09-01',30000,'{"charges":[{"id":"${id(1)}"},{"id":"${id(2)}"}]}');
`;
const options={skip:!process.env.PGLITE_PATH};
async function database(){const {PGlite}=require(process.env.PGLITE_PATH);const db=new PGlite();await db.exec(schema);await db.exec(sql);return db}
async function pay(db,overrides={}){
  const args={request:id(20),closing:id(10),receivable:null,date:'2026-09-15',cash:29780,fee:220,reference:'BANK',memo:'receipt',balance:30000,...overrides};
  return(await db.query('select record_domestic_grouped_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) result',Object.values(args))).rows[0].result;
}
async function records(db){return(await db.query('select * from domestic_receivables order by id')).rows}

test('closing payment atomically settles multiple invoices, fee counted once, one history group, retry idempotent',options,async()=>{
  const db=await database();try{
    const result=await pay(db);assert.equal(result.payment_count,2);assert.equal(result.allocated_amount_jpy,30000);
    const rows=await records(db);assert.equal(Number(rows[0].balance_jpy),0);assert.equal(Number(rows[1].balance_jpy),0);
    assert.equal(Number(rows[2].balance_jpy),5000);assert.equal(Number(rows[3].balance_jpy),9999);
    const payments=(await db.query('select * from domestic_receivable_payments')).rows;
    assert.equal(payments.length,2);assert.deepEqual(model.groupedHistory(payments).map(x=>[x.cash,x.fee,x.settled,x.count]),[[29780,220,30000,2]]);
    assert.equal((await pay(db)).already_recorded,true);
    assert.equal((await db.query('select count(*)::int n from domestic_receivable_payments')).rows[0].n,2);
    await assert.rejects(()=>pay(db,{cash:20000}),/同じ受付番号/);
    const closing=(await db.query('select * from domestic_billing_closings')).rows[0];assert.equal(model.closingState(closing,rows,payments).balance,0);
  }finally{await db.close()}
});
test('partial receipts remain partial and stale duplicate submissions cannot settle twice',options,async()=>{
  const db=await database();try{
    await pay(db,{cash:12000,fee:0});
    assert.deepEqual((await records(db)).slice(0,2).map(r=>[r.status,Number(r.balance_jpy)]),[['paid',0],['partial',18000]]);
    await assert.rejects(()=>pay(db,{request:id(21),cash:12000,fee:0}),/残額が変わって/);
    await pay(db,{request:id(21),cash:18000,fee:0,balance:18000});
    assert.equal(Number((await records(db))[1].balance_jpy),0);
  }finally{await db.close()}
});
test('unknown, reopened, unauthorized, invalid, overpaid and closed-period receipts make no changes',options,async()=>{
  const db=await database();try{
    for(const bad of [{closing:id(90)},{cash:-1},{fee:-1},{cash:'NaN'},{cash:0,fee:0},{cash:30001,fee:0},{cash:1.001},{date:null},{date:'2026-08-31'},{receivable:id(1)},{request:null},{balance:null}])await assert.rejects(()=>pay(db,bad));
    await db.exec("select set_config('test.internal','false',false)");await assert.rejects(()=>pay(db),/社内権限/);
    await db.exec("select set_config('test.internal','true',false);update domestic_billing_closings set status='reopened'");await assert.rejects(()=>pay(db),/請求締め/);
    assert.equal((await db.query('select count(*)::int n from domestic_receivable_payments')).rows[0].n,0);
  }finally{await db.close()}
});
test('late allocation failure rolls back every payment and balance update',options,async()=>{
  const db=await database();try{
    await db.exec(`create function fail_second() returns trigger language plpgsql as $$begin if new.receivable_id='${id(2)}' then raise exception 'second failed';end if;return new;end$$;create trigger fail_second before insert on domestic_receivable_payments for each row execute function fail_second()`);
    await assert.rejects(()=>pay(db),/second failed/);
    assert.equal((await db.query('select count(*)::int n from domestic_receivable_payments')).rows[0].n,0);
    assert.deepEqual((await records(db)).slice(0,2).map(r=>Number(r.balance_jpy)),[10000,20000]);
  }finally{await db.close()}
});
test('closing scope excludes later-dated, cancelled and backdated-after-close records; billed cap is respected',options,async()=>{
  const db=await database();try{
    await db.exec(`insert into domestic_receivables values('${id(5)}','A','unpaid','2026-08-01',9000,0,9000,'2026-09-12',null),('${id(6)}','A','cancelled','2026-08-01',9000,0,9000,'2026-08-01',null)`);
    await pay(db);
    assert.equal(Number((await records(db)).find(row=>row.id===id(5)).balance_jpy),9000);
    const closing=(await db.query('select * from domestic_billing_closings')).rows[0];
    assert.equal(model.targets(closing,await records(db)).length,2);
  }finally{await db.close()}
});
test('legacy payments and their historical fee treatment are unchanged; pre-existing individual payments reduce closing remaining',options,async()=>{
  const db=await database();try{
    await db.exec(`insert into domestic_receivable_payments(receivable_id,payment_date,amount_jpy,bank_fee_jpy) values('${id(1)}','2026-09-03',1000,220);update domestic_receivables set paid_amount_jpy=1000,balance_jpy=9000,status='partial' where id='${id(1)}'`);
    await db.exec(sql);
    const old=(await db.query('select * from domestic_receivable_payments')).rows[0];assert.equal(old.cash_amount_jpy,null);
    assert.equal(model.groupedHistory([old])[0].settled,1000);
    await pay(db,{cash:29000,fee:0,balance:29000});
    assert.equal(Number((await records(db))[0].balance_jpy),0);
  }finally{await db.close()}
});
test('two closing cycles share carried balance without allowing duplicate collection; later closing freezes payment dates',options,async()=>{
  const db=await database();try{
    await db.exec(`update domestic_billing_closings set period_to='2026-08-15',closed_at='2026-08-16';insert into domestic_billing_closings values('${id(11)}','A','closed','2026-08-16','2026-08-31','2026-09-01',30000,'{}')`);
    await assert.rejects(()=>pay(db,{date:'2026-08-20'}),/締め済み/);
    await pay(db,{closing:id(11)});
    await assert.rejects(()=>pay(db,{request:id(21)}),/残額/);
    assert.equal(model.latestClosings((await db.query('select * from domestic_billing_closings')).rows).length,1);
  }finally{await db.close()}
});
test('fee-only allocation and individual unclosed invoice work through the same atomic API',options,async()=>{
  const db=await database();try{
    await pay(db,{cash:29900,fee:0});
    await pay(db,{request:id(21),cash:0,fee:100,balance:100});
    await pay(db,{request:id(22),closing:null,receivable:id(3),cash:5000,fee:0,balance:5000});
    assert.equal(Number((await records(db))[2].balance_jpy),0);
  }finally{await db.close()}
});
test('UI starts with closing-level receipts, links closing history, paginates all records, uses retry-safe API',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  assert.match(html,/<option value="closing">請求締め別/);
  assert.match(html,/selectDomesticClosingForPayment/);
  assert.match(html,/rpc\("record_domestic_grouped_payment",domesticPaymentAttempt\)/);
  assert.match(html,/sessionStorage\.setItem\(domesticPaymentAttemptKey/);
  assert.doesNotMatch(html,/domestic_billing_closings[^\n]*\.limit\(300\)/);
  for(const table of ['domestic_receivables','domestic_receivable_payments','domestic_billing_closings'])assert.match(html,new RegExp('fetchPaged\\(\\(\\)=>supabaseClient\\.from\\("'+table+'"\\)[^\\n]*\\.order\\("id"\\)'));
  assert.match(html,/DomesticPayments\.latestClosings/);
  assert.match(sql,/for update/);assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/from public,anon/);
  assert.doesNotMatch(sql,/\bdelete from\b|\btruncate\b/i);
});
