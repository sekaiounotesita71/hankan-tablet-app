const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
function between(start,end){
  const from=html.indexOf(start),to=html.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,`Missing source: ${start}`);
  return html.slice(from,to);
}
function context(overrides={}){
  const ctx={
    confirmedBatches:[],activeOrderRows:()=>[],currentOrderSiteCode:()=>"TYO",
    val:()=>"",supabaseClient:null,currentUser:null,
    esc:value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"),
    normalizeImporterCode:value=>String(value).replace(/\s/g,"").toUpperCase(),
    getMasters:()=>({importers:[],customers:[{code:"07-001",siteCode:"TYO"}]}),
    ...overrides
  };
  vm.runInNewContext(between("function rowsWithBatchMeta(","function renderReportFilterCount("),ctx);
  vm.runInNewContext(between("function groupedBySupplier(","function openPrintLoadingWindow("),ctx);
  return ctx;
}
const sampleRow={orderDate:"2026-09-09",supplierCode:"10",supplierName:"確認用仕入先",productCode:"002",productName:"養殖真鯛 カマ付きフィレ",englishName:"Farmed red sea bream fillet",qty:2,unit:"Kg",customerCode:"07-001",customerName:"確認用得意先",importerCode:"07",importerName:"JKT",memo:"ウロコ・内臓除去、骨付き。個別真空でお願いします。",siteCode:"TYO"};

test("saved orders keep their site even after the customer master moves to Tokyo",()=>{
  const ctx=context();
  const rows=ctx.rowsWithBatchMeta({siteCode:"OSA",customer:{code:"07-001"},rows:[{...sampleRow,siteCode:"TYO"}]});
  assert.equal(rows[0].siteCode,"OSA");
  assert.equal(ctx.reportSiteName(rows[0]),"大阪");
  assert.equal(ctx.reportSiteName({}),"大阪");
  assert.equal(ctx.reportSiteName({site_code:"TYO"}),"東京");
  assert.equal(ctx.reportSiteName({siteCode:"NEW"}),"NEW");
});

test("current unsaved rows carry the current order site in both report read paths",async()=>{
  const ctx=context({activeOrderRows:()=>[{...sampleRow,siteCode:undefined}],val:id=>id==="order-date"||id==="report-filter-date"?"2026-09-09":""});
  assert.equal(ctx.printableRows()[0].siteCode,"TYO");
  assert.equal((await ctx.reportRowsForPrint())[0].siteCode,"TYO");
  ctx.supabaseClient={};ctx.currentUser={id:"user"};
  ctx.loadConfirmedReportBatchesFromDb=async()=>[];
  assert.equal((await ctx.reportRowsForPrint())[0].siteCode,"TYO");
});

test("site filter combines with date, importer and supplier without merging lines",()=>{
  const ctx=context();
  const rows=[sampleRow,{...sampleRow,siteCode:"OSA"},{...sampleRow,supplierCode:"11"},{...sampleRow,importerCode:"01",importerName:"DIM"},{...sampleRow,orderDate:"2026-09-10"}];
  const filter={date:"2026-09-09",importer:"07",supplier:"10",site:"TYO"};
  assert.equal(ctx.filterReportRows(rows,filter).length,1);
  assert.equal(ctx.filterReportRows(rows,{...filter,site:""}).length,2);
  assert.equal(ctx.filterReportRows(rows,{date:"2026-09-09"}).length,4);
  assert.equal(ctx.filterReportRows(rows,{...filter,date:""}).length,0);
});

test("purchase orders omit site labels without changing supplier grouping or product order",()=>{
  const ctx=context();
  const rows=[{...sampleRow,productCode:"010"},{...sampleRow,productCode:"002",siteCode:"OSA",importerCode:"01",importerName:"DIM"}];
  assert.equal(ctx.groupedBySupplier(rows).size,1);
  const page=ctx.purchaseOrderPage("10 確認用仕入先",rows,1);
  assert.doesNotMatch(page,/拠点|po-site|大阪|東京/);
  assert.equal((page.match(/<th>/g)||[]).length,6);
  assert.equal((page.match(/<td>/g)||[]).length,12);
  assert.ok(page.indexOf("<td>002</td>")<page.indexOf("<td>010</td>"));
  assert.equal((page.match(/<tr><td>/g)||[]).length,2);
  assert.equal(rows[0].siteCode,"TYO");
  assert.equal(rows[0].productCode,"010");
});

