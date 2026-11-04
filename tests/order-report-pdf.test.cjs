const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");

const root=path.join(__dirname,"..");
const read=name=>fs.readFileSync(path.join(root,name),"utf8");
const html=read("order-entry-beta.html");
const pdfScript=read("order-report-pdf.js");
const between=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)+1));
const guard=html.match(/document\.addEventListener\("click",e=>\{\s*if\(!appBusy\)return;[\s\S]*?\},true\);/)[0];

test("report panel offers direct PDF separately from existing print and Excel actions",()=>{
  const panel=between('id="report-output-panel"','</section>');
  for(const action of ["downloadOrderReport('purchase')","downloadOrderReport('ticket')","downloadSupplierWorkStatements()",
    "printPurchaseOrders()","printPickingTickets()","printSupplierWorkStatements()","exportSupplierWorkStatements()"]){
    assert.ok(panel.includes(`onclick="${action}"`),action);
  }
  assert.ok(html.includes('onclick="downloadSupplierReviewPurchaseOrder(${index})"'));
});

test("supplier grouping keeps similar and same-name codes separate and refuses unassigned rows",()=>{
  const context={window:{}};
  vm.runInNewContext(pdfScript,context);
  const {groupSuppliers}=context.window.OrderReportPdf;
  const rows=["151","51","５１","051"].map(supplierCode=>({supplierCode,supplierName:"Same name"}));
  const groups=groupSuppliers(rows);
  assert.equal(groups.length,3);
  assert.equal(groups.find(group=>group.code==="51").rows.length,2);
  assert.equal(groups.find(group=>group.code==="151").rows.length,1);
  assert.throws(()=>groupSuppliers([{supplierCode:""}]),/未設定/);
});

test("supplier review PDF is restricted to the selected line IDs and refuses a changed or incomplete group",async()=>{
  const chosen={line_id:"line-1",supplier_decision_status:"confirmed",supplier_code:"51",order_date:"2026-11-05"};
  const rows=[{lineId:"line-1",supplierCode:"51"},{lineId:"line-2",supplierCode:"151"},{lineId:"line-3",supplierCode:"51"}];
  const rendered=[],alerts=[];
  const ctx={supplierReviewGroups:[{rows:[chosen]}],supabaseClient:{},currentUser:{id:"user"},supplierNameFor:()=>"Supplier",
    rowsWithBatchMeta:batch=>batch.rows,sortRowsByProductCode:rows=>rows,normalizedImporter:value=>String(value||"").toLowerCase(),
    loadConfirmedReportBatchesFromDb:async()=>[{rows}],alert:msg=>alerts.push(msg),purchaseOrderCss:()=>"",
    purchaseOrderPage:(_supplier,rows)=>{rendered.push(...rows);return "test"},
    OrderReportPdf:{save:async(_kind,_title,build)=>build()}};
  vm.runInNewContext(between("function supplierReviewReportSelection(","async function setSupplierReviewOrdered("),ctx);
  await ctx.downloadSupplierReviewPurchaseOrder(0);
  assert.deepEqual(rendered,[rows[0]]);
  rows[0].supplierCode="151";
  await assert.rejects(()=>ctx.downloadSupplierReviewPurchaseOrder(0),/変更/);
  rows.shift();
  await assert.rejects(()=>ctx.downloadSupplierReviewPurchaseOrder(0),/変更/);
  chosen.supplier_decision_status="provisional";
  await ctx.downloadSupplierReviewPurchaseOrder(0);
  assert.match(alerts.at(-1),/確定/);
});

