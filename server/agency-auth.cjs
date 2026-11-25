const STAFF_PROJECT = "https://bvgjscxyjosjqqhxutyk.supabase.co";
const AGENCY_IMPORTER = "07";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

function agencyProjects() {
  const source = new URL(process.env.SUPABASE_URL || STAFF_PROJECT);
  const auth = new URL(process.env.AGENCY_AUTH_SUPABASE_URL || STAFF_PROJECT);
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/$/.test(auth.href)
      || auth.hostname === source.hostname || auth.origin === STAFF_PROJECT) {
    throw fail(503, "営業代行専用の認証を設定してください。");
  }
  return { source, auth };
}

async function adminRequest(path, method = "GET", body) {
  const { auth } = agencyProjects();
  const key = process.env.AGENCY_AUTH_SUPABASE_ADMIN_KEY?.trim();
  if (!key || key === process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw fail(503, "営業代行専用の管理キーを設定してください。");
  }
  const response = await fetch(new URL("/auth/v1/admin/users" + path, auth), {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    if (response.status === 404) throw fail(404, "対象の営業代行アカウントが見つかりません。");
    if (response.status === 409 || response.status === 422) throw fail(409, "登録済みのメールアドレスか、登録できないアドレスです。");
    throw fail(503, "営業代行アカウントを管理できませんでした。");
  }
  return response.json();
}

function managed(user) {
  return user?.app_metadata?.agency_sales_managed === true
    || user?.app_metadata?.agency_sales_importer === AGENCY_IMPORTER;
}

function accountRow(user) {
  const importerCode = user.app_metadata?.agency_sales_importer === AGENCY_IMPORTER ? AGENCY_IMPORTER : null;
  return { id: user.id, email: user.email || "", importerCode, active: importerCode !== null };
}

async function listAgencyUsers() {
  const accounts = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await adminRequest(`?page=${page}&per_page=200`);
    if (!Array.isArray(result?.users)) throw fail(503, "営業代行アカウントを読み込めませんでした。");
    accounts.push(...result.users.filter(managed).map(accountRow));
    if (result.users.length < 200) return accounts.sort((a, b) => a.email.localeCompare(b.email, "ja"));
  }
  throw fail(503, "営業代行アカウントが多すぎて一覧を読み込めませんでした。");
}

function assignment(importerCode) {
  if (importerCode !== AGENCY_IMPORTER && importerCode !== null) throw fail(400, "割り当て可能な輸入社コードは07のみです。");
  return { agency_sales_managed: true, agency_sales_importer: importerCode };
}

async function createAgencyUser(email, importerCode) {
  email = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) throw fail(400, "メールアドレスを確認してください。");
  if (importerCode == null) throw fail(400, "輸入社コードを選択してください。");
  // A pre-confirmed passwordless enrolment can receive a login code with signups disabled.
  const user = await adminRequest("", "POST", {
    email, email_confirm: true, app_metadata: assignment(importerCode)
  });
  return accountRow(user);
}

async function setAgencyAccess(id, importerCode) {
  if (typeof id !== "string" || !UUID.test(id)) throw fail(400, "対象アカウントが正しくありません。");
  const app_metadata = assignment(importerCode);
  const user = await adminRequest(`/${id}`);
  if (!managed(user)) throw fail(403, "営業代行として登録されたアカウントだけを設定できます。");
  return accountRow(await adminRequest(`/${id}`, "PUT", { app_metadata }));
}

module.exports = {
  STAFF_PROJECT, AGENCY_IMPORTER, agencyProjects, listAgencyUsers, createAgencyUser, setAgencyAccess
};
