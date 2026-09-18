(function(root){
  "use strict";
  const text=value=>String(value??"").trim();
  const key=value=>text(value).normalize("NFKC").toLowerCase();
  const number=value=>value===null||value===undefined||text(value)===""?null:(Number.isFinite(Number(value))?Number(value):null);
  function unit(value){
    const raw=text(value).normalize("NFKC");
    return {kg:"Kg",pc:"PC",pcs:"PC",pkt:"pkt",cs:"CS"}[raw.toLowerCase()]||raw;
  }
  function collect(candidates){
    const rows=[],excluded=[];
    for(const row of candidates){
      let reason=row.reason;
      if(!reason&&!/^\d{4}-\d{2}-\d{2}$/.test(row.date))reason="日付不明";
      if(!reason&&(!row.unit||!row.name&&!row.code))reason="商品・単位不明";
      if(!reason&&(row.price===null||row.price<0))reason="単価未設定・減額";
      if(!reason&&(row.qty===null||row.qty<=0))reason="数量未設定・返品";
      if(reason)excluded.push({...row,reason});
      else rows.push(row);
    }
    return {rows,excluded};
  }
  function sales(source){
    return collect(source.map((row,index)=>{
      const scope=key(row.analysisImporterCode||row.importer_code||row.importer_id);
      const customerCode=text(row.customer_code),customerName=text(row.store_name);
      return {
        id:row.id||String(index),date:text(row.analysisDate||row.work_date).slice(0,10),code:text(row.product_id),name:text(row.product_name),
        origin:text(row.origin),unit:unit(row.input_unit),qty:number(row.input_qty),price:number(row.unit_price),
        partyKey:JSON.stringify([scope,customerCode?"code:"+customerCode:"name:"+customerName]),
        partyLabel:[row.analysisImporterLabel||scope,customerCode,customerName||"得意先不明"].filter(Boolean).join(" / "),
        reference:text(row.session_name||row.source_type),note:text(row.memo),
        reason:row.is_stockout?"欠品":row._sales_provisional?"未確定":row.pending_entry_id||row._shipping_adjustment_amount?"調整伝票":number(row.amount)<0?"赤伝・減額":null
      };
    }));
  }
  function purchases(receipts){
    return collect(receipts.flatMap(receipt=>(receipt.lines||[]).map((line,index)=>{
      const actualUnit=unit(line.actual_unit),priceUnit=unit(line.price_unit||line.actual_unit);
      return {
        id:line.id||`${receipt.id}:${index}`,date:text(receipt.purchase_date).slice(0,10),code:text(line.product_code),name:text(line.product_name),
        origin:text(line.origin),unit:priceUnit,qty:number(line.actual_qty),price:number(line.unit_price),
        partyKey:receipt.supplier_code?"code:"+text(receipt.supplier_code):"name:"+text(receipt.supplier_name_snapshot),
        partyLabel:[receipt.supplier_code,receipt.supplier_name_snapshot||"仕入先不明"].filter(Boolean).join(" / "),
        reference:text(receipt.supplier_invoice_no),note:text(line.note),
        reason:receipt.receipt_type==="credit_note"?"赤伝":receipt.status!=="confirmed"||receipt.correction_unlocked?"未確定":actualUnit!==priceUnit?"数量単位と単価単位が不一致":null
      };
    })));
  }
  function groupKey(row,options={}){
    return JSON.stringify([row.code?"code:"+row.code:"name:"+row.name,row.unit,options.origin===false?"":key(row.origin),options.party?row.partyKey:""]);
  }
  function stats(rows){
    let qty=0,weighted=0,min=Infinity,max=-Infinity,latestDate="",latestQty=0,latestWeighted=0,priorDate="",priorQty=0,priorWeighted=0;
    for(const row of rows){
      qty+=row.qty;weighted+=row.price*row.qty;min=Math.min(min,row.price);max=Math.max(max,row.price);
      if(row.date>latestDate){priorDate=latestDate;priorQty=latestQty;priorWeighted=latestWeighted;latestDate=row.date;latestQty=0;latestWeighted=0}
      else if(row.date<latestDate&&row.date>priorDate){priorDate=row.date;priorQty=0;priorWeighted=0}
      if(row.date===latestDate){latestQty+=row.qty;latestWeighted+=row.price*row.qty}
      else if(row.date===priorDate){priorQty+=row.qty;priorWeighted+=row.price*row.qty}
    }
    return {count:rows.length,qty,weighted,avg:qty?weighted/qty:null,min:rows.length?min:null,max:rows.length?max:null,
      spread:rows.length?max-min:null,latest:latestQty?latestWeighted/latestQty:null,latestDate,prior:priorQty?priorWeighted/priorQty:null,priorDate};
  }
  function groups(current,previous,options={}){
    const map=new Map();
    for(const [rows,bucket] of [[current,"rows"],[previous,"previousRows"]])for(const row of rows){
      const id=groupKey(row,options);
      if(!map.has(id))map.set(id,{id,code:row.code,name:row.name,unit:row.unit,origin:options.origin===false?"全産地":row.origin||"産地未設定",partyLabel:options.party?row.partyLabel:"",rows:[],previousRows:[]});
      const group=map.get(id);group[bucket].push(row);
      if(bucket==="rows"&&(!group.labelDate||row.date>=group.labelDate)){group.name=row.name;group.labelDate=row.date;group.partyLabel=options.party?row.partyLabel:""}
    }
    return [...map.values()].map(group=>{
      const current=stats(group.rows),previous=stats(group.previousRows);
      const delta=current.avg===null||previous.avg===null?null:current.avg-previous.avg;
      return {...group,current,previous,delta,ratio:delta===null||previous.avg===0?null:delta/previous.avg*100,
        recentDelta:current.prior===null?null:current.latest-current.prior};
    });
  }
  function monthly(group){
    const map=new Map();
    for(const [rows,previous] of [[group.rows,false],[group.previousRows,true]])for(const row of rows){
      let month=row.date.slice(0,7);
      if(previous)month=`${Number(month.slice(0,4))+1}${month.slice(4)}`;
      if(!map.has(month))map.set(month,{month,rows:[],previousRows:[]});
      map.get(month)[previous?"previousRows":"rows"].push(row);
    }
    return [...map.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(row=>({...row,current:stats(row.rows),previous:stats(row.previousRows)}));
  }
  function filterSort(groups,{query="",sort="spread"}={}){
    const terms=key(query).split(/\s+/).filter(Boolean);
    const filtered=groups.filter(group=>terms.every(term=>key([group.code,group.name,group.origin,group.partyLabel].join(" ")).includes(term)));
    const value=group=>sort==="recent-up"?group.recentDelta:sort==="recent-down"?(group.recentDelta===null?null:-group.recentDelta):sort==="increase"?group.delta:sort==="decrease"?(group.delta===null?null:-group.delta):sort==="value"?group.current.weighted:group.current.spread;
    return filtered.sort((a,b)=>{
      if(sort!=="code"){
        const av=value(a),bv=value(b);
        if(av===null&&bv!==null)return 1;
        if(bv===null&&av!==null)return -1;
        if(av!==null&&bv!==null&&av!==bv)return bv-av;
      }
      return a.code.localeCompare(b.code,"ja",{numeric:true})||a.name.localeCompare(b.name,"ja")||a.id.localeCompare(b.id,"ja");
    });
  }
  function filterRows(rows,{query="",unit:chosenUnit=""}={}){
    const terms=key(query).split(/\s+/).filter(Boolean);
    return rows.filter(row=>(!chosenUnit||row.unit===chosenUnit)&&terms.every(term=>key([row.code,row.name,row.origin,row.partyLabel].join(" ")).includes(term)));
  }
  const api={unit,sales,purchases,groupKey,stats,groups,monthly,filterSort,filterRows};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.UnitPriceAnalysis=api;
})(typeof window!=="undefined"?window:this);
