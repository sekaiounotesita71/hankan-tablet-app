const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const PurchaseTaxDisplay=require('../purchase-tax-display.js');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(start,end){const a=html.indexOf(start),b=html.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return html.slice(a,b)}
function element(dataset={}){
  let text='';return {dataset,writes:0,get innerHTML(){return text},set innerHTML(value){text=value;this.writes++},classList:{remove(){}}};
}
function fixture(rows=[],credit=false){
  const amounts=rows.map((_,index)=>element({advanceAmount:String(index)}));
  const prices=rows.map((_,index)=>element({advanceUnitGross:String(index)}));
  const summary=element(),focused={value:'typing',selectionStart:3};
  const ctx={PurchaseTaxDisplay,advancePurchaseRows:rows,saveCalls:0,
    val:()=>credit?'credit_note':'purchase',dbNumber:value=>value===null||value===undefined||String(value).trim()===''?null:Number.isFinite(Number(value))?Number(value):null,
    esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    salesRefMoney:value=>Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2}),
    purchaseJpyAmount:value=>Math.sign(Number(value))*Math.round(Math.abs(Number(value))+Number.EPSILON),
    saveAdvancePurchaseDraft:()=>ctx.saveCalls++,showAdvancePurchaseProductSuggestions(){},
    renderAdvancePurchaseRows(){throw new Error('Input rows must not be repainted')},
    advancePurchaseCostScopeSelectHtml:()=>'',purchaseLineCostScopeSelectHtml:()=>'',
    currentUserIsAdmin:()=>false,purchaseUnitOptions:()=>'',purchaseTaxRateOptions:()=>'',purchaseSiteOptions:()=>'',
    siteNameFromCode:value=>value,purchaseReceiptTypeLabel:()=>'',purchaseStatusLabel:()=>'',
    document:{activeElement:focused,getElementById:id=>id==='advance-purchase-summary'?summary:null,
      querySelector:()=>element(),querySelectorAll:selector=>selector==='[data-advance-amount]'?amounts:selector==='[data-advance-unit-gross]'?prices:[]},
    supabaseClient:{rpc(){throw new Error('Display must not write to DB')}}};
  vm.createContext(ctx);
  vm.runInContext(source('function purchaseMoneyPairHtml(','function salesRefGrossBoxKey('),ctx);
  vm.runInContext(source('function advancePurchaseRowActive(','function advancePurchaseMasterProduct('),ctx);
  vm.runInContext(source('function updateAdvancePurchaseSummary(','function advancePurchaseSourceDatesHtml('),ctx);
  vm.runInContext(source('function setAdvancePurchaseRow(','function hideAdvancePurchaseProductSuggestions('),ctx);
  vm.runInContext(source('function purchaseReceiptCardHtml(','function renderPurchaseReceipts('),ctx);
  vm.runInContext(source('function purchaseReferenceExcelDetailRows(','function exportPurchaseReferenceExcel('),ctx);
  return {ctx,amounts,prices,summary,focused};
}
function input(price,changes={}){return {productName:'Fish',actualQty:'1',unitPrice:String(price),taxRate:8,...changes}}
function receipt(changes={}){return {id:'receipt',status:'confirmed',purchase_date:'2026-10-23',site_code:'OSA',supplier_code:'51',supplier_name_snapshot:'Supplier',
  subtotal:100,shipping_fee:0,other_fee:0,tax_amount:8,total_amount:108,
  lines:[{id:'line',product_code:'1198',product_name:'Fish',actual_qty:1,unit_price:100,tax_rate:8,line_amount:100}],...changes}}

