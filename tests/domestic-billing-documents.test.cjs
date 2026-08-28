const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "domestic-sales.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "domestic-billing-closing-migration.sql"), "utf8");

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
scripts.forEach((script, index) => new vm.Script(script, { filename: `domestic-inline-${index}.js` }));

assert.match(html, /onclick="printDomesticDeliveryNote\('\$\{row\.id\}'\)">納品書/);
assert.match(html, /id="close-billing-button"/);
assert.match(html, /締め確定・請求書/);
assert.match(html, /function printDomesticInvoice\(/);
assert.match(html, /function renderDomesticClosingHistory\(/);
assert.match(html, /月2回締め（15日・末日）/);
assert.match(html, /domesticMonthDay\(month,days\[cycleIndex\+1\]\)/);

assert.match(sql, /create table if not exists public\.domestic_billing_closings/);
assert.match(sql, /create or replace function public\.close_domestic_billing_period/);
assert.match(sql, /create or replace function public\.reopen_domestic_billing_period/);
assert.match(sql, /extract\(day from p_sale_date\)::integer <= 15/);
assert.match(sql, /return \(sale_month \+ interval '1 month'\)::date \+ 14/);
assert.match(sql, /extract\(day from p_sale_date\)::integer <= 10/);
assert.match(sql, /daterange\(closing\.period_from,closing\.period_to,'\[\]'\)/);
assert.match(sql, /Domestic 15-day first-cycle due date check failed/);

console.log("Domestic billing and document tests passed");
