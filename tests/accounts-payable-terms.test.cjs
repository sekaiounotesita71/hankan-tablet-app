const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname,"..");
const html = fs.readFileSync(path.join(root,"order-entry-beta.html"),"utf8");
const sql = fs.readFileSync(path.join(root,"accounts-payable-terms-migration.sql"),"utf8");

assert.match(html,/id="ap-profile-payment-mode"/);
assert.match(html,/value="cash_on_entry">都度現金払い/);
assert.match(html,/value="closing15-next15">15日締め・翌月15日払い/);
assert.match(html,/function applyPayableTermPreset\(preset\)/);
assert.match(html,/payment_mode:paymentMode/);
assert.match(html,/profile\.payment_mode!=="cash_on_entry"/);

const dueDateStart = html.indexOf("function apDueDate(");
const dueDateEnd = html.indexOf("async function loadPayableSupplierProfile",dueDateStart);
assert.ok(dueDateStart >= 0 && dueDateEnd > dueDateStart);
const dueDateContext = {
  arNumber(value){
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
};
vm.runInNewContext(html.slice(dueDateStart,dueDateEnd),dueDateContext);
assert.equal(dueDateContext.apDueDate("2026-08-15",1,15,15),"2026-09-15");
assert.equal(dueDateContext.apDueDate("2026-08-16",1,15,15),"2026-10-15");
assert.equal(dueDateContext.apDueDate("2026-08-31",1,31,31),"2026-09-30");
assert.equal(dueDateContext.apDueDate("2027-02-28",1,31,31),"2027-03-31");

assert.match(sql,/add column if not exists payment_mode text not null default 'credit'/);
assert.match(sql,/payment_mode in \('credit','cash_on_entry'\)/);
assert.match(sql,/create or replace function public\.accounts_payable_due_date\([\s\S]*?p_closing_day smallint/);
assert.match(sql,/when p_invoice_date <= effective_closing_date then invoice_month/);
assert.match(sql,/create unique index if not exists uq_accounts_payable_payment_source/);
assert.match(sql,/automatic_payment_key := 'cash-purchase:' \|\| cash_payable\.id::text/);
assert.match(sql,/on conflict \(source_key\) do update set/);
assert.match(sql,/where closing_day = 1/);
assert.match(sql,/profile\.payment_mode = 'cash_on_entry'/);

console.log("Accounts payable terms tests passed");
