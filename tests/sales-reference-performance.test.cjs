const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");

function sourceBetween(start,end){
  const from=html.indexOf(start);
  const to=html.indexOf(end,from+start.length);
  assert.notEqual(from,-1,`${start} がありません`);
  assert.notEqual(to,-1,`${end} がありません`);
  return html.slice(from,to);
}

test("売上参照では仕入原価を照合せず粗利参照だけで実行する",()=>{
  const salesSource=sourceBetween("async function loadSalesReferenceBoard()","function renderProfitReferenceBoard");
  const profitSource=sourceBetween("async function loadProfitReferenceBoard()","function salesRefResetPage");
  assert.match(salesSource,/renderSalesReferenceBoard\(\);/);
  assert.doesNotMatch(salesSource,/salesRefAttachPurchaseCosts/);
  assert.match(profitSource,/await salesRefAttachPurchaseCosts\(client,currentRows\)/);
  assert.match(profitSource,/renderProfitReferenceBoard\(\)/);
  assert.match(html,/data-workspace-tab="profit"/);
  assert.match(html,/data-workspace-panel="profit"/);
});

test("原価照合の分割問い合わせを制限付きで並列実行する",()=>{
  const helper=sourceBetween("async function salesRefReadChunks","async function salesRefAttachPurchaseCosts");
  const attach=sourceBetween("async function salesRefAttachPurchaseCosts","function salesRefMetrics");
  const suppliers=sourceBetween("async function readOrderSuppliersForAdvancePurchase","function advancePurchaseSalesLinkSchemaMissing");
  assert.match(helper,/Math\.min\(concurrency,chunks\.length\)/);
  assert.match(helper,/await Promise\.all\(workers\)/);
  assert.match(attach,/salesRefReadChunks\(salesIds,200/);
  assert.match(attach,/salesRefReadChunks\(lineIds,200/);
  assert.match(suppliers,/salesRefReadChunks\(sessionIds,100/);
  assert.match(suppliers,/salesRefReadChunks\(sourceIds,200/);
});

test("連続再読込では古い結果を画面へ反映しない",()=>{
  const source=sourceBetween("async function loadSalesReferenceBoard()","function renderProfitReferenceBoard");
  assert.match(source,/const loadSequence=\+\+salesReferenceLoadSequence/);
  assert.ok((source.match(/loadSequence!==salesReferenceLoadSequence/g)||[]).length>=2);
});

test("2ページ目以降の売上を並列で取得する",async()=>{
  const source=sourceBetween("async function salesRefReadPaged","async function salesRefReadCurrentRows");
  const readPaged=new Function(`${source}; return salesRefReadPaged;`)();
  let active=0,maxActive=0;
  const calls=[];
  const rows=await readPaged(includeCount=>({
    range:async(from,to)=>{
      calls.push({includeCount,from,to});
      active++;
      maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--;
      const count=Math.min(1000,2501-from);
      return {data:Array.from({length:count},(_,index)=>from+index),error:null,count:includeCount?2501:null};
    }
  }));
  assert.equal(rows.length,2501);
  assert.deepEqual(calls.map(call=>call.from),[0,1000,2000]);
  assert.equal(calls[0].includeCount,true);
  assert.ok(calls.slice(1).every(call=>call.includeCount===false));
  assert.ok(maxActive>=2,"2ページ目以降が直列取得です");
});

test("年次範囲は月ごとのDB問い合わせへ分割する",()=>{
  const source=sourceBetween("function salesRefSplitQueryRangeByMonth","async function salesRefReadPaged");
  const split=new Function("salesRefEndOfMonth",`${source}; return salesRefSplitQueryRangeByMonth;`)(month=>{
    const [year,value]=month.split("-").map(Number);
    return `${year}-${String(value).padStart(2,"0")}-${String(new Date(year,value,0).getDate()).padStart(2,"0")}`;
  });
  const ranges=split({from:"2026-01-01",to:"2026-12-31"});
  assert.equal(ranges.length,12);
  assert.deepEqual(ranges[0],{from:"2026-01-01",to:"2026-01-31"});
  assert.deepEqual(ranges[11],{from:"2026-12-01",to:"2026-12-31"});
});
