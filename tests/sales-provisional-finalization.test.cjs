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
function fixture(extra = {}) {
  const context = vm.createContext({
    getMasters: () => ({importers: [
      {code: "01", name: "DIM", aliases: []},
      {code: "03", name: "FBI", aliases: []},
      {code: "07", name: "JKT", aliases: []},
      {code: "FBI FZ", name: "FBI FZ", aliases: []}
    ]}),
    salesReferenceImporterIndex: null,
    ...extra
  });
  vm.runInContext(section("function normalizeImporterCode(", "function parseContractPrices("), context);
  vm.runInContext(section("function salesRefText(", "function salesRefAppliedPendingDate("), context);
  vm.runInContext(section("function salesRefUnfinalizedRows(", "async function loadSalesReferenceBoard("), context);
  context.salesReferenceImporterIndex = context.salesRefBuildImporterIndex();
  return context;
}
const line = (id, importer, session = "osaka") => ({id, session_id: session, importer_code: importer});
const ids = rows => Array.from(rows, row => row.id);

test("partial finalization excludes numeric codes and names, but not open importers or FZ variants", () => {
  const c = fixture();
  const rows = [line("dim", "DIM"), line("dim-code", "01"), line("fbi", "FBI"), line("jkt", "07"), line("frozen", "FBI FZ")];
  const before = JSON.stringify(rows);
  const result = c.salesRefUnfinalizedRows(rows, [{id: "osaka", finalized_importer_codes: ["01", "03"]}]);
  assert.deepEqual(ids(result), ["jkt", "frozen"]);
  assert.equal(JSON.stringify(rows), before);
});

test("matching stays within the exact work session, including the same importer at another site or date", () => {
  const c = fixture();
  const rows = [line("osaka", "DIM"), line("tokyo", "DIM", "tokyo"), line("tomorrow", "01", "tomorrow")];
  assert.deepEqual(ids(c.salesRefUnfinalizedRows(rows, [{id: "osaka", finalized_importer_codes: ["01"]}])), ["tokyo", "tomorrow"]);
});

test("confirmed sales suppress legacy or concurrently finalized forecasts without a session flag", () => {
  const c = fixture();
  const rows = [line("fbi", "03"), line("jkt", "07"), line("tokyo", "FBI", "tokyo")];
  const confirmed = [line("sale", "FBI")];
  assert.deepEqual(ids(c.salesRefUnfinalizedRows(rows, [{id: "osaka"}], confirmed)), ["jkt", "tokyo"]);
  assert.deepEqual(confirmed, [line("sale", "FBI")]);
});

test("reopened importers reappear only after both confirmation flags and confirmed rows are cleared", () => {
  const c = fixture();
  const rows = [line("dim", "01")];
  assert.equal(c.salesRefUnfinalizedRows(rows, [{id: "osaka", finalized_importer_codes: []}], [line("sale", "DIM")]).length, 0);
  assert.deepEqual(ids(c.salesRefUnfinalizedRows(rows, [{id: "osaka", finalized_importer_codes: []}], [])), ["dim"]);
});

test("legacy importer_id and unknown codes work without guessing from prefixes or missing values", () => {
  const c = fixture();
  const rows = [
    {...line("legacy", ""), importer_id: "FBI"},
    line("custom", " CUSTOM-9 "), line("other", "CUSTOM-90"), line("empty", "")
  ];
  assert.deepEqual(ids(c.salesRefUnfinalizedRows(rows, [{id: "osaka", finalized_importer_codes: ["03", "CUSTOM9"]}])), ["other", "empty"]);
});

function readerFixture(sessions, lines, boxes = []) {
  const reads = [];
  const client = {from(table) {
    const query = {
      select() {return this;}, in(field, values) {this.sessionIds = values; return this;}, order() {return this;},
      async range() {
        reads.push({table, ids: this.sessionIds});
        return {data: (table === "order_lines" ? lines : boxes).filter(row => this.sessionIds.includes(row.session_id))};
      }
    };
    return query;
  }};
  const c = fixture({
    salesRefReadChunks: async (values, size, read) => (await read(values)),
    salesRefReadPaged: async build => (await build(false).range()).data,
    salesRefJpyAmount: value => Math.round(value),
    salesRefSessionWorkDate: session => session.work_date || "2026-10-29"
  });
  return {c, reads, run: () => c.salesRefReadProvisionalRows(client, sessions)};
}

