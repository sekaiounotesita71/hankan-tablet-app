const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const test=require('node:test');
const root=path.join(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'work-additional-order-migration.sql'),'utf8');
const work=fs.readFileSync(path.join(root,'work-additional-orders.js'),'utf8');
const app=fs.readFileSync(path.join(root,'order-entry-beta.html'),'utf8');
const session='11111111-1111-4111-8111-111111111111';
const customer='22222222-2222-4222-8222-222222222222';
const request='33333333-3333-4333-8333-333333333333';
const order={importer_code:'01',customer_id:customer,customer_name:'Store',product_code:'P1',product_name:'Fish',supplier_code:'02',order_qty:2,order_unit:'Kg',unit_price:1500,origin:'Osaka',memo:'extra'};
const schema=`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid$$;
create function is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.internal',true),'true')='true'$$;
create function is_master_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
create table work_sessions(id uuid primary key,work_date date,site_code text,locked boolean default false,provisional_locked boolean default false,status text default 'active');
create table sales_records(id uuid primary key default gen_random_uuid(),session_id uuid,amount numeric);
create table supplier_master(supplier_code text primary key,supplier_name text,is_active boolean default true);
create table importer_master(importer_code text primary key,importer_name text,is_active boolean default true);
create table customer_master(id uuid primary key,customer_code text,customer_name text,importer_code text,site_code text,active boolean default true);
create table order_entry_batches(id uuid primary key,order_date date,ship_date date,site_code text,importer_code text,importer_name_snapshot text,customer_code text,customer_name_snapshot text,status text,source_type text,note text,confirmed_at timestamptz);
create table order_entry_lines(id uuid primary key,batch_id uuid references order_entry_batches(id),line_no integer,product_code text,product_name_snapshot text,english_name_snapshot text,order_qty numeric(12,3),order_unit text,supplier_code text,supplier_name_snapshot text,purchase_note text,unit_price numeric,source_text text);
create table order_lines(id uuid primary key default gen_random_uuid(),session_id uuid references work_sessions(id),source_row_no integer,source_order_line_id uuid references order_entry_lines(id),country_code text,importer_id text,importer_code text,store_name text,product_id text,product_name text,ordered_qty numeric,ordered_unit text,unit_price numeric,english_name text,scientific_name text,origin text,input_qty numeric,input_unit text,net_weight numeric,box_no text,memo text,is_stockout boolean default false,updated_by uuid,updated_at timestamptz default now(),unique(session_id,source_row_no),unique(session_id,source_order_line_id));
create function update_order_supplier_review(p_line_ids uuid[],p_supplier_code text,p_confirm boolean) returns integer language plpgsql as $$begin update order_entry_lines set supplier_code=p_supplier_code where id=any(p_line_ids);return 1;end$$;
insert into work_sessions(id,work_date,site_code) values('${session}','2026-09-18','OSA');
insert into importer_master values('01','FBI',true),('03','DIM',true);
insert into supplier_master values('02','Supplier',true),('03','Inactive',false);
insert into customer_master values('${customer}','0101','Store','01','OSA',true);
insert into order_lines(session_id,source_row_no,importer_id,importer_code,store_name,product_id,product_name,ordered_qty,ordered_unit,input_qty,input_unit,unit_price,net_weight,box_no,origin,memo) values('${session}',4,'01','01','Store','P2','Legacy',5,'PC',5,'PC',1234.5,10,'2','Tokyo','Keep');
`;
async function database(){const {PGlite}=require(process.env.PGLITE_PATH);const db=new PGlite();await db.exec(schema);await db.exec(sql);return db}
async function save(db,data=order,id=request,existing=null){return (await db.query('select save_work_additional_order($1,$2,$3::jsonb,$4) result',[session,id,JSON.stringify(data),existing])).rows[0].result}
async function counts(db){return (await db.query('select (select count(*) from order_entry_batches)::int batches,(select count(*) from order_entry_lines)::int sources,(select count(*) from order_lines)::int works')).rows[0]}
const dbOptions={skip:!process.env.PGLITE_PATH};

