const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "order-entry-beta.html"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0, `Missing marker: ${startMarker}`);
  assert.ok(end > start, `Missing marker: ${endMarker}`);
  return html.slice(start, end);
}

const parserSource = sourceBetween(
  "function normalizeLineInputText",
  "function productLookupMatches"
);
const parser = new Function(`${parserSource}; return { parseLineOrderPart, stripLineListMarker };`)();

assert.deepEqual(parser.parseLineOrderPart("・冷凍 のどぐろ フィレ 10パック"), {
  productText: "冷凍 のどぐろ フィレ",
  qty: "10",
  unit: "pkt",
  memo: ""
});
assert.deepEqual(parser.parseLineOrderPart("養殖ヒラメ 1枚 (鱗取って内臓抜き)"), {
  productText: "養殖ヒラメ",
  qty: "1",
  unit: "PC",
  memo: "鱗取って内臓抜き"
});

const reconciliationSource = sourceBetween(
  "function reconciliationCode",
  "function renderLineReconciliation"
);
const reconciliation = new Function(
  "resolveImporter",
  "normalizeLineUnit",
  "lookupLineDictionary",
  "lineDictionaryCustomerKey",
  "lineDictionaryImporterCode",
  "normalizeLineExpression",
  "getMasters",
  `${reconciliationSource}
   let confirmedBatches = [];
   let lineReconciliationContext = { targetBatchIndexes: [] };
   let lineReconciliationItems = [];
   let lineReconciliationRows = [];
   function renderLineReconciliation() {}
   return {
     setState(batches, items, indexes) {
       confirmedBatches = batches;
       lineReconciliationItems = items;
       lineReconciliationContext = { targetBatchIndexes: indexes };
       lineReconciliationRows = [];
     },
     rebuild() { rebuildLineReconciliation(); return lineReconciliationRows; },
     productMatch: reconciliationProductMatchKind,
     importerMatches: reconciliationImporterMatches,
     quantityMatches: reconciliationQuantityMatches,
     memoMatches: reconciliationMemoMatches
   };`
)(
  value => value || {},
  unit => {
    const normalized = String(unit || "").toLowerCase();
    if (normalized === "kg") return "Kg";
    if (["pc", "本", "個", "枚", "尾"].includes(normalized)) return "PC";
    if (["pkt", "p", "パック"].includes(normalized)) return "pkt";
    return unit || "";
  },
  () => null,
  value => [value?.code || "", value?.name || ""].join("|"),
  value => String(value || "").toUpperCase(),
  value => String(value || "").trim().toLowerCase(),
  () => ({ importers: [{ code: "02", name: "BKK", aliases: [] }] })
);

assert.equal(reconciliation.productMatch(
  { productCode: "101", productName: "真鯛" },
  { productCode: "101", productName: "真鯛" }
), "code");
assert.equal(reconciliation.productMatch(
  { productCode: "", productName: "真鯛" },
  { productCode: "101", productName: "真鯛" }
), "name");
assert.equal(reconciliation.importerMatches({ code: "02", name: "" }, { code: "BKK", name: "" }), true);
assert.equal(reconciliation.quantityMatches("2", "2.0"), true);
assert.equal(reconciliation.quantityMatches("2", "3"), false);
assert.equal(reconciliation.memoMatches("内臓抜き", "鱗取って内臓抜き"), true);

const importer = { code: "DIM", name: "DIM" };
const customer = { code: "C001", name: "TEST SHOP" };
const batches = [{
  importer,
  customer,
  rows: [
    { productCode: "101", productName: "真鯛", qty: "2", unit: "PC", memo: "" },
    { productCode: "101", productName: "真鯛", qty: "1", unit: "PC", memo: "" },
    { productCode: "202", productName: "マグロ", qty: "3", unit: "Kg", memo: "" }
  ]
}];
const items = [
  { importer, customer, row: { productCode: "101", productName: "真鯛", qty: "2", unit: "PC", memo: "", sourceExpression: "鯛" } },
  { importer, customer, row: { productCode: "101", productName: "真鯛", qty: "9", unit: "PC", memo: "", sourceExpression: "真鯛" } },
  { importer, customer, row: { productCode: "303", productName: "のどぐろ", qty: "1", unit: "PC", memo: "", sourceExpression: "のどぐろ" } },
  { importer, customer, row: { productCode: "", productName: "未知商品", qty: "1", unit: "PC", memo: "", sourceExpression: "未知商品" } }
];

reconciliation.setState(batches, items, [0]);
const statuses = reconciliation.rebuild().map(row => row.status);
assert.deepEqual(statuses, ["match", "mismatch", "line-only", "unresolved", "entered-only"]);

console.log("LINE reconciliation tests passed");
