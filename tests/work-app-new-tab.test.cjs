const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "order-entry-beta.html"), "utf8");
const workLinks = [...app.matchAll(/<a class="(?:app-nav-link|home-command)" href="\.\/index\.html" target="_blank" rel="noopener">/g)];
const workApp = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const managementLinks = [...workApp.matchAll(/<a class="(?:app-nav-link|btn)" href="\.\/(?:order-entry-beta\.html(?:#[^"]+)?|domestic-sales\.html)" target="_blank" rel="noopener">/g)];
const legacyWorkApp = fs.readFileSync(path.join(__dirname, "..", "hankan-p1p2-tablet.html"), "utf8");
const legacyManagementLinks = [...legacyWorkApp.matchAll(/<a class="app-nav-link" href="\/order-entry-beta\.html#(?:orders|supplier-board)" target="_blank" rel="noopener">/g)];

assert.equal(workLinks.length, 2);
assert.equal(managementLinks.length, 14);
assert.equal(legacyManagementLinks.length, 2);

console.log("Work-app bidirectional new-tab links tests passed");