test("the provisional reader excludes full locks, closed, archived and importer-scoped finalization", async () => {
  const sessions = [
    {id: "osaka", locked: false, status: "active", finalized_importer_codes: ["01"]},
    {id: "locked", locked: true}, {id: "closed", status: "closed"}, {id: "archived", status: "archived"}
  ];
  const f = readerFixture(sessions, [line("dim", "DIM"), {...line("open", "07"), input_qty: 2, unit_price: 100}, line("locked", "01", "locked")]);
  const result = await f.run();
  assert.deepEqual(ids(result), ["open"]);
  assert.equal(result[0].amount, 200);
  assert.equal(result[0]._sales_provisional, true);
  assert.equal(result[0].gross_weight, null);
  assert.deepEqual(Array.from(f.reads[0].ids), ["osaka"]);
});

test("open importer calculations preserve stockouts, missing amounts and importer-specific box weights", async () => {
  const f = readerFixture([{id: "osaka", status: "active", finalized_importer_codes: ["01"]}], [
    {...line("open", "03"), box_no: "1", input_qty: 1.5, unit_price: 101},
    {...line("stockout", "03"), is_stockout: true, input_qty: 2, unit_price: 101},
    {...line("missing", "03"), input_qty: null, unit_price: 101}
  ], [
    {session_id: "osaka", importer_code: "DIM", box_no: "1", gross_weight: 9},
    {session_id: "osaka", importer_code: "FBI", box_no: "1", gross_weight: 3}
  ]);
  const rows = await f.run();
  assert.equal(rows[0].amount, 152);
  assert.equal(rows[0].gross_weight, 3);
  assert.equal(rows[1].amount, null);
  assert.equal(rows[2].amount, null);
});

test("fully finalized importer sets produce no provisional rows even when the work session remains active", async () => {
  const f = readerFixture([{id: "osaka", locked: false, status: "active", finalized_importer_codes: ["01", "03"]}], [line("dim", "DIM"), line("fbi", "FBI")]);
  assert.equal((await f.run()).length, 0);
});

test("sales reload reconciles parallel results before totals, site lookup, tables and Excel share the rows", async () => {
  const sessions = [{id: "osaka", locked: false, status: "active", finalized_importer_codes: []}];
  const confirmed = [{...line("sale", "03"), amount: 200, work_date: "2026-10-29"}];
  const provisional = [{...line("duplicate", "FBI"), _sales_provisional: true}, {...line("open", "07"), _sales_provisional: true}];
  let located, message = "";
  const c = fixture({
    salesReferenceLoadSequence: 0, salesReferenceRows: [], salesReferenceSessions: [], profitReferenceReady: false,
    document: {querySelector: () => null, getElementById: () => ({get textContent() {return message;}, set textContent(value) {message = value;}})},
    initSupabase: () => ({}), ensureCurrentUser: async () => ({id: "user"}),
    salesRefDatabaseRange: () => ({ranges: [], label: "test"}),
    salesRefReadSessions: async () => sessions, salesRefReadCurrentRows: async () => confirmed,
    salesRefReadHistoricalRows: async () => [], salesRefReadAppliedPendingRows: async () => [],
    salesRefDateOnly: value => value || "", salesRefSessionWorkDate: () => "2026-10-29",
    salesRefJpyAmount: Math.round, salesRefRowDate: row => row.work_date || "",
    salesRefRebuildSessionIndexes() {}, salesRefRenderFilterOptions() {}, salesRefResetPage() {},
    renderSalesReferenceBoard() {}, val: () => "",
    ReferenceSites: {sessions: async (client, rows) => {located = rows; return rows;}}
  });
  c.salesRefReadProvisionalRows = async () => provisional;
  vm.runInContext(section("async function loadSalesReferenceBoard(", "function renderProfitReferenceBoard("), c);
  assert.equal(await c.loadSalesReferenceBoard(), true);
  assert.deepEqual(ids(located), ["sale", "open"]);
  assert.deepEqual(ids(c.salesReferenceRows).sort(), ["open", "sale"]);
  assert.ok(message.includes("1\u4ef6 / \u672a\u78ba\u5b9a\u901f\u5831 1\u4ef6"));
});

test("session reads include importer finalization state and all inline scripts remain syntactically valid", () => {
  assert.match(section("async function salesRefReadSessions(", "async function salesRefReadDomesticRows("), /finalized_importer_codes/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
});
