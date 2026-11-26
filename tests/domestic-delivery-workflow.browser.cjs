const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
let chromium,ExcelJS;
try{({chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright'));ExcelJS=require(process.env.EXCELJS_PATH||'exceljs')}catch{}
const output=process.env.DELIVERY_TEST_OUTPUT;
const options={skip:!chromium||!ExcelJS,timeout:120000};
function financials(sale){return sale.lines.map(({id,quantity,unit,unit_price_jpy,net_amount_jpy})=>({id,quantity,unit,unit_price_jpy,net_amount_jpy}))}
function parseCsv(text){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=1;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++}else if(c==='"')quoted=false;else cell+=c}
    else if(c==='"')quoted=true;
    else if(c===','){row.push(cell);cell=''}
    else if(c==='\r'){assert.equal(text[++i],'\n');row.push(cell);rows.push(row);row=[];cell=''}
    else cell+=c;
  }
  assert.equal(quoted,false);assert.equal(cell,'');return rows;
}
async function setup(browser,viewport,importerCode='10'){
  const context=await browser.newContext({viewport,acceptDownloads:true});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const assets=new Map([
    ['/tests/fixtures/domestic-delivery-export.html','tests/fixtures/domestic-delivery-export.html'],
    ['/domestic-delivery-export.css','domestic-delivery-export.css'],
    ['/domestic-delivery-export.js','domestic-delivery-export.js'],
    ['/domestic-delivery-export-app.js','domestic-delivery-export-app.js'],
    ['/domestic-documents.js','domestic-documents.js'],
    ['/yumirume-logo.jpg','yumirume-logo.jpg']
  ]);
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='cdn.jsdelivr.net'&&url.pathname.endsWith('/exceljs.min.js')){
      const file=path.join(path.dirname(require.resolve(process.env.EXCELJS_PATH||'exceljs')),'dist','exceljs.min.js');
      return route.fulfill({path:file,contentType:'text/javascript'});
    }
    const file=assets.get(url.pathname);
    if(url.hostname==='delivery.test'&&file)return route.fulfill({path:path.join(root,file)});
    return route.abort();
  });
  await page.goto('http://delivery.test/tests/fixtures/domestic-delivery-export.html');
  await page.evaluate(code=>{
    demoSale.source_importer_code=code;
    demoSources.forEach(row=>row.importer_code=code);
    if(code!=='10')demoSources.forEach((row,index)=>row.box_no=['MAR-1','YUK/02-A','0012'][index]);
  },importerCode);
  await page.getByRole('button',{name:'見本を開く'}).click();
  await page.locator('#dde-dialog').waitFor();
  return {context,page,errors};
}
async function click(page,action){await page.locator(`[data-action="${action}"]`).click()}
async function waitStatus(page,text){await page.waitForFunction(value=>document.getElementById('dde-status').textContent.includes(value),text)}
test('importer 10 downloads one order-sorted sheet and uses the same persisted amounts as the printed note',options,async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  try{
    const {context,page,errors}=await setup(browser,{width:1440,height:1000});
    const original=await page.evaluate(()=>({sale:structuredClone(demoSale),sources:structuredClone(demoSources)}));
    const order=page.locator('[data-index="0"] [data-field="orderNo"]');
    const customer=page.locator('[data-index="1"] [data-field="customerName"]');
    const carton=page.locator('[data-index="2"] [data-field="cartonNo"]');
    await order.fill('');await customer.fill('');await carton.fill('');
    await click(page,'csv');await waitStatus(page,'1行目の先方受注番号');
    assert.equal(await order.getAttribute('aria-invalid'),'true');
    assert.equal(await order.evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#test-message').textContent(),'');
    await click(page,'save');await waitStatus(page,'保存済み');
    assert.equal(await page.evaluate(()=>demoSale.lines[0].external_order_no),null);
    await order.fill('0000123');await click(page,'csv');await waitStatus(page,'2行目の得意先');
    await customer.fill('東京店');await click(page,'csv');await waitStatus(page,'3行目の提出用箱番号');
    await carton.fill('0012');await carton.press('Tab');
    assert.equal(await carton.inputValue(),'JNX/No,Y0012');
    const csvPromise=page.waitForEvent('download');await click(page,'csv');const csvDownload=await csvPromise;
    await waitStatus(page,'CSV出力済み');
    const csvData=parseCsv(fs.readFileSync(await csvDownload.path(),'utf8'));
    assert.equal(csvData[0].length,10);assert.equal(csvData.length,4);
    assert.deepEqual(csvData[0].slice(1,3),['得意先・店舗名','カートンNO']);
    assert.deepEqual(csvData[0].slice(6,8),['数量','NET重量 (kg)']);
    assert.ok(!csvData[0].includes('備考'));
    assert.equal(csvData[3][0],'0000123');assert.equal(csvData[1][1],'東京店');assert.equal(csvData[2][2],'JNX/No,Y0012');
    assert.deepEqual(csvData.slice(1).map(row=>row.slice(6,8)),[['3.3','3.3'],['2','1.4'],['1.13','1.13']]);
    const excelPromise=page.waitForEvent('download');await click(page,'excel');const excelDownload=await excelPromise;
    await waitStatus(page,'Excel出力済み');
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(await excelDownload.path());
    const [sheet]=workbook.worksheets;
    const values=s=>s.getSheetValues().slice(1).map(row=>row.slice(1).map(String));
    assert.deepEqual(workbook.worksheets.map(s=>s.name),['納品明細']);
    assert.deepEqual(values(sheet),csvData);
    assert.equal(sheet.getCell('A4').value,'0000123');
    assert.equal(sheet.getCell('G3').value,2);
    assert.equal(sheet.getCell('H3').value,1.4);
    assert.equal(sheet.getCell('J4').value,3447);
    assert.equal(sheet.getCell('C3').value,'JNX/No,Y0012');
    const printed=await page.evaluate(()=>DomesticDocuments.css()+DomesticDocuments.delivery(demoSale,{},{
      caseNumbers:new Map(demoSale.lines.map((line,i)=>[line.id,line.delivery_carton_no||demoSources[i].box_no]))
    }));
    assert.match(printed,/<td class="num">3,447<\/td>/);
    const printPage=await context.newPage();
    await printPage.setViewportSize({width:704,height:1032});
    await printPage.emulateMedia({media:'print'});
    await printPage.setContent(printed);
    const printTable=printPage.locator('table.lines');
    assert.equal(await printTable.locator('th').last().textContent(),'備考');
    assert.deepEqual(await printTable.locator('tbody td:last-child').allTextContents(),['JNX/No,Y6','JNX/No,Y9','JNX/No,Y0012','']);
    assert.doesNotMatch(await printTable.textContent(),/NET重量/);
    assert.ok(await printTable.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await printPage.close();
    assert.equal([2,3,4].reduce((sum,i)=>sum+sheet.getCell(`J${i}`).value,0),28107);
    assert.equal(typeof sheet.getCell('A2').value,'string');assert.equal(typeof sheet.getCell('J2').value,'number');
    assert.equal(sheet.getCell('A2').numFmt,'@');assert.equal(sheet.getCell('J2').numFmt,'#,##0');
    assert.deepEqual(financials(await page.evaluate(()=>demoSale)),financials(original.sale));
    assert.deepEqual(await page.evaluate(()=>demoSources),original.sources);
    if(output){fs.mkdirSync(output,{recursive:true});await csvDownload.saveAs(path.join(output,'納品書データ_確認.csv'));await excelDownload.saveAs(path.join(output,'納品書データ_確認.xlsx'));await page.screenshot({path:path.join(output,'desktop.png')})}
    await page.locator('.dde-columns summary').click();
    for(let i=0;i<9;i++)await page.locator('[data-key="amount"][data-move="-1"]').click();
    const movedPromise=page.waitForEvent('download');await click(page,'csv');const moved=await movedPromise;await waitStatus(page,'CSV出力済み');
    assert.equal(parseCsv(fs.readFileSync(await moved.path(),'utf8'))[0][0],'合計金額 円');
    await click(page,'close');
    await page.getByRole('button',{name:'見本を開く'}).click();
    assert.equal(await page.locator('#dde-preview-table th').first().textContent(),'合計金額 円');
    await click(page,'close');
    await page.locator('#simulate-failure').check();await page.getByRole('button',{name:'見本を開く'}).click();
    await order.fill('changed-but-not-saved');await click(page,'save');await waitStatus(page,'テスト保存エラー');
    assert.equal(await order.inputValue(),'changed-but-not-saved');assert.equal(await page.evaluate(()=>demoSale.lines[0].external_order_no),'0000123');
    page.once('dialog',dialog=>dialog.accept());await click(page,'close');
    await page.locator('#simulate-failure').uncheck();await page.getByRole('button',{name:'見本を開く'}).click();
    await page.evaluate(()=>{demoSale.lines[0].delivery_export_revision++});
    await click(page,'save');await waitStatus(page,'他の端末');
    assert.deepEqual(financials(await page.evaluate(()=>demoSale)),financials(original.sale));
    await click(page,'close');await page.getByRole('button',{name:'見本を開く'}).click();
    await page.evaluate(()=>{demoSale.product_subtotal_8_jpy++});
    await click(page,'excel');await waitStatus(page,'税率別金額が一致しません');
    assert.deepEqual(errors,[]);await context.close();
    const mobile=await setup(browser,{width:390,height:844});
    await mobile.page.locator('[data-index="0"] [data-field="customerName"]').fill('長い店舗名・東京中央市場第二営業部');
    const bounds=await mobile.page.locator('#dde-dialog').evaluate(el=>({width:el.getBoundingClientRect().width,client:el.clientWidth,scroll:el.scrollWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
    assert.ok(bounds.left>=0&&bounds.right<=390);assert.ok(bounds.scroll<=bounds.client+1,JSON.stringify(bounds));
    if(output)await mobile.page.screenshot({path:path.join(output,'mobile.png')});
    assert.deepEqual(mobile.errors,[]);await mobile.context.close();
    const plain=await setup(browser,{width:1440,height:1000},'01');
    assert.equal(await plain.page.locator('[data-setting="prefix"]').count(),0);
    assert.equal(await plain.page.locator('[data-setting="orderLabel"]').inputValue(),'先方受注番号');
    assert.deepEqual(await plain.page.locator('[data-field="cartonNo"]').evaluateAll(inputs=>inputs.map(el=>el.value)),['MAR-1','YUK/02-A','0012']);
    await plain.page.locator('[data-index="2"] [data-field="cartonNo"]').fill('0009');
    await plain.page.locator('[data-index="2"] [data-field="cartonNo"]').press('Tab');
    const plainDownloadPromise=plain.page.waitForEvent('download');await click(plain.page,'csv');const plainDownload=await plainDownloadPromise;
    await waitStatus(plain.page,'CSV出力済み');
    const plainRows=parseCsv(fs.readFileSync(await plainDownload.path(),'utf8'));
    assert.deepEqual(plainRows.slice(1).map(row=>row[2]),['MAR-1','YUK/02-A','0009']);
    assert.equal(plainRows[0][0],'先方受注番号');
    const plainExcelPromise=plain.page.waitForEvent('download');await click(plain.page,'excel');const plainExcel=await plainExcelPromise;
    await waitStatus(plain.page,'Excel出力済み');
    const otherWorkbook=new ExcelJS.Workbook();await otherWorkbook.xlsx.readFile(await plainExcel.path());
    assert.deepEqual(otherWorkbook.worksheets.map(s=>s.name),['納品明細']);
    assert.deepEqual(values(otherWorkbook.worksheets[0]),plainRows);
    if(output)await plain.page.screenshot({path:path.join(output,'other-importer.png')});
    assert.deepEqual(plain.errors,[]);await plain.context.close();
  }finally{await browser.close()}
});
