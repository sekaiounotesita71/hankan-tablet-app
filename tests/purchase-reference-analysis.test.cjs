const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");

assert.doesNotMatch(html, /getElementById\("purchase-filter-date"\)/);
assert.match(html, /getElementById\("purchase-filter-date-range"\)/);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing marker: ${startMarker}`);
  assert.ok(end > start, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const metricsSource = sourceBetween(
  html,
  "function purchaseRefMetrics",
  "function purchaseRefFilterByDate"
);
const analytics = new Function(
  "salesRefNum",
  "purchaseJpyAmount",
  `${metricsSource}; return { purchaseRefMetrics, purchaseRefGroupReceipts, purchaseRefGroupLines };`
)(value => Number(value) || 0, value => Math.sign(Number(value) || 0) * Math.round(Math.abs(Number(value) || 0) + Number.EPSILON));

const receipts = [
  {
    purchase_date: "2026-08-01",
    supplier_code: "S1",
    subtotal: 1000,
    shipping_fee: 100,
    other_fee: 20,
    tax_amount: 80,
    total_amount: 1200,
    lines: [
      { product_code: "P1", actual_qty: 2, actual_unit: "Kg", line_amount: 600 },
      { product_code: "P2", actual_qty: 4, actual_unit: "PC", line_amount: 400 }
    ]
  },
  {
    purchase_date: "2026-08-02",
    supplier_code: "S2",
    subtotal: 500,
    shipping_fee: 0,
    other_fee: 0,
    tax_amount: 40,
    total_amount: 540,
    lines: [{ product_code: "P1", actual_qty: 1, actual_unit: "Kg", line_amount: 500 }]
  }
];

assert.deepEqual(
  analytics.purchaseRefMetrics(receipts),
  {
    rows: receipts,
    lines: [...receipts[0].lines, ...receipts[1].lines],
    receiptCount: 2,
    lineCount: 3,
    subtotal: 1500,
    shipping: 120,
    tax: 120,
    total: 1740,
    suppliers: 2,
    products: 2,
    average: 870
  }
);
assert.equal(analytics.purchaseRefGroupReceipts(receipts, row => row.purchase_date.slice(0, 7))[0].amount, 1740);
const productGroups = analytics.purchaseRefGroupLines(receipts, line => line.product_code);
assert.equal(productGroups.find(row => row.key === "P1").amount, 1100);
assert.deepEqual(productGroups.find(row => row.key === "P1").quantityByUnit, { Kg: 3 });

assert.match(html, /id="purchase-filter-date-range"/);
assert.match(html, /setPurchaseReferencePeriod\('recent'\)/);
assert.match(html, /setPurchaseReferencePeriod\('month'\)/);
assert.match(html, /setPurchaseReferencePeriod\('year'\)/);
assert.match(html, /function purchaseRefMonthlyYoYRows/);
assert.match(html, /function purchaseRefAnalysisSnapshot/);
assert.match(html, /function purchaseRefSupplierLabel/);
assert.match(html, /purchaseRefGroupReceipts\(rows,purchaseRefSupplierLabel\)/);
assert.match(html, /function exportPurchaseReferenceExcel/);
assert.match(html, /月別仕入・昨対/);
assert.match(html, /年別仕入/);
assert.match(html, /仕入先別/);
assert.match(html, /商品別/);
assert.match(html, /salesRefReadPaged/);
assert.match(html, /purchaseDateRange\.value=purchaseRefRecentRange\(31\)/);
assert.match(html, /id="purchase-filter-status"[^>]*>[\s\S]*?<option value="" selected>全状態<\/option>/);
const loadSource = sourceBetween(html, "async function loadPurchaseReceipts", "function purchaseReceiptCardHtml");
assert.doesNotMatch(loadSource, /\.limit\(500\)/);
assert.match(loadSource, /salesRefReadChunks\(ids,100,chunk=>salesRefReadPaged/);
assert.match(loadSource, /select\("\*",includeCount\?\{count:"exact"\}:undefined\)/);
assert.doesNotMatch(loadSource, /for\(let index=0;index<ids\.length;index\+=200\)/);

console.log("Purchase reference analysis tests passed");
