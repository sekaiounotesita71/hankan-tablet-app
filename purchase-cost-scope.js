(function(root,factory){
  "use strict";
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else root.PurchaseCostScope=factory();
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const text=value=>typeof value==="string"||typeof value==="number"?String(value).normalize("NFKC").trim():"";
  const key=value=>text(value).toUpperCase();
  const unassigned=()=>({scope:"unassigned",importerCode:""});

  function literalCode(value){
    const code=key(value);
    if(/^\d+$/.test(code))return code.replace(/^0+(?=\d)/,"").padStart(2,"0");
    return /^[A-Z0-9][A-Z0-9_-]*$/.test(code)?code:"";
  }

  // Numeric codes are literal identities; names and aliases require a unique exact master match.
  function normalizeCode(value,importers=[]){
    const query=key(value);
    if(!query)return "";
    if(/^\d+$/.test(query))return literalCode(query);
    const codes=new Set(),matches=new Set();
    for(const importer of Array.isArray(importers)?importers:[]){
      if(!importer||typeof importer!=="object")continue;
      const rawCode=importer.code??importer.importer_code;
      const code=literalCode(rawCode);
      if(!code)continue;
      if(query===key(rawCode)||query===code)codes.add(code);
      const aliases=Array.isArray(importer.aliases)?importer.aliases:typeof importer.aliases==="string"?importer.aliases.split(/[|,\u3001]/):[];
      if([importer.name??importer.importer_name,...aliases].some(alias=>key(alias)===query))matches.add(code);
    }
    const found=codes.size?codes:matches;
    return found.size===1?[...found][0]:"";
  }

  function sourceScope(value,importers){
    if(value&&typeof value==="object"){
      if(value.scope==="domestic")return {scope:"domestic",importerCode:""};
      if(value.scope&&value.scope!=="importer")return unassigned();
      value=value.importerCode??value.importer_code;
    }
    const importerCode=normalizeCode(value,importers);
    return importerCode?{scope:"importer",importerCode}:unassigned();
  }

  function deriveFromSources(ids,map,importers=[]){
    if(!Array.isArray(ids)||!ids.length)return unassigned();
    const uniqueIds=new Set(ids.map(text)),scopes=new Map();
    for(const id of uniqueIds){
      if(!id)return unassigned();
      const value=map instanceof Map?map.get(id):map&&Object.prototype.hasOwnProperty.call(map,id)?map[id]:undefined;
      const result=sourceScope(value,importers);
      if(result.scope==="unassigned")return result;
      scopes.set(result.scope+":"+result.importerCode,result);
    }
    return scopes.size===1?{...[...scopes.values()][0]}:{scope:"shared",importerCode:""};
  }

  function choiceValue(scope,code){
    if(scope==="shared"||scope==="domestic")return scope;
    const importerCode=scope==="importer"?literalCode(code):"";
    return importerCode?"importer:"+importerCode:"unassigned";
  }

  function parseChoice(value){
    const choice=text(value);
    if(choice==="shared"||choice==="domestic")return {scope:choice,importerCode:""};
    if(!choice.startsWith("importer:"))return unassigned();
    const importerCode=literalCode(choice.slice(9));
    return importerCode?{scope:"importer",importerCode}:unassigned();
  }

  function integer(value){
    if(value===undefined||value===null||value==="")return 0;
    if(typeof value!=="number"&&(typeof value!=="string"||!/^[-+]?\d+$/.test(text(value))))throw new TypeError("Purchase cost must be an integer");
    const result=Number(value);
    if(!Number.isSafeInteger(result))throw new RangeError("Purchase cost exceeds safe integer precision");
    return Object.is(result,-0)?0:result;
  }

  function add(left,right){
    const sum=left+right;
    if(!Number.isSafeInteger(sum))throw new RangeError("Purchase cost total exceeds safe integer precision");
    return sum;
  }

  const bucket=(scope,importerCode="")=>({scope,importerCode,amount:0,fees:0,cost:0,count:0});
  function accumulate(target,amount,fees){
    target.amount=add(target.amount,amount);
    target.fees=add(target.fees,fees);
    target.cost=add(target.cost,add(amount,fees));
    target.count++;
  }

  // Amounts and optional fees are signed integer yen, never rounded or proportionally allocated.
  function buildSummary(rows){
    const summary={amount:0,fees:0,cost:0,count:0,importers:[],shared:bucket("shared"),domestic:bucket("domestic"),unassigned:bucket("unassigned")};
    const importers=new Map();
    for(const row of rows||[]){
      const amount=integer(row.amount),fees=integer(row.fees);
      const resolved=parseChoice(choiceValue(row.scope,row.importer_code??row.importerCode));
      let group=summary[resolved.scope];
      if(resolved.scope==="importer"){
        if(!importers.has(resolved.importerCode))importers.set(resolved.importerCode,bucket("importer",resolved.importerCode));
        group=importers.get(resolved.importerCode);
      }
      accumulate(group,amount,fees);
      accumulate(summary,amount,fees);
    }
    summary.importers=[...importers.values()].sort((a,b)=>a.importerCode.localeCompare(b.importerCode,"en",{numeric:true}));
    return summary;
  }

  // Margin is a percentage. Unclassified sales have no attributable profit; sidecars stay unallocated.
  function buildImporterProfit(salesRows,costRows){
    const groups=new Map();
    const result={rows:[],shared:{amount:0,count:0},unassigned:{amount:0,count:0},fees:{amount:0,count:0},totalCost:0};
    function groupFor(scope,importerCode){
      const id=scope+":"+importerCode;
      if(!groups.has(id))groups.set(id,{scope,importerCode,sales:0,cost:0,grossProfit:null,margin:null,lineCount:0});
      return groups.get(id);
    }
    for(const row of salesRows||[]){
      const resolved=row.scope==="importer"||row.scope==="domestic"?parseChoice(choiceValue(row.scope,row.importerCode)):unassigned();
      const group=groupFor(resolved.scope,resolved.importerCode);
      group.sales=add(group.sales,integer(row.amount));
    }
    for(const row of costRows||[]){
      const amount=integer(row.amount),count=row.line_count==null?1:integer(row.line_count);
      if(count<0)throw new RangeError("Purchase line count must be a nonnegative integer");
      const resolved=row.scope==="fees"?{scope:"fees",importerCode:""}:parseChoice(choiceValue(row.scope,row.importer_code??row.importerCode));
      if(resolved.scope==="importer"||resolved.scope==="domestic"){
        const group=groupFor(resolved.scope,resolved.importerCode);
        group.cost=add(group.cost,amount);
        group.lineCount=add(group.lineCount,count);
      }else{
        const sidecar=result[resolved.scope];
        sidecar.amount=add(sidecar.amount,amount);
        sidecar.count=add(sidecar.count,count);
      }
      result.totalCost=add(result.totalCost,amount);
    }
    const order={importer:0,domestic:1,unassigned:2};
    result.rows=[...groups.values()].map(group=>{
      if(group.scope==="unassigned")return group;
      const grossProfit=add(group.sales,-group.cost);
      return {...group,grossProfit,margin:group.sales?grossProfit/group.sales*100:null};
    }).sort((a,b)=>order[a.scope]-order[b.scope]||a.importerCode.localeCompare(b.importerCode,"en",{numeric:true}));
    return result;
  }

  return {normalizeCode,deriveFromSources,choiceValue,parseChoice,buildSummary,buildImporterProfit};
});
