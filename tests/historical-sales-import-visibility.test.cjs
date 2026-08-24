const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "order-entry-beta.html"), "utf8");

assert.match(app, /<div class="historical-sales-import" hidden aria-hidden="true">/);
assert.match(app, /function importHistoricalSalesCsv\(/);
assert.match(app, /function saveHistoricalSalesImport\(/);

console.log("Historical-sales import visibility tests passed");