test('input amount and summary show both net and gross with DB-exact decimal multiplication',()=>{
  const {ctx,amounts,prices,summary}=fixture([input('3050',{actualQty:'1.13'})]);
  ctx.updateAdvancePurchaseSummary();
  assert.match(amounts[0].innerHTML,/税抜.*¥3,447.*税込.*¥3,722/);
  assert.match(summary.innerHTML,/税抜小計 ¥3,447.*消費税 ¥275.*税込合計 ¥3,722/);
  assert.match(prices[0].innerHTML,/税込目安 ¥3,294/);
});
test('editing a price updates every affected tax-share cell but never replaces inputs or steals focus',()=>{
  const {ctx,amounts,prices,focused}=fixture([input(6),input(7)]);
  ctx.updateAdvancePurchaseSummary();
  assert.match(amounts[1].innerHTML,/税込.*¥8/);
  ctx.setAdvancePurchaseRow(0,'unitPrice','8');
  assert.match(amounts[0].innerHTML,/税抜.*¥8.*税込.*¥9/);
  assert.match(amounts[1].innerHTML,/税抜.*¥7.*税込.*¥7/);
  assert.match(prices[0].innerHTML,/税込目安 ¥8.64/);
  assert.equal(ctx.document.activeElement,focused);assert.equal(focused.value,'typing');assert.equal(focused.selectionStart,3);
  const writes=amounts.map(e=>e.writes);ctx.updateAdvancePurchaseSummary();
  assert.deepEqual(amounts.map(e=>e.writes),writes,'unchanged cells are not repainted');
  assert.equal(ctx.saveCalls,1);
});
test('rate changes, tax-exempt rows and credit notes stay consistent between lines and summary',()=>{
  const {ctx,amounts,summary}=fixture([input(6),input(7)],true);
  ctx.updateAdvancePurchaseSummary();
  assert.match(summary.innerHTML,/税抜小計 ¥-13.*消費税 ¥-1.*税込合計 ¥-14/);
  ctx.setAdvancePurchaseRow(0,'taxRate','0');
  assert.match(amounts[0].innerHTML,/税抜.*¥-6.*税込.*¥-6/);
  assert.match(summary.innerHTML,/消費税 ¥0.*税込合計 ¥-13/);
});
test('blank input is not a phantom purchase and explicit zero prices remain displayed',()=>{
  const {ctx,prices,summary}=fixture([{actualQty:'',unitPrice:'',taxRate:8}]);
  ctx.updateAdvancePurchaseSummary();assert.match(summary.innerHTML,/明細 0件/);assert.match(prices[0].innerHTML,/税込目安 -/);
  ctx.advancePurchaseRows[0]=input(0);ctx.updateAdvancePurchaseSummary();
  assert.match(prices[0].innerHTML,/税込目安 ¥0/);
});
test('closed receipt summary and detail use stored totals and keep financial fields locked',()=>{
  const {ctx}=fixture();const record=receipt({shipping_fee:100,other_fee:20,total_amount:228});
  const before=JSON.stringify(record),markup=ctx.purchaseReceiptCardHtml(record);
  assert.match(markup,/<summary>[\s\S]*税抜[\s\S]*¥220[\s\S]*税込[\s\S]*¥228[\s\S]*<\/summary>/);
  assert.match(markup,/税抜合計[\s\S]*¥220/);assert.match(markup,/税込合計[\s\S]*¥228/);
  assert.match(markup,/value="100" disabled onchange="savePurchaseLineField/);
  assert.match(markup,/金額（税抜／税込）/);assert.match(markup,/税込目安 ¥108/);
  assert.equal(JSON.stringify(record),before);
});
test('manual tax differences remain separate and line inclusive figures are clearly reference values',()=>{
  const {ctx}=fixture();const record=receipt({tax_override:true,tax_amount:9,total_amount:109});
  const before=JSON.stringify(record),markup=ctx.purchaseReceiptCardHtml(record);
  assert.match(markup,/伝票税額差 ¥1/);assert.match(markup,/税込参考/);assert.match(markup,/税込合計[\s\S]*¥109/);
  assert.equal(JSON.stringify(record),before);
});
test('Excel detail preserves old net fields and adds numeric inclusive/tax columns without duplicating adjustments',()=>{
  const {ctx}=fixture();const record=receipt({tax_amount:9,total_amount:109});
  const before=JSON.stringify(record),rows=ctx.purchaseReferenceExcelDetailRows([record]);
  assert.equal(rows[0]['仕入単価'],100);assert.equal(rows[0]['仕入単価（税込目安）'],108);
  assert.equal(rows[0]['税抜金額'],100);assert.equal(rows[0]['消費税（明細配分）'],8);assert.equal(rows[0]['税込金額（税率計算）'],108);
  assert.equal(rows[0]['伝票税額差あり'],'あり');assert.equal(JSON.stringify(record),before);
});
test('headings and readonly hints keep existing keyboard fields and script parsing intact',()=>{
  assert.ok(html.indexOf('src="./purchase-tax-display.js')<html.indexOf('function advancePurchaseAmount('));
  assert.match(html,/仕入単価（税抜）/);assert.match(html,/金額（税抜／税込）/);
  assert.match(html,/data-advance-field="unitPrice"/);assert.match(html,/data-advance-field="taxRate"/);
  const update=source('function updateAdvancePurchaseTaxDisplays(','function advancePurchaseSourceDatesHtml(');
  assert.doesNotMatch(update,/\.focus\(|\.blur\(|renderAdvancePurchaseRows|advance-purchase-body|supabase|\.rpc\(/);
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc=/.test(match[1]))new vm.Script(match[2]);
});
