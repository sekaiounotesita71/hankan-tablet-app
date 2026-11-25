const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/agency-sales");

const origin = "https://agency.example";
const auth = "https://agencyauth.supabase.co";
const source = "https://salesdb.supabase.co";
const email = "agent@example.test";
const userId = "aaaaaaaa-1111-4444-9999-999999999999";
const token = (claims = {}) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({
  iss: auth + "/auth/v1", role: "authenticated", aud: "authenticated", sub: userId,
  exp: Math.floor(Date.now() / 1000) + 1200, ...claims
})).toString("base64url")}.testSignature`;
const list = { action: "list", from: "2026-11-01", to: "2026-11-25", page: 1 };

function fixture(t) {
  const changes = {
    SUPABASE_URL: source, SUPABASE_SERVICE_ROLE_KEY: "staff-server-key",
    AGENCY_AUTH_SUPABASE_URL: auth, AGENCY_AUTH_SUPABASE_PUBLIC_KEY: "agency-public-key",
    AGENCY_APP_ORIGIN: origin
  };
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = [];
  const state = { importer: "07", userStatus: 200, otpStatus: 200, verifyStatus: 200, userConfirmed: true };
  t.mock.method(global, "fetch", async (url, options) => {
    const path = url.pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: url.href, body, headers: options.headers });
    if (path.endsWith("/otp")) return Response.json({}, { status: state.otpStatus });
    if (path.endsWith("/verify")) return Response.json({ access_token: token(), refresh_token: "not for clients" }, { status: state.verifyStatus });
    if (path.endsWith("/user")) return Response.json({
      id: userId, email_confirmed_at: state.userConfirmed ? "2026-11-01" : null,
      app_metadata: { agency_sales_importer: state.importer },
      user_metadata: { agency_sales_importer: "07" }
    }, { status: state.userStatus });
    assert.equal(url.href, source + "/rest/v1/rpc/agency_sales_07");
    return Response.json({ count: 1, netSales: 100, freight: 0, missingAmountCount: 0,
      rows: [{ product_name: "Sale", product_code: "0123", amount: 100, memo: "Hidden", purchase_price: 70, importer_code: "07" }] });
  });
  async function run(body, headers = {}, method = "POST") {
    const result = { headers: {} };
    await handler({ method, headers: { origin, "content-type": "application/json", ...headers }, body }, {
      set statusCode(code) { result.status = code; },
      setHeader(key, value) { result.headers[key] = value; },
      end(value) { result.body = JSON.parse(value); }
    });
    return result;
  }
  return { state, calls, run };
}

const cookieHeader = value => ({ cookie: `__Host-agency-sales=${value}` });

test("staff and unverified accounts cannot cause a business database read", async t => {
  const { calls, state, run } = fixture(t);
  assert.equal((await run(list)).status, 401);
  assert.equal((await run(list, cookieHeader(token({ iss: source + "/auth/v1" })))).status, 401);
  assert.equal((await run(list, cookieHeader(token({ role: "service_role" })))).status, 401);
  assert.equal(calls.length, 0);

  state.userStatus = 401;
  assert.equal((await run(list, cookieHeader(token()))).status, 401);
  state.userStatus = 200;
  state.userConfirmed = false;
  assert.equal((await run(list, cookieHeader(token()))).status, 403);
  assert.ok(calls.every(call => call.url === auth + "/auth/v1/user"));
});

test("permission is rechecked on every request using trusted metadata; no importer input reaches the DB", async t => {
  const { calls, state, run } = fixture(t);
  const session = cookieHeader(token({ app_metadata: { agency_sales_importer: "07" } }));
  const result = await run({ ...list, importerCode: "01", select: "*", product: " 01 ", customer: "Client", site: "TYO" }, session);
  assert.equal(result.status, 200);
  assert.equal(result.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(result.body.rows, [{ product_name: "Sale", product_code: "0123", amount: 100 }]);
  assert.deepEqual(calls[1].body, { p_from: list.from, p_to: list.to, p_page: 1, p_product: "01", p_customer: "Client", p_site: "TYO" });
  assert.equal(calls[0].headers.apikey, "agency-public-key");
  assert.equal(calls[1].headers.apikey, "staff-server-key");
  state.importer = null;
  assert.equal((await run(list, session)).status, 403);
  assert.equal(calls.length, 3);
});

test("account setup sends no signup and stores only the current access token in a secure cookie", async t => {
  const { calls, state, run } = fixture(t);
  assert.equal((await run({ action: "request-code", email })).status, 200);
  assert.deepEqual(calls[0].body, { email, create_user: false });
  state.otpStatus = 400;
  assert.deepEqual((await run({ action: "request-code", email })).body, { ok: true });
  assert.equal((await run({ action: "verify-code", email, code: "abcdef" })).status, 400);
  const verified = await run({ action: "verify-code", email, code: "001234" });
  assert.equal(verified.status, 200);
  assert.deepEqual(calls[2].body, { email, token: "001234", type: "email" });
  assert.match(verified.headers["Set-Cookie"], /; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  assert.deepEqual(verified.body, { ok: true });
  assert.match((await run({ action: "logout" })).headers["Set-Cookie"], /Max-Age=0$/);
});

test("rejects cross-site writes, invalid dates, unknown actions and staff project reuse", async t => {
  const { calls, run } = fixture(t);
  assert.equal((await run(list, { origin: "https://other.example" })).status, 403);
  assert.equal((await run(list, {}, "GET")).status, 405);
  assert.equal((await run({ action: "delete" })).status, 400);
  assert.equal(calls.length, 0);
  const session = cookieHeader(token());
  for (const input of [{ to: "2026-02-29" }, { to: "2028-11-01" }, { page: 0 }, { site: "07" }, { product: "a".repeat(121) }]) {
    assert.equal((await run({ ...list, ...input }, session)).status, 400);
  }
  assert.ok(calls.every(call => call.url === auth + "/auth/v1/user"));
  process.env.AGENCY_AUTH_SUPABASE_URL = source;
  assert.equal((await run(list, session)).status, 503);
  assert.equal(calls.length, 5);
});
