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
  assert.match(html,/id="sales-ref-customer" autocomplete="off"/);
  assert.match(html,/id="sales-ref-product" autocomplete="off"/);
  const source=sourceBetween("function salesRefFilterKey","function salesRefGroup");
  assert.match(source,/row\.customer_code,row\.store_name/);
  assert.match(source,/row\.product_id,row\.product_name/);
  assert.match(source,/\.includes\(customer\)/);
  assert.match(source,/\.includes\(product\)/);
});

test("受注入力と同じ独自候補を上下キーとEnterで選択できる",()=>{
  const source=sourceBetween("function salesRefSuggestionMatches","function clearSalesReferenceDetailFilters");
  assert.match(source,/\.slice\(0,10\)/);
  assert.match(source,/inline-product-suggest sales-ref-suggest/);
  assert.match(source,/event\.key==="ArrowDown"/);
  assert.match(source,/event\.key==="ArrowUp"/);
  assert.match(source,/event\.key==="Enter"&&chooseSalesRefSuggestion\(\)/);
  assert.doesNotMatch(html,/id="sales-ref-customer" list=/);
  assert.doesNotMatch(html,/id="sales-ref-product" list=/);
});

test("得意先・商品などの詳細絞り込み中は輸入社単位の送料を加算しない",()=>{
  const source=sourceBetween("function salesRefDetailFilterActive","function salesRefShippingBreakdownData");
  assert.match(source,/sales-ref-customer/);
  assert.match(source,/sales-ref-product/);
  assert.match(source,/sales-ref-search/);
  assert.match(source,/salesRefDetailFilterActive\(\)\?0:salesRefShippingFeeForRows\(rows\)/);
  assert.match(html,/送料売上（除外）/);
});

test("売上数量合計を単位別に集計し欠品・送料調整を除外する",()=>{
  const source=sourceBetween("function salesRefQuantityByUnit","function salesRefMetrics");
  const api=new Function(`
    function salesRefNum(value){const number=Number(value);return Number.isFinite(number)?number:0}
    function salesRefMoney(value){return Number(value).toLocaleString("ja-JP",{maximumFractionDigits:3})}
    function normalizeLineUnit(value){const unit=String(value||"").toLowerCase();if(unit==="kg")return "Kg";if(unit==="pc")return "PC";if(unit==="pkt")return "pkt";if(unit==="cs")return "CS";return String(value||"")}
    ${source};
    return {salesRefQuantityByUnit,salesRefQuantitySummaryText};
  `)();
  const quantities=api.salesRefQuantityByUnit([
    {input_qty:2,input_unit:"kg"},
    {input_qty:1.5,input_unit:"Kg"},
    {input_qty:4,input_unit:"pkt"},
    {input_qty:3,input_unit:"pc"},
    {input_qty:2,input_unit:"CS"},
    {input_qty:100,input_unit:"Kg",is_stockout:true},
    {input_qty:1,input_unit:"式",_shipping_adjustment_amount:500},
    {input_qty:0.5,input_unit:"Kg",_pending_adjustment:true,_pending_entry_type:"credit_note",amount:-1000}
  ]);
  assert.deepEqual(quantities,[["Kg",3],["pkt",4],["PC",3],["CS",2]]);
  assert.equal(api.salesRefQuantitySummaryText(quantities),"3 Kg / 4 pkt / 3 PC / 2 CS");
  assert.match(html,/\["売上数量合計",salesRefQuantitySummaryText\(metrics\.quantityByUnit\),"compact"\]/);
});
