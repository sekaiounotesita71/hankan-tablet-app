(function(){
  "use strict";
  let exporting=false;const libraryLoads=new Map();
  const reportScriptUrl=new URL("./supplier-work-report.js?v=20260923-1",document.currentScript?.src||location.href).href;
  function library(name,url){
    if(window[name])return Promise.resolve(window[name]);if(libraryLoads.has(name))return libraryLoads.get(name);
    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement("script");script.src=url;
      const fail=()=>{clearTimeout(timer);script.remove();libraryLoads.delete(name);reject(new Error("Excel出力の読み込みに失敗しました。通信を確認して再度お試しください。"))};
      const timer=setTimeout(fail,30000);
      script.onload=()=>{clearTimeout(timer);window[name]?resolve(window[name]):fail()};script.onerror=fail;document.head.append(script);
    });libraryLoads.set(name,promise);return promise;
  }
  function options(){return {suppliers:getMasters().suppliers||[],destination:document.getElementById("work-report-destination")?.value||"",contact:document.getElementById("work-report-contact")?.value||"",note:document.getElementById("work-report-note")?.value||""}}
  function download(buffer,name,type){
    const url=URL.createObjectURL(new Blob([buffer],{type}));const link=document.createElement("a");link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function output(kind){
    if(exporting)return;const filter={...reportFilter()};
    if(!filter.date){alert("帳票出力の日付を指定してください");return}
    let popup=null;if(kind==="pdf"){popup=openPrintLoadingWindow("作業明細書");if(!popup)return}
    exporting=true;setAppBusy(true,"作業明細書を作成中...");
    try{
      const settings=options();const source=await reportRowsForPrint(false);
      if(JSON.stringify(filter)!==JSON.stringify(reportFilter()))throw new Error("出力条件が変更されました。もう一度出力してください。");
      const rows=SupplierWorkReport.selectSupplier(source,filter.supplier,settings.suppliers);const model=SupplierWorkReport.build(rows,settings);
      if(kind==="pdf"){
        popup.document.open();popup.document.write(SupplierWorkReport.printableDocument(model,reportScriptUrl));popup.document.close();
      }else{
        const ExcelJS=await library("ExcelJS","https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js");const multiple=model.suppliers.length>1;
        const Zip=multiple?await library("JSZip","https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"):null;const zip=multiple?new Zip():null;
        for(let i=0;i<model.suppliers.length;i++){
          const supplier=model.suppliers[i];const book=SupplierWorkReport.createWorkbook(ExcelJS,supplier,model.options);const buffer=await book.xlsx.writeBuffer();const name=SupplierWorkReport.filename(supplier,i,filter.date);
          if(zip)zip.file(name,buffer);else download(buffer,name,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        }
        if(zip)download(await zip.generateAsync({type:"uint8array",compression:"DEFLATE"}),`作業明細書_${filter.date}_発注先別.zip`,"application/zip");
      }
    }catch(error){if(popup&&!popup.closed)popup.close();alert(error?.message||"作業明細書の出力に失敗しました。")}
    finally{exporting=false;setAppBusy(false)}
  }
  window.printSupplierWorkStatements=()=>output("pdf");window.exportSupplierWorkStatements=()=>output("excel");
})();
