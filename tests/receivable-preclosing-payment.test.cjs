const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ReferenceSites=require('../reference-sites.js');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(from,to){
  const start=html.indexOf(from),end=html.indexOf(to,start);
  assert.ok(start>=0&&end>start);return html.slice(start,end);
}
function model(){
  const fields=new Map();
  const element=id=>{if(!fields.has(id))fields.set(id,{value:'',textContent:'',hidden:false,style:{},focus(){},scrollIntoView(){}});return fields.get(id)};
  const values={'ar-date-range':'20261001-20261031','ar-importer':'','ar-site':'','ar-status':'','ar-search':''};
  for(const [id,value] of Object.entries(values))element(id).value=value;
  const ctx={receivableView:'prepayments',receivablePaymentAttempt:null,receivablePaymentSaving:false,
    receivableRows:[],receivableClosings:[],receivablePayments:[],receivableOperationStartDate:'2026-08-01',
    document:{getElementById:element,querySelectorAll:()=>[]},val:id=>element(id).value,
    salesRefDateRangeFromText:text=>text?{from:'2026-10-01',to:'2026-10-31',raw:text}:{from:'',to:'',raw:''},
    ReferenceSites,today:()=> '2026-10-30',arNumber:x=>Number(x)||0,arRound:x=>Math.round(x*100)/100,
    arImporterIdentity:r=>({code:r.importer_code||r,name:r.importer_name||'',label:r.importer_code||r,key:r.importer_code||r}),
    arSameImporter:(r,code)=>(r.importer_code||r)===(code.code||code),arCustomerNames:r=>r.customer_names||[],
    esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),salesRefMoney:x=>Number(x).toLocaleString('en-US'),
    renderReceivables:()=>{},renderReceivablePaymentHistory:()=>{},renderReceivablePaymentTotal:()=>{},alert:()=>{},
    loadStatementProfileFromSelectedImporter:async()=>{},refreshClosingSalesPreview:()=>{}};
  vm.runInNewContext(source('function arSettlementFor(','function arSourceLabel(')+source('function setReceivableView(','function openReceivableImporterDetail(')+
    source('function arSummaryCards(','function arRenderGroupedTable(')+source('function arRenderPrepaymentTable(','function renderReceivables(')+
    source('function selectReceivableForPayment(','function clearReceivablePaymentForm('),ctx);
  return {ctx,element};
}
function rows(){return [
  {id:'tokyo',source_type:'sales',importer_code:'01',invoice_no:'20261001001',invoice_date:'2026-10-01',amount_jpy:10000,_referenceSite:'TYO',customer_names:['TAK']},
  {id:'osaka',source_type:'sales',importer_code:'01',invoice_no:'20261001001',invoice_date:'2026-10-01',amount_jpy:20000,_referenceSite:'OSA'},
  {id:'closed',source_type:'sales',importer_code:'01',invoice_date:'2026-10-01',amount_jpy:30000,closing_id:'closing'},
  {id:'opening',source_type:'opening',importer_code:'01',invoice_date:'2026-07-31',amount_jpy:50000},
  {id:'adjustment',source_type:'adjustment',importer_code:'01',invoice_date:'2026-10-01',amount_jpy:-10},
  {id:'historical',source_type:'sales',importer_code:'01',invoice_date:'2026-07-01',amount_jpy:60000}
]}
test('pre-closing invoices are separate from posted balances, with date, importer, site, status and search filters',()=>{
  const {ctx,element}=model();ctx.receivableRows=rows();ctx.receivableClosings=[{id:'closing',status:'closed'}];
  ctx.receivablePayments=[{receivable_id:'tokyo',amount_jpy:3000,bank_fee_jpy:0}];
  assert.deepEqual(Array.from(ctx.arFilteredRows().rows,r=>r.id),['tokyo','osaka']);
  element('ar-site').value='TYO';assert.equal(ctx.arFilteredRows().rows[0].id,'tokyo');assert.equal(ctx.arFilteredRows().rows.length,1);
  element('ar-status').value='partial';assert.equal(ctx.arFilteredRows().rows[0].id,'tokyo');
  element('ar-search').value='TAK';assert.equal(ctx.arFilteredRows().rows.length,1);
  element('ar-importer').value='02';assert.equal(ctx.arFilteredRows().rows.length,0);
  element('ar-importer').value='';element('ar-search').value='';element('ar-status').value='';element('ar-site').value='';
  ctx.receivableView='summary';assert.deepEqual(Array.from(ctx.arFilteredRows().rows,r=>r.id),['closed','opening']);
});
test('same-number site invoices have independent actions, selected amount and history ID',()=>{
  const {ctx,element}=model();ctx.receivableRows=rows();
  ctx.receivablePayments=[{receivable_id:'tokyo',amount_jpy:3000,bank_fee_jpy:0}];
  ctx.selectReceivableForPayment('tokyo');
  assert.equal(element('ar-payment-receivable-id').value,'tokyo');assert.equal(element('ar-payment-closing-id').value,'');
  assert.equal(element('ar-payment-amount').value,7000);assert.match(element('ar-payment-target').textContent,/東京.*締め前/);
  const enriched=ctx.arFilteredRows().rows.map(r=>({...r,_state:ctx.arRecordState(r)}));
  const table=ctx.arRenderPrepaymentTable(enriched);assert.match(table,/>東京</);assert.match(table,/>大阪</);
  assert.match(table,/selectReceivableForPayment\('tokyo'\)/);assert.match(table,/selectReceivableForPayment\('osaka'\)/);
  assert.match(ctx.arSummaryCards(enriched),/締め前Invoiceの未入金額/);
});
test('pre-closing menu exposes filters, sync and entry without changing existing closing payment view',()=>{
  const {ctx,element}=model();ctx.setReceivableView('prepayments');
  for(const id of ['ar-site-filter','ar-date-filter','ar-importer-filter','ar-status-filter','ar-search-filter','ar-sync-button','ar-payment-section'])assert.equal(element(id).hidden,false,id);
  assert.equal(element('ar-sync-button').textContent,'対象期間のInvoiceを読込');assert.equal(element('ar-closing-section').hidden,true);
  ctx.setReceivableView('payments');assert.equal(element('ar-site-filter').hidden,true);assert.equal(element('ar-date-filter').hidden,true);
  assert.equal(element('ar-payment-section').hidden,false);
  ctx.receivablePaymentAttempt={p_request_id:'pending'};ctx.setReceivableView('prepayments');assert.equal(ctx.receivableView,'payments');
  assert.match(html,/data-ar-view="prepayments"/);
});

