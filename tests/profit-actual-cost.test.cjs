const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");
const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`${start} -> ${end}`);
  return html.slice(a,b);
}
const number=value=>value===null||value===undefined||value===""?null:(Number.isFinite(Number(value))?Number(value):null);
const normalize=value=>({kg:"Kg",pc:"PC",pkt:"pkt",cs:"CS"}[String(value||"").toLowerCase()]||"");
const quantityAndCost=section("function salesRefCostQuantity","async function salesRefReadChunks");
const allocator=section("function salesRefAllocateLinkedPurchaseCosts","async function salesRefAttachMasterCostContext");
const attach=section("async function salesRefAttachPurchaseCosts","function salesRefAllocateLinkedPurchaseCosts");
const chunks=section("async function salesRefReadChunks","function salesRefPurchaseCodeKeys");
const paged=section("async function salesRefReadPaged","async function salesRefReadCurrentRows");
const logic=new Function("purchasePriceUnit","normalizeLineUnit","salesRefNum","dbNumber",
  quantityAndCost+allocator+attach+chunks+paged+";return {salesRefAllocateLinkedPurchaseCosts,salesRefAttachPurchaseCosts,salesRefCostInfo};"
)(value=>normalize(value)||"Kg",normalize,value=>Number(value)||0,number);
const allocate=logic.salesRefAllocateLinkedPurchaseCosts;
function fixture(amount=10000){
  return {
    links:[{sales_record_id:"a",purchase_line_id:"line",purchase_receipt_id:"receipt"},{sales_record_id:"b",purchase_line_id:"line",purchase_receipt_id:"receipt"}],
    lines:[{id:"line",receipt_id:"receipt",price_unit:"Kg",line_amount:amount}],
    receipts:[{id:"receipt",status:"confirmed",supplier_code:"ACTUAL-SUPPLIER"}],
    sales:[{id:"a",input_qty:1,input_unit:"PC",net_weight:3},{id:"b",input_qty:1,input_unit:"PC",net_weight:7}]
  };
}
function calculate(data){return allocate(data.links,data.lines,data.receipts,data.sales)}
function clientFor(data){
  const calls=[];
  const tables={purchase_sales_links:data.links,purchase_receipt_lines:data.lines,purchase_receipts:data.receipts,sales_records:data.sales};
  return {calls,from(table){
    let rows=[...(tables[table]||[])],sortKey="id";
    return {
      select(){return this},
      in(field,ids){rows=rows.filter(row=>ids.includes(row[field]));calls.push({table,field,ids:[...ids]});return this},
      order(field){sortKey=field;return this},
      range(from,to){
        rows.sort((a,b)=>String(a[sortKey]).localeCompare(String(b[sortKey])));
        return Promise.resolve({data:rows.slice(from,to+1),count:null,error:null});
      }
    };
  }};
}
test("one-to-one uses the saved amount including zero, without master prices or quantities",()=>{
  for(const amount of [1234,0,-789]){
    const data=fixture(amount);data.links=data.links.slice(0,1);data.sales=[];
    assert.deepEqual(calculate(data).get("a"),{priced:true,amount,supplierCode:"ACTUAL-SUPPLIER"});
  }
});
test("grouped purchases allocate by NET weight and preserve the exact whole-yen amount",()=>{
  const result=calculate(fixture());
  assert.equal(result.get("a").amount,3000);
  assert.equal(result.get("b").amount,7000);
});
test("PC, pkt and CS use matching quantities, not NET",()=>{
  for(const unit of ["PC","pkt","CS"]){
    const data=fixture();data.lines[0].price_unit=unit;
    data.sales[0].input_unit=unit;data.sales[0].input_qty=2;
    data.sales[1].input_unit=unit;data.sales[1].input_qty=8;
    assert.equal(calculate(data).get("a").amount,2000);
  }
});
test("whole-yen rounding and negative costs remain stable regardless of input order",()=>{
  for(const amount of [1,2,100,-100,0,100000001]){
    const data=fixture(amount);
    data.links.push({sales_record_id:"c",purchase_line_id:"line",purchase_receipt_id:"receipt"});
    data.sales=["a","b","c"].map(id=>({id,net_weight:1}));
    const result=calculate(data);
    assert.equal([...result.values()].reduce((sum,cost)=>sum+cost.amount,0),amount);
    assert.ok([...result.values()].every(cost=>Number.isInteger(cost.amount)));
    data.links.reverse();data.sales.reverse();
    assert.deepEqual(calculate(data),result);
  }
});
test("missing, draft and invalid amounts never fall back to master or qty times price",()=>{
  const variants=[
    data=>data.receipts[0].status="draft",
    data=>data.receipts=[],
    data=>data.lines=[],
    data=>data.lines[0].line_amount=null,
    data=>data.lines[0].line_amount="invalid",
    data=>data.lines[0].line_amount=1.5,
    data=>data.links[0].purchase_receipt_id="other"
  ];
  variants.forEach(change=>{
    const data=fixture();change(data);
    assert.ok([...calculate(data).values()].every(cost=>!cost.priced&&cost.reason));
  });
});
test("grouped allocations reject missing sales, quantities and incompatible units instead of equal splitting",()=>{
  for(const change of [
    data=>data.sales.pop(),
    data=>data.sales[0].net_weight=null,
    data=>data.lines[0].price_unit="unknown",
    data=>data.sales[0].net_weight=-1
  ]){
    const data=fixture();change(data);
    assert.ok([...calculate(data).values()].every(cost=>cost.reason==="配分数量・単位要確認"));
  }
});
test("filtering to one customer/date/site still includes every linked sale in the denominator",async()=>{
  const data=fixture();data.sales[1].work_date="2026-09-01";
  const client=clientFor(data);
  const rows=[{id:"a",source_type:"現場確定",work_date:"2026-08-31"}];
  assert.deepEqual(await logic.salesRefAttachPurchaseCosts(client,rows),{actual:1});
  assert.equal(rows[0]._purchaseCostActual,3000);
  assert.equal(rows[0]._purchaseSupplierCode,"ACTUAL-SUPPLIER");
  assert.ok(client.calls.some(call=>call.table==="sales_records"&&call.ids.includes("b")));
  assert.ok(client.calls.every(call=>!call.table.includes("master")));
});
test("domestic intermediary uses its original export sale link, not its domestic line ID",async()=>{
  const data=fixture();
  const rows=[{id:"domestic",_domesticSale:true,_sourceSalesRecordId:"b"},{id:"direct",_domesticSale:true}];
  await logic.salesRefAttachPurchaseCosts(clientFor(data),rows);
  assert.equal(rows[0]._purchaseCostActual,7000);
  assert.equal(logic.salesRefCostInfo(rows[1]).priced,false);
});
test("unlinked historical and direct purchases are not matched automatically by product/month",async()=>{
  const rows=[{id:"a",source_type:"過去データ",product_id:"001"},{id:"not-linked",source_type:"現場確定",product_id:"001"}];
  const client=clientFor(fixture());
  await logic.salesRefAttachPurchaseCosts(client,rows);
  assert.ok(rows.every(row=>logic.salesRefCostInfo(row).reason==="仕入未紐づけ"));
  assert.ok(client.calls.every(call=>!call.ids.includes("a")));
});
test("reload reflects purchase corrections, unconfirmation and deleted links without retaining old cost",async()=>{
  const data=fixture(),rows=[{id:"a",source_type:"現場確定"}];
  await logic.salesRefAttachPurchaseCosts(clientFor(data),rows);
  data.lines[0].line_amount=20000;
  await logic.salesRefAttachPurchaseCosts(clientFor(data),rows);
  assert.equal(rows[0]._purchaseCostActual,6000);
  data.receipts[0].status="draft";
  await logic.salesRefAttachPurchaseCosts(clientFor(data),rows);
  assert.equal(logic.salesRefCostInfo(rows[0]).reason,"仕入未確定");
  data.links=[];
  await logic.salesRefAttachPurchaseCosts(clientFor(data),rows);
  assert.equal(logic.salesRefCostInfo(rows[0]).reason,"仕入未紐づけ");
});
test("all links are paginated past 1000 sales before allocating",async()=>{
  const data=fixture(1205);
  data.links=Array.from({length:1205},(_,i)=>({sales_record_id:`sale-${i}`,purchase_line_id:"line",purchase_receipt_id:"receipt"}));
  data.sales=data.links.map(link=>({id:link.sales_record_id,net_weight:1}));
  const rows=[{id:"sale-0",source_type:"現場確定"}];
  await logic.salesRefAttachPurchaseCosts(clientFor(data),rows);
  assert.equal(rows[0]._purchaseCostActual,1);
});
test("cost display accepts actual zero and ignores unlinked estimates",()=>{
  assert.equal(logic.salesRefCostInfo({_purchaseCostActual:0,_purchaseCostSource:"linked"}).priced,true);
  assert.equal(logic.salesRefCostInfo({_purchaseCostActual:500,_purchaseCostSource:"monthly_pdf"}).priced,false);
  assert.equal(logic.salesRefCostInfo({pending_entry_id:"credit"}).amount,0);
});
test("purchase period excludes previous-year comparison and supports all periods",async()=>{
  const rangeSource=section("function profitReferenceDatabaseRange","async function salesRefReadPurchaseSummary");
  let input={raw:"202608",from:"2026-08-01",to:"2026-08-31"};
  const getRange=new Function("salesRefDateRangeFromInput",rangeSource+";return profitReferenceDatabaseRange;")(()=>input);
  assert.deepEqual(getRange(),{ranges:[{from:"2026-08-01",to:"2026-08-31"}]});
  const source=section("async function salesRefReadPurchaseSummary","async function loadProfitReferenceBoard");
  const receipts=[
    {purchase_date:"2025-08-03",status:"confirmed",subtotal:100,shipping_fee:0,other_fee:0},
    {purchase_date:"2026-08-03",status:"confirmed",subtotal:300,shipping_fee:20,other_fee:5},
    {purchase_date:"2026-09-01",status:"confirmed",subtotal:500},
    {purchase_date:"2026-08-15",status:"draft",subtotal:999}
  ];
  const summarize=new Function("purchaseRefReadReceipts","val","ReferenceSites","purchaseJpyAmount",source+";return salesRefReadPurchaseSummary;")(
    async()=>receipts,()=>"",{},value=>Number(value)||0);
  assert.deepEqual(await summarize(null,getRange()),{subtotal:300,fees:25,cost:325,receiptCount:1});
  input={raw:"",from:"",to:""};
  assert.equal((await summarize(null,getRange())).cost,925);
});
test("profit loader uses the selected period and fails closed on failed sales reads",()=>{
  const source=section("async function loadProfitReferenceBoard","function salesRefResetPage");
  assert.match(source,/range=profitReferenceDatabaseRange\(\)/);
  assert.match(source,/if\(!salesLoaded\)/);
  assert.match(source,/salesRefAttachPurchaseCosts\(client,filteredRows\)/);
  assert.doesNotMatch(source,/salesRefAttachMasterCostContext|salesRefAllocateImportedPurchaseCosts/);
});
