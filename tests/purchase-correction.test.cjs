const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-correction-migration.sql"), "utf8");

assert.match(html, /function unlockPurchaseReceiptForCorrection\(id\)/);
assert.match(html, /unlock_purchase_receipt_for_correction/);
assert.match(html, /修正解除/);
assert.match(html, /修正を再確定/);
assert.match(html, /修正理由を入力してください/);
assert.match(html, /purchaseSiteOptions/);
assert.match(html, /savePurchaseSupplier/);
assert.match(html, /'product_code'/);
assert.match(html, /'product_name'/);

assert.match(sql, /create table if not exists public\.purchase_correction_log/);
assert.match(sql, /create or replace function public\.unlock_purchase_receipt_for_correction/);
assert.match(sql, /if not public\.is_master_admin\(\)/);
assert.match(sql, /accounts_payable_payments/);
assert.match(sql, /inventory_allocations/);
assert.match(sql, /correction_unlocked = true/);
assert.match(sql, /correction_unlocked = false/);
assert.match(sql, /create trigger trg_guard_confirmed_purchase_receipt/);
assert.match(sql, /create trigger trg_guard_confirmed_purchase_line/);
assert.match(sql, /perform public\.sync_confirmed_purchases_to_payables\(\)/);

console.log("Purchase correction tests passed");
