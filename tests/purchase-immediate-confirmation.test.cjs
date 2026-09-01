const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-immediate-confirmation-migration.sql"), "utf8");

assert.match(sql, /create or replace function public\.create_confirmed_purchase_batch_v4/);
assert.match(sql, /v_receipt_id := public\.create_purchase_batch_v3/);
assert.match(sql, /perform public\.confirm_purchase_receipt\(v_receipt_id\)/);
assert.doesNotMatch(sql, /update public\.purchase_receipts/);

assert.match(html, />仕入確定 Ctrl\+Enter</);
assert.match(html, /rpc\("create_confirmed_purchase_batch_v5"/);
assert.match(html, /purchase-filter-status"\)\.value="confirmed"/);
assert.match(html, /expected">本社確認待ち</);
assert.doesNotMatch(html, />未照合</);
assert.doesNotMatch(html, />事前仕入</);

console.log("Purchase immediate confirmation tests passed");
