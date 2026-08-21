const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "accounts-payable-closing-migration.sql"), "utf8");
const groupSql = fs.readFileSync(path.join(root, "accounts-payable-group-closing-migration.sql"), "utf8");

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
scripts.forEach((script, index) => new vm.Script(script, { filename: `order-entry-inline-${index}.js` }));

assert.match(html, /<summary>買掛締め<\/summary>/);
assert.match(html, /id="ap-closing-month"/);
assert.match(html, /id="ap-closing-day"/);
assert.match(html, /id="ap-closing-supplier"/);
assert.match(html, /id="ap-closing-group-list"/);
assert.match(html, /onclick="closeSelectedAccountsPayablePeriods\(\)"/);
assert.match(html, /function apClosingSnapshot\(supplierCode,range\)/);
assert.match(html, /function apReadSupplierProfiles\(\)/);
assert.match(html, /from\("accounts_payable_supplier_profiles"\)[\s\S]*?\.order\("supplier_code",\{ascending:true\}\)/);
assert.doesNotMatch(html, /arReadAll\("accounts_payable_supplier_profiles","supplier_code"\)/);
assert.match(html, /const openingBalance=arRound\(beforeCharges-beforePayments\)/);
assert.match(html, /function apClosingGroupCalculations\(\)/);
assert.match(html, /apClosingDay\(profile\)===context\.closingDay/);
assert.match(html, /function toggleAllPayableClosingSuppliers\(checked\)/);
assert.match(html, /rpc\("close_accounts_payable_group",\{p_items:items\}\)/);
assert.match(html, /全社成功または全社失敗/);
assert.match(html, /保存件数が一致しません/);
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

assert.match(groupSql, /create or replace function public\.close_accounts_payable_group\(/);
assert.match(groupSql, /jsonb_typeof\(p_items\) <> 'array'/);
assert.match(groupSql, /item_count > 200/);
assert.match(groupSql, /from public\.close_accounts_payable_period\(/);
assert.match(groupSql, /return next closing_row/);
assert.match(groupSql, /grant execute on function public\.close_accounts_payable_group\(jsonb\)/);

console.log("Accounts payable closing tests passed");
