const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const workApp = fs.readFileSync(path.join(root, "index.html"), "utf8");
const managementApp = fs.readFileSync(path.join(root, "order-entry-beta.html"), "utf8");
const adminApi = fs.readFileSync(path.join(root, "api", "admin-users.js"), "utf8");

test("root app forwards invite and recovery callbacks to password setup", () => {
  assert.match(workApp, /type=\(\?:invite\|recovery\)/);
  assert.match(workApp, /order-entry-beta\.html\?setup=1\$\{location\.hash\}/);
});

test("management app recognizes callback type before and during auth initialization", () => {
  assert.match(managementApp, /const authCallbackType=/);
  assert.match(managementApp, /has\("reset"\)\|\|authCallbackType\(\)/);
  assert.match(managementApp, /event==="PASSWORD_RECOVERY"\|\|authCallbackType\(\)/);
});

test("invite email points to the management password setup route", () => {
  assert.match(adminApi, /redirect_to:\s*`\$\{appOrigin\}\/order-entry-beta\?setup=1`/);
});
