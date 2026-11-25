const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright")); }
catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

test("agency login, sales paging and logout on desktop and mobile", { skip: !chromium, timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      const errors = [];
      const requests = [];
      let signedIn = false;
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        const file = {
          "/agency-sales": "agency-sales.html", "/agency-sales.js": "agency-sales.js",
          "/agency-sales.css": "agency-sales.css", "/yumirume-logo.jpg": "yumirume-logo.jpg"
        }[url.pathname];
        if (url.host !== "portal.test") return route.abort();
        if (file) return route.fulfill({ path: path.join(root, file) });
        if (url.pathname !== "/api/agency-sales") return route.abort();
        const request = route.request().postDataJSON();
        requests.push(request);
        if (request.action === "list" && !signedIn) return route.fulfill({ status: 401, json: { error: "ログインしてください。" } });
        if (request.action === "list") {
          const filtered = Boolean(request.product);
          const rows = Array.from({ length: request.page === 1 && !filtered ? 100 : 1 }, () => ({
            kind: "sale", sale_date: request.from, site_code: "OSA", customer_name: "テスト得意先",
            product_name: request.page === 1 ? "テスト商品 <img src=x>" : "2ページ目の商品", product_code: "0007",
            qty: 3, unit: "PC", unit_price: 1200, amount: 3600
          }));
          return route.fulfill({ json: { rows, count: filtered ? 1 : 101,
            netSales: filtered ? 3600 : 363600, freight: filtered ? 0 : 5400, missingAmountCount: 0 } });
        }
        if (request.action === "verify-code") signedIn = request.code === "001234";
        if (request.action === "logout") signedIn = false;
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto("http://portal.test/agency-sales");
      await page.locator("#login").waitFor();
      assert.equal(await page.locator("#sales").isVisible(), false);
      await page.locator("#email").fill("agent@example.test");
      await page.getByRole("button", { name: "確認コードを送る" }).click();
      await page.locator("#code").fill("001234");
      await page.getByRole("button", { name: "ログイン", exact: true }).click();
      await page.locator("#rows tr").first().waitFor();
      assert.equal(await page.locator("#rows tr").count(), 100);
      assert.equal(await page.locator("#rows img").count(), 0);
      assert.equal(await page.locator("#total").textContent(), "369,000 円");
      assert.equal(await page.locator("#prev").isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator("header img").evaluate(img => img.complete && img.naturalWidth > 0), true);
      await page.getByRole("button", { name: "次へ" }).click();
      await page.getByText("2ページ目の商品").waitFor();
      assert.equal(await page.locator("#next").isDisabled(), true);
      await page.locator("#from").fill("2026-10-01");
      await page.locator("#to").fill("2026-10-31");
      await page.getByLabel("商品名・商品コード").fill("0007");
      await page.getByLabel("得意先名").fill("テスト");
      await page.getByLabel("拠点", { exact: true }).selectOption("OSA");
      await page.getByRole("button", { name: "検索", exact: true }).click();
      await page.getByText("2026-10-01 ～ 2026-10-31 ・ 1件").waitFor();
      assert.equal(await page.locator("#freight").textContent(), "対象外");
      assert.equal(await page.locator("#total").textContent(), "3,600 円");
      assert.deepEqual(requests.at(-1), {
        action: "list", from: "2026-10-01", to: "2026-10-31", product: "0007", customer: "テスト", site: "OSA", page: 1
      });
      if (process.env.AGENCY_SCREENSHOT_DIR) await page.screenshot({
        path: path.join(process.env.AGENCY_SCREENSHOT_DIR, `agency-${width}.png`)
      });
      await page.getByRole("button", { name: "ログアウト", exact: true }).click();
      await page.getByText("ログアウトしました。").waitFor();
      assert.equal(await page.locator("#rows tr").count(), 0);
      assert.equal(await page.locator("#total").textContent(), "");
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("staff user management can issue, suspend and reassign agency access", { skip: !chromium, timeout: 30000 }, async () => {
  const source = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
  const panel = source.match(/<details id="agency-users"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(panel);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 650 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await page.setContent(`<!doctype html><meta charset="utf-8">${panel}`);
    await page.addScriptTag({ content: `
      let isAdmin = true;
      let users = [];
      const actions = [];
      function currentUserIsAdmin() { return isAdmin; }
      async function userAdminApi(method, payload) {
        actions.push(payload);
        if (payload.action === 'agency-create') {
          users.push({ id: 'fixture', email: payload.email, importerCode: payload.importerCode, active: true });
        }
        if (payload.action === 'agency-suspend') Object.assign(users[0], { active: false, importerCode: null });
        if (payload.action === 'agency-assign') Object.assign(users[0], { active: true, importerCode: payload.importerCode });
        return { users };
      }
    ` });
    await page.addScriptTag({ path: path.join(root, "agency-sales-admin.js") });
    await page.getByText("営業代行の売上閲覧").click();
    await page.getByText("登録済みの営業代行アカウントはありません。").waitFor();
    await page.getByLabel("メールアドレス").fill("agent@example.test");
    await page.getByRole("button", { name: "発行", exact: true }).click();
    await page.getByText("アカウントを発行しました。").waitFor();
    assert.equal(await page.locator("tbody").textContent(), "agent@example.test07有効停止");
    await page.getByRole("button", { name: /の閲覧を停止/ }).click();
    await page.getByText("閲覧を停止しました。").waitFor();
    await page.getByRole("button", { name: /の閲覧を再割り当て/ }).click();
    await page.getByText("輸入社07を割り当てました。").waitFor();
    assert.deepEqual(await page.evaluate(() => actions.filter(action => action.action !== "agency-list")), [
      { action: "agency-create", email: "agent@example.test", importerCode: "07" },
      { action: "agency-suspend", userId: "fixture", importerCode: "07" },
      { action: "agency-assign", userId: "fixture", importerCode: "07" }
    ]);
    await page.evaluate(() => { isAdmin = false; window.resetAgencyUsers(); });
    assert.equal(await page.locator("tbody tr").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
