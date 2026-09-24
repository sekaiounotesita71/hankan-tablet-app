(function(root,factory){
  const api=factory(typeof module==="object"&&module.exports?require("./supplier-work-profile.js"):root.SupplierWorkProfile);
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.SupplierWorkReport=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(Profiles){
  "use strict";
  const columns=[["No.",7],["得意先",27],["商品コード",16],["商品名",48],["備考",27],["注文数",13],["単位",10],["実績数量",14],["単位",10],["NET\nkg",16],["箱番号",20],["産地",20],["仕入単価\n税抜円",20],["単価\n単位",13]];
  const units=["Kg","pkt","PC","CS"];
  const text=value=>String(value??"").trim();
  const norm=value=>text(value).normalize("NFKC").toLowerCase();
  const compare=(a,b)=>text(a).localeCompare(text(b),"ja",{numeric:true});
  const escape=value=>text(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const safeName=value=>text(value).replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").replace(/[. ]+$/g,"").slice(0,65)||"作業明細書";
  const siteName=code=>({OSA:"大阪",TYO:"東京"}[code]||code);
  function customerKey(row){return JSON.stringify([row.customerCode,row.customerCode?"":row.customerName])}
  function cleanRow(row,index){
    // Only supplier-facing fields cross this boundary. Never copy sale prices or whole source rows.
    return {
      orderDate:text(row.orderDate||row.shipDate),supplierCode:text(row.supplierCode),supplierName:text(row.supplierName),
      importerCode:text(row.importerCode),importerName:text(row.importerName),siteCode:text(row.siteCode)||"OSA",
      customerCode:text(row.customerCode),customerName:text(row.customerName),productCode:text(row.productCode),productName:text(row.productName),
      memo:text(row.memo).replace(/(?:\s*\/\s*)?価格候補[:：]\s*[\d,.]+(?:\s*\/\s*[\d,.]+)*/g,"").replace(/^\s*\/\s*/,"").trim(),
      qty:typeof row.qty==="number"?row.qty:text(row.qty),unit:text(row.unit),sequence:index
    };
  }
  function selectSupplier(rows,query,masters=[]){
    const key=norm(query);
    if(!key||["all","全て","すべて"].includes(key))return rows;
    const identities=new Map();
    [...masters,...rows.map(r=>({code:r.supplierCode,name:r.supplierName}))].forEach(s=>{if(text(s.code))identities.set(norm(s.code),{code:text(s.code),name:text(s.name)})});
    let matches=[...identities.values()].filter(s=>norm(s.code)===key);
    if(!matches.length)matches=[...identities.values()].filter(s=>norm(s.name)===key);
    if(matches.length!==1)throw new Error("作業明細書は、発注先コードを指定するか、空欄（全発注先）で出力してください。");
    return rows.filter(r=>norm(r.supplierCode)===norm(matches[0].code));
  }
  function paginate(rows,capacity=12){
    const groups=new Map();rows.forEach(row=>{const key=customerKey(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});
    const pages=[];let page=[];const flush=()=>{if(page.length)pages.push(page);page=[]};
    for(const group of groups.values()){
      if(group.length<=capacity&&page.length+group.length>capacity)flush();
      for(const row of group){if(page.length===capacity)flush();page.push(row)}
    }
    flush();return pages;
  }
  function build(rows,options={}){
    const cleaned=rows.map(cleanRow);
    if(!cleaned.length)throw new Error("対象の受注明細がありません。");
    const missing=cleaned.filter(r=>!r.supplierCode||!r.importerCode||!r.customerName||!r.productName||!r.orderDate);
    if(missing.length)throw new Error(`発注先・輸入社・得意先・商品名・日付の未設定が${missing.length}件あります。受注を修正してから出力してください。`);
    const masterMap=new Map((options.suppliers||[]).map(s=>[norm(s.code),s]));const suppliers=new Map();
    cleaned.forEach(row=>{
      const key=norm(row.supplierCode);
      if(!suppliers.has(key)){const master=masterMap.get(key)||{};suppliers.set(key,{code:row.supplierCode,name:row.supplierName||text(master.name),boxPrefix:text(master.boxPrefix),groups:[]})}
      const supplier=suppliers.get(key);const groupKey=JSON.stringify([row.orderDate,norm(row.importerCode),row.siteCode]);
      let group=supplier.groups.find(g=>g.key===groupKey);
      if(!group){group={key:groupKey,date:row.orderDate,importerCode:row.importerCode,importerName:row.importerName,siteCode:row.siteCode,rows:[]};supplier.groups.push(group)}
      group.rows.push(row);
    });
    const result=[...suppliers.values()].sort((a,b)=>compare(a.code,b.code));
    for(const supplier of result){
      supplier.groups.sort((a,b)=>compare(a.date,b.date)||compare(a.importerCode,b.importerCode)||compare(a.siteCode,b.siteCode));
      for(const group of supplier.groups){
        group.header=Profiles.resolve(options.profiles||[],{site_code:group.siteCode,importer_code:group.importerCode,supplier_code:supplier.code},options.header);
        if(options.destination)group.header.cargo_location=text(options.destination);
        if(options.contact)group.header.contact=text(options.contact);
        if(options.note)group.header.packing_note=[group.header.packing_note,text(options.note)].filter(Boolean).join("\n");
        group.rows.sort((a,b)=>compare(a.customerCode,b.customerCode)||compare(a.customerName,b.customerName)||compare(a.productCode,b.productCode)||a.sequence-b.sequence);
        group.rows.forEach((row,index)=>{row.number=index+1});group.pages=paginate(group.rows);
      }
    }
    return {suppliers:result,options:{destination:text(options.destination),contact:text(options.contact),note:text(options.note)},rowCount:cleaned.length};
  }
  function cellValues(row){
    if(!row)return Array(14).fill("");
    const quantity=Number(text(row.qty).replace(/,/g,""));
    return [row.number,[row.customerName,row.customerCode].filter(Boolean).join("\n"),row.productCode,row.productName,row.memo,
      text(row.qty)!==""&&Number.isFinite(quantity)?quantity:text(row.qty),row.unit,"","","","","","",""];
  }
  function prefixLabel(supplier){return supplier.boxPrefix?`${supplier.boxPrefix.replace(/-+$/g,"")}-`:""}
  function headerValues(group,options={}){return group.header||Profiles.clean({cargo_location:options.destination,contact:options.contact,packing_note:options.note})}
  function headerHtml(group,options){
    const header=headerValues(group,options);
    const cell=(field,wide=false)=>`<div${wide?' class="header-wide"':""}><b>${Profiles.fields[field]}</b><span>${escape(header[field]||"―").replace(/\n/g,"<br>")}</span></div>`;
    return `<div class="work-header">${cell("destination_name")}${cell("contact")}${cell("cargo_location",true)}${cell("cargo_cut_time")}${cell("document_cut_time")}${cell("document_method",true)}${cell("packing_note",true)}</div>`;
  }
  function pageHtml(supplier,group,page,index,total,options){
    const allRows=page;let previous="";
    const lines=allRows.map(row=>{
      const key=row?customerKey(row):"";const first=!!row&&key!==previous;previous=key;
      return `<tr class="${first?"customer-start":""}${row?"":" blank"}"${row?` data-row="${row.sequence}"`:""}>${cellValues(row).map(value=>`<td>${escape(value).replace(/\n/g,"<br>")}</td>`).join("")}</tr>`;
    }).join("");
    return `<section class="work-page"><header><h1>作業明細書</h1><span>${index+1} / ${total}</span></header>
      <div class="meta">${[`発注先 ${supplier.code} ${supplier.name}`,`輸入社 ${group.importerCode} ${group.importerName}`,`日付 ${group.date}`,`拠点 ${siteName(group.siteCode)}`,`箱記号 ${prefixLabel(supplier)||"________"}`].map(t=>`<strong>${escape(t)}</strong>`).join("")}</div>
      ${headerHtml(group,options)}
      <table class="lines"><colgroup>${columns.map(c=>`<col style="width:${c[1]}mm">`).join("")}</colgroup><thead><tr>${columns.map(c=>`<th>${escape(c[0]).replace(/\n/g,"<br>")}</th>`).join("")}</tr></thead><tbody>${lines}</tbody></table>
      <div class="box-title">箱別重量 <span>箱記号 ${escape(prefixLabel(supplier))}</span></div>
      <table class="boxes"><thead><tr>${Array(3).fill("<th>箱番号</th><th>グロス重量 kg</th><th>ドライアイス kg</th>").join("")}</tr></thead><tbody>${Array(3).fill(`<tr>${Array(9).fill("<td></td>").join("")}</tr>`).join("")}</tbody></table>
      <footer><span>記入者 ____________________</span><span>確認 ____________________</span></footer></section>`;
  }
  const css=`@page{size:A4 landscape;margin:7mm 8mm}*{box-sizing:border-box}body{font-family:"Yu Gothic","Meiryo",sans-serif;color:#111;margin:0;font-size:9pt;letter-spacing:0;background:#e8ecef}.work-page{width:281mm;min-height:194mm;background:white;margin:10mm auto;padding:0;break-after:page;page-break-after:always}.work-page:last-child{break-after:auto;page-break-after:auto}header{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #111;padding:2mm 0}h1{font-size:17pt;margin:0}.meta{display:flex;flex-wrap:wrap;gap:2mm 8mm;padding:3mm 0;font-size:10pt}.delivery,.instructions{margin-bottom:2mm;white-space:normal;overflow-wrap:anywhere}.lines,.boxes{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #333;overflow-wrap:anywhere;vertical-align:middle;padding:1mm;font-weight:normal}th{font-weight:bold;background:#eceff1;font-size:8pt;height:9mm;text-align:center}.lines td{height:7.8mm;font-size:8.5pt;line-height:1.3}.lines td:first-child,.lines td:nth-child(6),.lines td:nth-child(7){text-align:center}.customer-start td{border-top:2px solid #111}.box-title{display:flex;justify-content:space-between;margin:3mm 0 1mm;font-weight:bold}.boxes th{height:6mm}.boxes td{height:6mm}.boxes th:nth-child(3n),.boxes td:nth-child(3n){border-right:2px solid #111}footer{display:flex;justify-content:flex-end;gap:12mm;margin-top:3mm}.print-tools{position:sticky;top:0;padding:12px;background:#fff;border-bottom:1px solid #bbb;display:flex;gap:12px;align-items:center;z-index:1}.print-tools button{font:inherit;padding:8px 18px;cursor:pointer}@media print{body{background:white}.print-tools{display:none}.work-page{margin:0;min-height:0}}`;
  const compactCss="body{line-height:1.25}header{padding:1mm 0}h1{line-height:1.2}.meta{padding:2mm 0}.work-header{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #555;border-left:1px solid #555;margin:0 0 2mm;font-size:8.5pt}.work-header>div{display:flex;gap:2mm;padding:1mm 1.5mm;border-right:1px solid #555;border-bottom:1px solid #555;min-width:0}.work-header b{flex:0 0 32mm}.work-header span{overflow-wrap:anywhere;min-width:0}.work-header .header-wide{grid-column:1/-1}.lines th{padding:.6mm;line-height:1.15;height:8mm}.lines td{padding:.6mm;line-height:1.2}.boxes th{line-height:1.15;padding:.5mm}.boxes td{height:5.5mm}footer{margin-top:2mm}";
  function renderPages(model){return model.suppliers.map(s=>s.groups.map(g=>g.pages.map((p,i)=>pageHtml(s,g,p,i,g.pages.length,model.options)).join("")).join("")).join("")}
  function printableDocument(model,scriptUrl){
    const data=JSON.stringify(model).replace(/</g,"\\u003c");
    const profileUrl=String(scriptUrl).replace(/supplier-work-report\.js/,"supplier-work-profile.js");
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>作業明細書</title><style>${css}${compactCss}</style></head><body><nav class="print-tools"><button id="print-work" disabled onclick="window.print()">印刷 / PDF保存</button><span id="print-status">表示を準備中...</span></nav><main id="work-pages">${renderPages(model)}</main><script type="application/json" id="work-report-data">${data}</script><script src="${escape(profileUrl)}"></script><script src="${escape(scriptUrl)}"></script><script>SupplierWorkReport.preparePrint(document);<\/script></body></html>`;
  }
  async function preparePrint(doc){
    if(doc.fonts?.ready)await doc.fonts.ready;
    const model=JSON.parse(doc.getElementById("work-report-data").textContent);
    const measure=doc.createElement("div");measure.style.cssText="position:absolute;height:191mm;width:1px;visibility:hidden";doc.body.append(measure);
    const maxHeight=measure.getBoundingClientRect().height;measure.remove();
    // Reflow long descriptions without losing a row or shrinking the entire sheet.
    let changed=true,pass=0;
    while(changed&&pass++<10000){
      changed=false;let pageIndex=0;const elements=[...doc.querySelectorAll(".work-page")];
      scan:for(const supplier of model.suppliers)for(const group of supplier.groups)for(let i=0;i<group.pages.length;i++){
        const el=elements[pageIndex++];if(!el)break scan;
        if(el.lastElementChild.getBoundingClientRect().bottom-el.getBoundingClientRect().top>maxHeight&&group.pages[i].length>1){
          const removed=group.pages[i].pop();if(!group.pages[i+1])group.pages.push([]);group.pages[i+1].unshift(removed);changed=true;break scan;
        }
      }
      if(changed)doc.getElementById("work-pages").innerHTML=renderPages(model);
    }
    const overflow=[...doc.querySelectorAll(".work-page")].some(el=>el.lastElementChild.getBoundingClientRect().bottom-el.getBoundingClientRect().top>maxHeight);
    doc.getElementById("print-status").textContent=overflow?"備考・連絡事項が長すぎます。Excel出力をご利用ください。":`${model.rowCount}明細 / ${doc.querySelectorAll(".work-page").length}ページ`;
    doc.getElementById("print-work").disabled=overflow;return !overflow;
  }
  function createWorkbook(ExcelJS,supplier,options={}){
    const workbook=new ExcelJS.Workbook();workbook.creator="YUMIRUME";
    supplier.groups.forEach((group,groupIndex)=>{
      const sheet=workbook.addWorksheet(`${groupIndex+1}_${safeName(group.importerCode)}_${safeName(group.siteCode)}`.replace(/[\[\]]/g,"_").slice(0,31),{
        views:[{state:"frozen",ySplit:9,showGridLines:false}],pageSetup:{paperSize:9,orientation:"landscape",fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:0.3,right:0.3,top:0.3,bottom:0.3,header:0.1,footer:0.1}}
      });
      sheet.columns=columns.map(c=>({width:c[1]*0.5}));sheet.pageSetup.printTitlesRow="1:9";
      sheet.headerFooter.oddFooter="&R&P / &N";
      function merged(row,from,to,value,size=10,bold=false){sheet.mergeCells(row,from,row,to);const cell=sheet.getCell(row,from);cell.value=value===""?null:value;cell.font={name:"Yu Gothic",size,bold};cell.alignment={vertical:"middle",wrapText:true}}
      merged(1,1,14,"作業明細書",17,true);sheet.getRow(1).height=28;
      merged(2,1,8,`発注先 ${supplier.code} ${supplier.name}`,11,true);merged(2,9,14,new Date(`${group.date}T00:00:00Z`),11,true);sheet.getCell(2,9).numFmt='"日付 "yyyy-mm-dd';sheet.getRow(2).height=25;
      merged(3,1,8,`輸入社 ${group.importerCode} ${group.importerName}`,11,true);merged(3,9,14,`拠点 ${siteName(group.siteCode)}　箱記号 ${prefixLabel(supplier)}`);sheet.getRow(3).height=25;
      const header=headerValues(group,options);
      function headerCell(row,from,to,field){
        const value=`${Profiles.fields[field]}　${header[field]||"―"}`;merged(row,from,to,value,10);
        const width=columns.slice(from-1,to).reduce((sum,c)=>sum+c[1],0)*0.5;
        const lines=value.split("\n").reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0)/Math.max(1,width-5))),0);
        sheet.getRow(row).height=Math.max(sheet.getRow(row).height||0,lines*14+6);
      }
      headerCell(4,1,8,"destination_name");headerCell(4,9,14,"contact");
      headerCell(5,1,14,"cargo_location");headerCell(6,1,8,"cargo_cut_time");headerCell(6,9,14,"document_cut_time");
      headerCell(7,1,14,"document_method");headerCell(8,1,14,"packing_note");
      columns.forEach((col,i)=>{const cell=sheet.getCell(9,i+1);cell.value=col[0];cell.font={name:"Yu Gothic",size:9,bold:true};cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFECEFF1"}};cell.alignment={vertical:"middle",horizontal:"center",wrapText:true}});sheet.getRow(9).height=28;
      if(Array.from({length:9},(_,i)=>sheet.getRow(i+1).height||0).reduce((sum,height)=>sum+height,0)>330)throw new Error("作業依頼書のヘッダーが長すぎます。梱包・申し送り等を短くしてから出力してください。");
      let cursor=10,previous="";
      group.rows.forEach(row=>{
        const values=cellValues(row);const key=customerKey(row);const newCustomer=key!==previous;previous=key;let lines=2;
        values.forEach((value,index)=>{
          const cell=sheet.getCell(cursor,index+1);cell.value=value===""?null:value;cell.font={name:"Yu Gothic",size:10,color:{argb:index>=7?"FF145AA8":"FF111111"}};
          cell.alignment={vertical:"middle",wrapText:true};cell.border={top:{style:newCustomer?"medium":"thin"},bottom:{style:"thin"},left:{style:"thin"},right:{style:"thin"}};
          if(index===2||index===10)cell.numFmt="@";if([5,7,9,12].includes(index))cell.numFmt="#,##0.###";
          const lineSize=Math.max(1,Math.floor((columns[index][1]-2)/3.5));
          lines=Math.max(lines,...String(value).split("\n").map(line=>Math.ceil([...line].reduce((sum,ch)=>sum+(ch.charCodeAt(0)>255?1:0.5),0)/lineSize)));
          if([8,13].includes(index))cell.dataValidation={type:"list",allowBlank:true,formulae:[`"${units.join(",")}"`],showErrorMessage:true,errorTitle:"単位",error:"Kg、pkt、PC、CSから選択してください。"};
          if([7,9,12].includes(index))cell.dataValidation={type:"decimal",operator:"greaterThanOrEqual",formulae:[0],allowBlank:true,showErrorMessage:true,error:"0以上の数値を入力してください。"};
        });sheet.getRow(cursor++).height=Math.max(24,lines*12);
      });
      merged(cursor,1,14,`箱別重量　箱記号 ${prefixLabel(supplier)}`,10,true);sheet.getRow(cursor++).height=22;
      const ranges=[[1,2],[3,4],[5,7],[8,9],[10,11],[12,14]];
      ranges.forEach(([from,to],i)=>merged(cursor,from,to,["箱番号","グロス重量 kg","ドライアイス kg"][i%3],9,true));sheet.getRow(cursor++).height=22;
      for(let line=0;line<Math.max(4,Math.ceil(group.rows.length/2));line++){
        ranges.forEach(([from,to],i)=>{merged(cursor,from,to,"");const cell=sheet.getCell(cursor,from);cell.numFmt=i%3===0?"@":"#,##0.###";for(let c=from;c<=to;c++)sheet.getCell(cursor,c).border={top:{style:"thin"},bottom:{style:"thin"},left:{style:"thin"},right:{style:"thin"}}});sheet.getRow(cursor++).height=20;
      }
      merged(cursor,1,7,"記入者");merged(cursor,8,14,"確認");sheet.getRow(cursor).height=24;sheet.pageSetup.printArea=`A1:N${cursor}`;
    });return workbook;
  }
  function filename(supplier,index,date){return `${String(index+1).padStart(2,"0")}_作業明細書_${safeName(date)}_${safeName(supplier.code)}_${safeName(supplier.name)}.xlsx`}
  return {columns,units,build,paginate,selectSupplier,cellValues,createWorkbook,printableDocument,preparePrint,renderPages,filename};
});
