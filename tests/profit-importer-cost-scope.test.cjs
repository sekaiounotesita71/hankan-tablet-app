const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const policy=require('../purchase-cost-scope.js');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b)}
function fixture(values={}){
  const masters=[{code:'01',name:'DIM',aliases:['DIM Fresh','AMB']},{code:'03',name:'FBI',aliases:['AMB']}];
  const ctx={PurchaseCostScope:policy,profitReferenceCostScopes:[],profitReferenceImporterMasters:null,val:id=>values[id]||'',
    getMasters:()=>({importers:masters}),salesRefNum:v=>Number(v)||0,
    salesRefMoney:v=>String(v),esc:v=>String(v),salesRefRowImporter:r=>({code:r.importer_code}),
    salesRefImporterIdentity:code=>({label:code+' / '+(masters.find(m=>m.code===code)?.name||''),search:(code+' '+(masters.find(m=>m.code===code)?.name||'')).toLowerCase()})};
  vm.createContext(ctx);
  vm.runInContext(section('function profitReferenceCostDetailFilterActive','function salesRefProfitAnalysisHtml'),ctx);
  vm.runInContext(section('async function profitReferenceReadCostScopes','async function loadProfitReferenceBoard'),ctx);
  return ctx;
}
const costs=[{scope:'importer',importer_code:'01',amount:600,line_count:2},
  {scope:'importer',importer_code:'03',amount:200,line_count:1},
  {scope:'shared',amount:100,line_count:1},{scope:'unassigned',amount:50,line_count:1},
  {scope:'domestic',amount:100,line_count:1},{scope:'fees',amount:20,line_count:1}];
test('importer estimates subtract only assigned purchases, including direct purchases and credits',()=>{
  const ctx=fixture();
  const result=ctx.profitReferenceImporterEstimates([{importer_code:'01',amount:1000},{importer_code:'01',amount:-100},
    {importer_code:'DOMESTIC',_domesticSale:true,amount:300}],costs);
  assert.equal(result.rows.find(r=>r.importerCode==='01').grossProfit,300);
  assert.equal(result.rows.find(r=>r.importerCode==='03').grossProfit,-200);
  assert.equal(result.rows.find(r=>r.scope==='domestic').grossProfit,200);
  assert.equal(result.shared.amount,100);assert.equal(result.unassigned.amount,50);assert.equal(result.fees.amount,20);
  assert.equal(result.totalCost,1070);
});
test('importer filter selects matching costs but shared values stay visible and unallocated',()=>{
  const ctx=fixture({'profit-ref-importer':'DIM'});
  const result=ctx.profitReferenceImporterEstimates([{importer_code:'01',amount:1000}],costs);
  assert.equal(result.rows.some(r=>r.importerCode==='03'),false);
  assert.equal(result.rows.find(r=>r.importerCode==='01').grossProfit,400);
  assert.equal(result.shared.amount,100);
});
test('product/customer detail filters cannot subtract whole-importer purchases from a subset',()=>{
  for(const field of ['profit-ref-customer','profit-ref-product','profit-ref-search']){
    const ctx=fixture({[field]:'test'});
    assert.match(ctx.profitReferenceImporterEstimateHtml([],costs),/絞り込みを解除/);
    assert.doesNotMatch(ctx.profitReferenceImporterEstimateHtml([],costs),/<table/);
  }
});
test('domestic intermediary revenue remains in its importer, not the general domestic bucket',()=>{
  const ctx=fixture();
  const result=ctx.profitReferenceImporterEstimates([{importer_code:'01',_domesticSale:true,amount:700}],costs);
  assert.equal(result.rows.find(r=>r.importerCode==='01').sales,700);
  assert.equal(result.rows.find(r=>r.scope==='domestic').sales,0);
  assert.match(html,/importer_code:sale\.source_type==="export_intermediary"\?sale\.source_importer_code/);
});
test('summary RPC is period/site scoped, read only and does not swallow DB errors',async()=>{
  const ctx=fixture({'profit-ref-site':'TOKYO'});let args;
  const client={async rpc(name,p){assert.equal(name,'get_purchase_cost_scope_summary');args=p;return {data:costs}}};
  const result=await ctx.profitReferenceReadCostScopes(client,{ranges:[{from:'2026-10-01',to:'2026-10-31'}]});
  assert.equal(result,costs);assert.deepEqual(JSON.parse(JSON.stringify(args)),{p_from:'2026-10-01',p_to:'2026-10-31',p_site_code:'TOKYO'});
  const error=new Error('DB failed');await assert.rejects(ctx.profitReferenceReadCostScopes({rpc:async()=>({error})},{ranges:[{}]}),error);
  assert.match(html,/if\(scopeTotal!==purchaseSummary\.cost\)throw new Error/);
});
test('canonical importer filtering includes the same sales and costs for names, aliases and legacy numeric codes',()=>{
  for(const query of ['01','1','DIM','DIM Fresh']){
    const ctx=fixture({'profit-ref-importer':query});
    ctx.profitReferenceRows=[{importer_code:'1',amount:400},{importer_code:'DIM Fresh',amount:600},{importer_code:'03',amount:200}];
    ctx.salesRefIsProvisional=()=>false;
    ctx.salesRefFilteredRows=options=>{assert.equal(options.ignoreImporter,true);return options.rows};
    const filtered=ctx.profitReferenceFilteredRows();
    assert.equal(filtered.length,2,query);
    const result=ctx.profitReferenceImporterEstimates(filtered,costs);
    assert.equal(result.rows.find(r=>r.importerCode==='01').grossProfit,400,query);
    assert.equal(result.rows.some(r=>r.importerCode==='03'),false,query);
  }
  assert.match(html,/const importer=options\.ignoreImporter\?"":val\("sales-ref-importer"\)/);
});
test('ambiguous raw sale aliases do not inherit cached first-match master classification',()=>{
  const ctx=fixture();
  const row={importer_code:'AMB',_sales_importer_code:'01',_sales_importer_key:'master:01',amount:1000};
  assert.equal(ctx.profitReferenceSaleScope(row).scope,'unassigned');
  const result=ctx.profitReferenceImporterEstimates([row],costs);
  assert.equal(result.rows.find(r=>r.scope==='unassigned').sales,1000);
  assert.equal(result.rows.find(r=>r.importerCode==='01').sales,0);
});
test('inactive importers keep historical revenue and purchase attribution without changing active input masters',()=>{
  const ctx=fixture({'profit-ref-importer':'09'});
  ctx.profitReferenceImporterMasters=[...ctx.getMasters().importers,{code:'09',name:'OLD',aliases:['Old Importer'],isActive:false}];
  ctx.profitReferenceRows=[{importer_code:'Old Importer',amount:1000}];
  ctx.salesRefIsProvisional=()=>false;ctx.salesRefFilteredRows=options=>options.rows;
  const result=ctx.profitReferenceImporterEstimates(ctx.profitReferenceFilteredRows(),[{scope:'importer',importer_code:'09',amount:600,line_count:1}]);
  assert.equal(result.rows.find(r=>r.importerCode==='09').grossProfit,400);
  assert.equal(ctx.profitReferenceImporterLabel('09'),'09 / OLD');
  assert.equal(ctx.getMasters().importers.some(m=>m.code==='09'),false);
  const read=section('async function profitReferenceReadImporterMasters','async function loadProfitReferenceBoard');
  assert.doesNotMatch(read,/\.eq\("is_active"|\.insert\(|\.update\(|localStorage|saveCustomMaster/);
});
