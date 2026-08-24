const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "order-entry-beta.html"), "utf8");

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${start} がありません`);
  assert.notEqual(to, -1, `${end} がありません`);
  return html.slice(from, to);
}

assert.match(html, /data-sales-period="today"[\s\S]*?>今日</);
assert.match(html, /data-sales-period="week"[\s\S]*?>今週</);
assert.match(html, /data-sales-period="month"[\s\S]*?>今月</);
assert.match(html, /id="sales-ref-status" type="hidden" value="confirmed"/);
assert.match(html, /data-sales-status="provisional"[\s\S]*?>速報のみ</);

const provisionalRead = sourceBetween("async function salesRefReadProvisionalRows", "async function loadSalesReferenceBoard");
assert.match(provisionalRead, /!\(session\.locked\|\|session\.status==="closed"\)/);
assert.match(provisionalRead, /session\.status!=="archived"/);
assert.match(provisionalRead, /const importerIndex=salesReferenceImporterIndex\|\|salesRefBuildImporterIndex\(\)/);
assert.match(provisionalRead, /from\("order_lines"\)/);
assert.match(provisionalRead, /from\("boxes"\)/);
assert.match(provisionalRead, /qty\*price:null/);
assert.match(provisionalRead, /source_type:"未確定速報"/);
assert.doesNotMatch(provisionalRead, /salesRefNormalizeRowImporter\([\s\S]*?,salesReferenceImporterIndex\)/);

const load = sourceBetween("async function loadSalesReferenceBoard", "function salesRefResetPage");
assert.match(load, /provisionalTask/);
assert.match(load, /\.\.\.provisionalRows/);
assert.match(load, /未確定速報 \$\{provisionalRows\.length\}件/);

const filters = sourceBetween("function salesRefFilteredRows", "function salesRefGroup");
assert.match(filters, /status==="confirmed"&&salesRefIsProvisional\(row\)/);
assert.match(filters, /status==="provisional"&&!salesRefIsProvisional\(row\)/);
assert.match(html, /id="sales-ref-forecast-cards"/);
assert.match(html, /\["着地見込",salesRefMoney\(confirmed\.totalSales\+provisional\.totalSales\)/);

console.log("Sales provisional forecast tests passed");
