const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
function sourceBetween(start,end){
  const from=html.indexOf(start),to=html.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from);
  return html.slice(from,to);
}
function reader(rows,failedOffset=-1){
  const requests=[];
  const context={
    receivableOperationStartDate:"2026-08-01",
    val:()=>"",
    initSupabase:()=>({from(table){
      assert.equal(table,"sales_records");
      const filters=[];
      return {
        select(){return this},order(){return this},
        gte(field,value){filters.push(["gte",field,value]);return this},
        lte(field,value){filters.push(["lte",field,value]);return this},
        async range(from,to){
          requests.push({from,to,filters});
          if(from===failedOffset)return {data:null,error:new Error("page unavailable")};
          return {data:rows.slice(from,to+1),error:null};
        }
      };
    }})
  };
  vm.runInNewContext(sourceBetween("async function arReadSalesRows(","async function syncSalesToReceivables("),context);
  return {context,requests};
}
test("excluded domestic rows do not truncate August receivable sales",async()=>{
  const rows=Array.from({length:2501},(_,id)=>({id,amount:100,session_id:`work-${Math.floor(id/250)}`,revenue_recognition_mode:id%101===0?"customs_only":"direct_export"}));
  const {context,requests}=reader(rows);
  const result=await context.arReadSalesRows({from:"2026-08-01",to:"2026-08-31"});
  const expected=rows.filter(row=>row.revenue_recognition_mode!=="customs_only");
  assert.deepEqual(Array.from(result,row=>row.id),expected.map(row=>row.id));
  assert.equal(new Set(result.map(row=>row.session_id)).size,11);
  assert.equal(result.reduce((sum,row)=>sum+row.amount,0),expected.length*100);
  assert.deepEqual(requests.map(row=>row.from),[0,1000,2000]);
  for(const request of requests)assert.deepEqual(request.filters,[["gte","work_date","2026-08-01"],["lte","work_date","2026-08-31"]]);
});
test("a fully excluded first page still loads later export work",async()=>{
  const rows=Array.from({length:1002},(_,id)=>({id,revenue_recognition_mode:id<1000?"customs_only":null}));
  const {context}=reader(rows);
  assert.deepEqual(Array.from(await context.arReadSalesRows({from:"2026-08-01",to:"2026-08-31"}),row=>row.id),[1000,1001]);
});
test("an excluded page boundary continues and a later failure rejects partial totals",async()=>{
  const rows=Array.from({length:2001},(_,id)=>({id,revenue_recognition_mode:id===999?"customs_only":"direct_export"}));
  const {context}=reader(rows,1000);
  await assert.rejects(()=>context.arReadSalesRows({from:"2026-08-01",to:"2026-08-31"}),/page unavailable/);
});
test("pre-cutover sales are never read into receivables",async()=>{
  const {context,requests}=reader([]);
  assert.equal((await context.arReadSalesRows({from:"2026-07-01",to:"2026-07-31"})).length,0);
  assert.equal(requests.length,0);
  await context.arReadSalesRows({from:"2026-07-01",to:"2026-08-31"});
  assert.deepEqual(requests[0].filters[0],["gte","work_date","2026-08-01"]);
});

function sameImporter(a,b){
  const code=value=>String(typeof value==="object"?value.importer_code:value).replace(/^0+/,"");
  return code(a)===code(b);
}
test("one closing synchronizes only its selected importer",async()=>{
  const inserted=[];
  const context={
    receivableOperationStartDate:"2026-08-01",
    currentUser:{id:"user"},document:{getElementById:()=>({textContent:""})},
    val:id=>id==="ar-importer"?"02":"202608",
    arCanonicalImporterCode:code=>code,arSameImporter:sameImporter,
    ensureCurrentUser:async()=>({id:"user"}),loadReceivableSettings:async()=>{},
    setAppBusy:()=>{},arReadSalesRows:async()=>[],arReadAll:async()=>[],
    arBuildSalesGroups:()=>["01","02"].map(importerCode=>({sessionId:`work-${importerCode}`,importerCode,invoiceDate:"2026-08-03",customers:new Set(),netSales:100,shipping:10,amount:110})),
    arInvoiceNumber:()=>"invoice",loadReceivables:async()=>{},
    alert:message=>{throw new Error(message)},arDbErrorMessage:error=>error.message,
    initSupabase:()=>({from(table){assert.equal(table,"accounts_receivable");return {
      upsert(chunk){inserted.push(...chunk);return {select:async()=>({data:chunk.map(row=>({source_key:row.source_key})),error:null})}}
    }}})
  };
  vm.runInNewContext(sourceBetween("async function syncSalesToReceivables(","async function saveOpeningReceivable("),context);
  assert.equal(await context.syncSalesToReceivables({from:"2026-08-01",to:"2026-08-31",importerCode:"01"}),true);
  assert.deepEqual(inserted.map(row=>row.importer_code),["01"]);
  assert.equal(inserted[0].amount_jpy,110);
});

test("closing checks individual work even when total amounts happen to match",()=>{
  const context={arSameImporter:sameImporter,arNumber:value=>Number(value)||0};
  vm.runInNewContext(sourceBetween("function arClosingSalesMismatch(","async function closeAccountsReceivablePeriod("),context);
  const groups=["a","b"].map(sessionId=>({sessionId,importerCode:"01",invoiceDate:"2026-08-03",sessionName:sessionId,netSales:100,shipping:10,amount:110}));
  const charges=groups.map(group=>({id:group.sessionId,source_type:"sales",source_session_id:group.sessionId,importer_code:"01",invoice_date:group.invoiceDate,net_sales_jpy:100,shipping_amount_jpy:10,amount_jpy:110}));
  assert.equal(context.arClosingSalesMismatch(groups,charges),"");
  assert.notEqual(context.arClosingSalesMismatch(groups,[charges[0]]),"");
  assert.notEqual(context.arClosingSalesMismatch(groups,[charges[0],{...charges[0],id:"duplicate"}]),"");
  assert.notEqual(context.arClosingSalesMismatch(groups,[{...charges[0],net_sales_jpy:90,amount_jpy:100},{...charges[1],net_sales_jpy:110,amount_jpy:120}]),"");
  assert.notEqual(context.arClosingSalesMismatch(groups,[{...charges[0],net_sales_jpy:90,shipping_amount_jpy:20},charges[1]]),"");
  assert.equal(context.arClosingSalesMismatch([...groups,{amount:0}],charges),"");
  assert.equal(context.arClosingSalesMismatch(groups,[...charges,{source_type:"adjustment",amount_jpy:-50}]),"");
});
