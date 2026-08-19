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
  "findMasterProduct",
  "productMatchInfo",
  "normalizeMasterSearchText",
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
  () => ({ importers: [{ code: "02", name: "BKK", aliases: [] }] }),
  (code, name) => {
    const products = [
      { code: "101", name: "真鯛", aliases: ["鯛"] },
      { code: "202", name: "マグロ", aliases: [] },
      { code: "404", name: "畜養マグロ 腹上", aliases: [] },
      { code: "405", name: "畜養マグロ 腹中", aliases: [] }
    ];
    const codeKey = String(code || "").normalize("NFKC").trim().toLowerCase();
    const nameKey = String(name || "").replace(/[\s　]+/g, "").toLowerCase();
    return products.find(product => codeKey && String(product.code).toLowerCase() === codeKey)
      || products.find(product => nameKey && String(product.name).replace(/[\s　]+/g, "").toLowerCase() === nameKey)
      || null;
  },
  (product, query) => {
    const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
    const normalizedQuery = normalize(query);
    let best = { score: 99, length: 0 };
    [product.code, product.name, ...(product.aliases || [])].forEach(value => {
      const normalizedValue = normalize(value);
      if (!normalizedValue || !normalizedQuery) return;
      const score = normalizedValue === normalizedQuery ? 0
        : normalizedValue.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedValue) ? 1
        : normalizedValue.includes(normalizedQuery) || normalizedQuery.includes(normalizedValue) ? 2
        : 99;
      const length = Math.min(normalizedValue.length, normalizedQuery.length);
      if (score < best.score || (score === best.score && length > best.length)) best = { score, length };
    });
    return best;
  },
  value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "")
);

assert.equal(reconciliation.productMatch(
  { productCode: "101", productName: "真鯛" },
  { productCode: "101", productName: "真鯛" }
), "code");
assert.equal(reconciliation.productMatch(
  { productCode: "", productName: "真鯛" },
  { productCode: "101", productName: "真鯛" }
), "name");
assert.equal(reconciliation.productMatch(
  { productCode: "", productName: "マグロ", sourceExpression: "マグロ" },
  { productCode: "404", productName: "畜養マグロ 腹上" }
), "text");
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

const fuzzyBatch = [{
  importer,
  customer,
  rows: [{ productCode: "404", productName: "畜養マグロ 腹上", qty: "3", unit: "Kg", memo: "" }]
}];
const fuzzyItems = [{
  importer,
  customer,
  row: { productCode: "", productName: "マグロ", qty: "3", unit: "Kg", memo: "", sourceExpression: "マグロ" }
}];
reconciliation.setState(fuzzyBatch, fuzzyItems, [0]);
const fuzzyRows = reconciliation.rebuild();
assert.equal(fuzzyRows[0].status, "mismatch");
assert.match(fuzzyRows[0].reasons.join(" "), /候補一致/);
assert.equal(fuzzyItems[0]._dictionarySelected, false);

const ambiguousBatch = [{
  importer,
  customer,
  rows: [
    { productCode: "404", productName: "畜養マグロ 腹上", qty: "3", unit: "Kg", memo: "" },
    { productCode: "405", productName: "畜養マグロ 腹中", qty: "3", unit: "Kg", memo: "" }
  ]
}];
reconciliation.setState(ambiguousBatch, fuzzyItems, [0]);
const ambiguousRows = reconciliation.rebuild();
assert.equal(ambiguousRows[0].status, "unresolved");
assert.equal(ambiguousRows.filter(row => row.status === "entered-only").length, 2);

console.log("LINE reconciliation tests passed");
