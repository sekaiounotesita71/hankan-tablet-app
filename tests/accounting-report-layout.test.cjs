const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const Layout=require('../accounting-report-layout.js');
const Domestic=require('../domestic-receivable-report.js');
const Period=require('../accounting-period-report.js');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const range={from:'2026-10-01',to:'2026-10-31'};

function sample(count=6,ledger=false){
  const receivables=Array.from({length:count},(_,i)=>({
    id:'r'+i,sale_id:'s'+i,customer_code:ledger?'163':String(i+1).padStart(3,'0'),
    customer_name_snapshot:i%3===0?'株式会社テスト水産・長い得意先名の改行確認用':'得意先テスト'+(i+1),
    source_type:'sale',invoice_date:'2026-10-'+String(i%28+1).padStart(2,'0'),
    amount_jpy:10800000.25,status:'partial'
  }));
  const sales=receivables.map(r=>({
    id:r.sale_id,sale_no:'DOM-202610-'+r.id,sale_date:r.invoice_date,customer_code:r.customer_code,
    status:'confirmed',total_net_jpy:10000000.25,tax_total_jpy:800000,total_amount_jpy:r.amount_jpy
  }));
  const payments=receivables.map((r,i)=>({
    id:'p'+i,receivable_id:r.id,payment_date:'2026-10-31',
    cash_amount_jpy:6000000,bank_fee_jpy:330,amount_jpy:6000330
  }));
  return Domestic.build({receivables,sales,payments,scope:'all',range,customer:ledger?'163':''});
}
function exportParams(report,kind='ar',detail=false){
  const scope={window:{},document:{getElementById:()=>null},accountingReportMoney:value=>Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2}),
    accountingReportRangeLabel:r=>r.from+' ～ '+r.to,accountingReportDate:value=>value,apNetBalanceText:()=>'-'};
  vm.runInNewContext(read('accounting-period-report-app.js'),scope);
  return scope.window.AccountingReports.params(report,{kind,scope:'all',range,site:''},detail);
}

test('domestic, export and payable lists use the same renderer and styles',()=>{
  const report=sample();
  const domestic=Domestic.document(report);
  const exported=Layout.create(exportParams(report));
  const payable=Layout.create(exportParams(report,'ap'));
  for(const doc of [domestic,exported,payable]){
    assert.match(doc.body,/period-report/);
    assert.match(doc.body,/class="report-brand"/);
    assert.equal(doc.styles,Domestic.css());
    assert.equal((doc.body.match(/class="report-cell-line"/g)||[]).length,70);
  }
  assert.match(read('order-entry-beta.html'),/AccountingReportLayout\.create/);
  assert.match(read('domestic-sales.html'),/accounting-report-layout\.js/);
});
test('domestic list preserves every amount using the export two-line column order',()=>{
  const report=sample(1);
  report.items[0].name='<Customer & Co>';
  const doc=Domestic.document(report);
  const cells=[...doc.body.matchAll(/<div class="report-cell-line">([^<]*)<\/div>/g)].map(m=>m[1]);
  assert.deepEqual(cells.slice(0,10),['0','10,000,000.25','6,000,000','0','330','800,000','-6,000,330','10,800,000.25','1','4,799,670.25']);
  assert.deepEqual(cells.slice(10),cells.slice(0,10));
  assert.match(doc.body,/&lt;Customer &amp; Co&gt;/);
  assert.equal((doc.body.match(/class="summary-item"/g)||[]).length,4);
});
test('shared renderer escapes company, titles, cells, URLs and repeated headers',()=>{
  const doc=Layout.create({title:'<Title>',company:'<Company>',logoUrl:'x" onerror="bad()',repeatLabel:'<Header>',
    headers:['Code'],rows:[['<script>bad</script>']]});
  for(const text of ['&lt;Title&gt;','&lt;Company&gt;','&lt;Header&gt;','&lt;script&gt;'])assert.ok(doc.html.includes(text));
  assert.ok(!doc.html.includes('<script>'));
  assert.ok(!doc.html.includes('src="x" onerror='));
});

const out=process.env.ACCOUNTING_REPORT_LAYOUT_PREVIEW;
test('Chrome renders domestic list and ledger plus unchanged export/AP layouts without overflowing cells',{skip:!out,timeout:60000},async()=>{
  const {chromium}=require('playwright');
  const {pathToFileURL}=require('node:url');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  fs.mkdirSync(out,{recursive:true});
  try{
    const company={company:'株式会社ゆみるめ',logoUrl:pathToFileURL(path.join(root,'yumirume-logo.jpg')).href,issuedAt:'2026-11-06'};
    const docs=[
      ['domestic-list',Domestic.document(sample(),company)],
      ['domestic-list-many',Domestic.document(sample(70),company)],
      ['domestic-ledger',Domestic.document(sample(48,true),{...company,detail:true})],
      ['export-list',Layout.create({...exportParams(sample()),...company})],
      ['payable-list',Layout.create({...exportParams(sample(),'ap'),...company})]
    ];
    const widths={};
    for(const [name,doc] of docs){
      const file=path.join(out,name+'.html');
      fs.writeFileSync(file,doc.html);
      const page=await browser.newPage({viewport:{width:1150,height:850}});
      await page.goto(pathToFileURL(file).href);
      await page.emulateMedia({media:'print'});
      await page.evaluate(()=>document.fonts.ready);
      const overflows=await page.locator('th,td,.report-cell-line').evaluateAll(nodes=>nodes.filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>el.textContent));
      assert.deepEqual(overflows,[],name);
      if(name==='domestic-list'||name==='export-list')widths[name]=await page.locator('tbody tr').first().locator('td').evaluateAll(nodes=>nodes.map(el=>Math.round(el.getBoundingClientRect().width)));
      assert.equal(await page.locator('header img').evaluate(el=>el.complete&&el.naturalWidth>0),true);
      await page.pdf({path:path.join(out,name+'.pdf'),printBackground:true,preferCSSPageSize:true});
      await page.screenshot({path:path.join(out,name+'.png')});
      await page.close();
    }
    assert.deepEqual(widths['domestic-list'],widths['export-list'],'a repeated domestic header must not change the shared column widths');
  }finally{await browser.close()}
});
