const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const workApp = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "order-supplier-review-migration.sql"), "utf8");
const unconfirmSql = fs.readFileSync(path.join(root, "order-supplier-unconfirm-migration.sql"), "utf8");

assert.match(app, /data-workspace-tab="supplier-board"/);
assert.match(app, /data-workspace-panel="supplier-board"/);
assert.match(app, /function renderSupplierReviewBoard\(\)/);
assert.match(app, /saveConfirmedBatches\(\);\s*renderConfirmedOrders\(\);/);
assert.doesNotMatch(app, /\brenderConfirmed\(\)/);
assert.match(app, /function setSupplierReviewLineOrdered\(lineId,ordered\)/);
assert.match(app, /function setSupplierReviewGroupOrdered\(index,ordered\)/);
assert.match(app, /全明細 発注済み/);
assert.match(app, /全明細コード変更/);
assert.match(app, /このコードで確定/);
assert.match(app, /確定取消/);
assert.match(app, /list_order_supplier_review/);
assert.match(app, /update_order_supplier_review/);
assert.match(app, /unconfirm_order_supplier_review/);
assert.match(app, /set_order_lines_purchase_ordered/);
assert.match(app, /initial_supplier_code:dbText\(row\.initialSupplierCode\|\|row\.supplierCode\)/);
assert.match(app, /purchase_ordered:!!row\.purchaseOrdered/);
assert.match(workApp, /order-entry-beta\.html#supplier-board/);

assert.match(sql, /add column if not exists initial_supplier_code text/);
assert.match(sql, /add column if not exists purchase_ordered boolean not null default false/);
assert.match(sql, /create table if not exists public\.order_supplier_review_log/);
assert.match(sql, /create or replace view public\.order_supplier_review/);
assert.match(sql, /create or replace function public\.list_order_supplier_review/);
assert.match(sql, /create or replace function public\.update_order_supplier_review/);
assert.match(sql, /create or replace function public\.unconfirm_order_supplier_review/);
assert.match(sql, /create or replace function public\.set_order_lines_purchase_ordered/);
assert.match(sql, /new\.purchase_ordered := false/);
assert.match(sql, /External work has already been published/);
assert.match(sql, /'supplier_unconfirm'/);
assert.match(unconfirmSql, /create or replace function public\.unconfirm_order_supplier_review/);
assert.match(unconfirmSql, /supplier_decision_status = 'provisional'/);
assert.match(unconfirmSql, /purchase_ordered = false/);
assert.match(unconfirmSql, /External work has already been published/);

console.log("Order supplier review tests passed");
