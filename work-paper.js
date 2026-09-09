(function(root){
  "use strict";
  const string=value=>String(value??"");
  const esc=value=>string(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const has=value=>string(value).trim()!=="";
  const compare=(a,b)=>string(a).localeCompare(string(b),"ja",{numeric:true});
  const customerKey=row=>JSON.stringify([row.customerCode||"",row.customerName||""]);
  const boxKey=(importer,box)=>JSON.stringify([string(importer),string(box).trim()]);
  const assetBase=typeof document!=="undefined"?new URL(".",document.currentScript?.src||location.href).href:"";

  function paperMemo(memo){
    return string(memo).replace(/(?:\s*\/\s*)?価格候補:\s*[\d,.]+(?:\s*\/\s*[\d,.]+)*/g,"").replace(/^\s*\/\s*/,"").trim();
  }
  function groupCustomers(rows){
    const groups=new Map();
    rows.forEach(row=>{const key=customerKey(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});
    return [...groups.values()].sort((a,b)=>compare(a[0].customerName,b[0].customerName)||compare(a[0].customerCode,b[0].customerCode));
  }
  // Keep a customer together when it fits; repeat its name on every continuation page.
  function paginateGroups(groups,capacities=[]){
    const pages=[];let current=[];
    const capacity=()=>capacities[pages.length]||12;
    const flush=()=>{if(current.length){pages.push({rows:current,capacity:capacity()});current=[]}};
    for(const group of groups){
      if(current.length&&current.length+group.length>capacity())flush();
      for(const row of group){if(current.length===capacity())flush();current.push(row)}
    }
    flush();
    return pages;
  }
  function makeSections(snapshot,options){
    const ids=new Set(options.ids),selected=snapshot.rows.filter(r=>ids.has(r.id));
    if(!selected.length)throw new Error("出力する商品を選択してください");
    if(!options.lines&&!options.boxes)throw new Error("出力する帳票を選択してください");
    const importers=new Map();
    selected.forEach(row=>{if(!importers.has(row.importerCode))importers.set(row.importerCode,[]);importers.get(row.importerCode).push(row)});
    const boxMap=new Map(snapshot.boxes.map(b=>[boxKey(b.importerCode,b.boxNo),b]));
    const sections=[];
    [...importers.entries()].sort(([a],[b])=>compare(a,b)).forEach(([code,rows])=>{
      const meta={code,importerName:rows[0].importerName||code,workDate:snapshot.workDate,printedAt:snapshot.printedAt,recipient:options.recipient||""};
      if(options.lines)sections.push({type:"lines",meta,groups:groupCustomers(rows),capacities:[]});
      if(options.boxes){
        const numbers=[...new Set(rows.filter(r=>!r.stockout&&has(r.boxNo)).map(r=>string(r.boxNo).trim()))].sort(compare);
        const boxes=numbers.map(boxNo=>({...(boxMap.get(boxKey(code,boxNo))||{}),boxNo}));
        sections.push({type:"boxes",meta,groups:boxes.length?boxes.map(b=>[b]):[[{}]],capacities:[]});
      }
    });
    return sections;
  }
  function check(checked=false,label=""){return `<span class="wp-choice"><span class="wp-check">${checked?"&#10003;":""}</span>${esc(label)}</span>`}
  function header(meta,type){
    return `<header class="wp-head"><div class="wp-title">${type==="lines"?"計量・箱詰め記録":"箱別重量記録"}</div><img src="${esc(assetBase)}yumirume-logo.jpg" alt="YUMIRUME INC."><div class="wp-meta"><div><span>作業日</span><b>${esc(meta.workDate)}</b></div><div><span>輸入社</span><b>${esc(meta.importerName)}</b></div><div><span>依頼先</span><b>${esc(meta.recipient)}</b></div><div><span>作業者</span><b></b></div></div></header>`;
  }
  function footer(meta,pageNo,total){
    return `<footer class="wp-footer"><div class="wp-signatures"><b>社内記入欄</b><span>${check(false,"回収")}<i></i></span><span>${check(false,"アプリ転記")}<i></i></span><span>${check(false,"照合完了")}<i></i></span></div><div class="wp-foot-meta"><span>${esc(meta.printedAt)}</span><span>${pageNo} / ${total}</span></div></footer>`;
  }
  function lineTable(page){
    const headings=["No.","得意先","商品コード / 商品名","注文<br>数量・単位","実績<br>数量","単位","NET重量<br>kg","箱番号","産地","備考 / 作業メモ","欠<br>品","完<br>了"];
    const widths=[8,29,63,18,19,15,21,22,24,42,8,8];
    let html="";
    page.rows.forEach((row,index)=>{
      const key=customerKey(row),start=index===0||customerKey(page.rows[index-1])!==key;
      let span=1;while(index+span<page.rows.length&&customerKey(page.rows[index+span])===key)span++;
      const done=row.stockout||[row.qty,row.net,row.boxNo].every(has);
      html+=`<tr class="${start?"wp-group-start":""}" data-source-id="${esc(row.id)}"><td class="wp-number">${esc(row.sourceNo)}</td>${start?`<td class="wp-customer" rowspan="${span}"><b>${esc(row.customerName)}</b>${row.customerCode?`<small>${esc(row.customerCode)}</small>`:""}</td>`:""}<td class="wp-product"><div><small>${esc(row.productCode)}</small><b>${esc(row.productName)}</b></div></td><td class="wp-order">${esc(row.orderQty)} ${esc(row.orderUnit)}</td><td>${row.stockout?"":esc(row.qty)}</td><td>${!row.stockout&&has(row.qty)?esc(row.unit):""}</td><td>${row.stockout?"":esc(row.net)}</td><td>${row.stockout?"":esc(row.boxNo)}</td><td>${esc(row.origin)}</td><td class="wp-memo">${esc(paperMemo(row.memo))}</td><td>${check(row.stockout)}</td><td>${check(done)}</td></tr>`;
    });
    for(let i=page.rows.length;i<page.capacity;i++)html+=`<tr class="wp-blank">${widths.map((_,j)=>`<td>${j>=10?check():""}</td>`).join("")}</tr>`;
    return `<table class="wp-table wp-lines"><colgroup>${widths.map(w=>`<col style="width:${w}mm">`).join("")}</colgroup><thead><tr>${headings.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${html}</tbody></table>`;
  }
  function boxTable(page){
    const widths=[8,44,38,62,51,12,62],headings=["No.","箱番号","グロス重量<br>kg","ドライアイス","箱サイズ","完了","作業メモ"];
    const rows=page.rows.concat(Array.from({length:page.capacity-page.rows.length},()=>({})));
    return `<table class="wp-table wp-boxes"><colgroup>${widths.map(w=>`<col style="width:${w}mm">`).join("")}</colgroup><thead><tr>${headings.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((b,i)=>`<tr><td>${page.start+i+1}</td><td>${esc(b.boxNo)}</td><td>${esc(b.gross)}</td><td><div class="wp-di">${check(b.dryIceEnabled===false,"無")}${check(b.dryIceEnabled===true,"有")}<span class="wp-write">${b.dryIceEnabled?esc(b.dryIce):""}</span><span>kg</span></div></td><td><div class="wp-sizes">${["小","中","大","特大"].map(size=>check(b.size===size,size)).join("")}</div></td><td>${check(has(b.gross)&&has(b.size)&&(!b.dryIceEnabled||has(b.dryIce)))}</td><td></td></tr>`).join("")}</tbody></table>`;
  }
  function pagesForSections(sections){
    return sections.flatMap((section,sectionIndex)=>{let start=0;return paginateGroups(section.groups,section.capacities).map((page,index)=>{const result={...page,type:section.type,meta:section.meta,sectionIndex,index,start};start+=page.rows.length;return result})});
  }
  function renderPages(sections){
    const pages=pagesForSections(sections);
    return pages.map((page,i)=>`<section class="wp-sheet" data-page="${i}">${header(page.meta,page.type)}${page.type==="lines"?lineTable(page):boxTable(page)}${footer(page.meta,i+1,pages.length)}</section>`).join("");
  }
  async function mountPrint(snapshot,options){
    const host=document.getElementById("wp-pages"),button=document.getElementById("wp-print-button"),status=document.getElementById("wp-print-status");
    try{
      const sections=makeSections(snapshot,options);
      host.innerHTML=renderPages(sections);
      await document.fonts.ready;
      await Promise.all([...host.querySelectorAll("img")].map(img=>img.decode().catch(()=>{})));
      // Long names and notes get more space instead of being clipped or silently omitted.
      for(let pass=0;pass<1000;pass++){
        const pages=pagesForSections(sections),sheets=[...host.children];
        const overflow=sheets.map((sheet,index)=>({sheet,index})).filter(({sheet})=>sheet.scrollHeight>sheet.clientHeight+2);
        if(!overflow.length){button.disabled=false;status.textContent=`${pages.length}ページ`;return}
        for(const {sheet,index} of overflow){
          const page=pages[index];
          if(page.capacity<=1)throw new Error("商品名または備考が1ページに収まりません。内容を確認してください");
          const height=selector=>sheet.querySelector(selector).getBoundingClientRect().height;
          const available=sheet.clientHeight-height("header")-height("footer")-height("thead")-2;
          let used=0,fit=0;
          for(const row of sheet.querySelectorAll("tbody tr")){used+=row.getBoundingClientRect().height;if(used>available)break;fit++}
          sections[page.sectionIndex].capacities[page.index]=Math.max(1,Math.min(page.capacity-1,fit));
        }
        host.innerHTML=renderPages(sections);
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      throw new Error("印刷ページを作成できませんでした");
    }catch(error){status.textContent=error.message;status.setAttribute("role","alert");host.replaceChildren()}
  }
  function printDocument(snapshot,options){
    // Only the selected, printable fields leave the work screen, including in the embedded data.
    const ids=new Set(options.ids),fields=["id","sourceNo","importerCode","importerName","customerCode","customerName","productCode","productName","orderQty","orderUnit","qty","unit","net","boxNo","origin","stockout"];
    const rows=snapshot.rows.filter(r=>ids.has(r.id)).map(row=>({...Object.fromEntries(fields.map(key=>[key,row[key]])),memo:paperMemo(row.memo)}));
    const keys=new Set(rows.filter(r=>!r.stockout&&has(r.boxNo)).map(r=>boxKey(r.importerCode,r.boxNo)));
    const boxes=snapshot.boxes.filter(b=>keys.has(boxKey(b.importerCode,b.boxNo))).map(b=>({importerCode:b.importerCode,boxNo:b.boxNo,gross:b.gross,dryIceEnabled:b.dryIceEnabled,dryIce:b.dryIce,size:b.size}));
    const printable={workDate:snapshot.workDate,printedAt:snapshot.printedAt,rows,boxes};
    const json=JSON.stringify({snapshot:printable,options}).replace(/</g,"\\u003c");
    return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>作業票_${esc(snapshot.workDate)}</title><link rel="stylesheet" href="${esc(assetBase)}work-paper.css?v=20260910-1"></head><body class="wp-print"><div class="wp-print-tools"><button id="wp-print-button" disabled onclick="window.print()">印刷 / PDF保存</button><span id="wp-print-status">作成中...</span></div><main id="wp-pages"></main><script id="wp-print-data" type="application/json">${json}</script><script src="${esc(assetBase)}work-paper.js?v=20260910-1"></script></body></html>`;
  }
  function open(snapshot){
    document.getElementById("wp-dialog")?.remove();
    const focusBefore=document.activeElement;
    snapshot=JSON.parse(JSON.stringify(snapshot));
    const selected=new Set(snapshot.rows.map(r=>r.id));
    const importerOptions=[...new Map(snapshot.rows.map(r=>[r.importerCode,r.importerName||r.importerCode])).entries()];
    const dialog=document.createElement("dialog");dialog.id="wp-dialog";dialog.className="wp-dialog";
    dialog.setAttribute("aria-labelledby","wp-dialog-title");
    dialog.innerHTML=`<div class="wp-dialog-head"><h2 id="wp-dialog-title">作業票</h2><button type="button" data-action="close" aria-label="閉じる" title="閉じる">&times;</button></div><div class="wp-filters"><label>輸入社<select id="wp-importer"><option value="">すべて</option>${importerOptions.map(([code,name],i)=>`<option value="${i}">${esc(name)}</option>`).join("")}</select></label><label>得意先<select id="wp-customer"></select></label><label>依頼先<input id="wp-recipient" maxlength="80" autocomplete="off"></label><label>帳票<select id="wp-kind"><option value="both">商品明細・箱一覧</option><option value="lines">商品明細</option><option value="boxes">箱一覧</option></select></label></div><div class="wp-select-tools"><label><input id="wp-select-all" type="checkbox">全件選択</label><span id="wp-selection-count"></span></div><div class="wp-selection-list" id="wp-selection-list"></div><div class="wp-dialog-foot"><span id="wp-error" role="status"></span><button type="button" data-action="print">印刷プレビュー</button></div>`;
    document.body.append(dialog);
    const importer=dialog.querySelector("#wp-importer"),customer=dialog.querySelector("#wp-customer");
    const active=importerOptions.findIndex(([code])=>code===snapshot.activeImporter);if(active>=0)importer.value=string(active);
    const imported=()=>snapshot.rows.filter(r=>importer.value===""||r.importerCode===importerOptions[Number(importer.value)][0]);
    const filtered=()=>imported().filter(r=>customer.value===""||customerKey(r)===customer.value);
    const fillCustomers=()=>{customer.innerHTML='<option value="">すべて</option>'+groupCustomers(imported()).map(g=>`<option value="${esc(customerKey(g[0]))}">${esc(g[0].customerName)}${g[0].customerCode?` (${esc(g[0].customerCode)})`:""}</option>`).join("")};
    function counts(){
      const visible=filtered(),count=visible.filter(r=>selected.has(r.id)).length,all=dialog.querySelector("#wp-select-all");
      all.checked=!!visible.length&&count===visible.length;all.indeterminate=count>0&&count<visible.length;
      dialog.querySelector("#wp-selection-count").textContent=`${count} / ${visible.length}明細`;
      dialog.querySelector('[data-action="print"]').disabled=!count;
      dialog.querySelectorAll("[data-group]").forEach(input=>{const group=visible.filter(r=>customerKey(r)===input.dataset.group),n=group.filter(r=>selected.has(r.id)).length;input.checked=n===group.length;input.indeterminate=n>0&&n<group.length});
    }
    function render(){
      dialog.querySelector("#wp-selection-list").innerHTML=groupCustomers(filtered()).map(group=>`<div class="wp-select-group"><label class="wp-group-label"><input type="checkbox" data-group="${esc(customerKey(group[0]))}">${esc(group[0].customerName)}${group[0].customerCode?` (${esc(group[0].customerCode)})`:""}</label>${group.map(r=>`<label class="wp-select-row"><input type="checkbox" data-row="${esc(r.id)}" ${selected.has(r.id)?"checked":""}><span>${esc(r.sourceNo)}</span><span>${esc(r.productCode)}</span><b>${esc(r.productName)}</b><span>${esc(r.orderQty)} ${esc(r.orderUnit)}</span></label>`).join("")}</div>`).join("");counts();
    }
    importer.addEventListener("change",()=>{fillCustomers();render()});customer.addEventListener("change",render);
    dialog.addEventListener("change",event=>{
      const input=event.target;let targets=[];
      if(input.id==="wp-select-all")targets=filtered();
      else if(input.dataset.group!==undefined)targets=filtered().filter(r=>customerKey(r)===input.dataset.group);
      else if(input.dataset.row!==undefined)targets=filtered().filter(r=>r.id===input.dataset.row);
      else return;
      targets.forEach(r=>input.checked?selected.add(r.id):selected.delete(r.id));
      dialog.querySelectorAll("[data-row]").forEach(el=>el.checked=selected.has(el.dataset.row));counts();
    });
    dialog.addEventListener("click",event=>{
      const action=event.target.closest("[data-action]")?.dataset.action;
      if(action==="close"){dialog.close();return}
      if(action!=="print")return;
      const kind=dialog.querySelector("#wp-kind").value;
      const options={ids:filtered().filter(r=>selected.has(r.id)).map(r=>r.id),lines:kind!=="boxes",boxes:kind!=="lines",recipient:dialog.querySelector("#wp-recipient").value.trim()};
      try{
        makeSections(snapshot,options);
        const w=window.open("","_blank");
        if(!w)throw new Error("ポップアップがブロックされました。ブラウザで許可してください");
        w.document.open();w.document.write(printDocument(snapshot,options));w.document.close();w.opener=null;
        dialog.querySelector("#wp-error").textContent="";
      }catch(error){dialog.querySelector("#wp-error").textContent=error.message}
    });
    dialog.addEventListener("close",()=>{dialog.remove();focusBefore?.focus()},{once:true});
    fillCustomers();render();dialog.showModal();
  }
  const api={open,paperMemo,groupCustomers,paginateGroups,makeSections,pagesForSections,renderPages,printDocument,mountPrint};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.WorkPaper=api;
  if(typeof document!=="undefined"){
    const data=document.getElementById("wp-print-data");
    if(data){const {snapshot,options}=JSON.parse(data.textContent);mountPrint(snapshot,options)}
    else{
      const source=document.getElementById("export-btn"),target=document.getElementById("work-paper-btn");
      if(source&&target){const sync=()=>{target.disabled=source.disabled};new MutationObserver(sync).observe(source,{attributes:true,attributeFilter:["disabled"]});sync()}
    }
  }
})(globalThis);
