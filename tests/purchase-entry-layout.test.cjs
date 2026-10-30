const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(from,to){const a=app.indexOf(from),b=app.indexOf(to,a+from.length);assert.ok(a>=0&&b>a);return app.slice(a,b)}
const fields=['productCode','productName','costChoice','origin','actualQty','actualUnit','unitPrice','priceUnit','taxRate','note'];
function fixture(rows){
  const body={innerHTML:''},calls=[];
  const ctx={advancePurchaseRows:rows,advancePurchaseMasterPriceSelections:new Set(['first']),
    document:{getElementById:id=>id==='advance-purchase-body'?body:null},
    esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    blankAdvancePurchaseRow:()=>({id:'blank'}),advancePurchaseTaxAmounts:()=>({lines:rows.map(()=>({net:3447,gross:3722}))}),
    advancePurchaseSourceDatesHtml:r=>r.sourceSalesIds?.length?'2026/10/22':'-',
    advancePurchaseCostScopeSelectHtml:(r,i)=>`<select aria-label="輸入社・仕入区分" data-advance-input data-advance-row-index="${i}" data-advance-field="costChoice" ${r.sourceSalesIds?.length?'disabled':''}></select>`,
    purchaseUnitOptions:()=>'<option>Kg</option>',purchaseTaxRateOptions:()=>'<option>8%</option>',
    purchaseUnitGrossHtml:()=> '税込目安 ¥3,294',purchaseMoneyPairHtml:(net,gross)=>`税抜 ¥${net} / 税込 ¥${gross}`,
    updateAdvancePurchaseSummary:()=>calls.push('summary'),updateAdvancePurchaseMasterSelectionUi:()=>calls.push('master')};
  vm.runInNewContext(source('function renderAdvancePurchaseRows(','function setAdvancePurchaseRow('),ctx);
  return {ctx,body,calls};
}
test('compact groups retain every keyboard field once per row, with source links and values unchanged',()=>{
  const rows=[{id:'first',productCode:'069',productName:'天然本マグロ 腹上',origin:'Aomori',actualQty:'1.13',actualUnit:'Kg',unitPrice:'3050',priceUnit:'Kg',taxRate:8,note:'keep',sourceSalesIds:['sale-a'],sourceSaleDates:{'sale-a':'2026-10-22'},invalid:true},
    {id:'second',productCode:'069',productName:'same code, separate line',actualQty:'2',unitPrice:'0',note:'<img src=x>',sourceSalesIds:[]}];
  const before=JSON.stringify(rows),{ctx,body,calls}=fixture(rows);ctx.renderAdvancePurchaseRows();
  assert.equal(JSON.stringify(rows),before);assert.equal((body.innerHTML.match(/role="listitem"/g)||[]).length,2);
  for(const i of [0,1])assert.deepEqual([...body.innerHTML.matchAll(new RegExp(`data-advance-row-index="${i}" data-advance-field="([^"]+)"`,'g'))].map(m=>m[1]),fields);
  assert.match(body.innerHTML,/class="advance-entry-row invalid advance-master-selected"/);
  assert.match(body.innerHTML,/data-advance-source-dates="0">2026\/10\/22/);
  assert.match(body.innerHTML,/data-advance-unit-gross="0"/);assert.match(body.innerHTML,/data-advance-amount="0"/);
  assert.match(body.innerHTML,/税抜 ¥3447 \/ 税込 ¥3722/);assert.match(body.innerHTML,/value="&lt;img src=x&gt;"/);
  assert.match(body.innerHTML,/duplicateAdvancePurchaseRow\(1\)/);assert.match(body.innerHTML,/removeAdvancePurchaseRow\(1\)/);
  assert.deepEqual(calls,['summary','master']);
});
test('layout has flexible groups and responsive wrapping, without hiding overflow or removing any control',()=>{
  assert.match(app,/\.advance-entry-table\{min-width:0\}/);
  assert.match(app,/\.advance-entry-row\{display:grid;/);
  assert.match(app,/@media\(max-width:1100px\)[\s\S]*?grid-template-areas/);
  assert.match(app,/@media\(max-width:640px\)[\s\S]*?grid-template-areas/);
  assert.match(app,/\.advance-entry-head\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(source('function renderAdvancePurchaseRows(','function setAdvancePurchaseRow('),/\.rpc\(|\.from\(/);
  assert.match(app,/const advancePurchaseFieldOrder=\["productCode","productName","costChoice","origin","actualQty","actualUnit","unitPrice","priceUnit","taxRate","note"\]/);
  for(const m of app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
});
test('keyboard navigation skips locked source scope, continues to next row, and retains reverse movement',()=>{
  const inputs=new Map(),focused=[];
  for(let row=0;row<2;row++)for(const field of fields)inputs.set(`${row}:${field}`,{disabled:row===0&&field==='costChoice',type:'text',focus(){focused.push(`${row}:${field}`)},select(){},scrollIntoView(){}});
  const ctx={advancePurchaseFieldOrder:fields,advancePurchaseRows:[{},{}],document:{querySelector:q=>{const m=q.match(/index="(\d+)".*field="([^"]+)"/);return inputs.get(`${m[1]}:${m[2]}`)}},addAdvancePurchaseRow(){throw Error('unexpected extra row')}};
  vm.runInNewContext(source('function focusAdvancePurchaseCell(','function moveAdvancePurchaseVertical('),ctx);
  ctx.moveAdvancePurchaseFocus({dataset:{advanceRowIndex:'0',advanceField:'productName'}},1);
  ctx.moveAdvancePurchaseFocus({dataset:{advanceRowIndex:'0',advanceField:'note'}},1);
  ctx.moveAdvancePurchaseFocus({dataset:{advanceRowIndex:'1',advanceField:'productCode'}},-1);
  assert.deepEqual(focused,['0:origin','1:productCode','0:note']);
});
