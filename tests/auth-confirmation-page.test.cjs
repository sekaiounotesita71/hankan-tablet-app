const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "auth-confirm.html"), "utf8");
const setup = fs.readFileSync(path.join(root, "USER-MANAGEMENT-SETUP.md"), "utf8");

test("confirmation page does not verify a token until the user presses the button", () => {
  const validationPosition = page.indexOf("validateConfirmation();");
  const verifyPosition = page.indexOf("client.auth.verifyOtp");
  assert.ok(validationPosition > verifyPosition, "the trailing startup call must only validate the URL");
  assert.match(page, /onclick="confirmAuthentication\(\)"/);
  assert.doesNotMatch(page.slice(validationPosition), /verifyOtp/);
});

test("confirmation token stays in the fragment and is removed after verification", () => {
  assert.match(page, /location\.hash/);
  assert.match(page, /history\.replaceState\(null,"",location\.pathname\)/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
});

test("invite and recovery templates use the scanner-resistant confirmation page", () => {
  assert.match(setup, /auth-confirm\.html#token_hash=\{\{ \.TokenHash \}\}&type=invite/);
  assert.match(setup, /auth-confirm\.html#token_hash=\{\{ \.TokenHash \}\}&type=recovery/);
});
