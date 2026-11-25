const { AGENCY_IMPORTER, agencyProjects } = require("../server/agency-auth.cjs");
const DEFAULT_APP_ORIGIN = "https://hankan-tablet-app.vercel.app";
const COOKIE = "__Host-agency-sales";
const MAX_SESSION_SECONDS = 1800;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function settings() {
  const { source, auth } = agencyProjects();
  const origin = new URL(process.env.AGENCY_APP_ORIGIN || process.env.APP_ORIGIN || DEFAULT_APP_ORIGIN).origin;
  const sourceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const authKey = process.env.AGENCY_AUTH_SUPABASE_PUBLIC_KEY?.trim();
  if (!sourceKey || !authKey || sourceKey === authKey) {
    throw failure(503, "営業代行用の閲覧サービスは設定されていません。");
  }
  return { source, auth, origin, sourceKey, authKey };
}

function send(res, status, data, cookie) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.end(JSON.stringify(data));
}

function sessionCookie(token, seconds) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
}

function sessionToken(req) {
  const entry = String(req.headers.cookie || "").split(";")
    .map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  return entry?.slice(COOKIE.length + 1) || "";
}

async function authRequest(config, path, body, token) {
  return fetch(new URL(`/auth/v1/${path}`, config.auth), {
    method: body ? "POST" : "GET",
    headers: {
      apikey: config.authKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
}

async function authorize(config, token) {
  let claims;
  if (token.length <= 8192 && TOKEN.test(token)) {
    try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
    catch { /* Treat malformed tokens as unauthenticated. */ }
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims?.iss !== `${config.auth.origin}/auth/v1` || claims.role !== "authenticated"
      || claims.aud !== "authenticated" || !Number.isInteger(claims.exp) || claims.exp <= now) {
    throw failure(401, "ログインしてください。");
  }
  // Auth validates the signature and returns current metadata, not the token's cached permissions.
  const response = await authRequest(config, "user", null, token);
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw failure(401, "ログインしてください。");
  }
  if (!response.ok) throw failure(503, "ログインの確認ができませんでした。");
  const user = await response.json();
  if (!user.id || user.id !== claims.sub || !user.email_confirmed_at
      || user.app_metadata?.agency_sales_importer !== AGENCY_IMPORTER) {
    throw failure(403, "売上を閲覧する権限がありません。");
  }
  return Math.min(MAX_SESSION_SECONDS, claims.exp - now);
}

function dateNumber(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value) || value.startsWith("0000")) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

async function readSales(config, input) {
  const from = dateNumber(input.from), to = dateNumber(input.to), page = input.page;
  if (!Number.isFinite(to - from) || to < from || to - from > 366 * 86400000
      || !Number.isInteger(page) || page < 1 || page > 100000) {
    throw failure(400, "開始日・終了日を366日以内の間隔で指定してください。");
  }
  const { product = "", customer = "", site = "" } = input;
  if ([product, customer].some(value => typeof value !== "string" || value.length > 120 || value.includes("\0"))
      || !["", "OSA", "TYO"].includes(site)) {
    throw failure(400, "検索条件を確認してください。");
  }
  const response = await fetch(new URL("/rest/v1/rpc/agency_sales_07", config.source), {
    method: "POST",
    headers: {
      apikey: config.sourceKey,
      Authorization: `Bearer ${config.sourceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_from: input.from, p_to: input.to, p_page: page, p_product: product.trim(), p_customer: customer.trim(), p_site: site
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw failure(503, "売上を読み込めませんでした。");
  const { count, missingAmountCount, netSales, freight, rows } = await response.json();
  return {
    count, missingAmountCount, netSales, freight,
    rows: rows.map(({ kind, sale_date, site_code, customer_name, product_code, product_name, qty, unit, unit_price, amount }) =>
      ({ kind, sale_date, site_code, customer_name, product_code, product_name, qty, unit, unit_price, amount }))
  };
}

module.exports = async function handleAgencySales(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }
  try {
    const config = settings();
    if (req.headers.origin !== config.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
      throw failure(403, "この操作は許可されていません。");
    }
    let input;
    try { input = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { throw failure(400, "入力を確認してください。"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw failure(400, "入力を確認してください。");

    if (input.action === "logout") return send(res, 200, { ok: true }, sessionCookie("", 0));
    if (input.action === "request-code" || input.action === "verify-code") {
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw failure(400, "メールアドレスを確認してください。");
      }
      if (input.action === "request-code") {
        const response = await authRequest(config, "otp", { email, create_user: false });
        if (response.status === 429) throw failure(429, "少し時間をおいてから再送してください。");
        if (response.status >= 500) throw failure(503, "確認コードを送信できませんでした。");
        // Do not reveal whether this email address is registered.
        return send(res, 200, { ok: true });
      }
      if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code)) throw failure(400, "6桁の確認コードを入力してください。");
      const response = await authRequest(config, "verify", { email, token: input.code, type: "email" });
      if (response.status === 429) throw failure(429, "少し時間をおいてからお試しください。");
      if (response.status >= 500) throw failure(503, "ログインの確認ができませんでした。");
      if (!response.ok) throw failure(400, "確認コードが違うか、有効期限が切れています。");
      const { access_token: token } = await response.json();
      const life = await authorize(config, typeof token === "string" ? token : "");
      return send(res, 200, { ok: true }, sessionCookie(token, life));
    }
    if (input.action !== "list") throw failure(400, "入力を確認してください。");
    await authorize(config, sessionToken(req));
    return send(res, 200, await readSales(config, input));
  } catch (error) {
    const status = error.status || 503;
    const cookie = status === 401 ? sessionCookie("", 0) : undefined;
    return send(res, status, { error: error.status ? error.message : "閲覧サービスに接続できませんでした。" }, cookie);
  }
};
