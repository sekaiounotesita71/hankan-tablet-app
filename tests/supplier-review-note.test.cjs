const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
const sql=fs.readFileSync(path.join(__dirname,"..","order-supplier-review-migration.sql"),"utf8");

function render(notes,activeSupplierReviewKey="__all__"){
  const nodes=Object.fromEntries(["list","summary","tabs"].map(name=>["supplier-review-"+name,{innerHTML:""}]));
  const rows=notes.map((note,index)=>({
    line_id:`line-${index}`,supplier_code:"51",product_code:String(index+1),
    product_name_snapshot:`Product ${index+1}`,purchase_note:note
  }));
  const scope={
    document:{getElementById:id=>nodes[id],querySelectorAll:()=>[]},
    supplierReviewVisibleRows:()=>rows,supplierReviewGroups:[],activeSupplierReviewKey,
    supplierReviewTabScrollLeft:0,supplierNameFor:()=>"",requestAnimationFrame:()=>{}
  };
  const esc=html.match(/^function esc\(v\).*$/m)[0];
  const review=html.slice(html.indexOf("function supplierReviewStatusLabel("),html.indexOf("async function loadSupplierReviewBoard("));
  vm.runInNewContext(esc+"\n"+review+"\nrenderSupplierReviewBoard();",scope);
  return nodes["supplier-review-list"].innerHTML;
}

test("supplier review uses the already saved order-line note",()=>{
  assert.match(sql,/line\.purchase_note,/);
  assert.match(html,/purchase_note:dbText\(row\.memo\)/);
});

test("both ALL and supplier tabs show escaped multiline notes under the product, without a new column",()=>{
  for(const tab of ["__all__","51"]){
    const view=render(["first\n<script>& second</script>"],tab);
    assert.match(view,/<td><b>Product 1<\/b><div class="supplier-review-memo">備考：first\n&lt;script&gt;&amp; second&lt;\/script&gt;<\/div><\/td>/);
    assert.equal((view.match(/<th>/g)||[]).length,11);
    assert.equal((view.match(/<td[ >]/g)||[]).length,11);
  }
});

test("blank notes leave no extra line",()=>{
  assert.doesNotMatch(render([null,"","  \n"]),/supplier-review-memo/);
});
