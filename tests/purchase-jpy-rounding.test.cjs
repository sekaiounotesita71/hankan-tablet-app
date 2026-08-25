const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const migration = fs.readFileSync(path.join(root, "purchase-jpy-rounding-migration.sql"), "utf8");

const helperSource = app.match(/function salesRefNum\([\s\S]*?\n}\nfunction salesRefJpyAmount\([\s\S]*?\n}\nfunction purchaseJpyAmount\([\s\S]*?\n}/);
assert.ok(helperSource, "仕入JPY丸め関数が見つかること");

const sandbox = {};
vm.runInNewContext(`${helperSource[0]};this.purchaseJpyAmount=purchaseJpyAmount;`, sandbox);
assert.equal(sandbox.purchaseJpyAmount(98363.2), 98363);
assert.equal(sandbox.purchaseJpyAmount(100.5), 101);
assert.equal(sandbox.purchaseJpyAmount(-100.5), -101);

assert.match(app, /return qty===null\|\|price===null\?0:purchaseJpyAmount\(qty\*price\)/, "仕入入力は明細ごとに1円単位へ丸めること");
assert.match(app, /line\.line_amount=purchaseJpyAmount\(Number\(line\.actual_qty\|\|0\)\*Number\(line\.unit_price\|\|0\)\)/, "仕入修正も同じ丸め規則を使うこと");
assert.match(app, /"税抜金額":purchaseJpyAmount\(line\.line_amount\)/, "仕入Excelは丸め済み明細金額を出力すること");

assert.match(migration, /trg_normalize_purchase_receipt_line_jpy_amount/, "仕入明細のDB丸めトリガーを追加すること");
assert.match(migration, /new\.line_amount := round\(new\.actual_qty \* new\.unit_price, 0\)/, "DBも数量×単価を明細ごとに丸めること");
assert.match(migration, /new\.total_amount := new\.subtotal[\s\S]*?\+ new\.tax_amount/, "仕入合計は丸め済み内訳の合計にすること");
assert.match(migration, /trg_normalize_accounts_payable_jpy_amount/, "買掛金額も1円単位に固定すること");
assert.match(migration, /coalesce\(payment\.source_key, ''\) <> 'cash-purchase:'/, "手動支払済みの過去伝票を補正対象から除外すること");

console.log("purchase-jpy-rounding tests passed");
