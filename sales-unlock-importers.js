let salesImporterUnlockBusy=false;

function salesImporterUnlockError(error){
  if(error?.code==="PGRST202"||error?.code==="42883")return "輸入社別の解除用SQLが未実行です。sales-unlock-importers-migration.sql を実行してください。";
  if(error?.code==="40001")return "確認中にデータが変更されました。この画面を閉じて「ロック解除」を開き直してください。";
  return String(error?.message||error||"解除できませんでした");
}

async function openSalesImporterUnlock(){
  if(salesImporterUnlockBusy||salesFinalizeInProgress)return false;
  const sessionId=currentSessionId;
  if(!sessionId)return false;
  const checkSession=()=>{if(currentSessionId!==sessionId)throw new Error("作業が切り替わったため中止しました。")};
  const waitForSaves=async()=>{
    const waited=new Set();
    for(;;){
      checkSession();
      const saves=[...orderLineSaveQueues.values(),...boxSaveInFlight].filter(task=>!waited.has(task));
      if(!saves.length)return;
      saves.forEach(task=>waited.add(task));
      if((await Promise.all(saves)).some(result=>result===false))throw new Error("未保存の明細・箱情報があります。保存状態を確認してください。");
    }
  };
  salesImporterUnlockBusy=true;
  updateLockUITrial();
  try{
    await loadCurrentUserRoleTrial();
    checkSession();
    if(!currentUserIsAdmin())throw new Error("売上確定の解除は管理者のみ可能です。");
    await waitForSaves();
    const {data,error}=await supabaseClient.rpc("work_importer_finalization_preview",{p_session_id:sessionId});
    checkSession();
    if(error)throw error;
    if(!data?.version||data.session?.id!==sessionId||!Array.isArray(data.groups))throw new Error("作業の確認結果を取得できませんでした。開き直してください。");
    if(!Array.isArray(data.session.reopened_importer_codes))throw new Error("輸入社別の解除用SQLが未実行です。sales-unlock-importers-migration.sql を実行してください。");
    const eligible=data.groups.map((group,i)=>group.finalized?i:-1).filter(i=>i>=0);
    if(!eligible.length){setSessionLockStateTrial(data.session);toast("解除する確定済み輸入社がありません");return false}
    const activeCode=invoiceImporterCode(currentPhase===1?activeCountry:activeImporter);
    const defaultIndex=eligible.find(i=>activeCode&&invoiceImporterCode(data.groups[i].importer_code)===activeCode)??(eligible.length===1?eligible[0]:-1);
    return await new Promise(resolve=>{
      let busy=false,success=false,invalid=false;
      const dialog=document.createElement("dialog");
      dialog.id="sales-unlock-importers-dialog";dialog.className="refinalize-dialog";
      dialog.setAttribute("aria-labelledby","sales-unlock-importers-title");
      dialog.innerHTML=`<div class="refinalize-head"><div><h2 id="sales-unlock-importers-title">売上確定の解除</h2><span>${esc(data.session.name)} / ${esc(data.session.work_date)}</span></div><button type="button" data-close aria-label="閉じる">×</button></div><div class="refinalize-list">${data.groups.map((group,i)=>`<label class="refinalize-row"><input type="checkbox" data-importer-index="${i}" aria-label="${esc(group.importer_name||group.importer_code)}を解除対象に選択" ${i===defaultIndex?"checked":""} ${eligible.includes(i)?"":"disabled"}><div><strong>${esc(group.importer_name||group.importer_code)} <small>${esc(group.importer_code)}</small></strong><div>${Number(group.line_count)}明細</div><span class="refinalize-state">${group.finalized?"確定済み":data.session.reopened_importer_codes.includes(group.importer_code)?"訂正中":"未確定"}</span></div></label>`).join("")}</div><div class="refinalize-intro"><label for="sales-unlock-reason">解除理由</label><input id="sales-unlock-reason" type="text" data-reason autocomplete="off" aria-label="解除理由" placeholder="解除理由（4文字以上）" style="display:block;width:100%;min-height:44px;margin-top:6px"></div><div class="refinalize-error" role="alert"></div><div class="refinalize-actions"><button type="button" data-close>中止</button><button type="button" data-submit>選択した輸入社を解除</button></div>`;
      document.body.append(dialog);
      const errorBox=dialog.querySelector(".refinalize-error");
      const selected=()=>[...dialog.querySelectorAll("[data-importer-index]:checked")].map(el=>Number(el.dataset.importerIndex)).filter(i=>eligible.includes(i));
      const setControls=()=>{
        dialog.querySelectorAll("[data-close],[data-reason]").forEach(el=>el.disabled=busy);
        dialog.querySelectorAll("[data-importer-index]").forEach(el=>{
          if(!eligible.includes(Number(el.dataset.importerIndex)))el.checked=false;
          el.disabled=busy||invalid||!eligible.includes(Number(el.dataset.importerIndex));
        });
        const submit=dialog.querySelector("[data-submit]");
        submit.disabled=busy||invalid||!selected().length;
        submit.textContent=busy?"解除中...":"選択した輸入社を解除";
      };
      dialog.addEventListener("change",setControls);
      dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault()});
      dialog.addEventListener("close",()=>{dialog.remove();resolve(success)},{once:true});
      dialog.addEventListener("click",async event=>{
        if(event.target.closest("[data-close]")){if(!busy)dialog.close();return}
        if(!event.target.closest("[data-submit]")||busy||invalid)return;
        const indexes=selected();if(!indexes.length)return;
        const reason=dialog.querySelector("[data-reason]").value.trim();
        if(reason.length<4){errorBox.textContent="解除理由を4文字以上で入力してください。";dialog.querySelector("[data-reason]").focus();return}
        busy=true;setControls();errorBox.textContent="";
        try{
          await waitForSaves();checkSession();
          if(!currentUserIsAdmin())throw new Error("売上確定の解除は管理者のみ可能です。");
          const codes=indexes.map(i=>data.groups[i].importer_code);
          const {data:result,error:saveError}=await supabaseClient.rpc("unlock_work_session_importers",{
            p_session_id:sessionId,p_importer_codes:codes,p_reason:reason,p_expected_version:data.version
          });
          if(saveError)throw saveError;
          if(result?.session?.id!==sessionId||!Array.isArray(result.session.reopened_importer_codes)
            ||codes.some(code=>!result.session.reopened_importer_codes.includes(code))){
            invalid=true;throw new Error("結果を確認できませんでした。作業一覧から最新状態を確認してください。");
          }
          success=true;
          if(currentSessionId===sessionId){
            setSessionLockStateTrial(result.session);
            setSaveState(`Supabase: ${codes.join(" / ")} の確定を解除`);
          }
          toast(`${data.session.name}: ${codes.join(" / ")} の確定を解除しました`);
          dialog.close();
        }catch(saveError){
          if(success||saveError?.code==="40001"||currentSessionId!==sessionId)invalid=true;
          errorBox.textContent=success?"解除は完了しましたが、画面の更新に失敗しました。作業一覧から最新状態を確認してください。":salesImporterUnlockError(saveError);
        }finally{busy=false;if(dialog.isConnected)setControls()}
      });
      setControls();
      try{dialog.showModal()}catch(error){dialog.remove();throw error}
    });
  }catch(error){alert(salesImporterUnlockError(error));return false}
  finally{salesImporterUnlockBusy=false;updateLockUITrial()}
}
