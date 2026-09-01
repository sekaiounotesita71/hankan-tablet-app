const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-tax-rate-migration.sql"), "utf8");

assert.match(sql, /tax_rate in \(0,8,10\)/);
assert.match(sql, /add column if not exists tax_override boolean not null default true/);
assert.match(sql, /alter column tax_override set default false/);
assert.match(sql, /sum\(floor\(grouped\.taxable_amount \* grouped\.tax_rate \/ 100\.0\)\)/);
assert.match(sql, /after insert or update of receipt_id,line_amount,tax_rate or delete/);
assert.match(sql, /create or replace function public\.create_purchase_batch_v3/);
assert.match(sql, /case when v_has_sales_links then 'order' else 'advance' end/);
assert.match(sql, /v_tax_rate not in \(0,8,10\)/);
assert.match(sql, /unit_price, price_unit, tax_rate, line_amount/);

assert.match(html, /function purchaseTaxRateOptions/);
assert.match(html, /taxRate:8/);
assert.match(html, /data-advance-field="taxRate"/);
assert.match(html, /tax_rate:Number\(row\.taxRate\?\?8\)/);
assert.match(html, /税率から自動/);
assert.match(html, /税額を手入力/);
assert.match(html, /savePurchaseTaxMode/);
assert.match(html, /create_confirmed_purchase_batch_v5/);

console.log("Purchase tax rate tests passed");
