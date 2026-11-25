(() => {
  const byId = id => document.getElementById(id);
  const yen = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 });
  const dayParts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const { year, month, day } = Object.fromEntries(dayParts.map(part => [part.type, part.value]));
  const labels = { freight: "送料", freight_adjustment: "送料調整", adjustment: "売上調整" };
  const sites = { OSA: "大阪", TYO: "東京" };
  const filterIds = ["from", "to", "product", "customer", "site"];
  let pendingEmail = "", busy = false, applied = null;
  byId("from").value = `${year}-${month}-01`;
  byId("to").value = `${year}-${month}-${day}`;

  function notice(text, error = false) {
    byId("notice").textContent = text;
    byId("notice").classList.toggle("error", error);
  }

  function resultVisibility(visible) {
    for (const id of ["totals", "results"]) byId(id).hidden = !visible;
    if (!visible) for (const id of ["rows", "net", "freight", "total", "page-counter"]) byId(id).replaceChildren();
  }

  function view(signedIn) {
    byId("login").hidden = signedIn;
    byId("sales").hidden = !signedIn;
    byId("logout").hidden = !signedIn;
    if (!signedIn) {
      applied = null;
      resultVisibility(false);
    }
  }

  async function api(action, fields = {}) {
    const response = await fetch("/api/agency-sales", {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...fields })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || "接続できませんでした。"), { status: response.status });
    return result;
  }

  async function run(action, { initial = false } = {}) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll("button")].filter(button => !button.disabled);
    controls.forEach(button => { button.disabled = true; });
    try {
      await action();
    } catch (error) {
      if (initial || error.status === 401 || error.status === 403) view(false);
      notice(initial && error.status === 401 ? "" : error.message, !initial || error.status !== 401);
    } finally {
      controls.forEach(button => { button.disabled = false; });
      byId("prev").disabled = !applied || applied.page <= 1;
      byId("next").disabled = !applied || applied.page >= applied.pages;
      busy = false;
    }
  }

  function money(value) {
    return value == null ? "—" : `${yen.format(value)} 円`;
  }

  function showSales(result, period, page) {
    const rows = result.rows.map(row => {
      const tr = document.createElement("tr");
      const label = labels[row.kind];
      const product = label && row.product_name ? `${label}：${row.product_name}` : label || row.product_name;
      for (const [index, value] of [
        row.sale_date, sites[row.site_code], row.customer_name, product,
        row.qty == null ? null : yen.format(row.qty), row.unit, money(row.unit_price), money(row.amount)
      ].entries()) {
        const td = tr.insertCell();
        td.textContent = value || "—";
        if ([4, 6, 7].includes(index)) td.className = "numeric";
        if (index === 3 && row.product_code) {
          const code = document.createElement("small");
          code.className = "product-code";
          code.textContent = row.product_code;
          td.append(code);
        }
      }
      return tr;
    });
    byId("rows").replaceChildren(...rows);
    byId("net").textContent = money(result.netSales);
    const detailFiltered = Boolean(period.product || period.customer);
    byId("freight").textContent = detailFiltered ? "対象外" : money(result.freight);
    byId("total").textContent = money(Number(result.netSales) + Number(result.freight));
    applied = { ...period, page, pages: Math.max(1, Math.ceil(result.count / 100)) };
    byId("page-counter").textContent = `${page} / ${applied.pages}`;
    view(true);
    resultVisibility(true);
    byId("results").hidden = !rows.length;
    const incomplete = result.missingAmountCount ? `（金額未設定 ${result.missingAmountCount}件は合計対象外）` : "";
    notice(result.count ? `${period.from} ～ ${period.to} ・ ${result.count}件${incomplete}` : "この期間の確定売上はありません。");
  }

  const inputPeriod = () => Object.fromEntries(filterIds.map(id => [id, byId(id).value.trim()]));
  async function load(period, page = 1) {
    resultVisibility(false);
    notice("売上を読み込み中…");
    const result = await api("list", { ...period, page });
    const lastPage = Math.max(1, Math.ceil(result.count / 100));
    if (page > lastPage) {
      showSales(await api("list", { ...period, page: lastPage }), period, lastPage);
    } else {
      showSales(result, period, page);
    }
  }

  byId("period").addEventListener("submit", event => {
    event.preventDefault();
    run(() => load(inputPeriod()));
  });
  for (const [id, delta] of [["prev", -1], ["next", 1]]) {
    byId(id).addEventListener("click", () => run(() => {
      const { page, pages, ...period } = applied;
      for (const id of filterIds) byId(id).value = period[id];
      return load(period, page + delta);
    }));
  }
  byId("email").addEventListener("input", () => {
    pendingEmail = "";
    byId("code-form").hidden = true;
    byId("code").value = "";
  });
  byId("email-form").addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      const email = byId("email").value.trim();
      await api("request-code", { email });
      if (byId("email").value.trim() !== email) return;
      pendingEmail = email;
      byId("code-form").hidden = false;
      byId("code").focus();
      notice("登録済みのメールアドレスに確認コードを送信しました。");
    });
  });
  byId("code-form").addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      await api("verify-code", { email: pendingEmail, code: byId("code").value });
      byId("code").value = "";
      byId("code-form").hidden = true;
      view(true);
      await load(inputPeriod());
    });
  });
  byId("logout").addEventListener("click", () => run(async () => {
    await api("logout");
    view(false);
    notice("ログアウトしました。");
  }));
  run(() => load(inputPeriod()), { initial: true });
})();
