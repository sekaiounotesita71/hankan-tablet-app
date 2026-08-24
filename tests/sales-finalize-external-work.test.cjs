const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const checkStart = app.indexOf("async function confirmOutstandingExternalWorkBeforeSales()");
const checkEnd = app.indexOf("finalizeSalesTrial=async function()", checkStart);
const externalCheck = app.slice(checkStart, checkEnd);

assert.match(app, /function incompleteSalesWorkRows\(\)\{\s*return rows\.filter\(row=>!row\._stockout&&\(!row\._qty\|\|!row\._net\|\|!row\._box\)\);\s*\}/);
assert.match(externalCheck, /if\(!incompleteSalesWorkRows\(\)\.length\)return true;/);
assert.ok(
  externalCheck.indexOf("if(!incompleteSalesWorkRows().length)return true;") <
    externalCheck.indexOf("if(!sitePartnerSchemaReady)return true;"),
  "Completed work rows must bypass the external-assignment status check"
);
assert.match(app, /const incomplete=incompleteSalesWorkRows\(\)\.length;/);

console.log("Sales finalization external-work tests passed");
