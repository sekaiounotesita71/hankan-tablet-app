let workBoxRoutingCache=null;
async function loadWorkBoxRouting(records,siteCode,idField="source_order_line_id"){
  if(siteCode!=="TYO")return records;
  const ids=[...new Set(records.map(row=>row[idField]).filter(Boolean))].sort();
  const key=JSON.stringify([currentUser?.id||"",ids]);
  try{
    let sources,suppliers;
    if(workBoxRoutingCache?.key===key&&Date.now()-workBoxRoutingCache.time<30000){
      ({sources,suppliers}=workBoxRoutingCache);
    }else{
      sources=[];suppliers=[];
      for(let index=0;index<ids.length;index+=200){
        const {data,error}=await supabaseClient.from("order_entry_lines").select("id,supplier_code").in("id",ids.slice(index,index+200));
        if(error)throw error;
        sources.push(...(data||[]));
      }
      const codes=[...new Set(sources.map(row=>row.supplier_code).filter(Boolean))];
      for(let index=0;index<codes.length;index+=200){
        const {data,error}=await supabaseClient.from("supplier_master").select("supplier_code,box_prefix").in("supplier_code",codes.slice(index,index+200));
        if(error)throw error;
        suppliers.push(...(data||[]));
      }
      workBoxRoutingCache={key,sources,suppliers,time:Date.now()};
    }
    return WorkBoxNumber.routeRows(records,sources,suppliers,idField);
  }catch(error){
    return records.map(row=>({...row,_boxRouting:{prefix:"",error:`箱コード読込失敗: ${error.message||error}`}}));
  }
}
function workBoxInput(row){
  const info=WorkBoxNumber.describe(row._box,currentSessionSiteCode,row._boxRouting);
  const title=info.blocked?info.error:info.legacy?`保存済みの箱番号: ${info.stored}`:"箱番号";
  return `<div class="work-box-input"><span class="work-box-prefix" title="${esc(title)}">${esc(info.prefix||"未設定")}${info.prefix?"-":""}</span><input class="inline-work-input work-box-sequence" data-row-idx="${row._idx}" data-field="box" data-box-prefix="${esc(info.prefix)}" data-box-original="${esc(info.stored)}" data-box-dirty="0" inputmode="numeric" pattern="[0-9]*" autocomplete="off" enterkeyhint="next" value="${esc(info.sequence)}" placeholder="番号" aria-label="${esc(info.prefix||"未設定")} 箱番号" title="${esc(title)}" ${info.blocked?"disabled data-box-routing-blocked=\"true\"":""} onclick="event.stopPropagation()" oninput="updateInlineP1Draft(this)" onblur="commitInlineP1Field(this)" onkeydown="handleInlineWorkKey(event)">${info.legacy?'<span class="work-box-legacy">コード未反映</span>':""}</div>`;
}
