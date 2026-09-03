const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const orders = read("order-entry-beta.html");
const work = read("index.html");
const domestic = read("domestic-sales.html");

const orderStart = orders.indexOf("async function confirmCustomerOrder(options={})");
const orderEnd = orders.indexOf("function groupedBySupplier", orderStart);
const orderConfirm = orders.slice(orderStart, orderEnd);

assert.match(orderConfirm, /if\(appBusy\)return false;/);
assert.ok(orderConfirm.indexOf("const batch=currentBatch()") < orderConfirm.indexOf("await learnLineDictionaryFromOrders"));
assert.ok(orderConfirm.indexOf("setAppBusy(true") < orderConfirm.indexOf("await learnLineDictionaryFromOrders"));
assert.match(orderConfirm, /finally\{\s*setAppBusy\(false\);\s*\}/);
assert.match(orders, /id="confirm-customer-order-button"/);
assert.match(orders, /document\.addEventListener\("click",e=>\{\s*if\(!appBusy\)return;\s*e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);\s*\},true\);/);
assert.match(orders, /function protectSingleSubmitAction\(name\)/);
assert.match(orders, /"confirmCustomerOrder","savePendingEntry","setPendingStatus","saveHistoricalSalesImport"/);

const saveMarker = work.indexOf("const createdNewSession=!currentSessionId;");
const saveStart = work.lastIndexOf("async function saveCurrentSessionToSupabase()", saveMarker);
const saveEnd = work.indexOf("function boxInput", saveMarker);
const workSave = work.slice(saveStart, saveEnd);

assert.match(workSave, /if\(workSessionSaveInProgress\)/);
assert.ok(workSave.indexOf("workSessionSaveInProgress=true") < workSave.indexOf("await requireSupabaseLogin"));
assert.match(workSave, /finally\{\s*workSessionSaveInProgress=false;\s*updateCloudSaveButton\(\);\s*\}/);

const finalizeStart = work.indexOf("finalizeSalesTrial=async function(){");
const finalizeEnd = work.indexOf("function sessionListStatusLabelTrial", finalizeStart);
const workFinalize = work.slice(finalizeStart, finalizeEnd);

assert.match(workFinalize, /if\(salesFinalizeInProgress\)/);
assert.ok(workFinalize.indexOf("salesFinalizeInProgress=true") < workFinalize.indexOf("await saveCurrentSessionToSupabase"));
assert.match(workFinalize, /finally\{\s*salesFinalizeInProgress=false;\s*updateLockUITrial\(\);\s*\}/);

assert.match(domestic, /document\.addEventListener\("click",event=>\{\s*if\(!appBusy\)return;\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*\},true\);/);
assert.match(domestic, /document\.addEventListener\("submit",event=>\{\s*if\(!appBusy\)return;/);
assert.match(domestic, /"confirmDomesticSale","saveDomesticSaleCorrection","cancelSale","recordPayment"/);

console.log("Double-submit protection tests passed");
