const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");
const paper=require("../work-paper.js");
const root=path.join(__dirname,"..");
const app=fs.readFileSync(path.join(root,"index.html"),"utf8");
const adapter=app.slice(app.indexOf("function openWorkPaper(){"),app.indexOf("function toast(",app.indexOf("function openWorkPaper(){")));

function row(i,overrides={}){
  return {id:String(i),sourceNo:i+1,importerCode:"02",importerName:"BKK",customerCode:`C${Math.floor(i/4)}`,customerName:`見本店舗${Math.floor(i/4)+1}`,productCode:`00${i}`,productName:["養殖ハマチ フィレ","畜養本マグロ 腹上","冷凍天然車エビホール（約320g）","大葉"][i%4],orderQty:5,orderUnit:"PC",qty:"",unit:"Kg",net:"",boxNo:"",origin:"",memo:i%4===2?"個別真空 / 価格候補: 1,200 / 1,500":"",stockout:false,...overrides};
}
function snapshot(rows=Array.from({length:12},(_,i)=>row(i)),boxes=[]){return {rows,boxes,workDate:"2026-09-10",printedAt:"2026/09/10 12:00",activeImporter:"02"}}
function options(s,overrides={}){return {ids:s.rows.map(r=>r.id),lines:true,boxes:true,recipient:"",...overrides}}

test("paper sheets preserve every detail and keep customers together in twelve-row pages",()=>{
  const rows=[...Array.from({length:10},(_,i)=>row(i,{customerCode:"A",customerName:"A店"})),...Array.from({length:3},(_,i)=>row(i+10,{customerCode:"B",customerName:"B店"}))];
  const pages=paper.paginateGroups(paper.groupCustomers(rows));
  assert.deepEqual(pages.map(p=>p.rows.length),[10,3]);
  const many=Array.from({length:2507},(_,i)=>row(i,{customerCode:String(Math.floor(i/31)),customerName:`店舗${Math.floor(i/31)}`}));
  const large=paper.paginateGroups(paper.groupCustomers(many));
  assert.equal(large.flatMap(p=>p.rows).length,many.length);
  assert.equal(new Set(large.flatMap(p=>p.rows.map(r=>r.id))).size,many.length);
  assert.ok(large.every(p=>p.rows.length<=12));
  const s=snapshot(Array.from({length:13},(_,i)=>row(i,{customerCode:"A",customerName:"続き店舗"})));
  const html=paper.renderPages(paper.makeSections(s,options(s,{boxes:false})));
  assert.equal((html.match(/<b>続き店舗<\/b>/g)||[]).length,2);
  assert.equal((html.match(/data-source-id=/g)||[]).length,13);
});

test("different customer codes and importer codes are never merged",()=>{
  const s=snapshot([row(0,{customerName:"同名",customerCode:"A"}),row(1,{customerName:"同名",customerCode:"B"}),row(2,{importerCode:"07",importerName:"JKT"})]);
  const sections=paper.makeSections(s,options(s));
  assert.deepEqual(sections.map(s=>[s.meta.code,s.type]),[["02","lines"],["02","boxes"],["07","lines"],["07","boxes"]]);
  assert.equal(sections[0].groups.length,2);
  assert.equal(sections[2].meta.importerName,"JKT");
});

test("box sheets retain exact labels and selected scope with no customer or NET columns",()=>{
  const s=snapshot([row(0,{boxNo:"001"}),row(1,{boxNo:"TKY-10"}),row(2,{boxNo:"TKY-2"}),row(3,{boxNo:"001"}),row(4,{stockout:true,boxNo:"999"}),row(5,{importerCode:"07",boxNo:"001"})],[{importerCode:"02",boxNo:"001",gross:5.2,dryIceEnabled:true,dryIce:1,size:"中"},{importerCode:"07",boxNo:"001",gross:99,size:"大"},{importerCode:"02",boxNo:"stale",gross:88}]);
  const before=JSON.stringify(s);
  const sections=paper.makeSections(s,options(s,{lines:false,ids:["0","1","2","3","4"]}));
  assert.equal(sections.length,1);
  assert.deepEqual(sections[0].groups.map(g=>g[0].boxNo),["001","TKY-2","TKY-10"]);
  assert.equal(sections[0].groups[0][0].gross,5.2);
  const html=paper.renderPages(sections);
  assert.ok(!/得意先|NET|見本店舗|stale|>99<|>999</.test(html));
  assert.equal((html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].match(/<tr>/g)||[]).length,12);
  assert.equal(JSON.stringify(s),before);
  const blank=snapshot([row(0)]);
  assert.equal(paper.pagesForSections(paper.makeSections(blank,options(blank,{lines:false}))).length,1);
  const thirteen=snapshot(Array.from({length:13},(_,i)=>row(i,{boxNo:String(i+1)})));
  assert.equal(paper.pagesForSections(paper.makeSections(thirteen,options(thirteen,{lines:false}))).length,2);
});

