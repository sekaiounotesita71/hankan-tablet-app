const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const AccountingPeriodReport=require('../accounting-period-report.js');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(from,to){
  const start=html.indexOf(from),end=html.indexOf(to,start);
  assert.ok(start>=0&&end>start,`${from} through ${to}`);
  return html.slice(start,end);
}
function statementModel(rows,payments,closings){
  const ctx={receivableRows:rows,receivablePayments:payments,receivableClosings:closings,AccountingPeriodReport,
    salesReferenceImporterIndex:null,salesRefBuildImporterIndex:()=>({}),
    arCanonicalImporterCode:value=>value,
    arSameImporter:(row,code)=>(row.importer_code||row)===code,
    arInvoiceNumber:(day,row)=>day.replaceAll('-','')+row.importer_code.padStart(3,'0'),
    arIsOperationRow:()=>true,arNumber:value=>Number(value)||0,arRound:value=>Math.round(value*100)/100,
    today:()=> '2026-10-02',esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),
    URL,location:{href:'https://example.com/order-entry-beta.html'}};
  vm.runInNewContext(source('function arStatementDate(','async function arAssignInvoiceNumbers(')+
    source('function arInvoiceStatementSnapshot(','async function arSaveStatementIssue(')+
    source('function arStatementRowsHtml(','async function printStatementOfAccount('),ctx);
  return ctx;
}
const aug={id:'aug',importer_code:'01',status:'closed',period_from:'2026-08-01',period_to:'2026-08-31'};
const sep={id:'sep',importer_code:'01',status:'closed',period_from:'2026-09-01',period_to:'2026-09-30'};
const sale=(id,date,net,shipping=0,closing=aug)=>({id,importer_code:'01',source_type:'sales',closing_id:closing.id,
  invoice_date:date,invoice_no:date.replaceAll('-','')+'001',net_sales_jpy:net,shipping_amount_jpy:shipping,amount_jpy:net+shipping});
const receipt=(id,recordId,date,amount,fee=0)=>({id,receivable_id:recordId,payment_date:date,amount_jpy:amount,bank_fee_jpy:fee});
const profile={customer_name:'DIM Pte,Ltd.',currency:'JPY'};
const referenceRows=[
  ['03',1043670,133976],['06',1100024,120527],['10',641103,119807],
  ['13',864385,116916],['17',774892,125050],['20',718368,117765],
  ['24',867483,128590],['27',1202235,137905],['31',1221372,156375]
].map(([day,net,shipping])=>sale('aug-'+day,'2026-08-'+day,net,shipping));

test('SOA month is next to its export button, outside collapsible closing details',()=>{
  const toolbar=source('<section class="panel workspace-panel" data-workspace-panel="receivables"','<div class="hint" id="ar-state"');
  assert.equal((html.match(/id="ar-closing-month"/g)||[]).length,1);
  assert.match(toolbar,/<label id="ar-closing-month-filter" hidden>SOA・請求締め対象月<input id="ar-closing-month" type="month" onchange="refreshClosingSalesPreview\(\{force:true\}\)"><\/label>\s*<button[^>]*id="ar-soa-button"/);
  assert.doesNotMatch(source('<details class="ar-entry ar-statement-profile" id="ar-closing-section"','<section class="panel workspace-panel" data-workspace-panel="guide"'),/id="ar-closing-month"/);
});

test('SOA month and button stay visible together, retaining the month across view changes',async()=>{
  const nodes=new Map(),loads=[];
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:false,style:{},value:id==='ar-closing-month'?'2026-08':''});
    return nodes.get(id);
  };
  const ctx={document:{getElementById:node,querySelectorAll:()=>[]},renderReceivables(){},
    async loadStatementProfileFromSelectedImporter(silent){loads.push(silent)},async refreshClosingSalesPreview(){}};
  vm.runInNewContext(source('function setReceivableView(','function openReceivableImporterDetail('),ctx);
  for(const view of ['closing','detail','summary','payments','setup','closing']){
    ctx.setReceivableView(view);
    assert.equal(node('ar-closing-month-filter').hidden,view!=='closing');
    assert.equal(node('ar-soa-button').hidden,view!=='closing');
    assert.equal(node('ar-closing-month').value,'2026-08');
  }
  await Promise.resolve();
  assert.deepEqual(loads,[true,true],'entering the view must not open a blocking missing-importer alert');
});

