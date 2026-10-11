const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const report=require('../supplier-work-report.js');
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright'))}catch{}
const base={orderDate:'2026-10-11',supplierCode:'51',supplierName:'確認用問屋',importerCode:'01',importerName:'DIM',siteCode:'TYO',customerCode:'01001',customerName:'確認用得意先',productCode:'0001',productName:'真鯛フィレ',qty:2,unit:'Kg',memo:'個別真空'};
const header={destination_name:'Singapore',cargo_location:'確認用集荷場所\n東京都内の指定倉庫',cargo_cut_time:'9:30',document_cut_time:'9:30',document_method:'担当へメールまたはFAX\n連絡済みの方法で送付',packing_note:'箱上面にコードを記載\n水漏れ防止',contact:'出荷担当\n連絡先は作業依頼書を参照'};
test('real print layout preserves all rows and fits fuller continuation pages without repeating instructions',{skip:!chromium,timeout:120000},async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const name=new URL(route.request().url()).pathname.split('/').pop();
      if(['supplier-work-report.js','supplier-work-profile.js'].includes(name))await route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'..',name),'utf8')});
      else await route.abort();
    });
    for(const mode of ['short','long','mixed']){
      const rows=Array.from({length:mode==='mixed'?70:45},(_,i)=>({...base,productCode:String(i+1).padStart(4,'0'),
        ...(mode==='long'?{productName:'冷凍天然車海老ホール（大サイズ・個別真空パック）',memo:'鱗・内臓除去、骨付き。個別真空で梱包をお願いします。'}:{}),
        ...(mode==='mixed'&&i>=35?{importerCode:'07',importerName:'JKT'}:{})}));
      const model=report.build(rows,{header,suppliers:[{code:'51',boxPrefix:'MAR'}]});
      await page.setContent(report.printableDocument(model,'https://report.test/supplier-work-report.js'),{waitUntil:'networkidle'});
      await page.waitForFunction(()=>!document.getElementById('print-work').disabled);
      await page.emulateMedia({media:'print'});
      const result=await page.evaluate(()=>[...document.querySelectorAll('.work-page')].map(el=>({
        fullHeader:!!el.querySelector('.work-header'),meta:el.querySelector('.meta').textContent,
        number:el.querySelector('header span').textContent,
        height:el.lastElementChild.getBoundingClientRect().bottom-el.getBoundingClientRect().top,
        rows:[...el.querySelectorAll('.lines tbody tr')].map(r=>Number(r.dataset.row))
      })));
      assert.equal(result.flatMap(p=>p.rows).length,rows.length);
      assert.equal(new Set(result.flatMap(p=>p.rows)).size,rows.length);
      for(const [i,p] of result.entries()){
        assert.ok(p.rows.length>0);
        assert.ok(p.height<=191*96/25.4+1,`${mode} page ${i+1} overflows: ${p.height}`);
        assert.equal(p.fullHeader,p.number.startsWith('1 /'));
        assert.match(p.meta,/発注先 51/);assert.match(p.meta,/箱記号 MAR-/);
      }
      assert.equal(result.filter(p=>p.fullHeader).length,mode==='mixed'?2:1);
      if(mode==='short')assert.ok(result[1].rows.length>12,JSON.stringify(result));
      assert.deepEqual(errors,[]);
      if(process.env.WORK_REPORT_PRINT_DIR){
        fs.mkdirSync(process.env.WORK_REPORT_PRINT_DIR,{recursive:true});
        await page.pdf({path:path.join(process.env.WORK_REPORT_PRINT_DIR,`${mode}.pdf`),preferCSSPageSize:true,printBackground:true});
        if(mode==='short')for(let i=0;i<2;i++)await page.locator('.work-page').nth(i).screenshot({path:path.join(process.env.WORK_REPORT_PRINT_DIR,`page-${i+1}.png`)});
      }
      console.log(mode,JSON.stringify(result.map(p=>({rows:p.rows.length,header:p.fullHeader,height:Math.round(p.height)}))));
    }
  }finally{await browser.close()}
});
