const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

test("company logo asset is included", () => {
  const logo = path.join(root, "yumirume-logo.jpg");
  assert.ok(fs.existsSync(logo));
  assert.ok(fs.statSync(logo).size > 10000);
});

test("main applications show the shared logo", () => {
  for (const name of ["order-entry-beta.html", "index.html", "domestic-sales.html", "partner-work.html"]) {
    const html = read(name);
    assert.match(html, /yumirume-logo\.jpg/);
    assert.match(html, /YUMIRUME INC\./);
  }
});

test("print documents use the shared logo", () => {
  const order = read("order-entry-beta.html");
  const domestic = read("domestic-sales.html");
  assert.match(order, /new URL\("\.\/yumirume-logo\.jpg",location\.href\)\.href/);
  assert.match(order, /class=\"report-brand\"/);
  assert.match(domestic, /class=\"company-logo\"/);
  assert.match(domestic, /domesticCompanyHtml\(\)/);
});

test("logo sizes are constrained for tablet headers", () => {
  const css = read("app-nav.css");
  assert.match(css, /\.app-brand-logo\{[^}]*width:88px[^}]*height:54px/);
  assert.match(css, /\.app-login-logo\{[^}]*width:150px[^}]*height:92px/);
});
