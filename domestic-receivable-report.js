(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./accounting-period-report.js'),require('./domestic-payment-model.js'),require('./reference-sites.js'),require('./accounting-report-layout.js'));
  else root.DomesticReceivableReport=factory(root.AccountingPeriodReport,root.DomesticPayments,root.ReferenceSites,root.AccountingReportLayout);
})(typeof globalThis!=='undefined'?globalThis:this,function(period,paymentsModel,sites,Layout){
  'use strict';
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
  function document(report,{detail=false,company='株式会社ゆみるめ',issuedAt='',logoUrl=''}={}){
    if(!report.items.length)throw Error('対象期間に残高または取引がありません。');
    if(detail&&(!report.customer||report.items.length!==1))throw Error('得意先明細は得意先コードを1つ選択してください。');
    const title=detail?'国内 得意先明細表':'国内 売掛一覧表',total=report.totals;
    const numberCell=value=>({text:money(value),className:'money'});
    const paired=(top,bottom)=>({lines:[top,bottom],className:'money'});
    const itemRow=row=>[
      {text:row.code||'',className:'code'},row.name||'',
      paired(money(row.opening),money(row.net)),paired(money(row.cash),money(row.adjustment)),
      paired(money(row.fee),money(row.tax)),paired(money(row.carry),money(row.charges)),
      paired(String(row.count),money(row.balance))
    ];
    let headers,rows,subtitle;
    if(detail){
      const row=report.items[0];
      subtitle=`${row.code} ${row.name}`;
      headers=[{label:'日付',width:'22mm'},{label:'区分',width:'22mm'},{label:'管理番号',width:'38mm'},'内容',
        {label:'売上・調整（税込）',className:'money',width:'32mm'},
        {label:'入金・消込',className:'money',width:'32mm'},{label:'売掛残高',className:'money',width:'34mm'}];
      rows=[[report.range.from,'繰越','-','期間開始前残高','','',numberCell(row.opening)],
        ...row.events.map(event=>[event.date,event.type,event.reference,event.description,event.debit?numberCell(event.debit):'',event.credit?numberCell(event.credit):'',numberCell(event.balance)]),
        {total:true,cells:['','合計','','',numberCell(row.charges),numberCell(row.cash+row.fee),numberCell(row.balance)]}];
    }else{
      subtitle='得意先別 期間残高一覧（送料を含む）';
      headers=[{label:'コード',width:'16mm'},{label:'得意先名',width:'68mm'},
        {label:'期首残高\n当期売上額（税抜）',className:'money'},{label:'入金額\n調整・初期登録',className:'money'},
        {label:'手数料消込\n消費税',className:'money'},{label:'差引繰越\n当期売上合計（税込）',className:'money'},
        {label:'伝票数\n期末売掛残高（税込）',className:'money'}];
      rows=[...report.items.map(itemRow),{total:true,cells:itemRow(total)}];
    }
    const meta=[`対象期間 ${report.range.from} ～ ${report.range.to}`,`期末基準日 ${report.range.to}`,
      report.scope==='posted'?'締め済み＋初期残高':'登録済みすべて（未締め含む）',
      report.customer?`得意先 ${report.customer}`:'全得意先',sites.label(report.site),'単位：円'];
    const summary=[{label:'期首残高',value:money(total.opening)},{label:'期間入金・消込',value:money(total.cash+total.fee)},
      {label:'期間売上・調整計（税込）',value:money(total.charges)},{label:'期末売掛残高（税込）',value:money(total.balance)}];
    return Layout.create({title,subtitle,meta,summary,headers,rows,orientation:'landscape',layout:'period',company,issuedAt,logoUrl,
      repeatLabel:`${title} ／ ${report.range.from} ～ ${report.range.to}${detail?` ／ ${report.items[0].code} ${report.items[0].name}`:''}`});
  }
  function css(){return Layout.css();}
  return {range,selectRows,build,document,css};
});
