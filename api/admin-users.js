const DEFAULT_SUPABASE_URL = "https://bvgjscxyjosjqqhxutyk.supabase.co";
const DEFAULT_APP_ORIGIN = "https://hankan-tablet-app.vercel.app";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function configuration() {
  const supabaseUrl = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const appOrigin = String(process.env.APP_ORIGIN || DEFAULT_APP_ORIGIN).replace(/\/$/, "");
  if (!serviceRoleKey) throw new Error("Vercelに SUPABASE_SERVICE_ROLE_KEY を設定してください。");
  return { supabaseUrl, serviceRoleKey, appOrigin };
}

async function supabaseRequest(path, options = {}) {
  const { supabaseUrl, serviceRoleKey } = configuration();
  const response = await fetch(`${supabaseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (error) { data = { message: text }; }
  }
  if (!response.ok) {
    const message = data?.msg || data?.message || data?.error_description || data?.error || `Supabase API error (${response.status})`;
    const apiError = new Error(message);
    apiError.status = response.status;
    throw apiError;
  }
  return data;
}

async function requireAdministrator(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error("ログイン情報がありません。");
    error.status = 401;
    throw error;
  }
  const { supabaseUrl, serviceRoleKey } = configuration();
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${match[1]}` }
  });
  if (!userResponse.ok) {
    const error = new Error("ログイン期限が切れています。再度ログインしてください。");
    error.status = 401;
    throw error;
  }
  const user = await userResponse.json();
  const params = new URLSearchParams({ select: "user_id", user_id: `eq.${user.id}`, role: "eq.admin", limit: "1" });
  const roles = await supabaseRequest(`/rest/v1/user_roles?${params.toString()}`);
  if (!Array.isArray(roles) || !roles.length) {
    const error = new Error("ユーザー管理は管理者のみ利用できます。");
    error.status = 403;
    throw error;
  }
  return user;
}

