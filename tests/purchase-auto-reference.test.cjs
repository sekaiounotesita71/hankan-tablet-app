const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-auto-reference-migration.sql"), "utf8");
const baseSql = fs.readFileSync(path.join(root, "site-partner-purchase-migration.sql"), "utf8");

assert.doesNotMatch(html, /id="advance-purchase-invoice"/);
assert.doesNotMatch(html, /請求書番号を入力してください/);
assert.match(html, /p_supplier_invoice_no:null/);
assert.match(html, /管理番号<div class="site-readonly">/);
assert.match(html, /数量・単価を照合済みとして仕入を確定しますか/);

for (const source of [sql, baseSql]) {
  assert.match(source, /create sequence if not exists public\.purchase_internal_reference_seq/);
  assert.match(source, /PUR-%s-%s-%s/);
  assert.match(source, /create trigger trg_purchase_receipts_internal_reference/);
  assert.match(source, /where nullif\(btrim\(supplier_invoice_no\),''\) is null/);
  assert.doesNotMatch(source, /Supplier invoice number is required/);
}

assert.match(sql, /invoice_date = coalesce\(invoice_date,purchase_date\)/);
assert.match(sql, /grant execute on function public\.confirm_purchase_receipt\(uuid\) to authenticated/);

console.log("Purchase auto reference tests passed");
