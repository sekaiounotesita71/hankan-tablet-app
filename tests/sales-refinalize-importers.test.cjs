const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.join(__dirname,".."),sql=fs.readFileSync(path.join(root,"sales-refinalize-importers-migration.sql"),"utf8"),app=fs.readFileSync(path.join(root,"index.html"),"utf8"),ui=fs.readFileSync(path.join(root,"sales-refinalize.js"),"utf8");
const session="00000000-0000-0000-0000-000000000001",domestic="00000000-0000-0000-0000-000000000008";

test("reopened work routes to importer selection before any legacy sale writes",()=>{
  const final=app.slice(app.indexOf("finalizeSalesTrial=async function(){"),app.indexOf("function sessionListStatusLabelTrial"));
  assert.ok(final.indexOf("openSalesRefinalization()")<final.indexOf("upsertSalesRecordsTrial("));
  assert.match(final,/if\(currentSessionFinalizedAt\)return await openSalesRefinalization\(\)/);
  assert.doesNotMatch(final,/\.delete\(/);
  const upsert=app.slice(app.indexOf("async function upsertSalesRecordsTrial("),app.indexOf("function finalizedReceivablePayloads("));
  assert.doesNotMatch(upsert,/\.delete\(/);
  assert.match(ui,/p_expected_version:data.version/);
  assert.match(ui,/if\(!event.target.closest\("\[data-submit\]"\)\|\|busy\)return/);
  assert.match(ui,/\.\.\.orderLineSaveQueues.values\(\),\.\.\.boxSaveInFlight/);
  new vm.Script(ui);
  [...app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m=>m[1].trim()).forEach(m=>new vm.Script(m[1]));
});

test("refinalization SQL is administrator-only, atomic, versioned and does not delete export sales",()=>{
  assert.match(sql,/not public.is_internal_user\(\) or not public.is_master_admin\(\)/);
  assert.match(sql,/p_expected_version<>before_state->>'version'/);
  assert.match(sql,/from public.work_sessions where id=p_session_id for update/);
  assert.doesNotMatch(sql,/delete from public.sales_records/i);
  assert.doesNotMatch(sql,/insert into public.domestic_sales\(/i);
  assert.match(sql,/revoke all on function public.work_refinalization_source\(uuid\) from public,anon,authenticated/);
});

const schema=`
create role anon;create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$select '11111111-1111-1111-1111-111111111111'::uuid$$;
create function public.is_master_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
create function public.is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.internal',true),'true')='true'$$;
create function public.domestic_sale_has_closed_billing(text,date) returns boolean language sql as $$select coalesce(current_setting('test.closed',true),'false')='true'$$;
create table work_sessions(id uuid primary key,name text,work_date date,site_code text,locked boolean default false,status text default 'active',finalized_at timestamptz,finalized_by uuid,shipping_fee numeric default 0,shipping_fees jsonb default '{}',unlock_reason text);
create table importer_master(importer_code text primary key,importer_name text);
create function public.canonical_importer_code(v text) returns text language sql stable as $$select coalesce((select importer_code from importer_master where importer_code=v or importer_name=v order by importer_code limit 1),v)$$;
create table order_lines(id uuid primary key default gen_random_uuid(),session_id uuid references work_sessions,source_row_no int,country_code text,importer_id text,importer_code text,store_name text,product_id text,product_name text,english_name text,scientific_name text,origin text,ordered_qty numeric,ordered_unit text,input_qty numeric,input_unit text,net_weight numeric,box_no text,unit_price numeric,memo text,is_stockout boolean default false,unique(session_id,source_row_no));
create table boxes(id uuid primary key default gen_random_uuid(),session_id uuid,importer_code text,box_no text,gross_weight numeric,dry_ice_enabled boolean,dry_ice_weight numeric,box_size text);
create table sales_records(id uuid primary key default gen_random_uuid(),session_id uuid references work_sessions,source_row_no int,work_date date,finalized_at timestamptz,finalized_by uuid,country_code text,importer_id text,importer_code text,store_name text,product_id text,product_name text,english_name text,scientific_name text,origin text,ordered_qty numeric,ordered_unit text,input_qty numeric,input_unit text,net_weight numeric,box_no text,gross_weight numeric,dry_ice_enabled boolean,dry_ice_weight numeric,box_size text,unit_price numeric,amount numeric,memo text,is_stockout boolean default false,site_code text,revenue_recognition_mode text default 'direct_export',domestic_sale_id uuid,unique(session_id,source_row_no));
create table accounts_receivable_settings(singleton boolean,operation_start_date date);
create table accounts_receivable(id uuid primary key default gen_random_uuid(),source_key text unique,source_type text,source_session_id uuid,importer_code text,importer_name text,customer_name text,customer_names jsonb,invoice_no text,invoice_date date,currency text,net_sales_jpy numeric,shipping_amount_jpy numeric,amount_jpy numeric,created_by uuid,updated_by uuid,closing_id uuid);
create table accounts_receivable_payments(id uuid primary key default gen_random_uuid(),receivable_id uuid references accounts_receivable);
create table product_master(product_id text primary key);
create table domestic_sales(id uuid primary key,sale_no text,sale_date date,customer_code text,status text,source_session_id uuid,source_importer_code text,product_subtotal_8_jpy numeric,product_subtotal_10_jpy numeric,shipping_amount_jpy numeric,total_net_jpy numeric,tax_8_jpy numeric,tax_10_jpy numeric,tax_total_jpy numeric,total_amount_jpy numeric,corrected_at timestamptz,corrected_by uuid,correction_reason text);
create table domestic_receivables(id uuid primary key default gen_random_uuid(),sale_id uuid references domestic_sales,status text,paid_amount_jpy numeric default 0,amount_jpy numeric,balance_jpy numeric,updated_by uuid);
create table domestic_receivable_payments(id uuid primary key default gen_random_uuid(),receivable_id uuid references domestic_receivables);
create table domestic_sale_lines(id uuid primary key default gen_random_uuid(),sale_id uuid references domestic_sales,line_no integer,product_code text references product_master,product_name_snapshot text,quantity numeric check(quantity>0),unit text,unit_price_jpy numeric check(unit_price_jpy>=0),tax_rate integer,net_amount_jpy numeric,memo text,source_sales_record_id uuid references sales_records,unique(sale_id,line_no),unique(source_sales_record_id));
create table sales_correction_log(id uuid primary key default gen_random_uuid(),action_type text,session_id uuid,importer_code text,old_values jsonb,new_values jsonb,reason text,changed_by uuid);
insert into importer_master values('01','FBI'),('03','DIM'),('08','国内経由');
insert into accounts_receivable_settings values(true,'2026-08-01');
insert into product_master values('P1'),('P3'),('P8');
insert into work_sessions(id,name,work_date,site_code,finalized_at,shipping_fee,shipping_fees,unlock_reason) values('${session}','確認用大阪','2026-09-10','OSA','2026-09-10T00:00:00Z',100,'{"01":100,"03":0,"08":0}','金額修正');
insert into order_lines(session_id,source_row_no,importer_id,importer_code,store_name,product_id,product_name,input_qty,input_unit,net_weight,box_no,unit_price) values
('${session}',1,'01','01','店舗A','P1','商品A',2,'Kg',2,'1',100),
('${session}',2,'03','03','店舗B','P3','商品B',3,'Kg',3,'1',100),
('${session}',3,'08','08','店舗C','P8','商品C',4,'Kg',4,'1',100);
insert into domestic_sales(id,sale_no,sale_date,customer_code,status,source_session_id,source_importer_code,product_subtotal_8_jpy,product_subtotal_10_jpy,shipping_amount_jpy,total_net_jpy,tax_8_jpy,tax_10_jpy,tax_total_jpy,total_amount_jpy) values('${domestic}','DOM-EXISTING','2026-09-10','D1','confirmed','${session}','08',400,0,0,400,32,0,32,432);
insert into domestic_receivables(sale_id,status,amount_jpy,balance_jpy) values('${domestic}','unpaid',432,432);
insert into accounts_receivable(source_key,source_type,source_session_id,importer_code,net_sales_jpy,shipping_amount_jpy,amount_jpy,invoice_date,invoice_no) values
('sales:${session}:01','sales','${session}','01',200,100,300,'2026-09-10','20260910001'),
('sales:${session}:03','sales','${session}','03',300,0,300,'2026-09-10','20260910003');
`;
async function database(){
  const {PGlite}=require(process.env.PGLITE_PATH||"@electric-sql/pglite");
  const db=new PGlite();await db.exec(schema);await db.exec(sql);
  await db.exec(`insert into sales_records select (jsonb_populate_record(null::sales_records,payload||jsonb_build_object('id',gen_random_uuid(),'finalized_at','2026-09-10T00:00:00Z','revenue_recognition_mode',case when importer_code='08' then 'customs_only' else 'direct_export' end,'domestic_sale_id',case when importer_code='08' then '${domestic}' else null end))).* from work_refinalization_source('${session}');insert into domestic_sale_lines(sale_id,line_no,product_code,product_name_snapshot,quantity,unit,unit_price_jpy,tax_rate,net_amount_jpy,source_sales_record_id) select '${domestic}',1,product_id,product_name,input_qty,input_unit,unit_price,8,amount,id from sales_records where importer_code='08';`);
  return db;
}
async function preview(db){return (await db.query("select work_refinalization_preview($1) as result",[session])).rows[0].result}
async function finalize(db,codes=["01"],fees={"01":100},version){const v=version??(await preview(db)).version;return (await db.query("select refinalize_work_session_importers($1,$2,$3::jsonb,$4) as result",[session,codes,JSON.stringify(fees),v])).rows[0].result}
async function state(db){return (await db.query(`select jsonb_build_object('sessions',(select jsonb_agg(to_jsonb(x) order by id) from work_sessions x),'sales',(select jsonb_agg(to_jsonb(x) order by id) from sales_records x),'ar',(select jsonb_agg(to_jsonb(x) order by id) from accounts_receivable x),'domestic',(select jsonb_agg(to_jsonb(x) order by id) from domestic_sales x),'dl',(select jsonb_agg(to_jsonb(x) order by id) from domestic_sale_lines x),'dr',(select jsonb_agg(to_jsonb(x) order by id) from domestic_receivables x),'logs',(select jsonb_agg(to_jsonb(x) order by id) from sales_correction_log x)) as result`)).rows[0].result}

test("PostgreSQL re-finalization preserves other importers and existing linked invoices",{skip:!process.env.SALES_REFINALIZE_DB},async()=>{
  const db=await database();try{
    assert.ok((await preview(db)).groups.every(g=>!g.changed));
    const before=await state(db);
    await db.exec("update order_lines set unit_price=90 where source_row_no=1");
    const p=await preview(db);assert.deepEqual(p.groups.filter(g=>g.changed).map(g=>g.importer_code),["01"]);
    const result=await finalize(db);assert.equal(result.session.locked,true);assert.deepEqual(result.pending_importers,[]);
    const after=await state(db);
    assert.equal(after.sales.length,3);assert.equal(after.sales.find(s=>s.importer_code==="01").id,before.sales.find(s=>s.importer_code==="01").id);
    assert.equal(after.ar.find(r=>r.importer_code==="01").amount_jpy,280);
    assert.equal(after.ar.find(r=>r.importer_code==="01").id,before.ar.find(r=>r.importer_code==="01").id);
    assert.deepEqual(after.sales.filter(s=>s.importer_code!=="01"),before.sales.filter(s=>s.importer_code!=="01"));
    assert.deepEqual(after.ar.filter(s=>s.importer_code!=="01"),before.ar.filter(s=>s.importer_code!=="01"));
    assert.deepEqual(after.domestic,before.domestic);assert.deepEqual(after.dl,before.dl);assert.deepEqual(after.dr,before.dr);
    await assert.rejects(()=>finalize(db),/すでに確定/);
    assert.deepEqual(await state(db),after);
  }finally{await db.close()}
});

test("PostgreSQL stale versions, protected billing and late failures leave all data unchanged",{skip:!process.env.SALES_REFINALIZE_DB},async()=>{
  const db=await database();try{
    const p=await preview(db);await db.exec("update order_lines set unit_price=90 where source_row_no=1");
    let before=await state(db);await assert.rejects(()=>finalize(db,["01"],{"01":100},p.version),/確認中/);assert.deepEqual(await state(db),before);
    await db.exec("update accounts_receivable set closing_id=gen_random_uuid() where importer_code='03'");
    before=await state(db);await assert.rejects(()=>finalize(db,["01","03"],{"01":100,"03":0}),/請求締め済み/);assert.deepEqual(await state(db),before);
    // An unrelated importer being closed must not prevent this correction.
    assert.equal((await finalize(db)).session.locked,true);
    await db.exec("update work_sessions set locked=false,status='active';select set_config('test.admin','false',false)");
    before=await state(db);await assert.rejects(()=>preview(db),/管理者/);assert.deepEqual(await state(db),before);
  }finally{await db.close()}
});

test("PostgreSQL partial corrections keep other pending changes open and reuse domestic sale IDs",{skip:!process.env.SALES_REFINALIZE_DB},async()=>{
  const db=await database();try{
    const before=await state(db);
    await db.exec("update order_lines set unit_price=90 where source_row_no in (1,3)");
    const first=await finalize(db);assert.equal(first.session.locked,false);assert.deepEqual(first.pending_importers,["08"]);
    const second=await finalize(db,["08"],{"08":10});assert.equal(second.session.locked,true);
    const after=await state(db);assert.equal(after.domestic.length,1);assert.equal(after.domestic[0].id,before.domestic[0].id);assert.equal(after.domestic[0].sale_no,"DOM-EXISTING");
    assert.equal(after.domestic[0].total_amount_jpy,399);assert.equal(after.dr[0].amount_jpy,399);assert.equal(after.dr[0].id,before.dr[0].id);assert.equal(after.dl[0].id,before.dl[0].id);
    assert.equal(after.sessions[0].shipping_fee,110);assert.equal(after.ar.length,2);
  }finally{await db.close()}
});

test("PostgreSQL recovers interrupted prior writes and handles decimal rounding and zero sales",{skip:!process.env.SALES_REFINALIZE_DB},async()=>{
  const db=await database();try{
    await db.exec("update order_lines set unit_price=90 where source_row_no=1;update sales_records set unit_price=90,amount=180 where source_row_no=1");
    assert.equal((await preview(db)).groups.find(g=>g.importer_code==="01").changed,true);
    await finalize(db);
    await db.exec("update work_sessions set locked=false,status='active';update order_lines set input_qty=1.25,unit_price=10 where source_row_no=1");
    await finalize(db);assert.equal((await state(db)).ar.find(r=>r.importer_code==="01").net_sales_jpy,13);
    await db.exec("update work_sessions set locked=false,status='active';update order_lines set is_stockout=true where source_row_no=1");
    const done=await finalize(db,["01"],{"01":0});assert.equal(done.session.locked,true);assert.equal((await state(db)).ar.find(r=>r.importer_code==="01").amount_jpy,0);
  }finally{await db.close()}
});

test("PostgreSQL validates scope, permissions, duplicate invoices and stockouts in domestic links",{skip:!process.env.SALES_REFINALIZE_DB},async()=>{
  const db=await database();try{
    let before=await state(db);
    for(const [codes,fees,pattern] of [[[],{},/選択/],[["99"],{},/明細がありません/],[["01"],{"03":100},/選択していない/],[["01"],{"01":-1},/整数/],[["01"],{"01":1.1},/整数/]]){
      await assert.rejects(()=>finalize(db,codes,fees),pattern);assert.deepEqual(await state(db),before);
    }
    await db.exec("select set_config('test.internal','false',false)");await assert.rejects(()=>preview(db),/管理者/);
    await db.exec("select set_config('test.internal','true',false);insert into accounts_receivable(source_key,source_type,source_session_id,importer_code,net_sales_jpy,shipping_amount_jpy,amount_jpy) select source_key||':duplicate',source_type,source_session_id,importer_code,net_sales_jpy,shipping_amount_jpy,amount_jpy from accounts_receivable where importer_code='01'");
    before=await state(db);await assert.rejects(()=>finalize(db),/請求候補が複数/);assert.deepEqual(await state(db),before);
    await db.exec("delete from accounts_receivable where source_key like '%:duplicate';update order_lines set is_stockout=true where source_row_no=3");
    const result=await finalize(db,["08"],{"08":0});assert.equal(result.session.locked,true);
    const after=await state(db);assert.equal(after.domestic[0].total_amount_jpy,0);assert.equal(after.dr[0].amount_jpy,0);assert.equal(after.domestic[0].id,domestic);assert.equal(after.sales.length,3);
  }finally{await db.close()}
});

test("refinalization dialog uses saved shipping and prevents repeated submissions on desktop and tablet",{skip:!process.env.SALES_REFINALIZE_BROWSER},async()=>{
  const {chromium}=require("playwright");const browser=await chromium.launch({channel:"chrome",headless:true});
  const groups=[{importer_code:"01",importer_name:"FBI",line_count:109,net_sales:1285463,shipping:165957,changed:true},{importer_code:"03",importer_name:"DIM",line_count:37,net_sales:584525,shipping:0,changed:false},{importer_code:"08",importer_name:"国内経由",line_count:2,net_sales:106640,shipping:0,changed:false,domestic:{id:domestic}}];
  const css=fs.readFileSync(path.join(root,"sales-refinalize.css"),"utf8");
  const fixture=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{font-family:Meiryo,sans-serif;margin:10px}${css}</style><button id="start" onclick="openSalesRefinalization()">売上再確定</button><script>var currentSessionId='test',orderLineSaveQueues=new Map(),boxSaveInFlight=new Set(),calls=[],busyReply=null,locked=false;function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}async function loadCurrentUserRoleTrial(){}function currentUserIsAdmin(){return true}function setSessionLockStateTrial(s){locked=s.locked}function setSaveState(){}function toast(){}var supabaseClient={rpc:async(name,args)=>{if(name==='work_refinalization_preview')return {data:{session:{id:'test',name:'確認用大阪',work_date:'2026-09-10'},version:'v1',groups:${JSON.stringify(groups)}}};calls.push(args);return await new Promise(resolve=>busyReply=resolve)}};${ui}</script>`;
  try{
    const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
    for(const width of [1280,768,390]){
      await page.setViewportSize({width,height:900});await page.setContent(fixture);
      await page.locator("#start").click();await page.locator("#sales-refinalize-dialog").waitFor({state:"visible"});
      assert.equal(await page.locator('[data-shipping-index="0"]').inputValue(),"165957");
      assert.equal(await page.locator('[data-importer-index="0"]').isChecked(),true);
      assert.equal(await page.locator('[data-importer-index="1"]').isChecked(),false);
      assert.equal(await page.locator('[data-shipping-index="1"]').isDisabled(),true);
      const bounds=await page.locator("dialog").evaluate(d=>({width:d.getBoundingClientRect().width,overflow:d.scrollWidth>d.clientWidth,height:d.getBoundingClientRect().height}));
      assert.ok(bounds.width<=width&&!bounds.overflow&&bounds.height<=900);
      if(process.env.SALES_REFINALIZE_SCREENSHOTS){fs.mkdirSync(process.env.SALES_REFINALIZE_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.SALES_REFINALIZE_SCREENSHOTS,`refinalize-${width}.png`)})}
      await page.locator('[data-submit]').click();assert.equal(await page.locator('[data-submit]').isDisabled(),true);
      await page.keyboard.press("Escape");assert.equal(await page.locator("dialog").isVisible(),true);
      const requests=await page.evaluate(()=>calls);assert.equal(requests.length,1);assert.deepEqual(requests[0].p_importer_codes,["01"]);assert.deepEqual(requests[0].p_shipping_fees,{"01":165957});
      await page.evaluate(()=>busyReply({data:{session:{locked:true},pending_importers:[]}}));
      await page.locator("dialog").waitFor({state:"detached"});assert.equal(await page.evaluate(()=>locked),true);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
