const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Report=require('../accounting-period-report.js');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'..','accounting-period-report-app.js'),'utf8');
const range={from:'2026-08-01',to:'2026-08-31'};
const row=(id,date,amount,extra={})=>({id,date,amount,key:'01',code:'01',name:'Supplier',sourceType:'sales',tax:0,taxKnown:true,...extra});
const payment=(id,recordId,date,cash,fee=0)=>({id,recordId,date,cash,fee});
test('period list reconstructs opening and closing independently of current open/paid status',()=>{
  const records=[row('opening','2026-07-31',1000,{sourceType:'opening'}),row('aug','2026-08-03',2200),row('future','2026-09-02',500)];
  const payments=[payment('before','opening','2026-07-31',100),payment('in','opening','2026-08-31',800,100),payment('later','aug','2026-09-10',2200)];
  const snapshot=JSON.stringify({records,payments});
  const report=Report.build({records,payments,range});
  assert.equal(report.totals.opening,900);assert.equal(report.totals.cash,800);assert.equal(report.totals.fee,100);
  assert.equal(report.totals.carry,0);assert.equal(report.totals.charges,2200);assert.equal(report.totals.balance,2200);assert.equal(report.totals.count,1);
  assert.equal(report.items[0].events.at(-1).balance,2200);
  assert.equal(JSON.stringify({records,payments}),snapshot);
});
test('reference PDF arithmetic: prior balance minus cash and fee plus current sales',()=>{
  const report=Report.build({range,records:[row('opening','2026-07-31',19562246,{sourceType:'opening'}),row('sale','2026-08-31',8433532)],payments:[payment('paid','opening','2026-08-31',19555441,6805)]});
  assert.equal(report.totals.carry,0);assert.equal(report.totals.balance,8433532);
});
test('purchases use recorded mixed tax and do not deduct bank fees from the liability',()=>{
  const report=Report.build({kind:'ap',range,records:[row('p','2026-08-01',2180,{sourceType:'purchase',tax:180}),row('credit','2026-08-20',-108,{sourceType:'adjustment',tax:-8})],payments:[payment('paid','p','2026-08-25',1000,220)]});
  assert.equal(report.totals.net,2000);assert.equal(report.totals.tax,172);assert.equal(report.totals.adjustment,-100);
  assert.equal(report.totals.charges,2072);assert.equal(report.totals.cash,1000);assert.equal(report.totals.fee,220);assert.equal(report.totals.balance,1072);
});
test('returns, embedded adjustments, opening entries and overpayments retain their signs',()=>{
  const report=Report.build({range,records:[row('a','2026-08-01',1100,{adjustment:-100}),row('b','2026-08-20',-200,{sourceType:'adjustment'}),row('opening','2026-08-01',300,{sourceType:'opening'})],payments:[payment('p','a','2026-08-31',1500)]});
  assert.equal(report.totals.net,1200);assert.equal(report.totals.adjustment,0);assert.equal(report.totals.charges,1200);assert.equal(report.totals.count,2);assert.equal(report.totals.balance,-300);
});
test('prior debt paid during period is present even without a new sale; future-only parties are absent',()=>{
  const report=Report.build({range,records:[row('prior','2026-07-31',500),row('later','2026-09-01',800,{key:'02',code:'02'})],payments:[payment('p','prior','2026-08-10',500)]});
  assert.equal(report.items.length,1);assert.equal(report.items[0].count,0);assert.equal(report.items[0].balance,0);
  assert.equal(report.items[0].cash,500);
});
test('prepayments on future-dated bills are not lost',()=>{
  const report=Report.build({range,records:[row('next','2026-09-01',500)],payments:[payment('p','next','2026-08-20',200)]});
  assert.equal(report.totals.charges,0);assert.equal(report.totals.balance,-200);
});
test('rounding uses integer cents and preserves a full year of entries beyond 1000',()=>{
  const records=Array.from({length:1301},(_,i)=>row(String(i),'2026-08-01','0.10'));
  const report=Report.build({records,payments:[],range:{from:'2026-01-01',to:'2026-12-31'}});
  assert.equal(report.totals.balance,130.1);assert.equal(report.totals.count,1301);
});
test('bad dates, invalid money and duplicate IDs fail closed',()=>{
  for(const badRange of [{from:'',to:''},{from:'2026-02-30',to:'2026-03-31'},{from:'2026-09-01',to:'2026-08-31'}])assert.throws(()=>Report.build({records:[],payments:[],range:badRange}));
  assert.throws(()=>Report.build({records:[row('a','2026-08-01','NaN')],payments:[],range}));
  assert.throws(()=>Report.build({records:[row('a','2026-08-01',1),row('a','2026-08-02',2)],payments:[],range}));
  assert.throws(()=>Report.build({records:[row('a','2026-08-01',1)],payments:[payment('x','a','2026-08-02',1),payment('x','a','2026-08-03',1)],range}));
});
function uiContext(){
  const c={window:{},document:{getElementById:()=>null},AccountingPeriodReport:Report,
    receivableRows:[],receivablePayments:[],receivableClosings:[],payableRows:[],payablePayments:[],payableClosings:[],
    arIsOperationRow:r=>r.source_type==='opening'||r.invoice_date>='2026-08-01',
    arSameImporter:(a,b)=>['01','DIM'].includes(a.importer_code)&&['01','DIM'].includes(b),
    arImporterIdentity:r=>({key:'01',code:'01',name:'DIM'}),ReferenceSites:{matches:(r,s)=>r.site===s},
    lookupSupplierByCode:()=>null,apSameSupplier:(a,b)=>a===b,
    arSourceLabel:s=>s,apSourceLabel:s=>s,arNumber:n=>Number(n)||0,arRound:n=>Math.round(n*100)/100,
    accountingReportMoney:n=>Number(n).toLocaleString('ja-JP',{maximumFractionDigits:2}),
    accountingReportRangeLabel:r=>`${r.from} - ${r.to}`,accountingReportDate:d=>d,
    apNetBalanceSummary:(rows,state)=>({net:rows.reduce((n,r)=>{const s=state(r);return n+(s.amount?s.balance*(s.amount-r.tax_amount_jpy)/s.amount:0)},0)}),
    apMergeNetBalances:rows=>({net:rows.reduce((n,r)=>n+r.net,0)}),apNetBalanceText:v=>String(v.net)};
  vm.createContext(c);vm.runInContext(ui,c);return c;
}
test('screen status never suppresses historical report entries; scope, cutover, aliases and sites are explicit',()=>{
  const c=uiContext();
  c.receivableClosings=[{id:'c1',status:'closed'},{id:'reopened',status:'reopened'}];
  c.receivableRows=[{id:'opening',source_type:'opening',invoice_date:'2026-07-31',amount_jpy:100,importer_code:'01',site:'OSA'},
    {id:'sale',source_type:'sales',invoice_date:'2026-08-31',amount_jpy:200,importer_code:'DIM',site:'OSA',closing_id:'c1'},
    {id:'old',source_type:'sales',invoice_date:'2026-07-20',amount_jpy:9999,importer_code:'01',site:'OSA'},
    {id:'other',source_type:'sales',invoice_date:'2026-08-31',amount_jpy:400,importer_code:'01',site:'TYO',closing_id:'c1'},
    {id:'unclosed',source_type:'sales',invoice_date:'2026-08-31',amount_jpy:500,importer_code:'01',site:'OSA'},
    {id:'reopened',source_type:'sales',invoice_date:'2026-08-31',amount_jpy:600,importer_code:'01',site:'OSA',closing_id:'reopened'},
    {id:'missing-closing',source_type:'sales',invoice_date:'2026-08-31',amount_jpy:700,importer_code:'01',site:'OSA',closing_id:'missing'}];
  c.receivablePayments=[{id:'p',receivable_id:'sale',payment_date:'2026-09-01',amount_jpy:200}];
  const options={kind:'ar',range,site:'OSA',scope:'posted',party:'DIM'};
  const report=c.window.AccountingReports.data(options);
  assert.equal(report.items.length,1);assert.equal(report.totals.opening,100);assert.equal(report.totals.balance,300);
  assert.equal(c.window.AccountingReports.data({...options,scope:'all'}).totals.balance,2100);
  const params=c.window.AccountingReports.params(report,options,false);
  assert.ok(params.meta.some(t=>t.includes('2026-08-31')));assert.ok(params.rows.at(-1).total);assert.equal(params.siteCode,'OSA');
  assert.equal(params.rows[0].length,params.headers.length);
  const ledger=c.window.AccountingReports.params(report,options,true);assert.equal(ledger.rows.at(-1).cells.at(-1).text,'300');
});
test('AP net balance uses the selected cutoff instead of current payments and unknown tax is never fabricated',()=>{
  const c=uiContext();
  c.payableRows=[{id:'p',source_type:'purchase',invoice_date:'2026-08-31',supplier_code:'45',amount_jpy:1080,tax_amount_jpy:80}];
  c.payablePayments=[{id:'pay',payable_id:'p',payment_date:'2026-09-01',amount_jpy:1080}];
  const options={kind:'ap',range,scope:'all',site:'',party:'45'};
  const report=c.window.AccountingReports.data(options);assert.equal(report.totals.balance,1080);assert.equal(report.totals.netBalance.net,1000);
  const params=c.window.AccountingReports.params(report,options,false);assert.equal(params.rows[0].at(-1).text,'1000');
  c.payableRows[0].tax_amount_jpy=null;
  const unknown=c.window.AccountingReports.data(options);assert.equal(unknown.totals.taxUnknown,1);
  assert.equal(c.window.AccountingReports.params(unknown,options,false).rows[0][2].lines[1],'税内訳不明');
});
test('reports route all four buttons to one date-based engine without mutation APIs',()=>{
  for(const [name,kind,detail] of [['printReceivableListPdf','ar',false],['printCustomerLedgerPdf','ar',true],['printPayableListPdf','ap',false],['printSupplierLedgerPdf','ap',true]])assert.ok(html.includes(`async function ${name}(){\n  return AccountingReports.print("${kind}",${detail});\n}`)||html.includes(`async function ${name}(){\r\n  return AccountingReports.print("${kind}",${detail});\r\n}`));
  assert.doesNotMatch(ui,/\.rpc\(|\.update\(|\.insert\(|\.upsert\(|syncSalesToReceivables|syncPurchasesToPayables|arAssignInvoiceNumbers/);
  new vm.Script(ui);new vm.Script(fs.readFileSync(path.join(__dirname,'..','accounting-period-report.js'),'utf8'));
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
});

test('renderer escapes names, preserves two-line cells, totals and captured report site',()=>{
  const c=uiContext();
  c.esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  c.val=()=> 'TYO';c.ReferenceSites.label=code=>code==='OSA'?'大阪':'東京';
  c.URL=URL;c.location={href:'https://example.test/order-entry-beta'};
  vm.runInContext(html.slice(html.indexOf('function writeAccountingReport('),html.indexOf('async function ensureReceivablesForReport(')),c);
  const report=Report.build({range,records:[row('a','2026-08-01',100,{name:'<Supplier & Co>'})],payments:[]});
  let output='';const reportWindow={document:{open(){},write(value){output+=value},close(){}},focus(){}};
  c.writeAccountingReport(reportWindow,c.window.AccountingReports.params(report,{kind:'ar',range,scope:'all',site:'OSA',party:''},false));
  assert.match(output,/&lt;Supplier &amp; Co&gt;/);assert.doesNotMatch(output,/<Supplier/);
  assert.match(output,/class="total-row"/);assert.match(output,/class="report-cell-line"/);
  assert.match(output,/拠点 大阪/);assert.doesNotMatch(output,/拠点 東京/);
  assert.match(output,/@page\{size:A4 landscape/);assert.match(output,/thead\{display:table-header-group\}/);
  assert.match(output,/2026-08-31/);
});

test('print reload failures do not print stale data; double-clicks share one request',async()=>{
  const c=uiContext();
  c.receivableOperationStartDate='2026-08-01';c.receivablesLoaded=true;
  c.val=id=>id==='ar-report-range'?'20260801-20260831':id==='ar-report-scope'?'all':'';
  c.salesRefDateRangeFromText=()=>range;
  let opened=0,closed=0,printed=0,loaded=0,release;
  const gate=new Promise(resolve=>{release=resolve});const alerts=[];
  c.alert=message=>alerts.push(message);
  c.openAccountingReportWindow=()=>{opened++;return{close(){closed++}}};
  c.loadReceivables=async()=>{loaded++;await gate};
  c.writeAccountingReport=()=>{printed++};
  const first=c.window.AccountingReports.print('ar');
  await c.window.AccountingReports.print('ar');release();await first;
  assert.equal(loaded,1);assert.equal(opened,1);assert.equal(closed,1);assert.equal(printed,0);
  assert.equal(alerts.length,1);assert.match(alerts[0],/作成していません/);
  c.salesRefDateRangeFromText=()=>({from:'',to:''});
  await c.window.AccountingReports.print('ar');assert.equal(opened,1);
});
