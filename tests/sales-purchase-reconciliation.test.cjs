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

const allocationSource=sourceBetween("function salesRefPurchaseCodeKeys","async function salesRefReadImportedPurchaseCosts");
const allocation=new Function(
  "normalizeMasterSearchText","salesRefCostQuantity","salesRefNum","salesRefMonth","salesRefRowDate","purchaseJpyAmount",
  `${allocationSource}; return {salesRefPurchaseCodeKeys,salesRefImportedPurchaseMatches,salesRefAllocateImportedPurchaseCosts};`
)(
  value=>String(value||"").normalize("NFKC").toUpperCase().replace(/\s+/g,"").replace(/[蓄畜]養/g,"畜養"),
  (row,unit)=>String(unit||"").toLowerCase()==="kg"?Number(row.net_weight)||0:Number(row.input_qty)||0,
  value=>Number(value)||0,
  value=>String(value||"").slice(0,7),
  row=>row.work_date||"",
  value=>Math.sign(Number(value)||0)*Math.round(Math.abs(Number(value)||0)+Number.EPSILON)
);

test("OLD商品コードを現行コードへ月次照合して数量比で配分する",()=>{
  const sales=[
    {id:"s1",work_date:"2026-08-03",product_id:"422",product_name:"ウニ",input_qty:1,input_unit:"pkt",net_weight:.1},
    {id:"s2",work_date:"2026-08-10",product_id:"422",product_name:"ウニ",input_qty:2,input_unit:"pkt",net_weight:.2},
    {id:"s3",work_date:"2026-08-17",product_id:"157C",product_name:"畜養マグロ 腹上",input_qty:1,input_unit:"Kg",net_weight:4},
    {id:"s4",work_date:"2026-08-17",product_id:"999",product_name:"別商品",input_qty:1,input_unit:"PC",_purchaseCostActual:50,_purchaseCostSource:"linked"}
  ];
  const receipts=[{id:"r1",purchase_date:"2026-08-18",note:"PDF一括取込ID:purchase-aug-2026-v1"}];
  const lines=[
    {id:"l1",receipt_id:"r1",product_code:"OLD-422",product_name:"生ウニ",actual_qty:3,actual_unit:"pkt",price_unit:"pkt",line_amount:300},
    {id:"l2",receipt_id:"r1",product_code:"OLD-4157",product_name:"畜養マグロ",actual_qty:4,actual_unit:"Kg",price_unit:"Kg",line_amount:200},
    {id:"l3",receipt_id:"r1",product_code:"OLD-999",product_name:"別商品",actual_qty:1,actual_unit:"PC",price_unit:"PC",line_amount:80},
    {id:"l4",receipt_id:"r1",product_code:"OLD-777",product_name:"未販売",actual_qty:1,actual_unit:"PC",price_unit:"PC",line_amount:70}
  ];
  const result=allocation.salesRefAllocateImportedPurchaseCosts(sales,receipts,lines,new Set(["l3"]));
  assert.equal(result.matchedLines,2);
  assert.equal(result.matchedSales,3);
  assert.equal(result.matchedCost,500);
  assert.equal(result.unmatchedLines,1);
  assert.equal(result.unmatchedCost,70);
  assert.equal(Math.round(sales[0]._purchaseCostActual),100);
  assert.equal(Math.round(sales[1]._purchaseCostActual),200);
  assert.equal(Math.round(sales[2]._purchaseCostActual),200);
  assert.equal(sales[3]._purchaseCostActual,50);
  assert.equal(sales[0]._purchaseCostSource,"monthly_pdf");
});

test("PDF一括取込以外の通常事前仕入は自動配分しない",()=>{
  const sales=[{id:"s1",work_date:"2026-08-03",product_id:"422",product_name:"ウニ",input_qty:1,input_unit:"pkt"}];
  const receipts=[{id:"r1",purchase_date:"2026-08-03",note:"通常の事前仕入"}];
  const lines=[{id:"l1",receipt_id:"r1",product_code:"422",product_name:"ウニ",line_amount:100}];
  const result=allocation.salesRefAllocateImportedPurchaseCosts(sales,receipts,lines);
  assert.equal(result.matchedLines,0);
  assert.equal(sales[0]._purchaseCostActual,undefined);
});

test("粗利画面はマスタ仕入単価を基準に表示する",()=>{
  assert.match(html,/商品別粗利はマスタ仕入単価で計算/);
  assert.match(html,/全体粗利は、期間内の純売上から仕入確定/);
  assert.match(html,/原価未設定商品（売上金額順）/);
  assert.doesNotMatch(html,/明細リンク \$\{metrics\.linkedCostCount\}件/);
});

