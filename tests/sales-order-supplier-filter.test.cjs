const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const html = fs.readFileSync(path.join(__dirname, "..", "order-entry-beta.html"), "utf8");
function section(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
function sale(id, source, extra = {}) {
  return {id, session_id: "session-a", source_row_no: source, source_type: "\u73fe\u5834\u78ba\u5b9a", work_date: "2026-09-01", importer_code: "DIM", product_id: "100", product_name: "Fish", store_name: "Shop", customer_code: "C1", input_qty: 2, amount: 1000, ...extra};
}
function runtime(rows = [], read = async () => new Map()) {
  const fields = {"sales-ref-supplier": "", "sales-ref-importer": "", "sales-ref-customer": "", "sales-ref-product": "", "sales-ref-search": "", "sales-ref-status": "confirmed"};
  const context = vm.createContext({
    salesReferenceRows: rows, salesRefSupplierCache: {rows: null, ready: false, promise: null, error: ""},
    val: id => fields[id] || "",
    salesRefFilterKey: value => String(value || "").normalize("NFKC").toLowerCase(),
    salesRefText: value => String(value || ""),
    salesRefRowDate: row => row.work_date,
    salesRefRowImporter: row => ({search: row.importer_code.toLowerCase(), label: row.importer_code}),
    salesRefDateRangeFromInput: () => ({raw: "202609", from: "2026-09-01", to: "2026-09-30"}),
    salesRefIsProvisional: row => !!row._sales_provisional,
    salesRefResetPage: () => {}, renderSalesReferenceBoard: () => {},
    readOrderSuppliersForAdvancePurchase: read,
    advancePurchaseSaleSourceKey: row => `${row.session_id}|${row.source_row_no}`,
    salesRefDbErrorMessage: error => error.message,
    document: {getElementById: id => ({get value() {return fields[id] || "";}, set value(value) {fields[id] = value;}})}
  });
  vm.runInContext(section("function salesRefSupplierCodeKey(", "function salesRefGroup("), context);
  return {context, fields};
}

test("filter uses exact order supplier codes and composes with all existing criteria", async () => {
  const rows = [sale("a", 1), sale("b", 2), sale("c", 3, {store_name: "Other", customer_code: "C2"}), sale("old", 4, {work_date: "2025-09-01"}), sale("provisional", 5, {_sales_provisional: true})];
  const {context, fields} = runtime(rows, async () => new Map([["session-a|1", "02"], ["session-a|2", "20"], ["session-a|3", "02"], ["session-a|4", "02"], ["session-a|5", "02"]]));
  await context.salesRefEnsureOrderSuppliers();
  fields["sales-ref-supplier"] = " \uff10\uff12 ";
  assert.deepEqual(Array.from(context.salesRefFilteredRows(), row => row.id), ["a", "c"]);
  fields["sales-ref-customer"] = "C1 Shop";
  fields["sales-ref-product"] = "100 Fish";
  fields["sales-ref-importer"] = "dim";
  assert.deepEqual(Array.from(context.salesRefFilteredRows(), row => row.id), ["a"]);
  fields["sales-ref-search"] = "no-match";
  assert.equal(context.salesRefFilteredRows().length, 0);
  fields["sales-ref-search"] = "";
  fields["sales-ref-status"] = "provisional";
  assert.deepEqual(Array.from(context.salesRefFilteredRows(), row => row.id), ["provisional"]);
  fields["sales-ref-supplier"] = "2";
  assert.equal(context.salesRefFilteredRows().length, 0);
});

test("supplier lookup is lazy, deduplicated during flight and cached until sales reload", async () => {
  let calls = 0, release;
  const {context, fields} = runtime([sale("a", 1)], () => {calls++; return new Promise(resolve => {release = resolve;});});
  await context.refreshSalesRefSupplierFilter();
  assert.equal(calls, 0);
  fields["sales-ref-supplier"] = "02";
  const first = context.refreshSalesRefSupplierFilter(), second = context.refreshSalesRefSupplierFilter();
  assert.equal(calls, 1);
  assert.equal(context.salesRefFilteredRows().length, 0);
  release(new Map([["session-a|1", "02"]]));
  await Promise.all([first, second]);
  await context.refreshSalesRefSupplierFilter();
  assert.equal(calls, 1);
  assert.equal(context.salesRefFilteredRows().length, 1);
  context.salesReferenceRows = [sale("new", 1)];
  assert.equal(context.salesRefSupplierReady(), false);
  const next = context.refreshSalesRefSupplierFilter();
  release(new Map([["session-a|1", "03"]]));
  await next;
  assert.equal(calls, 2);
  assert.equal(context.salesRefFilteredRows().length, 0);
});

test("old lookups cannot overwrite the next sales load", async () => {
  const resolvers = [];
  const oldRows = [sale("old", 1)];
  const {context} = runtime(oldRows, () => new Promise(resolve => resolvers.push(resolve)));
  const oldLoad = context.salesRefEnsureOrderSuppliers();
  const newRows = [sale("new", 1)];
  context.salesReferenceRows = newRows;
  const newLoad = context.salesRefEnsureOrderSuppliers();
  resolvers[1](new Map([["session-a|1", "03"]]));
  await newLoad;
  resolvers[0](new Map([["session-a|1", "02"]]));
  assert.equal(await oldLoad, false);
  assert.equal(newRows[0]._orderSupplierCode, "03");
  assert.equal(oldRows[0]._orderSupplierCode, undefined);
});

test("lookup failure fails closed, remains retryable and clearing restores all rows", async () => {
  let fail = true;
  const {context, fields} = runtime([sale("a", 1)], async () => {if (fail) throw new Error("network"); return new Map([["session-a|1", "02"]]);});
  fields["sales-ref-supplier"] = "02";
  await context.refreshSalesRefSupplierFilter();
  assert.equal(context.salesRefSupplierReady(), false);
  assert.ok(context.salesRefSupplierCache.error.includes("network"));
  assert.equal(context.salesRefFilteredRows().length, 0);
  fields["sales-ref-supplier"] = "";
  assert.equal(context.salesRefFilteredRows().length, 1);
  fields["sales-ref-supplier"] = "02";
  fail = false;
  await context.refreshSalesRefSupplierFilter();
  assert.equal(context.salesRefFilteredRows().length, 1);
});

test("unlinked and historical rows are never guessed from product masters or adjustments", async () => {
  const rows = [sale("a", 1), sale("missing", 2), sale("historical", 1, {source_type: "\u904e\u53bb\u30c7\u30fc\u30bf"}), sale("adjustment", 1, {source_type: "\u8d64\u4f1d"}), sale("manual", null)];
  let requested;
  const {context, fields} = runtime(rows, async subset => {requested = subset; return new Map([["session-a|1", "02"]]);});
  const before = rows.map(row => ({...row}));
  await context.salesRefEnsureOrderSuppliers();
  assert.deepEqual(Array.from(requested, row => row.id), ["a", "missing"]);
  fields["sales-ref-supplier"] = "02";
  assert.deepEqual(Array.from(context.salesRefFilteredRows(), row => row.id), ["a"]);
  rows.forEach((row, index) => {const {_orderSupplierCode, ...unchanged} = row; assert.deepEqual(unchanged, before[index]);});
});

test("supplier details exclude unallocated shipping from both screen and Excel totals", () => {
  const {context, fields} = runtime();
  context.salesRefShippingFeeForRows = () => 900;
  vm.runInContext(section("function salesRefDetailFilterActive(", "function salesRefShippingBreakdownData("), context);
  assert.equal(context.salesRefVisibleShippingFeeForRows([]), 900);
  fields["sales-ref-supplier"] = "02";
  assert.equal(context.salesRefVisibleShippingFeeForRows([]), 0);
  const exportSource = section("function exportSalesReferenceBoardExcel(", "function productGuideDefaultRange(");
  assert.match(exportSource, /const rows=salesRefFilteredRows\(\)/);
  assert.match(exportSource, /const shippingSales=salesRefVisibleShippingFeeForRows\(rows\)/);
  assert.match(exportSource, /!salesRefSupplierReady\(\)/);
});

test("supplier input is cleared with detail filters and never leaks into gross profit", () => {
  const {context, fields} = runtime();
  vm.runInContext(section("function clearSalesReferenceDetailFilters(", "function clearProfitReferenceFilters("), context);
  fields["sales-ref-supplier"] = "02";
  context.clearSalesReferenceDetailFilters();
  assert.equal(fields["sales-ref-supplier"], "");
  assert.match(section("function syncProfitReferenceFiltersToSales(", "function syncSalesReferenceFiltersToProfit("), /if\(supplier\)supplier\.value=""/);
  assert.match(html, /id="sales-ref-supplier" list="supplier-code-list"/);
  assert.match(section("async function loadSalesReferenceBoard(", "function renderProfitReferenceBoard("), /if\(val\("sales-ref-supplier"\)\.trim\(\)\)\{[\s\S]*?await salesRefEnsureOrderSuppliers\(\)/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
});
