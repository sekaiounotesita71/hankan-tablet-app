const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const docs=require('../domestic-documents.js');
const html=fs.readFileSync(path.join(__dirname,'..','domestic-sales.html'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
function sale(id='s1',base8=39457,base10=0,shipping=0){
  const lines=[{sale_id:id,line_no:1,product_code:'P1',product_name_snapshot:'鮮魚',quantity:1,unit:'Kg',unit_price_jpy:base8,tax_rate:8,net_amount_jpy:base8}];
  if(base10)lines.push({sale_id:id,line_no:2,product_code:'P2',product_name_snapshot:'梱包資材',quantity:1,unit:'PC',unit_price_jpy:base10,tax_rate:10,net_amount_jpy:base10});
  const tax8=Math.floor(base8*8/100),tax10=Math.floor((base10+shipping)*10/100);
  return{id,sale_no:'DOM-'+id,sale_date:'2026-09-10',customer_code:'163',customer_name_snapshot:'山崎',status:'confirmed',product_subtotal_8_jpy:base8,product_subtotal_10_jpy:base10,shipping_amount_jpy:shipping,total_net_jpy:base8+base10+shipping,tax_8_jpy:tax8,tax_10_jpy:tax10,tax_total_jpy:tax8+tax10,total_amount_jpy:base8+base10+shipping+tax8+tax10,lines};
}
function closing(sales){
  const total=sales.reduce((n,s)=>n+s.total_amount_jpy,0);
  return{id:'cl1',invoice_no:'D-20260930-000001',period_from:'2026-09-01',period_to:'2026-09-30',due_date:'2026-10-31',customer_code:'163',customer_name_snapshot:'山崎',status:'closed',carryover_amount_jpy:0,sales_amount_jpy:total,payment_amount_jpy:0,billing_amount_jpy:total,snapshot:{charges:sales.map(s=>({sale_id:s.id,source_type:'sale',invoice_date:s.sale_date,amount_jpy:s.total_amount_jpy}))}};
}
test('delivery contains all required invoice fields, reduced rate and shipping at 10 percent',()=>{
  const doc=docs.delivery(sale('mixed',101,202,303),{},{logoUrl:'logo.jpg'});
  for(const text of ['T8120001233117','株式会社ゆみるめ','山崎','2026-09-10','DOM-mixed','鮮魚','梱包資材','※','軽減税率','8％','10％','送料','単価（税抜）','金額（税抜）'])assert.ok(doc.includes(text),text);
  assert.match(doc,/505円/);assert.match(doc,/50円/);assert.match(doc,/8円/);
});
test('September EN keeps 8,921 tax and 120,443 total rather than recalculating monthly tax',()=>{
  const sales=[sale('a',39457),sale('b',38300),sale('c',33765)],c=closing(sales);
  const before=clone({sales,c});const totals=docs.validateInvoice(c,sales);
  assert.equal(totals.tax8,8921);assert.equal(totals.gross,120443);
  assert.equal(Math.floor(totals.base8*8/100),8921);
  const doc=docs.invoice(c,sales);
  assert.equal((doc.match(/class="document /g)||[]).length,4);
  assert.equal((doc.match(/T8120001233117/g)||[]).length,4);
  assert.equal((doc.match(/合計請求書番号/g)||[]).length,3);
  for(const s of sales)assert.ok(doc.includes(s.sale_no));
  assert.match(doc,/納品書別金額・消費税額の合計（参考）/);
  assert.deepEqual({sales,c},before);
});
test('rounding stays per delivery when monthly tax would differ by one yen',()=>{
  const sales=[sale('a',19),sale('b',19)],c=closing(sales);
  assert.equal(docs.validateInvoice(c,sales).tax8,2);
  assert.equal(Math.floor(38*8/100),3);
  assert.match(docs.invoice(c,sales),/>40 円</);
});
test('missing or inconsistent stored amounts, unknown tax, cancelled and partial detail are rejected',()=>{
  for(const mutate of [s=>s.lines=[],s=>s.status='cancelled',s=>s.tax_8_jpy++,s=>s.total_net_jpy++,s=>s.total_amount_jpy++,s=>s.lines[0].tax_rate=null,s=>s.lines[0].net_amount_jpy++,s=>s.lines[0].sale_id='another',s=>s.lines.push(clone(s.lines[0])),s=>s.lines[0].quantity=null]){
    const s=sale();mutate(s);assert.throws(()=>docs.delivery(s));
  }
});
test('invoice rejects stale closing, another customer, extra, duplicate or missing sales',()=>{
  const s=sale(),c=closing([s]);
  assert.throws(()=>docs.invoice({...c,status:'reopened'},[s]),/解除済み/);
  assert.throws(()=>docs.invoice({...c,sales_amount_jpy:1},[s]),/一致/);
  assert.throws(()=>docs.invoice(c,[]),/読み込めません/);
  assert.throws(()=>docs.invoice(c,[s,s]),/重複/);
  assert.throws(()=>docs.invoice(c,[{...s,customer_code:'999'}]),/一致/);
  assert.throws(()=>docs.invoice(c,[{...s,sale_date:'2026-10-01'}]),/一致/);
  const twice=clone(c);twice.snapshot.charges.push(twice.snapshot.charges[0]);assert.throws(()=>docs.invoice(twice,[s]),/重複/);
});
test('carryover, opening and payments are not included in taxable current sales',()=>{
  const s=sale('s',100),c=closing([s]);c.snapshot.charges.push({source_type:'opening',amount_jpy:500});
  c.sales_amount_jpy+=500;c.carryover_amount_jpy=200;c.payment_amount_jpy=50;c.billing_amount_jpy+=650;
  const doc=docs.invoice(c,[s]);assert.match(doc,/開始残高（今回売上対象外）/);assert.match(doc,/>758 円</);
  assert.equal(docs.validateInvoice(c,[s]).base8,100);
  c.snapshot.charges[1].source_type='adjustment';assert.throws(()=>docs.invoice(c,[s]),/調整明細/);
});
test('registration is required and user content is escaped, unit prices retain four decimals',()=>{
  assert.throws(()=>docs.delivery(sale(),{},{issuer:{name:'Company',registrationNumber:''}}),/登録番号/);
  const s=sale();s.lines[0].product_name_snapshot='<script>alert(1)</script>';s.lines[0].unit_price_jpy=123.4567;
  const doc=docs.delivery(s,{address_text:'<img src=x onerror=alert(1)>'});
  assert.ok(!doc.includes('<script>'));assert.match(doc,/&lt;script&gt;/);assert.match(doc,/123\.4567/);
});
test('print css repeats table headers, keeps totals together and separates delivery documents',()=>{
  assert.match(docs.css(),/size:A4 portrait/);assert.match(docs.css(),/display:table-header-group/);
  assert.match(docs.css(),/\.totals-block\{break-inside:avoid/);assert.match(docs.css(),/break-before:page/);
});
function appContext({c,sales,cache=[]}){
  let output='',closed=false,calls=0,error='';const win={close(){closed=true}};
  const client={from(table){return{select(){return this},eq(){return this},single:async()=>({data:c})}}};
  const context={DomesticDocuments:docs,supabaseClient:client,domesticClosingRows:cache,customers:[],location:{href:'https://example.test/domestic-sales'},URL,openDomesticPrintWindow:()=>win,writeDomesticPrintDocument:(w,t,b)=>output=b,showToast:e=>error=e,friendlyError:e=>e.message};
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('async function printDomesticInvoice('),html.indexOf('function renderCustomerList(')),context);
  context.domesticSalesForCharges=async()=>{calls++;return sales};
  return{context,result:()=>({output,closed,calls,error})};
}
test('old closings use fresh data, while new invoices reprint their stored document snapshots',async()=>{
  const s=sale(),c=closing([s]);const old=appContext({c,sales:[s],cache:[{...c,status:'reopened'}]});
  await old.context.printDomesticInvoice(c.id);assert.equal(old.result().calls,1);assert.ok(old.result().output.includes('T8120001233117'));
  const frozen=clone(c);Object.assign(frozen.snapshot,{document_version:1,document_sales:[s],document_customer:{address_text:'保存した住所'},document_issuer:docs.issuer});
  const fresh=appContext({c:frozen,sales:[]});await fresh.context.printDomesticInvoice(c.id);
  assert.equal(fresh.result().calls,0);assert.match(fresh.result().output,/保存した住所/);
  delete frozen.snapshot.document_issuer;
  const broken=appContext({c:frozen,sales:[s]});await broken.context.printDomesticInvoice(c.id);
  assert.equal(broken.result().closed,true);assert.match(broken.result().error,/保存明細/);
});
test('all domestic inline scripts compile and documents are validated before closing is sent',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
  const close=html.slice(html.indexOf('async function closeDomesticBillingPeriod('),html.indexOf('function renderDomesticClosingHistory('));
  assert.ok(close.indexOf('DomesticDocuments.validateInvoice')<close.indexOf('supabaseClient.rpc'));
  assert.match(close,/documentSnapshot\.document_sales=documentSales/);
  const fetch=html.slice(html.indexOf('async function domesticSaleForDocument('),html.indexOf('async function domesticSalesForCharges('));
  assert.match(fetch,/fetchPaged/);assert.doesNotMatch(fetch,/salesRows\.find/);
});
test('closing persists invoice details and aborts before RPC when the document is incomplete',async()=>{
  for(const incomplete of [false,true]){
    const s=sale(),c=closing([s]);let rpcCalls=0,payload=null,printed=0,error='';
    const snapshot={range:{from:c.period_from,to:c.period_to},charges:c.snapshot.charges,payments:[],carryover:0,sales:c.sales_amount_jpy,payment:0,total:c.billing_amount_jpy};
    const ctx={appBusy:false,domesticClosingLoaded:true,domesticClosingDbReady:true,domesticClosingLoadError:'',DomesticDocuments:docs,
      domesticClosingCalculation:()=>({customer:{customer_code:'163',customer_name:'山崎'},snapshot,range:snapshot.range,dueDate:c.due_date}),
      domesticSalesForCharges:async()=>incomplete?[]:[s],confirm:()=>true,money:String,
      openDomesticPrintWindow:()=>({close(){}}),setBusy(value){ctx.appBusy=value},showToast(v,isError){if(isError)error=v},friendlyError:e=>e.message,
      supabaseClient:{async rpc(name,args){rpcCalls++;payload=args;return{data:c}}},loadReceivables:async()=>{},printDomesticInvoice:async()=>{printed++}};
    vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('function domesticClosingPayload('),html.indexOf('function renderDomesticClosingHistory(')),ctx);
    await ctx.closeDomesticBillingPeriod();assert.equal(ctx.appBusy,false);
    if(incomplete){assert.equal(rpcCalls,0);assert.equal(printed,0);assert.match(error,/読み込めません/)}
    else{assert.equal(rpcCalls,1);assert.equal(printed,1);assert.equal(payload.p_snapshot.document_issuer.registrationNumber,'T8120001233117');assert.deepEqual(clone(payload.p_snapshot.document_sales),[s]);assert.equal(payload.p_billing_amount_jpy,c.billing_amount_jpy)}
    ctx.appBusy=true;await ctx.closeDomesticBillingPeriod();assert.equal(rpcCalls,incomplete?0:1);
  }
});