test("picking tickets omit site labels and keep the same importer color and contents",()=>{
  const ctx=context();
  const tokyo=ctx.ticketHtml(sampleRow),osaka=ctx.ticketHtml({...sampleRow,siteCode:"OSA"});
  assert.equal(tokyo,osaka);
  assert.doesNotMatch(tokyo,/拠点|ticket-site|大阪|東京/);
  assert.match(tokyo,/--ticket-main:#d71920/);
  assert.match(tokyo,/Farmed red sea bream fillet/);
  assert.match(ctx.ticketHtml({...sampleRow,productName:"<sample>"}),/&lt;sample&gt;/);
});

test("printing and supplier review preserve every selected row but do not print site metadata",async()=>{
  const outputs=[];
  const ctx=context({
    openPrintLoadingWindow:()=>({close:()=>{throw new Error("unexpected close")}}),
    setAppBusy:()=>{},openPrintDoc:(title,output)=>outputs.push({title,output}),
    dbErrorMessage:error=>error.message,alert:message=>{throw new Error(message)}
  });
  const rows=Array.from({length:9},(_,i)=>({...sampleRow,lineId:`line-${i}`,productCode:String(i+1).padStart(3,"0"),siteCode:i%2?"OSA":"TYO"}));
  ctx.reportRowsForPrint=async()=>rows;
  await ctx.printPurchaseOrders();
  await ctx.printPickingTickets();
  assert.equal((outputs[0].output.match(/<tr><td>/g)||[]).length,9);
  assert.equal((outputs[1].output.match(/<section class="ticket-page">/g)||[]).length,2);
  assert.equal((outputs[1].output.match(/class="ticket"/g)||[]).length,9);
  vm.runInNewContext(between("async function printSupplierReviewPurchaseOrder(","async function setSupplierReviewOrdered("),ctx);
  ctx.supabaseClient={};ctx.currentUser={id:"user"};
  ctx.supplierReviewGroups=[{rows:[{line_id:"line-0",order_date:"2026-09-09",supplier_decision_status:"confirmed",supplier_code:"10",supplier_name_snapshot:"確認用仕入先"}]}];
  ctx.loadConfirmedReportBatchesFromDb=async()=>[{siteCode:"TYO",rows}];
  await ctx.printSupplierReviewPurchaseOrder(0);
  assert.equal((outputs[2].output.match(/<tr><td>/g)||[]).length,1);
  outputs.forEach(({output})=>assert.doesNotMatch(output,/作業拠点|po-site|ticket-site|<th>拠点<\/th>/));
  assert.equal(rows[0].siteCode,"TYO");
});

test("site selection triggers report count refresh",()=>{
  assert.match(html,/id="report-filter-site"/);
  assert.match(html,/\["report-filter-date","report-filter-importer","report-filter-supplier","report-filter-site"\]\.forEach/);
});

if(process.env.REPORT_SITE_PREVIEW_DIR){
  const ctx=context(),out=path.resolve(process.env.REPORT_SITE_PREVIEW_DIR);
  fs.mkdirSync(out,{recursive:true});
  const rows=Array.from({length:8},(_,i)=>({...sampleRow,productCode:String(i+1).padStart(3,"0"),siteCode:i%2?"OSA":"TYO",customerName:i%2?"Sushi Osaka Central":"Tokyo Sushi Restaurant",productName:i%3?sampleRow.productName:"冷凍天然車海老ホール（20g以上・真空パック）"}));
  const preview=(title,content)=>`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><style>@media screen{body{width:194mm;margin:8mm auto!important}}</style></head><body>${content}</body></html>`;
  fs.writeFileSync(path.join(out,"purchase-order.html"),preview("拠点表示・発注書確認",ctx.purchaseOrderCss()+ctx.purchaseOrderPage("10 確認用仕入先",rows,1)),"utf8");
  fs.writeFileSync(path.join(out,"picking-tickets.html"),preview("拠点表示・現品票確認",ctx.ticketCss()+`<section class="ticket-page">${rows.map(ctx.ticketHtml).join("")}</section>`),"utf8");
}
