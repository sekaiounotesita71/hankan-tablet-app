const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-credit-note-migration.sql"), "utf8");

test("purchase entry offers a distinct credit-note mode", () => {
  assert.match(html, /id="advance-purchase-entry-type"/);
  assert.match(html, /value="credit_note">赤伝・減額</);
  assert.match(html, /function setAdvancePurchaseEntryType/);
  assert.match(html, /数量と単価は正数で入力してください。確定時にマイナス仕入・マイナス買掛として登録します。/);
});

test("credit-note entry is submitted through the versioned atomic RPC", () => {
  assert.match(html, /rpc\("create_confirmed_purchase_batch_v5"/);
  assert.match(html, /p_entry_type:entryType/);
  assert.match(html, /advancePurchaseIsCreditNote\(\)\?Math\.abs\(dbNumber\(row\.actualQty\)\)/);
  assert.match(html, /entryType==="credit_note"\?"赤伝"/);
});

test("database stores purchase credit notes as negative receipts", () => {
  assert.match(sql, /receipt_type in \('order','advance','credit_note'\)/);
  assert.match(sql, /create or replace function public\.create_confirmed_purchase_batch_v5/);
  assert.match(sql, /set receipt_type = 'credit_note'/);
  assert.match(sql, /actual_qty = -abs\(actual_qty\)/);
  assert.match(sql, /line_amount = -abs\(line_amount\)/);
  assert.match(sql, /perform public\.confirm_purchase_receipt\(v_receipt_id\)/);
});

test("negative purchase tax mirrors positive truncation", () => {
  assert.match(html, /rawTax>=0\?Math\.floor\(rawTax\):Math\.ceil\(rawTax\)/);
  assert.match(sql, /when grouped\.taxable_amount >= 0[\s\S]*floor/);
  assert.match(sql, /else ceil\(grouped\.taxable_amount \* grouped\.tax_rate \/ 100\.0\)/);
});