test('pre-closing invoice read creates missing invoices only and never overwrites existing or closed-period invoices',async()=>{
  const written=[],errors=[];let loads=0;
  const ctx={receivableOperationStartDate:'2026-08-01',receivablesLoaded:true,
    receivableRows:[{source_type:'sales',source_session_id:'paid',importer_code:'01',amount_jpy:123}],
    receivableClosings:[{status:'closed',importer_code:'01',period_from:'2026-09-01',period_to:'2026-09-30'}],
    document:{getElementById:()=>({textContent:''})},val:id=>id==='ar-date-range'?'20260901-20261031':'01',
    arCanonicalImporterCode:r=>r.importer_code||r,arSameImporter:(a,b)=>a===b,ensureCurrentUser:async()=>({id:'user'}),
    loadReceivableSettings:async()=>{},setAppBusy:()=>{},arReadSalesRows:async()=>[],arReadAll:async()=>[],
    arBuildSalesGroups:()=>['paid','closed-period','new'].map(sessionId=>({sessionId,importerCode:'01',invoiceDate:sessionId==='closed-period'?'2026-09-10':'2026-10-22',customers:new Set(),netSales:100,shipping:10,amount:110})),
    arInvoiceNumber:()=> '20261022001',loadReceivables:async()=>{loads++},alert:s=>errors.push(s),arDbErrorMessage:e=>e.message,
    initSupabase:()=>({from:()=>({upsert:chunk=>{written.push(...chunk);return {select:async()=>({data:chunk,error:null})}}})})};
  vm.runInNewContext(source('async function syncSalesToReceivables(','async function saveOpeningReceivable('),ctx);
  const before=JSON.stringify(ctx.receivableRows);
  assert.equal(await ctx.syncSalesToReceivables({onlyUnclosed:true}),true);
  assert.deepEqual(written.map(r=>r.source_session_id),['new']);assert.equal(JSON.stringify(ctx.receivableRows),before);
  assert.equal(loads,2);assert.deepEqual(errors,[]);
  ctx.receivablesLoaded=false;written.length=0;
  assert.equal(await ctx.syncSalesToReceivables({onlyUnclosed:true}),false);assert.equal(written.length,0);
});
