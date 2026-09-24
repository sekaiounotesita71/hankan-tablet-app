const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");
const report=require("../supplier-work-report.js");
const sample={orderDate:"2026-09-18",supplierCode:"10",supplierName:"確認用問屋",importerCode:"07",importerName:"JKT",customerCode:"07001",customerName:"EDO",productCode:"0010",productName:"養殖真鯛フィレ",memo:"個別真空",qty:2.5,unit:"Kg",siteCode:"TYO",unitPrice:987654321,englishName:"secret sale name",lineId:"private-id",purchaseUnitPrice:87654321};
const settings={suppliers:[{code:"10",name:"確認用問屋",boxPrefix:"IYH"}],destination:"東京 集荷場所",contact:"出荷担当",note:"鱗・内臓を除去"};

test("new controls sit next to both report entry points without removing old reports",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
  assert.equal((html.match(/onclick="printSupplierWorkStatements\(\)"/g)||[]).length,2);
  assert.equal((html.match(/onclick="exportSupplierWorkStatements\(\)"/g)||[]).length,2);
  assert.ok(html.includes('onclick="printPurchaseOrders()"'));
  assert.ok(html.includes('onclick="printPickingTickets()"'));
});
test("supplier filter is exact, never a partial code that includes another supplier",()=>{
  const rows=[sample,{...sample,supplierCode:"110"},{...sample,supplierCode:"10A"}];
  assert.deepEqual(report.selectSupplier(rows,"１０"),[sample]);
  assert.deepEqual(report.selectSupplier(rows,"ALL"),rows);
  assert.throws(()=>report.selectSupplier(rows,"確認"),/発注先コード/);
  assert.throws(()=>report.selectSupplier(rows,"確認用問屋"),/発注先コード/);
});
test("separates suppliers, importers and sites; does not combine duplicate products or same-name customers",()=>{
  const rows=[sample,{...sample,productCode:"0002"},{...sample},{...sample,customerCode:"07002"},
    {...sample,importerCode:"01"},{...sample,siteCode:"OSA"},{...sample,supplierCode:"11"}];
  const before=JSON.stringify(rows);const model=report.build(rows,settings);
  assert.equal(model.suppliers.length,2);assert.equal(model.suppliers[0].groups.length,3);
  const tokyo=model.suppliers[0].groups.find(g=>g.importerCode==="07"&&g.siteCode==="TYO");
  assert.deepEqual(tokyo.rows.map(r=>r.productCode),["0002","0010","0010","0010"]);
  assert.deepEqual(tokyo.rows.map(r=>r.customerCode),["07001","07001","07001","07002"]);
  assert.equal(model.rowCount,7);assert.equal(JSON.stringify(rows),before);
});
test("keeps customers together, repeats continuation pages and retains more than 1000 lines",()=>{
  const rows=Array.from({length:1507},(_,i)=>({...sample,customerCode:`C${Math.floor(i/7)}`,productCode:String(i)}));
  const model=report.build(rows,settings),group=model.suppliers[0].groups[0];
  assert.equal(group.pages.flat().length,1507);assert.equal(new Set(group.pages.flat().map(r=>r.sequence)).size,1507);
  assert.ok(group.pages.every(p=>p.length<=12&&p.length>0));
  const long=report.build(Array.from({length:25},()=>sample),settings).suppliers[0].groups[0];
  assert.deepEqual(long.pages.map(p=>p.length),[12,12,1]);
});
test("print whitelist excludes sale prices and private fields even in embedded JSON",()=>{
  const model=report.build([{...sample,memo:"個別真空 / 価格候補: 987654321 / 123456789"}],settings);
  const html=report.printableDocument(model,"https://example.test/supplier-work-report.js");
  for(const value of ["987654321","87654321","123456789","unitPrice","englishName","private-id","販売単価"])assert.ok(!html.includes(value),value);
  assert.ok(html.includes("仕入単価"));assert.ok(html.includes("IYH-"));assert.ok(html.includes("個別真空"));
  assert.ok(html.includes("グロス重量 kg"));assert.ok(html.includes("A4 landscape"));
  assert.deepEqual(report.cellValues(model.suppliers[0].groups[0].rows[0]).slice(7),Array(7).fill(""));
});
test("escapes supplied names/notes and refuses incomplete routing rather than omitting rows",()=>{
  const model=report.build([{...sample,productName:'<script>alert("x")</script>'}],{note:"<img src=x onerror=bad()>"});
  const html=report.printableDocument(model,"/supplier-work-report.js");
  assert.ok(html.includes("&lt;script&gt;"));assert.ok(!html.includes('<script>alert("x")'));
  for(const field of ["supplierCode","importerCode","customerName","productName","orderDate"])assert.throws(()=>report.build([{...sample,[field]:""}],settings),/未設定/);
  assert.throws(()=>report.build([],settings),/ありません/);
});

