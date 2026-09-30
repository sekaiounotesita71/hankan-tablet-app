const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const sites=require('../reference-sites.js');
const app=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(start,end){
  const a=app.indexOf(start),b=app.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`${start} exists`);return app.slice(a,b);
}
function client(tables,error=null){
  const reads=[];
  return {reads,from(table){
    let key,ids;
    const query={select(){return query},in(k,v){key=k;ids=v;return query},order(){return query},range(from,to){
      reads.push({table,key,ids,from,to});
      return Promise.resolve({data:(tables[table]||[]).filter(row=>ids.includes(row[key])).slice(from,to+1),error});
    }};return query;
  }};
}
test('site matching partitions Osaka, Tokyo and unresolved rows without mutating records',()=>{
  const rows=[{site_code:'OSA'},{siteCode:'TYO'},{_referenceSite:'MIXED'},{_referenceSite:'UNASSIGNED'},{}];
  const before=JSON.stringify(rows);
  assert.equal(rows.filter(row=>sites.matches(row,'')).length,5);
  assert.equal(rows.filter(row=>sites.matches(row,'OSA')).length,2);
  assert.equal(rows.filter(row=>sites.matches(row,'TYO')).length,1);
  assert.equal(rows.filter(row=>sites.matches(row,'UNASSIGNED')).length,2);
  assert.equal(sites.label('TYO'),'東京');
  assert.equal(JSON.stringify(rows),before);
  const customers=[{code:'001',name:'同名',siteCode:'TYO'},{code:'002',name:'同名',siteCode:'OSA'}];
  assert.equal(sites.customerSite({customerCode:'001'},customers),'TYO');
  assert.equal(sites.customerSite({customer:{code:'002'}},customers),'OSA');
  assert.equal(sites.customerSite({customerName:'同名'},customers),'UNASSIGNED');
});
test('sales and receivables prefer original work site over a stale Osaka default',async()=>{
  const db=client({work_sessions:[{id:'tokyo',site_code:'TYO'}]});
  const input=[{id:1,session_id:'tokyo',site_code:'OSA'},{id:2,source_session_id:'known',site_code:'OSA'},{id:3,session_id:'missing'},{id:4,source_type:'過去データ'}];
  const before=JSON.stringify(input);
  const rows=await sites.sessions(db,input,[{id:'known',site_code:'TYO'}]);
  assert.deepEqual(rows.map(sites.code),['TYO','TYO','UNASSIGNED','OSA']);
  assert.deepEqual(db.reads[0].ids,['tokyo','missing']);
  assert.equal(JSON.stringify(input),before);
  await assert.rejects(sites.sessions(client({},new Error('read denied')),input),/read denied/);
});
test('purchase joins keep the same supplier separate and never prorate mixed or unlinked balances',async()=>{
  const receipts=[
    {id:'r1',accounts_payable_id:'p1',site_code:'OSA'},
    {id:'r2',accounts_payable_id:'p2',site_code:'TYO'},
    {id:'r3',accounts_payable_id:'p3',site_code:'OSA'},
    {id:'r4',accounts_payable_id:'p3',site_code:'TYO'}
  ];
  const rows=await sites.payables(client({purchase_receipts:receipts}),['p1','p2','p3','p4'].map(id=>({id,supplier_code:'01',source_type:'purchase',amount_jpy:100})));
  assert.deepEqual(rows.map(sites.code),['OSA','TYO','MIXED','UNASSIGNED']);
  assert.equal(rows.reduce((sum,row)=>sum+row.amount_jpy,0),400);
  assert.equal(rows.filter(row=>sites.matches(row,'TYO')).reduce((sum,row)=>sum+row.amount_jpy,0),100);
  assert.equal(rows.filter(row=>sites.matches(row,'UNASSIGNED')).reduce((sum,row)=>sum+row.amount_jpy,0),200);
});
test('linked reads retain over 1000 receipts and chunk more than 200 IDs',async()=>{
  const receipts=Array.from({length:1201},(_,i)=>({id:`r${i}`,accounts_payable_id:'p',site_code:i===1200?'TYO':'OSA'}));
  const db=client({purchase_receipts:receipts});
  const rows=await sites.payables(db,[{id:'p',source_type:'purchase'}]);
  assert.equal(sites.code(rows[0]),'MIXED');
  assert.equal(db.reads.length,2);
  const work=Array.from({length:405},(_,i)=>({id:`s${i}`,site_code:'TYO'}));
  const many=client({work_sessions:work});
  assert.equal((await sites.sessions(many,work.map(row=>({session_id:row.id})))).length,405);
  assert.equal(many.reads.length,3);
  assert.ok(many.reads.every(read=>read.ids.length<=200));
});
test('domestic intermediary sales and receivables inherit export branch, not customer name',async()=>{
  const db=client({domestic_sales:[{id:'d1',source_session_id:'s1'},{id:'d2'}],work_sessions:[{id:'s1',site_code:'TYO'}]});
  const rows=await sites.domesticReceivables(db,[{id:'a1',sale_id:'d1'},{id:'a2',sale_id:'d2'},{id:'a3',sale_id:'missing'}]);
  assert.deepEqual(rows.map(sites.code),['TYO','OSA','UNASSIGNED']);
});
test('sales filter composes site with date, status, supplier and product; all restores every row',()=>{
  const fields={'sales-ref-site':'TYO','sales-ref-status':'confirmed'};
  const rows=[
    {id:1,_referenceSite:'TYO',work_date:'2026-09-10',product_id:'01',_orderSupplierCode:'02'},
    {id:2,_referenceSite:'OSA',work_date:'2026-09-10',product_id:'01',_orderSupplierCode:'02'},
    {id:3,_referenceSite:'TYO',work_date:'2026-08-10',product_id:'01',_orderSupplierCode:'02'},
    {id:4,_referenceSite:'TYO',work_date:'2026-09-10',product_id:'01',provisional:true},
    {id:5,_referenceSite:'TYO',work_date:'2026-09-10',product_id:'99'}
  ];
  const ctx={ReferenceSites:sites,val:id=>fields[id]||'',salesReferenceRows:rows,salesRefFilterKey:v=>String(v||'').toLowerCase(),salesRefSupplierCodeKey:v=>String(v||''),salesRefSupplierReady:()=>true,salesRefDateRangeFromInput:()=>({from:'2026-09-01',to:'2026-09-30'}),salesRefRowDate:r=>r.work_date,salesRefRowImporter:()=>({search:'01 dim',label:'DIM'}),salesRefIsProvisional:r=>!!r.provisional,salesRefText:v=>String(v||'')};
  vm.runInNewContext(source('function salesRefFilteredRows(','function salesRefGroup('),ctx);
  assert.deepEqual(Array.from(ctx.salesRefFilteredRows(),r=>r.id),[1,5]);
  fields['sales-ref-supplier']='02';fields['sales-ref-product']='01';
  assert.deepEqual(Array.from(ctx.salesRefFilteredRows(),r=>r.id),[1]);
  assert.deepEqual(Array.from(ctx.salesRefFilteredRows({ignoreDate:true}),r=>r.id),[1,3]);
  assert.deepEqual(Array.from(ctx.salesRefFilteredRows({site:'OSA'}),r=>r.id),[2]);
  fields['sales-ref-supplier']='';fields['sales-ref-product']='';fields['sales-ref-site']='';
  assert.equal(ctx.salesRefFilteredRows({ignoreDate:true,ignoreStatus:true}).length,5);
});
test('profit purchase totals include only the selected branch with unchanged fees and rounding',async()=>{
  const fields={'profit-ref-site':'TYO'};
  const ctx={ReferenceSites:sites,val:id=>fields[id]||'',purchaseJpyAmount:v=>Math.round(Number(v)||0),purchaseRefReadReceipts:async()=>[
    {purchase_date:'2026-09-01',site_code:'OSA',status:'confirmed',subtotal:500,shipping_fee:20},
    {purchase_date:'2026-09-01',site_code:'TYO',status:'confirmed',subtotal:100,shipping_fee:10,other_fee:5},
    {purchase_date:'2026-09-01',site_code:'TYO',status:'draft',subtotal:900},
    {purchase_date:'2025-09-01',site_code:'TYO',status:'confirmed',subtotal:9999}
  ]};
  vm.runInNewContext(source('async function salesRefReadPurchaseSummary(','async function loadProfitReferenceBoard('),ctx);
  const range={ranges:[{from:'2026-09-01',to:'2026-09-30'}]};
  assert.equal((await ctx.salesRefReadPurchaseSummary(null,range)).cost,115);
  fields['profit-ref-site']='';assert.equal((await ctx.salesRefReadPurchaseSummary(null,range)).cost,635);
});
test('changing profit filters invalidates in-flight reads so another site cannot restore stale cost totals',()=>{
  const nodes=new Map([['profit-ref-analysis',{innerHTML:'old totals'}],['profit-ref-state',{}]]);
  const ctx={profitReferenceLoadSequence:7,profitReferenceReady:true,document:{getElementById:id=>nodes.get(id)}};
  vm.runInNewContext(source('function invalidateProfitReference(','function salesRefSupplierCodeKey('),ctx);
  ctx.invalidateProfitReference();
  assert.equal(ctx.profitReferenceLoadSequence,8);
  assert.equal(ctx.profitReferenceReady,false);
  assert.equal(nodes.get('profit-ref-analysis').innerHTML,'');
});
test('reference controls and exports share site scope while closing calculations stay unfiltered',()=>{
  for(const id of ['draft-filter-site','confirmed-filter-site','pending-filter-site','sales-ref-site','profit-ref-site','ar-site','ap-site','purchase-filter-site','supplier-review-site','report-filter-site'])assert.match(app,new RegExp(`id="${id}"`));
  assert.match(source('function exportSalesReferenceBoardExcel(','function '),/salesRefFilteredRows/);
  for(const [start,end,field] of [
    ['function receivableLedgerRows(','function ','ar-site'],
    ['function payableLedgerRows(','function ','ap-site']
  ])assert.ok(source(start,end).includes(`val("${field}")`));
  assert.ok(!source('function arClosingCalculation(','function ').includes('val("ar-site")'));
  assert.match(app,/\{group,index\}[\s\S]*?draft-filter-site[\s\S]*?map\(\(\{group,index\}\)/);
  assert.match(app,/siteCode:row\.site_code\|\|"OSA"/);
});
test('receivable and payable ledger balances include only payments for the selected site, including carry-forward',()=>{
  const fields={'ar-site':'TYO','ap-site':'TYO'};
  const rows=[
    {id:'o',_referenceSite:'OSA',amount_jpy:1000,invoice_date:'2026-08-31',supplier_code:'01'},
    {id:'t',_referenceSite:'TYO',amount_jpy:300,invoice_date:'2026-08-31',supplier_code:'01'},
    {id:'t2',_referenceSite:'TYO',amount_jpy:200,invoice_date:'2026-09-10',supplier_code:'01'}
  ];
  const payments=[
    {receivable_id:'o',payable_id:'o',amount_jpy:900,payment_date:'2026-09-05'},
    {receivable_id:'t',payable_id:'t',amount_jpy:100,payment_date:'2026-08-31'},
    {receivable_id:'t2',payable_id:'t2',amount_jpy:50,payment_date:'2026-09-15'}
  ];
  const ctx={ReferenceSites:sites,val:id=>fields[id]||'',receivableRows:rows,payableRows:rows,receivablePayments:payments,payablePayments:payments,arIsOperationRow:()=>true,arIsPostedReceivable:()=>true,arSameImporter:()=>true,arRound:Math.round,arNumber:v=>Number(v)||0,arCustomerNames:()=>[],arSourceLabel:()=>'',apSourceLabel:()=>'',accountingReportMoney:String,accountingReportDate:String};
  vm.runInNewContext(source('function receivableLedgerRows(','async function printCustomerLedgerPdf('),ctx);
  vm.runInNewContext(source('function payableLedgerRows(','async function printSupplierLedgerPdf('),ctx);
  const range={from:'2026-09-01',to:'2026-09-30'};
  for(const ledger of [ctx.receivableLedgerRows({},range),ctx.payableLedgerRows('01',range)]){
    assert.equal(ledger.opening,200);assert.equal(ledger.balance,350);
    assert.equal(ledger.charges.length,2);assert.equal(ledger.payments.length,2);
  }
  fields['ar-site']='';fields['ap-site']='';
  assert.equal(ctx.receivableLedgerRows({},range).balance,450);
  assert.equal(ctx.payableLedgerRows('01',range).balance,450);
});
test('shipping is counted once per selected work session and importer, without other-site charges',()=>{
  const fields={};
  const ctx={val:id=>fields[id]||'',salesRefNum:v=>Number(v)||0,salesRefShippingFeesObject:v=>v,salesReferenceSessionMap:new Map([
    ['osa',{shipping_fees:{'01':100}}],['tyo',{shipping_fees:{'01':300,'02':700}}]
  ]),salesReferenceSessions:[],salesReferenceImporterKeysBySession:new Map(),salesRefImporterIdentity:v=>({key:`master:${v}`}),salesRefRowImporter:row=>({key:`master:${row.importer_code}`}),salesRefShippingAdjustmentForRows:rows=>rows.reduce((sum,row)=>sum+(row._shipping_adjustment_amount||0),0)};
  vm.runInNewContext(source('function salesRefSessionShippingFee(','function salesRefShippingBreakdownData('),ctx);
  const rows=[{session_id:'osa',importer_code:'01',_referenceSite:'OSA'},{session_id:'tyo',importer_code:'01',_referenceSite:'TYO'},{session_id:'tyo',importer_code:'01',_referenceSite:'TYO'},{_referenceSite:'TYO',_shipping_adjustment_amount:-10}];
  assert.equal(ctx.salesRefVisibleShippingFeeForRows(rows.filter(row=>sites.matches(row,'TYO'))),290);
  assert.equal(ctx.salesRefVisibleShippingFeeForRows(rows),390);
});
test('modified application scripts compile and branch resolution is read-only',()=>{
  for(const name of ['index.html','order-entry-beta.html','domestic-sales.html']){
    const html=fs.readFileSync(path.join(__dirname,'..',name),'utf8');
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
      if(/\bsrc=|application\/json/.test(match[1]))continue;
      new vm.Script(match[2],{filename:name});
    }
    assert.match(html,/src="\.\/reference-sites\.js/);
  }
  const module=fs.readFileSync(path.join(__dirname,'..','reference-sites.js'),'utf8');
  assert.doesNotMatch(module,/\.(?:insert|update|upsert|delete|rpc)\(/);
});
