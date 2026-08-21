const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
scripts.forEach((script, index) => new vm.Script(script, { filename: `order-entry-inline-${index}.js` }));

assert.match(html, /onclick="printReceivableListPdf\(\)">売掛一覧PDF/);
assert.match(html, /onclick="printCustomerLedgerPdf\(\)">得意先明細PDF/);
assert.match(html, /onclick="printPayableListPdf\(\)">買掛一覧PDF/);
assert.match(html, /onclick="printSupplierLedgerPdf\(\)">仕入先明細PDF/);

assert.match(html, /function writeAccountingReport\(/);
assert.match(html, /@page\{size:A4 \$\{orientation\}/);
assert.match(html, /thead\{display:table-header-group\}/);

assert.match(html, /const result=arFilteredRows\(\)/);
assert.match(html, /_state:arRecordState\(row\)/);
assert.match(html, /const result=apFilteredRows\(\)/);
assert.match(html, /_state:apRecordState\(row\)/);

assert.match(html, /function receivableLedgerRows\(importer,range\)/);
assert.match(html, /arNumber\(payment\.amount_jpy\)\+arNumber\(payment\.bank_fee_jpy\)/);
assert.match(html, /function payableLedgerRows\(supplierCode,range\)/);
assert.match(html, /payments\.filter\(payment=>beforeFrom\(payment\.payment_date\)\)\.reduce\(\(sum,payment\)=>sum\+arNumber\(payment\.amount_jpy\),0\)/);
assert.match(html, /期間開始前残高/);
assert.match(html, /async function printStatementOfAccount\(\)[\s\S]*?const range=salesRefDateRangeFromText\(val\("ar-date-range"\)\)/);
assert.match(html, /async function printCustomerLedgerPdf\(\)[\s\S]*?const range=receivableView==="detail"\?salesRefDateRangeFromText/);

console.log("Accounting PDF report tests passed");
