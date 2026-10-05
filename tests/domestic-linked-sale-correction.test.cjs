const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'domestic-sales.html'),'utf8');
const sql=fs.readFileSync(path.join(root,'domestic-linked-sale-correction-migration.sql'),'utf8');
const base=fs.readFileSync(path.join(root,'domestic-sales-migration.sql'),'utf8').replace('create extension if not exists pgcrypto;','');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const dbOptions={skip:!process.env.PGLITE_PATH};
async function database(){
  const {PGlite}=require(process.env.PGLITE_PATH);const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key);insert into auth.users values('${id(99)}');
    create function auth.uid() returns uuid language sql as $$select '${id(99)}'::uuid$$;
    create function is_internal_user() returns boolean language sql as $$select true$$;
    create function is_master_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
    create table product_master(product_id text primary key,product_name text,is_active boolean default true);
    insert into product_master values('P1','Product one',true),('P2','Product two',true);`);
  await db.exec(base);
  await db.exec(`
    create table work_sessions(id uuid primary key,data jsonb);insert into work_sessions values('${id(50)}','{"locked":true,"qty":2}');
    alter table domestic_sales add source_type text default 'manual',add source_session_id uuid references work_sessions(id),add source_importer_code text,add source_key text unique;
    create table sales_records(id uuid primary key,domestic_sale_id uuid references domestic_sales(id),revenue_recognition_mode text,data jsonb);
    alter table domestic_sale_lines add source_sales_record_id uuid references sales_records(id);
    create unique index uq_source on domestic_sale_lines(source_sales_record_id) where source_sales_record_id is not null;
    create table domestic_billing_closings(id uuid primary key default gen_random_uuid(),customer_code text,status text,period_from date,period_to date);
    insert into domestic_customer_master(customer_code,customer_name) values('A','Customer A'),('B','Customer B');
    insert into domestic_sales(id,sale_no,sale_date,customer_code,customer_name_snapshot,product_subtotal_8_jpy,total_net_jpy,tax_8_jpy,tax_total_jpy,total_amount_jpy,source_type,source_session_id,source_importer_code,source_key)
      values('${id(1)}','DOM-TEST','2026-08-10','A','Customer A',2000,2000,160,160,2160,'export_intermediary','${id(50)}','08','export-intermediary:test:08');
    insert into sales_records values('${id(10)}','${id(1)}','customs_only','{"qty":2,"price":1000,"amount":2000}');
    insert into domestic_sale_lines(id,sale_id,line_no,product_code,product_name_snapshot,quantity,unit,unit_price_jpy,tax_rate,net_amount_jpy,source_sales_record_id)
      values('${id(2)}','${id(1)}',1,'P1','Product one',2,'Kg',1000,8,2000,'${id(10)}');
    insert into domestic_receivables(id,source_key,source_type,sale_id,customer_code,customer_name_snapshot,invoice_date,due_date,amount_jpy,balance_jpy)
      values('${id(3)}','sale:test','sale','${id(1)}','A','Customer A','2026-08-10','2026-09-30',2160,2160);
  `);
  await db.exec(sql);return db;
}
const line=(changes={})=>({original_line_id:id(2),product_code:'P1',product_name:'Product one',quantity:2,unit:'Kg',unit_price:1200,tax_rate:8,memo:'domestic only',...changes});
async function correct(db,changes={}){
  const args={sale:id(1),date:'2026-08-10',customer:'A',shipping:100,memo:'test',lines:[line()],reason:'test correction',...changes};
  return(await db.query('select correct_domestic_sale($1,$2,$3,$4,$5,$6,$7) result',Object.values(args))).rows[0].result;
}
async function cancel(db){await db.query('select cancel_domestic_sale($1,$2)',[id(1),'test cancellation']);}
async function rows(db,table){return(await db.query(`select * from ${table} order by id`)).rows;}
async function snapshot(db){const result={};for(const name of ['domestic_sales','domestic_sale_lines','domestic_receivables','sales_records','work_sessions'])result[name]=await rows(db,name);return result;}

test('linked correction updates domestic sale and receivable atomically without changing export or work records',dbOptions,async()=>{
  const db=await database();try{
    const before=await snapshot(db);const result=await correct(db);
    assert.equal(Number(result.total_amount_jpy),2702);
    const after=await snapshot(db);
    assert.equal(Number(after.domestic_receivables[0].balance_jpy),2702);
    assert.equal(after.domestic_sale_lines[0].id,id(2));
    assert.equal(after.domestic_sale_lines[0].source_sales_record_id,id(10));
    assert.equal(after.domestic_sales[0].source_key,before.domestic_sales[0].source_key);
    assert.equal(after.domestic_sales[0].source_type,'export_intermediary');
    assert.equal(after.domestic_sales[0].correction_reason,'test correction');
    assert.deepEqual(after.sales_records,before.sales_records);assert.deepEqual(after.work_sessions,before.work_sessions);
  }finally{await db.close()}
});
test('line deletion and duplication affect domestic detail only; a duplicate does not inherit the export source',dbOptions,async()=>{
  const db=await database();try{
    const before=await snapshot(db);
    await correct(db,{lines:[line(),line({original_line_id:null,product_code:'P2',product_name:'Duplicate'})]});
    let detail=await rows(db,'domestic_sale_lines');assert.equal(detail.length,2);
    assert.equal(detail.filter(r=>r.source_sales_record_id).length,1);
    const added=detail.find(r=>r.id!==id(2));
    await correct(db,{lines:[line({original_line_id:added.id,product_code:'P2',product_name:'Duplicate'})]});
    detail=await rows(db,'domestic_sale_lines');assert.equal(detail.length,1);assert.equal(detail[0].source_sales_record_id,null);
    assert.deepEqual(await rows(db,'sales_records'),before.sales_records);assert.deepEqual(await rows(db,'work_sessions'),before.work_sessions);
  }finally{await db.close()}
});
test('linked cancellation keeps history and export customs exclusion while clearing only domestic receivable',dbOptions,async()=>{
  const db=await database();try{
    const before=await snapshot(db);await cancel(db);await cancel(db);const after=await snapshot(db);
    assert.equal(after.domestic_sales[0].status,'cancelled');assert.equal(after.domestic_receivables[0].status,'cancelled');
    assert.equal(Number(after.domestic_receivables[0].balance_jpy),0);assert.equal(Number(after.domestic_sales[0].total_amount_jpy),2160);
    assert.deepEqual(after.domestic_sale_lines,before.domestic_sale_lines);
    assert.deepEqual(after.sales_records,before.sales_records);assert.deepEqual(after.work_sessions,before.work_sessions);
    await assert.rejects(()=>correct(db),/取消済み/);
  }finally{await db.close()}
});
test('non-admin cannot correct or cancel; anonymous function permissions stay revoked',dbOptions,async()=>{
  const db=await database();try{
    const before=await snapshot(db);await db.exec("select set_config('test.admin','false',false)");
    await assert.rejects(()=>correct(db),/Administrator/);await assert.rejects(()=>cancel(db),/Administrator/);
    assert.deepEqual(await snapshot(db),before);
    const grants=(await db.query("select has_function_privilege('anon','correct_domestic_sale(uuid,date,text,numeric,text,jsonb,text)','execute') c,has_function_privilege('anon','cancel_domestic_sale(uuid,text)','execute') d")).rows[0];
    assert.equal(grants.c,false);assert.equal(grants.d,false);
  }finally{await db.close()}
});
test('paid and closed sales reject both changes, including amounts carried into a later closed period',dbOptions,async()=>{
  const db=await database();try{
    await db.exec("update domestic_receivables set paid_amount_jpy=1,balance_jpy=2159");
    await assert.rejects(()=>correct(db),/入金/);await assert.rejects(()=>cancel(db),/入金/);
    await db.exec("update domestic_receivables set paid_amount_jpy=0,balance_jpy=2160;insert into domestic_billing_closings(customer_code,status,period_from,period_to) values('A','closed','2026-09-01','2026-09-30')");
    const before=await snapshot(db);await assert.rejects(()=>correct(db),/請求締め済み/);await assert.rejects(()=>cancel(db),/請求締め済み/);
    assert.deepEqual(await snapshot(db),before);
    await db.exec("update domestic_billing_closings set status='reopened'");await correct(db);
  }finally{await db.close()}
});
test('changing date or customer updates domestic receivable but cannot enter another closed period',dbOptions,async()=>{
  const db=await database();try{
    await db.exec("insert into domestic_billing_closings(customer_code,status,period_from,period_to) values('B','closed','2026-08-01','2026-08-31')");
    await assert.rejects(()=>correct(db,{customer:'B'}),/変更後/);
    await correct(db,{customer:'B',date:'2026-09-01'});
    const receivable=(await rows(db,'domestic_receivables'))[0];assert.equal(receivable.customer_code,'B');assert.equal(new Date(receivable.invoice_date).toISOString().slice(0,10),'2026-09-01');
    assert.equal((await rows(db,'sales_records'))[0].revenue_recognition_mode,'customs_only');
  }finally{await db.close()}
});
test('invalid and duplicate line identities and late validation failures roll back all rows',dbOptions,async()=>{
  const db=await database();try{
    const before=await snapshot(db);
    for(const lines of [[line({original_line_id:id(88)})],[line(),line()],[line(),line({original_line_id:null,quantity:0})],[line({product_code:'UNKNOWN'})],[],null]){
      await assert.rejects(()=>correct(db,{lines}));assert.deepEqual(await snapshot(db),before);
    }
  }finally{await db.close()}
});
test('manual correction remains compatible and applying migration alone does not change data',dbOptions,async()=>{
  const db=await database();try{
    const before=await snapshot(db);await db.exec(sql);assert.deepEqual(await snapshot(db),before);
    await db.exec("update domestic_sales set source_type='manual';update domestic_sale_lines set source_sales_record_id=null");
    await correct(db,{lines:[line({original_line_id:null})]});assert.equal((await rows(db,'domestic_sales'))[0].source_type,'manual');
  }finally{await db.close()}
});

function sourceBetween(start,end){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));}
function render(admin,status='confirmed',source='export_intermediary'){
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  const c={salesRows:[{id:id(1),status,source_type:source,sale_no:'DOM-TEST',lines:[]}],expandedSales:new Set(),isAdmin:()=>admin,money:x=>String(Number(x)||0),esc:x=>String(x??''),document:{getElementById:get}};
  vm.createContext(c);vm.runInContext(sourceBetween('function renderSalesReference()','function toggleSaleDetail'),c);c.renderSalesReference();return get('sales-body').innerHTML;
}
test('admin sees correction and cancellation for both manual and export-linked rows, not cancelled rows or staff',()=>{
  for(const type of ['manual','export_intermediary']){
    assert.match(render(true,'confirmed',type),/>訂正</);assert.match(render(true,'confirmed',type),/>削除（取消）</);
    assert.doesNotMatch(render(false,'confirmed',type),/openDomesticSaleCorrection|cancelSale/);
    assert.doesNotMatch(render(true,'cancelled',type),/openDomesticSaleCorrection|cancelSale/);
  }
  assert.match(html,/\.sales-table \.sale-actions\{position:sticky;right:0/);
});
test('UI keeps provenance for original rows, clears it on duplication, and explicitly limits cancellation scope',()=>{
  assert.match(html,/originalLineId:line.id/);assert.match(html,/original_line_id:line.originalLineId\|\|null/);
  assert.match(html,/source\?\{\.\.\.source,id:newId\(\),originalLineId:null\}/);
  const open=sourceBetween('function openDomesticSaleCorrection','function closeDomesticSaleCorrection');
  assert.doesNotMatch(open,/export_intermediary"\)return/);assert.match(open,/国内売上・国内売掛のみ/);
  const cancel=sourceBetween('async function cancelSale','function invalidateDomesticReceivables');
  assert.match(cancel,/if\(appBusy\)return/);assert.match(cancel,/if\(!isAdmin\(\)\)/);assert.match(cancel,/履歴は残ります/);assert.match(cancel,/輸出作業・通関用/);
  assert.match(cancel,/invalidateDomesticReceivables\(\)/);
  assert.match(sourceBetween('async function saveDomesticSaleCorrection','async function cancelSale'),/invalidateDomesticReceivables\(\)/);
});
test('all domestic lines are paginated before editing, preserving deterministic ordering',()=>{
  assert.match(sourceBetween('async function loadSalesReference','function renderSalesReference'),/fetchPaged\(\(\)=>supabaseClient.from\("domestic_sale_lines"\).*order\("line_no"\).order\("id"\)/);
  assert.doesNotMatch(sql,/(?:update|delete from|insert into) public\.(?:sales_records|work_sessions|order_lines|accounts_receivable)\b/i);
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
});
