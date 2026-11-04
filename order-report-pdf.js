(function(){
  "use strict";
  const libraries={
    html2canvas:["html2canvas@1.4.1/dist/html2canvas.min.js","sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H",()=>window.html2canvas],
    pdf:["jspdf@4.2.1/dist/jspdf.umd.min.js","sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3",()=>window.jspdf?.jsPDF],
    zip:["jszip@3.10.1/dist/jszip.min.js","sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG",()=>window.JSZip]
  };
  const loading=new Map();
  let exporting=false;
  const pxPerMm=96/25.4;
  const namePart=value=>String(value??"").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").replace(/^[. ]+|[. ]+$/g,"").slice(0,65);
  const supplierKey=value=>String(value??"").normalize("NFKC").trim().toLowerCase();

  function loadLibrary(name){
    const [path,integrity,get]=libraries[name];
    if(get())return Promise.resolve(get());
    if(loading.has(name))return loading.get(name);
    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src="https://cdn.jsdelivr.net/npm/"+path;
      script.integrity=integrity;
      script.crossOrigin="anonymous";
      const fail=()=>{
        clearTimeout(timer);
        script.remove();
        loading.delete(name);
        reject(new Error("PDF出力の準備に失敗しました。通信を確認して再度お試しください。"));
      };
      const timer=setTimeout(fail,20000);
      script.onload=()=>{if(!get()){fail();return}clearTimeout(timer);resolve(get())};
      script.onerror=fail;
      document.head.append(script);
    });
    loading.set(name,promise);
    return promise;
  }

  function groupSuppliers(rows){
    const groups=new Map();
    for(const row of rows){
      const key=supplierKey(row.supplierCode);
      if(!key)throw new Error("発注先が未設定の明細があります。発注先を入力してからPDFを保存してください。");
      if(!groups.has(key))groups.set(key,{code:row.supplierCode,name:row.supplierName,rows:[]});
      groups.get(key).rows.push(row);
    }
    return [...groups.values()].sort((a,b)=>supplierKey(a.code).localeCompare(supplierKey(b.code),"ja",{numeric:true}));
  }

  async function withReportDocument(html,render){
    const frame=document.createElement("iframe");
    frame.setAttribute("sandbox","allow-same-origin");
    frame.setAttribute("aria-hidden","true");
    frame.tabIndex=-1;
    frame.style.cssText="position:fixed;left:-2000px;top:0;width:1200px;height:1160px;border:0;pointer-events:none";
    frame.srcdoc=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';img-src data:"></head><body>${html}</body></html>`;
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("帳票の表示を準備できませんでした。")),10000);
        frame.onload=()=>{clearTimeout(timer);resolve()};
        document.body.append(frame);
      });
      const doc=frame.contentDocument;
      if(!doc?.body)throw new Error("帳票を表示できませんでした。");
      await doc.fonts?.ready;
      return await render(doc);
    }finally{
      frame.remove();
    }
  }

  function paginatePurchaseOrder(doc,limit){
    const template=doc.querySelector(".po-page");
    if(!template)return [];
    const rows=[...template.querySelectorAll("tbody tr")];
    template.querySelector("tbody").replaceChildren();
    template.remove();
    let page,body;
    const pages=[];
    function nextPage(){
      page=template.cloneNode(true);
      doc.body.append(page);
      pages.push(page);
      body=page.querySelector("tbody");
    }
    for(const row of rows){
      if(!page)nextPage();
      body.append(row);
      if(page.getBoundingClientRect().height>limit){
        if(body.rows.length===1)throw new Error("発注書の備考または商品名が長すぎて、1ページに収まりません。");
        nextPage();
        body.append(row);
        if(page.getBoundingClientRect().height>limit)throw new Error("発注書の備考または商品名が長すぎて、1ページに収まりません。");
      }
    }
    return pages;
  }

  async function renderPdf(kind,item,capture,Pdf){
    const landscape=kind==="work";
    const width=landscape?281:194;
    const height=landscape?196:281;
    const top=landscape?7:8;
    const layoutCss=`<style>body{background:#fff}.po-page{width:194mm;min-height:0}.po-page td:last-child,.ticket-memo strong{white-space:pre-wrap}.work-page{margin:0;min-height:0}</style>`;
    return withReportDocument(item.html+layoutCss,async doc=>{
      let pages;
      if(kind==="purchase"){
        pages=paginatePurchaseOrder(doc,height*pxPerMm-2);
      }else if(landscape){
        const root=doc.getElementById("work-pages");
        if(!SupplierWorkReport.reflowPages(root,item.model,191*pxPerMm))throw new Error("作業明細書の備考・連絡事項が長すぎます。Excel出力をご利用ください。");
        pages=[...root.querySelectorAll(".work-page")];
      }else{
        pages=[...doc.querySelectorAll(".ticket-page")];
        if(pages.some(page=>[...page.children].some(ticket=>ticket.scrollHeight>ticket.clientHeight+2))){
          throw new Error("現品票の備考または商品名が長すぎて、1枚に収まりません。");
        }
      }
      if(!pages.length)throw new Error("出力対象の明細がありません。");
      const pdf=new Pdf({orientation:landscape?"landscape":"portrait",unit:"mm",format:"a4",compress:true});
      for(const [index,page] of pages.entries()){
        const bounds=page.getBoundingClientRect();
        const canvas=await capture(page,{backgroundColor:"#ffffff",scale:2,logging:false});
        try{
          if(!canvas.width||!canvas.height)throw new Error("PDFに帳票を描画できませんでした。");
          if(index)pdf.addPage();
          pdf.addImage(canvas.toDataURL("image/jpeg",0.94),"JPEG",8,top,width,Math.min(height,bounds.height/pxPerMm));
        }finally{
          canvas.width=canvas.height=0;
        }
      }
      return pdf.output("arraybuffer");
    });
  }

  function download(buffer,name,type){
    const url=URL.createObjectURL(new Blob([buffer],{type}));
    const link=document.createElement("a");
    link.href=url;
    link.download=name;
    document.body.append(link);
    try{link.click()}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
  }

  async function save(kind,title,build){
    if(exporting)return;
    exporting=true;
    let file;
    setAppBusy(true,`${title}のPDFを作成中...`);
    try{
      const result=await build();
      if(!result?.documents.length)return;
      const {date,scope,documents}=result;
      const multiple=documents.length>1;
      const [capture,Pdf,Zip]=await Promise.all([loadLibrary("html2canvas"),loadLibrary("pdf"),multiple?loadLibrary("zip"):null]);
      const zip=Zip?new Zip():null;
      for(const [index,item] of documents.entries()){
        if(multiple)setAppBusy(true,`${title}のPDFを作成中... ${index+1}/${documents.length}`);
        const buffer=await renderPdf(kind,item,capture,Pdf);
        const base=[title,date,item.code,item.name,scope].map(namePart).filter(Boolean).join("_");
        const name=`${multiple?String(index+1).padStart(2,"0")+"_":""}${base}.pdf`;
        if(zip)zip.file(name,buffer);
        else file={buffer,name,type:"application/pdf"};
      }
      if(zip)file={buffer:await zip.generateAsync({type:"uint8array"}),name:`${[title,date,scope,"発注先別"].map(namePart).filter(Boolean).join("_")}.zip`,type:"application/zip"};
    }catch(error){
      alert(error?.message||"PDFを作成できませんでした。");
    }finally{
      exporting=false;
      setAppBusy(false);
    }
    // The app's busy guard also intercepts programmatic clicks.
    if(file)download(file.buffer,file.name,file.type);
  }

  window.OrderReportPdf={groupSuppliers,save};
})();
