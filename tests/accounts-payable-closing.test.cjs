const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "accounts-payable-closing-migration.sql"), "utf8");

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
scripts.forEach((script, index) => new vm.Script(script, { filename: `order-entry-inline-${index}.js` }));

assert.match(html, /<summary>買掛締め<\/summary>/);
assert.match(html, /id="ap-closing-month"/);
assert.match(html, /id="ap-closing-supplier"/);
assert.match(html, /onclick="closeAccountsPayablePeriod\(\)"/);
assert.match(html, /function apClosingSnapshot\(supplierCode,range\)/);
assert.match(html, /const openingBalance=arRound\(beforeCharges-beforePayments\)/);
assert.match(html, /function renderPayableClosingHistory\(\)/);
assert.match(html, /function reopenAccountsPayablePeriod\(closingId\)/);
assert.match(html, /if\(apClosingIsActive\(payment\?\.closing_id\)\)/);

assert.match(sql, /create table if not exists public\.accounts_payable_closings/);
assert.match(sql, /add column if not exists closing_id uuid/);
assert.match(sql, /create or replace function public\.protect_closed_payable\(\)/);
assert.match(sql, /create or replace function public\.protect_closed_payable_payment\(\)/);
assert.match(sql, /trg_business_audit[\s\S]*?log_business_audit_event/);
assert.match(sql, /daterange\(c\.period_from, c\.period_to, '\[\]'\)/);
assert.match(sql, /create or replace function public\.close_accounts_payable_period\(/);
assert.match(sql, /and invoice_date <= p_period_to/);
assert.match(sql, /and payment\.payment_date <= p_period_to/);
assert.match(sql, /create or replace function public\.reopen_accounts_payable_period\(/);
assert.match(sql, /if not public\.is_master_admin\(\)/);
assert.match(sql, /notify pgrst, 'reload schema'/);

console.log("Accounts payable closing tests passed");