test("print source excludes prices, unrelated details and unselected boxes and escapes text",()=>{
  const s=snapshot([row(0,{productName:'</script><script>alert("x")</script>',unitPrice:123456,memo:"個別真空 / 価格候補: 1,200 / 1,500",boxNo:"A-1"}),row(1,{productName:"非選択情報",boxNo:"B-1"})],[{importerCode:"02",boxNo:"A-1",gross:3},{importerCode:"02",boxNo:"B-1",gross:777}]);
  const html=paper.printDocument(s,options(s,{ids:["0"]}));
  assert.ok(!html.includes("非選択情報"));assert.ok(!html.includes("B-1"));assert.ok(!html.includes("123456"));assert.ok(!html.includes("価格候補"));
  assert.ok(!html.includes('<script>alert("x")</script>'));
  const data=JSON.parse(html.match(/<script id="wp-print-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.snapshot.rows.length,1);assert.equal(data.snapshot.boxes.length,1);
  assert.equal(data.snapshot.rows[0].memo,"個別真空");
  assert.equal(data.snapshot.rows[0].productName,s.rows[0].productName);
  assert.ok(paper.renderPages(paper.makeSections(s,options(s))).includes("&lt;/script&gt;"));
  assert.equal(paper.paperMemo("価格候補: 1,200 / 1,500 / 個別真空"),"個別真空");
  assert.equal(paper.paperMemo("1/2に切る / A/B"),"1/2に切る / A/B");
  assert.throws(()=>paper.makeSections(s,options(s,{ids:[]})),/選択/);
  assert.throws(()=>paper.makeSections(s,options(s,{lines:false,boxes:false})),/選択/);
});

test("work-app adapter is a read-only snapshot and does not call save or lock operations",()=>{
  const rows=[{_idx:3,importer_id:"02",customer:"得意先",product_id:"001",product_name:"商品",csv_qty:2,unit:"PC",_qty:2.5,_unit:"Kg",_net:2.5,_box:"V-001",origin:"CHIBA",_memo:"個別真空",unit_price:123456}];
  const boxMap={"02":{"V-001":{gross:3.2,dry_ice:1,dry_ice_enabled:true,box_size:"中"}}};
  const initial=JSON.stringify({rows,boxMap});let captured;
  const context={currentUser:{id:"test"},rows,boxMap,currentSessionWorkDate:"2026-09-10",currentPhase:1,activeCountry:"02",activeImporter:"",importerCode:v=>v,importerDisplayName:()=>"BKK",toast:()=>assert.fail("unexpected toast"),window:{WorkPaper:{}},WorkPaper:{open:s=>captured=s}};
  vm.runInNewContext(adapter+"\nopenWorkPaper();",context);
  assert.equal(captured.rows[0].sourceNo,4);assert.equal(captured.rows[0].boxNo,"V-001");
  assert.equal(captured.boxes[0].gross,3.2);assert.equal(captured.rows[0].importerName,"BKK");
  assert.ok(!JSON.stringify(captured).includes("123456"));
  assert.equal(JSON.stringify({rows,boxMap}),initial);
  assert.doesNotMatch(adapter,/supabase|\.update\(|\.insert\(|save|lock|renderP/i);
  const inline=[...app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
  inline.forEach(s=>new vm.Script(s));
});

test("paper selection, pagination and print layout work in a separate offline browser",{skip:!process.env.WORK_PAPER_BROWSER},async()=>{
  const http=require("node:http"),{chromium}=require("playwright");
  const s=snapshot(),normal=paper.printDocument(s,options(s));
  const long=snapshot(Array.from({length:36},(_,i)=>row(i,{customerCode:"A",customerName:"長い名前の確認用店舗",productName:"冷凍天然車海老ホールの長い商品名確認用 ".repeat(3),memo:"水洗い・内臓除去、個別真空、箱詰め順の確認。".repeat(12)})));
  const css=app.match(/<style>([\s\S]*?)<\/style>/)[1];
  const header=app.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[0];
  const fixture=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><link rel="stylesheet" href="app-nav.css"><link rel="stylesheet" href="work-paper.css"><script src="work-paper.js" defer></script></head><body>${header}<input id="unchanged" value="入力途中"><script>function openWorkPaper(){WorkPaper.open(${JSON.stringify(s)})}</script></body></html>`;
  const files=new Map(["app-nav.css","work-paper.css","work-paper.js","yumirume-logo.jpg"].map(f=>["/"+f,fs.readFileSync(path.join(root,f))]));
  const requests=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");requests.push(url.pathname);
    const type=url.pathname.endsWith(".css")?"text/css":url.pathname.endsWith(".js")?"text/javascript":url.pathname.endsWith(".jpg")?"image/jpeg":"text/html";
    res.setHeader("Content-Type",type+"; charset=utf-8");
    if(url.pathname==="/fixture")res.end(fixture);
    else if(url.pathname==="/normal")res.end(normal);
    else if(url.pathname==="/long")res.end(paper.printDocument(long,options(long)));
    else if(files.has(url.pathname))res.end(files.get(url.pathname));
    else{res.statusCode=404;res.end()}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{
    browser=await chromium.launch({channel:"chrome",headless:true});
    const page=await browser.newPage();
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(base+"/normal");
    await page.waitForFunction(()=>!document.getElementById("wp-print-button").disabled);
    assert.equal(await page.locator(".wp-sheet").count(),2);
    assert.equal(await page.locator("[data-source-id]").count(),12);
    assert.equal(await page.locator(".wp-lines tbody tr").count(),12);
    assert.equal(await page.locator(".wp-boxes tbody tr").count(),12);
    assert.equal(await page.locator(".wp-customer").count(),3);
    assert.ok(await page.locator(".wp-head img").evaluateAll(images=>images.every(i=>i.naturalWidth>0)));
    const fits=()=>page.locator(".wp-sheet").evaluateAll(sheets=>sheets.every(s=>s.scrollHeight<=s.clientHeight+2&&s.scrollWidth<=s.clientWidth+2&&s.querySelector("footer").getBoundingClientRect().bottom<=s.getBoundingClientRect().bottom+2));
    assert.ok(await fits());
    if(process.env.WORK_PAPER_OUTPUT){
      fs.mkdirSync(process.env.WORK_PAPER_OUTPUT,{recursive:true});
      await page.emulateMedia({media:"print"});
      for(let i=0;i<2;i++)await page.locator(".wp-sheet").nth(i).screenshot({path:path.join(process.env.WORK_PAPER_OUTPUT,`paper-${i+1}.png`)});
      if(process.env.WORK_PAPER_PDF)await page.pdf({path:path.join(process.env.WORK_PAPER_OUTPUT,"work-paper-qa.pdf"),printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false});
      await page.emulateMedia({media:"screen"});
    }
    await page.goto(base+"/long");
    await page.waitForFunction(()=>!document.getElementById("wp-print-button").disabled,null,{timeout:30000});
    assert.equal(await page.locator("[data-source-id]").count(),36);
    assert.equal(new Set(await page.locator("[data-source-id]").evaluateAll(nodes=>nodes.map(n=>n.dataset.sourceId))).size,36);
    assert.ok(await fits());
    assert.ok(await page.locator(".wp-sheet").count()>4);
    for(const width of [1280,1024,768,390]){
      await page.setViewportSize({width,height:900});await page.goto(base+"/fixture");
      const pageWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
      assert.ok(pageWidth<=width+1,`Header overflow at ${width}: ${pageWidth}`);
      assert.equal(await page.locator("#work-paper-btn").isDisabled(),true);
      await page.evaluate(()=>document.getElementById("export-btn").disabled=false);
      await page.waitForFunction(()=>!document.getElementById("work-paper-btn").disabled);
      await page.locator("#work-paper-btn").click();
      assert.equal(await page.locator("#wp-dialog").isVisible(),true);
      const bounds=await page.locator("#wp-dialog").evaluate(d=>({left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,bottom:d.getBoundingClientRect().bottom,overflow:d.scrollWidth>d.clientWidth+1}));
      assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.bottom<=900&&!bounds.overflow,JSON.stringify({width,bounds}));
      await page.locator("#wp-select-all").uncheck();
      assert.equal(await page.locator('[data-action="print"]').isDisabled(),true);
      await page.locator("[data-group]").first().check();
      assert.equal(await page.locator("#wp-selection-count").textContent(),"4 / 12明細");
      if(process.env.WORK_PAPER_OUTPUT)await page.screenshot({path:path.join(process.env.WORK_PAPER_OUTPUT,`dialog-${width}.png`)});
      if(width===1024){
        const popupPromise=page.waitForEvent("popup");await page.locator('[data-action="print"]').click();
        const popup=await popupPromise;
        await popup.waitForFunction(()=>!document.getElementById("wp-print-button").disabled);
        assert.equal(await popup.locator("[data-source-id]").count(),4);
        assert.equal(await popup.evaluate(()=>window.opener),null);
        assert.equal(await popup.locator(".wp-sheet").count(),2);
        await popup.close();
      }
      await page.keyboard.press("Escape");await page.locator("#wp-dialog").waitFor({state:"detached"});
      assert.equal(await page.locator("#unchanged").inputValue(),"入力途中");
    }
    assert.deepEqual(errors,[]);
    assert.ok(!requests.some(r=>r.includes("supabase")||r.includes("rpc")));
  }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
