(function(){
  "use strict";
  const table="supplier_work_profiles",fields=SupplierWorkProfile.fields;
  const panelIds=["master-core-editor","statement-profile-master","payable-profile-master","invoice-export-master","audit-admin-view"];
  const limits={cargo_location:400,cargo_cut_time:100,document_cut_time:100,document_method:600,packing_note:1200,destination_name:200,contact:200};
  let profiles=[],loaded=null,busy=false,loadVersion=0;
  const el=id=>document.getElementById(id),value=id=>el(id)?.value?.trim()||"";
  const identity=row=>JSON.stringify(SupplierWorkProfile.scopeFields.map(field=>row[field]||""));
  function state(message,error=false){const node=el("work-profile-state");if(node){node.textContent=message;node.style.color=error?"var(--danger)":""}}
  function db(){if(!supabaseClient||!currentUser)throw new Error("ログインしてから作業依頼書設定を読み込んでください。");return supabaseClient}
  function errorText(error){
    const message=String(error?.message||error);
    return ["42P01","PGRST205"].includes(error?.code)||/could not find.*supplier_work_profiles|relation.*supplier_work_profiles.*does not exist/i.test(message)
      ?"作業依頼書設定用SQLが未実行です。supplier-work-profile-migration.sql を実行してください。":message;
  }
  async function read(){
    const client=db(),result=[];
    for(let from=0;;from+=1000){
      const {data,error}=await client.from(table).select("*").order("site_code").order("importer_code").order("supplier_code").range(from,from+999);
      if(error)throw new Error(errorText(error));result.push(...(data||[]));if((data||[]).length<1000)return result;
    }
  }
  function scope(){return {site_code:value("work-profile-site"),importer_code:value("work-profile-importer"),supplier_code:value("work-profile-supplier")}}
  function scopeName(row){
    const masters=getMasters(),name=(items,code)=>[code,items.find(item=>String(item.code)===code)?.name].filter(Boolean).join(" ");
    return [row.site_code?({OSA:"大阪",TYO:"東京"}[row.site_code]):"全拠点",row.importer_code?name(masters.importers||[],row.importer_code):"全輸入社",row.supplier_code?name(masters.suppliers||[],row.supplier_code):"全問屋"].join(" / ");
  }
  function fill(profile){
    loaded=profile?{...profile}:null;
    for(const field of SupplierWorkProfile.scopeFields)el({site_code:"work-profile-site",importer_code:"work-profile-importer",supplier_code:"work-profile-supplier"}[field]).value=profile?.[field]||"";
    for(const field of Object.keys(fields))el("work-profile-"+field).value=profile?.[field]||"";
    el("work-profile-delete").disabled=!loaded||!currentUserIsAdmin();
  }
  function chooser(){
    const selected=loaded?identity(loaded):"";
    el("work-profile-select").innerHTML='<option value="">新規設定</option>'+profiles.map((p,i)=>`<option value="${i}"${identity(p)===selected?" selected":""}>${esc(scopeName(p))}</option>`).join("");
  }
  async function refresh(){
    const version=++loadVersion;state("設定を読み込み中...");
    try{const rows=await read();if(version!==loadVersion)return;profiles=rows;chooser();state(`${rows.length}件登録済み`)}catch(error){if(version===loadVersion)state(errorText(error),true)}
  }
  function form(){
    const host=el("work-report-profile-master");if(host.dataset.ready)return;host.dataset.ready="1";
    host.innerHTML=`<div class="work-profile-form">
      <label class="full">登録済み設定<select id="work-profile-select" onchange="SupplierWorkProfilesApp.select(this.value)"><option value="">新規設定</option></select></label>
      <label>拠点<select id="work-profile-site"><option value="">全拠点</option><option value="OSA">大阪</option><option value="TYO">東京</option></select></label>
      <label>輸入社コード（空欄＝共通）<input id="work-profile-importer" list="importer-code-list" autocomplete="off"></label>
      <label>問屋コード（空欄＝共通）<input id="work-profile-supplier" list="supplier-code-list" autocomplete="off"></label>
      ${Object.entries(fields).map(([field,label])=>`<label class="${["cargo_location","document_method","packing_note"].includes(field)?"full":""}">${label}<textarea id="work-profile-${field}" maxlength="${limits[field]}" rows="${field==="packing_note"?3:2}"></textarea></label>`).join("")}
      </div><div class="actions"><button class="btn primary" type="button" id="work-profile-save" onclick="SupplierWorkProfilesApp.save()">設定を保存</button><button class="btn" type="button" onclick="SupplierWorkProfilesApp.reload()">再読込</button><button class="btn" type="button" id="work-profile-delete" onclick="SupplierWorkProfilesApp.remove()" disabled>設定を削除</button><span id="work-profile-state" role="status"></span></div>
      <p class="hint">空欄の項目は共通設定を引き継ぎます。指定なしにする場合は「なし」と入力してください。</p>`;
  }
  function setBusy(on){busy=on;el("work-report-profile-master").querySelectorAll("input,select,textarea,button").forEach(node=>node.disabled=on);if(!on){el("work-profile-save").disabled=!currentUserIsAdmin();el("work-profile-delete").disabled=!loaded||!currentUserIsAdmin()}}
  function changed(){if(!el("work-profile-site"))return false;const current={...scope(),...Object.fromEntries(Object.keys(fields).map(field=>[field,value("work-profile-"+field)]))};return identity(current)!==identity(loaded||{})||Object.keys(fields).some(field=>current[field]!==String(loaded?.[field]||""))}
  async function show(){
    masterView="work-report";panelIds.forEach(id=>el(id)?.classList.add("master-view-hidden"));form();updateMasterTabState();setBusy(busy);await refresh();
  }
  function select(index){
    if(busy)return;if(changed()&&!confirm("保存していない設定を破棄しますか？")){chooser();return}
    fill(index===""?null:profiles[Number(index)]);state(loaded?scopeName(loaded):"新規設定");
  }
  async function save(){
    if(busy)return;if(!currentUserIsAdmin()){alert("作業依頼書設定を変更できるのは管理者のみです。");return}
    const payload={...scope(),...Object.fromEntries(Object.keys(fields).map(field=>[field,value("work-profile-"+field)]))};
    for(const [field,type] of [["importer_code","importers"],["supplier_code","suppliers"]]){
      if(!payload[field])continue;
      const master=(getMasters()[type]||[]).find(item=>String(item.code).normalize("NFKC").toUpperCase()===payload[field].normalize("NFKC").toUpperCase());
      if(!master){alert(`${field==="importer_code"?"輸入社":"問屋"}コードをマスタから選択してください。`);return}payload[field]=String(master.code);
    }
    if(Object.entries(limits).some(([field,max])=>payload[field].length>max)){alert("入力が長すぎます。");return}
    const same=loaded&&identity(loaded)===identity(payload);
    if(!same&&profiles.some(row=>identity(row)===identity(payload))){alert("同じ条件の設定が登録済みです。登録済み設定から選択して修正してください。");return}
    if(!confirm(`${scopeName(payload)} の作業依頼書設定を保存しますか？`))return;
    setBusy(true);state("保存中...");
    try{
      let query=same?db().from(table).update(payload).eq("updated_at",loaded.updated_at):db().from(table).insert(payload);
      if(same)for(const field of SupplierWorkProfile.scopeFields)query=query.eq(field,loaded[field]);
      const {data,error}=await query.select("*").maybeSingle();if(error)throw error;if(!data)throw new Error("他の担当者が設定を更新しました。再読込して確認してください。");
      fill(data);profiles=profiles.filter(row=>identity(row)!==identity(data));profiles.push(data);chooser();state("DBへ保存しました。次回のPDF・Excel出力に反映されます。");
    }catch(error){state(errorText(error),true)}finally{setBusy(false)}
  }
  async function remove(){
    if(busy||!loaded||!currentUserIsAdmin())return;if(!confirm(`${scopeName(loaded)} の設定を削除しますか？ 共通設定がある場合はそちらを使用します。`))return;
    setBusy(true);
    try{let query=db().from(table).delete().eq("updated_at",loaded.updated_at);for(const field of SupplierWorkProfile.scopeFields)query=query.eq(field,loaded[field]);const {data,error}=await query.select("*").maybeSingle();if(error)throw error;if(!data)throw new Error("設定が更新されています。再読込してください。");profiles=profiles.filter(row=>identity(row)!==identity(loaded));fill(null);chooser();state("削除しました。")}catch(error){state(errorText(error),true)}finally{setBusy(false)}
  }
  window.SupplierWorkProfilesApp={read,show,save,remove,select,async reload(){if(busy)return;if(changed()&&!confirm("保存していない設定を破棄して再読込しますか？"))return;fill(null);await refresh()},open(){switchWorkspaceTab("masters");show()}};
  window.addEventListener("beforeunload",event=>{if(changed()){event.preventDefault();event.returnValue=""}});
})();
