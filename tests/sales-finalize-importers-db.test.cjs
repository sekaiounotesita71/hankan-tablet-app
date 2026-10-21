const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const session='00000000-0000-0000-0000-000000000001';
const base=fs.readFileSync(path.join(__dirname,'sales-refinalize-importers.test.cjs'),'utf8').match(/const schema=`([\s\S]*?)`;/)[1].split('insert into importer_master')[0];
const migration=fs.readFileSync(path.join(root,'sales-finalize-importers-migration.sql'),'utf8');
async function database(){
 const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');const db=new PGlite();
 await db.exec(base);
 await db.exec(`
 alter table work_sessions add provisional_locked boolean default false;
 alter table importer_master add is_active boolean default true, add revenue_route text default 'direct_export', add domestic_customer_code text;
 alter table product_master add is_active boolean default true;
 create table domestic_customer_master(customer_code text primary key,customer_name text,active boolean,closing_day integer,payment_month_offset integer,payment_day integer);
 create function domestic_receivable_due_date(date,integer,integer,integer) returns date language sql as $$select $1+30$$;
 create sequence domestic_sale_no_seq;
 alter table domestic_sales add customer_name_snapshot text,add memo text,add confirmed_by uuid,add confirmed_at timestamptz,add source_type text,add source_key text unique;
 alter table domestic_receivables add source_key text unique,add source_type text,add customer_code text,add customer_name_snapshot text,add invoice_date date,add due_date date,add memo text,add created_by uuid;
 insert into importer_master(importer_code,importer_name,revenue_route,domestic_customer_code) values('01','DIM','direct_export',null),('03','FBI','direct_export',null),('08','EN','domestic_intermediary','D1');
 insert into domestic_customer_master values('D1','国内請求先',true,31,1,31);
 insert into accounts_receivable_settings values(true,'2026-08-01');
 insert into product_master values('P1',true),('P3',true),('P8',true);
 insert into work_sessions(id,name,work_date,site_code) values('${session}','輸入社別確定テスト','2026-10-22','TYO');
 insert into order_lines(session_id,source_row_no,importer_id,importer_code,store_name,product_id,product_name,input_qty,input_unit,net_weight,box_no,unit_price) values
 ('${session}',1,'01','01','得意先A','P1','商品A',1.25,'Kg',1.25,'MAR-1',10),
 ('${session}',2,'03','03','得意先B','P3','商品B',3,'Kg',3,'MAR-1',100),
 ('${session}',3,'08','08','得意先C','P8','商品C',4,'Kg',4,'MAR-1',100);
 insert into boxes(session_id,importer_code,box_no,gross_weight) values('${session}','01','MAR-1',5),('${session}','03','MAR-1',6),('${session}','08','MAR-1',7);
 `);
 await db.exec(fs.readFileSync(path.join(root,'sales-refinalize-importers-migration.sql'),'utf8'));
 await db.exec(migration);return db;
}
async function preview(db){return (await db.query('select work_importer_finalization_preview($1) as r',[session])).rows[0].r}
async function finalize(db,codes=['01'],fees={'01':100},version,allow=false){return (await db.query('select finalize_work_session_importers($1,$2,$3,$4,$5) as r',[session,codes,fees,version??(await preview(db)).version,allow])).rows[0].r}
async function state(db){return (await db.query(`select jsonb_build_object('work',(select jsonb_agg(to_jsonb(w) order by id) from work_sessions w),'sales',(select jsonb_agg(to_jsonb(s) order by id) from sales_records s),'ar',(select jsonb_agg(to_jsonb(r) order by id) from accounts_receivable r),'ds',(select jsonb_agg(to_jsonb(d) order by id) from domestic_sales d),'dr',(select jsonb_agg(to_jsonb(d) order by id) from domestic_receivables d),'dl',(select jsonb_agg(to_jsonb(d) order by id) from domestic_sale_lines d)) as r`)).rows[0].r}

