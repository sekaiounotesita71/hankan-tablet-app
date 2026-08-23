const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

assert.match(app, /preservedTabScrollPositions/);
assert.match(app, /horizontalScrollInteractionUntil/);
assert.match(app, /Date\.now\(\)<horizontalScrollInteractionUntil/);
assert.match(app, /document\.addEventListener\("scroll",event=>markHorizontalScrollInteraction/);
assert.match(app, /const __buildP1TabsScrollBase=buildP1Tabs/);
assert.match(app, /const __buildP15ScrollBase=buildP15/);
assert.match(app, /const __buildP2ScrollBase=buildP2/);

console.log("Work-app horizontal scroll stability tests passed");
