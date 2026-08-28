const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-no-inventory-migration.sql"), "utf8");

assert.doesNotMatch(html, />在庫</);
assert.doesNotMatch(html, /在庫計上/);
assert.doesNotMatch(html, /trackInventory:true/);
assert.doesNotMatch(html, /data-advance-field="trackInventory"/);
assert.match(html, /track_inventory:false/);

assert.match(sql, /alter column track_inventory set default false/);
assert.match(sql, /set track_inventory = false/);
assert.match(sql, /set_config\('app\.purchase_correction','on',true\)/);
assert.match(sql, /new\.track_inventory := false/);
assert.match(sql, /trg_force_purchase_inventory_disabled/);
assert.doesNotMatch(sql, /delete from public\.inventory_lots/);

console.log("Purchase no-inventory tests passed");