const fixtureDir=process.env.ORDER_REPORT_PDF_FIXTURES;
test("Chrome downloads real PDF and ZIP without printing, and captures every line once",{skip:!fixtureDir,timeout:120000},async()=>{
  const {chromium}=require("playwright");
  const JSZip=require(path.join(fixtureDir,"jszip.min.js"));
  const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,downloadsPath:fixtureDir,args:["--no-sandbox"]});
  try{
    const page=await browser.newPage({acceptDownloads:true});
    const scripts=["supplier-work-profile.js","supplier-work-report.js","order-report-pdf.js","supplier-work-report-app.js"];
    const row=(code,i)=>({supplierCode:code,supplierName:code==="51"?"丸新スズキ":"別の仕入先",
      orderDate:"2026-11-05",siteCode:"TYO",importerCode:"01",importerName:"DIM",
      customerCode:"01-007",customerName:"確認用 寿司店",productCode:`${code}-${String(i+1).padStart(3,"0")}`,
      productName:`${code}-${String(i+1).padStart(3,"0")} 養殖本マグロ 腹上（血合いなし）`,
      englishName:"Bluefin Tuna Belly",qty:1.13,unit:"Kg",memo:i%3?"ウロコと内臓を除去して個別真空で。":"水洗い\n個別真空でお願いします。"});
    const rows=[...Array.from({length:58},(_,i)=>row("51",i)),...Array.from({length:3},(_,i)=>row("151",i))];
    const escape=html.match(/^function esc\(v\).*$/m)[0];
    const fixture=`<!doctype html><meta charset="utf-8">
      ${scripts.map(script=>`<script src="/${script}" defer></script>`).join("")}
      <button id="purchase" onclick="downloadOrderReport('purchase')">PO</button>
      <button id="ticket" onclick="downloadOrderReport('ticket')">Tickets</button>
      <button id="work" onclick="downloadSupplierWorkStatements()">Work</button>
      <script>
      let appBusy=false, supplier="51";
      const rows=${JSON.stringify(rows)};
      const reportFilter=()=>({date:"2026-11-05",supplier,importer:"01",site:"TYO"});
      const reportRowsForPrint=async()=>rows;
      const val=()=>"2026-11-05";
      const getMasters=()=>({importers:[],suppliers:[{code:"51",name:"丸新スズキ",boxPrefix:"MAR"},{code:"151",name:"別の仕入先"}]});
      const SupplierWorkProfilesApp={read:async()=>[]};
      const reportSiteName=()=>"東京";
      const normalizeImporterCode=value=>value;
      const setAppBusy=active=>{appBusy=active};
      window.open=window.print=()=>{throw new Error("Printing or a popup was triggered")};
      window.captures=[];
      document.addEventListener("load",event=>{
        if(!event.target.src?.includes("/html2canvas@"))return;
        const capture=window.html2canvas;
        window.html2canvas=(element,options)=>{
          window.captures.push({html:element.innerHTML,kind:element.className});
          return capture(element,options);
        };
      },true);
      ${guard}
      ${escape}
      ${between("function groupedBySupplier(","function openPrintLoadingWindow(")}
      </script>`;
    await page.route("**/*",async route=>{
      const url=new URL(route.request().url());
      if(url.protocol==="blob:")return route.continue();
      const file=path.basename(url.pathname);
      if(url.hostname==="reports.test"&&url.pathname==="/")return route.fulfill({contentType:"text/html; charset=utf-8",body:fixture});
      if(url.hostname==="reports.test"&&scripts.includes(file))return route.fulfill({contentType:"text/javascript; charset=utf-8",body:read(file)});
      if(url.hostname==="cdn.jsdelivr.net"&&["html2canvas.min.js","jspdf.umd.min.js","jszip.min.js"].includes(file)){
        return route.fulfill({contentType:"text/javascript",headers:{"Access-Control-Allow-Origin":"*"},body:fs.readFileSync(path.join(fixtureDir,file))});
      }
      return route.abort();
    });
    const dialogs=[],browserErrors=[];
    page.on("pageerror",error=>browserErrors.push(error.message));
    page.on("console",message=>{if(message.type()==="error")browserErrors.push(message.text())});
    page.on("dialog",dialog=>{dialogs.push(dialog.message());void dialog.dismiss()});
    await page.goto("https://reports.test/");
    async function clickDownload(kind){
      const pending=page.waitForEvent("download",{timeout:45000});
      await page.locator("#"+kind).click();
      const item=await pending.catch(error=>{throw new Error(`${kind}: ${dialogs.join(", ")}`,{cause:error})});
      assert.equal(await item.failure(),null,JSON.stringify({url:item.url(),name:item.suggestedFilename(),browserErrors}));
      const buffer=fs.readFileSync(await item.path());
      const captures=await page.evaluate(()=>window.captures.splice(0));
      return {buffer,captures,name:item.suggestedFilename()};
    }
    const po=await clickDownload("purchase");
    assert.match(po.name,/発注書_2026-11-05_51_丸新スズキ_01_東京\.pdf$/);
    assert.equal(po.buffer.subarray(0,5).toString(),"%PDF-");
    assert.ok(po.captures.length>1);
    assert.ok(po.captures.every(page=>page.html.includes("<thead>")));
    assert.deepEqual(po.captures.flatMap(page=>[...page.html.matchAll(/<tr><td>(51-\d+)<\/td>/g)].map(match=>match[1])),rows.filter(row=>row.supplierCode==="51").map(row=>row.productCode));
    assert.ok(po.captures.every(page=>!page.html.includes("151-")));
    fs.writeFileSync(path.join(fixtureDir,"purchase.pdf"),po.buffer);
    await page.evaluate(()=>{supplier=""});
    for(const kind of ["ticket","work"]){
      if(kind==="work")await page.setViewportSize({width:390,height:844});
      const result=await clickDownload(kind);
      assert.match(result.name,/発注先別\.zip$/);
      const zip=await JSZip.loadAsync(result.buffer);
      const files=Object.values(zip.files);
      assert.equal(files.length,2);
      assert.ok(files[0].name.includes("_51_丸新スズキ_"));
      assert.ok(files[1].name.includes("_151_別の仕入先_"));
      for(const [index,file] of files.entries()){
        const buffer=await file.async("nodebuffer");
        assert.equal(buffer.subarray(0,5).toString(),"%PDF-");
        fs.writeFileSync(path.join(fixtureDir,`${kind}-${index+1}.pdf`),buffer);
      }
      const regex=kind==="work"?/<td>((?:51|151)-\d+)<\/td>/g:/<strong>((?:51|151)-\d+) 養殖/g;
      const codes=result.captures.flatMap(page=>[...page.html.matchAll(regex)].map(match=>match[1]));
      assert.deepEqual(codes,rows.map(row=>row.productCode));
      const firstOther=result.captures.findIndex(page=>page.html.includes("151-001"));
      assert.ok(firstOther>0);
      assert.ok(result.captures.slice(firstOther).every(page=>!/<(?:td|strong)>51-/.test(page.html)));
      if(kind==="ticket")assert.equal(result.captures.length,9);
      if(kind==="work")assert.equal(result.captures.filter(page=>page.html.includes('class="work-header"')).length,2);
    }
    assert.deepEqual(dialogs,[]);
    assert.equal(await page.locator("iframe").count(),0);
  }finally{await browser.close()}
});
