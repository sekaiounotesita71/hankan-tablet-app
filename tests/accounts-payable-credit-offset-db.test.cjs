const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=n=>fs.readFileSync(path.join(root,n),'utf8');
let db;
const admin='00000000-0000-4000-8000-000000000001';
const staff='00000000-0000-4000-8000-000000000002';
const external='00000000-0000-4000-8000-000000000003';
async function user(id=admin){await db.exec(`reset role; select set_config('test.user','${id}',false); set role authenticated;`)}
before(async()=>{
  db=new PGlite();
  await db.exec(`create role authenticated;create role anon;create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${admin}'),('${staff}'),('${external}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
    create function public.is_internal_user() returns boolean language sql stable as $$ select auth.uid() in ('${admin}'::uuid,'${staff}'::uuid) $$;
    create function public.is_master_admin() returns boolean language sql stable as $$ select auth.uid()='${admin}'::uuid $$;
    grant usage on schema public,auth to authenticated,anon;
    create table public.supplier_master(supplier_code text primary key,supplier_name text);
    create table public.purchase_receipts(id uuid primary key);
    grant select on public.supplier_master to authenticated;
  `);
  for(const f of ['accounts-payable-migration.sql','accounts-payable-closing-migration.sql','accounts-payable-closing-payment-migration.sql','accounts-payable-credit-offset-migration.sql']){
    await db.exec(read(f).replace('create extension if not exists pgcrypto;',''));
  }
  // Applying twice must preserve schema and existing data.
  await db.exec(read('accounts-payable-credit-offset-migration.sql'));
});
after(async()=>db?.close());
async function fixture(amounts,code=randomUUID()){
  await db.exec('reset role');
  await db.query('insert into supplier_master values($1,$1)',[code]);
  const ids=[];
  for(const [i,amount] of amounts.entries()){
    const id=randomUUID();ids.push(id);
    await db.query(`insert into accounts_payable(id,supplier_code,invoice_no,invoice_date,amount_jpy,subtotal_jpy,tax_amount_jpy)
      values($1,$2,$3,'2026-09-24',$4,$4,0)`,[id,code,'test-'+i,amount]);
  }
  await user();
  const total=amounts.reduce((s,n)=>s+n,0);
  const {rows}=await db.query(`select * from close_accounts_payable_period($1,'2026-09-01','2026-09-30','2026-10-31',0,$2,0,$2,'{}')`,[code,total]);
  return {code,ids,closing:rows[0].id};
}
async function pay(f,amount,req=randomUUID(),date='2026-10-23',fee=0){
  const {rows}=await db.query(`select register_accounts_payable_net_payment($1,$2,$3,$4,null,null,$5) result`,[f.closing,date,amount,fee,req]);
  return rows[0].result;
}
async function balances(f){
  return (await db.query(`select p.id,p.amount_jpy::float8 amount,
    coalesce(sum(m.amount_jpy),0)::float8 cash,coalesce(sum(m.credit_offset_jpy),0)::float8 as "offset",
    (p.amount_jpy-coalesce(sum(m.amount_jpy+m.credit_offset_jpy),0))::float8 balance
    from accounts_payable p left join accounts_payable_payments m on m.payable_id=p.id
    where p.supplier_code=$1 group by p.id order by p.id`,[f.code])).rows;
}
test('takakuwa: full cash payment 876123 plus credit 2754 settles all nine invoices',async()=>{
  const amounts=[167299,95252,143830,133430,123944,154486,20109,40527,-2754];
  const f=await fixture(amounts,'16');
  const before=await balances(f);
  await assert.rejects(pay(f,878877),/相殺後/);
  const req=randomUUID(),r=await pay(f,876123,req,'2026-10-23',330);
  assert.equal(r.allocated_amount_jpy,876123);assert.equal(r.credit_offset_jpy,2754);
  assert.equal(r.remaining_balance_jpy,0);
  const b=await balances(f);
  assert.ok(b.every(x=>x.balance===0));
  assert.equal(b.reduce((s,x)=>s+x.cash,0),876123);
  assert.equal(b.reduce((s,x)=>s+x.offset,0),0);
  assert.deepEqual(b.map(x=>x.amount),before.map(x=>x.amount));
  assert.equal((await db.query('select sum(bank_fee_jpy)::float8 n from accounts_payable_payments where payment_group_id=$1',[req])).rows[0].n,330);
  assert.deepEqual(await pay(f,876123,req,'2026-10-23',330),r);
  assert.deepEqual(await balances(f),b);
  await assert.rejects(pay(f,876122,req),/異なる支払/);
  await assert.rejects(pay(f,1),/相殺後/);
  await db.query('select cancel_accounts_payable_payment_group($1)',[req]);
  assert.deepEqual(await balances(f),before);
  await db.query('select cancel_accounts_payable_payment_group($1)',[req]);
  await assert.rejects(pay(f,876123,req,'2026-10-23',330),/取消済み/);
});
test('partial cash payment consumes credit once, second payment settles only remaining cash',async()=>{
  const f=await fixture([600,400,-200]);
  const a=await pay(f,300);
  assert.equal(a.credit_offset_jpy,200);
  assert.equal(a.remaining_balance_jpy,500);
  const b=await pay(f,500);
  assert.equal(b.credit_offset_jpy,0);
  assert.ok((await balances(f)).every(x=>x.balance===0));
  await db.query('select cancel_accounts_payable_payment_group($1)',[a.payment_group_id]);
  assert.equal((await balances(f)).reduce((s,x)=>s+x.balance,0),300);
});
test('offset-only, excess credit carry and pure credit do not invent cash',async()=>{
  const f=await fixture([100,-160]);
  const r=await pay(f,0);
  assert.equal(r.credit_offset_jpy,100);assert.equal(r.remaining_balance_jpy,-60);
  assert.equal((await balances(f)).reduce((s,x)=>s+x.cash,0),0);
  await assert.rejects(pay(f,0),/対象の残高/);
  const pure=await fixture([-50]);
  await assert.rejects(pay(pure,0),/対象の残高/);
  const zero=await fixture([100,-100]);
  await pay(zero,0);assert.ok((await balances(zero)).every(x=>x.balance===0));
});
test('no credits, multiple suppliers, later invoices, carry and legacy client',async()=>{
  const f=await fixture([200,-50]);const other=await fixture([-1000]);
  await db.exec('reset role');
  await db.query(`insert into accounts_payable(supplier_code,invoice_date,amount_jpy) values($1,'2026-10-01',-999)`,[f.code]);
  await user();
  const r=(await db.query(`select register_accounts_payable_closing_payment($1,'2026-10-23',150) r`,[f.closing])).rows[0].r;
  assert.equal(r.credit_offset_jpy,50);
  assert.equal((await balances(other))[0].balance,-1000);
  const normal=await fixture([400,600]);assert.equal((await pay(normal,1000)).credit_offset_jpy,0);
  const carry=await fixture([600,-50]);
  await db.exec('reset role');
  await db.query(`insert into accounts_payable(supplier_code,invoice_date,amount_jpy) values($1,'2026-08-31',-25)`,[carry.code]);
  await user();assert.equal((await pay(carry,525)).credit_offset_jpy,75);
});
test('authorization, direct tampering and adjustment of offset invoices are blocked',async()=>{
  const f=await fixture([1000,-200]);const r=await pay(f,300);
  const group=r.payment_group_id;
  await assert.rejects(db.query('delete from accounts_payable_payments where payment_group_id=$1',[group]),/締め単位/);
  await assert.rejects(db.query('update accounts_payable_payments set amount_jpy=2 where payment_group_id=$1 and amount_jpy>0',[group]),/専用/);
  await assert.rejects(db.query(`insert into accounts_payable_payments(payable_id,payment_date,amount_jpy,credit_offset_jpy,payment_group_id,target_closing_id)
    values($1,'2026-10-23',0,1,$2,$3)`,[f.ids[0],randomUUID(),f.closing]),/専用/);
  await user(external);await assert.rejects(pay(f,100),/ログイン/);
  assert.equal((await db.query('select * from accounts_payable_settlements')).rows.length,0);
  await user(staff);await assert.rejects(db.query('select cancel_accounts_payable_payment_group($1)',[group]),/管理者/);
  await user();
  await db.query(`select reopen_accounts_payable_period($1,'test')`,[f.closing]);
  await assert.rejects(db.query('update accounts_payable set amount_jpy=999 where id=$1',[f.ids[1]]),/相殺済み/);
  await assert.rejects(db.query('delete from accounts_payable where id=$1',[f.ids[1]]),/相殺済み/);
});
test('subsequent closing locks all cash/offset rows; reopen allows atomic reversal',async()=>{
  const f=await fixture([1000,-200]);const r=await pay(f,800);
  const next=(await db.query(`select * from close_accounts_payable_period($1,'2026-10-01','2026-10-31','2026-11-30',800,0,800,0,'{}')`,[f.code])).rows[0];
  await assert.rejects(db.query('select cancel_accounts_payable_payment_group($1)',[r.payment_group_id]),/締め/);
  await db.query(`select reopen_accounts_payable_period($1,'test')`,[next.id]);
  await db.query('select cancel_accounts_payable_payment_group($1)',[r.payment_group_id]);
  assert.equal((await balances(f)).reduce((s,x)=>s+x.balance,0),800);
});
test('invalid dates/fees, backdating, exact decimal amounts and overpayment credit',async()=>{
  const f=await fixture([100,-20]);
  await assert.rejects(pay(f,80,randomUUID(),'2026-09-30'),/翌日/);
  await assert.rejects(pay(f,0,randomUUID(),'2026-10-23',5),/手数料/);
  await pay(f,20);
  await assert.rejects(pay(f,20,randomUUID(),'2026-10-22'),/後日の支払/);
  const decimal=await fixture([10.25,-0.13]);
  assert.equal((await pay(decimal,10.12)).remaining_balance_jpy,0);
  const over=await fixture([100,500]);
  await db.query(`insert into accounts_payable_payments(payable_id,payment_date,amount_jpy) values($1,'2026-10-01',150)`,[over.ids[0]]);
  assert.equal((await pay(over,450)).credit_offset_jpy,50);
  assert.ok((await balances(over)).every(x=>x.balance===0));
});
test('mid-allocation failure rolls back journal, cash and both sides of the offset',async()=>{
  const f=await fixture([1000,-200]);const request=randomUUID();const before=await balances(f);
  await db.exec(`reset role;
    create function public.test_fail_offset() returns trigger language plpgsql as $$ begin
      if new.credit_offset_jpy>0 then raise exception 'test allocation failure'; end if; return new; end $$;
    create trigger z_test_fail before insert on accounts_payable_payments for each row execute function test_fail_offset();`);
  await user();await assert.rejects(pay(f,800,request),/test allocation failure/);
  assert.deepEqual(await balances(f),before);
  assert.equal((await db.query('select * from accounts_payable_settlements where id=$1',[request])).rows.length,0);
  await db.exec('reset role; drop trigger z_test_fail on accounts_payable_payments; drop function test_fail_offset();');
  await user();await pay(f,800,request);assert.ok((await balances(f)).every(x=>x.balance===0));
});