test("粗利画面は国内商品売上を読み込み輸出と合算する",()=>{
  const domestic=sourceBetween("async function salesRefReadDomesticRows","async function salesRefReadProvisionalRows");
  const profitLoad=sourceBetween("async function loadProfitReferenceBoard","function salesRefResetPage");
  const attach=sourceBetween("async function salesRefAttachMasterCostContext","function salesRefQuantityByUnit");
  assert.match(domestic,/from\("domestic_sales"\)/);
  assert.match(domestic,/from\("domestic_sale_lines"\)/);
  assert.match(domestic,/amount:salesRefJpyAmount\(line\.net_amount_jpy\)/);
  assert.match(domestic,/_domesticSale:true/);
  assert.match(profitLoad,/profitReferenceRows=\[\.\.\.salesReferenceRows,\.\.\.domesticRows\]/);
  assert.match(profitLoad,/salesRefAttachMasterCostContext\(currentRows\)/);
  assert.doesNotMatch(profitLoad,/salesRefAttachPurchaseCosts/);
  assert.match(attach,/activeRows=\(rows\|\|\[\]\)\.filter\(row=>row\.id&&!row\.is_stockout&&!row\._domesticSale\)/);
  assert.match(attach,/readOrderSuppliersForAdvancePurchase\(activeRows\)/);
  assert.doesNotMatch(attach,/salesRefAllocateImportedPurchaseCosts/);
  assert.match(html,/合算純売上/);
  assert.match(html,/輸出・国内別粗利/);
});

test("粗利は送料を含まない純売上から計算する",()=>{
  const metrics=sourceBetween("function salesRefMetrics","function salesRefProfitGroups");
  assert.match(metrics,/const totalSales=netSales\+shippingSales/);
  assert.match(metrics,/costedSales\+=salesRefNum\(row\.amount\)/);
  assert.match(metrics,/const grossProfit=costedSales-purchaseCost/);
  assert.doesNotMatch(metrics,/grossProfit=totalSales-purchaseCost/);
});

test("原価未設定を含む商品別集計は粗利を表示しない",()=>{
  const table=sourceBetween("function salesRefProfitTable","function salesRefUnpricedProductGroups");
  const analysis=sourceBetween("function salesRefProfitAnalysisHtml","function salesRefRatio");
  assert.match(table,/incomplete=row\.unpriced>0/);
  assert.match(table,/算出不可/);
  assert.match(analysis,/aggregateGrossProfit=metrics\.netSales-periodPurchaseCost/);
  assert.match(analysis,/全体粗利には影響しません/);
});

test("全体粗利は同期間の仕入確定を税抜で集計する",()=>{
  const summary=sourceBetween("async function salesRefReadPurchaseSummary","async function loadProfitReferenceBoard");
  const load=sourceBetween("async function loadProfitReferenceBoard","function salesRefResetPage");
  assert.match(summary,/receipt\.status==="confirmed"/);
  assert.match(summary,/purchaseJpyAmount\(receipt\.subtotal\)/);
  assert.match(summary,/purchaseJpyAmount\(receipt\.shipping_fee\)\+purchaseJpyAmount\(receipt\.other_fee\)/);
  assert.match(summary,/cost:subtotal\+fees/);
  assert.match(load,/salesRefReadPurchaseSummary\(client,range\)/);
});

test("PDF仕入は全期間検索せず対象月だけ取得する",()=>{
  const source=sourceBetween("async function salesRefReadImportedPurchaseCosts","async function salesRefAttachPurchaseCosts");
  assert.doesNotMatch(source,/\.ilike\("note"/);
  assert.match(source,/\.gte\("purchase_date",`\$\{month\}-01`\)/);
  assert.match(source,/\.lte\("purchase_date",salesRefEndOfMonth\(month\)\)/);
  assert.match(source,/startsWith\("PDF一括取込ID:"\)/);
});

test("売上参照の期間空欄は当月を初期値にする",()=>{
  const source=sourceBetween("function salesRefDatabaseRange","async function salesRefReadPaged");
  assert.match(source,/if\(!input\.raw\)/);
  assert.match(source,/sales-ref-date-range/);
  assert.match(source,/salesRefDateRangeFromText\(month\)/);
  assert.match(source,/dataset\.periodAll==="true"/);
  assert.match(source,/label:"全期間"/);
});
