(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DomesticPayments=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const round=value=>Math.round((Number(value)||0)*100)/100;
  const date=value=>value instanceof Date?value.toISOString().slice(0,10):String(value||'').slice(0,10);
  function targets(closing,receivables){
    const charges=new Set((closing.snapshot?.charges||[]).map(row=>row.id));
    return receivables.filter(row=>row.customer_code===closing.customer_code&&row.status!=='cancelled'&&date(row.invoice_date)<=date(closing.period_to)&&
      (Date.parse(row.created_at)<=Date.parse(closing.closed_at)||charges.has(row.id)));
  }
  function closingState(closing,receivables,payments){
    const rows=targets(closing,receivables),ids=new Set(rows.map(row=>row.id));
    const original=round(closing.billing_amount_jpy);
    const later=round(payments.filter(row=>ids.has(row.receivable_id)&&date(row.payment_date)>date(closing.period_to)).reduce((sum,row)=>sum+Number(row.amount_jpy||0),0));
    const open=round(rows.reduce((sum,row)=>sum+Number(row.balance_jpy||0),0));
    const balance=Math.max(0,Math.min(open,round(original-later)));
    return{rows,amount:original,paid:round(Math.max(0,original-balance)),balance,status:balance<=0?'paid':balance<original?'partial':'unpaid'};
  }
  function groupedHistory(payments){
    const groups=new Map();
    for(const row of payments){
      const key=row.payment_group_id||row.id;
      if(!groups.has(key))groups.set(key,{id:key,date:date(row.payment_date),cash:0,fee:0,settled:0,reference:row.reference_no||'',memo:row.memo||'',count:0});
      const group=groups.get(key);group.cash+=Number(row.cash_amount_jpy??row.amount_jpy);group.fee+=Number(row.bank_fee_jpy||0);group.settled+=Number(row.amount_jpy||0);group.count++;
    }
    return [...groups.values()].map(row=>({...row,cash:round(row.cash),fee:round(row.fee),settled:round(row.settled)})).sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
  }
  function latestClosings(closings){
    const latest=new Map();
    for(const row of closings.filter(row=>row.status==='closed').slice().sort((a,b)=>date(b.period_to).localeCompare(date(a.period_to))))if(!latest.has(row.customer_code))latest.set(row.customer_code,row);
    return [...latest.values()];
  }
  return{round,targets,closingState,groupedHistory,latestClosings};
});
