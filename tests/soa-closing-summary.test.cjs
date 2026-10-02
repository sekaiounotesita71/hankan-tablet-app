const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
function source(from,to){
  const start=html.indexOf(from);
  assert.ok(start>=0,`${from} exists`);
  const end=html.indexOf(to,start);
  assert.ok(end>start,`${to} follows ${from}`);
  return html.slice(start,end);
}
function statementModel(rows,payments,closings){
  const ctx={
    receivableRows:rows,receivablePayments:payments,receivableClosings:closings,
    arCanonicalImporterCode:value=>value,
    arSameImporter:(row,code)=>(row.importer_code||row)===code,
    arIsOperationRow:()=>true,
    arIsPostedReceivable:row=>row.source_type==='opening'||closings.some(closing=>closing.id===row.closing_id&&closing.status==='closed'),
    arNumber:value=>Number(value)||0,
    arRound:value=>Math.round(value*100)/100,
    today:()=> '2026-10-02',
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),
    URL,location:{href:'https://example.com/order-entry-beta.html'}
  };
  vm.runInNewContext(
    source('function arStatementDate(','function arStatementRecords(')+
    source('function arStatementRecords(','async function arAssignInvoiceNumbers(')+
    source('function arClosingStatementSnapshot(','async function arSaveStatementIssue(')+
    source('function arStatementRowsHtml(','async function printStatementOfAccount('),ctx
  );
  return ctx;
}
const closings=[
  {id:'aug',importer_code:'EDO',status:'closed',period_from:'2026-08-01',period_to:'2026-08-31',snapshot:{charges:[{id:'aug-a'},{id:'aug-b'},{id:'credit'}]}},
  {id:'sep',importer_code:'EDO',status:'closed',period_from:'2026-09-01',period_to:'2026-09-30',snapshot:{charges:[{id:'sep-a'}]}}
];
const rows=[
  {id:'opening',importer_code:'EDO',source_type:'opening',invoice_date:'2026-07-31',amount_jpy:1000},
  {id:'aug-a',importer_code:'EDO',source_type:'sales',closing_id:'aug',invoice_date:'2026-08-10',invoice_no:'INV-1',amount_jpy:2000},
  {id:'aug-b',importer_code:'EDO',source_type:'sales',closing_id:'aug',invoice_date:'2026-08-20',invoice_no:'INV-2',amount_jpy:1000},
  {id:'credit',importer_code:'EDO',source_type:'adjustment',closing_id:'aug',invoice_date:'2026-08-25',memo:'Red note',amount_jpy:-200},
  {id:'sep-a',importer_code:'EDO',source_type:'sales',closing_id:'sep',invoice_date:'2026-09-12',invoice_no:'INV-3',amount_jpy:3000},
  {id:'later-posted',importer_code:'EDO',source_type:'sales',closing_id:'oct',invoice_date:'2026-09-22',amount_jpy:4000},
  {id:'unclosed',importer_code:'EDO',source_type:'sales',invoice_date:'2026-09-14',amount_jpy:9000},
  {id:'other',importer_code:'NGA',source_type:'sales',closing_id:'sep',invoice_date:'2026-09-12',amount_jpy:8000}
];
const payments=[
  {id:'p1',receivable_id:'opening',payment_date:'2026-09-08',amount_jpy:1000,bank_fee_jpy:0},
  {id:'p2',receivable_id:'aug-a',payment_date:'2026-09-08',amount_jpy:680,bank_fee_jpy:20},
  {id:'p3',receivable_id:'aug-b',payment_date:'2026-09-08',amount_jpy:500,bank_fee_jpy:0},
  {id:'p4',receivable_id:'sep-a',payment_date:'2026-10-01',amount_jpy:1200,bank_fee_jpy:0},
  {id:'future',receivable_id:'sep-a',payment_date:'2026-10-04',amount_jpy:500,bank_fee_jpy:0}
];

test('SOA groups posted sales by closing, nets split receipts and credit, and omits invoice details',()=>{
  const model=statementModel(rows,payments,[...closings,{id:'oct',importer_code:'EDO',status:'closed',period_from:'2026-10-01',period_to:'2026-10-31'}]);
  const snapshot=model.arClosingStatementSnapshot('EDO',closings[1],{customer_name:'EDO',currency:'JPY'});
  assert.equal(snapshot.chargeAmount,6800);
  assert.equal(snapshot.paymentAmount,3400);
  assert.equal(snapshot.totalAmount,3400);
  assert.deepEqual(Array.from(snapshot.closingRows,group=>[group.closing.id,group.balance]),[['aug',1600],['sep',1800]]);
  const report=model.arStatementDocumentHtml(snapshot,{statement_no:42});
  assert.equal((report.match(/Sales Closing \d{2}\./g)||[]).length,2);
  assert.match(report,/Outstanding as of 2026-10-02/);
  for(const hidden of ['Carryover amount','Payment','Red note','INV-1','INV-2','INV-3','Opening Balance','Adjustment']){
    assert.ok(!report.includes(hidden),`${hidden} is not printed`);
  }
});

test('fully settled prior closing is omitted and the selected closing remains one row at zero',()=>{
  const fullPayments=[...payments,
    {id:'p5',receivable_id:'aug-a',payment_date:'2026-10-02',amount_jpy:1600,bank_fee_jpy:0},
    {id:'p6',receivable_id:'sep-a',payment_date:'2026-10-02',amount_jpy:1800,bank_fee_jpy:0}
  ];
  const model=statementModel(rows,fullPayments,closings);
  const snapshot=model.arClosingStatementSnapshot('EDO',closings[1],{customer_name:'EDO'});
  assert.equal(snapshot.totalAmount,0);
  assert.deepEqual(Array.from(snapshot.closingRows,group=>[group.closing.id,group.balance]),[['sep',0]]);
  assert.equal((model.arStatementRowsHtml(snapshot).match(/Sales Closing/g)||[]).length,1);
});

test('SOA print uses the selected closing month rather than the hidden invoice-date filter',()=>{
  const print=source('async function printStatementOfAccount(','function accountingReportDate(');
  assert.match(print,/val\("ar-closing-month"\)/);
  assert.doesNotMatch(print,/val\("ar-date-range"\)/);
  assert.match(print,/arClosingStatementSnapshot/);
  assert.match(print,/arSaveStatementIssue\(snapshot,user,\{refresh:true\}\)/);
});
