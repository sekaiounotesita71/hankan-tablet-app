(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./accounting-period-report.js'),require('./domestic-payment-model.js'),require('./reference-sites.js'));
  else root.DomesticReceivableReport=factory(root.AccountingPeriodReport,root.DomesticPayments,root.ReferenceSites);
})(typeof globalThis!=='undefined'?globalThis:this,function(period,paymentsModel,sites){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
  function amount(value,label){
    if(value===null||value===undefined||value===''||!Number.isFinite(Number(value)))throw Error(`${label}を読み込めません。帳票は作成していません。`);
    return Math.round(Number(value)*100)/100;
  }
  function range(text){
    const match=String(text||'').normalize('NFKC').trim().match(/^(\d{8})\s*[-~～]\s*(\d{8})$/);
    if(!match)throw Error('対象期間を 20260901-20260930 の形式で入力してください。');
    const day=s=>period.date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
    const result={from:day(match[1]),to:day(match[2])};
    if(result.from>result.to)throw Error('開始日は終了日以前にしてください。');
    return result;
  }
  function selectRows({receivables,closings,range:dates,scope='posted',site='',customer=''}){
    const to=period.date(dates.to),from=period.date(dates.from);
    if(from>to)throw Error('開始日は終了日以前にしてください。');
    if(!['posted','all'].includes(scope))throw Error('集計対象を選択してください。');
    const rows=receivables.filter(row=>row.status!=='cancelled'&&(!customer||row.customer_code===customer)&&sites.matches(row,site));
    if(scope==='all')return rows;
    // Closing totals include carryover. Select underlying receivables once, never sum closing totals.
    const eligible=closings.filter(row=>row.status==='closed'&&period.date(row.period_to)<=to);
    const included=new Set();
    for(const closing of paymentsModel.latestClosings(eligible)){
      if(!Array.isArray(closing.snapshot?.charges)||!Number.isFinite(Date.parse(closing.closed_at)))throw Error('締め履歴の対象明細を確認できません。再読込してください。');
      for(const row of paymentsModel.targets(closing,rows))included.add(row.id);
    }
    return rows.filter(row=>period.date(row.invoice_date)<=to&&(row.source_type==='opening'||included.has(row.id)));
  }
  function build(options){
    const rows=selectRows(options),sales=new Map(),identities=new Map();
    for(const sale of options.sales||[]){if(!sale.id||sales.has(sale.id))throw Error('売上IDが空欄または重複しています。');sales.set(sale.id,sale)}
    for(const customer of options.customers||[])identities.set(customer.customer_code,customer.customer_name);
    const records=rows.map(row=>{
      const gross=amount(row.amount_jpy,'売掛金額'),sale=sales.get(row.sale_id);
      const inPeriod=row.invoice_date>=options.range.from&&row.invoice_date<=options.range.to;
      let tax=0;
      if(row.sale_id&&inPeriod){
        if(!sale||sale.status!=='confirmed'||sale.customer_code!==row.customer_code||sale.sale_date!==row.invoice_date||amount(sale.total_amount_jpy,'売上合計')!==gross)throw Error(`${row.customer_code} ${row.invoice_date} の売上と売掛が一致しません。再読込してください。`);
        tax=amount(sale.tax_total_jpy,'消費税額');
        if(amount(amount(sale.total_net_jpy,'税抜売上')+tax,'売上合計')!==gross)throw Error('売上の税抜・消費税・税込合計が一致しません。');
      }else if(inPeriod&&row.source_type!=='opening')throw Error('売上との紐づけがない明細があります。税内訳を確認してください。');
      return {id:row.id,key:row.customer_code,code:row.customer_code,name:identities.get(row.customer_code)||row.customer_name_snapshot||row.customer_code,date:row.invoice_date,amount:gross,tax,taxKnown:true,sourceType:row.source_type,reference:sale?.sale_no||'',description:row.source_type==='opening'?'初期残高':row._referenceSite?sites.label(row):'国内売上'};
    });
    const ids=new Set(rows.map(row=>row.id));
    const payments=(options.payments||[]).filter(row=>ids.has(row.receivable_id)&&period.date(row.payment_date)<=options.range.to).map(row=>{
      const settled=amount(row.amount_jpy,'入金消込額');
      // Legacy payments settled cash only; grouped payments store cash + fee in amount_jpy.
      const cash=row.cash_amount_jpy==null?settled:amount(row.cash_amount_jpy,'入金額');
      const fee=row.cash_amount_jpy==null?0:amount(row.bank_fee_jpy,'手数料');
      if(cash<0||fee<0||amount(cash+fee,'消込額')!==settled)throw Error('入金額と手数料消込額が一致しません。');
      return {id:row.id,recordId:row.receivable_id,date:row.payment_date,cash,fee,reference:row.reference_no||'',description:fee?`入金 ${money(cash)} / 手数料消込 ${money(fee)}`:'入金'};
    });
    return {...period.build({records,payments,range:options.range,kind:'ar'}),scope:options.scope||'posted',site:options.site||'',customer:options.customer||''};
  }
  function document(report,{detail=false,company='株式会社ゆみるめ',issuedAt=''}={}){
    if(!report.items.length)throw Error('対象期間に残高または取引がありません。');
    if(detail&&(!report.customer||report.items.length!==1))throw Error('得意先明細は得意先コードを1つ選択してください。');
    const title=detail?'国内 得意先明細表':'国内 売掛一覧表',total=report.totals;
    const num=n=>`<td class="num">${money(n)}</td>`;
    const listRow=row=>`<tr${row===total?' class="total"':''}><td>${esc(row===total?'合計':row.code)}</td><td>${esc(row===total?'':row.name||'')}</td>${[row.opening,row.net,row.tax,row.adjustment,row.cash,row.fee,row.balance].map(num).join('')}</tr>`;
    let table;
    if(detail){
      const row=report.items[0];
      let last=`<tr class="total"><td colspan="4">合計</td>${num(row.charges)}${num(row.cash+row.fee)}${num(row.balance)}</tr>`;
      table=`<h2>${esc(row.code)} ${esc(row.name)}</h2><table><colgroup><col style="width:23mm"><col style="width:18mm"><col style="width:44mm"><col><col style="width:31mm"><col style="width:31mm"><col style="width:31mm"></colgroup><thead><tr><th>日付</th><th>区分</th><th>管理番号</th><th>内容</th><th>売上・調整（税込）</th><th>入金・消込</th><th>売掛残高</th></tr></thead><tbody><tr><td>${esc(report.range.from)}</td><td>繰越</td><td></td><td>期間開始前残高</td><td></td><td></td>${num(row.opening)}</tr>${row.events.map(event=>`<tr><td>${esc(event.date)}</td><td>${esc(event.type)}</td><td>${esc(event.reference)}</td><td>${esc(event.description)}</td>${num(event.debit)}${num(event.credit)}${num(event.balance)}</tr>`).join('')}${last}</tbody></table>`;
    }else{
      table=`<table><colgroup><col style="width:16mm"><col style="width:43mm">${'<col style="width:30mm">'.repeat(7)}</colgroup><thead><tr><th>コード</th><th>得意先名</th><th>期首残高</th><th>期間売上<br>（税抜・送料込）</th><th>消費税</th><th>調整・初期登録</th><th>期間入金額</th><th>手数料消込</th><th>期末売掛残高<br>（税込）</th></tr></thead><tbody>${report.items.map(listRow).join('')}${listRow(total)}</tbody></table>`;
    }
    const repeatLabel=`${title} ／ ${report.range.from} ～ ${report.range.to}${detail?` ／ ${report.items[0].code} ${report.items[0].name}`:''}`;
    table=table.replace('<thead>','<thead><tr><th colspan="'+(detail?7:9)+'" style="text-align:left;background:#fff">'+esc(repeatLabel)+'</th></tr>');
    return {title,body:`<main class="ar-report"><header><div><h1>${title}</h1><div class="meta">対象期間 ${esc(report.range.from)} ～ ${esc(report.range.to)} ／ 残高基準日 ${esc(report.range.to)}</div><div class="meta">${report.scope==='posted'?'締め済み＋初期残高':'登録済みすべて（未締め含む）'} ／ ${esc(sites.label(report.site))} ／ ${report.customer?`得意先 ${esc(report.customer)}`:'全得意先'} ／ 単位：円</div></div><div class="issuer">${esc(company)}${issuedAt?`<br>出力日 ${esc(issuedAt)}`:''}</div></header><div class="summary">${[['期首残高',total.opening],['期間売上・調整（税込）',total.charges],['期間入金・消込',total.cash+total.fee],['期末売掛残高（税込）',total.balance]].map(([label,n])=>`<div><span>${label}</span><b>${money(n)}</b></div>`).join('')}</div>${table}</main>`};
  }
  function css(){return `<style>@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box;letter-spacing:0}body{margin:0;color:#111;background:#fff;font-family:Meiryo,"Yu Gothic",sans-serif;font-size:9pt}.print-actions{display:flex;gap:8px;margin:10px}.print-actions button{font:inherit;padding:8px 14px;background:#fff;border:1px solid #555}.ar-report{width:100%;max-width:277mm;margin:0 auto;padding:4mm 0}header{display:flex;justify-content:space-between;gap:8mm;margin-bottom:5mm}h1{font-size:19pt;margin:0 0 3mm}h2{font-size:12pt;margin:4mm 0}.meta{line-height:1.7;font-size:8.5pt}.issuer{text-align:right;font-size:9pt;line-height:1.8;white-space:nowrap}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:2px solid #333;border-bottom:1px solid #333;margin:0 0 5mm;break-inside:avoid}.summary>div{padding:2mm 3mm;border-right:1px solid #aaa}.summary>div:last-child{border:0}.summary span{font-size:8pt}.summary b{display:block;text-align:right;font-size:13pt;margin-top:1mm}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt}th,td{border:1px solid #777;padding:2.1mm 1.4mm;overflow-wrap:anywhere;vertical-align:middle}th{background:#eee;font-size:8pt;font-weight:700}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.total{font-weight:700;background:#f2f2f2}.total td{border-top:2px solid #444}@media(max-width:800px){body{overflow-x:auto}.ar-report{min-width:1000px}}@media print{.print-actions{display:none}.ar-report{min-width:0;max-width:none;margin:0;padding:0}body{overflow:visible}}</style>`;}
  return {range,selectRows,build,document,css};
});
