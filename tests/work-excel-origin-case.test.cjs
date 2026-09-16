const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return app.slice(from, to);
}
function runtime() {
  const context = vm.createContext({
    importerCode: value => value,
    importerCodeFromRow: row => row.importer_id,
    countryCode: value => value,
    XLSX: {utils: {sheet_to_json: sheet => sheet}},
    currentSessionId: "test-session",
    currentUser: {id: "test-user"},
    sitePartnerSchemaReady: false,
    numberOrNull: value => value === "" || value == null ? null : Number(value)
  });
  vm.runInContext(
    section("const WORK_ORIGIN_ROMAJI_PARTS=", "function workPriceValuePresent(") +
    section("function applyWorkPriceOriginToRows(", "function workMasterPriceSummaryText(") +
    section("function rowToOrderLinePayload(", "function syncOrderRowsFromRows("), context);
  return context;
}
function sheetRow(name, origin, overrides = {}) {
  const cells = Array(44).fill("");
  cells[1] = name;
  cells[2] = origin;
  cells[4] = 1200;
  cells[5] = 1500;
  cells[6] = 1;
  cells[7] = "pkt";
  cells[36] = 2000;
  cells[42] = 2500;
  cells[37] = 3000;
  cells[43] = 3500;
  return Object.assign(cells, overrides);
}
function loadExcel(context, fish, vegetables = []) {
  context.workbook = {
    SheetNames: ["Master Special", "Master Special \u91ce\u83dc"],
    Sheets: {
      "Master Special": [[], [], ...fish],
      "Master Special \u91ce\u83dc": [[], [], ...vegetables]
    }
  };
  vm.runInContext("workPriceOriginEntries=parseWorkPriceOriginWorkbook(workbook); workPriceOriginFilename='test.xlsx';", context);
}
function workRow(name, overrides = {}) {
  return {_idx: 0, product_name: name, origin: "", _unit: "Kg", _memo: "", importer_id: "DIM", unit_price: 999, _priceSource: "", ...overrides};
}

test("Excel origin capitalizes only the first character after romanization", () => {
  const context = runtime();
  const cases = [
    ["\u5927\u962a", "Osaka"],
    ["\u5927\u962a\u5e9c\u7523", "Osaka"],
    ["OSAKA", "Osaka"], ["osaka", "Osaka"], ["oSaKa", "Osaka"],
    [" \uff2f\uff33\uff21\uff2b\uff21 ", "Osaka"],
    ["\u5317\u6d77\u9053", "Hokkaido"],
    ["\u30cb\u30e5\u30fc\u30b8\u30fc\u30e9\u30f3\u30c9", "New zealand"],
    ["\u5175\u5eab\u770c\u6de1\u8def\u5cf6", "Hyogo / awaji island"],
    ["\u5927\u962a\u30fb\u5175\u5eab", "Osaka / hyogo"],
    ["\u672a\u767b\u9332\u7523\u5730", "\u672a\u767b\u9332\u7523\u5730"],
    ["", ""], [null, ""]
  ];
  for (const [input, expected] of cases) {
    assert.equal(context.workPriceOriginFormatOrigin(input), expected);
    assert.equal(context.workPriceOriginFormatOrigin(expected), expected);
  }
  assert.equal(context.workOriginRomanize("\u5927\u962a"), "OSAKA");
});

test("fish and vegetable Excel imports retain prices, units, memos and DB origin case", () => {
  const context = runtime();
  loadExcel(context, [sheetRow("Fish", "\u5927\u962a", {6: 2})], [sheetRow("Vegetable", "HOKKAIDO")]);
  const rows = [workRow("Fish"), workRow("Fish", {importer_id: "FBI"}), workRow("Vegetable", {importer_id: "FBI"})];
  const summary = context.applyWorkPriceOriginToRows(rows);
  assert.equal(summary.origin, 3);
  assert.deepEqual(rows.map(row => row.origin), ["Osaka", "Osaka", "Hokkaido"]);
  assert.deepEqual(rows.map(row => row.unit_price), [1200, 2000, 3000]);
  assert.deepEqual(rows.map(row => row._unit), ["PC", "PC", "pkt"]);
  assert.ok(rows[0]._memo.includes("1,200 / 1,500"));
  assert.ok(rows[2]._memo.includes("3,000 / 3,500"));
  assert.ok(rows.every(row => row._priceOriginSource.startsWith("test.xlsx / ")));
  const payload = context.rowToOrderLinePayload(rows[0]);
  assert.equal(payload.origin, "Osaka");
  assert.equal(context.orderLineToLocalRow(payload).origin, "Osaka");
});

test("existing origins, order prices and master fallbacks are not reformatted or overwritten", () => {
  const context = runtime();
  loadExcel(context, [sheetRow("Fish", "\u5927\u962a")]);
  const rows = [workRow("Fish", {origin: "TOKYO", unit_price: 88, _priceSource: "\u53d7\u6ce8\u4fa1\u683c"}), workRow("Missing", {_masterOrigin: "CHIBA"})];
  const summary = context.applyWorkPriceOriginToRows(rows);
  context.applyWorkMasterOriginFallbacks(rows);
  assert.equal(summary.origin, 0);
  assert.equal(rows[0].origin, "TOKYO");
  assert.equal(rows[0].unit_price, 88);
  assert.equal(rows[1].origin, "CHIBA");
});

test("ambiguous matches and missing Excel never invent an origin", () => {
  const context = runtime();
  const blank = workRow("Fish");
  assert.equal(context.applyWorkPriceOriginToRows([blank]), null);
  loadExcel(context, [sheetRow("Fish", "OSAKA"), sheetRow("Fish", "TOKYO")]);
  const summary = context.applyWorkPriceOriginToRows([blank]);
  assert.equal(summary.ambiguous, 1);
  assert.equal(blank.origin, "");
  assert.equal(blank.unit_price, 999);
});

test("work app inline scripts remain syntactically valid", () => {
  for (const match of app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
});