async function listAuthUsers() {
  const users = [];
  const perPage = 200;
  for (let page = 1; page <= 50; page += 1) {
    const result = await supabaseRequest(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    const batch = Array.isArray(result) ? result : (result?.users || []);
    users.push(...batch);
    if (batch.length < perPage) break;
  }
  return users;
}

async function listManagedUsers() {
  const [authUsers, roles, internalAccess, partnerAccess] = await Promise.all([
    listAuthUsers(),
    supabaseRequest("/rest/v1/user_roles?select=user_id,role"),
    supabaseRequest("/rest/v1/internal_user_access?select=user_id,site_codes,active"),
    supabaseRequest("/rest/v1/partner_user_access?select=user_id,supplier_code,site_codes,active")
  ]);
  const roleMap = new Map((roles || []).map(row => [row.user_id, row.role]));
  const internalMap = new Map((internalAccess || []).map(row => [row.user_id, row]));
  const partnerMap = new Map();
  (partnerAccess || []).forEach(row => {
    const rows = partnerMap.get(row.user_id) || [];
    rows.push(row);
    partnerMap.set(row.user_id, rows);
  });
  return authUsers.map(user => {
    const role = roleMap.get(user.id) || "user";
    const internal = internalMap.get(user.id);
    const partners = partnerMap.get(user.id) || [];
    const accountType = internal || role === "admin" ? "internal" : partners.length ? "partner" : "unassigned";
    const partnerSites = [...new Set(partners.flatMap(row => row.site_codes || []))];
    const siteCodes = accountType === "internal" ? (internal?.site_codes || ["OSA", "TYO"]) : partnerSites;
    const active = accountType === "internal" ? (role === "admin" || internal?.active === true) : partners.some(row => row.active);
    return {
      id: user.id,
      email: user.email || "",
      displayName: user.user_metadata?.display_name || user.user_metadata?.name || "",
      role,
      accountType,
      siteCodes,
      supplierCodes: partners.map(row => row.supplier_code),
      active,
      createdAt: user.created_at || null,
      invitedAt: user.invited_at || null,
      lastSignInAt: user.last_sign_in_at || null
    };
  }).sort((a, b) => Number(b.active) - Number(a.active) || a.email.localeCompare(b.email, "ja"));
}

function normalizedAccess(payload) {
  const accountType = payload.accountType === "partner" ? "partner" : "internal";
  const active = payload.active !== false;
  const role = accountType === "internal" && active && payload.role === "admin" ? "admin" : "user";
  const siteCodes = [...new Set((Array.isArray(payload.siteCodes) ? payload.siteCodes : []).filter(code => code === "OSA" || code === "TYO"))];
  const supplierCode = String(payload.supplierCode || "").trim();
  if (!siteCodes.length) throw new Error("利用拠点を1つ以上選択してください。");
  if (accountType === "partner" && !supplierCode) throw new Error("外部作業者には発注先コードが必要です。");
  return { accountType, active, role, siteCodes, supplierCode };
}

async function upsertTable(table, body, onConflict) {
  const path = `/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  await supabaseRequest(path, { method: "POST", body, prefer: "resolution=merge-duplicates,return=minimal" });
}

async function deleteRows(table, filters) {
  const params = new URLSearchParams(filters);
  await supabaseRequest(`/rest/v1/${table}?${params.toString()}`, { method: "DELETE", prefer: "return=minimal" });
}

async function applyAccess(userId, payload, administratorId) {
  const access = normalizedAccess(payload);
  const existingRoleRows = await supabaseRequest(`/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  const existingRole = existingRoleRows?.[0]?.role || "user";
  if (userId === administratorId && (access.accountType !== "internal" || !access.active || access.role !== "admin")) {
    throw new Error("現在ログイン中の管理者自身は、権限変更や利用停止ができません。");
  }
  if (existingRole === "admin" && access.role !== "admin") {
    const adminRows = await supabaseRequest("/rest/v1/user_roles?select=user_id&role=eq.admin");
    if ((adminRows || []).length <= 1) throw new Error("最後の管理者は一般ユーザーへ変更できません。");
  }
  await upsertTable("user_roles", { user_id: userId, role: access.role }, "user_id");
  if (access.accountType === "internal") {
    await upsertTable("internal_user_access", { user_id: userId, site_codes: access.siteCodes, active: access.active }, "user_id");
    await deleteRows("partner_user_access", { user_id: `eq.${userId}` });
  } else {
    await deleteRows("internal_user_access", { user_id: `eq.${userId}` });
    await deleteRows("partner_user_access", { user_id: `eq.${userId}` });
    await upsertTable("partner_user_access", {
      user_id: userId,
      supplier_code: access.supplierCode,
      site_codes: access.siteCodes,
      active: access.active
    }, "user_id,supplier_code");
  }
  const displayName = String(payload.displayName || "").trim();
  await supabaseRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: { user_metadata: { display_name: displayName } }
  });
}

async function inviteUser(payload, administratorId) {
  const email = String(payload.email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("正しいメールアドレスを入力してください。");
  normalizedAccess(payload);
  const { appOrigin } = configuration();
  const invitedUser = await supabaseRequest("/auth/v1/invite", {
    method: "POST",
    body: {
      email,
      data: { display_name: String(payload.displayName || "").trim() },
      redirect_to: `${appOrigin}/order-entry-beta?setup=1`
    }
  });
  if (!invitedUser?.id) throw new Error("招待ユーザーを作成できませんでした。");
  await applyAccess(invitedUser.id, payload, administratorId);
  return invitedUser.id;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const administrator = await requireAdministrator(req);
    if (req.method === "GET") {
      sendJson(res, 200, { users: await listManagedUsers() });
      return;
    }
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (payload.action === "invite") {
      const userId = await inviteUser(payload, administrator.id);
      sendJson(res, 200, { ok: true, userId });
      return;
    }
    if (payload.action === "save") {
      const userId = String(payload.userId || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("対象ユーザーが正しくありません。");
      await applyAccess(userId, payload, administrator.id);
      sendJson(res, 200, { ok: true, userId });
      return;
    }
    sendJson(res, 400, { error: "操作内容が正しくありません。" });
  } catch (error) {
    const status = Number(error?.status) || (/Vercelに SUPABASE_SERVICE_ROLE_KEY/.test(String(error?.message || "")) ? 503 : 400);
    sendJson(res, status, { error: String(error?.message || error || "ユーザー管理処理に失敗しました。") });
  }
};
