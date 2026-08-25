const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const workApp = fs.readFileSync(path.join(root, "index.html"), "utf8");
const orderApp = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const migration = fs.readFileSync(path.join(root, "jpy-invoice-rounding-migration.sql"), "utf8");

const helperSource = workApp.match(/function roundFinancialAmount\([\s\S]*?\n}\nfunction roundJpyAmount[^\n]+\nfunction roundInvoiceAmount\([\s\S]*?\n}/);
assert.ok(helperSource, "JPY丸めの共通関数が見つかること");

const sandbox = {};
vm.runInNewContext(`${helperSource[0]};this.roundFinancialAmount=roundFinancialAmount;this.roundJpyAmount=roundJpyAmount;this.roundInvoiceAmount=roundInvoiceAmount;`, sandbox);
assert.equal(sandbox.roundJpyAmount(100.49), 100);
assert.equal(sandbox.roundJpyAmount(100.5), 101);
assert.equal(sandbox.roundJpyAmount(-100.5), -101);
assert.equal(sandbox.roundInvoiceAmount(10.126, "USD"), 10.13);

assert.match(workApp, /line\.amount=roundInvoiceAmount\(rawAmount,currency\)/, "Invoice明細を通貨単位で丸めること");
assert.match(workApp, /amount:qty!==null&&price!==null\?roundJpyAmount\(qty\*price\):null/, "売上確定額を明細ごとに1円単位へ丸めること");
assert.match(workApp, /group\.netSales\+=roundJpyAmount\(qty\*price\)/, "売掛は丸め済み明細を合計すること");
assert.match(workApp, /result\["金額"\]=line\.amount/, "Invoice Dataにも丸め済み金額を出力すること");

assert.match(orderApp, /function salesRefJpyAmount\(/, "売上参照にJPY丸め関数があること");
assert.match(orderApp, /group\.netSales\+=arRoundJpy\(/, "売掛再同期で明細を1円単位へ丸めること");
assert.match(orderApp, /amount=!line\.is_stockout[\s\S]*?salesRefJpyAmount\(qty\*price\)/, "未確定速報も同じ丸め規則を使うこと");

assert.match(migration, /trg_normalize_sales_record_jpy_amount/, "売上DBに丸めトリガーを追加すること");
assert.match(migration, /trg_normalize_pending_entry_jpy_amount/, "赤伝DBに丸めトリガーを追加すること");
assert.match(migration, /trg_normalize_accounts_receivable_jpy_amount/, "売掛DBに丸めトリガーを追加すること");
assert.match(migration, /new\.amount_jpy := new\.net_sales_jpy \+ new\.shipping_amount_jpy \+ new\.adjustment_amount_jpy/, "売掛合計は丸め済み内訳の合計にすること");

console.log("jpy-invoice-rounding tests passed");
