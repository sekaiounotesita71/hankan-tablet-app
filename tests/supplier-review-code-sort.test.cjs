const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");

function sourceBetween(start,end){
  const from=html.indexOf(start);
  const to=html.indexOf(end,from+start.length);
  assert.notEqual(from,-1,`${start} がありません`);
  assert.notEqual(to,-1,`${end} がありません`);
  return html.slice(from,to);
}

test("発注先確認を発注先コード、商品コードの順で自然順ソートする",()=>{
  const source=sourceBetween("function supplierReviewCodeCompare","function switchSupplierReviewTab");
  const api=new Function(`${source};return {supplierReviewSortRows};`)();
  const sorted=api.supplierReviewSortRows([
    {supplier_code:"10",product_code:"2",customer_name_snapshot:"B",line_id:"4"},
    {supplier_code:"2",product_code:"10",customer_name_snapshot:"A",line_id:"3"},
    {supplier_code:"2",product_code:"2",customer_name_snapshot:"C",line_id:"2"},
    {supplier_code:"",product_code:"1",customer_name_snapshot:"A",line_id:"1"}
  ]);
  assert.deepEqual(sorted.map(row=>`${row.supplier_code||"未設定"}:${row.product_code}`),["2:2","2:10","10:2","未設定:1"]);
});

test("発注先タブのグループも発注先コード順にする",()=>{
  const source=sourceBetween("function renderSupplierReviewBoard","async function loadSupplierReviewBoard");
  assert.match(source,/supplierReviewSortRows\(supplierReviewVisibleRows\(\)\)/);
  assert.match(source,/supplierReviewGroups=.*\.sort\(\(a,b\)=>/s);
  assert.match(source,/supplierReviewCodeCompare\(a\.rows\[0\]\?\.supplier_code,b\.rows\[0\]\?\.supplier_code\)/);
});
