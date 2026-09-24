const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const profile=require("../supplier-work-profile.js"),report=require("../supplier-work-report.js");
const common={site_code:"",importer_code:"",supplier_code:"",cargo_location:"共通倉庫",cargo_cut_time:"当日 12:00 JST",document_cut_time:"前日 16:00 JST",document_method:"PDFを担当へメール",packing_note:"水漏れ防止",contact:"出荷担当"};
const tokyo={site_code:"TYO",importer_code:"",supplier_code:"",cargo_location:"東京 空港貨物棟",cargo_cut_time:"当日 11:00 JST"};
const jakarta={site_code:"TYO",importer_code:"07",supplier_code:"",destination_name:"JAKARTA",document_method:"PDF・Excelを指定メールへ"};
const vendor={site_code:"TYO",importer_code:"07",supplier_code:"10",packing_note:"個別真空\n箱側面に記号"};
const profiles=[common,tokyo,jakarta,vendor,{site_code:"TYO",importer_code:"07",supplier_code:"11",packing_note:"他社専用指示"}];
const row={orderDate:"2026-09-24",supplierCode:"10",supplierName:"確認用問屋",importerCode:"07",importerName:"JKT",siteCode:"TYO",customerCode:"07001",customerName:"TEST",productCode:"0001",productName:"真鯛",qty:2,unit:"Kg"};
test("saved scopes inherit common fields and isolate supplier/importer/site and leading zeros",()=>{
  const resolved=profile.resolve(profiles,{site_code:"TYO",importer_code:"07",supplier_code:"10"});
  assert.equal(resolved.cargo_location,tokyo.cargo_location);assert.equal(resolved.document_method,jakarta.document_method);assert.equal(resolved.packing_note,vendor.packing_note);
  assert.equal(resolved.document_cut_time,common.document_cut_time);assert.equal(resolved.destination_name,"JAKARTA");
  assert.equal(profile.resolve(profiles,{site_code:"OSA",importer_code:"07",supplier_code:"10"}).cargo_location,common.cargo_location);
  assert.equal(profile.resolve(profiles,{site_code:"TYO",importer_code:"7",supplier_code:"10"}).destination_name,"");
  assert.equal(profile.resolve(profiles,{site_code:"TYO",importer_code:"07",supplier_code:"110"}).packing_note,common.packing_note);
  assert.equal(profile.resolve(profiles,{site_code:"TYO",importer_code:"07",supplier_code:"10"},{cargo_location:"臨時倉庫",packing_note:"なし"}).packing_note,"なし");
});
test("resolved header repeated on every print page without unrelated profile/private fields",()=>{
  const model=report.build(Array.from({length:25},()=>row),{profiles,note:"今回追記"});const html=report.printableDocument(model,"https://example.test/supplier-work-report.js?v=2");
  const pages=report.renderPages(model);assert.equal((pages.match(/貨物カット時間/g)||[]).length,3);
  assert.equal((pages.match(/JAKARTA/g)||[]).length,3);assert.equal((pages.match(/今回追記/g)||[]).length,3);
  assert.ok(pages.includes("個別真空<br>箱側面に記号<br>今回追記"));assert.ok(!html.includes("他社専用指示"));assert.ok(!html.includes('"profiles"'));
  assert.ok(html.includes("supplier-work-profile.js?v=2"));assert.equal(model.rowCount,25);
  const escaped=report.renderPages(report.build([row],{profiles:[{...common,packing_note:"<script>x</script>"}]}));assert.ok(escaped.includes("&lt;script&gt;"));
});
let ExcelJS;try{ExcelJS=require(process.env.EXCELJS_PATH||"exceljs")}catch{}
test("Excel headers, freeze and repeating titles survive file roundtrip for every destination",{skip:!ExcelJS},async()=>{
  const model=report.build([row,{...row,importerCode:"08",importerName:"OTHER"}],{profiles});
  const book=report.createWorkbook(ExcelJS,model.suppliers[0],model.options),loaded=new ExcelJS.Workbook();await loaded.xlsx.load(await book.xlsx.writeBuffer());
  assert.equal(loaded.worksheets.length,2);
  for(const sheet of loaded.worksheets){assert.equal(sheet.pageSetup.printTitlesRow,"1:9");assert.equal(sheet.views[0].ySplit,9);assert.match(sheet.getCell("A5").value,/東京 空港貨物棟/);assert.match(sheet.getCell("I6").value,/前日 16:00 JST/);assert.equal(sheet.getCell("C10").value,"0001")}
  assert.match(loaded.worksheets[0].getCell("A4").value,/JAKARTA/);assert.match(loaded.worksheets[0].getCell("A8").value,/個別真空\n箱側面/);
  assert.doesNotMatch(loaded.worksheets[1].getCell("A4").value,/JAKARTA/);assert.doesNotMatch(loaded.worksheets[1].getCell("A8").value,/個別真空/);
  const long=report.build([row],{profiles:[{...common,packing_note:Array(35).fill("長い注意事項").join("\n")}]});assert.throws(()=>report.createWorkbook(ExcelJS,long.suppliers[0],long.options),/長すぎます/);
});
function appContext(rows=profiles){
  const elements=new Map(),calls=[],alerts=[];const node=id=>{if(!elements.has(id))elements.set(id,{value:"",textContent:"",style:{},disabled:false,dataset:{},classList:{add(){},toggle(){}},querySelectorAll(){return []}});return elements.get(id)};
  let queryError=null,response=rows,writeResult=null;
  const client={from(table){calls.push(["from",table]);let action="read";const q={select(){return q},order(){return q},range(from,to){return Promise.resolve({data:response.slice(from,to+1),error:queryError})},eq(...args){calls.push(["eq",...args]);return q},insert(data){action="insert";calls.push([action,data]);return q},update(data){action="update";calls.push([action,data]);return q},delete(){action="delete";calls.push([action]);return q},maybeSingle(){return Promise.resolve({data:writeResult,error:queryError})}};return q}};
  const context={window:{addEventListener(){}},SupplierWorkProfile:profile,supabaseClient:client,currentUser:{id:"user"},currentUserIsAdmin:()=>true,document:{getElementById:node},getMasters:()=>({suppliers:[{code:"10",name:"問屋"}],importers:[{code:"07",name:"JKT"}]}),esc:String,updateMasterTabState(){},confirm:()=>true,alert:m=>alerts.push(m),masterView:"core"};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","supplier-work-profile-app.js"),"utf8"),context);
  return {api:context.window.SupplierWorkProfilesApp,context,node,calls,alerts,setError(error){queryError=error},setWrite(row){writeResult=row}};
}
test("profile DB reads paginated, failures explicit, no auto writes when opening",async()=>{
  const state=appContext(Array.from({length:1204},()=>common));assert.equal((await state.api.read()).length,1204);assert.equal(state.calls.filter(c=>c[0]==="from").length,2);
  await state.api.show();assert.ok(!state.calls.some(c=>["insert","update","delete"].includes(c[0])));
  state.setError({code:"42P01",message:"supplier_work_profiles not found"});await assert.rejects(state.api.read(),/SQL/);
  state.setError({code:"42501",message:"permission denied for table supplier_work_profiles"});await assert.rejects(state.api.read(),/permission denied/);
});
test("admin-only saves, scope exact selection, stale update and double-submit safeguards",async()=>{
  const saved={...common,updated_at:"2026-09-24T00:00:00Z"},state=appContext([saved]);await state.api.show();state.api.select("0");
  state.node("work-profile-cargo_cut_time").value="13:00";state.context.currentUserIsAdmin=()=>false;await state.api.save();assert.ok(!state.calls.some(c=>c[0]==="update"));
  state.context.currentUserIsAdmin=()=>true;state.setWrite(null);const p=state.api.save();await state.api.save();await p;
  assert.equal(state.calls.filter(c=>c[0]==="update").length,1);assert.ok(state.calls.some(c=>c[0]==="eq"&&c[1]==="updated_at"&&c[2]===saved.updated_at));assert.match(state.node("work-profile-state").textContent,/他の担当者/);
});
let PGlite;try{({PGlite}=require(process.env.PGLITE_PATH||"@electric-sql/pglite"))}catch{}
test("SQL is idempotent and limits profiles to staff read / admin writes, no business-table writes",{skip:!PGlite},async()=>{
  const pg=new PGlite();try{
    await pg.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select null::uuid$$; create function public.is_internal_user() returns boolean language sql as $$select coalesce(current_setting('test.staff',true),'')='yes'$$; create function public.is_master_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'')='yes'$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    const sql=fs.readFileSync(path.join(__dirname,"..","supplier-work-profile-migration.sql"),"utf8");await pg.exec(sql);await pg.exec(sql);
    await pg.exec(`set role authenticated; set test.staff='yes'; set test.admin='no';`);await assert.rejects(pg.exec("insert into public.supplier_work_profiles(cargo_location) values ('test')"),/row-level security/);
    await pg.exec(`set test.admin='yes'; insert into public.supplier_work_profiles(cargo_location) values ('test');`);assert.equal((await pg.query("select * from public.supplier_work_profiles")).rows.length,1);
    await pg.exec(`set test.staff='no';`);assert.equal((await pg.query("select * from public.supplier_work_profiles")).rows.length,0);await assert.rejects(pg.exec("insert into public.supplier_work_profiles(site_code) values ('TYO')"),/row-level security/);
    await pg.exec(`reset role; set role anon;`);await assert.rejects(pg.exec("select * from public.supplier_work_profiles"),/permission denied/);
    assert.doesNotMatch(sql,/\b(?:update|delete from|insert into)\s+public\.(?:order|sales|purchase|supplier_master|work_sessions)/i);
  }finally{await pg.close()}
});