test('reference August SOA: nine invoices, shipping and subtotals total exactly 9,590,443',()=>{
  const model=statementModel(referenceRows,[],[aug]);
  const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.totalAmount,9590443);assert.equal(snapshot.carryover,0);
  assert.equal(snapshot.invoiceRows.length,9);assert.equal(snapshot.asOfDate,'2026-08-31');
  assert.equal(snapshot.invoiceRows[0].amount,1177646);assert.equal(snapshot.invoiceRows[8].amount,1377747);
  const report=model.arStatementDocumentHtml(snapshot,{statement_no:191});
  assert.equal((report.match(/Export Invoice No\./g)||[]).length,9);
  assert.equal((report.match(/Shipping Fee/g)||[]).length,9);
  assert.equal((report.match(/class="subtotal"/g)||[]).length,9);
  assert.match(report,/Date<\/th><th>Invoice No\.<\/th><th>Amount/);
  assert.match(report,/9,590,443/);assert.doesNotMatch(report,/Sales Closing|Closing Date|Payments \/ Adjustments/);
});

test('later-month receipts do not change a closed-month SOA',()=>{
  const model=statementModel(referenceRows,referenceRows.map(row=>receipt('paid-'+row.id,row.id,'2026-09-30',row.amount_jpy)),[aug]);
  const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.totalAmount,9590443);assert.equal(snapshot.invoiceRows.length,9);
  assert.equal(snapshot.paymentAmount,0);assert.equal(snapshot.settlementAmount,0);
});

test('prior balance paid by closing date clears carryover without receipt detail rows',()=>{
  const rows=[...referenceRows,sale('sep-a','2026-09-10',2000,300,sep)];
  const payments=referenceRows.map(row=>receipt('paid-'+row.id,row.id,'2026-09-30',row.amount_jpy));
  const model=statementModel(rows,payments,[aug,sep]);
  const snapshot=model.arInvoiceStatementSnapshot('01',sep,profile);
  assert.equal(snapshot.carryover,0);assert.equal(snapshot.totalAmount,2300);assert.equal(snapshot.paymentAmount,0);
  assert.equal(snapshot.invoiceRows.length,1);
  const report=model.arStatementDocumentHtml(snapshot,{statement_no:42});
  assert.doesNotMatch(report,/20260803001|paid-aug|Payments \/ Adjustments/);
});

test('partial receipts, fees, credit notes and embedded adjustments reconcile without detail rows',()=>{
  const a=sale('a','2026-08-03',2000,300);a.adjustment_amount_jpy=-100;a.amount_jpy-=100;
  const credit={id:'credit',importer_code:'01',source_type:'adjustment',closing_id:'aug',invoice_date:'2026-08-04',amount_jpy:-200,memo:'Private credit reason'};
  const payments=[receipt('p1','a','2026-08-20',480,20),receipt('future','a','2026-09-01',500)];
  const model=statementModel([a,credit],payments,[aug]);
  const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.invoiceRows[0].net,1900);assert.equal(snapshot.invoiceRows[0].amount,2200);
  assert.equal(snapshot.currentAdjustments,-200);assert.equal(snapshot.paymentAmount,500);
  assert.equal(snapshot.settlementAmount,-700);assert.equal(snapshot.totalAmount,1500);
  const report=model.arStatementDocumentHtml(snapshot,{statement_no:42});
  assert.doesNotMatch(report,/Payments \/ Adjustments|-700 JPY/);assert.match(report,/1,500 JPY/);
  assert.doesNotMatch(report,/Private credit reason|<td>Payment|<td>Adjustment/);
});

test('SOA hides the settlement summary for either sign without changing totals or source data',()=>{
  for(const adjustment of [-200,100,200]){
    const rows=[sale('a','2026-08-03',1000,300),
      {id:'credit',importer_code:'01',source_type:'adjustment',closing_id:'aug',invoice_date:'2026-08-04',amount_jpy:adjustment}];
    const payments=[receipt('paid','a','2026-08-20',100)];
    const before=JSON.stringify([rows,payments]);
    const model=statementModel(rows,payments,[aug]);
    const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
    const report=model.arStatementDocumentHtml(snapshot,{statement_no:42});
    assert.equal(snapshot.settlementAmount,adjustment-100);
    assert.equal(snapshot.totalAmount,1200+adjustment);
    assert.equal(snapshot.invoiceRows[0].amount,1300);
    assert.equal((report.match(/class="balance-line"/g)||[]).length,2);
    assert.doesNotMatch(report,/Payments \/ Adjustments/);
    assert.match(report,new RegExp(`${(1200+adjustment).toLocaleString('en-US')} JPY`));
    assert.equal(JSON.stringify([rows,payments]),before);
  }
});

