const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const stateStart = app.indexOf("function p15RowState(row)");
const stateEnd = app.indexOf("function renderP15Importer", stateStart);
const p15RowState = new Function(`${app.slice(stateStart, stateEnd)}; return p15RowState;`)();

assert.match(app, /function p15RowState\(row\)\{/);
assert.match(app, /const complete=!missingOrigin&&!missingPrice;/);
assert.match(app, /産地・売価 未入力/);
assert.match(app, /state\.complete\?"":"p15-incomplete"/);
assert.match(app, /state\.missingOrigin\?" p15-input-missing":""/);
assert.match(app, /state\.missingPrice\?" p15-input-missing":""/);
assert.match(app, /pending\?"has-pending":"all-done"/);
assert.match(app, /\.p15-incomplete>td\{background:var\(--danger-bg\)!important\}/);
assert.deepEqual(p15RowState({origin: "", unit_price: ""}), {missingOrigin: true, missingPrice: true, complete: false, label: "産地・売価 未入力"});
assert.deepEqual(p15RowState({origin: "HOKKAIDO", unit_price: ""}), {missingOrigin: false, missingPrice: true, complete: false, label: "売価 未入力"});
assert.deepEqual(p15RowState({origin: "", unit_price: 1200}), {missingOrigin: true, missingPrice: false, complete: false, label: "産地 未入力"});
assert.deepEqual(p15RowState({origin: "HOKKAIDO", unit_price: 0}), {missingOrigin: false, missingPrice: false, complete: true, label: "完了"});

console.log("Phase 1.5 incomplete highlight tests passed");
