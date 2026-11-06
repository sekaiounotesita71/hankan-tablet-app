(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.AccountingReportLayout=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function css(orientation='landscape',summaryCount=4){
    const paper=orientation==='portrait'?'portrait':'landscape';
    const count=Math.min(Math.max(summaryCount,1),4);
    return `<style>
    @page{size:A4 ${paper};margin:10mm}
    *{box-sizing:border-box}body{margin:0;color:#111;background:#fff;font-family:"Yu Gothic","Meiryo",sans-serif;font-size:9pt;line-height:1.4;letter-spacing:0}
    .print-actions{display:flex;gap:8px;margin:0 0 7mm}.print-actions button{padding:8px 16px;border:1px solid #333;background:#fff;font:inherit;font-weight:700;cursor:pointer}
    header{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:3mm;margin-bottom:3mm}h1{font-size:19pt;letter-spacing:0;margin:0}.report-brand{display:flex;align-items:center;gap:3mm}.report-brand img{display:block;width:25mm;height:15mm;object-fit:contain}.company{text-align:right;font-weight:700}.subtitle{font-size:10pt;margin-top:1mm;color:#333}
    .meta{display:flex;flex-wrap:wrap;gap:2mm 7mm;margin:0 0 3mm}.meta span{white-space:nowrap}.summary{display:grid;grid-template-columns:repeat(${count},1fr);gap:2mm;margin:0 0 4mm}.summary-item{border:1px solid #777;padding:2.5mm 3mm}.summary-item span{display:block;font-size:8pt;color:#444}.summary-item b{display:block;text-align:right;font-size:13pt;margin-top:.5mm}
    table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th,td{border:1px solid #777;padding:1.6mm 1.8mm;vertical-align:top;overflow-wrap:anywhere}th{background:#e9edf2;text-align:left;font-size:8pt}.money{text-align:right;white-space:nowrap}.center{text-align:center}.code{font-family:Consolas,"Courier New",monospace}.negative{color:#b42318}.muted{color:#555}.total-row td{font-weight:700;border-top:2px solid #111}.portrait th:nth-child(1){width:21mm}.portrait th:nth-child(2){width:20mm}.portrait th:nth-child(3){width:32mm}.portrait th:nth-child(5),.portrait th:nth-child(6),.portrait th:nth-child(7){width:25mm}
    footer{margin-top:3mm;text-align:right;color:#555;font-size:7.5pt}
    .payable-report th.money,.payable-report td.money{white-space:normal}
    .period-report{max-width:277mm;margin:0 auto;padding:5mm 0}.period-report th{white-space:pre-line!important;font-size:8pt;background:#fff;border-left:0;border-right:0;border-top:1.5px solid #111;border-bottom:1.5px solid #111}.period-report td{border-left:0;border-right:0;padding-top:2mm;padding-bottom:2mm}.report-cell-line{min-height:1.65em;white-space:nowrap}.period-report .summary{display:flex;flex-wrap:wrap;gap:4mm}.period-report .summary-item{flex:1;min-width:36mm;border:0;border-bottom:1px solid #777;padding:1mm}.period-report .summary-item b{font-size:11pt}.period-report .meta span{white-space:normal}.period-report .total-row td{border-bottom:2px solid #111}.period-report .money{font-variant-numeric:tabular-nums}.period-report h1{font-size:17pt}
    .period-report .repeat-label{text-align:left;border:0;font-size:8pt;padding:1mm 0}
    @media screen and (max-width:800px){.period-report{min-width:1000px}}
    @media print{.print-actions{display:none}body{font-size:8.5pt}a{color:inherit;text-decoration:none}.period-report{min-width:0;max-width:none;padding:0;margin:0}thead{display:table-header-group}}
    </style>`;
  }
  function create({title,subtitle='',meta=[],summary=[],headers=[],rows=[],orientation='landscape',layout='',company='株式会社ゆみるめ',logoUrl='',issuedAt='',repeatLabel=''}){
    const paper=orientation==='portrait'?'portrait':'landscape';
    const summaryHtml=summary.map(item=>`<div class="summary-item"><span>${esc(item.label)}</span><b>${esc(item.value)}</b></div>`).join('');
    const headerHtml=headers.map(header=>`<th class="${esc(header.className||'')}"${header.width?` style="width:${esc(header.width)}"`:''}>${esc(header.label||header)}</th>`).join('');
    const columns=headers.map(header=>`<col${header.width?` style="width:${esc(header.width)}"`:''}>`).join('');
    const bodyHtml=rows.map(row=>`<tr${row.total?' class="total-row"':''}>${(row.cells||row).map(cell=>{
      const data=cell&&typeof cell==='object'?cell:{text:cell};
      return `<td class="${esc(data.className||'')}">${data.lines?data.lines.map(line=>`<div class="report-cell-line">${esc(line)}</div>`).join(''):esc(data.text??'')}</td>`;
    }).join('')}</tr>`).join('');
    const repeat=repeatLabel?`<tr><th class="repeat-label" colspan="${headers.length}">${esc(repeatLabel)}</th></tr>`:'';
    const body=`<main class="accounting-report ${paper}${title==='買掛一覧表'?' payable-report':''}${layout==='period'?' period-report':''}">
      <header><div><h1>${esc(title)}</h1>${subtitle?`<div class="subtitle">${esc(subtitle)}</div>`:''}</div><div class="report-brand">${logoUrl?`<img src="${esc(logoUrl)}" alt="YUMIRUME INC.">`:''}<div class="company">${esc(company)}</div></div></header>
      ${meta.length?`<div class="meta">${meta.filter(Boolean).map(item=>`<span>${esc(item)}</span>`).join('')}</div>`:''}
      ${summary.length?`<div class="summary">${summaryHtml}</div>`:''}
      <table><colgroup>${columns}</colgroup><thead>${repeat}<tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
      ${issuedAt?`<footer>出力日時 ${esc(issuedAt)}</footer>`:''}</main>`;
    const styles=css(paper,summary.length);
    const actions='<div class="print-actions"><button onclick="window.print()">印刷 / PDF保存</button><button onclick="window.close()">閉じる</button></div>';
    return {title,body,styles,html:`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${styles}</head><body>${actions}${body}</body></html>`};
  }
  return {create,css};
});
