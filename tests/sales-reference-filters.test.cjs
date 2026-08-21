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

test("年・月・日付範囲を期間として入力できる",()=>{
  const source=sourceBetween("function salesRefDateInputEndOfMonth","function salesRefDateRangeFromInput");
  const parse=new Function(`${source}; return salesRefDateRangeFromText;`)();
  assert.deepEqual(parse("2026"),{from:"2026-01-01",to:"2026-12-31",raw:"2026"});
  assert.deepEqual(parse("202608"),{from:"2026-08-01",to:"2026-08-31",raw:"202608"});
  assert.deepEqual(parse("20260801-20260815"),{from:"2026-08-01",to:"2026-08-15",raw:"20260801-20260815"});
});

test("得意先と商品を専用候補から組み合わせて絞り込める",()=>{
  assert.match(html,/id="sales-ref-customer" list="sales-ref-customer-list"/);
  assert.match(html,/id="sales-ref-product" list="sales-ref-product-list"/);
  const source=sourceBetween("function salesRefFilterKey","function salesRefGroup");
  assert.match(source,/row\.customer_code,row\.store_name/);
  assert.match(source,/row\.product_id,row\.product_name/);
  assert.match(source,/\.includes\(customer\)/);
  assert.match(source,/\.includes\(product\)/);
});
