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

test("売上明細は仕入原価の照合完了を待たずに表示する",()=>{
  const source=sourceBetween("async function loadSalesReferenceBoard()","function salesRefResetPage");
  const renderAt=source.indexOf("renderSalesReferenceBoard();",source.indexOf("const baseMessage="));
  const costAt=source.indexOf("void salesRefAttachPurchaseCosts(client,currentRows)");
  assert.ok(renderAt>=0,"初期表示がありません");
  assert.ok(costAt>renderAt,"原価照合より先に初期表示する必要があります");
  assert.ok(!source.includes("await salesRefAttachPurchaseCosts(client,currentRows)"),"原価照合で初期表示を待たせています");
  assert.match(source,/renderSalesReferenceSummary\(\);\s*renderSalesReferenceAnalysis\(\);/);
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
  const source=sourceBetween("async function loadSalesReferenceBoard()","function salesRefResetPage");
  assert.match(source,/const loadSequence=\+\+salesReferenceLoadSequence/);
  assert.ok((source.match(/loadSequence!==salesReferenceLoadSequence/g)||[]).length>=3);
});
