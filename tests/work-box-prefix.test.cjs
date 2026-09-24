const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");
const root=path.join(__dirname,"..");
const app=fs.readFileSync(path.join(root,"index.html"),"utf8");
const routing=fs.readFileSync(path.join(root,"work-box-routing.js"),"utf8");
const box=require("../work-box-number.js");
function section(start,end){const a=app.indexOf(start),b=app.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return app.slice(a,b)}
const esc=value=>String(value??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");
function row(index,code,number=""){
  return {_idx:index,_sourceOrderLineId:`source-${index}`,_boxRouting:{supplierCode:code,prefix:code},_box:number,_qty:"2",_net:"2.5",_unit:"Kg",_stockout:false,
    _memo:"",product_id:"001",product_name:"Test fish",customer:"Customer",importer_id:"07",country:"07",csv_qty:2,unit:"Kg",unit_price:1200,en_name:"Fish",sci_name:"",origin:"Tokyo"};
}
function runtime(rows=[row(0,"A"),row(1,"B")]){
  const elements={};const saved=[];
  const ctx={rows,WorkBoxNumber:box,esc,currentSessionSiteCode:"TYO",currentSessionId:"session",currentUser:{id:"user"},sitePartnerSchemaReady:true,
    P1_KEY:{qty:"_qty",net:"_net",box:"_box"},numberOrNull:v=>v===""||v==null?null:Number(v),importerCodeFromRow:r=>r.importer_id,
    importerCode:v=>v,countryCode:v=>v,importerDisplayName:v=>v,boxMap:{},activeImporter:null,getImporters:()=>[...new Set(ctx.rows.map(r=>r.importer_id))],
    document:{getElementById:id=>elements[id]??(elements[id]={style:{},innerHTML:"",scrollLeft:0}),querySelectorAll:()=>[]},cid:v=>v,
    saveOrderLineToSupabase:r=>saved.push(ctx.rowToOrderLinePayload(r)),scheduleP1InlineRefresh:()=>{},renderP2Importer:()=>{},
    getExportRows:()=>ctx.rows,Date};
  vm.createContext(ctx);
  vm.runInContext(routing,ctx);
  vm.runInContext(section("function sanitizeInlineNumber(","function inlineP1MemoInput("),ctx);
  vm.runInContext(section("function updateInlineP1Draft(","function updateInlineP1MemoDraft("),ctx);
  vm.runInContext(section("function commitInlineP1Field(","function commitInlineP1Memo("),ctx);
  vm.runInContext(section("function rowToOrderLinePayload(","function syncOrderRowsFromRows("),ctx);
  vm.runInContext(section("function boxToPayload(","async function requireSupabaseLogin("),ctx);
  vm.runInContext(section("function buildP2(){\n","function renderP2Importer(imp){\n"),ctx);
  vm.runInContext(section("function exportBoxNo(","function forceTextColumn("),ctx);
  vm.runInContext(section("function orderExportRowsByCustomerAndBox(","async function exportExcel(){"),ctx);
  return {ctx,saved,elements};
}
function input(index,prefix,value,original=""){return {dataset:{rowIdx:String(index),field:"box",boxPrefix:prefix,boxOriginal:original,boxDirty:"0"},value,disabled:false}}

test("Tokyo uses explicit supplier codes, numeric input and distinct complete labels",()=>{
  const {ctx,saved}=runtime();
  for(const [index,prefix] of [[0,"A"],[1,"B"]]){const el=input(index,prefix,"１");ctx.updateInlineP1Draft(el);ctx.commitInlineP1Field(el);assert.equal(el.value,"1")}
  assert.deepEqual(saved.map(r=>r.box_no),["A-1","B-1"]);
  assert.deepEqual(saved.map(r=>r.source_order_line_id),["source-0","source-1"]);
  assert.match(ctx.inlineP1Input(ctx.rows[0],"box","箱"),/data-box-prefix="A"/);
  assert.match(ctx.inlineP1Input(ctx.rows[0],"box","箱"),/value="1"/);
  assert.equal(ctx.rows[0]._qty,"2");assert.equal(ctx.rows[0].unit_price,1200);
});

test("editing and clearing do not duplicate the prefix or create empty phantom boxes",()=>{
  const {ctx,saved}=runtime([row(0,"A","A-1")]);
  const el=input(0,"A","02","A-1");ctx.updateInlineP1Draft(el);ctx.commitInlineP1Field(el);
  assert.equal(saved[0].box_no,"A-2");
  el.value="";ctx.updateInlineP1Draft(el);ctx.commitInlineP1Field(el);
  assert.equal(saved[1].box_no,null);assert.equal(ctx.rows[0]._box,"");
});

test("a mere focus/blur never rewrites existing numbers or strips a saved prefix",()=>{
  for(const value of ["1","A-1","A-001"]){
    const {ctx,saved}=runtime([row(0,"B",value)]);
    const parts=box.describe(value,"TYO",{prefix:"B"});
    ctx.commitInlineP1Field(input(0,parts.prefix,parts.sequence,value));
    assert.equal(ctx.rows[0]._box,value);assert.equal(saved.length,0);
  }
  assert.equal(box.describe("A-1","TYO",{prefix:"B"}).prefix,"A");
  assert.equal(box.describe("1","TYO",{prefix:"B"}).legacy,true);
});

test("missing routing blocks numeric-only saves; known saved qualified labels remain usable",()=>{
  const {ctx,saved}=runtime([row(0,"")]);
  assert.match(ctx.inlineP1Input(ctx.rows[0],"box","箱"),/disabled data-box-routing-blocked="true"/);
  const el=input(0,"","1");el.disabled=true;ctx.updateInlineP1Draft(el);ctx.commitInlineP1Field(el);
  assert.equal(saved.length,0);assert.equal(ctx.rows[0]._box,"");
  assert.equal(box.describe("A-1","TYO",{error:"offline"}).blocked,false);
  assert.match(app,/el\.disabled=locked\|\|el\.dataset\.boxRoutingBlocked==="true"/);
});

test("Osaka retains the existing numeric-only layout and save path",()=>{
  const {ctx,saved}=runtime();ctx.currentSessionSiteCode="OSA";
  assert.doesNotMatch(ctx.inlineP1Input(ctx.rows[0],"box","箱"),/work-box-prefix|data-box-prefix/);
  const el={dataset:{rowIdx:"0",field:"box"},value:"12"};ctx.commitInlineP1Field(el);
  assert.equal(saved[0].box_no,"12");
});

test("the older number dialog preserves a numeric supplier prefix instead of appending it to the sequence",()=>{
  const {ctx,elements}=runtime([row(0,"21","21-3")]);
  ctx.npMode="p1";ctx.curRow=0;ctx.curF="box";ctx.npVal="21-3";ctx.toast=()=>{};
  vm.runInContext(section("function nativeNumberInput(","function focusNativeNumberInput("),ctx);
  vm.runInContext(section("function saveNP(){","function saveMemoCur("),ctx);
  ctx.configureNativeNumberInput();assert.equal(elements["np-native-input"].value,"3");
  ctx.saveNP();assert.equal(ctx.rows[0]._box,"21-3");
  ctx.npVal="4";ctx.saveNP();assert.equal(ctx.rows[0]._box,"21-4");
  ctx.npVal="";ctx.saveNP();assert.equal(ctx.rows[0]._box,"");
  ctx.rows[0]._boxRouting={};ctx.npVal="5";ctx.configureNativeNumberInput();ctx.saveNP();
  assert.equal(elements["np-native-input"].disabled,true);assert.equal(ctx.rows[0]._box,"");
});

test("P2 and invoice count codes separately, combine only identical labels and keep gross/ice isolated",()=>{
  const {ctx}=runtime([row(0,"A","A-1"),row(1,"B","B-1"),row(2,"A","A-1"),row(3,"A","A-2")]);
  ctx.buildP2();
  assert.deepEqual(Object.keys(ctx.boxMap["07"]),["A-1","A-2","B-1"]);
  Object.assign(ctx.boxMap["07"]["A-1"],{gross:"6",dry_ice:"1",dry_ice_enabled:true,box_size:"小"});
  Object.assign(ctx.boxMap["07"]["B-1"],{gross:"3",box_size:"中"});
  const payload=ctx.buildExportPayload("07");
  assert.equal(payload.boxNumberList.length,3);
  const a=payload.p2Sheets[0].data.find(r=>r["箱番号"]==="A-1"),b=payload.p2Sheets[0].data.find(r=>r["箱番号"]==="B-1");
  assert.equal(a["NET重量合計(kg)"],5);assert.equal(b["NET重量合計(kg)"],2.5);
  assert.equal(a["グロス重量(kg)"],6);assert.equal(b["グロス重量(kg)"],3);
  assert.equal(a["ドライアイス重量(kg)"],1);assert.equal(b["ドライアイス重量(kg)"],"");
  assert.equal(payload.p1data.filter(r=>r["ケース番号"]==="A-1"&&r["グロス重量"]===6).length,1);
  assert.equal(ctx.boxToPayload("07","B-1",ctx.boxMap["07"]["B-1"]).box_no,"B-1");
  const restored=ctx.orderLineToLocalRow(ctx.rowToOrderLinePayload(ctx.rows[0]));assert.equal(restored._box,"A-1");
});

test("supplier lookup never guesses from product or customer and never collapses source lines",()=>{
  const records=[{id:"1",supplier_code:"wrong"},{id:"2"},{id:"3"}];
  const routed=box.routeRows(records,[{id:"1",supplier_code:"S01"},{id:"2",supplier_code:"S02"}],
    [{supplier_code:"S01",box_prefix:" Ａ- "},{supplier_code:"S02",box_prefix:"B"}],"id");
  assert.deepEqual(routed.map(r=>r._boxRouting.prefix),["A","B",""]);
  assert.equal(routed.length,records.length);assert.ok(routed[2]._boxRouting.error);
  assert.equal(records[0]._boxRouting,undefined);
});

test("sales snapshots and Excel files retain full box labels and independent weights",async()=>{
  const {ctx}=runtime([row(0,"A","A-1"),row(1,"B","B-1"),row(2,"A","A-1")]);
  ctx.buildP2();ctx.boxMap["07"]["A-1"].gross="6";ctx.boxMap["07"]["B-1"].gross="3";
  ctx.currentWorkDateValue=()=>"2026-09-24";ctx.roundJpyAmount=Math.round;
  vm.runInContext(section("function salesRecordPayloadTrial(","async function finalizeSalesTrial("),ctx);
  assert.equal(ctx.salesRecordPayloadTrial(ctx.rows[0]).box_no,"A-1");
  assert.equal(ctx.salesRecordPayloadTrial(ctx.rows[1]).gross_weight,3);
  assert.equal(ctx.salesRecordPayloadTrial(ctx.rows[0]).site_code,"TYO");
  const ExcelJS=require(process.env.EXCELJS_PATH||"exceljs");
  vm.runInContext(section("function addExcelJsJsonSheet(","function addInvoiceCheckExcelJs("),ctx);
  const payload=ctx.buildExportPayload("07"),workbook=new ExcelJS.Workbook();
  ctx.addExcelJsJsonSheet(workbook,"Boxes",payload.boxNumberList,["箱番号","グロス重量","ドライアイス","箱サイズ"]);
  const restored=new ExcelJS.Workbook();await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet=restored.getWorksheet("Boxes");assert.equal(sheet.rowCount,3);
  assert.equal(sheet.getCell("A2").value,"A-1");assert.equal(sheet.getCell("A3").value,"B-1");
  assert.equal(sheet.getCell("B2").value,6);assert.equal(sheet.getCell("B3").value,3);
});

test("routing reads are chunked, cached for polling and scoped to the signed-in user",async()=>{
  const {ctx}=runtime();const requests=[];
  ctx.supabaseClient={from:table=>({select:columns=>({in:async(key,ids)=>{
    requests.push({table,columns,key,ids});assert.ok(ids.length<=200);
    return {data:table==="order_entry_lines"?ids.map(id=>({id,supplier_code:`S-${id}`})):ids.map(code=>({supplier_code:code,box_prefix:code}))};
  }})})};
  const records=Array.from({length:1201},(_,i)=>({source_order_line_id:`id-${i}`}));
  const first=await ctx.loadWorkBoxRouting(records,"TYO");assert.equal(first.length,1201);assert.ok(first.every(r=>r._boxRouting.prefix));
  const count=requests.length;await ctx.loadWorkBoxRouting(records,"TYO");assert.equal(requests.length,count);
  ctx.currentUser={id:"different"};await ctx.loadWorkBoxRouting(records,"TYO");assert.equal(requests.length,count*2);
  await ctx.loadWorkBoxRouting(records,"OSA");assert.equal(requests.length,count*2);
});

test("routing failures do not stop other work fields, erase stored boxes or cache a failure",async()=>{
  const {ctx}=runtime();let fail=true;
  ctx.supabaseClient={from:table=>({select:()=>({in:async()=>{
    if(fail)return {error:{message:"offline"}};
    return {data:table==="order_entry_lines"?[{id:"1",supplier_code:"S"}]:[{supplier_code:"S",box_prefix:"T"}]};
  }})})};
  const records=[{source_order_line_id:"1",box_no:"OLD-9",input_qty:2}];
  const failed=await ctx.loadWorkBoxRouting(records,"TYO");assert.equal(failed[0].box_no,"OLD-9");assert.equal(failed[0].input_qty,2);assert.match(failed[0]._boxRouting.error,/offline/);
  fail=false;const recovered=await ctx.loadWorkBoxRouting(records,"TYO");assert.equal(recovered[0]._boxRouting.prefix,"T");
});

test("routing is connected to creation, saved sessions, polling and additional orders without new DB writes",()=>{
  assert.match(app,/loadWorkBoxRouting\(lines,siteCode,"id"\)/);
  assert.match(app,/loadWorkSessionOrderLines\(sessionId,session\.site_code\|\|"OSA"\)/);
  assert.match(app,/r\._boxRouting\?\.prefix,r\._boxRouting\?\.error/);
  assert.match(fs.readFileSync(path.join(root,"work-additional-orders.js"),"utf8"),/loadWorkBoxRouting\(\[data\],currentSessionSiteCode\)/);
  assert.doesNotMatch(routing,/\.upsert\(|\.update\(|\.insert\(|\.delete\(|\.rpc\(/);
});

if(process.env.WORK_BOX_PREVIEW){
  const {ctx}=runtime([row(0,"A"),row(1,"B"),row(2,"A","A-12"),row(3,"B","1"),row(4,"")]);
  const style=app.match(/<style>([\s\S]*?)<\/style>/)[1]+fs.readFileSync(path.join(root,"work-box-number.css"),"utf8");
  const functions=section("function sanitizeInlineNumber(","function inlineP1MemoInput(")+section("function updateInlineP1Draft(","function updateInlineP1MemoDraft(")+section("function commitInlineP1Field(","function commitInlineP1Memo(");
  const script=`const rows=${JSON.stringify(ctx.rows)};let currentSessionSiteCode='TYO';const P1_KEY={qty:'_qty',net:'_net',box:'_box'};const esc=${esc.toString()};function saveOrderLineToSupabase(){document.getElementById('saved').textContent=JSON.stringify(rows.map(r=>r._box))}function scheduleP1InlineRefresh(){} function handleInlineWorkKey(e){if(e.key==='Enter'){e.preventDefault();e.currentTarget.dataset.boxDirty='1';commitInlineP1Field(e.currentTarget);const a=[...document.querySelectorAll('input:not(:disabled)')];a[a.indexOf(e.currentTarget)+1]?.focus()}};${routing}\n${functions}`;
  const body=ctx.rows.map(r=>`<tr><td>${r._idx+1}</td><td>Tokyo Sushi</td><td>養殖真鯛フィレ</td><td>2 Kg</td><td>${ctx.inlineP1Input(r,"qty","数量")}</td><td>${ctx.inlineP1Input(r,"net","NET")}</td><td>${ctx.inlineP1Input(r,"box","箱")}</td></tr>`).join("");
  fs.writeFileSync(process.env.WORK_BOX_PREVIEW,`<!doctype html><html lang="ja"><meta charset="utf-8"><title>東京 箱番号入力確認</title><style>${style}</style><body><main style="padding:16px"><h2>東京 作業入力</h2><table><thead><tr><th>No</th><th>得意先</th><th>商品名</th><th>注文</th><th>数量</th><th>NET</th><th>箱番号</th></tr></thead><tbody>${body}</tbody></table><output id="saved"></output></main><script>${fs.readFileSync(path.join(root,"work-box-number.js"),"utf8")}</script><script>${script}</script></body></html>`);
}
