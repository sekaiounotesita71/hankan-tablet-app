(() => {
  const byId = id => document.getElementById(id);
  const panel = byId("agency-users");
  if (!panel) return;
  const form = byId("agency-user-form");
  const email = byId("agency-user-email");
  const importer = byId("agency-user-importer");
  const list = byId("agency-user-list");
  const rows = byId("agency-user-rows");
  const status = byId("agency-user-status");
  let busy = false;
  let viewVersion = 0;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  window.resetAgencyUsers = () => {
    viewVersion += 1;
    panel.open = false;
    form.reset();
    rows.replaceChildren();
    list.hidden = true;
    message("");
  };

  function render(accounts) {
    const items = accounts.map(account => {
      const row = document.createElement("tr");
      if (!account.active) row.className = "inactive";
      for (const value of [account.email, account.importerCode || "—", account.active ? "有効" : "停止"]) {
        row.insertCell().textContent = value;
      }
      const control = document.createElement("button");
      control.type = "button";
      control.className = "small";
      control.textContent = account.active ? "停止" : "再割り当て";
      control.setAttribute("aria-label", `${account.email} の閲覧を${control.textContent}`);
      if (account.active) control.classList.add("danger");
      control.addEventListener("click", () => {
        if (account.active && !confirm(`${account.email} の売上閲覧を停止しますか？`)) return;
        run({
          action: account.active ? "agency-suspend" : "agency-assign",
          userId: account.id, importerCode: importer.value
        }, account.active ? "閲覧を停止しました。" : "輸入社07を割り当てました。");
      });
      row.insertCell().append(control);
      return row;
    });
    rows.replaceChildren(...items);
    list.hidden = !items.length;
  }

  async function run(payload, success) {
    if (busy || !currentUserIsAdmin()) return;
    busy = true;
    const version = viewVersion;
    const current = () => version === viewVersion && currentUserIsAdmin();
    const controls = [...panel.querySelectorAll("button, input, select")];
    controls.forEach(control => { control.disabled = true; });
    message("処理中…");
    try {
      if (payload) await userAdminApi("POST", payload);
      if (!current()) return;
      if (payload?.action === "agency-create") form.reset();
      const { users } = await userAdminApi("POST", { action: "agency-list" });
      if (!current()) return;
      render(users);
      message(success || (users.length ? `${users.length}名` : "登録済みの営業代行アカウントはありません。"));
    } catch (error) {
      if (current()) message(error.message, true);
    } finally {
      controls.forEach(control => { control.disabled = false; });
      busy = false;
    }
  }

  panel.addEventListener("toggle", () => { if (panel.open) run(); });
  byId("agency-user-refresh").addEventListener("click", () => run());
  form.addEventListener("submit", event => {
    event.preventDefault();
    run({ action: "agency-create", email: email.value, importerCode: importer.value }, "アカウントを発行しました。");
  });
})();
