const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'work-product-change-migration.sql'),'utf8');
const js=fs.readFileSync(path.join(root,'work-product-change.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const session='11111111-1111-4111-8111-111111111111';
const source='22222222-2222-4222-8222-222222222222';
const work='33333333-3333-4333-8333-333333333333';
const request='44444444-4444-4444-8444-444444444444';
const stamp='2026-10-03T01:00:00Z';
const change={product_id:'P2',product_name:'Replacement',english_name:'New English',scientific_name:'New species',origin:'Tokyo',unit_price:2200,expected_source_updated_at:stamp};
const schema=`
create role anon;create role authenticated;
create schema auth;create table auth.users(id uuid primary key);
insert into auth.users values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
create function auth.uid() returns uuid language sql as $$select case when coalesce(current_setting('test.anonymous',true),'false')='true' then null else 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid end$$;
create function is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.internal',true),'true')='true'$$;
create table work_sessions(id uuid primary key,locked boolean default false,provisional_locked boolean default false,status text default 'active');
create table product_master(product_id text primary key,is_active boolean default true);
create table order_entry_lines(id uuid primary key,product_code text,product_name_snapshot text,english_name_snapshot text,unit_price numeric,supplier_code text,purchase_ordered boolean,purchase_ordered_at timestamptz,purchase_ordered_by uuid,updated_at timestamptz default '${stamp}');
create table order_lines(id uuid primary key,session_id uuid,source_row_no integer,source_order_line_id uuid,product_id text,product_name text,english_name text,scientific_name text,origin text,unit_price numeric,input_qty numeric,input_unit text,net_weight numeric,box_no text,memo text,is_stockout boolean,updated_by uuid,updated_at timestamptz default '${stamp}');
create function touch_work() returns trigger language plpgsql as $$begin new.updated_at=clock_timestamp();return new;end$$;
create trigger work_touch before update on order_lines for each row execute function touch_work();
create trigger source_touch before update on order_entry_lines for each row execute function touch_work();
create table sales_records(id uuid primary key default gen_random_uuid(),session_id uuid,source_row_no integer);
create table external_work_assignments(id uuid primary key,status text);
create table external_work_assignment_lines(id uuid primary key,assignment_id uuid,order_line_id uuid,active boolean,product_code text,product_name text);
create table purchase_receipts(id uuid primary key,status text);
create table purchase_receipt_lines(id uuid primary key,receipt_id uuid,source_assignment_line_id uuid);
insert into work_sessions(id) values('${session}');
insert into product_master values('P1',true),('P2',true),('P3',false);
insert into order_entry_lines(id,product_code,product_name_snapshot,english_name_snapshot,unit_price,supplier_code,purchase_ordered,purchase_ordered_at) values('${source}','P1','Original','Old English',1000,'45',true,'${stamp}');
insert into order_lines(id,session_id,source_row_no,source_order_line_id,product_id,product_name,english_name,scientific_name,origin,unit_price,input_qty,input_unit,net_weight,box_no,memo,is_stockout)
 values('${work}','${session}',1,'${source}','P1','Original','Old English','Old species','Osaka',1000,3,'PC',1.8,'TK-1','Keep memo',false);
`;
async function db(){const {PGlite}=require(process.env.PGLITE_PATH);const db=new PGlite();await db.exec(schema);await db.exec(sql);return db}
async function save(db,value=change,id=request,expected=stamp){return (await db.query('select change_work_order_product($1,1,$2,$3,$4::jsonb) result',[session,expected,id,JSON.stringify(value)])).rows[0].result}
async function count(db){return Number((await db.query('select count(*) n from work_product_change_log')).rows[0].n)}
const dbOpts={skip:!process.env.PGLITE_PATH};
test('product changes atomically update work/source, preserve measurements and keep the supplier link',dbOpts,async()=>{
  const d=await db();try{
    const row=await save(d);assert.equal(row.product_id,'P2');assert.equal(row.unit_price,2200);
    assert.equal(row.source_order_line_id,source);assert.equal(row.input_qty,3);assert.equal(row.net_weight,1.8);assert.equal(row.box_no,'TK-1');assert.equal(row.memo,'Keep memo');assert.equal(row.input_unit,'PC');
    const entry=(await d.query('select * from order_entry_lines')).rows[0];
    assert.equal(entry.product_code,'P2');assert.equal(entry.product_name_snapshot,'Replacement');assert.equal(entry.english_name_snapshot,'New English');assert.equal(entry.supplier_code,'45');assert.equal(entry.purchase_ordered,false);assert.equal(entry.purchase_ordered_at,null);
    assert.equal(await count(d),1);assert.equal((await save(d)).product_id,'P2');assert.equal(await count(d),1);
    await assert.rejects(save(d,{...change,product_name:'Other'}),/重複/);
    await d.exec('update work_sessions set locked=true');assert.equal((await save(d)).product_id,'P2');
  }finally{await d.close()}
});
test('unregistered replacement can clear old metadata and legacy work without an order remains editable',dbOpts,async()=>{
  const d=await db();try{
    await d.exec('update order_lines set source_order_line_id=null');
    const current=(await d.query('select updated_at from order_lines')).rows[0].updated_at;
    const row=await save(d,{...change,product_id:'',english_name:'',scientific_name:'',origin:'',unit_price:null},request,current);
    assert.match(row.product_id,/^ADD-/);assert.equal(row.english_name,null);assert.equal(row.scientific_name,null);assert.equal(row.unit_price,null);assert.equal(row.input_qty,3);
    assert.equal((await d.query('select product_code from order_entry_lines')).rows[0].product_code,'P1');
  }finally{await d.close()}
});
test('invalid product, price, stale work/source and duplicate source usage reject without partial updates',dbOpts,async()=>{
  const d=await db();try{
    for(const invalid of [{product_name:''},{product_id:'missing'},{product_id:'P3'},{unit_price:-1},{unit_price:'NaN'},{unit_price:'Infinity'},{expected_source_updated_at:null}])await assert.rejects(save(d,{...change,...invalid}));
    await assert.rejects(save(d,change,request,'2000-01-01'),/更新/);
    await d.exec(`insert into order_lines(id,session_id,source_row_no,source_order_line_id) values('55555555-5555-4555-8555-555555555555','${session}',2,'${source}')`);
    await assert.rejects(save(d),/複数作業/);
    assert.equal(await count(d),0);assert.equal((await d.query('select product_code from order_entry_lines')).rows[0].product_code,'P1');
  }finally{await d.close()}
});
test('internal access, locks and finalized sales are enforced by the database, not only the UI',dbOpts,async()=>{
  const d=await db();try{
    await d.exec("select set_config('test.internal','false',false)");await assert.rejects(save(d),/社内/);
    await d.exec("select set_config('test.internal','true',false);select set_config('test.anonymous','true',false)");await assert.rejects(save(d),/社内/);
    await d.exec("select set_config('test.anonymous','false',false);update work_sessions set provisional_locked=true");await assert.rejects(save(d),/仮締め/);
    await d.exec("update work_sessions set provisional_locked=false,locked=true");await assert.rejects(save(d),/確定/);
    await d.exec(`update work_sessions set locked=false;insert into sales_records(session_id,source_row_no) values('${session}',1)`);await assert.rejects(save(d),/売上登録済み/);
    assert.equal(await count(d),0);
  }finally{await d.close()}
});
test('published external work and existing purchases are protected; late failure rolls back both records',dbOpts,async()=>{
  const d=await db();try{
    await d.exec(`insert into external_work_assignments values('${request}','published');insert into external_work_assignment_lines values('${request}','${request}','${source}',true,'P1','Original')`);
    await assert.rejects(save(d),/外部作業/);
    await d.exec(`update external_work_assignments set status='cancelled';insert into purchase_receipts values('${request}','confirmed');insert into purchase_receipt_lines values('${request}','${request}','${request}')`);
    await assert.rejects(save(d),/仕入/);
    await d.exec(`update purchase_receipts set status='cancelled';create function fail_audit() returns trigger language plpgsql as $$begin raise exception 'audit failed';end$$;create trigger fail_audit before insert on work_product_change_log for each row execute function fail_audit()`);
    await assert.rejects(save(d),/audit failed/);
    assert.equal((await d.query('select product_code from order_entry_lines')).rows[0].product_code,'P1');
    assert.equal((await d.query('select product_id from order_lines')).rows[0].product_id,'P1');assert.equal(await count(d),0);
  }finally{await d.close()}
});
test('field autosaves are narrow, product-scoped and cannot overwrite replacement metadata',async()=>{
  const calls=[],query={update(payload){calls.push(payload);return this},eq(){return this},is(){return this},select(){return this},async maybeSingle(){return {data:{source_row_no:1}}}};
  const ctx={currentSessionId:session,currentUser:{id:'user'},supabaseClient:{from:()=>query},setSaveState(){},toast(){},rowToOrderLinePayload:row=>({session_id:session,source_row_no:1,product_id:row.product_id,product_name:'New',unit_price:999,origin:'Old',input_qty:3,input_unit:'PC',net_weight:1.8,box_no:'TK-1',memo:'M',is_stockout:false,store_name:'S',updated_by:'user'})};
  vm.runInNewContext(html.slice(html.indexOf('var orderLineSaveQueues='),html.indexOf('function updateOrderLineFieldsToSupabase(')),ctx);
  await ctx.saveOrderLineToSupabase({product_id:'P2'});
  assert.equal(calls[0].input_qty,3);for(const key of ['product_id','product_name','english_name','scientific_name','unit_price','origin'])assert.equal(Object.hasOwn(calls[0],key),false);
});
test('UI compiles, keeps retries, clears old metadata, guards auto refresh and exposes both phases',()=>{
  new vm.Script(js);
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  assert.match(js,/sessionStorage\.setItem\(workProductRetryKey/);assert.match(js,/workProductBusy\|\|!workProductEdit/);
  assert.match(html,/r\.en_name=dbRow\.english_name\?\?""/);assert.match(html,/work-product-dialog"\)\?\.open/);
  assert.equal((html.match(/\$\{workProductCell\(r\)\}/g)||[]).length,3);
  assert.match(sql,/enable row level security/);assert.match(sql,/revoke all on function[\s\S]*from public,anon/);
});
function uiModel(rpc){
  const nodes=new Map(),storage=new Map(),written=[];
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{_value:'',get value(){return this._value},set value(v){this._value=String(v)},textContent:'',disabled:false,querySelectorAll:()=>[],addEventListener(){},close(){this.closed=true}});
    return nodes.get(id);
  };
  const ctx=vm.createContext({document:{body:{insertAdjacentHTML(){}},getElementById:node},window:{addEventListener(){}},
    currentSessionId:session,currentSessionLocked:false,currentSessionProvisionalLocked:false,currentPhase:1,
    masterMap:{P2:{product_id:'P2',product_name:'Replacement',en_name:'New English',sci_name:'New species',origin:'Tokyo'}},
    normalizeProductId:v=>v,workOriginRomanize:v=>v,resolveInitialUnitPrice:()=>2200,numberOrNull:v=>v===''?null:Number.isFinite(Number(v))?Number(v):null,
    esc:v=>String(v??''),requireEditableTrial:()=>true,confirm:()=>true,crypto:{randomUUID:()=>request},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    supabaseClient:{rpc},upsertRemoteOrderLine:row=>written.push(row),buildP1Tabs(){},buildP15(){},buildP2(){},setSaveState(){},toast(){}});
  vm.runInContext(js,ctx);
  vm.runInContext(`workProductEdit={sessionId:${JSON.stringify(session)},rowIdx:0,base:{product_name:'Original',product_id:'P1',updated_at:${JSON.stringify(stamp)},importer_code:'01'},source:{updated_at:${JSON.stringify(stamp)},purchase_ordered:true},appliedCode:'P1',attempt:null}`,ctx);
  ctx.workProductFill({product_id:'P1',product_name:'Original',english_name:'Old English',scientific_name:'Old species',origin:'Osaka',unit_price:1000});
  return {ctx,node,storage,written};
}
test('typing a matching code only offers candidates; selecting applies new metadata, not the old price',()=>{
  const {ctx,node}=uiModel();node('work-product-product_id').value='P2';
  ctx.workProductCandidates();assert.equal(node('work-product-product_name').value,'Original');
  ctx.workProductApplyCode();assert.equal(node('work-product-product_name').value,'Replacement');assert.equal(node('work-product-unit_price').value,'2200');
  node('work-product-product_id').value='';ctx.workProductApplyCode();
  for(const key of ['english_name','scientific_name','origin','unit_price'])assert.equal(node('work-product-'+key).value,'');
});
test('double clicks create one request and data changes only after successful acknowledgement',async()=>{
  let release;const calls=[];
  const {ctx,written,storage}=uiModel((name,args)=>{calls.push({name,args});return new Promise(resolve=>{release=resolve})});
  const first=ctx.saveWorkProductChange();await ctx.saveWorkProductChange();
  assert.equal(calls.length,1);assert.equal(written.length,0);assert.equal(storage.size,1);
  release({data:{id:work,session_id:session,source_row_no:1,product_id:'P1'}});await first;
  assert.equal(written.length,1);assert.equal(storage.size,0);
});
test('network failure keeps the exact request for retry; structured conflict leaves displayed work unchanged',async()=>{
  const calls=[];
  const {ctx,written,storage}=uiModel(async(name,args)=>{calls.push(args);return {error:{message:'offline'}}});
  await ctx.saveWorkProductChange();await ctx.saveWorkProductChange();
  assert.equal(calls.length,2);assert.equal(calls[0].p_request_id,calls[1].p_request_id);assert.deepEqual(calls[0].p_change,calls[1].p_change);
  assert.equal(written.length,0);assert.equal(storage.size,1);
  ctx.supabaseClient.rpc=async()=>({error:{code:'40001',message:'conflict'}});
  await ctx.saveWorkProductChange();assert.equal(written.length,0);assert.equal(storage.size,0);
});