let ExcelJS;
if(process.env.EXCELJS_PATH)ExcelJS=require(process.env.EXCELJS_PATH);
else{try{ExcelJS=require("exceljs")}catch{}}
test("xlsx roundtrip retains exact rows, leading zeros, decimals, editable cells and supplier isolation",{skip:!ExcelJS},async()=>{
  const rows=[sample,{...sample},{...sample,productCode:"0002",productName:"=NO_FORMULA()"},{...sample,supplierCode:"11",supplierName:"別の問屋",productName:"他社限定商品"}];
  const model=report.build(rows,settings);const original=report.createWorkbook(ExcelJS,model.suppliers[0],model.options);
  const buffer=await original.xlsx.writeBuffer();const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(buffer);
  assert.equal(loaded.worksheets.length,1);const sheet=loaded.worksheets[0];
  assert.equal(sheet.getCell("C10").value,"0002");assert.equal(sheet.getCell("C10").numFmt,"@");
  assert.equal(sheet.getCell("D10").value,"=NO_FORMULA()");assert.equal(sheet.getCell("D10").type,3);
  assert.equal(sheet.getCell("F10").value,2.5);assert.ok(sheet.getCell("I2").value instanceof Date);
  assert.equal(sheet.getCell("M10").value,null);assert.equal(sheet.getCell("M10").dataValidation.type,"decimal");
  assert.equal(sheet.getCell("N10").dataValidation.formulae[0],'"Kg,pkt,PC,CS"');assert.equal(sheet.views[0].ySplit,9);
  assert.equal(sheet.pageSetup.orientation,"landscape");assert.equal(sheet.pageSetup.printTitlesRow,"1:9");
  const values=[];sheet.eachRow(row=>row.eachCell(cell=>values.push(cell.value)));
  const serialized=JSON.stringify(values);for(const secret of ["987654321","87654321","他社限定商品","別の問屋"])assert.ok(!serialized.includes(secret),secret);
  assert.equal(values.filter(v=>v==="0010").length,2);
  if(process.env.WORK_REPORT_PREVIEW_DIR){fs.mkdirSync(process.env.WORK_REPORT_PREVIEW_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.WORK_REPORT_PREVIEW_DIR,"sample.xlsx"),buffer)}
});