test('initial finalization isolates importers, fees and box weights, and closes only after all importers',{timeout:60000},async()=>{
 const db=await database();try{
  let p=await preview(db);assert.equal(p.groups.length,3);assert.ok(p.groups.every(g=>!g.finalized));
  const first=await finalize(db);assert.equal(first.session.locked,false);assert.equal(first.session.finalized_at,null);assert.deepEqual(first.pending_importers,['03','08']);
  let saved=await state(db);assert.equal(saved.sales.length,1);assert.equal(saved.sales[0].amount,13);assert.equal(saved.sales[0].gross_weight,5);assert.equal(saved.ar[0].amount_jpy,113);assert.equal(saved.ds,null);
  const firstSale=saved.sales[0],firstAR=saved.ar[0];
  p=await preview(db);assert.equal(p.groups.find(g=>g.importer_code==='01').finalized,true);
  await assert.rejects(()=>finalize(db),/確定済み/);assert.deepEqual(await state(db),saved);
  await finalize(db,['08'],{'08':10});saved=await state(db);assert.equal(saved.ds.length,1);assert.equal(saved.dr.length,1);assert.equal(saved.dr[0].amount_jpy,443);assert.equal(saved.ar.length,1);
  assert.equal(saved.sales.find(s=>s.importer_code==='08').revenue_recognition_mode,'customs_only');assert.deepEqual(saved.sales.find(s=>s.importer_code==='01'),firstSale);assert.deepEqual(saved.ar[0],firstAR);
  const third=await finalize(db,['03'],{'03':20});assert.equal(third.session.locked,true);assert.ok(third.session.finalized_at);assert.deepEqual(third.pending_importers,[]);assert.equal(third.session.shipping_fee,130);
  saved=await state(db);assert.equal(saved.sales.length,3);assert.equal(saved.ar.length,2);assert.equal(saved.ds.length,1);assert.deepEqual(saved.sales.find(s=>s.importer_code==='01'),firstSale);
  await assert.rejects(()=>finalize(db,['03'],{'03':20}),/確定済み/);assert.deepEqual(await state(db),saved);
 }finally{await db.close()}
});
test('stale source, invalid scope and incomplete work cannot create partial financial writes',{timeout:60000},async()=>{
 const db=await database();try{
  const p=await preview(db);await db.exec('update order_lines set unit_price=15 where source_row_no=1');let before=await state(db);
  await assert.rejects(()=>finalize(db,['01'],{'01':10},p.version),/更新され/);assert.deepEqual(await state(db),before);
  for(const [codes,fees] of [[[],{}],[['99'],{'99':0}],[['01'],{'03':1}],[['01'],{'01':-1}],[['01'],{'01':1.5}],[['01'],{}]]){
   await assert.rejects(()=>finalize(db,codes,fees));assert.deepEqual(await state(db),before);
  }
  await db.exec("update order_lines set input_qty=null where source_row_no=2;select set_config('test.admin','false',false)");
  await assert.rejects(()=>finalize(db,['03'],{'03':0},undefined,true),/管理者/);
  await finalize(db,['01'],{'01':10});
  await assert.rejects(()=>db.exec("update order_lines set unit_price=999 where source_row_no=1"),/確定済み/);
  await assert.rejects(()=>db.exec("update boxes set gross_weight=99 where importer_code='01'"),/確定済み/);
  await db.exec('update order_lines set input_qty=3 where source_row_no=2');
  before=await state(db);await assert.rejects(()=>db.exec("update work_sessions set finalized_importer_codes='{}'"),/確定状態/);assert.deepEqual(await state(db),before);
  await db.exec("select set_config('test.internal','false',false)");await assert.rejects(()=>preview(db),/社内/);
 }finally{await db.close()}
});
test('domestic route failure rolls back other selected importers and preserves earlier finalized importer',{timeout:60000},async()=>{
 const db=await database();try{
  await finalize(db,['03'],{'03':20});await db.exec("update domestic_customer_master set active=false");const before=await state(db);
  await assert.rejects(()=>finalize(db,['01','08'],{'01':10,'08':0}),/国内請求先/);assert.deepEqual(await state(db),before);
  await db.exec("update domestic_customer_master set active=true");await finalize(db,['01','08'],{'01':10,'08':0});
  await db.exec("update work_sessions set locked=false,status='active',unlock_reason='訂正' where id='${session}'".replace('${session}',session));
  const p=await db.query('select work_refinalization_preview($1) as r',[session]);assert.ok(p.rows[0].r.session.finalized_at);assert.deepEqual(p.rows[0].r.session.finalized_importer_codes,[]);
  await db.exec('update order_lines set unit_price=90 where source_row_no=2');
  const v=(await db.query('select work_refinalization_preview($1) as r',[session])).rows[0].r.version;
  const result=(await db.query('select refinalize_work_session_importers($1,$2,$3,$4) as r',[session,['03'],{'03':20},v])).rows[0].r;assert.equal(result.session.locked,true);
 }finally{await db.close()}
});
test('migration reruns safely and authenticated admin autosaves cannot change finalized importers',{timeout:60000},async()=>{
 const db=await database();try{
  await finalize(db);const before=await state(db);
  await db.exec(migration);assert.deepEqual(await state(db),before);
  await db.exec("grant usage on schema public to authenticated;grant select,insert,update,delete on all tables in schema public to authenticated;set role authenticated");
  await assert.rejects(()=>db.exec("update order_lines set input_qty=100 where source_row_no=1"),/確定済み/);
  await assert.rejects(()=>db.exec("delete from boxes where importer_code='01'"),/確定済み/);
  await assert.rejects(()=>db.exec("update order_lines set importer_code='01' where source_row_no=2"),/確定済み/);
  await assert.rejects(()=>db.exec("update sales_records set amount=1"),/確定済み/);
  await db.exec("update order_lines set input_qty=5 where source_row_no=2;reset role");
  assert.deepEqual((await state(db)).sales,before.sales);
  await assert.rejects(()=>db.exec("insert into order_lines(session_id,source_row_no,importer_code) values('"+session+"',4,'01')"),/確定済み/);
 }finally{await db.close()}
});

test('zero-value stockouts close only the selected importer without creating a receivable',{timeout:60000},async()=>{
 const db=await database();try{
  await db.exec("update order_lines set is_stockout=true,input_qty=null,net_weight=null,box_no=null where source_row_no=1");
  const result=await finalize(db,['01'],{'01':0});
  assert.deepEqual(result.session.finalized_importer_codes,['01']);
  assert.deepEqual(result.pending_importers,['03','08']);
  const saved=await state(db);assert.equal(saved.ar,null);assert.equal(saved.sales.length,1);assert.equal(saved.sales[0].amount,null);
 }finally{await db.close()}
});

test('private route helper is not callable by application roles',()=>{
 assert.match(migration,/revoke all on function public.finalize_export_revenue_route_scoped\([^;]+from public,anon,authenticated/);
 assert.doesNotMatch(migration,/update public.work_sessions set finalized_importer_codes[^;]+where finalized_at/is);
});
