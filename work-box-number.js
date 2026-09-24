(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.WorkBoxNumber=api;
})(typeof window!=="undefined"?window:this,function(){
  "use strict";
  function prefix(value){return String(value??"").normalize("NFKC").trim().toUpperCase().replace(/-+$/,"")}
  function digits(value){return String(value??"").normalize("NFKC").replace(/[^0-9]/g,"")}
  function describe(value,site,route){
    const stored=String(value??"").trim();
    if(site!=="TYO")return {prefix:"",sequence:stored,stored,blocked:false,legacy:false};
    // A saved qualified number is its own snapshot, even if the supplier changes later.
    const saved=stored.match(/^(.+)-([0-9]+)$/);
    const fixed=saved?saved[1]:prefix(route?.prefix);
    return {prefix:fixed,sequence:saved?saved[2]:stored,stored,blocked:!fixed,
      legacy:!!stored&&!saved,error:route?.error||(!fixed?"仕入先マスタの箱番号の固定コードが未設定です。":"")};
  }
  function compose(fixed,value){
    const sequence=digits(value).replace(/^0+(?=\d)/,"");
    return sequence?`${fixed}-${sequence}`:"";
  }
  function routeRows(records,sources,suppliers,idField){
    const bySource=new Map(sources.map(row=>[row.id,row]));
    const bySupplier=new Map(suppliers.map(row=>[row.supplier_code,row]));
    return records.map(row=>{
      const source=bySource.get(row[idField]);
      const supplier=bySupplier.get(source?.supplier_code);
      return {...row,_boxRouting:{supplierCode:source?.supplier_code||"",prefix:prefix(supplier?.box_prefix),
        error:!row[idField]?"受注明細との紐づけがありません。発注先を確認してください。":!source?.supplier_code?"受注明細の発注先が未設定です。":""}};
    });
  }
  return {prefix,digits,describe,compose,routeRows};
});
