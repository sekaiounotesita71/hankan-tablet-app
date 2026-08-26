const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");

function sourceBetween(start,end){
  const from=html.indexOf(start);
  const to=html.indexOf(end,from+start.length);
  assert.notEqual(from,-1,`${start} がありません`);
  assert.notEqual(to,-1,`${end} がありません`);
  return html.slice(from,to);
}

test("仕入入力の商品コードと商品名から最大10件のマスタ候補を表示する",()=>{
  assert.match(html,/data-advance-field="productCode"[^>]+oninput="setAdvancePurchaseRow/);
  assert.match(html,/data-advance-field="productName"[^>]+oninput="setAdvancePurchaseRow/);
  assert.doesNotMatch(html,/class="product-code ime-ja" list="product-code-list"/);
  const source=sourceBetween("function hideAdvancePurchaseProductSuggestions","function applyAdvancePurchaseProduct");
  assert.match(source,/productInlineMatches\(query\)/);
  assert.match(source,/inline-product-suggest advance-product-suggest/);
  assert.match(source,/product\.code/);
  assert.match(source,/product\.name/);
});

test("仕入商品候補は上下キーとEnterで選択し入力途中では自動確定しない",()=>{
  const inputSource=sourceBetween("function setAdvancePurchaseRow","function hideAdvancePurchaseProductSuggestions");
  assert.match(inputSource,/showAdvancePurchaseProductSuggestions\(index,field,value\)/);
  assert.doesNotMatch(inputSource,/applyAdvancePurchaseProduct\(index/);
  const keySource=sourceBetween('if(target instanceof HTMLElement&&target.matches("[data-advance-input]"))','if(target instanceof HTMLElement&&target.matches("[data-advance-header]")');
  assert.match(keySource,/e\.key==="ArrowDown"\|\|e\.key==="ArrowUp"/);
  assert.match(keySource,/e\.key==="Enter"&&chooseActiveAdvancePurchaseProduct/);
  assert.match(keySource,/e\.key==="Escape"/);
});

test("仕入商品候補の確定で数量へ移動し仕入先別マスタ単価を補完する",()=>{
  const chooseSource=sourceBetween("function chooseAdvancePurchaseProductSuggestion","function chooseActiveAdvancePurchaseProduct");
  assert.match(chooseSource,/applyAdvancePurchaseProduct\(index,product\)/);
  assert.match(chooseSource,/focusAdvancePurchaseCell\(index,"actualQty"\)/);
  const applySource=sourceBetween("function applyAdvancePurchaseProduct","function resolveAdvancePurchaseProduct");
  assert.match(applySource,/productPurchasePriceForSupplier/);
  assert.match(applySource,/row\.productCode=product\.code/);
  assert.match(applySource,/row\.productName=product\.name/);
});
