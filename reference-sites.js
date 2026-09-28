(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;else root.ReferenceSites=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function code(row={}){return String(row._referenceSite??row.site_code??row.siteCode??"OSA").trim().toUpperCase()||"OSA"}
  function matches(row,selected){return !selected||code(row)===selected||(selected==="UNASSIGNED"&&!["OSA","TYO"].includes(code(row)))}
  function label(value){const key=typeof value==="object"?code(value):value;return {OSA:"大阪",TYO:"東京",MIXED:"複数拠点",UNASSIGNED:"共通・未判定"}[key]||(key?"共通・未判定":"全拠点")}
  function customerSite(row,customers=[]){
    if(row.site_code||row.siteCode)return code(row);
    const customerCode=String(row.customer_code||row.customerCode||row.customer?.code||"").normalize("NFKC").trim();
    const customer=customers.find(item=>String(item.code||item.customer_code||"").normalize("NFKC").trim()===customerCode&&customerCode);
    return customer?code(customer):"UNASSIGNED";
  }
  async function readLinked(client,table,columns,key,values){
    const ids=[...new Set(values.filter(Boolean))],result=[];
    for(let i=0;i<ids.length;i+=200){
      for(let offset=0;;offset+=1000){
        const {data,error}=await client.from(table).select(columns).in(key,ids.slice(i,i+200)).order("id").range(offset,offset+999);
        if(error)throw error;
        result.push(...(data||[]));if((data||[]).length<1000)break;
      }
    }
    return result;
  }
  async function sessions(client,rows,known=[]){
    const source=row=>row.source_session_id||row.session_id||"";
    const byId=new Map(known.filter(row=>row.site_code).map(row=>[row.id,row]));
    const found=await readLinked(client,"work_sessions","id,site_code","id",rows.map(source).filter(id=>id&&!byId.has(id)));
    found.forEach(row=>byId.set(row.id,row));
    return rows.map(row=>({...row,_referenceSite:source(row)?(byId.has(source(row))?code(byId.get(source(row))):"UNASSIGNED"):code(row)}));
  }
  async function payables(client,rows){
    const receipts=await readLinked(client,"purchase_receipts","id,accounts_payable_id,site_code","accounts_payable_id",rows.map(row=>row.id));
    const sites=new Map();
    receipts.forEach(row=>{const set=sites.get(row.accounts_payable_id)||new Set();set.add(code(row));sites.set(row.accounts_payable_id,set)});
    return rows.map(row=>{const set=sites.get(row.id);return {...row,_referenceSite:set?.size?(set.size===1?[...set][0]:"MIXED"):(row.site_code||row.siteCode?code(row):"UNASSIGNED")}});
  }
  async function domesticReceivables(client,rows){
    const sales=await readLinked(client,"domestic_sales","id,source_session_id","id",rows.map(row=>row.sale_id));
    const sites=new Map((await sessions(client,sales)).map(row=>[row.id,code(row)]));
    return rows.map(row=>({...row,_referenceSite:row.sale_id?(sites.get(row.sale_id)||"UNASSIGNED"):code(row)}));
  }
  return {code,matches,label,customerSite,readLinked,sessions,payables,domesticReceivables};
});
