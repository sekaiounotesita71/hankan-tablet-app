(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.DomesticDocuments=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const issuer=Object.freeze({
    name:"株式会社ゆみるめ",registrationNumber:"T8120001233117",
    address:"〒556-0004 大阪市浪速区日本橋西2-2-11",
    contact:"TEL 06-6537-9994　FAX 06-6536-8496",email:"info@yumirume.co.jp"
  });
  const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money=value=>Number(value).toLocaleString("ja-JP",{maximumFractionDigits:0});
  const decimal=value=>Number(value).toLocaleString("ja-JP",{maximumFractionDigits:4});
  function yen(value,label){
    if(value==null||value===""||!Number.isSafeInteger(Number(value)))throw new Error(`${label}が未設定、または円単位ではありません。帳票を作成できません。`);
    return Number(value);
  }
  function required(value,label){
    if(!String(value??"").trim())throw new Error(`${label}がありません。帳票を作成できません。`);
  }
  function assertIssuer(company){
    required(company?.name,"発行者名");
    if(!/^T\d{13}$/.test(company?.registrationNumber||""))throw new Error("適格請求書の登録番号（T＋13桁）が未設定です。");
  }
  function validateSale(sale){
    required(sale?.id,"売上ID");required(sale.sale_no,"納品書番号");required(sale.sale_date,"取引日");
    required(sale.customer_code,"得意先コード");required(sale.customer_name_snapshot,"得意先名");
    if(sale.status!=="confirmed")throw new Error(`${sale.sale_no} は取消済み、または未確定です。`);
    if(!Array.isArray(sale.lines)||!sale.lines.length)throw new Error(`${sale.sale_no} の明細がありません。再読込してください。`);
    const bases={8:0,10:0};const numbers=new Set();
    for(const line of sale.lines){
      required(line.product_name_snapshot,"商品名");required(line.unit,"単位");
      if(line.sale_id&&line.sale_id!==sale.id)throw new Error("他の納品書の明細が混在しています。");
      const rate=Number(line.tax_rate),no=Number(line.line_no);
      if(![8,10].includes(rate))throw new Error(`${sale.sale_no} に税率未設定の明細があります。`);
      if(!Number.isInteger(no)||no<1||numbers.has(no))throw new Error("納品明細番号が重複、または不正です。");
      numbers.add(no);
      if(line.quantity==null||!Number.isFinite(Number(line.quantity))||Number(line.quantity)<=0||line.unit_price_jpy==null||!Number.isFinite(Number(line.unit_price_jpy))||Number(line.unit_price_jpy)<0)throw new Error("数量・単価を確認してください。");
      const amount=yen(line.net_amount_jpy,"明細金額");if(amount<0)throw new Error("返品明細は通常の納品書では出力できません。");
      bases[rate]+=amount;
    }
    const shipping=yen(sale.shipping_amount_jpy,"送料");if(shipping<0)throw new Error("送料を確認してください。");
    if(bases[8]!==yen(sale.product_subtotal_8_jpy,"8％商品計")||bases[10]!==yen(sale.product_subtotal_10_jpy,"10％商品計"))throw new Error(`${sale.sale_no} の明細と税率別金額が一致しません。再読込してください。`);
    bases[10]+=shipping;
    const taxes={8:yen(sale.tax_8_jpy,"8％消費税"),10:yen(sale.tax_10_jpy,"10％消費税")};
    // Keep the persisted per-delivery tax. Never recalculate monthly tax for display.
    for(const rate of [8,10])if(taxes[rate]!==Number(BigInt(yen(bases[rate],"税率別対象額"))*BigInt(rate)/100n))throw new Error(`${sale.sale_no} の${rate}％消費税が税率別の端数処理と一致しません。`);
    if(yen(sale.total_net_jpy,"税抜合計")!==bases[8]+bases[10]||yen(sale.tax_total_jpy,"消費税計")!==taxes[8]+taxes[10]||yen(sale.total_amount_jpy,"税込合計")!==bases[8]+bases[10]+taxes[8]+taxes[10])throw new Error(`${sale.sale_no} の合計金額が一致しません。`);
    return{bases,taxes};
  }
  function validateInvoice(closing,sales){
    if(closing?.status!=="closed")throw new Error("解除済み、または未確定の請求書は出力できません。");
    for(const key of ["invoice_no","period_from","period_to","customer_code","customer_name_snapshot"])required(closing[key],"請求情報");
    const charges=closing.snapshot?.charges;
    if(!Array.isArray(charges))throw new Error("請求締めの対象明細がありません。再読込してください。");
    const seen=new Set();let chargeTotal=0;
    const totals={base8:0,base10:0,tax8:0,tax10:0,gross:0};
    for(const charge of charges){
      const amount=yen(charge.amount_jpy,"請求対象額");chargeTotal+=amount;
      if(!charge.sale_id){
        if(charge.source_type!=="opening")throw new Error("税率の確認できない調整明細があります。請求内容を確認してください。");
        continue;
      }
      if(seen.has(charge.sale_id))throw new Error("請求対象の納品書が重複しています。");
      seen.add(charge.sale_id);
      const sale=sales.find(row=>row.id===charge.sale_id);
      if(!sale)throw new Error("請求対象の納品書が読み込めません。再読込してください。");
      const detail=validateSale(sale);
      if(sale.customer_code!==closing.customer_code||sale.sale_date!==charge.invoice_date||sale.sale_date<closing.period_from||sale.sale_date>closing.period_to||Number(sale.total_amount_jpy)!==amount)throw new Error(`${sale.sale_no} と締め済み請求情報が一致しません。`);
      totals.base8+=detail.bases[8];totals.base10+=detail.bases[10];totals.tax8+=detail.taxes[8];totals.tax10+=detail.taxes[10];totals.gross+=amount;
    }
    if(seen.size!==sales.length||new Set(sales.map(s=>s.id)).size!==sales.length)throw new Error("請求対象外、または重複した納品書が含まれています。");
    if(chargeTotal!==yen(closing.sales_amount_jpy,"今回計上額")||yen(closing.carryover_amount_jpy,"前回繰越")+chargeTotal-yen(closing.payment_amount_jpy,"期間内入金")!==yen(closing.billing_amount_jpy,"今回請求額"))throw new Error("締め済み請求額と対象明細が一致しません。再読込してください。");
    return totals;
  }
  function companyHtml(company,logoUrl){
    assertIssuer(company);
    return`<div class="company"><img class="company-logo" src="${esc(logoUrl)}" alt="YUMIRUME INC."><b>${esc(company.name)}</b><br><strong>登録番号：${esc(company.registrationNumber)}</strong><br>${esc(company.address)}<br>${esc(company.contact)}<br>${esc(company.email)}</div>`;
  }
  function recipient(name,customer){
    return`<div class="customer-name">${esc(name)} 御中</div><div class="address">${esc([customer.postal_code?`〒${customer.postal_code}`:"",customer.address_text,customer.phone?`TEL ${customer.phone}`:""].filter(Boolean).join("\n"))}</div>`;
  }
  function taxTable(bases,taxes,reference=false){
    return`<table class="tax-table"><caption>${reference?"納品書別金額・消費税額の合計（参考）":"税率別内訳"}</caption><thead><tr><th>税率</th><th>対象額（税抜）</th><th>消費税額</th><th>税込金額</th></tr></thead><tbody>${[8,10].map(rate=>`<tr><th>${rate}％${rate===8?"（軽減税率）":""}</th><td>${money(bases[rate])}円</td><td>${money(taxes[rate])}円</td><td>${money(bases[rate]+taxes[rate])}円</td></tr>`).join("")}</tbody></table>`;
  }
  function delivery(sale,customer={},options={}){
    const {bases,taxes}=validateSale(sale),company=options.issuer||issuer;
    const rows=[...sale.lines].sort((a,b)=>a.line_no-b.line_no).map(line=>`<tr><td class="center">${esc(line.line_no)}</td><td>${esc(line.product_code||"")}</td><td>${esc(line.product_name_snapshot)}${Number(line.tax_rate)===8?' <span class="reduced">※</span>':""}</td><td class="num">${decimal(line.quantity)}</td><td class="center">${esc(line.unit)}</td><td class="num">${decimal(line.unit_price_jpy)}</td><td class="center">${esc(line.tax_rate)}％</td><td class="num">${money(line.net_amount_jpy)}</td></tr>`).join("");
return`<main class="document delivery-document"><h1 class="doc-title">${options.invoiceNo?"納品明細書":"納 品 書"}</h1><div class="doc-top"><div>${recipient(sale.customer_name_snapshot,customer)}<table class="meta"><tr><th>取引日</th><td>${esc(sale.sale_date)}</td></tr><tr><th>納品書番号</th><td>${esc(sale.sale_no)}</td></tr>${options.invoiceNo?`<tr><th>合計請求書番号</th><td>${esc(options.invoiceNo)}</td></tr>`:""}</table></div>${companyHtml(company,options.logoUrl)}</div><table class="lines"><colgroup><col style="width:5%"><col style="width:12%"><col><col style="width:8%"><col style="width:7%"><col style="width:12%"><col style="width:7%"><col style="width:15%"></colgroup><thead><tr><th>No.</th><th>商品コード</th><th>商品名</th><th>数量</th><th>単位</th><th>単価（税抜）</th><th>税率</th><th>金額（税抜）</th></tr></thead><tbody>${rows}${Number(sale.shipping_amount_jpy)>0?`<tr><td></td><td></td><td>送料</td><td></td><td></td><td></td><td class="center">10％</td><td class="num">${money(sale.shipping_amount_jpy)}</td></tr>`:""}</tbody></table><p class="legend">※は軽減税率（8％）対象品目です。</p><div class="totals-block">${taxTable(bases,taxes)}<table class="summary"><tr><th>税抜合計</th><td>${money(sale.total_net_jpy)}円</td></tr><tr><th>消費税合計</th><td>${money(sale.tax_total_jpy)}円</td></tr><tr><th>税込合計</th><td>${money(sale.total_amount_jpy)}円</td></tr></table></div>${sale.memo?`<div class="note">備考　${esc(sale.memo)}</div>`:""}</main>`;
  }
  function invoice(closing,sales,customer={},options={}){
    // NTA invoice Q&A 67: link each delivery document to the monthly statement,
    // retaining the tax rounded once per rate on each delivery document.
    const totals=validateInvoice(closing,sales),company=options.issuer||issuer;
    const sorted=[...sales].sort((a,b)=>a.sale_date.localeCompare(b.sale_date)||a.sale_no.localeCompare(b.sale_no));
    const rows=sorted.map(sale=>`<tr><td>${esc(sale.sale_date)}</td><td>${esc(sale.sale_no)}</td><td class="num">${money(sale.total_net_jpy)}</td><td class="num">${money(sale.tax_total_jpy)}</td><td class="num">${money(sale.total_amount_jpy)}</td></tr>`).join("");
    const opening=closing.snapshot.charges.filter(row=>!row.sale_id).reduce((sum,row)=>sum+Number(row.amount_jpy),0);
    const cover=`<main class="document invoice-cover"><h1 class="doc-title">合 計 請 求 書</h1><div class="doc-top"><div>${recipient(closing.customer_name_snapshot,customer)}<table class="meta"><tr><th>請求書番号</th><td>${esc(closing.invoice_no)}</td></tr><tr><th>請求期間</th><td>${esc(closing.period_from)} ～ ${esc(closing.period_to)}</td></tr><tr><th>請求日</th><td>${esc(closing.period_to)}</td></tr><tr><th>支払期限</th><td>${esc(closing.due_date||"")}</td></tr></table></div>${companyHtml(company,options.logoUrl)}</div><div class="amount-due"><span>今回ご請求額</span><strong>${money(closing.billing_amount_jpy)} 円</strong></div><table class="lines"><colgroup><col style="width:16%"><col style="width:33%"><col style="width:17%"><col style="width:17%"><col style="width:17%"></colgroup><thead><tr><th>取引日</th><th>納品書番号</th><th>税抜金額</th><th>消費税額</th><th>税込金額</th></tr></thead><tbody>${rows||'<tr><td colspan="5" class="center">当期の納品なし</td></tr>'}</tbody></table><div class="totals-block">${taxTable({8:totals.base8,10:totals.base10},{8:totals.tax8,10:totals.tax10},true)}<table class="summary"><tr><th>前回繰越</th><td>${money(closing.carryover_amount_jpy)}円</td></tr><tr><th>今回売上（税込）</th><td>${money(totals.gross)}円</td></tr>${opening?`<tr><th>開始残高（今回売上対象外）</th><td>${money(opening)}円</td></tr>`:""}<tr><th>期間内入金</th><td>${money(closing.payment_amount_jpy)}円</td></tr><tr><th>今回ご請求額</th><td>${money(closing.billing_amount_jpy)}円</td></tr></table></div><p class="note">本書と添付の納品明細書を合わせて適格請求書とします。<br>消費税額は納品書単位・税率ごとに計算し、1円未満を切り捨てています。</p></main>`;
    return cover+sorted.map(sale=>delivery(sale,customer,{...options,issuer:company,invoiceNo:closing.invoice_no})).join("");
  }
  function css(){return`<style>@page{size:A4 portrait;margin:12mm}*{box-sizing:border-box;letter-spacing:0}body{margin:0;color:#111;background:#fff;font-family:"Yu Gothic",Meiryo,sans-serif;font-size:9pt}.print-actions{display:flex;gap:8px;margin-bottom:6mm}.print-actions button{padding:8px 14px;border:1px solid #555;background:#fff;font:inherit;font-weight:700}.document{max-width:186mm;margin:0 auto 12mm}.document+.document{break-before:page;page-break-before:always;border-top:1px solid #aaa;padding-top:8mm}.doc-title{text-align:center;font-size:21pt;font-weight:900;margin:0 0 7mm}.doc-top{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:7mm;margin-bottom:5mm;break-inside:avoid}.customer-name{font-size:14pt;font-weight:700;border-bottom:1px solid #111;padding:0 0 2mm;overflow-wrap:anywhere}.address{white-space:pre-line;line-height:1.5;margin-top:2mm;overflow-wrap:anywhere}.company{text-align:right;line-height:1.6;font-size:8.3pt;overflow-wrap:anywhere}.company-logo{display:block;width:31mm;height:19mm;object-fit:contain;margin:0 0 1mm auto}.company b{font-size:11pt}.meta{width:100%;border-collapse:collapse;margin-top:3mm;font-size:8pt}.meta th,.meta td{border:1px solid #777;padding:1.6mm;overflow-wrap:anywhere}.meta th{width:30%;white-space:nowrap;background:#f2f2f2}.amount-due{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111;margin:4mm 0;padding:0 2mm 2mm;font-size:12pt;font-weight:700}.amount-due strong{font-size:20pt}.lines{width:100%;border-collapse:collapse;table-layout:fixed}.lines th,.lines td{border:1px solid #777;padding:1.7mm 1.2mm;vertical-align:top;overflow-wrap:anywhere}.lines th{background:#eee;text-align:center;font-size:8pt}.lines thead{display:table-header-group}.lines tr{break-inside:avoid;page-break-inside:avoid}.num{text-align:right;font-variant-numeric:tabular-nums}.center{text-align:center}.reduced{white-space:nowrap}.legend{font-size:8pt;margin:2mm 0}.totals-block{break-inside:avoid;page-break-inside:avoid}.tax-table{width:100%;margin-top:4mm;border-collapse:collapse;font-size:8.5pt}.tax-table caption{text-align:left;font-weight:700;margin-bottom:1.5mm}.tax-table th,.tax-table td{border:1px solid #777;padding:2mm}.tax-table th{background:#f2f2f2}.tax-table td{text-align:right;white-space:nowrap}.summary{width:92mm;margin:4mm 0 0 auto;border-collapse:collapse}.summary th,.summary td{border:1px solid #777;padding:1.8mm}.summary th{background:#f2f2f2;text-align:left}.summary td{text-align:right;white-space:nowrap;font-weight:700}.note{margin-top:4mm;border-top:1px solid #aaa;padding-top:2mm;font-size:8pt;line-height:1.5;break-inside:avoid}@media print{.print-actions{display:none}.document{max-width:none;margin:0}.document+.document{border-top:0;padding-top:0}}</style>`;}
  return{issuer,assertIssuer,validateSale,validateInvoice,companyHtml,delivery,invoice,css};
});
