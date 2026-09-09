const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");

const app=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const css=app.match(/<style>([\s\S]*?)<\/style>/)[1];
function source(start,end){
  const a=app.indexOf(start),b=app.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a);
  return app.slice(a,b);
}
function fixture(){
  const nodes=new Map();
  const ctx={
    document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)}},
    cid:value=>value,esc:value=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;"),
    P1_KEY:{qty:"_qty",net:"_net",box:"_box"},
    rows:["養殖ハマチ","畜養マグロ 腹上","冷凍 天然車エビホール（約320g・大サイズ）","VeryLongProductNameWithoutSpacesForWrapping"].map((name,i)=>({_idx:i,country:"07",importer_id:"07",customer:i===2?"PT.ASIA PANGAN SENTOSA":"確認用店舗",product_name:name,product_id:`00${i}`,csv_qty:"12",unit:"本",_unit:"Kg",_qty:i===1?"12.345":"",_net:"",_box:"",_memo:"個別真空",origin:"",unit_price:"",_stockout:i===3})),
    importerCode:value=>value,importerDisplayName:()=>"JKT",p15MasterPriceSelections:new Set(),
    p15HistoryOpenRowIdx:1,p15HistorySuggestionHtml:()=>'<span>直近候補</span><button class="p15-history-apply">1,200</button><span>2026-09-01</span>',
    p15HistoryDetailHtml:()=>'<div class="p15-history-band">単価履歴</div>',
    p15MasterPriceScope:()=>"contract",p15MasterSelectedRows:()=>[]
  };
  for(const [start,end] of [["function inlineP1Input(","function updateInlineP1Draft("],["function p1TouchCell(","function openP1NP("],["renderP1Cell=function(country,customer){","renderP2Importer=function(imp){"],["function p15RowState(","function moveP15Focus("]])vm.runInNewContext(source(start,end),ctx);
  ctx.renderP1Cell("07","ALL");ctx.renderP15Importer("07");
  const headings=["#","店舗名","商品名","注文数量","注文単位","数量","単位","NET重量","箱番号","メモ","状態",""];
  return `<html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main><div class="tabs-wrap" id="p1-tabs-wrap"><div class="country-tabs"><button class="country-tab">JKT</button></div><div class="customer-panel active"><div class="table-scroll"><table><thead><tr>${headings.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${nodes.get("p1cusbody-07ALL").innerHTML}</tbody></table></div></div></div><div class="tabs-wrap" id="p15-tabs-wrap">${nodes.get("p15content-07").innerHTML}</div></main></html>`;
}

test("work product spacing is scoped to phase 1 and 1.5, including stockout rows",()=>{
  assert.match(css,/main\{width:min\(1680px,100%\)/);
  assert.match(css,/:is\(#p1-tabs-wrap,#p15-tabs-wrap\)[^{]+td\{padding-left:6px;padding-right:6px\}/);
  assert.match(css,/td:nth-child\(3\)\{width:26%;min-width:240px;white-space:normal;overflow-wrap:anywhere;word-break:normal;line-height:1.5\}/);
  assert.match(css,/tr:not\(\.p15-history-detail-row\)/);
  assert.match(fixture(),/text-decoration:line-through/);
});

test("product names fit across desktop, tablet and phone without shrinking touch inputs",{skip:!process.env.WORK_LAYOUT_BROWSER},async()=>{
  const {chromium}=require("playwright");
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{
    const page=await browser.newPage({javaScriptEnabled:false});
    for(const width of [1745,1280,1024,768,390]){
      await page.setViewportSize({width,height:1100});
      await page.setContent(fixture());
      const measurements=await page.evaluate(()=>({
        pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,
        products:Array.from(document.querySelectorAll('.table-scroll>table>tbody>tr:not(.p15-history-detail-row)>td:nth-child(3)')).map(e=>({width:e.getBoundingClientRect().width,overflow:e.scrollWidth>e.clientWidth,text:e.innerText})),
        inputs:Array.from(document.querySelectorAll('.inline-work-input,.p15-input')).map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,cellWidth:e.parentElement.getBoundingClientRect().width})),
        historyPadding:getComputedStyle(document.querySelector('.p15-history-detail-row td')).paddingLeft
      }));
      assert.ok(measurements.pageWidth<=width+1,`Page overflow at ${width}`);
      assert.ok(measurements.products.every(p=>p.width>=239&&!p.overflow),`Product width at ${width}`);
      assert.ok(measurements.inputs.every(i=>i.height>=39&&i.width>=91&&i.width<=i.cellWidth),`Touch input dimensions at ${width}`);
      assert.equal(measurements.historyPadding,"0px");
      console.log(JSON.stringify({width,productWidths:measurements.products.map(p=>Math.round(p.width))}));
      if(process.env.WORK_LAYOUT_SCREENSHOTS){
        fs.mkdirSync(process.env.WORK_LAYOUT_SCREENSHOTS,{recursive:true});
        await page.screenshot({path:path.join(process.env.WORK_LAYOUT_SCREENSHOTS,`work-${width}.png`),fullPage:true});
      }
    }
  }finally{await browser.close()}
});
