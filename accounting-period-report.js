(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.AccountingPeriodReport=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function cents(value){
    if(value===null||value===undefined||value==='')return 0;
    const n=Number(value),result=Math.sign(n)*Math.round((Math.abs(n)+Number.EPSILON)*100);
    if(!Number.isFinite(n)||!Number.isSafeInteger(result))throw Error('帳票の金額に不正な値があります。');
    return result;
  }
  function date(value){
    const s=String(value||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('帳票の日付を確認してください。');
    const d=new Date(s+'T00:00:00Z');
    if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)throw Error('存在しない日付です。');
    return s;
  }
  const moneyFields=['opening','cash','fee','carry','net','adjustment','tax','charges','balance'];
  function empty(identity){
    return {...identity,opening:0,cash:0,fee:0,carry:0,net:0,adjustment:0,tax:0,charges:0,balance:0,count:0,taxUnknown:0,events:[],records:[],payments:[]};
  }
  function build({records,payments,range,kind='ar'}){
    const from=date(range.from),to=date(range.to);
    if(from>to)throw Error('帳票の開始日は終了日以前にしてください。');
    const groups=new Map(),byId=new Map(),paymentIds=new Set();
    for(const row of records){
      if(!row.id||byId.has(row.id))throw Error('帳票の明細IDが空欄または重複しています。');
      const day=date(row.date),amount=cents(row.amount);
      const key=row.key||row.code;
      if(!key)throw Error('帳票の取引先コードが未設定です。');
      let group=groups.get(key);
      if(!group){group=empty({key,code:row.code,name:row.name});groups.set(key,group)}
      byId.set(row.id,{row,group});
      group.records.push(row);
      if(day<from)group.opening+=amount;
      else if(day<=to){
        const tax=row.taxKnown?cents(row.tax):0;
        const adjustment=row.sourceType==='opening'||row.sourceType==='adjustment'?amount-tax:cents(row.adjustment);
        group.charges+=amount;
        group.net+=amount-tax-adjustment;
        group.adjustment+=adjustment;
        group.tax+=tax;
        if(!row.taxKnown&&amount!==0&&row.sourceType!=='opening')group.taxUnknown++;
        if(row.sourceType!=='opening')group.count++;
        group.events.push({date:day,type:row.sourceType==='opening'?'初期残高':row.sourceType==='adjustment'?'調整':kind==='ar'?'請求':'仕入・請求',reference:row.reference||'',description:row.description||'',debit:amount,credit:0,order:0,id:row.id});
      }
    }
    for(const payment of payments){
      const match=byId.get(payment.recordId);
      if(!match)continue;
      if(!payment.id||paymentIds.has(payment.id))throw Error('帳票の入出金IDが空欄または重複しています。');
      paymentIds.add(payment.id);
      const day=date(payment.date),cash=cents(payment.cash),fee=cents(payment.fee);
      const settled=cash+(kind==='ar'?fee:0),group=match.group;
      group.payments.push(payment);
      if(day<from)group.opening-=settled;
      else if(day<=to){
        group.cash+=cash;group.fee+=fee;
        group.events.push({date:day,type:kind==='ar'?'入金':'支払',reference:payment.reference||'',description:payment.description||'',debit:0,credit:settled,order:1,id:payment.id});
      }
    }
    const totals=empty({key:'total',code:'',name:'合計'});
    const items=[...groups.values()].filter(g=>g.opening!==0||g.events.length).sort((a,b)=>String(a.code).localeCompare(String(b.code),'ja',{numeric:true}));
    for(const group of items){
      group.carry=group.opening-group.cash-(kind==='ar'?group.fee:0);
      group.balance=group.carry+group.charges;
      group.events.sort((a,b)=>a.date.localeCompare(b.date)||a.order-b.order||String(a.id).localeCompare(String(b.id)));
      let balance=group.opening;
      group.events=group.events.map(event=>{balance+=event.debit-event.credit;return {...event,debit:event.debit/100,credit:event.credit/100,balance:balance/100}});
      for(const field of moneyFields){totals[field]+=group[field];group[field]/=100}
      totals.count+=group.count;totals.taxUnknown+=group.taxUnknown;
    }
    for(const field of moneyFields)totals[field]/=100;
    return {range:{from,to},kind,items,totals};
  }
  return {build,date};
});
