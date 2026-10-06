const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const report=require('../domestic-receivable-report.js');
const sites=require('../reference-sites.js');
const html=fs.readFileSync(path.join(__dirname,'..','domestic-sales.html'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
const dates={from:'2026-09-01',to:'2026-09-30'};
function record(id,date,gross=108,extra={}){return{id,customer_code:'163',customer_name_snapshot:'山崎',invoice_date:date,source_type:'sale',sale_id:'s-'+id,amount_jpy:gross,paid_amount_jpy:0,balance_jpy:gross,status:'unpaid',created_at:date+'T01:00:00Z',_referenceSite:'OSA',...extra}}
function sale(row){return{id:row.sale_id,sale_no:'DOM-'+row.id,sale_date:row.invoice_date,customer_code:row.customer_code,status:'confirmed',total_net_jpy:Number(row.amount_jpy)-8,tax_total_jpy:8,total_amount_jpy:row.amount_jpy}}
function closing(id,to,rows,extra={}){return{id,customer_code:'163',status:'closed',period_to:to,closed_at:to+'T10:00:00Z',snapshot:{charges:rows.map(row=>({id:row.id}))},...extra}}
function opts(rows,extra={}){return{range:dates,scope:'all',receivables:rows,sales:rows.filter(r=>r.sale_id).map(sale),payments:[],closings:[],...extra}}

test('date input validates compact dates, leap years and reversed periods',()=>{
  assert.deepEqual(report.range('２０２６０９０１-２０２６０９３０'),dates);
  assert.equal(report.range('20240229-20240301').from,'2024-02-29');
  for(const value of ['','20260901','20260931-20261001','20260229-20260301','20261001-20260930'])assert.throws(()=>report.range(value));
});
test('historical balances ignore current paid status, future sales and later payments',()=>{
  const opening=record('o','2026-08-31',500,{sale_id:null,source_type:'opening',status:'paid',balance_jpy:0});
  const rows=[opening,record('a','2026-09-10'),record('future','2026-10-01')];
  const payments=[{id:'p1',receivable_id:'o',payment_date:'2026-09-20',amount_jpy:120,cash_amount_jpy:100,bank_fee_jpy:20},{id:'p2',receivable_id:'a',payment_date:'2026-10-05',amount_jpy:108}];
  const result=report.build(opts(rows,{payments}));
  assert.equal(result.items.length,1);
  assert.equal(result.totals.opening,500);assert.equal(result.totals.net,100);assert.equal(result.totals.tax,8);
  assert.equal(result.totals.cash,100);assert.equal(result.totals.fee,20);assert.equal(result.totals.balance,488);
});
test('posted scope uses latest eligible closing targets once, not cumulative invoice totals',()=>{
  const rows=[record('a','2026-08-15'),record('b','2026-09-15'),record('c','2026-09-25')];
  const closings=[closing('aug','2026-08-31',[rows[0]]),closing('sep','2026-09-15',[rows[1]]),closing('future','2026-10-31',rows)];
  const result=report.build(opts(rows,{scope:'posted',closings}));
  assert.equal(result.totals.opening,108);assert.equal(result.totals.charges,108);assert.equal(result.totals.balance,216);
  assert.equal(report.build(opts(rows,{scope:'posted',closings:[...closings,closing('reopened','2026-09-30',rows,{status:'reopened'})]})).totals.balance,216);
});
test('all-sales scope retains prepayment against future-dated sale without counting that sale',()=>{
  const row=record('future','2026-10-01');
  const payments=[{id:'p',receivable_id:row.id,payment_date:'2026-09-30',amount_jpy:100}];
  const result=report.build(opts([row],{payments,sales:[]}));
  assert.equal(result.totals.charges,0);assert.equal(result.totals.cash,100);assert.equal(result.totals.balance,-100);
});
test('late backdated rows do not enter old closing unless present in its snapshot',()=>{
  const late=record('late','2026-09-10',108,{created_at:'2026-10-01T00:00:00Z'});
  const c=closing('sep','2026-09-30',[]);
  assert.equal(report.build(opts([late],{scope:'posted',closings:[c]})).items.length,0);
  c.snapshot.charges.push({id:'late'});
  assert.equal(report.build(opts([late],{scope:'posted',closings:[c]})).totals.balance,108);
});
test('opening is included without closing and cancelled rows are excluded',()=>{
  const rows=[record('o','2026-09-01',500,{sale_id:null,source_type:'opening'}),record('a','2026-09-10'),record('x','2026-09-10',500,{status:'cancelled'})];
  const result=report.build(opts(rows,{scope:'posted'}));
  assert.equal(result.totals.net,0);assert.equal(result.totals.tax,0);assert.equal(result.totals.adjustment,500);assert.equal(result.totals.balance,500);
});
test('legacy fees are not settled twice, modern payment fees reconcile exactly',()=>{
  const rows=[record('o','2026-08-01',500,{sale_id:null,source_type:'opening'})];
  const payments=[{id:'old',receivable_id:'o',payment_date:'2026-08-20',amount_jpy:100,cash_amount_jpy:null,bank_fee_jpy:10},{id:'new',receivable_id:'o',payment_date:'2026-09-20',amount_jpy:120,cash_amount_jpy:100,bank_fee_jpy:20}];
  const result=report.build(opts(rows,{payments}));assert.equal(result.totals.opening,400);assert.equal(result.totals.balance,280);
  payments[1].bank_fee_jpy=30;assert.throws(()=>report.build(opts(rows,{payments})),/一致/);
});
test('site and exact customer code filters retain distinct codes with the same name',()=>{
  const rows=[record('a','2026-09-10'),record('b','2026-09-10',108,{customer_code:'164',_referenceSite:'TYO'}),record('c','2026-09-10',108,{_referenceSite:'TYO'})];
  assert.equal(report.build(opts(rows)).items.length,2);
  const result=report.build(opts(rows,{site:'TYO',customer:'163'}));assert.equal(result.items.length,1);assert.equal(result.totals.balance,108);
  assert.match(report.document(result).body,/東京/);
});
test('fail closed on incomplete tax data, inconsistent sales or malformed closing',()=>{
  const row=record('a','2026-09-10');
  for(const mutate of [s=>s.tax_total_jpy=null,s=>s.total_net_jpy++,s=>s.customer_code='other',s=>s.sale_date='2026-09-11',s=>s.status='cancelled']){
    const option=opts([row]);mutate(option.sales[0]);assert.throws(()=>report.build(option));
  }
  assert.throws(()=>report.build(opts([row],{sales:[]})),/一致/);
  assert.throws(()=>report.build(opts([row],{scope:'posted',closings:[{status:'closed',customer_code:'163',period_to:'2026-09-30'}]})),/締め履歴/);
});
test('same payment group has distinct allocation IDs and sums once per record',()=>{
  const rows=[record('a','2026-09-10'),record('b','2026-09-10')];
  const payments=rows.map((r,i)=>({id:'p'+i,payment_group_id:'group',receivable_id:r.id,payment_date:'2026-09-20',amount_jpy:108,cash_amount_jpy:100,bank_fee_jpy:8}));
  const result=report.build(opts(rows,{payments}));assert.equal(result.totals.cash,200);assert.equal(result.totals.fee,16);assert.equal(result.totals.balance,0);
  assert.equal(result.items.length,1);
  assert.throws(()=>report.build(opts(rows,{payments:[payments[0],payments[0]]})),/重複/);
});
test('more than 1000 rows and cent amounts are not truncated or rounded to whole yen',()=>{
  const rows=Array.from({length:1005},(_,i)=>record('a'+i,'2026-09-10',108.25));
  const before=clone(rows);const result=report.build(opts(rows));
  assert.equal(result.totals.count,1005);assert.equal(result.totals.balance,108791.25);assert.deepEqual(rows,before);
  assert.match(report.document(result).body,/108,791.25/);
});
test('document includes period, basis, totals, pagination CSS and escapes customer content',()=>{
  const row=record('a','2026-09-10',108,{customer_name_snapshot:'<script>bad</script>'});
  const result=report.build(opts([row],{customer:'163'}));
  const list=report.document(result),detail=report.document(result,{detail:true});
  for(const text of ['国内 売掛一覧表','2026-09-30','期首残高','期間入金額','手数料消込','期末売掛残高','消費税'])assert.ok(list.body.includes(text));
  assert.ok(!list.body.includes('<script>'));assert.match(detail.body,/DOM-a/);
  assert.match(report.css(),/A4 landscape/);assert.match(report.css(),/thead\{display:table-header-group/);
  assert.throws(()=>report.document({...result,customer:''},{detail:true}),/得意先/);
});
test('inline scripts compile and report controls are independent of current unpaid filter',()=>{
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
  const fn=html.slice(html.indexOf('async function printDomesticArReport('),html.indexOf('function receivableStatus('));
  assert.match(fn,/fetchPaged/);assert.doesNotMatch(fn,/value\("ar-status"\)|\.rpc\(|\.insert\(|\.update\(/);
  for(const id of ['domestic-ar-report-range','domestic-ar-report-site','domestic-ar-report-scope','domestic-ar-report-customer'])assert.ok(html.includes(`id="${id}"`));
});
test('report read failures close the print window and never fall back to cached totals',async()=>{
  for(const fail of [false,true]){
    const row=record('a','2026-09-10');let output='',closed=false,error='',fetches=0,opened=0;
    const printWindow={document:{open(){},write(s){output=s},close(){}},close(){closed=true},focus(){}};
    const ctx={appBusy:false,currentUser:{},customers:[],DomesticReceivableReport:report,DomesticDocuments:{issuer:{name:'Test'}},today:()=>dates.to,
      value:id=>({'domestic-ar-report-range':'20260901-20260930','domestic-ar-report-scope':'all'}[id]||''),findCustomer:()=>null,
      showToast:s=>error=s,friendlyError:e=>e.message,esc:s=>s,setBusy(v){ctx.appBusy=v},openDomesticPrintWindow:()=>{opened++;return printWindow},
      supabaseClient:{from(){return{select(){return this},neq(){return this},lte(){return this},order(){return this}}}},
      fetchPaged:async query=>{fetches++;query();if(fail)throw Error('network failed');return[row]},
      ReferenceSites:{...sites,readLinked:async(client,table)=>table==='domestic_sales'?[sale(row)]:[]}};
    vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('async function printDomesticArReport('),html.indexOf('function receivableStatus(')),ctx);
    await ctx.printDomesticArReport();assert.equal(ctx.appBusy,false);assert.equal(fetches,1);assert.equal(opened,1);
    if(fail){assert.equal(closed,true);assert.match(error,/network/);assert.equal(output,'')}
    else{assert.match(output,/国内 売掛一覧表/);assert.equal(closed,false)}
    ctx.appBusy=true;await ctx.printDomesticArReport();assert.equal(opened,1);
  }
});
