const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
scripts.forEach((script, index) => new vm.Script(script, { filename: `order-entry-inline-${index}.js` }));

assert.match(html, /id="advance-purchase-master-scope"/);
assert.match(html, /仕入先別単価/);
assert.match(html, /標準仕入単価/);
assert.match(html, /onclick="saveSelectedAdvancePurchaseMasterPrices\(\)"/);
assert.match(html, /data-advance-master-row-id/);

assert.match(html, /function advancePurchaseMasterPriceEntries\(\)/);
assert.match(html, /商品マスタ未登録/);
assert.match(html, /同じ商品コードで異なる仕入単価/);
assert.match(html, /if\(!currentUserIsAdmin\(\)\)/);
assert.match(html, /product_supplier_prices[\s\S]*?onConflict:"product_id,supplier_code"/);
assert.match(html, /product_master[\s\S]*?purchase_unit_price:entry\.price/);
assert.match(html, /source_filename:"purchase-entry-selected-price"/);
assert.match(html, /保存件数が一致しません/);
assert.match(html, /advancePurchaseMasterPriceSelections\.clear\(\)/);

console.log("Purchase master price registration tests passed");
