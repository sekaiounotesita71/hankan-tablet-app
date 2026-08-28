const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "purchase-price-profit-migration.sql"), "utf8");
const baseSql = fs.readFileSync(path.join(root, "order-entry-beta-migration.sql"), "utf8");
const backup = fs.readFileSync(path.join(root, "scripts", "export-supabase-backup.ps1"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing marker: ${startMarker}`);
  assert.ok(end > start, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const pricingSource = sourceBetween(
  html,
  "function purchasePriceUnit",
  "function refreshOrderRowMasterPrice"
);
const pricing = new Function(
  "masterCodeKey",
  "dbNumber",
  `${pricingSource}; return { purchasePriceUnit, productPurchasePriceForSupplier };`
)(
  value => String(value || "").normalize("NFKC").trim().toLowerCase(),
  value => {
    const text = String(value ?? "").replace(/,/g, "").trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
);

const product = {
  purchaseUnitPrice: 1200,
  purchasePriceUnit: "Kg",
  supplierPrices: {
    S001: { price: 980, unit: "Kg" },
    S002: { price: 240, unit: "PC" }
  }
};
assert.deepEqual(pricing.productPurchasePriceForSupplier(product, "s001"), {
  price: 980,
  unit: "Kg",
  source: "supplier",
  supplierCode: "S001"
});
assert.equal(pricing.productPurchasePriceForSupplier(product, "S002").price, 240);
assert.equal(pricing.productPurchasePriceForSupplier(product, "S002").unit, "PC");
assert.equal(pricing.productPurchasePriceForSupplier(product, "S999").price, 1200);
assert.equal(pricing.productPurchasePriceForSupplier(product, "S999").source, "product");
assert.equal(pricing.productPurchasePriceForSupplier({ purchaseUnitPrice: 0 }, "S999").price, null);

const costSource = sourceBetween(
  html,
  "function salesRefCostQuantity",
  "async function salesRefAttachPurchaseCosts"
);
let activeProduct = product;
const cost = new Function(
  "purchasePriceUnit",
  "normalizeLineUnit",
  "salesRefNum",
  "findMasterProduct",
  "productPurchasePriceForSupplier",
  `${costSource}; return { salesRefCostQuantity, salesRefCostInfo };`
)(
  pricing.purchasePriceUnit,
  unit => ({ kg: "Kg", pkt: "pkt", pc: "PC", cs: "CS" }[String(unit || "").toLowerCase()] || String(unit || "")),
  value => Number(value) || 0,
  () => activeProduct,
  pricing.productPurchasePriceForSupplier
);

assert.equal(cost.salesRefCostInfo({ input_qty: 3, input_unit: "PC", _purchaseSupplierCode: "S002" }).amount, 720);
assert.equal(cost.salesRefCostInfo({ net_weight: 2.5, input_unit: "PC", _purchaseSupplierCode: "S001" }).amount, 2450);
assert.equal(cost.salesRefCostInfo({ net_weight: 2, _purchaseSupplierCode: "S001", _purchaseCostActual: 777 }).amount, 1960);
assert.equal(cost.salesRefCostInfo({ net_weight: 2, _purchaseSupplierCode: "S001", _purchaseCostActual: 777 }).source, "supplier");
activeProduct = null;
assert.equal(cost.salesRefCostInfo({ input_qty: 1, input_unit: "PC" }).priced, false);

const unpricedSource = sourceBetween(
  html,
  "function salesRefUnpricedProductGroups",
  "function salesRefUnpricedProductTable"
);
const unpricedGroups = new Function(
  "salesRefCostInfo",
  "salesRefNum",
  `${unpricedSource}; return salesRefUnpricedProductGroups;`
)(
  () => ({ priced: false }),
  value => Number(value) || 0
);
const groupedUnpriced = unpricedGroups([
  { product_id: "157C", product_name: "畜養マグロ 腹上", amount: 100 },
  { product_id: "157C", product_name: "冷凍短期畜養マグロ 腹上", amount: 200 },
  { product_id: "422", product_name: "ウニ", amount: 250 }
]);
assert.equal(groupedUnpriced.length, 2);
assert.equal(groupedUnpriced[0].code, "157C");
assert.equal(groupedUnpriced[0].sales, 300);
assert.match(groupedUnpriced[0].name, /畜養マグロ 腹上/);
assert.match(groupedUnpriced[0].name, /冷凍短期畜養マグロ 腹上/);

assert.match(html, /id="advance-purchase-order-supplier"/);
assert.match(html, /id="advance-purchase-supplier"/);
assert.match(html, /productPurchasePriceForSupplier\(product,supplierCode\)/);
assert.match(html, /商品別粗利/);
assert.match(html, /得意先別粗利/);
assert.match(html, /輸入社・国内別粗利/);
assert.match(html, /原価未設定商品（売上金額順）/);
assert.match(html, /原価未設定売上/);
assert.match(html, /全体粗利/);
assert.match(html, /算出不可/);
assert.match(html, /期間仕入（税抜）/);
assert.match(html, /全体粗利には影響しません/);
assert.match(sql, /create table if not exists public\.product_supplier_prices/);
assert.match(sql, /purchase_unit_price numeric/);
assert.match(sql, /trg_product_supplier_prices_change_log/);
assert.match(sql, /create policy internal_access_guard/);
assert.match(baseSql, /product_supplier_prices/);
assert.match(backup, /"product_supplier_prices"/);

console.log("Purchase pricing and profit tests passed");
