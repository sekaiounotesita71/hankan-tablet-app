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

test("赤伝入力に商品コード別の販売単価履歴を表示する",()=>{
  assert.match(html,/id="post-sale-price-history-state"/);
  assert.match(html,/id="post-sale-price-history-list"/);
  assert.match(html,/id="post-sale-product-code"[^>]+oninput="schedulePostSalePriceHistory\(\)"/);
  const source=sourceBetween("async function loadPostSalePriceHistory","function applyPostSalePriceHistory");
  assert.match(source,/from\("sales_records"\)/);
  assert.match(source,/from\("historical_sales_records"\)/);
  assert.match(source,/\.eq\("product_id",productCode\)/);
  assert.match(source,/\.limit\(50\)/);
});

test("同じ得意先・輸入社の単価履歴を優先して最大10件にする",()=>{
  const source=sourceBetween("function postSalePriceHistoryDate","function renderPostSalePriceHistory");
  const api=new Function(`
    function normalizeImporterCode(value){return String(value||"").trim().replace(/^0+/,"")}
    function normalizeMasterSearchText(value){return String(value||"").normalize("NFKC").toLowerCase().replace(/\\s+/g,"")}
    ${source};
    return {postSalePrioritizePriceHistory};
  `)();
  const rows=api.postSalePrioritizePriceHistory([
    {work_date:"2026-08-25",importer_code:"02",store_name:"OTHER",unit_price:300},
    {work_date:"2026-07-01",importer_code:"02",store_name:"TARGET",unit_price:200},
    {work_date:"2026-08-26",importer_code:"03",store_name:"TARGET",unit_price:400}
  ],{importerCode:"2",customerName:"target"});
  assert.deepEqual(rows.map(row=>row.unit_price),[200,300,400]);
  assert.equal(rows[0].sameCustomer,true);
  assert.equal(rows[0].sameImporter,true);
});

test("履歴から数量は変えず単位と単価だけを赤伝へ反映する",()=>{
  const source=sourceBetween("function applyPostSalePriceHistory","function postSaleNormalizedAmount");
  assert.match(source,/post-sale-unit/);
  assert.match(source,/post-sale-unit-price/);
  assert.match(source,/post-sale-amount/);
  assert.doesNotMatch(source,/postSaleSetValue\("post-sale-qty"/);
  assert.match(source,/document\.getElementById\("post-sale-qty"\)\?\.focus/);
});
