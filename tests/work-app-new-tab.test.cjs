const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "order-entry-beta.html"), "utf8");
const workLinks = [...app.matchAll(/<a class="(?:app-nav-link|home-command)" href="\.\/index\.html" target="_blank" rel="noopener">/g)];

assert.equal(workLinks.length, 2);

console.log("Work-app new-tab links tests passed");
