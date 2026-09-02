const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const management = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const domestic = fs.readFileSync(path.join(root, "domestic-sales.html"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing marker: ${startMarker}`);
  assert.ok(end > start, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

test("売上・粗利・仕入・買掛・国内売上の期間ボタンを同じ構成にする", () => {
  for (const scope of ["sales", "profit", "purchase", "payable"]) {
    for (const period of ["recent", "today", "week", "month", "previous-month", "year", "all"]) {
      assert.match(management, new RegExp(`data-${scope}-period="${period}"`));
    }
  }
  for (const period of ["recent", "today", "week", "month", "previous-month", "year", "all"]) {
    assert.match(domestic, new RegExp(`data-domestic-sales-period="${period}"`));
  }
  assert.ok((management.match(/>先月<\/button>/g) || []).length >= 4);
  assert.match(domestic, />先月<\/button>/);
});

test("共通期間計算は月跨ぎと先月を正しく扱う", () => {
  const source = sourceBetween(management, "function salesRefCompactDate", "function syncSalesReferencePeriodButtons");
  const periodValue = new Function(`${source}; return salesRefPeriodValue;`)();
  const current = "2026-09-02";
  assert.equal(periodValue("recent", current), "20260803-20260902");
  assert.equal(periodValue("today", current), "20260902");
  assert.equal(periodValue("week", current), "20260831-20260902");
  assert.equal(periodValue("month", current), "202609");
  assert.equal(periodValue("previous-month", current), "202608");
  assert.equal(periodValue("year", current), "2026");
  assert.equal(periodValue("all", current), "");
});

test("全期間ボタンは売上の当月初期値へ戻されない", () => {
  const databaseRange = sourceBetween(management, "function salesRefDatabaseRange", "async function salesRefReadPaged");
  assert.match(databaseRange, /dataset\.periodAll==="true"/);
  assert.match(databaseRange, /ranges:\[\{from:"",to:""\}\],label:"全期間"/);
  assert.match(domestic, /if\(from\)query=query\.gte\("sale_date",from\)/);
  assert.match(domestic, /if\(to\)query=query\.lte\("sale_date",to\)/);
});
