const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const workApp = fs.readFileSync(path.join(root, "index.html"), "utf8");
const orderApp = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const domesticApp = fs.readFileSync(path.join(root, "domestic-sales.html"), "utf8");
const migration = fs.readFileSync(path.join(root, "domestic-intermediary-export-migration.sql"), "utf8");

assert.match(migration, /revenue_route text not null default 'direct_export'/);
assert.match(migration, /revenue_recognition_mode text not null default 'direct_export'/);
assert.match(migration, /create unique index if not exists uq_domestic_sales_source_key/);
assert.match(migration, /create unique index if not exists uq_domestic_sale_lines_source_sales_record/);
assert.match(migration, /create or replace function public\.finalize_export_revenue_route/);
assert.match(migration, /set revenue_recognition_mode = 'customs_only'/);
assert.match(migration, /'export-intermediary:' \|\| p_session_id::text/);
assert.match(migration, /create trigger trg_guard_customs_only_accounts_receivable/);
assert.match(migration, /update public\.work_sessions[\s\S]*set locked = true/);

assert.match(workApp, /\.rpc\("finalize_export_revenue_route"/);
assert.match(workApp, /syncFinalizedSessionToReceivables\(workDate,shippingFees,directImporters\)/);
assert.match(workApp, /revenue_recognition_mode,domestic_sale_id/);

assert.match(orderApp, /id="master-revenue-route"/);
assert.match(orderApp, /id="master-domestic-customer-code"/);
assert.match(orderApp, /rows\.filter\(row=>row\.revenue_recognition_mode!=="customs_only"\)/);
assert.match(orderApp, /row\.revenue_recognition_mode!=="customs_only"&&!row\.is_stockout/);
assert.match(domesticApp, /輸出連動/);
assert.match(domesticApp, /row\.source_type==="export_intermediary"/);

console.log("Domestic intermediary export tests passed");
