const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const docs = require("../domestic-documents.js");

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

test("regular delivery note prints case-number order with the exact saved amounts, without changing invoice defaults", async () => {
  const lines = [
    {id:"a",line_no:1,product_name_snapshot:"BOX-TEN",quantity:1.13,unit_price_jpy:3050,net_amount_jpy:3447,source_sales_record_id:"source-a"},
    {id:"b",line_no:2,product_name_snapshot:"BOX-TWO-FIRST",quantity:1,unit_price_jpy:100,net_amount_jpy:100,delivery_carton_no:"JNX/No,Y2",source_sales_record_id:"source-b"},
    {id:"c",line_no:3,product_name_snapshot:"NO-CASE",quantity:1,unit_price_jpy:300,net_amount_jpy:300},
    {id:"d",line_no:4,product_name_snapshot:"BOX-TWO-SECOND",quantity:1,unit_price_jpy:100,net_amount_jpy:100,source_sales_record_id:"source-d"}
  ].map(line=>Object.freeze({...line,tax_rate:8,unit:"Kg"}));
  const sale=Object.freeze({
    id:"sale-1",sale_no:"D1",sale_date:"2026-11-24",status:"confirmed",customer_code:"168",customer_name_snapshot:"テスト得意先",
    source_session_id:"session-1",source_importer_code:"10",lines:Object.freeze(lines),
    product_subtotal_8_jpy:3947,product_subtotal_10_jpy:0,shipping_amount_jpy:600,
    tax_8_jpy:315,tax_10_jpy:60,total_net_jpy:4547,tax_total_jpy:375,total_amount_jpy:4922
  });
  const start=html.indexOf("async function domesticDeliveryCaseNumbers("),end=html.indexOf("async function printDomesticInvoice(",start);
  assert.ok(start>=0&&end>start);
  const actions=[];
  const query={select(fields){actions.push(fields);return this},in(field,ids){actions.push([field,...ids]);return this},
    eq(field,id){actions.push([field,id]);return this},order(field){actions.push(field);return this}};
  let result;
  const context={
    DomesticDocuments:docs,customers:[],URL,location:{href:"https://example.test/domestic-sales"},
    openDomesticPrintWindow:()=>({close(){assert.fail("print should succeed")}}),domesticSaleForDocument:async()=>sale,
    supabaseClient:{from(table){assert.equal(table,"sales_records");return query}},fetchPaged:async build=>{
      assert.equal(build(),query);
      return [{id:"source-a",box_no:"１０"},{id:"source-d",box_no:"2"}];
    },writeDomesticPrintDocument:(_window,_title,body)=>{result=body},showToast:message=>assert.fail(message)
  };
  vm.runInNewContext(html.slice(start,end),context);
  await context.printDomesticDeliveryNote(sale.id);
  assert.deepEqual(JSON.parse(JSON.stringify(actions)),["id,box_no",["id","source-a","source-d"],["session_id","session-1"],["importer_code","10"],"id"]);
  const printedOrder=body=>[...body.matchAll(/\b(BOX-(?:TWO-FIRST|TWO-SECOND|TEN)|NO-CASE)\b/g)].map(m=>m[0]);
  assert.deepEqual(printedOrder(result),["BOX-TWO-FIRST","BOX-TWO-SECOND","BOX-TEN","NO-CASE"]);
  assert.deepEqual(printedOrder(docs.delivery(sale)),["BOX-TEN","BOX-TWO-FIRST","NO-CASE","BOX-TWO-SECOND"]);
  assert.match(result,/<td class="num">3,447<\/td>/);
  assert.match(result,/税込合計<\/th><td>4,922円/);
  assert.deepEqual(lines.map(line=>line.line_no),[1,2,3,4]);
  actions.length=0;
  const manual=await context.domesticDeliveryCaseNumbers({lines:[{id:"manual"}]});
  assert.equal(manual.get("manual"),"");
  assert.equal(actions.length,0);
});

console.log("Domestic billing and document tests passed");
