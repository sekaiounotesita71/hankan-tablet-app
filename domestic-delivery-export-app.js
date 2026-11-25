(function(root){
  "use strict";
  const core=()=>root.DomesticDeliveryExport;
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const memory=new Map();
  let opening=false;
  const fieldLabels={orderNo:"先方受注番号",cartonNo:"提出用箱番号",customerName:"得意先（店舗名）",spec:"規格・数量"};
  function importerRules(importerCode){
    const code=String(importerCode??"").normalize("NFKC").trim();
    return{importerCode:code,prefix:code==="10"?"JNX/No,Y":"",orderLabel:code==="10"?"J NEXT様の\nオーダー番号":"先方受注番号"};
  }
  const settingsKey=(code,importerCode)=>`domestic-delivery-export-v2:${encodeURIComponent(importerCode)}:${encodeURIComponent(code)}`;
  function preferences(code,importerCode=""){
    const rules=importerRules(importerCode),key=settingsKey(code,rules.importerCode);
    let value=memory.get(key);
    if(!value)try{value=JSON.parse(localStorage.getItem(key)||"null")}catch(_){}
    const known=core().columns.map(c=>c.key);
    const valid=Array.isArray(value?.columns)&&value.columns.length&&new Set(value.columns).size===value.columns.length&&value.columns.every(k=>known.includes(k));
    const columns=valid?[...value.columns]:[...core().defaultColumns8];
    if((!valid||![2,3,4].includes(value?.version))&&!columns.includes("customerName"))columns.splice(columns.indexOf("orderNo")+1,0,"customerName");
    const jnext=rules.importerCode==="10";
    if(jnext&&(!valid||value?.version!==4)){
      const carton=columns.indexOf("cartonNo"),customer=columns.indexOf("customerName");
      if(carton>=0&&customer>carton)[columns[carton],columns[customer]]=[columns[customer],columns[carton]];
      if(!columns.includes("weight")){
        const price=columns.indexOf("unitPrice");
        columns.splice(price<0?columns.length:price,0,"weight");
      }
      if(!columns.includes("remarks"))columns.push("remarks");
    }
    return{version:jnext?4:2,columns,prefix:rules.prefix?String(value?.prefix??rules.prefix).slice(0,100):"",orderLabel:String(value?.orderLabel??rules.orderLabel).slice(0,120)};
  }
  function remember(code,importerCode,value){
    const key=settingsKey(code,importerCode);
    memory.set(key,value);
    try{localStorage.setItem(key,JSON.stringify(value))}catch(_){}
  }
  async function load(saleId){
    const sale=await domesticSaleForDocument(saleId);
    if(sale.status!=="confirmed")throw new Error("確定済みの国内売上を選択してください。");
    const ids=[...new Set(sale.lines.map(l=>l.source_sales_record_id).filter(Boolean))],sources=[];
    for(let start=0;start<ids.length;start+=100){
      const part=ids.slice(start,start+100);
      sources.push(...await fetchPaged(()=>supabaseClient.from("sales_records").select("id,session_id,importer_code,store_name,external_order_no,box_no,origin,net_weight,ordered_qty,ordered_unit,input_qty,input_unit").in("id",part).order("id")));
    }
    const rows=core().makeRows(sale,sources);
    const schemaReady=sale.lines.every(l=>Object.prototype.hasOwnProperty.call(l,"delivery_export_revision"));
    return{sale,rows,schemaReady};
  }
  function normalizeCartons(rows,prefix){
    if(!prefix)return rows.map(row=>({...row}));
    return rows.map(row=>{
      const value=String(row.cartonNo??"").trim();
      if(/^\d+$/.test(value))return{...row,cartonNo:core().cartonNumber(value,prefix)};
      if(value===String(row.sourceCartonNo??"")&&!value.startsWith(prefix))return{...row,cartonNo:""};
      return{...row};
    });
  }
  function validateCartons(rows,prefix){
    const bySource=new Map(),byDisplay=new Map();
    for(const row of rows){
      const value=String(row.cartonNo||"");
      if(prefix&&(!value.startsWith(prefix)||!/^\d+$/.test(value.slice(prefix.length))))throw new Error(`${row.lineNo}行目の提出用箱番号を確認してください。`);
      const source=String(row.sourceCartonNo||"");
      if(!source)continue;
      if(bySource.has(source)&&bySource.get(source)!==value)throw new Error(`現場箱番号 ${source} の提出用箱番号が複数あります。`);
      if(byDisplay.has(value)&&byDisplay.get(value)!==source)throw new Error(`提出用箱番号 ${value} が異なる現場箱に重複しています。`);
      bySource.set(source,value);byDisplay.set(value,source);
    }
  }
  function metadataRows(rows){
    return rows.map(r=>({id:r.id,expected_revision:r.revision,external_order_no:String(r.orderNo??"").trim(),delivery_carton_no:String(r.cartonNo??"").trim(),delivery_spec:String(r.spec??"").trim(),delivery_customer_name:String(r.customerName??"").trim()}));
  }
  function sameMetadata(rows,expected){
    const map=new Map(rows.map(r=>[r.id,r]));
    return rows.length===expected.length&&map.size===rows.length&&expected.every(r=>{const actual=map.get(r.id);return actual&&["orderNo","cartonNo","spec","customerName"].every(k=>String(actual[k]??"").trim()===String(r[k]??"").trim())});
  }
  function download(blob,name){
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function errorText(error){
    const message=String(error?.message||error);
    if(/Delivery metadata changed|40001/.test(message)||error?.code==="40001")return "他の端末または売上訂正で明細が更新されました。開き直して確認してください。";
    const missing=message.match(/^Row (\d+) (orderNo|cartonNo|customerName) is required/);
    if(missing)return `${missing[1]}行目の${fieldLabels[missing[2]]}を入力してください。`;
    const tooLong=message.match(/^Row (\d+) (orderNo|cartonNo|customerName|spec) exceeds (\d+) characters/);
    if(tooLong)return `${tooLong[1]}行目の${fieldLabels[tooLong[2]]}は${tooLong[3]}文字以内で入力してください。`;
    return /external_order_no|delivery_export_revision|save_domestic_delivery_metadata|schema cache|PGRST202|PGRST204/i.test(message)?"納品書データ用SQLが未反映です。delivery-export-migration.sql を確認してください。":message;
  }
  async function open(saleId){
    if(opening||document.getElementById("dde-dialog"))return;
    opening=true;
    let state;
    try{state=await load(saleId)}catch(error){showToast(errorText(error),true);return}finally{opening=false}
    const rules=importerRules(state.sale.source_importer_code);
    const prefs=preferences(state.sale.customer_code,rules.importerCode),focusBefore=document.activeElement;
    const jnext=rules.importerCode==="10";
    const outputLabels=()=>({orderNo:prefs.orderLabel,...(jnext?{weight:"NET重量 (kg)"}:{})});
    const outputOptions=()=>({labels:outputLabels(),sortByOrderNumber:jnext});
    let rows=normalizeCartons(state.rows,prefs.prefix),busy=false,dirty=false,appliedPrefix=prefs.prefix;
    const dialog=document.createElement("dialog");dialog.id="dde-dialog";dialog.className="dde-dialog";
    dialog.setAttribute("aria-labelledby","dde-title");
    dialog.innerHTML=`<header class="dde-head"><div><h2 id="dde-title">納品書データ</h2><span>${esc(state.sale.sale_date)} / ${esc(state.sale.sale_no)} / ${esc(state.sale.customer_name_snapshot)}</span></div><button type="button" data-action="close" class="dde-icon" aria-label="閉じる" title="閉じる">&times;</button></header><div class="dde-body"><div class="dde-settings">${rules.prefix?`<label>箱番号の固定表記<input data-setting="prefix" maxlength="100" value="${esc(prefs.prefix)}"></label>`:""}<label>受注番号の列名<textarea data-setting="orderLabel" maxlength="120" rows="2">${esc(prefs.orderLabel)}</textarea></label></div><details class="dde-columns"><summary>出力列</summary><div id="dde-column-list"></div></details><div id="dde-lines"></div><details class="dde-preview"><summary>出力プレビュー</summary><div id="dde-preview-table"></div></details></div><footer class="dde-foot"><span id="dde-status" role="status">${state.schemaReady?`${rows.length}明細`:'専用SQL未反映・保存不可'}</span><div><button type="button" data-action="save">保存</button><button type="button" data-action="excel">Excel出力</button><button type="button" data-action="csv">CSV出力</button></div></footer>`;
    document.body.append(dialog);
    const status=dialog.querySelector("#dde-status");
    function markDirty(){dirty=true;status.textContent="未保存"}
    function renderColumns(){
      const order=[...prefs.columns,...core().columns.map(c=>c.key).filter(k=>!prefs.columns.includes(k))];
      const labels=outputLabels();
      dialog.querySelector("#dde-column-list").innerHTML=order.map(key=>{const col=core().columns.find(c=>c.key===key),i=prefs.columns.indexOf(key),label=(labels[key]??col.label).replace(/\n/g," ");return`<div class="dde-column"><label><input type="checkbox" data-column="${key}" ${i>=0?"checked":""}>${esc(label)}</label><span><button type="button" class="dde-icon" data-move="-1" data-key="${key}" ${i<=0?"disabled":""} title="上へ" aria-label="${esc(label)}を上へ">&#8593;</button><button type="button" class="dde-icon" data-move="1" data-key="${key}" ${i<0||i===prefs.columns.length-1?"disabled":""} title="下へ" aria-label="${esc(label)}を下へ">&#8595;</button></span></div>`}).join("");
    }
    function renderPreview(){
      try{
        const matrix=core().sheetRows(rows,prefs.columns,outputOptions());
        dialog.querySelector("#dde-preview-table").innerHTML=`<table><thead><tr>${matrix[0].map(v=>`<th>${esc(v)}</th>`).join("")}</tr></thead><tbody>${matrix.slice(1).map(line=>`<tr>${line.map(v=>`<td${typeof v==="number"?' class="dde-number"':""}>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      }catch(error){dialog.querySelector("#dde-preview-table").textContent=error.message}
    }
    function renderLines(){
      dialog.querySelector("#dde-lines").innerHTML=rows.map((r,index)=>`<section class="dde-line" data-index="${index}"><div class="dde-product"><b>${esc(r.lineNo)}. ${esc(r.productName)}</b><span>現場箱 ${esc(r.sourceCartonNo||"未設定")} / 商品重量 ${esc(r.weight)}${r.weight===""?"":"kg"} / 単価 ${esc(r.unitPrice)}円 / 金額 ${esc(r.amount)}円</span></div><div class="dde-fields"><label>先方受注番号<input data-field="orderNo" maxlength="120" value="${esc(r.orderNo)}"></label><label>提出用箱番号<input data-field="cartonNo" maxlength="120" value="${esc(r.cartonNo)}"></label><label>規格・数量<input data-field="spec" maxlength="300" value="${esc(r.spec)}"></label><label>得意先（店舗名）<textarea data-field="customerName" maxlength="300" rows="2">${esc(r.customerName)}</textarea></label></div></section>`).join("");
      renderPreview();
    }
    function invalidField(error){
      const message=String(error?.message||error);
      const match=message.match(/^Row (\d+) (orderNo|cartonNo|customerName|spec) /);
      if(!match)return null;
      const input=dialog.querySelector(`[data-index="${Number(match[1])-1}"] [data-field="${match[2]}"]`);
      input?.setAttribute("aria-invalid","true");
      return input;
    }
    function pendingClose(){
      if(busy)return;
      if(dirty&&!confirm("未保存の変更があります。閉じますか？"))return;
      dialog.close();
    }
    function setBusy(value){busy=value;dialog.querySelectorAll("input,textarea,button").forEach(el=>el.disabled=value);if(!value)renderColumns()}
    async function saveAndExport(kind){
      if(busy)return;
      setBusy(true);status.textContent="保存中...";
      let invalidInput=null;
      try{
        if(!state.schemaReady)throw new Error("delivery_export_revision が未反映です");
        if((rules.prefix&&!prefs.prefix.trim())||!prefs.orderLabel.trim()||!prefs.columns.length)throw new Error("固定表記・列名・出力列を確認してください。");
        rows=rows.map(r=>({...r,cartonNo:prefs.prefix&&/^\d+$/.test(String(r.cartonNo).trim())?core().cartonNumber(String(r.cartonNo).trim(),prefs.prefix):String(r.cartonNo).trim()}));
        core().validateRows(rows,{requireOrderNumber:kind!=="save",requireCarton:kind!=="save",requireCustomer:kind!=="save"});
        if(kind!=="save"){
          validateCartons(rows,prefs.prefix);
          if(jnext)DomesticDocuments.validateSale(state.sale);
        }
        const expected=rows.map(r=>({...r}));
        const {error}=await supabaseClient.rpc("save_domestic_delivery_metadata",{p_sale_id:state.sale.id,p_lines:metadataRows(rows)});
        if(error)throw error;
        state=await load(saleId);
        if(!sameMetadata(state.rows,expected))throw new Error("保存後の明細が変わりました。出力は中止しました。開き直して確認してください。");
        rows=state.rows;dirty=false;remember(state.sale.customer_code,rules.importerCode,prefs);renderLines();
        status.textContent=`${rows.length}明細 保存済み`;
        if(kind==="save")return;
        core().validateRows(rows,{requireOrderNumber:true,requireCarton:true,requireCustomer:true});validateCartons(rows,prefs.prefix);
        if(jnext)DomesticDocuments.validateSale(state.sale);
        const stem=`納品書データ_${state.sale.sale_date}_${String(state.sale.sale_no).replace(/[\\/:*?"<>|]/g,"_")}`;
        const options=outputOptions();
        if(kind==="csv")download(new Blob([core().csv(rows,prefs.columns,options)],{type:"text/csv;charset=utf-8"}),`${stem}.csv`);
        else{
          if(!root.ExcelJS)throw new Error("Excel出力ライブラリを読み込めませんでした。");
          const workbook=core().createWorkbook(root.ExcelJS,rows,prefs.columns,options);
          const bytes=await workbook.xlsx.writeBuffer();
          download(new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),`${stem}.xlsx`);
        }
        status.textContent=`${kind==="csv"?"CSV":"Excel"}出力済み / ${rows.length}明細`;
      }catch(error){status.textContent=errorText(error);invalidInput=invalidField(error)}finally{
        setBusy(false);
        if(invalidInput){invalidInput.scrollIntoView({block:"nearest"});invalidInput.focus()}
      }
    }
    dialog.addEventListener("input",event=>{
      const input=event.target;
      input.removeAttribute("aria-invalid");
      if(input.dataset.setting){prefs[input.dataset.setting]=input.value;markDirty();renderPreview();return}
      const index=Number(input.closest("[data-index]")?.dataset.index);
      if(input.dataset.field&&Number.isInteger(index)&&rows[index]){rows[index][input.dataset.field]=input.value;markDirty();renderPreview()}
    });
    dialog.addEventListener("change",event=>{
      const key=event.target.dataset.column;if(!key)return;
      prefs.columns=event.target.checked?[...prefs.columns,key]:prefs.columns.filter(c=>c!==key);markDirty();renderColumns();renderPreview();
    });
    dialog.addEventListener("focusout",event=>{
      if(event.target.dataset.setting==="prefix"){
        const next=prefs.prefix.trim();
        if(next&&appliedPrefix){rows=rows.map(r=>{const value=String(r.cartonNo||""),digits=value.startsWith(appliedPrefix)?value.slice(appliedPrefix.length):"";return /^\d+$/.test(digits)?{...r,cartonNo:core().cartonNumber(digits,next)}:r});prefs.prefix=next;appliedPrefix=next;renderLines()}
        return;
      }
      const input=event.target;if(input.dataset.field!=="cartonNo")return;
      const row=rows[Number(input.closest("[data-index]").dataset.index)],value=input.value.trim();
      if(prefs.prefix&&/^\d+$/.test(value)){row.cartonNo=core().cartonNumber(value,prefs.prefix);input.value=row.cartonNo;renderPreview()}
    });
    dialog.addEventListener("click",event=>{
      const button=event.target.closest("button");if(!button)return;
      if(button.dataset.move){const i=prefs.columns.indexOf(button.dataset.key),j=i+Number(button.dataset.move);if(i>=0&&j>=0&&j<prefs.columns.length){[prefs.columns[i],prefs.columns[j]]=[prefs.columns[j],prefs.columns[i]];markDirty();renderColumns();renderPreview()}return}
      if(button.dataset.action==="close")pendingClose();
      else if(["save","excel","csv"].includes(button.dataset.action))saveAndExport(button.dataset.action);
    });
    dialog.addEventListener("cancel",event=>{event.preventDefault();pendingClose()});
    const beforeUnload=event=>{if(busy||dirty){event.preventDefault();event.returnValue=""}};
    root.addEventListener("beforeunload",beforeUnload);
    dialog.addEventListener("close",()=>{root.removeEventListener("beforeunload",beforeUnload);dialog.remove();focusBefore?.focus()},{once:true});
    renderColumns();renderLines();dialog.showModal();
  }
  root.openDomesticDeliveryExport=open;
  root.DomesticDeliveryExportApp={normalizeCartons,validateCartons,metadataRows,sameMetadata,preferences,errorText,importerRules};
})(globalThis);
