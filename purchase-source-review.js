let purchaseSourceReviewOpen=false;
function reviewUnassignedPurchaseSources(sales,orderSupplierBySale){
  return new Promise(resolve=>{
    let busy=false;
    purchaseSourceReviewOpen=true;
    const dialog=document.createElement("dialog");
    dialog.className="purchase-source-dialog";
    dialog.setAttribute("aria-label","発注先未設定の売上明細");
    const records=sales.map(sale=>({sale,id:crypto.randomUUID(),saved:false,request:null}));
    dialog.innerHTML=`<div class="purchase-source-head"><h2>発注先未設定 ${sales.length}件</h2><button type="button" data-cancel aria-label="閉じる">×</button></div>
      <div class="purchase-source-scroll"><table><thead><tr><th>日付 / 得意先</th><th>商品コード / 商品名</th><th>実績数量</th><th>発注先コード</th><th></th></tr></thead><tbody>${records.map((r,i)=>`<tr data-source-row="${i}"><td>${esc(salesRefRowDate(r.sale))}<br>${esc(r.sale.store_name)}</td><td>${esc(r.sale.product_id)}<br>${esc(r.sale.product_name)}</td><td>${esc(r.sale.input_qty)} ${esc(r.sale.input_unit)}</td><td><input aria-label="${esc(r.sale.product_name)}の発注先" data-supplier="${i}" list="supplier-code-list" autocomplete="off"><span data-supplier-name="${i}"></span></td><td><button type="button" data-save="${i}">登録</button><span data-result="${i}" role="status"></span></td></tr>`).join("")}</tbody></table></div>
      <div class="purchase-source-error" role="alert"></div><div class="purchase-source-actions"><button type="button" data-cancel>引用を中止</button><button type="button" data-continue>設定済みの明細だけ引用</button></div>`;
    document.body.append(dialog);
    const finish=value=>{purchaseSourceReviewOpen=false;dialog.close();dialog.remove();resolve(value)};
    dialog.addEventListener("cancel",event=>{event.preventDefault();if(!busy)finish(false)});
    dialog.addEventListener("input",event=>{
      const index=event.target.dataset.supplier;
      if(index===undefined)return;
      const supplier=lookupSupplierByCode(event.target.value.trim());
      dialog.querySelector(`[data-supplier-name="${index}"]`).textContent=supplier?.name||"";
    });
    dialog.addEventListener("keydown",event=>{
      if(event.key!=="Enter"||event.isComposing||event.keyCode===229)return;
      const index=event.target.dataset.supplier;
      if(index!==undefined){event.preventDefault();dialog.querySelector(`[data-save="${index}"]`).focus()}
    });
    dialog.addEventListener("click",async event=>{
      if(busy)return;
      if(event.target.closest("[data-cancel]")){finish(false);return}
      if(event.target.closest("[data-continue]")){
        const remaining=records.filter(r=>!r.saved).length;
        if(remaining&&!confirm(`発注先未設定の${remaining}件は引用されません。設定済みの明細だけ続けますか？`))return;
        finish(true);return;
      }
      const button=event.target.closest("[data-save]");if(!button)return;
      const index=Number(button.dataset.save),record=records[index];
      const input=dialog.querySelector(`[data-supplier="${index}"]`);
      const supplier=lookupSupplierByCode(input.value.trim());
      const errorBox=dialog.querySelector(".purchase-source-error");
      if(!supplier){errorBox.textContent="仕入先マスタに登録済みの発注先を選択してください。";input.focus();return}
      busy=true;errorBox.textContent="";
      dialog.querySelectorAll("button,input").forEach(el=>{el.disabled=true});
      button.textContent="保存中...";
      try{
        if(!record.request){
          const {data,error}=await supabaseClient.from("order_lines").select("id,updated_at").eq("session_id",record.sale.session_id).eq("source_row_no",record.sale.source_row_no).maybeSingle();
          if(error)throw error;
          if(!data)throw new Error("元の作業明細がありません。発注入力から確認してください。");
          record.request={supplier_code:supplier.code,expected_id:data.id,expected_updated_at:data.updated_at};
        }
        const {data,error}=await supabaseClient.rpc("save_work_additional_order",{
          p_session_id:record.sale.session_id,p_request_id:record.id,p_order:record.request,p_existing_source_row_no:Number(record.sale.source_row_no)
        });
        if(error){
          if(error.code&&/^(P\d|\d{2}|PGRST)/.test(error.code))record.request=null;
          throw error;
        }
        if(!data?.source_order_line_id)throw new Error("保存結果を確認できません。同じ内容で再試行してください。");
        record.saved=true;
        orderSupplierBySale.set(advancePurchaseSaleSourceKey(record.sale),record.request.supplier_code);
        dialog.querySelector(`[data-result="${index}"]`).textContent="登録済み";
        if(records.every(r=>r.saved))dialog.querySelector("[data-continue]").textContent="仕入引用へ進む";
      }catch(error){
        errorBox.textContent=error?.code==="PGRST202"||error?.code==="42883"
          ?"追加注文用SQLが未反映です。work-additional-order-migration.sql を実行してください。":String(error?.message||error);
      }finally{
        busy=false;
        dialog.querySelectorAll("button,input").forEach(el=>{el.disabled=false});
        records.forEach((r,i)=>{
          dialog.querySelector(`[data-supplier="${i}"]`).disabled=r.saved||!!r.request;
          const save=dialog.querySelector(`[data-save="${i}"]`);save.disabled=r.saved;
          save.textContent=r.saved?"登録済み":r.request?"再確認":"登録";
        });
      }
    });
    dialog.showModal();
  });
}
