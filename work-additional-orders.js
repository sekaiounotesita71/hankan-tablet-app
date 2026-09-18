// Keep field additions on the same order-source path as normal order entry.
let workAdditionalBusy=false;
let workAdditionalMasters={importers:[],customers:[],suppliers:[]};
let workAdditionalSession="";
let workAdditionalCustomers=[];
let workAdditionalProduct="";
let workAdditionalAutoSupplier="";
let workAdditionalAttempt=null;
const workAdditionalStorageKey="yumirume-work-additional-pending-v1";
function workAdditionalError(error){
  if(error?.code==="PGRST202"||error?.code==="42883")return "追加注文用SQLが未反映です。work-additional-order-migration.sql を実行してください。";
  return String(error?.message||error||"保存できませんでした。");
}
function workAdditionalSetBusy(busy){
  workAdditionalBusy=busy;
  const modal=document.getElementById("manual-order-bg");
  modal.querySelectorAll("input,select,button").forEach(el=>{el.disabled=busy});
  if(workAdditionalAttempt)modal.querySelectorAll("input,select").forEach(el=>{el.disabled=true});
  const button=document.getElementById("manual-save");
  if(button)button.textContent=busy?"保存中...":workAdditionalAttempt?"保存結果を確認・再試行":"追加する";
}
function workAdditionalMessage(message){document.getElementById("manual-error").textContent=message}
function workAdditionalProductOptions(){
  const q=manualValue("manual-product-id").normalize("NFKC").toLowerCase();
  const candidates=q?Object.values(masterMap).filter(p=>`${p.product_id} ${p.product_name}`.normalize("NFKC").toLowerCase().includes(q)):[];
  document.getElementById("manual-products").innerHTML=candidates.length<=10?candidates.map(p=>`<option value="${esc(p.product_id)}">${esc(p.product_name)}</option>`).join(""):"";
}
async function workAdditionalApplyProduct(){
  const code=manualValue("manual-product-id");
  if(code===workAdditionalProduct)return;
  const supplierInput=document.getElementById("manual-supplier");
  if(workAdditionalAutoSupplier&&supplierInput.value===workAdditionalAutoSupplier){
    supplierInput.value="";workAdditionalSupplierName();
  }
  workAdditionalAutoSupplier="";
  workAdditionalProduct=code;
  const product=masterMap[normalizeProductId(code)];
  if(!product)return;
  document.getElementById("manual-product-name").value=product.product_name||"";
  document.getElementById("manual-origin").value=workOriginRomanize(product.origin||"");
  document.getElementById("manual-price").value=resolveInitialUnitPrice("",product,manualValue("manual-importer"));
  if(!supplierInput.value.trim()){
    const {data,error}=await supabaseClient.from("product_master").select("default_supplier_code").eq("product_id",product.product_id).maybeSingle();
    if(!error&&!workAdditionalBusy&&code===manualValue("manual-product-id")&&!supplierInput.value.trim()){
      const match=workAdditionalMasters.suppliers.find(s=>s.supplier_code===data?.default_supplier_code);
      if(match){supplierInput.value=match.supplier_code;workAdditionalAutoSupplier=match.supplier_code}
      workAdditionalSupplierName();
    }
  }
}
function workAdditionalSupplierName(){
  const code=manualValue("manual-supplier");
  const supplier=workAdditionalMasters.suppliers.find(s=>s.supplier_code===code);
  document.getElementById("manual-supplier-name").textContent=supplier?.supplier_name||"";
}
function workAdditionalCustomerOptions(selectedName=""){
  const importer=manualValue("manual-importer");
  workAdditionalCustomers=workAdditionalMasters.customers.filter(c=>c.importer_code===importer&&c.site_code===currentSessionSiteCode)
    .map(c=>({id:c.id,code:c.customer_code||"",name:c.customer_name}));
  const currentNames=[...new Set(rows.filter(r=>importerCode(r.importer_id)===importer).map(r=>r.customer))];
  currentNames.forEach(name=>{
    if(!workAdditionalCustomers.some(c=>c.name===name))workAdditionalCustomers.push({id:"",code:"",name});
  });
  const select=document.getElementById("manual-customer");
  select.innerHTML='<option value="">選択してください</option>'+workAdditionalCustomers.map((c,i)=>`<option value="${i}">${esc([c.code,c.name].filter(Boolean).join(" / "))}</option>`).join("");
  const matches=workAdditionalCustomers.map((c,i)=>c.name===selectedName?i:-1).filter(i=>i>=0);
  if(matches.length===1)select.value=String(matches[0]);
}
async function openManualOrderModal(){
  if(workAdditionalBusy)return;
  if(!requireEditableTrial())return;
  if(!currentSessionId||!rows.length){toast("作業を名前を付けて保存してから追加してください");return}
  if(!(await requireSupabaseLogin()))return;
  const sessionId=currentSessionId;
  const modal=document.getElementById("manual-order-bg");
  const form=modal.querySelector(".manual-form");
  form.innerHTML=`<div class="wide manual-context">${esc(currentSessionWorkDate)} / ${currentSessionSiteCode==="TYO"?"東京":"大阪"}</div>
    <label>輸入社<select id="manual-importer" onchange="workAdditionalCustomerOptions()"></select></label>
    <label>得意先<select id="manual-customer"></select></label>
    <label>商品コード<input id="manual-product-id" list="manual-products" autocomplete="off" oninput="workAdditionalProductOptions()" onchange="workAdditionalApplyProduct()" placeholder="未登録商品は空欄"><datalist id="manual-products"></datalist></label>
    <label>商品名<input id="manual-product-name" lang="ja" autocomplete="off"></label>
    <label>発注先コード<input id="manual-supplier" list="manual-suppliers" autocomplete="off" oninput="workAdditionalAutoSupplier='';workAdditionalSupplierName()"><span id="manual-supplier-name"></span><datalist id="manual-suppliers"></datalist></label>
    <label>注文数量<input id="manual-qty" inputmode="decimal" autocomplete="off"></label>
    <label>注文単位<input id="manual-unit" list="manual-units" autocomplete="off"><datalist id="manual-units">${["Kg","pkt","PC","CS","本","尾","枚","個","箱"].map(u=>`<option value="${u}"></option>`).join("")}</datalist></label>
    <label>産地<input id="manual-origin" lang="en" autocapitalize="none" autocomplete="off"></label>
    <label>売価<input id="manual-price" inputmode="decimal" autocomplete="off"></label>
    <label>備考<input id="manual-memo" lang="ja" autocomplete="off"></label>
    <div class="wide manual-error" id="manual-error" role="alert"></div>`;
  modal.querySelector(".manual-actions").innerHTML='<button class="btn" onclick="closeManualOrderModal()">キャンセル</button><button class="btn btn-primary" id="manual-save" onclick="addManualOrder()">追加する</button>';
  modal.classList.add("open");
  workAdditionalAttempt=null;
  workAdditionalSetBusy(true);
  workAdditionalMessage("マスタを読込中...");
  try{
    const [importers,customers,suppliers]=await Promise.all([
      readAllWorkRows((a,b)=>supabaseClient.from("importer_master").select("importer_code,importer_name").eq("is_active",true).order("importer_code").range(a,b)),
      readAllWorkRows((a,b)=>supabaseClient.from("customer_master").select("id,customer_code,customer_name,importer_code,site_code").eq("active",true).eq("site_code",currentSessionSiteCode).order("id").range(a,b)),
      readAllWorkRows((a,b)=>supabaseClient.from("supplier_master").select("supplier_code,supplier_name").eq("is_active",true).order("supplier_code").range(a,b))
    ]);
    if(currentSessionId!==sessionId)throw new Error("作業が切り替わりました。開き直してください。");
    workAdditionalSession=sessionId;
    workAdditionalMasters={importers,customers,suppliers};
    document.getElementById("manual-importer").innerHTML='<option value="">選択してください</option>'+importers.map(i=>`<option value="${esc(i.importer_code)}">${esc(i.importer_code)} / ${esc(i.importer_name)}</option>`).join("");
    document.getElementById("manual-suppliers").innerHTML=suppliers.map(s=>`<option value="${esc(s.supplier_code)}">${esc(s.supplier_name)}</option>`).join("");
    const importer=activeCountry||activeImporter||getCountries()[0]||"";
    document.getElementById("manual-importer").value=importers.some(i=>i.importer_code===importer)?importer:"";
    workAdditionalCustomerOptions(activeCustomer[importer]||"");
    workAdditionalProduct="";
    workAdditionalAutoSupplier="";
    const pending=JSON.parse(sessionStorage.getItem(workAdditionalStorageKey)||"null");
    if(pending?.sessionId===sessionId){
      workAdditionalAttempt=pending;
      const data=pending.order;
      document.getElementById("manual-importer").value=data.importer_code;
      workAdditionalCustomerOptions(data.customer_name);
      const match=workAdditionalCustomers.findIndex(c=>c.name===data.customer_name&&c.id===(data.customer_id||""));
      if(match>=0)document.getElementById("manual-customer").value=String(match);
      for(const [id,key] of Object.entries({"product-id":"product_code","product-name":"product_name",supplier:"supplier_code",qty:"order_qty",unit:"order_unit",origin:"origin",price:"unit_price",memo:"memo"}))document.getElementById("manual-"+id).value=data[key]??"";
      workAdditionalSupplierName();
      workAdditionalMessage("前回の保存結果が未確認です。同じ内容で再確認します。");
    }else workAdditionalMessage("");
  }catch(error){workAdditionalMessage(workAdditionalError(error));workAdditionalSession=""}
  finally{workAdditionalSetBusy(false)}
}
function closeManualOrderModal(){
  if(workAdditionalBusy)return;
  document.getElementById("manual-order-bg").classList.remove("open");
}
async function addManualOrder(){
  if(workAdditionalBusy||(!workAdditionalAttempt&&!requireEditableTrial()))return;
  if(workAdditionalSession!==currentSessionId){workAdditionalMessage("作業を確認して開き直してください。");return}
  if(!workAdditionalAttempt){
    const supplier=workAdditionalMasters.suppliers.find(s=>s.supplier_code===manualValue("manual-supplier"));
    const customerValue=manualValue("manual-customer");
    const customer=customerValue===""?null:workAdditionalCustomers[customerValue];
    const qty=numberOrNull(manualValue("manual-qty")),priceText=manualValue("manual-price"),price=numberOrNull(priceText);
    if(!supplier||!customer||!manualValue("manual-product-name")||!manualValue("manual-unit")||!(qty>0)){
      workAdditionalMessage("得意先・商品名・発注先・注文数量・注文単位を確認してください。");return;
    }
    if(priceText&&(price===null||price<0)){workAdditionalMessage("売価は0以上の数値で入力してください。");return}
    const code=manualValue("manual-product-id"),master=masterMap[normalizeProductId(code)]||{};
    const order={importer_code:manualValue("manual-importer"),customer_id:customer.id,customer_name:customer.name,
      product_code:code,product_name:manualValue("manual-product-name"),supplier_code:supplier.supplier_code,
      order_qty:qty,order_unit:manualValue("manual-unit"),origin:workOriginRomanize(manualValue("manual-origin")),
      unit_price:price,english_name:master.en_name||"",scientific_name:master.sci_name||"",memo:manualValue("manual-memo")};
    workAdditionalAttempt={sessionId:currentSessionId,requestId:crypto.randomUUID(),order};
    try{sessionStorage.setItem(workAdditionalStorageKey,JSON.stringify(workAdditionalAttempt))}
    catch(error){workAdditionalAttempt=null;workAdditionalMessage("再試行用データを保持できません。端末の保存設定を確認してください。");return}
  }
  const attempt=workAdditionalAttempt;
  workAdditionalSetBusy(true);workAdditionalMessage("");
  try{
    const {data,error}=await supabaseClient.rpc("save_work_additional_order",{p_session_id:attempt.sessionId,p_request_id:attempt.requestId,p_order:attempt.order});
    if(error){
      // Structured DB rejections roll back the transaction; transport errors remain retry-only.
      if(error.code&&/^(P\d|\d{2}|PGRST)/.test(error.code)){workAdditionalAttempt=null;sessionStorage.removeItem(workAdditionalStorageKey)}
      throw error;
    }
    if(!data?.id||data.source_order_line_id!==attempt.requestId)throw new Error("保存結果を確認できません。同じ内容で再試行してください。");
    if(currentSessionId===attempt.sessionId){
      upsertRemoteOrderLine(data);
      const row=rows.find(r=>r._sourceOrderLineId===attempt.requestId)||orderLineToLocalRow(data);
      syncOrderRowsFromRows();
      activeCountry=row.country;activeCustomer[row.country]=row.customer;
      buildP1Tabs();p1SwitchCountry(row.country);p1SwitchCustomer(row.country,row.customer);
      if(currentPhase===1.5)buildP15();
      if(currentPhase===2)buildP2();
    }
    sessionStorage.removeItem(workAdditionalStorageKey);workAdditionalAttempt=null;
    document.getElementById("manual-order-bg").classList.remove("open");
    setSaveState("Supabase: 追加注文保存済み");toast("発注先を含めて追加注文を保存しました");
  }catch(error){workAdditionalMessage(workAdditionalError(error));setSaveState("Supabase: 追加注文の保存未確認",true)}
  finally{workAdditionalSetBusy(false)}
}
document.getElementById("manual-order-bg").addEventListener("keydown",event=>{
  if(event.key!=="Enter"||event.isComposing||event.keyCode===229||event.target.tagName==="BUTTON")return;
  event.preventDefault();
  const fields=[...event.currentTarget.querySelectorAll("input,select,#manual-save")].filter(el=>!el.disabled);
  const next=fields[fields.indexOf(event.target)+1];
  next?.focus();
});
