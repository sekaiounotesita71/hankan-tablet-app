const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "advance-purchase-batch-migration.sql"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing marker: ${startMarker}`);
  assert.ok(end > start, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const manualBatchSql = sourceBetween(
  sql,
  "create or replace function public.create_advance_purchase_batch(",
  "create or replace function public.create_advance_purchase_batch_v2("
);
const salesLinkedBatchSql = sourceBetween(
  sql,
  "create or replace function public.create_advance_purchase_batch_v2(",
  "revoke all on function public.create_advance_purchase_batch_v2"
);

assert.match(manualBatchSql, /\) values \(\s*'advance',/);
assert.match(salesLinkedBatchSql, /\) values \(\s*'order',/);
assert.match(sql, /where receipt\.receipt_type = 'advance'[\s\S]*purchase_sales_links/);

const labelSource = sourceBetween(
  html,
  "function purchaseReceiptTypeLabel",
  "async function loadPurchaseReceipts"
);
const purchaseReceiptTypeLabel = new Function(`${labelSource}; return purchaseReceiptTypeLabel;`)();

assert.equal(purchaseReceiptTypeLabel({ receipt_type: "advance" }), "事前仕入");
assert.equal(purchaseReceiptTypeLabel({ receipt_type: "order", source_assignment_id: null }), "売上連動仕入");
assert.equal(purchaseReceiptTypeLabel({ receipt_type: "order", source_assignment_id: "assignment-id" }), "外部作業");

const saveSource = sourceBetween(
  html,
  "async function saveAdvancePurchaseBatch",
  "function initialWorkspaceTab"
);
assert.match(saveSource, /hasSalesLinks\?"create_advance_purchase_batch_v2":"create_advance_purchase_batch"/);
assert.match(saveSource, /hasSalesLinks\?"売上連動仕入":"事前仕入"/);

console.log("Purchase receipt type tests passed");
