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
assert.match(html, /apPayableClosingDays\(profile\)\.includes\(context\.closingDay\)/);
assert.match(html, /function apIsSemiMonthlyProfile\(profile\)/);
assert.match(html, /function apClosingDateMatchesDay\(dateValue,closingDay\)/);
assert.match(html, /function apEffectivePayableSupplierProfiles\(profiles=payableSupplierProfiles,rows=payableRows\)/);
assert.match(html, /_default_profile:true/);
assert.match(html, /支払条件未登録.*末締め初期値/);
assert.match(html, /条件未登録・初期値適用/);
assert.match(html, /現在の表示は未保存の初期値/);
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

const effectiveProfileSource = html.slice(
  html.indexOf("function apEffectivePayableSupplierProfiles"),
  html.indexOf("function apSupplierMapForClosing")
);
const effectiveProfiles = new Function(`${effectiveProfileSource}; return apEffectivePayableSupplierProfiles;`)();
const profiles = effectiveProfiles(
  [{ supplier_code: "02", payment_mode: "credit", closing_day: 15 }],
  [{ supplier_code: "02" }, { supplier_code: "16" }]
);
assert.equal(profiles.length, 2);
assert.equal(profiles.find((profile) => profile.supplier_code === "02").closing_day, 15);
assert.deepEqual(profiles.find((profile) => profile.supplier_code === "16"), {
  supplier_code: "16",
  payment_mode: "credit",
  closing_day: 31,
  payment_month_offset: 1,
  payment_day: 31,
  _default_profile: true
});

const closingCalculationSource = html.slice(
  html.indexOf("function apClosingDay"),
  html.indexOf("function apClosingGroupContext")
);
const closingContext = {
  payableSupplierProfiles: [],
  payableRows: [],
  payableClosings: [],
  payablesLoaded: false,
  arNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  },
  arMonthDay(month, day, monthOffset = 0) {
    const match = String(month || "").match(/^(\d{4})-(\d{2})$/);
    if (!match) return "";
    const first = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + monthOffset, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const targetDay = Math.min(Math.max(1, Number(day) || 31), lastDay);
    return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
  },
  arShiftDate(date, days) {
    const target = new Date(`${date}T00:00:00Z`);
    target.setUTCDate(target.getUTCDate() + days);
    return target.toISOString().slice(0, 10);
  },
  apSameSupplier(left, right) {
    return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
  },
  apClosingSnapshot() {
    return null;
  }
};
vm.runInNewContext(closingCalculationSource, closingContext);
const semiMonthlyProfile = {
  supplier_code: "02",
  payment_mode: "credit",
  closing_day: 15,
  payment_month_offset: 1,
  payment_day: 15
};
assert.deepEqual(Array.from(closingContext.apPayableClosingDays(semiMonthlyProfile)), [15, 31]);
const firstHalf = closingContext.apClosingCalculationFor({ code: "02", name: "仕入先" }, "2026-08", semiMonthlyProfile, 15);
assert.equal(firstHalf.range.from, "2026-08-01");
assert.equal(firstHalf.range.to, "2026-08-15");
assert.equal(firstHalf.dueDate, "2026-08-31");
const secondHalf = closingContext.apClosingCalculationFor({ code: "02", name: "仕入先" }, "2026-08", semiMonthlyProfile, 31);
assert.equal(secondHalf.range.from, "2026-08-16");
assert.equal(secondHalf.range.to, "2026-08-31");
assert.equal(secondHalf.dueDate, "2026-09-15");
assert.equal(closingContext.apClosingDateMatchesDay("2026-08-15", 15), true);
assert.equal(closingContext.apClosingDateMatchesDay("2026-08-31", 31), true);
closingContext.payablesLoaded = true;
closingContext.apClosingSnapshot = (_supplierCode, range) => ({
  range,
  charges: range.to.endsWith("-15") ? [{ id: "purchase-1" }] : [{ id: "purchase-2" }],
  payments: [],
  openingBalance: 0,
  purchaseAmount: 100,
  paymentAmount: 0,
  closingBalance: 100
});
const blockedSecondHalf = closingContext.apClosingCalculationFor({ code: "02", name: "仕入先" }, "2026-08", semiMonthlyProfile, 31);
assert.equal(blockedSecondHalf.error, "先に同月15日締めを完了してください。");
closingContext.payableClosings.push({ supplier_code: "02", status: "closed", period_from: "2026-08-01", period_to: "2026-08-15" });
const enabledSecondHalf = closingContext.apClosingCalculationFor({ code: "02", name: "仕入先" }, "2026-08", semiMonthlyProfile, 31);
assert.equal(enabledSecondHalf.error, "");
assert.equal(enabledSecondHalf.range.from, "2026-08-16");

console.log("Accounts payable closing tests passed");