test('invoice-level corrections stay in their original invoice amount, never a separate adjustment line',()=>{
  const corrected=referenceRows.map(row=>({...row}));
  const changes=[[-23100,0],[-1,2],[-1600,7],[197400,8]];
  for(const [adjustment,i] of changes){corrected[i].adjustment_amount_jpy=adjustment;corrected[i].net_sales_jpy-=adjustment}
  const model=statementModel(corrected,[],[aug]);
  const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.totalAmount,9590443);assert.equal(snapshot.settlementAmount,0);
  assert.deepEqual(Array.from(snapshot.invoiceRows,row=>row.net),referenceRows.map(row=>row.net_sales_jpy));
  assert.doesNotMatch(model.arStatementDocumentHtml(snapshot,{statement_no:191}),/Payments \/ Adjustments/);
});

test('separate correction records with the same unique invoice reproduce every reference subtotal',()=>{
  const rows=referenceRows.map(row=>({...row}));
  for(const [amount,i] of [[-23100,0],[-1,2],[-1600,7],[200900,8],[-3500,8]]){
    rows[i].net_sales_jpy-=amount;rows[i].amount_jpy-=amount;
    rows.push({id:'correction-'+rows.length,importer_code:'01',source_type:'adjustment',closing_id:aug.id,
      invoice_date:rows[i].invoice_date,invoice_no:rows[i].invoice_no,amount_jpy:amount});
  }
  const model=statementModel(rows,[],[aug]);const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.totalAmount,9590443);assert.equal(snapshot.invoiceRows.length,9);assert.equal(snapshot.settlementAmount,0);
  assert.deepEqual(Array.from(snapshot.invoiceRows,row=>[row.net,row.shipping,row.amount]),referenceRows.map(row=>[row.net_sales_jpy,row.shipping_amount_jpy,row.amount_jpy]));
  assert.doesNotMatch(model.arStatementDocumentHtml(snapshot,{statement_no:191}),/Payments \/ Adjustments/);
});

test('ambiguous corrections stay in aggregate; explicit session links select the right same-day invoice',()=>{
  const a={...sale('a','2026-08-03',1000,100),source_session_id:'one'},b={...sale('b','2026-08-03',2000,200),source_session_id:'two'};
  const correction={id:'c',importer_code:'01',source_type:'adjustment',closing_id:'aug',invoice_date:a.invoice_date,invoice_no:a.invoice_no,amount_jpy:-50};
  const model=statementModel([a,b,correction],[],[aug]);
  let snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.invoiceRows.length,2);assert.equal(snapshot.settlementAmount,-50);assert.equal(snapshot.invoiceRows[0].amount,1100);
  correction.source_session_id='two';correction.shipping_amount_jpy=-50;
  snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.settlementAmount,0);assert.equal(snapshot.invoiceRows[1].net,2000);
  assert.equal(snapshot.invoiceRows[1].shipping,150);assert.equal(snapshot.totalAmount,3250);
});

test('opening balances, overpayment, same-date invoices and other importers stay distinct',()=>{
  const rows=[{id:'opening',importer_code:'01',source_type:'opening',invoice_date:'2026-07-31',amount_jpy:1000},
    sale('a','2026-08-03',2000),sale('b','2026-08-03',500),{...sale('other','2026-08-03',999),importer_code:'02'}];
  const payments=[receipt('open-paid','opening','2026-08-01',1200),receipt('paid-a','a','2026-08-10',2100)];
  const model=statementModel(rows,payments,[aug]);const before=JSON.stringify([rows,payments]);
  const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.carryover,-200);assert.equal(snapshot.invoiceRows.length,2);assert.equal(snapshot.totalAmount,200);
  assert.equal(snapshot.carryover+snapshot.invoiceAmount+snapshot.settlementAmount,snapshot.totalAmount);
  assert.equal(JSON.stringify([rows,payments]),before);
});

