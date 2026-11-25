const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/admin-users");

const staff = "https://staffproj.supabase.co";
const agency = "https://agencyproj.supabase.co";
const userId = "aaaaaaaa-1111-4444-9999-999999999999";
const otherId = "bbbbbbbb-2222-4444-9999-999999999999";
const other = { id: otherId, email: "other@example.test", user_metadata: { agency_sales_managed: true } };

function fixture(t) {
  const env = {
    SUPABASE_URL: staff, SUPABASE_SERVICE_ROLE_KEY: "staff-test-secret",
    AGENCY_AUTH_SUPABASE_URL: agency, AGENCY_AUTH_SUPABASE_ADMIN_KEY: "agency-test-secret"
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = { staffAdmin: true, user: null };
  const requests = [];
  t.mock.method(global, "fetch", async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const payload = options.body ? JSON.parse(options.body) : null;
    requests.push({ host: url.origin, path: url.pathname, method: options.method, payload, headers: options.headers });
    if (url.origin === staff) {
      assert.equal(options.headers.apikey, "staff-test-secret");
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "staff-admin" });
      assert.equal(url.pathname, "/rest/v1/user_roles");
      return Response.json(state.staffAdmin ? [{ user_id: "staff-admin" }] : []);
    }
    assert.equal(url.origin, agency);
    assert.equal(options.headers.apikey, "agency-test-secret");
    assert.equal(options.headers.Authorization, "Bearer agency-test-secret");
    if (url.pathname === "/auth/v1/admin/users") {
      if (options.method === "POST") {
        state.user = { id: userId, email: payload.email, app_metadata: payload.app_metadata, internal: "omitted" };
        return Response.json(state.user);
      }
      return Response.json({ users: [state.user, other].filter(Boolean) });
    }
    if (url.pathname.endsWith(otherId)) return Response.json(other);
    assert.equal(url.pathname, `/auth/v1/admin/users/${userId}`);
    if (options.method === "PUT") state.user.app_metadata = payload.app_metadata;
    return Response.json(state.user);
  });
  async function post(body, authorization = "Bearer verified-test-token") {
    const result = {};
    await handler({ method: "POST", headers: { authorization }, body }, {
      set statusCode(code) { result.status = code; },
      setHeader() {},
      end(text) { result.data = JSON.parse(text); }
    });
    return result;
  }
  return { state, requests, post };
}

test("only a staff admin can list or assign agency accounts, without who they are leaking to non-admins", async t => {
  const { state, requests, post } = fixture(t);
  assert.equal((await post({ action: "agency-list" }, "")).status, 401);
  assert.equal(requests.length, 0);
  state.staffAdmin = false;
  assert.equal((await post({ action: "agency-list" })).status, 403);
  assert.equal((await post({ action: "agency-assign", userId, importerCode: "07" })).status, 403);
  assert.ok(requests.every(request => request.host === staff));
});

test("07 is assigned only in the separate Auth project, and a stopped account can be reassigned", async t => {
  const { requests, post } = fixture(t);
  const enrollment = { action: "agency-create", email: " Agent@EXAMPLE.test ", importerCode: "07" };
  const enabled = { id: userId, email: "agent@example.test", importerCode: "07", active: true };
  assert.deepEqual((await post(enrollment)).data.user, enabled);
  assert.deepEqual(requests.find(request => request.host === agency).payload, {
    email: enabled.email, email_confirm: true, app_metadata: { agency_sales_managed: true, agency_sales_importer: "07" }
  });
  assert.deepEqual((await post({ action: "agency-list" })).data.users, [enabled]);
  assert.deepEqual((await post({ action: "agency-suspend", userId })).data.user, { ...enabled, active: false, importerCode: null });
  assert.equal((await post({ action: "agency-list" })).data.users[0].active, false);
  assert.deepEqual((await post({ action: "agency-assign", userId, importerCode: "07" })).data.user, enabled);
  assert.ok(requests.filter(request => request.host === staff).every(request => !request.method || request.method === "GET"));
});

test("rejects other importer assignments and staff-project reuse before any agency write", async t => {
  const { requests, post } = fixture(t);
  for (const action of ["agency-create", "agency-assign"]) {
    assert.equal((await post({ action, email: "agent@example.test", userId, importerCode: "01" })).status, 400);
    assert.equal((await post({ action, email: "agent@example.test", userId })).status, 400);
  }
  assert.ok(requests.every(request => request.host === staff));
  assert.equal((await post({ action: "agency-assign", userId: otherId, importerCode: "07" })).status, 403);
  process.env.AGENCY_AUTH_SUPABASE_URL = staff;
  assert.equal((await post({ action: "agency-list" })).status, 503);
  assert.ok(requests.filter(request => request.host === agency).every(request => request.method === "GET"));
});