function adapterContext(overrides={}){
  const alerts=[],busy=[],outputs=[];const filter={date:"2026-09-18",supplier:"10"};
  const popup={closed:false,close(){this.closed=true},document:{open(){},write(value){outputs.push(value)},close(){}}};
  const context={window:{},SupplierWorkReport:report,URL,Blob,setTimeout,clearTimeout,
    document:{getElementById:()=>null},location:{href:"https://example.test/order-entry-beta"},
    reportFilter:()=>filter,getMasters:()=>settings,reportRowsForPrint:async()=>[sample],SupplierWorkProfilesApp:{read:async()=>[]},
    openPrintLoadingWindow:()=>popup,setAppBusy:(...args)=>busy.push(args),alert:message=>alerts.push(message),...overrides};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","supplier-work-report-app.js"),"utf8"),context);
  return {context,filter,popup,alerts,busy,outputs};
}
function guardedDownloadContext(overrides={}){
  const blobs=[],names=[],listeners=[];
  class DownloadURL extends URL{static createObjectURL(blob){blobs.push(blob);return "blob:test"}static revokeObjectURL(){}}
  const state=adapterContext({URL:DownloadURL,appBusy:false,
    document:{getElementById:()=>null,body:{append(){}},addEventListener(type,listener){listeners.push(listener)},createElement:()=>({remove(){},click(){
      const event={preventDefault(){this.defaultPrevented=true},stopImmediatePropagation(){}};
      for(const listener of listeners)listener(event);
      if(!event.defaultPrevented)names.push(this.download);
    }})},
    setTimeout:(fn,ms)=>{const handle=setTimeout(fn,ms);handle.unref();return handle},...overrides});
  state.context.setAppBusy=(active)=>{state.context.appBusy=active;state.busy.push([active])};
  const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
  const guard=html.match(/document\.addEventListener\("click",e=>\{\s*if\(!appBusy\)return;[\s\S]*?\},true\);/);
  assert.ok(guard,"use the production busy click guard so downloads cannot bypass it in tests");
  vm.runInNewContext(guard[0],state.context);
  return {...state,blobs,names};
}
test("double click is blocked during loading and export does not mutate DB or masters",async()=>{
  let resolve,calls=0;const pending=new Promise(r=>{resolve=r});
  const state=adapterContext({reportRowsForPrint:()=>{calls++;return pending}});
  const first=state.context.window.printSupplierWorkStatements();await state.context.window.printSupplierWorkStatements();
  assert.equal(calls,1);resolve([sample]);await first;
  assert.equal(state.outputs.length,1);assert.equal(state.alerts.length,0);assert.deepEqual(state.busy.at(-1),[false]);
  const source=fs.readFileSync(path.join(__dirname,"..","supplier-work-report-app.js"),"utf8");
  assert.doesNotMatch(source,/\.from\(|\.rpc\(|\.upsert\(|localStorage\.setItem/);
});
test("missing date, changed filters, empty result and network failure release busy state",async()=>{
  const none=adapterContext({reportFilter:()=>({date:""})});await none.context.window.printSupplierWorkStatements();assert.equal(none.busy.length,0);assert.match(none.alerts[0],/日付/);
  const empty=adapterContext({reportRowsForPrint:async()=>[]});await empty.context.window.printSupplierWorkStatements();assert.equal(empty.popup.closed,true);assert.deepEqual(empty.busy.at(-1),[false]);
  const failed=adapterContext({reportRowsForPrint:async()=>{throw new Error("network")}});await failed.context.window.printSupplierWorkStatements();assert.deepEqual(failed.alerts,["network"]);
  const profileFailed=adapterContext({SupplierWorkProfilesApp:{read:async()=>{throw new Error("設定を取得できません")}}});await profileFailed.context.window.printSupplierWorkStatements();assert.deepEqual(profileFailed.alerts,["設定を取得できません"]);assert.equal(profileFailed.outputs.length,0);assert.deepEqual(profileFailed.busy.at(-1),[false]);
  const changed=adapterContext();changed.context.reportRowsForPrint=async()=>{changed.filter.supplier="11";return [sample]};await changed.context.window.printSupplierWorkStatements();assert.match(changed.alerts[0],/条件が変更/);assert.equal(changed.outputs.length,0);
});
test("Excel button produces a separate workbook for each supplier inside one ZIP",{skip:!ExcelJS},async()=>{
  const JSZip=require(require.resolve("jszip",{paths:[process.env.EXCELJS_PATH||__dirname]}));
  const state=guardedDownloadContext({window:{ExcelJS,JSZip},
    reportFilter:()=>({date:"2026-09-18",supplier:""}),
    reportRowsForPrint:async()=>[sample,{...sample,supplierCode:"11",supplierName:"別の問屋",productName:"他社限定商品"}]
  });
  const {blobs,names}=state;
  await state.context.window.exportSupplierWorkStatements();assert.deepEqual(state.alerts,[]);assert.equal(names.length,1);assert.match(names[0],/\.zip$/);
  const zip=await JSZip.loadAsync(await blobs[0].arrayBuffer());const files=Object.values(zip.files).filter(f=>!f.dir);assert.equal(files.length,2);
  for(const [index,file] of files.entries()){
    const book=new ExcelJS.Workbook();await book.xlsx.load(await file.async("nodebuffer"));const sheet=book.worksheets[0];
    assert.equal(sheet.getCell("D10").value,index===0?sample.productName:"他社限定商品");assert.equal(sheet.getCell("A11").value,"箱別重量　箱記号 "+(index===0?"IYH-":""));
    assert.equal(sheet.getCell("M10").value,null);
  }
});

test("single supplier Excel downloads after the busy guard is released and ignores repeat clicks while generating",{skip:!ExcelJS},async()=>{
  let resolve,calls=0;const pending=new Promise(r=>{resolve=r});
  const state=guardedDownloadContext({window:{ExcelJS},reportRowsForPrint:()=>{calls++;return pending}});
  const first=state.context.window.exportSupplierWorkStatements();
  assert.equal(state.context.appBusy,true);await state.context.window.exportSupplierWorkStatements();assert.equal(calls,1);
  resolve([sample]);await first;
  assert.deepEqual(state.alerts,[]);assert.equal(state.names.length,1);assert.match(state.names[0],/\.xlsx$/);
  assert.equal(state.context.appBusy,false);
  const book=new ExcelJS.Workbook();await book.xlsx.load(await state.blobs[0].arrayBuffer());
  assert.equal(book.worksheets[0].getCell("D10").value,sample.productName);
  await state.context.window.exportSupplierWorkStatements();assert.equal(state.names.length,2);
});

if(process.env.WORK_REPORT_PREVIEW_DIR){
  const dir=process.env.WORK_REPORT_PREVIEW_DIR;fs.mkdirSync(dir,{recursive:true});
  const rows=Array.from({length:26},(_,i)=>({...sample,productCode:String(i+1).padStart(4,"0"),customerCode:i<8?"07001":"07002",customerName:i<8?"EDO":"Sushi Tokyo Central",productName:i%3?sample.productName:"冷凍天然車海老ホール（20g以上・真空パック）",memo:i%4?sample.memo:"ウロコ・内臓除去、骨付き。個別真空でお願いします。"}));
  fs.writeFileSync(path.join(dir,"preview.html"),report.printableDocument(report.build(rows,settings),"/hankan_site_partner_20260804/supplier-work-report.js"));
  const app=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
  const styles=app.match(/<style>([\s\S]*?)<\/style>/)[1];
  const panel=app.slice(app.lastIndexOf("<section",app.indexOf('id="report-output-panel"')),app.indexOf("</section>",app.indexOf('id="report-output-panel"'))+10);
  const fixture=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><script src="/hankan_site_partner_20260804/supplier-work-report.js" defer></script><script src="/hankan_site_partner_20260804/supplier-work-report-app.js" defer></script></head><body><main style="padding:16px"><h1>帳票出力 動作確認用</h1>${panel}<p id="busy"></p></main><script>
  const demoRows=${JSON.stringify(rows)};
  function reportFilter(){return {date:document.getElementById('report-filter-date').value,supplier:document.getElementById('report-filter-supplier').value,importer:document.getElementById('report-filter-importer').value,site:document.getElementById('report-filter-site').value}}
  function getMasters(){return ${JSON.stringify(settings)}}
  async function reportRowsForPrint(){return demoRows}
  function openPrintLoadingWindow(){return window.open('','_blank')}
  function setAppBusy(active){document.getElementById('busy').textContent=active?'作成中':'完了'}
  document.getElementById('report-filter-date').value='2026-09-18';
  </script></body></html>`;
  fs.writeFileSync(path.join(dir,"controls.html"),fixture);
}