test('multiple closings retain the selected closing period and do not print a prior closing as a sale',()=>{
  const first={...sep,id:'first',period_to:'2026-09-15'},last={...sep,id:'last',period_from:'2026-09-16'};
  const model=statementModel([sale('a','2026-09-10',100,0,first),sale('b','2026-09-25',200,0,last)],[],[first,last]);
  const selected=model.arSelectedStatementClosing('01','2026-09');assert.equal(selected.id,'last');
  const snapshot=model.arInvoiceStatementSnapshot('01',selected,profile);
  assert.equal(snapshot.range.from,'2026-09-16');assert.equal(snapshot.invoiceRows.length,1);
  assert.equal(snapshot.carryover,100);assert.equal(snapshot.totalAmount,300);
});

test('unknown, overlapping, reopened, malformed and duplicate data fail before output',()=>{
  const missing=statementModel([{...sale('a','2026-08-01',100),closing_id:'missing'}],[],[aug]);
  assert.throws(()=>missing.arInvoiceStatementSnapshot('01',aug,profile),/締め履歴がありません/);
  assert.throws(()=>missing.arInvoiceStatementSnapshot('01',{...aug,status:'reopened'},profile),/確定済み/);
  const overlap=statementModel([],[],[aug,{...aug,id:'overlap'}]);
  assert.throws(()=>overlap.arInvoiceStatementSnapshot('01',aug,profile),/重複/);
  for(const invalid of [[sale('a','2026-08-01',100),sale('a','2026-08-01',100)],[{...sale('a','2026-08-01',100),amount_jpy:'bad'}]]){
    const model=statementModel(invalid,[],[aug]);assert.throws(()=>model.arInvoiceStatementSnapshot('01',aug,profile));
  }
});

test('future, unclosed and reopened sales never enter the invoice list',()=>{
  const future={...sep,id:'future',period_from:'2026-10-01',period_to:'2026-10-31'},reopened={...sep,id:'reopened',status:'reopened'};
  const model=statementModel([sale('a','2026-08-01',100),sale('future','2026-08-03',999,0,future),
    {...sale('unclosed','2026-08-04',999),closing_id:null},sale('reopened','2026-08-05',999,0,reopened)],[],[aug,sep,future,reopened]);
  const snapshot=model.arInvoiceStatementSnapshot('01',aug,profile);
  assert.equal(snapshot.invoiceRows.length,1);assert.equal(snapshot.totalAmount,100);
});

test('SOA reads its saved serial without overwriting the closing-time statement',async()=>{
  const model=statementModel([],[],[aug]);let read=0;
  const saved={id:'statement',statement_no:42,importer_code:'01',period_from:aug.period_from,period_to:aug.period_to,total_amount_jpy:9999};
  model.initSupabase=()=>({from(table){assert.equal(table,'accounts_receivable_statements');return{
    select(){return this},eq(key,value){assert.equal(key,'id');assert.equal(value,'statement');return this},
    async single(){read++;return{data:saved,error:null}}}}});
  const result=await model.arReadStatementIssue({...aug,statement_id:'statement'});
  assert.equal(result.statement_no,42);assert.equal(result.total_amount_jpy,9999);assert.equal(read,1);
  await assert.rejects(model.arReadStatementIssue(aug),/保存情報がありません/);
  await assert.rejects(model.arReadStatementIssue({...sep,statement_id:'statement'}),/一致しません/);
});

test('SOA export is read-only, uses closing date not today, and rejects double clicks and stale reloads',async()=>{
  const print=source('async function printStatementOfAccount(','function accountingReportDate(');
  assert.match(print,/val\("ar-closing-month"\)/);assert.match(print,/arInvoiceStatementSnapshot/);
  assert.doesNotMatch(print,/arSaveStatementIssue|arAssignInvoiceNumbers|\.update\(|\.insert\(|\.rpc\(/);
  assert.doesNotMatch(source('function arInvoiceStatementSnapshot(','async function arSaveStatementIssue('),/today\(/);
  const model=statementModel([],[],[aug]);let opened=0,closed=0,written=0,release;
  const gate=new Promise(resolve=>{release=resolve}),alerts=[];
  model.window={open(){opened++;return{document:{write(){written++},close(){}},close(){closed++}}}};
  model.ensureCurrentUser=async()=>({id:'user'});model.val=id=>id==='ar-importer'?'01':'2026-08';
  model.receivablesLoaded=true;model.loadReceivables=async()=>{await gate};
  model.alert=message=>alerts.push(message);model.arDbErrorMessage=e=>e.message;
  vm.runInNewContext(print,model);
  const first=model.printStatementOfAccount();await model.printStatementOfAccount();release();await first;
  assert.equal(opened,1);assert.equal(written,1);assert.equal(closed,1);assert.match(alerts[0],/読み込めません/);
});
