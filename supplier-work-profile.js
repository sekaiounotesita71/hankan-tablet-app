(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.SupplierWorkProfile=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const fields={cargo_location:"貨物持ち込み場所",cargo_cut_time:"貨物カット時間",document_cut_time:"書類カット時間",document_method:"書類送付方法",packing_note:"梱包・特別申し送り",destination_name:"仕向け地",contact:"担当・連絡先"};
  const text=value=>String(value??"").normalize("NFKC").trim();
  const key=value=>text(value).toUpperCase();
  const scopeFields=["site_code","importer_code","supplier_code"];
  function clean(value={}){return Object.fromEntries(Object.keys(fields).map(field=>[field,String(value[field]??"").trim()]))}
  function matches(profile,scope){return scopeFields.every(field=>!text(profile[field])||key(profile[field])===key(scope[field]))}
  function rank(profile){return scopeFields.reduce((score,field,index)=>score+(text(profile[field])?10+2**index:0),0)}
  function resolve(profiles,scope,overrides={}){
    const result=clean();
    // More specific scopes win; empty values inherit the less-specific setting.
    profiles.filter(profile=>matches(profile,scope)).sort((a,b)=>rank(a)-rank(b)).forEach(profile=>{
      const values=clean(profile);for(const field of Object.keys(fields))if(values[field])result[field]=values[field];
    });
    const values=clean(overrides);for(const field of Object.keys(fields))if(values[field])result[field]=values[field];
    return result;
  }
  return {fields,scopeFields,clean,matches,resolve};
});
