const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
let chromium;
try{({chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright'))}
catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error}

test('order number sits after product name and Enter advances even when it is empty',{skip:!chromium,timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:940}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      const filename=url.pathname.slice(1);
      if(url.hostname!=='order.test'||!/^[\w.-]+$/.test(filename)||!fs.existsSync(path.join(root,filename)))return route.abort();
      await route.fulfill({path:path.join(root,filename)});
    });
    await page.goto('http://order.test/order-entry-beta.html#orders');
    await page.evaluate(()=>document.body.classList.remove('auth-checking','auth-locked'));
    const table=page.locator('table.orders').filter({has:page.locator('#order-body')});
    const field=(key,row=0)=>table.locator(`input[data-row="${row}"][data-field="${key}"]`);
    const name=field('productName'),number=field('externalOrderNo'),qty=field('qty');
    const focused=()=>page.evaluate(()=>document.activeElement.dataset.field);
    const headers=await table.locator('th').allTextContents();
    assert.deepEqual(headers.slice(2,5),['商品名','先方受注番号','数量']);
    await name.fill('確認用の商品');
    await name.press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='externalOrderNo');
    assert.equal(await number.inputValue(),'');
    await number.press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='qty');
    assert.equal(await number.inputValue(),'');
    await qty.press('ArrowLeft');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='externalOrderNo');
    await number.fill('0005-A');
    await number.press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='qty');
    assert.equal(await page.evaluate(()=>orders[0].externalOrderNo),'0005-A');
    await name.focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(),'externalOrderNo');
    const boxes=await Promise.all([name,number,qty].map(locator=>locator.boundingBox()));
    assert.ok(boxes.every(Boolean));
    assert.equal(boxes[0].y,boxes[1].y);
    assert.equal(boxes[1].y,boxes[2].y);
    assert.ok(boxes[0].x+boxes[0].width<=boxes[1].x&&boxes[1].x+boxes[1].width<=boxes[2].x);
    const output=process.env.ORDER_ENTRY_TEST_SCREENSHOTS;
    if(output)await table.screenshot({path:path.join(output,'order-number-layout.png')});

    const code=await page.evaluate(()=>{
      baseMasters.products.push({code:'TST01',name:'確認用マスタ商品',unitPrice:200});
      addOrderRow();
      return 'TST0';
    });
    const productCode=field('productCode',1);
    await productCode.scrollIntoViewIfNeeded();
    await productCode.click();
    await page.keyboard.type(code);
    await page.locator('#product-suggest-1 button').first().waitFor();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='externalOrderNo'&&document.activeElement.dataset.row==='1',undefined,{timeout:3000});
    assert.equal(await field('productName',1).inputValue(),'確認用マスタ商品');
    await field('externalOrderNo',1).press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='qty'&&document.activeElement.dataset.row==='1');

    await page.setViewportSize({width:390,height:844});
    await field('externalOrderNo',0).focus();
    await field('externalOrderNo',0).press('Enter');
    await page.waitForFunction(()=>document.activeElement.dataset.field==='qty'&&document.activeElement.dataset.row==='0');
    assert.equal(await field('externalOrderNo',0).inputValue(),'0005-A');
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
});
