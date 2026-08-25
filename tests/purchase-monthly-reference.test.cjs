const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-monthly-reference-migration.sql"), "utf8");

assert.match(app, /id="advance-purchase-reference-mode"/);
assert.match(app, /id="advance-purchase-reference-period"/);
assert.match(app, /function advancePurchaseReferenceRange\(\)/);
assert.match(app, /\.gte\("work_date",fromDate\)\s*\.lte\("work_date",toDate\)/);
assert.match(app, /referenceRange\.mode==="month"/);
assert.match(app, /setAdvancePurchaseImportMode\("product",\{save:false\}\)/);
assert.match(app, /supplier\.purchaseReferenceMode\|\|"day"/);
assert.match(app, /purchase_reference_mode:supplierPurchaseReferenceMode\(item\.purchaseReferenceMode\)/);
assert.match(app, /purchaseReferenceMode:supplierPurchaseReferenceMode\(row\.purchase_reference_mode\)/);
assert.match(app, /sourceSalesIds:\[\]/);
assert.match(app, /readImportedSalesIdsForAdvancePurchase/);

assert.match(sql, /alter table public\.supplier_master/);
assert.match(sql, /add column if not exists purchase_reference_mode text not null default 'day'/);
assert.match(sql, /check \(purchase_reference_mode in \('day','month'\)\)/);

console.log("Purchase monthly sales-reference tests passed");
