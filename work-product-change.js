let workProductEdit=null;
let workProductBusy=false;
const workProductRetryKey="yumirume-work-product-retry-v1";
function workProductCell(row){
  return `<div class="work-product-cell"><span${row._stockout?' style="text-decoration:line-through"':''}>${esc(row.product_name)}</span><button type="button" class="work-product-edit" title="商品変更" aria-label="${esc(row.product_name)}の商品変更" onclick="event.stopPropagation();openWorkProductChange(${row._idx})" ${currentSessionLocked||currentSessionProvisionalLocked?'disabled':''}>変更</button></div>`;
}
function workProductMessage(message){document.getElementById("work-product-error").textContent=message}
function workProductValues(){
  return Object.fromEntries(["product_id","product_name","english_name","scientific_name","origin","unit_price"].map(key=>[key,document.getElementById("work-product-"+key).value.trim()]));
}
function workProductFill(data){
  for(const key of ["product_id","product_name","english_name","scientific_name","origin","unit_price"])document.getElementById("work-product-"+key).value=data[key]??"";
}
function workProductSetBusy(busy){
  workProductBusy=busy;
  const modal=document.getElementById("work-product-dialog");
  modal.querySelectorAll("input,button").forEach(el=>{el.disabled=busy||!!workProductEdit?.attempt&&el.tagName==="INPUT"});
  document.getElementById("work-product-save").textContent=busy?"保存中...":workProductEdit?.attempt?"保存結果を確認・再試行":"変更を保存";
}
function workProductCandidates(){
  const query=document.getElementById("work-product-product_id").value.normalize("NFKC").trim().toLowerCase();
  const found=query?Object.values(masterMap).filter(p=>`${p.product_id} ${p.product_name}`.normalize("NFKC").toLowerCase().includes(query)):[];
  document.getElementById("work-product-candidates").innerHTML=found.length<=10?found.map(p=>`<option value="${esc(p.product_id)}">${esc(p.product_name)}</option>`).join(""):"";
}
function workProductApplyCode(){
  if(!workProductEdit||workProductBusy)return;
  const code=document.getElementById("work-product-product_id").value.trim();
  if(code===workProductEdit.appliedCode)return;
  const master=masterMap[normalizeProductId(code)];
  if(code&&!master){workProductMessage("商品コードが未登録です。未登録商品はコードを空欄にしてください。");return}
  workProductEdit.appliedCode=master?.product_id||code;
  if(master){
    workProductFill({product_id:master.product_id,product_name:master.product_name,
      english_name:master.en_name,scientific_name:master.sci_name,origin:workOriginRomanize(master.origin||""),
      unit_price:resolveInitialUnitPrice("",master,workProductEdit.base.importer_code||workProductEdit.base.importer_id)});
  }else{
    for(const key of ["english_name","scientific_name","origin","unit_price"])document.getElementById("work-product-"+key).value="";
  }
  workProductMessage("");
}
async function openWorkProductChange(rowIdx){
  if(workProductBusy||!requireEditableTrial())return;
  if(!currentSessionId){toast("作業を保存してから変更してください");return}
  const sessionId=currentSessionId,row=rows.find(r=>r._idx===rowIdx);
  if(!row)return;
  const modal=document.getElementById("work-product-dialog");
  workProductEdit=null;
  modal.showModal();
  workProductSetBusy(true);workProductMessage("明細を読込中...");
  try{
    if(!(await requireSupabaseLogin()))throw new Error("ログインしてください。");
    const queue=orderLineSaveQueues.get(`${sessionId}:${rowIdx+1}`);
    if(queue&&await queue===false)throw new Error("入力内容の保存に失敗しています。先に保存を確認してください。");
    const {data:base,error}=await supabaseClient.from("order_lines").select("*").eq("session_id",sessionId).eq("source_row_no",rowIdx+1).single();
    if(error)throw error;
    let source=null;
    if(base.source_order_line_id){
      const result=await supabaseClient.from("order_entry_lines").select("id,updated_at,supplier_code,purchase_ordered").eq("id",base.source_order_line_id).single();
      if(result.error)throw result.error;
      source=result.data;
    }
    if(currentSessionId!==sessionId)throw new Error("作業が切り替わりました。開き直してください。");
    workProductEdit={sessionId,rowIdx,base,source,appliedCode:base.product_id||"",attempt:null};
    document.getElementById("work-product-context").textContent=`${base.store_name} / ${base.product_id||"未登録"} / ${base.product_name}`;
    document.getElementById("work-product-actuals").textContent=`数量 ${base.input_qty??"未入力"} ${base.input_unit||"Kg"} / NET ${base.net_weight??"未入力"} / 箱 ${base.box_no||"未入力"}`;
    workProductFill(base);workProductCandidates();
    const pending=JSON.parse(sessionStorage.getItem(workProductRetryKey)||"null");
    if(pending&&(pending.sessionId!==sessionId||pending.rowIdx!==rowIdx)){
      workProductEdit=null;
      throw new Error(`前回の商品変更が未確認です。作業 ${pending.sessionId} の明細 ${pending.rowIdx+1} を先に確認してください。`);
    }
    if(pending&&pending.sessionId===sessionId&&pending.rowIdx===rowIdx){
      workProductEdit.attempt=pending;
      workProductFill(pending.change);
      workProductMessage("前回の保存結果が未確認です。同じ内容で再確認します。");
    }else workProductMessage("");
    workProductEdit.initial=JSON.stringify(workProductValues());
  }catch(error){workProductMessage(error.message||String(error))}
  finally{workProductSetBusy(false);document.getElementById("work-product-save").disabled=!workProductEdit}
}
function closeWorkProductChange(){
  if(workProductBusy)return;
  if(workProductEdit&&!workProductEdit.attempt&&workProductEdit.initial!==JSON.stringify(workProductValues())&&!confirm("保存せずに閉じますか？"))return;
  document.getElementById("work-product-dialog").close();workProductEdit=null;
}
async function saveWorkProductChange(){
  if(workProductBusy||!workProductEdit)return;
  const edit=workProductEdit;
  if(edit.sessionId!==currentSessionId){workProductMessage("作業が切り替わりました。開き直してください。");return}
  if(!edit.attempt){
    if(!requireEditableTrial())return;
    const change=workProductValues(),price=numberOrNull(change.unit_price);
    if(change.product_id!==edit.appliedCode){workProductMessage("商品コードを候補から選択するか、未登録商品は空欄にしてください。");return}
    if(!change.product_name||change.unit_price&&(price===null||price<0)){
      workProductMessage("商品名と売価（0以上の数値）を確認してください。");return;
    }
    change.origin=workOriginRomanize(change.origin);
    change.unit_price=price;change.expected_source_updated_at=edit.source?.updated_at||null;
    if(!confirm(`「${edit.base.product_name}」を「${change.product_name}」へ変更します。数量・NET・箱番号は維持します。${edit.source?.purchase_ordered?'発注済みチェックは解除されます。':''}よろしいですか？`))return;
    edit.attempt={sessionId:edit.sessionId,rowIdx:edit.rowIdx,expectedUpdatedAt:edit.base.updated_at,requestId:crypto.randomUUID(),change};
    try{sessionStorage.setItem(workProductRetryKey,JSON.stringify(edit.attempt))}
    catch(error){edit.attempt=null;workProductMessage("再試行用データを保存できません。端末の保存設定を確認してください。");return}
  }
  workProductSetBusy(true);workProductMessage("");
  const attempt=edit.attempt;
  try{
    const {data,error}=await supabaseClient.rpc("change_work_order_product",{p_session_id:attempt.sessionId,p_source_row_no:attempt.rowIdx+1,
      p_expected_updated_at:attempt.expectedUpdatedAt,p_request_id:attempt.requestId,p_change:attempt.change});
    if(error){
      if(error.code&&/^(P\d|\d{2}|PGRST)/.test(error.code)){edit.attempt=null;sessionStorage.removeItem(workProductRetryKey)}
      if(error.code==="PGRST202"||error.code==="42883")throw new Error("商品変更用SQLが未反映です。work-product-change-migration.sql を実行してください。");
      throw error;
    }
    if(!data?.id||data.session_id!==attempt.sessionId||data.source_row_no!==attempt.rowIdx+1)throw new Error("保存結果が未確認です。同じ内容で再試行してください。");
    if(currentSessionId===attempt.sessionId){
      upsertRemoteOrderLine(data);
      buildP1Tabs();if(currentPhase===1.5)buildP15();if(currentPhase===2)buildP2();
    }
    sessionStorage.removeItem(workProductRetryKey);edit.attempt=null;
    document.getElementById("work-product-dialog").close();workProductEdit=null;
    setSaveState("Supabase: 商品変更保存済み");toast("商品を変更しました");
  }catch(error){workProductMessage(error.message||String(error));setSaveState("Supabase: 商品変更の保存未確認",true)}
  finally{workProductSetBusy(false)}
}
document.body.insertAdjacentHTML("beforeend",`<dialog id="work-product-dialog" class="work-product-dialog" aria-labelledby="work-product-title">
  <h2 id="work-product-title">商品変更</h2><div id="work-product-context"></div><div id="work-product-actuals"></div>
  <div class="work-product-fields">
    <label>商品コード<input id="work-product-product_id" list="work-product-candidates" autocomplete="off" oninput="workProductCandidates()" onchange="workProductApplyCode()"><datalist id="work-product-candidates"></datalist></label>
    <label>商品名<input id="work-product-product_name" lang="ja" autocomplete="off" maxlength="300"></label>
    <label>英名<input id="work-product-english_name" lang="en" autocomplete="off" maxlength="300"></label>
    <label>学術名<input id="work-product-scientific_name" lang="en" autocomplete="off" maxlength="300"></label>
    <label>産地<input id="work-product-origin" lang="en" autocapitalize="none" autocomplete="off" maxlength="200"></label>
    <label>売価<input id="work-product-unit_price" inputmode="decimal" autocomplete="off"></label>
  </div><div id="work-product-error" role="alert"></div>
  <div class="work-product-actions"><button type="button" class="btn" onclick="closeWorkProductChange()">キャンセル</button><button type="button" class="btn btn-primary" id="work-product-save" onclick="saveWorkProductChange()">変更を保存</button></div>
</dialog>`);
document.getElementById("work-product-dialog").addEventListener("cancel",event=>{event.preventDefault();closeWorkProductChange()});
document.getElementById("work-product-dialog").addEventListener("keydown",event=>{
  if(event.key!=="Enter"||event.isComposing||event.keyCode===229||event.target.tagName!=="INPUT")return;
  event.preventDefault();
  const fields=[...event.currentTarget.querySelectorAll("input,#work-product-save")].filter(el=>!el.disabled);
  fields[fields.indexOf(event.target)+1]?.focus();
});
window.addEventListener("beforeunload",event=>{
  if(workProductBusy||workProductEdit&&workProductEdit.initial!==JSON.stringify(workProductValues())){event.preventDefault();event.returnValue=""}
});
