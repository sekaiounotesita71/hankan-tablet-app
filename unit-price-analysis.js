"use strict";
const unitPriceState={sales:{mode:"overview",loaded:null,page:1},purchase:{mode:"overview",loaded:null,page:1}};
const UNIT_PRICE_PAGE_SIZE=30;
let unitPriceDialog=null;
function markUnitPriceDataLoaded(kind,ranges){unitPriceState[kind].loaded=ranges.map(range=>({...range}))}
function unitPriceHost(kind){return document.getElementById(`${kind}-unit-price`)}
function unitPricePanel(kind){return document.getElementById(kind==="sales"?"sales-reference-panel":"purchase-reference-panel")}
function unitPriceFormat(value){return value===null||value===undefined?"-":Number(value).toLocaleString("ja-JP",{maximumFractionDigits:4})}
function unitPriceDifference(group){
  if(group.current.avg===null)return group.previous.avg===null?"比較対象なし":`前年 ${unitPriceFormat(group.previous.avg)}`;
  if(group.delta===null)return "前年単価なし";
  const sign=group.delta>0?"+":"";
  return `${sign}${unitPriceFormat(group.delta)}${group.ratio===null?"":` (${group.ratio>0?"+":""}${group.ratio.toFixed(1)}%)`}`;
}
function unitPriceCloseDialog(){if(unitPriceDialog){unitPriceDialog.close();unitPriceDialog.remove();unitPriceDialog=null}}
function unitPriceMode(kind,mode){
  unitPriceCloseDialog();
  const state=unitPriceState[kind];state.mode=mode;
  unitPricePanel(kind).dataset.analysisMode=mode;
  unitPriceHost(kind).hidden=mode!=="price";
  document.querySelectorAll(`[data-price-mode="${kind}"]`).forEach(button=>button.setAttribute("aria-selected",String(button.dataset.mode===mode)));
  if(kind==="sales")renderSalesReferenceBoard();else renderPurchaseReceipts();
}
function clearUnitPriceAnalysis(kind,message){
  const state=unitPriceState[kind];state.groups=[];state.filtered=[];state.snapshot=null;
  unitPriceCloseDialog();
  const host=unitPriceHost(kind);if(!host)return;
  host.querySelector(".price-results").innerHTML=`<div class="price-empty">${esc(message)}</div>`;
}
function unitPriceRangeCovered(loaded,range){
  if(!loaded)return false;
  return loaded.some(part=>(!part.from||range.from&&part.from<=range.from)&&(!part.to||range.to&&part.to>=range.to));
}
function unitPriceSnapshot(kind){
  const input=kind==="sales"?salesRefDateRangeFromInput():purchaseRefDateRange();
  if(input.raw&&(!input.from||!input.to))return {error:"期間の形式を確認してください。"};
  const range={from:input.from||"",to:input.to||""};
  const previousRange=range.from&&range.to?{from:salesRefShiftYear(range.from,-1),to:salesRefShiftYear(range.to,-1)}:null;
  const loaded=unitPriceState[kind].loaded;
  if(!unitPriceRangeCovered(loaded,range)||previousRange&&!unitPriceRangeCovered(loaded,previousRange))return {error:"期間のデータを読み込んでください。",reload:true};
  let data;
  if(kind==="sales")data=UnitPriceAnalysis.sales(salesRefFilteredRows({ignoreDate:true}).map(row=>({
    ...row,analysisDate:salesRefRowDate(row),analysisImporterCode:salesRefRowImporter(row).key,analysisImporterLabel:salesRefRowImporter(row).label,
    _sales_provisional:salesRefIsProvisional(row)
  })));
  else data=UnitPriceAnalysis.purchases(purchaseRefFilteredReceipts({ignoreDate:true}));
  const within=(row,period)=>(!period.from||row.date>=period.from)&&(!period.to||row.date<=period.to);
  return {range,previousRange,rows:data.rows.filter(row=>within(row,range)),previousRows:previousRange?data.rows.filter(row=>within(row,previousRange)):[],
    excluded:data.excluded.filter(row=>within(row,range))};
}
function renderUnitPriceAnalysis(kind){
  const state=unitPriceState[kind];
  if(state.mode!=="price")return false;
  const host=unitPriceHost(kind);if(!host)return false;
  const snapshot=unitPriceSnapshot(kind);
  if(snapshot.error){
    clearUnitPriceAnalysis(kind,snapshot.error);
    if(snapshot.reload)host.querySelector(".price-results").insertAdjacentHTML("beforeend",'<button type="button" class="btn primary" data-price-reload>読込</button>');
    return true;
  }
  state.snapshot=snapshot;state.page=1;
  const units=[...new Set([...snapshot.rows,...snapshot.previousRows].map(row=>row.unit))].sort();
  const select=host.querySelector('[data-price-control="unit"]'),selected=select.value;
  select.innerHTML='<option value="">全単位</option>'+units.map(unit=>`<option value="${esc(unit)}">${esc(unit)}</option>`).join("");
  select.value=units.includes(selected)?selected:"";
  updateUnitPriceResults(kind);
  return true;
}
function unitPriceOptions(kind){
  const host=unitPriceHost(kind);
  return {party:host.querySelector('[data-price-control="axis"]').value==="party",origin:host.querySelector('[data-price-control="origin"]').checked,
    unit:host.querySelector('[data-price-control="unit"]').value,query:host.querySelector('[data-price-control="query"]').value,
    sort:host.querySelector('[data-price-control="sort"]').value};
}
function unitPriceExclusions(rows){
  if(!rows.length)return "";
  const reasons=new Map();rows.forEach(row=>reasons.set(row.reason,(reasons.get(row.reason)||0)+1));
  return `<details class="price-exclusions"><summary>単価比較対象外 ${rows.length.toLocaleString("ja-JP")}明細</summary><ul>${[...reasons].map(([reason,count])=>`<li>${esc(reason)}: ${count.toLocaleString("ja-JP")}件</li>`).join("")}</ul></details>`;
}
function unitPriceGrid(groups,options={}){
  const party=options.party;
  return `<div class="price-grid-scroll"><table class="price-grid"><thead><tr><th>${options.partyOnly?"取引先":"商品 / 産地"}</th>${party?'<th class="price-party">取引先</th>':""}<th>単位</th><th title="直近日と、その前の取引日の数量加重平均を比較">直近日平均 / 前回差</th><th title="単価×数量の合計÷数量合計">平均単価 / 前年差</th><th>最安 ～ 最高</th><th>数量 / 明細</th>${options.actions===false?"":"<th>内訳</th>"}</tr></thead><tbody>${groups.map((group,index)=>`<tr>
    <td>${options.partyOnly?esc(group.partyLabel):`<b>${esc(group.code||"コードなし")}</b> ${esc(group.name)}<span class="price-sub">${esc(group.origin)}</span>`}</td>
    ${party?`<td class="price-party">${esc(group.partyLabel)}</td>`:""}<td>${esc(group.unit)}</td>
    <td>${unitPriceFormat(group.current.latest)}<span class="price-sub">${esc(group.current.latestDate||"期間内取引なし")}</span><span class="price-sub ${group.recentDelta>0?"price-up":group.recentDelta<0?"price-down":""}" title="${esc(group.current.priorDate)} / ${unitPriceFormat(group.current.prior)}">${group.current.prior===null?"期間内の前回取引なし":`前回差 ${group.recentDelta>0?"+":""}${unitPriceFormat(group.recentDelta)}`}</span></td>
    <td><b>${unitPriceFormat(group.current.avg)}</b><span class="price-sub ${group.delta>0?"price-up":group.delta<0?"price-down":""}">${esc(unitPriceDifference(group))}</span></td>
    <td>${unitPriceFormat(group.current.min)} ～ ${unitPriceFormat(group.current.max)}<span class="price-sub">差 ${unitPriceFormat(group.current.spread)}</span></td>
    <td>${unitPriceFormat(group.current.qty)}<span class="price-sub">${group.current.count}明細</span></td>
    ${options.actions===false?"":`<td><button class="small" type="button" data-price-detail="${index}">履歴・比較</button></td>`}</tr>`).join("")||`<tr><td colspan="${6+(party?1:0)+(options.actions===false?0:1)}" class="price-empty">該当する単価データはありません。</td></tr>`}</tbody></table></div>`;
}
function updateUnitPriceResults(kind){
  const state=unitPriceState[kind],snapshot=state.snapshot;if(!snapshot)return;
  const options=unitPriceOptions(kind),host=unitPriceHost(kind);
  state.analysisRows=UnitPriceAnalysis.filterRows(snapshot.rows,options);
  state.analysisPreviousRows=UnitPriceAnalysis.filterRows(snapshot.previousRows,options);
  state.groups=UnitPriceAnalysis.groups(state.analysisRows,state.analysisPreviousRows,options);
  state.filtered=UnitPriceAnalysis.filterSort(state.groups,{sort:options.sort});
  const total=state.filtered.length,pages=Math.max(1,Math.ceil(total/UNIT_PRICE_PAGE_SIZE));
  state.page=Math.max(1,Math.min(state.page,pages));
  state.visible=state.filtered.slice((state.page-1)*UNIT_PRICE_PAGE_SIZE,state.page*UNIT_PRICE_PAGE_SIZE);
  const compared=state.filtered.filter(group=>group.delta!==null),up=compared.filter(group=>group.delta>1e-8).length,down=compared.filter(group=>group.delta< -1e-8).length;
  const period=snapshot.range.from?`${snapshot.range.from} ～ ${snapshot.range.to}`:"読込済み全期間";
  host.querySelector(".price-results").innerHTML=`<div class="price-summary"><span>${esc(period)}</span><span><b>${total.toLocaleString("ja-JP")}</b> 組</span><span class="price-up">前年より上昇 <b>${up}</b></span><span class="price-down">前年より低下 <b>${down}</b></span><span>比較あり ${compared.length}組</span></div>
    <div class="price-note">${kind==="sales"?"確定売上":"確定仕入・税抜"} / 円・送料別 / 平均は数量加重平均${snapshot.previousRange?` / 前年 ${esc(snapshot.previousRange.from)} ～ ${esc(snapshot.previousRange.to)}`:" / 全期間は前年比較なし"}</div>
    ${unitPriceExclusions(snapshot.excluded)}${unitPriceGrid(state.visible,options)}
    <div class="price-pager"><span>${state.page} / ${pages}ページ</span><button class="small" data-price-page="-1" ${state.page===1?"disabled":""}>前へ</button><button class="small" data-price-page="1" ${state.page===pages?"disabled":""}>次へ</button><button class="btn" data-price-export ${!total?"disabled":""}>分析Excel</button></div>`;
}
function unitPriceExcelRows(groups){
  return groups.map(group=>({"商品コード":group.code,"商品名":group.name,"産地":group.origin,"取引先":group.partyLabel,"単位":group.unit,
    "直近日":group.current.latestDate,"直近日平均単価":group.current.latest,"前回取引日":group.current.priorDate,"前回取引日平均単価":group.current.prior,"前回差":group.current.prior===null?null:group.current.latest-group.current.prior,"数量加重平均単価":group.current.avg,"前年平均単価":group.previous.avg,
    "前年差":group.delta,"前年比変化率%":group.ratio,"最安単価":group.current.min,"最高単価":group.current.max,"単価差":group.current.spread,"数量":group.current.qty,"明細数":group.current.count}));
}
function unitPriceHistoryExcel(rows,period){
  return rows.map(row=>({"期間":period,"日付":row.date,"商品コード":row.code,"商品名":row.name,"産地":row.origin,"取引先":row.partyLabel,"単位":row.unit,"数量":row.qty,"単価":row.price,"管理番号・区分":row.reference,"備考":row.note}));
}
function exportUnitPriceAnalysis(kind,groups=unitPriceState[kind].filtered){
  if(typeof XLSX==="undefined"){alert("Excel出力ライブラリを読み込めませんでした。");return}
  if(!groups?.length)return;
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(unitPriceExcelRows(groups)),"単価比較");
  const current=[...new Map(groups.flatMap(group=>group.rows).map(row=>[row.id,row])).values()];
  const previous=[...new Map(groups.flatMap(group=>group.previousRows).map(row=>[row.id,row])).values()];
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([...unitPriceHistoryExcel(current,"対象期間"),...unitPriceHistoryExcel(previous,"前年同期間")] ),"単価履歴");
  const excluded=unitPriceState[kind].snapshot?.excluded||[];
  if(excluded.length)XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(excluded.map(row=>({"日付":row.date,"商品コード":row.code,"商品名":row.name,"取引先":row.partyLabel,"比較対象外の理由":row.reason}))),"比較対象外");
  XLSX.writeFile(workbook,`${kind==="sales"?"売上":"仕入"}_単価分析.xlsx`);
}
function openUnitPriceDetail(kind,index){
  const state=unitPriceState[kind],selected=state.visible[index];if(!selected)return;
  unitPriceCloseDialog();
  const options=unitPriceOptions(kind),snapshot=state.snapshot;
  const match=row=>UnitPriceAnalysis.groupKey(row,{origin:options.origin})===UnitPriceAnalysis.groupKey(selected.rows[0]||selected.previousRows[0],{origin:options.origin});
  const current=state.analysisRows.filter(match),previous=state.analysisPreviousRows.filter(match);
  const partners=[...new Map([...current,...previous].map(row=>[row.partyKey,row.partyLabel])).entries()].sort((a,b)=>a[1].localeCompare(b[1],"ja"));
  const dialog=document.createElement("dialog");unitPriceDialog=dialog;
  dialog.className="price-dialog";dialog.dataset.kind=kind;dialog.setAttribute("aria-label","単価履歴・取引先比較");
  dialog.innerHTML=`<div class="price-dialog-head"><h2>${esc(selected.code)} ${esc(selected.name)}<span class="price-sub">${esc(selected.origin)} / ${esc(selected.unit)} / 円</span></h2><button class="btn" type="button" data-close>閉じる</button></div>
    <div class="price-tools"><label>${kind==="sales"?"得意先":"仕入先"}<select data-party><option value="">すべて</option>${partners.map(([key,label],i)=>`<option value="${i}">${esc(label)}</option>`).join("")}</select></label><label data-history-period hidden>履歴期間<select data-history-period-select><option value="current">対象期間</option><option value="previous">前年同期間</option></select></label><button class="btn" data-export>分析Excel</button></div>
    <div class="price-mode-tabs" role="tablist" aria-label="単価内訳"><button role="tab" aria-selected="true" data-view="party">${kind==="sales"?"得意先別価格差":"仕入先別価格差"}</button><button role="tab" aria-selected="false" data-view="month">月別推移</button><button role="tab" aria-selected="false" data-view="history">単価履歴</button></div><div data-detail-body></div>`;
  document.body.append(dialog);
  if(options.party)dialog.querySelector("[data-party]").value=String(partners.findIndex(([key])=>key===(selected.rows[0]||selected.previousRows[0]).partyKey));
  let view="party",page=1,visibleGroup;
  function render(){
    const selectedPartner=dialog.querySelector("[data-party]").value;
    const matchPartner=row=>selectedPartner===""||row.partyKey===partners[Number(selectedPartner)]?.[0];
    const rows=current.filter(matchPartner),previousRows=previous.filter(matchPartner);
    visibleGroup={...selected,partyLabel:selectedPartner===""?"":partners[Number(selectedPartner)][1],rows,previousRows,current:UnitPriceAnalysis.stats(rows),previous:UnitPriceAnalysis.stats(previousRows)};
    visibleGroup.delta=visibleGroup.current.avg===null||visibleGroup.previous.avg===null?null:visibleGroup.current.avg-visibleGroup.previous.avg;
    visibleGroup.ratio=visibleGroup.delta===null||!visibleGroup.previous.avg?null:visibleGroup.delta/visibleGroup.previous.avg*100;
    let body;
    if(view==="party")body=unitPriceGrid(UnitPriceAnalysis.filterSort(UnitPriceAnalysis.groups(rows,previousRows,{party:true,origin:false}),{sort:"value"}),{partyOnly:true,actions:false});
    else if(view==="month"){
      const months=UnitPriceAnalysis.monthly({rows,previousRows}),max=Math.max(1,...months.flatMap(month=>[month.current.avg||0,month.previous.avg||0]));
      body=`<div class="price-grid-scroll"><table class="price-grid"><thead><tr><th>月</th><th>平均単価</th><th>前年平均単価</th><th>最安 ～ 最高</th><th>数量</th><th>明細</th></tr></thead><tbody>${months.map(month=>`<tr><td>${esc(month.month)}</td><td><b>${unitPriceFormat(month.current.avg)}</b><div class="price-mini-bar"><span style="width:${(month.current.avg||0)/max*100}%"></span></div></td><td>${unitPriceFormat(month.previous.avg)}</td><td>${unitPriceFormat(month.current.min)} ～ ${unitPriceFormat(month.current.max)}</td><td>${unitPriceFormat(month.current.qty)}</td><td>${month.current.count}</td></tr>`).join("")||'<tr><td colspan="6">データなし</td></tr>'}</tbody></table></div>`;
    }else{
      const historySource=dialog.querySelector("[data-history-period-select]").value==="previous"?previousRows:rows;
      const history=historySource.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id)),pages=Math.max(1,Math.ceil(history.length/50));
      page=Math.min(page,pages);
      body=`<div class="price-grid-scroll"><table class="price-grid"><thead><tr><th>日付 / 管理番号</th><th class="price-party">${kind==="sales"?"得意先":"仕入先"}</th><th>単価</th><th>数量</th><th>単位</th><th>産地</th><th>商品名 / 備考</th></tr></thead><tbody>${history.slice((page-1)*50,page*50).map(row=>`<tr><td>${esc(row.date)}<span class="price-sub">${esc(row.reference)}</span></td><td class="price-party">${esc(row.partyLabel)}</td><td><b>${unitPriceFormat(row.price)}</b></td><td>${unitPriceFormat(row.qty)}</td><td>${esc(row.unit)}</td><td>${esc(row.origin)}</td><td><span class="price-sub">${esc(row.name)}<br>${esc(row.note)}</span></td></tr>`).join("")||'<tr><td colspan="7">期間内の取引なし</td></tr>'}</tbody></table></div><div class="price-pager"><span>${history.length}明細 / ${page} / ${pages}ページ</span><button class="small" data-page="-1" ${page===1?"disabled":""}>前へ</button><button class="small" data-page="1" ${page===pages?"disabled":""}>次へ</button></div>`;
    }
    dialog.querySelector("[data-detail-body]").innerHTML=body;
    dialog.querySelector("[data-history-period]").hidden=view!=="history";
    dialog.querySelectorAll("[data-view]").forEach(button=>button.setAttribute("aria-selected",String(button.dataset.view===view)));
  }
  dialog.addEventListener("change",()=>{page=1;render()});
  dialog.addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button)return;
    if(button.hasAttribute("data-close"))unitPriceCloseDialog();
    else if(button.dataset.view){view=button.dataset.view;page=1;render()}
    else if(button.dataset.page){page+=Number(button.dataset.page);render()}
    else if(button.hasAttribute("data-export"))exportUnitPriceAnalysis(kind,[visibleGroup]);
  });
  dialog.addEventListener("cancel",event=>{event.preventDefault();unitPriceCloseDialog()});
  render();dialog.showModal();
}
function installUnitPriceAnalysis(kind){
  const reference=kind==="sales"?document.getElementById("sales-ref-forecast-cards"):document.getElementById("purchase-ref-summary-cards");
  if(!reference)return;
  const tabs=document.createElement("div");tabs.className="price-mode-tabs";tabs.setAttribute("role","tablist");tabs.setAttribute("aria-label",kind==="sales"?"売上参照の表示":"仕入参照の表示");
  tabs.innerHTML=`<button type="button" role="tab" data-price-mode="${kind}" data-mode="overview" aria-selected="true">概況・明細</button><button type="button" role="tab" data-price-mode="${kind}" data-mode="price" aria-selected="false">単価分析</button>`;
  reference.before(tabs);
  const host=document.createElement("div");host.id=`${kind}-unit-price`;host.className="unit-price-panel";host.hidden=true;
  host.innerHTML=`<div class="price-tools"><label>集計<select data-price-control="axis"><option value="product">商品別</option><option value="party">${kind==="sales"?"得意先":"仕入先"} × 商品</option></select></label><label>商品・取引先・産地<input data-price-control="query" autocomplete="off" type="search"></label><label>単位<select data-price-control="unit"><option value="">全単位</option></select></label><label>並び順<select data-price-control="sort"><option value="spread">価格差が大きい順</option><option value="recent-up">単価上昇順（前回差）</option><option value="recent-down">単価低下順（前回差）</option><option value="increase">単価上昇順（前年差）</option><option value="decrease">単価低下順（前年差）</option><option value="value">取引規模順</option><option value="code">商品コード順</option></select></label><label class="price-check"><input type="checkbox" data-price-control="origin" checked>産地別に分ける</label></div><div class="price-results"></div>`;
  tabs.after(host);
  tabs.addEventListener("click",event=>{const button=event.target.closest("button");if(button)unitPriceMode(kind,button.dataset.mode)});
  let timer;
  host.addEventListener("input",event=>{
    if(event.target.dataset.priceControl!=="query"||event.isComposing)return;
    clearTimeout(timer);timer=setTimeout(()=>{unitPriceState[kind].page=1;updateUnitPriceResults(kind)},160);
  });
  host.addEventListener("compositionend",()=>{clearTimeout(timer);unitPriceState[kind].page=1;updateUnitPriceResults(kind)});
  host.addEventListener("change",event=>{if(event.target.dataset.priceControl){unitPriceState[kind].page=1;updateUnitPriceResults(kind)}});
  host.addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button)return;
    if(button.hasAttribute("data-price-detail"))openUnitPriceDetail(kind,Number(button.dataset.priceDetail));
    else if(button.dataset.pricePage){unitPriceState[kind].page+=Number(button.dataset.pricePage);updateUnitPriceResults(kind);host.querySelector(".price-grid-scroll")?.scrollTo({top:0})}
    else if(button.hasAttribute("data-price-export"))exportUnitPriceAnalysis(kind);
    else if(button.hasAttribute("data-price-reload")){if(kind==="sales")loadSalesReferenceBoard();else loadPurchaseReceipts()}
  });
}
installUnitPriceAnalysis("sales");
installUnitPriceAnalysis("purchase");
