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
assert.deepEqual(cost.salesRefCostInfo({ _purchaseCostActual: 777 }), { priced: true, amount: 777, source: "actual" });
activeProduct = null;
assert.equal(cost.salesRefCostInfo({ input_qty: 1, input_unit: "PC" }).priced, false);

assert.match(html, /id="advance-purchase-order-supplier"/);
assert.match(html, /id="advance-purchase-supplier"/);
assert.match(html, /productPurchasePriceForSupplier\(product,supplierCode\)/);
assert.match(html, /商品別粗利/);
assert.match(html, /得意先別粗利/);
assert.match(html, /輸入社・国内別粗利/);
assert.match(sql, /create table if not exists public\.product_supplier_prices/);
assert.match(sql, /purchase_unit_price numeric/);
assert.match(sql, /trg_product_supplier_prices_change_log/);
assert.match(sql, /create policy internal_access_guard/);
assert.match(baseSql, /product_supplier_prices/);
assert.match(backup, /"product_supplier_prices"/);

console.log("Purchase pricing and profit tests passed");
