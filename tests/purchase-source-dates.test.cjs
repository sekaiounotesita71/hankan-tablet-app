const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const app=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(start,end){
  const a=app.indexOf(start),b=app.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start);
  return app.slice(a,b);
}
function fixture(overrides={}){
  const calls=[],cells=new Map();
  const ctx={dbReady:true,supabaseClient:{from(table){
    assert.equal(table,'sales_records');
    return {select(fields){assert.equal(fields,'id,work_date');return this},async in(field,ids){
      assert.equal(field,'id');calls.push([...ids]);
      return {data:ids.map(id=>({id,work_date:'2026-09-03'}))};
    }};
  }},currentUser:{id:'user'},advancePurchaseRows:[],advancePurchaseDatesLoading:false,
    document:{querySelector(selector){if(!cells.has(selector))cells.set(selector,{});return cells.get(selector)}},
    saveAdvancePurchaseDraft:()=>calls.push('save'),console:{warn:()=>{}},...overrides};
  vm.createContext(ctx);
  vm.runInContext(source('function advancePurchaseSourceDatesHtml(', 'function renderAdvancePurchaseRows('),ctx);
  return {ctx,calls,cells};
}
test('source date distinguishes a single date, grouped dates, unknown dates and manual entries',()=>{
  const {ctx}=fixture();
  assert.equal(ctx.advancePurchaseSourceDatesHtml({sourceSalesIds:[]}),'-');
  assert.equal(ctx.advancePurchaseSourceDatesHtml({sourceSalesIds:['a','b'],sourceSaleDates:{a:'2026-09-03',b:'2026-09-03'}}),'2026/09/03');
  const grouped=ctx.advancePurchaseSourceDatesHtml({sourceSalesIds:['a','b','c'],sourceSaleDates:{a:'2026-09-20',b:'2026-09-03',c:'2026-09-20',unused:'2025-01-01'}});
  assert.match(grouped,/<summary>2026\/09\/03 ～<br>2026\/09\/20/);
  assert.match(grouped,/2日分/);assert.match(grouped,/<span>2026\/09\/03<\/span><span>2026\/09\/20<\/span>/);
  assert.doesNotMatch(grouped,/2025/);
  const unknown=ctx.advancePurchaseSourceDatesHtml({sourceSalesIds:['a','b'],sourceSaleDates:{a:'2026-09-03',b:'<img src=x>'}});
  assert.match(unknown,/2026\/09\/03.*日付未確認 1件/);assert.doesNotMatch(unknown,/<img/);
});
test('old drafts hydrate dates in bounded read-only chunks without repainting inputs',async()=>{
  const row={sourceSalesIds:Array.from({length:451},(_,i)=>`sale-${i}`),actualQty:7.5,unitPrice:1200,note:'keep'};
  const {ctx,calls,cells}=fixture({advancePurchaseRows:[row]});
  await ctx.refreshAdvancePurchaseSourceDates();
  assert.deepEqual(calls.filter(Array.isArray).map(chunk=>chunk.length),[200,200,51]);
  assert.equal(row.sourceSaleDates['sale-450'],'2026-09-03');
  assert.equal(row.actualQty,7.5);assert.equal(row.unitPrice,1200);assert.equal(row.note,'keep');
  assert.deepEqual([...cells.keys()],['[data-advance-source-dates="0"]']);
  assert.equal(cells.values().next().value.innerHTML,'2026/09/03');
  await ctx.refreshAdvancePurchaseSourceDates();
  assert.equal(calls.filter(Array.isArray).length,3);
});
test('failed hydration leaves draft intact and allows retry; signed-out calls do nothing',async()=>{
  const row={sourceSalesIds:['a']};
  const {ctx,calls}=fixture({advancePurchaseRows:[row],dbReady:false});
  await ctx.refreshAdvancePurchaseSourceDates();assert.equal(calls.length,0);
  ctx.dbReady=true;
  const client=ctx.supabaseClient;
  ctx.supabaseClient={from:()=>({select:()=>({in:async()=>({error:{message:'offline'}})})})};
  await ctx.refreshAdvancePurchaseSourceDates();assert.equal(row.sourceSaleDates,undefined);assert.equal(ctx.advancePurchaseDatesLoading,false);
  ctx.supabaseClient=client;
  await ctx.refreshAdvancePurchaseSourceDates();assert.equal(row.sourceSaleDates.a,'2026-09-03');
});
test('late date reads cannot resurrect cleared or duplicated source rows',async()=>{
  let complete;
  const row={sourceSalesIds:['a']};
  const {ctx,cells}=fixture({advancePurchaseRows:[row],supabaseClient:{from:()=>({select:()=>({in:()=>new Promise(resolve=>complete=resolve)})})}});
  const loading=ctx.refreshAdvancePurchaseSourceDates();ctx.advancePurchaseRows=[];
  complete({data:[{id:'a',work_date:'2026-09-03'}]});await loading;
  assert.equal(row.sourceSaleDates,undefined);assert.equal(cells.size,0);
  assert.match(source('function duplicateAdvancePurchaseRow(', 'function removeAdvancePurchaseRow('),/sourceSalesIds:\[\],sourceSaleDates:\{\}/);
  assert.match(source('function setAdvancePurchaseEntryType(', 'function setAdvancePurchaseImportMode('),/row\.sourceSalesIds=\[\];row\.sourceSaleDates=\{\}/);
});
test('monthly import carries each work date without changing grouping, quantity or source links',async()=>{
  const sales=[
    {id:'s1',work_date:'2026-09-03',input_qty:2.5},
    {id:'s2',work_date:'2026-09-20',input_qty:3},
    {id:'s3',work_date:'2026-09-20',input_qty:1},
  ].map(sale=>({...sale,session_id:'session',source_row_no:1,product_id:'001',product_name:'Product',origin:'Osaka',input_unit:'Kg'}));
  for(const mode of ['product','detail']){
    const fields={'advance-purchase-site':'OSA','advance-purchase-supplier':'45','advance-purchase-order-supplier':'45','advance-purchase-date':'2026-09-30','advance-purchase-importer':''};
    let id=0;
    const ctx={dbReady:true,currentUser:{id:'user'},purchaseSourceReviewOpen:false,advancePurchaseRows:[],advancePurchaseImportMode:mode,
      val:key=>fields[key]||'',lookupSupplierByCode:code=>({code}),normalizeImporterCode:value=>value,
      advancePurchaseReferenceRange:()=>({mode:'month',from:'2026-09-01',to:'2026-09-30',label:'2026年09月'}),
      readSalesForAdvancePurchase:async()=>sales,readOrderSuppliersForAdvancePurchase:async()=>new Map([['session|1','45']]),
      readImportedSalesIdsForAdvancePurchase:async()=>new Set(),advancePurchaseSaleSourceKey:row=>`${row.session_id}|${row.source_row_no}`,
      supabaseClient:{from:()=>({select:()=>({in:async()=>({data:[{id:'session',site_code:'OSA'}]})})})},
      document:{getElementById:()=>({value:'',textContent:'',className:''})},setAppBusy:()=>{},alert:message=>{assert.doesNotMatch(message,/失敗/)},
      findMasterProduct:()=>({}),normalizeLineUnit:value=>value,dbNumber:Number,productPurchasePriceForSupplier:()=>({price:1000,unit:'Kg'}),
      newAppUuid:()=>`row-${++id}`,advancePurchaseActiveRows:()=>[],renderAdvancePurchaseRows:()=>{},saveAdvancePurchaseDraft:()=>{},requestAnimationFrame:()=>{},
    };
    vm.createContext(ctx);vm.runInContext(app.match(/function blankAdvancePurchaseRow\(\)\{[^\n]+/)[0],ctx);
    vm.runInContext(source('async function importSalesIntoAdvancePurchase(', 'function updateAdvancePurchaseSummary('),ctx);
    await ctx.importSalesIntoAdvancePurchase();
    assert.equal(ctx.advancePurchaseRows.length,mode==='product'?1:3);
    assert.equal(ctx.advancePurchaseRows.reduce((sum,row)=>sum+row.actualQty,0),6.5);
    assert.deepEqual(Array.from(ctx.advancePurchaseRows.flatMap(row=>row.sourceSalesIds)),['s1','s2','s3']);
    ctx.advancePurchaseRows.forEach(row=>row.sourceSalesIds.forEach(sourceId=>assert.equal(row.sourceSaleDates[sourceId],sales.find(sale=>sale.id===sourceId).work_date)));
  }
});
test('date column preserves keyboard targets and saving does not change accounting dates',()=>{
  assert.match(app,/<th>No\.<\/th><th>引用元日付<\/th><th>商品コード/);
  const render=source('function renderAdvancePurchaseRows(', 'function setAdvancePurchaseRow(');
  assert.match(render,/data-advance-source-dates=/);assert.match(render,/data-advance-field="unitPrice"/);
  assert.doesNotMatch(source('async function saveAdvancePurchaseBatch(', 'function initialWorkspaceTab('),/sourceSaleDates|source_dates/);
  for(const script of app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
