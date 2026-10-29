function salesRefinalizeError(error){
  if(error?.code==="PGRST202"||error?.code==="42883")return "再確定用SQLが未実行です。sales-refinalize-importers-migration.sql を実行してください。";
  if(error?.code==="40001")return "確認中にデータが変更されました。この画面を閉じて「売上再確定」を開き直してください。";
  return String(error?.message||error||"再確定できませんでした");
}
async function openSalesRefinalization(){
  await loadCurrentUserRoleTrial();
  if(!currentUserIsAdmin()){alert("売上の再確定は管理者のみ可能です。");return false}
  const sessionId=currentSessionId;
  const saves=[...orderLineSaveQueues.values(),...boxSaveInFlight];
  try{
    if((await Promise.all(saves)).some(result=>result===false))throw new Error("未保存の明細があります。");
  }catch(saveError){alert("未保存の明細があります。保存状態を確認してから再確定してください。");return false}
  const reopened=typeof currentSessionReopenedImporters!=="undefined"&&currentSessionReopenedImporters.length>0;
  const {data,error}=await supabaseClient.rpc(reopened?"work_reopened_importer_preview":"work_refinalization_preview",{p_session_id:sessionId});
  if(error){alert(salesRefinalizeError(error));return false}
  if(currentSessionId!==sessionId){alert("作業が切り替わったため中止しました。");return false}
  if(data?.session?.locked){setSessionLockStateTrial(data.session);toast("すでに売上確定済みです");return false}
  if(!data?.version||!Array.isArray(data.groups)||!data.groups.length){alert("再確定する明細を取得できませんでした。");return false}
  const eligible=data.groups.map((group,i)=>!reopened||group.reopened?i:-1).filter(i=>i>=0);
  if(!eligible.length){alert("再確定する輸入社がありません。最新状態を読み込んでください。");return false}
  return new Promise(resolve=>{
    let busy=false,success=false,invalid=false;
    const dialog=document.createElement("dialog");dialog.className="refinalize-dialog";dialog.id="sales-refinalize-dialog";
    dialog.setAttribute("aria-labelledby","refinalize-title");
    dialog.innerHTML=`<div class="refinalize-head"><div><h2 id="refinalize-title">売上再確定</h2><span>${esc(data.session.name)} / ${esc(data.session.work_date)}</span></div><button type="button" data-close aria-label="閉じる">×</button></div><div class="refinalize-list">${data.groups.map((group,i)=>`<label class="refinalize-row"><input type="checkbox" data-importer-index="${i}" ${eligible.includes(i)&&group.changed?"checked":""} ${eligible.includes(i)?"":"disabled"}><div><strong>${esc(group.importer_name)} <small>${esc(group.importer_code)}</small></strong><div>${Number(group.line_count)}明細 / 商品売上 ${Number(group.net_sales).toLocaleString("ja-JP")}円</div><span class="refinalize-state ${group.changed?"changed":""}">${reopened?(group.reopened?"訂正中":group.finalized?"確定済み":"未確定"):group.changed?"訂正・未反映あり":"前回確定と一致"}${Number(group.incomplete)?` / 作業未完了 ${Number(group.incomplete)}件`:""}${group.domestic?" / 国内連動":""}</span></div><div class="refinalize-shipping"><span>送料（円）</span><input type="number" inputmode="numeric" min="0" step="1" aria-label="${esc(group.importer_name)}の送料" data-shipping-index="${i}" value="${Number(group.shipping)||0}"></div></label>`).join("")}</div><div class="refinalize-error" role="alert"></div><div class="refinalize-actions"><button type="button" data-close>中止</button><button type="button" data-submit>選択した輸入社を再確定</button></div>`;
    document.body.append(dialog);
    const selected=()=>[...dialog.querySelectorAll("[data-importer-index]:checked")].map(el=>Number(el.dataset.importerIndex)).filter(i=>eligible.includes(i));
    const setControls=()=>{
      dialog.querySelectorAll("button,input").forEach(el=>el.disabled=busy);
      dialog.querySelectorAll("[data-importer-index]").forEach(el=>{
        if(!eligible.includes(Number(el.dataset.importerIndex))){el.disabled=true;el.checked=false}
        else el.disabled=busy||invalid;
      });
      dialog.querySelectorAll("[data-shipping-index]").forEach(el=>{el.disabled=busy||!selected().includes(Number(el.dataset.shippingIndex))});
      const submit=dialog.querySelector("[data-submit]");submit.disabled=busy||invalid||!selected().length;submit.textContent=busy?"再確定中...":"選択した輸入社を再確定";
    };
    dialog.addEventListener("change",setControls);
    dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault()});
    dialog.addEventListener("close",()=>{dialog.remove();resolve(success)},{once:true});
    dialog.addEventListener("click",async event=>{
      if(event.target.closest("[data-close]")){if(!busy)dialog.close();return}
      if(!event.target.closest("[data-submit]")||busy)return;
      if(invalid||success)return;
      const indexes=selected();if(!indexes.length)return;
      const fees={};
      for(const i of indexes){
        const input=dialog.querySelector(`[data-shipping-index="${i}"]`),fee=Number(input.value);
        if(input.value.trim()===""||!Number.isSafeInteger(fee)||fee<0){dialog.querySelector(".refinalize-error").textContent="送料は0以上の整数で入力してください。";input.focus();return}
        fees[data.groups[i].importer_code]=fee;
      }
      const incomplete=indexes.reduce((sum,i)=>sum+Number(data.groups[i].incomplete||0),0);
      if(incomplete&&!confirm(`未完了の明細が${incomplete}件あります。選択した輸入社を再確定しますか？`))return;
      busy=true;setControls();dialog.querySelector(".refinalize-error").textContent="";
      try{
        if(currentSessionId!==sessionId)throw new Error("作業が切り替わったため中止しました。");
        const {data:result,error:saveError}=await supabaseClient.rpc("refinalize_work_session_importers",{p_session_id:sessionId,p_importer_codes:indexes.map(i=>data.groups[i].importer_code),p_shipping_fees:fees,p_expected_version:data.version});
        if(saveError)throw saveError;
        if(!result?.session||(result.session.id&&result.session.id!==sessionId)||!Array.isArray(result.pending_importers)){
          invalid=true;throw new Error("結果を確認できませんでした。作業一覧から最新状態を確認してください。");
        }
        success=true;
        if(currentSessionId===sessionId)setSessionLockStateTrial(result.session);
        const pending=result.pending_importers||[];
        setSaveState(pending.length?"Supabase: 選択分を再確定 / 他の輸入社に訂正あり":"Supabase: 売上再確定・請求候補反映済み");
        if(pending.length)alert(`選択した輸入社を再確定しました。\n残りの未確定・訂正対象: ${pending.join(" / ")}`);
        else toast("売上・請求候補を更新し、再確定しました");
        dialog.close();
      }catch(saveError){
        if(success||saveError?.code==="40001"||currentSessionId!==sessionId)invalid=true;
        dialog.querySelector(".refinalize-error").textContent=success?"再確定は完了しましたが、画面の更新に失敗しました。作業一覧から最新状態を確認してください。":salesRefinalizeError(saveError);
      }finally{busy=false;if(dialog.isConnected)setControls()}
    });
    setControls();dialog.showModal();
  });
}
