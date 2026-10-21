let salesImporterFinalizationOpen=false;

function importerSalesCodeFinalized(value){
  const code=invoiceImporterCode(value);
  return !!code&&typeof currentSessionFinalizedImporters!=="undefined"&&
    Array.isArray(currentSessionFinalizedImporters)&&
    currentSessionFinalizedImporters.some(item=>invoiceImporterCode(item)===code);
}

function salesImporterFinalizationError(error){
  if(error?.code==="PGRST202"||error?.code==="42883")return "輸入社別の売上確定用SQLが未実行です。";
  if(error?.code==="40001")return "確認中にデータが変更されました。この画面を閉じて「売上確定」を開き直してください。";
  return String(error?.message||error||"売上確定できませんでした");
}

async function openSalesImporterFinalization(){
  if(salesImporterFinalizationOpen)return false;
  const sessionId=currentSessionId;
  if(!sessionId){alert("作業を保存してから売上確定してください。");return false}
  const activeCode=invoiceImporterCode(currentPhase===1?activeCountry:activeImporter);
  const sessionChanged=()=>currentSessionId!==sessionId;
  const checkSession=()=>{
    if(sessionChanged())throw new Error("作業が切り替わったため中止しました。");
  };
  const waitForSaves=async()=>{
    // Saves can enqueue successors while an earlier request is in flight.
    const waited=new Set();
    for(;;){
      checkSession();
      const saves=[...orderLineSaveQueues.values(),...boxSaveInFlight].filter(task=>!waited.has(task));
      if(!saves.length)return;
      saves.forEach(task=>waited.add(task));
      try{
        if((await Promise.all(saves)).some(result=>result===false))throw new Error("unsaved");
      }catch(error){throw new Error("未保存の明細・箱情報があります。保存状態を確認してから売上確定してください。")}
    }
  };
  salesImporterFinalizationOpen=true;
  try{
    await loadCurrentUserRoleTrial();
    await waitForSaves();
    const {data,error}=await supabaseClient.rpc("work_importer_finalization_preview",{p_session_id:sessionId});
    checkSession();
    if(error)throw error;
    if(!data?.session||!data.version||!Array.isArray(data.groups)||!data.groups.length){
      throw new Error("売上確定する明細を取得できませんでした。");
    }
    if(data.session.id&&data.session.id!==sessionId)throw new Error("作業の確認結果が一致しません。開き直してください。");
    if(data.session.locked||data.session.status==="closed"){
      setSessionLockStateTrial(data.session);toast("すでに売上確定済みです");return false;
    }
    if(data.session.finalized_at)throw new Error("確定済み作業の訂正には「売上再確定」を使用してください。");
    const pending=data.groups.map((group,i)=>group.finalized?null:i).filter(i=>i!==null);
    const defaultIndex=pending.find(i=>activeCode&&invoiceImporterCode(data.groups[i].importer_code)===activeCode)??
      (pending.length===1?pending[0]:-1);
    return await new Promise(resolve=>{
      let busy=false,success=false,invalid=false;
      const dialog=document.createElement("dialog");
      dialog.className="refinalize-dialog";dialog.id="sales-finalize-importers-dialog";
      dialog.setAttribute("aria-labelledby","sales-finalize-importers-title");
      dialog.innerHTML=`<div class="refinalize-head"><div><h2 id="sales-finalize-importers-title">売上確定</h2><span>${esc(data.session.name||"")} / ${esc(data.session.work_date||"")}</span></div><button type="button" data-close aria-label="閉じる">×</button></div><div class="refinalize-intro" data-summary role="status" aria-live="polite"></div><div class="refinalize-list">${data.groups.map((group,i)=>`<div class="refinalize-row"><input type="checkbox" id="sales-finalize-importer-${i}" data-importer-index="${i}" aria-label="${esc(group.importer_name||group.importer_code)}を選択" ${i===defaultIndex?"checked":""} ${group.finalized?"disabled":""}><label for="sales-finalize-importer-${i}"><strong>${esc(group.importer_name||group.importer_code)} <small>${esc(group.importer_code)}</small></strong><div>${Number(group.line_count)}明細 / 商品売上 ${Number(group.net_sales).toLocaleString("ja-JP")}円</div><span class="refinalize-state ${group.finalized?"":"changed"}">${group.finalized?"確定済み":"未確定"}${Number(group.incomplete)?` / 作業未完了 ${Number(group.incomplete)}件`:""}</span></label><label class="refinalize-shipping"><span>送料（円）</span><input type="number" inputmode="numeric" min="0" step="1" aria-label="${esc(group.importer_name||group.importer_code)}の送料" data-shipping-index="${i}" value="${esc(group.shipping??0)}"></label></div>`).join("")}</div><div class="refinalize-error" role="alert"></div><div class="refinalize-actions"><button type="button" data-close>中止</button><button type="button" data-submit>選択した輸入社を確定</button></div>`;
      document.body.append(dialog);
      const errorBox=dialog.querySelector(".refinalize-error");
      const selected=()=>[...dialog.querySelectorAll("[data-importer-index]:checked")]
        .map(el=>Number(el.dataset.importerIndex)).filter(i=>pending.includes(i));
      const incompleteCount=indexes=>indexes.reduce((sum,i)=>sum+Number(data.groups[i].incomplete||0),0);
      const incompleteMessage=count=>`未完了の明細が${count}件あります。売上確定には管理者の確認が必要です。`;
      const setControls=()=>{
        const indexes=selected(),incomplete=incompleteCount(indexes);
        dialog.querySelectorAll("[data-close]").forEach(el=>el.disabled=busy);
        dialog.querySelectorAll("[data-importer-index]").forEach(el=>{
          const finalized=!pending.includes(Number(el.dataset.importerIndex));
          if(finalized)el.checked=false;
          el.disabled=busy||invalid||finalized;
        });
        dialog.querySelectorAll("[data-shipping-index]").forEach(el=>{
          el.disabled=busy||invalid||!indexes.includes(Number(el.dataset.shippingIndex));
        });
        const submit=dialog.querySelector("[data-submit]");
        submit.disabled=busy||invalid||!indexes.length||(incomplete>0&&!currentUserIsAdmin());
        submit.textContent=busy?"売上確定中...":"選択した輸入社を確定";
        dialog.querySelector("[data-summary]").textContent=`未確定 ${pending.length}社 / 確定済み ${data.groups.length-pending.length}社 / 選択 ${indexes.length}社・${indexes.reduce((sum,i)=>sum+Number(data.groups[i].line_count),0)}明細 / 未完了 ${incomplete}件`;
      };
      const updateSelection=()=>{
        if(!busy&&!invalid){
          const incomplete=incompleteCount(selected());
          errorBox.textContent=incomplete&&!currentUserIsAdmin()?incompleteMessage(incomplete):"";
        }
        setControls();
      };
      dialog.addEventListener("change",updateSelection);
      dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault()});
      dialog.addEventListener("close",()=>{dialog.remove();resolve(success)},{once:true});
      dialog.addEventListener("click",async event=>{
        if(event.target.closest("[data-close]")){if(!busy)dialog.close();return}
        if(!event.target.closest("[data-submit]")||busy||invalid)return;
        if(sessionChanged()){
          invalid=true;errorBox.textContent="作業が切り替わったため中止しました。";setControls();return;
        }
        const indexes=selected();if(!indexes.length)return;
        const fees={};
        for(const i of indexes){
          const input=dialog.querySelector(`[data-shipping-index="${i}"]`),fee=Number(input.value);
          if(input.value.trim()===""||!Number.isSafeInteger(fee)||fee<0){
            errorBox.textContent="送料は0以上の整数で入力してください。";input.focus();return;
          }
          fees[data.groups[i].importer_code]=fee;
        }
        const incomplete=incompleteCount(indexes);
        if(incomplete&&!currentUserIsAdmin()){
          errorBox.textContent=incompleteMessage(incomplete);setControls();return;
        }
        busy=true;setControls();errorBox.textContent="";
        try{
          if(incomplete&&!confirm(`未完了の明細が${incomplete}件あります。選択した輸入社を売上確定しますか？`))return;
          await waitForSaves();
          checkSession();
          if(incomplete&&!currentUserIsAdmin())throw new Error(incompleteMessage(incomplete));
          const {data:result,error:saveError}=await supabaseClient.rpc("finalize_work_session_importers",{
            p_session_id:sessionId,
            p_importer_codes:indexes.map(i=>data.groups[i].importer_code),
            p_shipping_fees:fees,
            p_expected_version:data.version,
            p_allow_incomplete:incomplete>0
          });
          if(saveError)throw saveError;
          if(!result?.session||!Array.isArray(result.pending_importers)||(result.session.id&&result.session.id!==sessionId)){
            invalid=true;
            throw new Error("結果を確認できませんでした。作業一覧から最新状態を確認してください。");
          }
          success=true;
          const remaining=result.pending_importers.length;
          const message=`${indexes.length}社・${Number(result.saved_rows)||0}明細を売上確定しました${remaining?` / 未確定 ${remaining}社`:""}`;
          if(!sessionChanged()){
            setSessionLockStateTrial(result.session);
            setSaveState(remaining?`Supabase: 選択分を売上確定 / 未確定 ${remaining}社`:"Supabase: 売上確定・請求候補反映済み");
            toast(message);
          }else toast(`作業「${data.session.name||sessionId}」: ${message}`);
          dialog.close();
        }catch(saveError){
          if(success||saveError?.code==="40001"||sessionChanged())invalid=true;
          errorBox.textContent=success?"売上確定は完了しましたが、画面の更新に失敗しました。作業一覧から最新状態を確認してください。":
            sessionChanged()?"作業が切り替わったため中止しました。":salesImporterFinalizationError(saveError);
        }finally{busy=false;if(dialog.isConnected)setControls()}
      });
      updateSelection();
      try{dialog.showModal()}catch(error){dialog.remove();throw error}
    });
  }catch(error){
    alert(salesImporterFinalizationError(error));return false;
  }finally{salesImporterFinalizationOpen=false}
}
