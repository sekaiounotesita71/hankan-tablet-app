const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(start,end){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)))}
function context(){
  const nodes={};const c={nodes,payableRows:[],payablePayments:[],payablesLoaded:true,
    arNumber:v=>Number(v)||0,arRound:v=>Math.round((Number(v)+Number.EPSILON)*100)/100,
    today:()=> '2026-09-29',apSameSupplier:(a,b)=>a===b,
    accountingReportMoney:v=>`¥${Number(v).toLocaleString('ja-JP',{maximumFractionDigits:2})}`,
    salesRefMoney:v=>Number(v).toLocaleString('ja-JP',{maximumFractionDigits:2}),
    esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),
    val:()=>'',apClosingIsActive:()=>false,currentUserIsAdmin:()=>false,
    document:{getElementById:id=>nodes[id]},
    apFilteredRows:()=>({rows:c.payableRows,range:{},error:''}),
    apPaymentsFor:id=>c.payablePayments.filter(p=>p.payable_id===id)};
  vm.runInNewContext(source('function apRecordState(','function apFilteredRows('),c);
  return c;
}
function row(id,amount,tax,extra={}){return {id,amount_jpy:amount,tax_amount_jpy:tax,source_type:'purchase',supplier_code:'45',invoice_date:'2026-09-24',...extra}}
test('registered tax handles 8%, 10%, mixed tax, zero tax and returns without assuming a rate',()=>{
  const c=context();
  for(const [amount,tax,net] of [[1080,80,1000],[1100,100,1000],[2180,180,2000],[900,0,900],[-1080,-80,-1000],[115981,8591,107390]])assert.equal(c.apNetBalance(row('x',amount,tax)).net,net);
});
test('partial settlement is prorated only for reference and full settlement is zero',()=>{
  const c=context(),r=row('x',2180,180);
  c.payablePayments=[{payable_id:'x',amount_jpy:1090,bank_fee_jpy:220}];
  const before=c.apRecordState(r);assert.equal(before.balance,1090);
  assert.deepEqual(JSON.parse(JSON.stringify(c.apNetBalance(r))),{net:1000,estimated:true,reason:''});
  assert.deepEqual(c.apRecordState(r),before);
  c.payablePayments[0].amount_jpy=2180;assert.equal(c.apNetBalance(r).net,0);
  c.payablePayments[0].amount_jpy=2300;assert.equal(c.apNetBalance(r).net,null);assert.equal(c.apRecordState(r).balance,-120);
});
test('unknown opening tax is never invented, and totals explicitly identify known portions',()=>{
  const c=context(),rows=[row('opening',1080,0,{source_type:'opening'}),row('known',1100,100)];
  assert.equal(c.apNetBalance(rows[0]).net,null);
  const sum=c.apNetBalanceSummary(rows);assert.equal(sum.net,1000);assert.equal(sum.unknownCount,1);
  assert.equal(c.apNetBalanceText(sum),'¥1,000（判明分）');assert.match(c.apNetBalanceNote(sum),/未算出 1件/);
  assert.equal(c.apNetBalanceText(c.apNetBalanceSummary([rows[0]])),'税抜未算出');
  for(const tax of [null,undefined,'',NaN,1200,-10])assert.equal(c.apNetBalance(row('x',1080,tax)).net,null);
  c.payablePayments=[{payable_id:'opening',amount_jpy:1080}];
  assert.equal(c.apNetBalanceSummary(rows).unknownCount,0);
});
test('closing reference excludes future purchases and payments and uses the same prior carryover scope',()=>{
  const c=context();c.payableRows=[row('old',1080,80,{invoice_date:'2026-09-01'}),row('now',1100,100),row('future',1080,80,{invoice_date:'2026-09-27'}),row('other',1080,80,{supplier_code:'46'})];
  c.payablePayments=[{payable_id:'old',payment_date:'2026-09-10',amount_jpy:540},{payable_id:'now',payment_date:'2026-10-02',amount_jpy:1100}];
  const before=JSON.stringify([c.payableRows,c.payablePayments]);
  const sum=c.apClosingNetBalance('45','2026-09-26');assert.equal(sum.net,1500);assert.equal(sum.estimatedCount,1);
  assert.equal(c.apNetBalanceSummary(c.payableRows.slice(0,2)).net,500);
  assert.equal(JSON.stringify([c.payableRows,c.payablePayments]),before);
});
test('screen retains tax-exclusive reference totals and gross settlement amounts',async()=>{
  const c=context();c.payableRows=[row('a',1080,80),row('b',1100,100,{supplier_code:'46',supplier_name:'Other'})];
  c.payablePayments=[{payable_id:'a',amount_jpy:540}];
  for(const id of ['ap-table','ap-summary','ap-state'])c.nodes[id]={innerHTML:'',textContent:''};
  vm.runInNewContext(source('function apSourceLabel(','async function loadPayables('),c);
  c.renderPayables();assert.match(c.nodes['ap-summary'].innerHTML,/税抜・参考[\s\S]*¥1,500/);
  assert.match(c.nodes['ap-summary'].innerHTML,/税込[\s\S]*1,640/);assert.match(c.nodes['ap-table'].innerHTML,/税抜・参考/);
  assert.match(c.nodes['ap-table'].innerHTML,/比例按分/);
});
test('tax display does not introduce database mutations or change payment and closing payloads',()=>{
  const display=source('// Tax-exclusive balances','function apFilteredRows(');
  assert.doesNotMatch(display,/\.rpc\(|\.from\(|\.update\(|\.insert\(|\.upsert\(/);
  assert.match(html,/closing_balance_jpy:row.snapshot.closingBalance/);
  assert.match(html,/const balance=closing\?apClosingCurrentBalance\(closing\):apRecordState\(row\).balance/);
  for(const [index,script] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries())new vm.Script(script[1],{filename:`inline-${index}`});
});
