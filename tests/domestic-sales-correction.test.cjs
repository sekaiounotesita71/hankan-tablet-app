const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");
const vm=require("node:vm");

const root=path.join(__dirname,"..");
const domestic=fs.readFileSync(path.join(root,"domestic-sales.html"),"utf8");
const main=fs.readFileSync(path.join(root,"order-entry-beta.html"),"utf8");
const sql=fs.readFileSync(path.join(root,"domestic-sales-correction-migration.sql"),"utf8");

const scripts=[...domestic.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match=>match[1]).filter(source=>source.trim());
scripts.forEach((source,index)=>new vm.Script(source,{filename:`domestic-correction-${index}.js`}));

function sourceBetween(source,start,end){
  const from=source.indexOf(start);
  const to=source.indexOf(end,from+start.length);
  assert.notEqual(from,-1,`${start} がありません`);
  assert.notEqual(to,-1,`${end} がありません`);
  return source.slice(from,to);
}

test("国内売上は管理者が確定後に売上・明細・売掛を一括修正できる",()=>{
  assert.match(domestic,/openDomesticSaleCorrection\('\$\{row\.id\}'\)/);
  assert.match(domestic,/supabaseClient\.rpc\("correct_domestic_sale"/);
  assert.match(domestic,/修正理由（4文字以上）/);
  assert.match(sql,/create or replace function public\.correct_domestic_sale/);
  assert.match(sql,/if not public\.is_master_admin\(\)/);
  assert.match(sql,/delete from public\.domestic_sale_lines where sale_id = p_sale_id/);
  assert.match(sql,/update public\.domestic_receivables/);
  assert.match(sql,/perform set_config\('app\.audit_reason'/);
});

test("入金済み・請求締め済み・輸出連動売上は修正と取消を拒否する",()=>{
  assert.match(sql,/target_receivable\.paid_amount_jpy > 0/);
  assert.match(sql,/domestic_sale_has_closed_billing\(target_sale\.customer_code,target_sale\.sale_date\)/);
  assert.match(sql,/source_type','manual'\) <> 'manual'/);
  const cancelSource=sourceBetween(sql,"create or replace function public.cancel_domestic_sale","revoke all on function public.domestic_sale_has_closed_billing");
  assert.match(cancelSource,/domestic_sale_has_closed_billing/);
  assert.match(cancelSource,/target_receivable\.paid_amount_jpy > 0/);
});

test("国内のコード候補は最大10件で矢印とEnterに対応し入力途中で自動選択しない",()=>{
  assert.match(domestic,/data-domestic-suggest="customer"/);
  assert.match(domestic,/data-domestic-suggest="product"/);
  assert.match(domestic,/\.slice\(0,10\)/);
  assert.match(domestic,/event\.key==="ArrowDown"\|\|event\.key==="ArrowUp"/);
  assert.match(domestic,/chooseActiveDomesticSuggestion/);
  const setter=sourceBetween(domestic,"function setEntryLine","function renderEntryLines");
  assert.doesNotMatch(setter,/applyProductToEntry/);
  assert.doesNotMatch(domestic,/id="entry-customer-code"[^>]+list="domestic-customer-list"/);
});

test("売上・仕入の確定後修正とマスタ停止は共通ルールを持つ",()=>{
  assert.match(main,/function openSalesRecordCorrection/);
  assert.match(main,/admin_correct_sales_record/);
  assert.match(main,/function unlockPurchaseReceiptForCorrection/);
  assert.match(main,/unlock_purchase_receipt_for_correction/);
  assert.match(main,/過去データは残り、今後の候補からは非表示になります/);
  assert.match(domestic,/function toggleDomesticCustomerActive/);
  assert.match(domestic,/過去の売上・売掛は削除されません/);
});