test('atomic addition connects supplier to source and work, and retries are idempotent',dbOptions,async()=>{
  const db=await database();try{
    const row=await save(db);assert.equal(row.source_row_no,5);assert.equal(row.source_order_line_id,request);assert.equal(row.unit_price,1500);
    const retry=await save(db);assert.equal(retry.id,row.id);assert.deepEqual(await counts(db),{batches:1,sources:1,works:2});
    assert.equal((await db.query('select s.supplier_code from order_lines w join order_entry_lines s on s.id=w.source_order_line_id where w.id=$1',[row.id])).rows[0].supplier_code,'02');
    await assert.rejects(()=>save(db,{...order,supplier_code:'01'}));
    await assert.rejects(()=>save(db,{...order,order_qty:3}),/重複/);
    const second=await save(db,{...order,product_code:''},'44444444-4444-4444-8444-444444444444');
    assert.equal(second.source_row_no,6);assert.equal(second.product_id,'ADD-44444444444444448444444444444444');
  }finally{await db.close()}
});
test('invalid supplier, quantity, customer site and importer never create partial records',dbOptions,async()=>{
  const db=await database();try{
    for(const bad of [{supplier_code:''},{supplier_code:'03'},{order_qty:0},{order_qty:-1},{order_qty:1.2345},{order_qty:'NaN'},{unit_price:'Infinity'},{product_name:''},{order_unit:''},{unit_price:-1},{importer_code:'03'},{customer_id:'55555555-5555-4555-8555-555555555555'}]){
      await assert.rejects(()=>save(db,{...order,...bad}));assert.deepEqual(await counts(db),{batches:0,sources:0,works:1});
    }
    await db.exec("update customer_master set site_code='TYO'");await assert.rejects(()=>save(db),/拠点/);
  }finally{await db.close()}
});
test('a late work insert failure rolls back the order batch and order line',dbOptions,async()=>{
  const db=await database();try{
    await db.exec("create function fail_work() returns trigger language plpgsql as $$begin raise exception 'late failure';end$$;create trigger fail_work before insert on order_lines for each row execute function fail_work()");
    await assert.rejects(()=>save(db),/late failure/);assert.deepEqual(await counts(db),{batches:0,sources:0,works:1});
  }finally{await db.close()}
});
test('external users and locked sessions cannot add; administrator status does not bypass the addition lock',dbOptions,async()=>{
  const db=await database();try{
    await db.exec("select set_config('test.internal','false',false)");await assert.rejects(()=>save(db),/社内/);
    await db.exec("select set_config('test.internal','true',false);select set_config('test.admin','true',false);update work_sessions set provisional_locked=true");
    await assert.rejects(()=>save(db),/仮締め/);
    await db.exec("update work_sessions set provisional_locked=false;select set_config('test.admin','false',false);insert into sales_records(session_id,amount) values('"+session+"',100)");await assert.rejects(()=>save(db),/売上確定/);
    assert.deepEqual(await counts(db),{batches:0,sources:0,works:1});
  }finally{await db.close()}
});
test('a successful request can be verified after a later lock without making another order',dbOptions,async()=>{
  const db=await database();try{
    const row=await save(db);
    await db.exec("update work_sessions set locked=true;update supplier_master set is_active=false");
    assert.equal((await save(db)).id,row.id);assert.deepEqual(await counts(db),{batches:1,sources:1,works:2});
  }finally{await db.close()}
});
test('explicit supplier repair preserves every financial and work input field',dbOptions,async()=>{
  const db=await database();try{
    const before=(await db.query('select to_jsonb(w) row from order_lines w')).rows[0].row;
    await db.exec("update work_sessions set locked=true;insert into sales_records(session_id,amount) values('"+session+"',6173)");
    const data={supplier_code:'02',expected_id:before.id,expected_updated_at:before.updated_at};
    await assert.rejects(()=>save(db,data,request,4),/管理者/);
    await db.exec("select set_config('test.admin','true',false)");
    await assert.rejects(()=>save(db,{...data,expected_updated_at:'2000-01-01'},request,4),/更新/);
    const after=await save(db,data,request,4);
    for(const key of Object.keys(before).filter(k=>!['source_order_line_id','updated_by'].includes(k)))assert.deepEqual(after[key],before[key],key);
    assert.equal(after.source_order_line_id,request);assert.equal((await save(db,data,request,4)).id,before.id);
    assert.equal(Number((await db.query('select amount from sales_records')).rows[0].amount),6173);
    assert.deepEqual(await counts(db),{batches:1,sources:1,works:1});
  }finally{await db.close()}
});
test('repair of an already-linked missing supplier does not duplicate order or work lines',dbOptions,async()=>{
  const db=await database();try{
    const row=await save(db);
    await db.exec("update order_entry_lines set supplier_code=null");
    const data={supplier_code:'02',expected_id:row.id,expected_updated_at:row.updated_at};
    const repairId='44444444-4444-4444-8444-444444444444';
    assert.equal((await save(db,data,repairId,5)).id,row.id);
    assert.equal((await save(db,data,repairId,5)).id,row.id);
    assert.deepEqual(await counts(db),{batches:1,sources:1,works:2});
    assert.equal((await db.query('select supplier_code from order_entry_lines')).rows[0].supplier_code,'02');
  }finally{await db.close()}
});
test('UI validates and keeps retry IDs, and purchase import never silently guesses a supplier',()=>{
  new vm.Script(work);new vm.Script(fs.readFileSync(path.join(root,'purchase-source-review.js'),'utf8'));
  assert.match(work,/workAdditionalBusy\|\|\(!workAdditionalAttempt&&!requireEditableTrial\(\)\)/);
  assert.match(work,/sessionStorage\.setItem\(workAdditionalStorageKey/);
  assert.match(work,/source_order_line_id!==attempt\.requestId/);
  assert.match(work,/upsertRemoteOrderLine\(data\)/);
  assert.doesNotMatch(work,/\.from\("order_lines"\)\.upsert/);
  assert.match(app,/const effectiveSupplierCode=lineOrderSupplierCode;/);
  assert.match(app,/await reviewUnassignedPurchaseSources\(unassigned,orderSupplierBySale\)/);
  assert.match(sql,/security invoker/);
  assert.match(sql,/revoke all on function[\s\S]*from public,anon/);
  for(const file of ['index.html','order-entry-beta.html']){
    const html=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){if(match[1].trim())new vm.Script(match[1])}
  }
});
