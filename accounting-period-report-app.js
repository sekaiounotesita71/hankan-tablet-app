(function(){
  'use strict';
  const busy=new Set();
  function setPeriod(kind,period){
    const input=document.getElementById(kind+'-report-range');
    if(!input)return;
    const range=salesRefDateRangeFromText(salesRefPeriodValue(period));
    if(kind==='ar'&&receivableOperationStartDate&&range.from<receivableOperationStartDate)range.from=receivableOperationStartDate;
    input.value=range.from&&range.to?`${salesRefCompactDate(range.from)}-${salesRefCompactDate(range.to)}`:'';
  }
  function init(){
    for(const kind of ['ar','ap']){
      const panel=document.getElementById(kind==='ar'?'accounts-receivable-panel':'accounts-payable-panel');
      const toolbar=panel?.querySelector('.ar-tools');
      if(!toolbar||document.getElementById(kind+'-report-range'))continue;
      const tools=document.createElement('div');
      tools.className='accounting-report-tools';
      tools.innerHTML=`<strong>帳票出力</strong><label>帳票対象期間<input id="${kind}-report-range" type="text" inputmode="numeric" autocomplete="off" placeholder="20260801-20260831"></label><div class="accounting-period-buttons"><button class="small" type="button" data-period="month">今月</button><button class="small" type="button" data-period="previous-month">先月</button><button class="small" type="button" data-period="year">今年</button></div><label>集計対象<select id="${kind}-report-scope"><option value="posted" ${kind==='ar'?'selected':''}>締め済み＋初期残高</option><option value="all" ${kind==='ap'?'selected':''}>登録済みすべて（未締め含む）</option></select></label>`;
      for(const button of tools.querySelectorAll('[data-period]'))button.addEventListener('click',()=>setPeriod(kind,button.dataset.period));
      toolbar.after(tools);
      for(const button of toolbar.querySelectorAll(`button[onclick="${kind==='ar'?'printReceivableListPdf()':'printPayableListPdf()'}"],button[onclick="${kind==='ar'?'printCustomerLedgerPdf()':'printSupplierLedgerPdf()'}"]`))tools.append(button);
      setPeriod(kind,'previous-month');
    }
  }
  function config(kind){
    init();
    const range=salesRefDateRangeFromText(val(kind+'-report-range'));
    if(!range.from||!range.to)throw Error('帳票対象期間を 20260801-20260831 の形式で入力してください。');
    AccountingPeriodReport.date(range.from);AccountingPeriodReport.date(range.to);
    if(kind==='ar'&&receivableOperationStartDate&&range.from<receivableOperationStartDate)throw Error(`売掛帳票は運用開始日 ${receivableOperationStartDate} 以降を指定してください。それ以前は初期残高に含まれています。`);
    return {kind,range,scope:val(kind+'-report-scope')||'posted',site:val(kind+'-site'),party:val(kind==='ar'?'ar-importer':'ap-supplier').trim()};
  }
  function data(options){
    const {kind,range,scope,site,party}=options,isAr=kind==='ar';
    const closings=new Map((isAr?receivableClosings:payableClosings).map(c=>[c.id,c]));
    const sourceRows=(isAr?receivableRows:payableRows).filter(row=>{
      if(isAr&&!arIsOperationRow(row))return false;
      if(site&&!ReferenceSites.matches(row,site))return false;
      if(scope==='posted'&&row.source_type!=='opening'&&(!row.closing_id||closings.get(row.closing_id)?.status!=='closed'))return false;
      if(!party)return true;
      if(isAr)return arSameImporter(row,party);
      const master=lookupSupplierByCode(party);
      return master?apSameSupplier(row.supplier_code,master.code):apSameSupplier(row.supplier_code,party)||String(row.supplier_name||'').toLowerCase().includes(party.toLowerCase());
    });
    const records=sourceRows.map(row=>{
      const identity=isAr?arImporterIdentity(row):{key:String(row.supplier_code||'').normalize('NFKC').trim().toUpperCase(),code:row.supplier_code,name:row.supplier_name};
      const taxKnown=isAr||(row.tax_amount_jpy!==null&&row.tax_amount_jpy!==undefined&&row.tax_amount_jpy!==''&&(row.source_type==='purchase'||Number(row.tax_amount_jpy)!==0));
      return {id:row.id,key:identity.key,code:identity.code,name:identity.name,date:row.invoice_date,amount:row.amount_jpy,tax:isAr?0:row.tax_amount_jpy,taxKnown,adjustment:row.adjustment_amount_jpy,sourceType:row.source_type,reference:row.invoice_no||'',description:[isAr?arSourceLabel(row.source_type):apSourceLabel(row.source_type),row.memo].filter(Boolean).join(' / ')};
    });
    const payments=(isAr?receivablePayments:payablePayments).map(p=>({id:p.id,recordId:isAr?p.receivable_id:p.payable_id,date:p.payment_date,cash:p.amount_jpy,fee:p.bank_fee_jpy,reference:p.reference_no,description:[p.memo,arNumber(p.bank_fee_jpy)?`${isAr?'手数料消込':'振込手数料（外数）'} ${accountingReportMoney(p.bank_fee_jpy)}`:''].filter(Boolean).join(' / ')}));
    const report=AccountingPeriodReport.build({records,payments,range,kind});
    if(!isAr){
      const paid=new Map();
      for(const p of payablePayments)if(String(p.payment_date||'').slice(0,10)<=range.to)paid.set(p.payable_id,(paid.get(p.payable_id)||0)+arNumber(p.amount_jpy));
      const byId=new Map(sourceRows.map(row=>[row.id,row]));
      for(const item of report.items)item.netBalance=apNetBalanceSummary(item.records.map(row=>byId.get(row.id)),row=>{
        const amount=String(row.invoice_date||'')<=range.to?arNumber(row.amount_jpy):0,settled=paid.get(row.id)||0;
        return {amount,paid:settled,balance:arRound(amount-settled)};
      });
      report.totals.netBalance=apMergeNetBalances(report.items.map(item=>item.netBalance));
    }
    return report;
  }
  function params(report,options,detail){
    const isAr=options.kind==='ar',title=detail?(isAr?'得意先明細':'仕入先明細'):(isAr?'売掛一覧表':'買掛一覧表');
    const money=accountingReportMoney,numberCell=value=>({text:money(value),className:'money'});
    const meta=[`対象期間 ${accountingReportRangeLabel(report.range)}`,`期末基準日 ${accountingReportDate(report.range.to)}`,options.scope==='posted'?'締め済み＋初期残高':'登録済みすべて（未締め含む）',options.party?`${isAr?'輸入社':'仕入先'} ${options.party}`:`${isAr?'輸入社':'仕入先'} 全件`];
    if(!isAr)meta.push('税抜残高は参考値。一部支払は比例按分、税内訳不明分は未算出。振込手数料は買掛から差し引きません。');
    const total=report.totals;
    const summary=[{label:'期首残高',value:money(total.opening)},{label:isAr?'期間入金・消込':'期間支払',value:money(total.cash+(isAr?total.fee:0))},{label:isAr?'期間売上・調整計':'期間仕入・調整計（税込）',value:money(total.charges)},{label:isAr?'期末売掛残高':'期末買掛残高（税込）',value:money(total.balance)}];
    if(!isAr)summary.push({label:'期末買掛残高（税抜・参考）',value:apNetBalanceText(total.netBalance)});
    if(detail){
      const item=report.items[0];
      const rows=[[accountingReportDate(report.range.from),'繰越','-','期間開始前残高','','',numberCell(item.opening)]];
      for(const e of item.events)rows.push([accountingReportDate(e.date),e.type,e.reference,e.description,e.debit?numberCell(e.debit):'',e.credit?numberCell(e.credit):'',numberCell(e.balance)]);
      rows.push({total:true,cells:['','合計','','',numberCell(item.charges),numberCell(item.cash+(isAr?item.fee:0)),numberCell(item.balance)]});
      return {title,subtitle:`${item.code} ${item.name||''}`,meta,summary,orientation:'landscape',layout:'period',siteCode:options.site,headers:[{label:'日付',width:'22mm'},{label:'区分',width:'22mm'},{label:'管理番号',width:'38mm'},'内容',{label:isAr?'請求・調整':'仕入・調整',className:'money',width:'32mm'},{label:isAr?'入金・消込':'支払',className:'money',width:'32mm'},{label:'残高',className:'money',width:'34mm'}],rows};
    }
    const paired=(top,bottom)=>({lines:[top,bottom],className:'money'});
    function itemRow(item){
      const cells=[{text:item.code||'',className:'code'},item.name||'',paired(money(item.opening),item.taxUnknown?'税内訳不明':money(item.net)),paired(money(item.cash),money(item.adjustment)),paired(money(item.fee),item.taxUnknown?'税内訳不明':money(item.tax)),paired(money(item.carry),money(item.charges)),paired(String(item.count),money(item.balance))];
      if(!isAr)cells.push({text:apNetBalanceText(item.netBalance),className:'money'});
      return cells;
    }
    const headers=[{label:'コード',width:'16mm'},{label:isAr?'輸入社名':'仕入先名',width:isAr?'68mm':'48mm'},{label:`期首残高\n当期${isAr?'売上':'仕入'}額（税抜）`,className:'money'},{label:`${isAr?'入金額':'支払額'}\n調整・初期登録`,className:'money'},{label:`${isAr?'手数料消込':'振込手数料（外数）'}\n消費税`,className:'money'},{label:`差引繰越\n当期${isAr?'売上':'仕入'}合計`,className:'money'},{label:`伝票数\n期末${isAr?'売掛':'買掛'}残高`,className:'money'}];
    if(!isAr)headers.push({label:'期末買掛残高\n（税抜・参考）',className:'money',width:'33mm'});
    return {title,subtitle:isAr?'輸入社別 期間残高一覧（送料を含む）':'仕入先別 期間残高一覧（送料等を含む）',meta,summary,headers,rows:[...report.items.map(itemRow),{total:true,cells:itemRow(total)}],orientation:'landscape',layout:'period',siteCode:options.site};
  }
  async function print(kind,detail=false){
    const key=kind+(detail?'-detail':'-list');if(busy.has(key))return;
    let options;
    try{options=config(kind);if(detail&&!options.party)throw Error(`${kind==='ar'?'輸入社':'仕入先'}を選択してください。`)}catch(error){alert(error.message);return}
    const reportWindow=openAccountingReportWindow(kind==='ar'?'売掛帳票':'買掛帳票');if(!reportWindow)return;
    busy.add(key);
    try{
      if(kind==='ar'){
        receivablesLoaded=false;
        await loadReceivables();
        if(!receivablesLoaded)throw Error('売掛データを読み込めません。帳票は作成していません。');
        if(receivableOperationStartDate&&options.range.from<receivableOperationStartDate)throw Error(`売掛帳票は運用開始日 ${receivableOperationStartDate} 以降を指定してください。`);
      }else{
        payablesLoaded=false;
        await loadPayables();
        if(!payablesLoaded)throw Error('買掛データを読み込めません。帳票は作成していません。');
        if(options.scope==='posted'&&!payableClosingDbReady)throw Error('締め履歴を読み込めません。');
      }
      const report=data(options);
      if(!report.items.length)throw Error('指定期間・条件に該当する残高または取引がありません。');
      if(detail&&report.items.length!==1)throw Error('明細帳票は取引先コードを1つ選択してください。');
      writeAccountingReport(reportWindow,params(report,options,detail));
    }catch(error){reportWindow.close();alert(String(error?.message||error))}
    finally{busy.delete(key)}
  }
  window.AccountingReports={print,setPeriod,data,params};
  init();
})();
