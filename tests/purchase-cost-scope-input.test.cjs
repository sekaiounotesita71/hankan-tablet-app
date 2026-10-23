const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");
const PurchaseCostScope=require("../purchase-cost-scope.js");
const PurchaseTaxDisplay=require("../purchase-tax-display.js");
const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
const importers=[{code:"01",name:"DIM",aliases:["DIM FZ"]},{code:"03",name:"FBI"},{code:"07",name:"JKT"},{code:"09",name:"Inactive",is_active:false}];

function source(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start);
  return html.slice(a,b);
}
function plain(value){return JSON.parse(JSON.stringify(value))}
function fixture(overrides={}){
  const fields={"advance-purchase-date":"2026-10-23","advance-purchase-site":"OSA","advance-purchase-supplier":"45","advance-purchase-entry-type":"purchase"};
  const elements=new Map(),alerts=[],calls=[];
  let sequence=0;
  const ctx={
    PurchaseCostScope,PurchaseTaxDisplay,getMasters:()=>({importers}),newAppUuid:()=>`row-${++sequence}`,
    salesRefMoney:value=>Number(value).toLocaleString("ja-JP",{maximumFractionDigits:2}),
    esc:value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])),
    dbNumber:value=>value===undefined||value===null||String(value).trim()===""?null:Number(value),
    salesRefBuildImporterIndex:()=>({}),
    salesRefImporterIdentity:({importer_code:code})=>({code:importers.find(item=>[item.code,item.name,...(item.aliases||[])].includes(String(code)))?.code||String(code)}),
    advancePurchaseRows:[],advancePurchaseDatesLoading:false,advancePurchaseSaving:false,
    advancePurchaseMasterPriceSelections:new Set(),purchaseReceipts:[],dbReady:true,currentUser:{id:"internal-user"},
    val:id=>fields[id]||"",today:()=>"2026-10-23",lookupSupplierByCode:code=>({code}),
    document:{getElementById:id=>{
      if(!elements.has(id))elements.set(id,{value:fields[id]||"",classList:{toggle(){}},textContent:"",className:""});
      return elements.get(id);
    },querySelector:selector=>elements.get(selector)||null,querySelectorAll:()=>[]},
    saveAdvancePurchaseDraft:()=>calls.push("save-draft"),renderAdvancePurchaseRows:()=>calls.push("render"),
    updateAdvancePurchaseSummary:()=>{},showAdvancePurchaseProductSuggestions:()=>{},
    requestAnimationFrame:callback=>callback(),focusAdvancePurchaseCell:()=>true,
    setAppBusy:()=>{},alert:message=>alerts.push(message),console:{warn(){}},
    sitePartnerDbError:error=>error.message||String(error),
    supabaseClient:{rpc:async(name,args)=>{calls.push({name,args:plain(args)});return {data:null,error:null}}},
    clearAdvancePurchaseRows:()=>calls.push("clear"),loadPurchaseReceipts:async()=>{},
    ...overrides
  };
  vm.createContext(ctx);
  vm.runInContext(source("function purchaseMoneyPairHtml(","function salesRefGrossBoxKey("),ctx);
  vm.runInContext(html.match(/function blankAdvancePurchaseRow\(\)\{[^\n]+/)[0],ctx);
  vm.runInContext(source("function purchaseCostScopeImporters(","function advancePurchaseRowActive("),ctx);
  vm.runInContext(source("function advancePurchaseRowActive(","function advancePurchaseAmount("),ctx);
  vm.runInContext(source("function advancePurchaseIsCreditNote(","function advancePurchaseTaxAmount("),ctx);
  vm.runInContext(source("function advancePurchaseValidation(","function initialWorkspaceTab("),ctx);
  return {ctx,fields,elements,alerts,calls};
}
function active(ctx,changes={}){
  return {...ctx.blankAdvancePurchaseRow(),productCode:"1198",productName:"Product",actualQty:"2.5",unitPrice:"1200",...changes};
}

test("direct input requires an active importer or explicit shared/domestic choice, never a phantom row",()=>{
  const {ctx}=fixture();
  const row=active(ctx);
  ctx.advancePurchaseRows=[row];
  assert.equal(ctx.advancePurchaseValidation().firstInvalid,0);
  for(const [costScope,costImporterCode,valid] of [["importer","01",true],["importer","99",false],["importer","09",false],["shared","",true],["domestic","",true],["unassigned","",false]]){
    Object.assign(row,{costScope,costImporterCode});
    assert.equal(ctx.advancePurchaseValidation().firstInvalid,valid?null:0,`${costScope}:${costImporterCode}`);
  }
  ctx.advancePurchaseRows=[{...ctx.blankAdvancePurchaseRow(),costScope:"shared"}];
  assert.equal(ctx.advancePurchaseActiveRows().length,0);
  assert.equal(ctx.advancePurchaseValidation().firstInvalid,null);
});

test("quoted rows derive canonical numeric importer, mixed shared and missing unassigned",()=>{
  const {ctx}=fixture();
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"DIM FZ"}),"01");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"unknown",importer_id:"03"}),"03");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"unknown"}),"");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"99"}),"");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"09"}),"");
  const row=active(ctx,{sourceSalesIds:["a","b"],sourceSaleImporters:{a:"01",b:"01"},costScope:"domestic"});
  assert.deepEqual(plain(ctx.advancePurchaseCostScope(row)),{scope:"importer",importerCode:"01"});
  row.sourceSaleImporters.b="03";
  assert.deepEqual(plain(ctx.advancePurchaseCostScope(row)),{scope:"shared",importerCode:""});
  delete row.sourceSaleImporters.b;
  assert.deepEqual(plain(ctx.advancePurchaseCostScope(row)),{scope:"unassigned",importerCode:""});
  assert.equal(ctx.advancePurchaseCostScopeValid(row),true,"DB remains authoritative for quoted sources");
});

test("ambiguous importer names never inherit the first matching identity",()=>{
  const {ctx}=fixture({getMasters:()=>({importers:[...importers,{code:"12",name:"DIM"}]})});
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"DIM"}),"");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"DIM",importer_id:"01"}),"01");
});

test("registered alphanumeric importer codes are offered and derived while unknown codes fail closed",()=>{
  const {ctx}=fixture({getMasters:()=>({importers:[...importers,{code:"LEGACY_DIM",name:"Legacy DIM",aliases:["Legacy Exact"]},{code:"BAD CODE",name:"Invalid"},{code:"OLD_FBI",name:"Inactive Legacy",is_active:false}]})});
  assert.equal(ctx.purchaseCostScopeImporterExists("LEGACY_DIM"),true);
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"LEGACY_DIM"}),"LEGACY_DIM");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"Legacy Exact"}),"LEGACY_DIM");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"Legacy"}),"");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"UNKNOWN_DIM"}),"");
  assert.equal(ctx.purchaseCostScopeSalesImporter({importer_code:"99"}),"");
  const options=ctx.purchaseCostScopeOptionsHtml("importer","LEGACY_DIM");
  assert.match(options,/value="importer:LEGACY_DIM" selected>LEGACY_DIM Legacy DIM/);
  assert.doesNotMatch(options,/BAD CODE|OLD_FBI/);
  ctx.advancePurchaseRows=[active(ctx,{costScope:"importer",costImporterCode:"LEGACY_DIM"})];
  assert.equal(ctx.advancePurchaseValidation().firstInvalid,null);
});

test("dropdown labels are escaped, numeric codes included and legacy unassigned distinguished",()=>{
  const {ctx}=fixture();
  const options=ctx.purchaseCostScopeOptionsHtml("","");
  assert.match(options,/value="" selected disabled>選択してください/);
  assert.match(options,/01 DIM/);assert.match(options,/03 FBI/);
  assert.match(options,/全体仕入（複数輸入社）/);assert.match(options,/国内仕入/);
  assert.doesNotMatch(options,/Inactive|value="importer:09"/);
  const legacy=ctx.purchaseCostScopeOptionsHtml("unassigned","",{legacy:true});
  assert.match(legacy,/value="" selected disabled>未分類/);assert.doesNotMatch(legacy,/マスタ未登録/);
  assert.match(ctx.purchaseCostScopeOptionsHtml("importer","99",{legacy:true}),/99（マスタ未登録）/);
  assert.match(ctx.advancePurchaseCostScopeSelectHtml(active(ctx,{sourceSalesIds:["a"],sourceSaleImporters:{a:"01"}}),0),/disabled/);
  assert.doesNotMatch(ctx.advancePurchaseCostScopeSelectHtml(active(ctx,{costScope:"shared"}),0),/data-advance-field="costChoice" disabled/);
});

test("changing manual scope persists without rerender and quoted choices cannot be overridden",()=>{
  const {ctx,calls}=fixture();
  vm.runInContext(source("function setAdvancePurchaseRow(","function hideAdvancePurchaseProductSuggestions("),ctx);
  const row=active(ctx);ctx.advancePurchaseRows=[row];
  ctx.setAdvancePurchaseRow(0,"costChoice","importer:07");
  assert.equal(row.costScope,"importer");assert.equal(row.costImporterCode,"07");
  assert.deepEqual(calls,["save-draft"]);
  row.sourceSalesIds=["a"];row.sourceSaleImporters={a:"01"};ctx.advancePurchaseCostScope(row);
  ctx.setAdvancePurchaseRow(0,"costChoice","shared");
  assert.equal(row.costScope,"importer");assert.equal(row.costImporterCode,"01");
  assert.equal(calls.length,1);
});

test("duplicated quoted rows and credit conversion clear source classification; manual duplicate retains explicit choice",()=>{
  const {ctx}=fixture();
  vm.runInContext(source("function duplicateAdvancePurchaseRow(","function removeAdvancePurchaseRow("),ctx);
  vm.runInContext(source("function setAdvancePurchaseEntryType(","function setAdvancePurchaseImportMode("),ctx);
  const quoted=active(ctx,{sourceSalesIds:["a"],sourceSaleDates:{a:"2026-09-01"},sourceSaleImporters:{a:"01"},costScope:"importer",costImporterCode:"01"});
  ctx.advancePurchaseRows=[quoted];ctx.duplicateAdvancePurchaseRow(0);
  const duplicate=ctx.advancePurchaseRows[1];
  assert.deepEqual(plain(duplicate.sourceSalesIds),[]);assert.deepEqual(plain(duplicate.sourceSaleImporters),{});
  assert.equal(duplicate.costScope,"");assert.equal(ctx.advancePurchaseCostScopeValid(duplicate),false);
  duplicate.costScope="domestic";ctx.duplicateAdvancePurchaseRow(1);
  assert.equal(ctx.advancePurchaseRows[2].costScope,"domestic");
  ctx.setAdvancePurchaseEntryType("credit_note");
  assert.equal(quoted.costScope,"");assert.deepEqual(plain(quoted.sourceSaleImporters),{});
  assert.equal(duplicate.costScope,"domestic");
});

test("old drafts hydrate importer alongside dates in bounded chunks and patch cells only",async()=>{
  const queries=[];
  const {ctx,elements,calls}=fixture({supabaseClient:{from(table){
    assert.equal(table,"sales_records");
    return {select(fields){assert.equal(fields,"id,work_date,importer_code,importer_id");return this},async in(field,ids){
      queries.push(ids);return {data:ids.map(id=>({id,work_date:"2026-09-03",importer_code:"DIM"}))};
    }};
  }}});
  vm.runInContext(source("function advancePurchaseSourceDatesHtml(","function renderAdvancePurchaseRows("),ctx);
  const row=active(ctx,{sourceSalesIds:Array.from({length:451},(_,i)=>`sale-${i}`)});
  ctx.advancePurchaseRows=[row];
  const dateCell={},scopeSelect={};
  elements.set('[data-advance-source-dates="0"]',dateCell);
  elements.set('[data-advance-row-index="0"][data-advance-field="costChoice"]',scopeSelect);
  await ctx.refreshAdvancePurchaseSourceDates();
  assert.deepEqual(queries.map(ids=>ids.length),[200,200,51]);
  assert.equal(row.sourceSaleImporters["sale-450"],"01");assert.equal(row.sourceSaleDates["sale-450"],"2026-09-03");
  assert.equal(row.costScope,"importer");assert.equal(row.costImporterCode,"01");
  assert.equal(scopeSelect.disabled,true);assert.match(scopeSelect.innerHTML,/value="importer:01" selected/);
  assert.equal(dateCell.innerHTML,"2026/09/03");assert.equal(row.unitPrice,"1200");assert.equal(row.actualQty,"2.5");
  assert.deepEqual(calls,["save-draft"]);
  await ctx.refreshAdvancePurchaseSourceDates();assert.equal(queries.length,3);
});

test("draft save and restore retain both explicit choices and per-source importer maps",()=>{
  const storage=new Map();
  const {ctx}=fixture({
    ADVANCE_PURCHASE_DRAFT_KEY:"draft",advancePurchaseImportMode:"product",
    localStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)},
    supplierPurchaseReferenceMode:value=>value||"day",normalizeImporterCode:value=>value,
    setAdvancePurchaseReferenceMode(){},setAdvancePurchaseImportMode(){},setAdvancePurchaseEntryType(){},updateAdvancePurchaseHeader(){}
  });
  vm.runInContext(source("function saveAdvancePurchaseDraft(","function setAdvancePurchaseEntryType("),ctx);
  ctx.advancePurchaseRows=[active(ctx,{costScope:"domestic"}),active(ctx,{costScope:"importer",costImporterCode:"01",sourceSalesIds:["sale"],sourceSaleImporters:{sale:"01"},sourceSaleDates:{sale:"2026-10-22"}})];
  ctx.saveAdvancePurchaseDraft();
  const saved=JSON.parse(storage.get("draft"));
  assert.equal(saved.rows[0].costScope,"domestic");assert.deepEqual(saved.rows[1].sourceSaleImporters,{sale:"01"});
  ctx.advancePurchaseRows=[];ctx.loadAdvancePurchaseDraft();
  assert.equal(ctx.advancePurchaseRows[0].costScope,"domestic");
  assert.deepEqual(plain(ctx.advancePurchaseRows[1].sourceSaleImporters),{sale:"01"});
});

test("monthly product quote groups mixed importers as shared while detail quote keeps each importer",async()=>{
  for(const mode of ["product","detail"]){
    const sales=[{id:"a",importer_code:"DIM",work_date:"2026-10-01",input_qty:2},{id:"b",importer_id:"07",work_date:"2026-10-22",input_qty:3}]
      .map(row=>({...row,session_id:"session",source_row_no:1,product_id:"1198",product_name:"Product",origin:"Osaka",input_unit:"Kg"}));
    const {ctx}=fixture({
      advancePurchaseImportMode:mode,purchaseSourceReviewOpen:false,
      advancePurchaseReferenceRange:()=>({mode:"month",from:"2026-10-01",to:"2026-10-31",label:"2026年10月"}),
      readSalesForAdvancePurchase:async()=>sales,readOrderSuppliersForAdvancePurchase:async()=>new Map([["session|1","45"]]),
      readImportedSalesIdsForAdvancePurchase:async()=>new Set(),advancePurchaseSaleSourceKey:()=>"session|1",
      normalizeImporterCode:value=>value,findMasterProduct:()=>({}),normalizeLineUnit:value=>value,
      productPurchasePriceForSupplier:()=>({price:1000,unit:"Kg"}),
      supabaseClient:{from:()=>({select:()=>({in:async()=>({data:[{id:"session",site_code:"OSA"}]})})})}
    });
    vm.runInContext(source("async function importSalesIntoAdvancePurchase(","function updateAdvancePurchaseSummary("),ctx);
    await ctx.importSalesIntoAdvancePurchase();
    assert.equal(ctx.advancePurchaseRows.length,mode==="product"?1:2);
    assert.equal(ctx.advancePurchaseRows.reduce((sum,row)=>sum+row.actualQty,0),5);
    if(mode==="product")assert.equal(ctx.advancePurchaseRows[0].costScope,"shared");
    else assert.deepEqual(Array.from(ctx.advancePurchaseRows,row=>row.costImporterCode),["01","07"]);
    assert.deepEqual(plain(Object.assign({},...ctx.advancePurchaseRows.map(row=>row.sourceSaleImporters))),{a:"01",b:"07"});
  }
});

test("all purchase types submit scoped V6 atomically and never call old fallbacks",async()=>{
  for(const entryType of ["purchase","credit_note"]){
    const {ctx,fields,calls,alerts}=fixture();fields["advance-purchase-entry-type"]=entryType;
    ctx.advancePurchaseRows=[active(ctx,{costScope:"importer",costImporterCode:"07",actualQty:entryType==="credit_note"?"-2.5":"2.5",note:"keep"})];
    await ctx.saveAdvancePurchaseBatch();
    const rpc=calls.find(call=>call?.name);
    assert.equal(rpc.name,"create_confirmed_purchase_batch_v6");
    assert.equal(rpc.args.p_entry_type,entryType);
    assert.equal(rpc.args.p_lines[0].cost_scope,"importer");assert.equal(rpc.args.p_lines[0].cost_importer_code,"07");
    assert.equal(rpc.args.p_lines[0].actual_qty,2.5);assert.equal(rpc.args.p_lines[0].unit_price,1200);
    assert.equal(rpc.args.p_lines[0].tax_rate,8);assert.equal(rpc.args.p_lines[0].note,"keep");
    assert.equal(alerts.length,1);assert.match(alerts[0],/仕入確定しました/);
  }
});

test("quoted payload deduplicates source ids and sends derived shared scope without allocating",async()=>{
  const {ctx,calls}=fixture();
  ctx.advancePurchaseRows=[active(ctx,{sourceSalesIds:["a","b","a"],sourceSaleImporters:{a:"01",b:"07"},costScope:"domestic"})];
  await ctx.saveAdvancePurchaseBatch();
  const line=calls.find(call=>call?.name).args.p_lines[0];
  assert.equal(line.cost_scope,"shared");assert.equal(line.cost_importer_code,null);
  assert.deepEqual(line.source_sales_ids,["a","b"]);assert.equal(line.actual_qty,2.5);
});

test("double submission is suppressed and missing V6 fails closed without clearing draft",async()=>{
  let finish;
  const {ctx,calls,alerts}=fixture({supabaseClient:{rpc(name,args){calls.push({name,args});return new Promise(resolve=>finish=resolve)}}});
  ctx.advancePurchaseRows=[active(ctx,{costScope:"shared"})];
  const first=ctx.saveAdvancePurchaseBatch();await ctx.saveAdvancePurchaseBatch();
  assert.equal(calls.length,1);assert.equal(ctx.advancePurchaseSaving,true);
  finish({error:{code:"PGRST202",message:"Could not find create_confirmed_purchase_batch_v6"}});await first;
  assert.equal(ctx.advancePurchaseSaving,false);assert.equal(calls.includes("clear"),false);
  assert.match(alerts[0],/purchase-cost-scope-migration.sql/);
});

test("existing confirmed manual scope uses metadata RPC only and preserves financial values",async()=>{
  const line={id:"line",actual_qty:2.5,unit_price:1200,line_amount:3000,tax_rate:8};
  const receipt={id:"receipt",status:"confirmed",subtotal:3000,total_amount:3240,accounts_payable_id:"paid-ap",lines:[line]};
  let finish;
  const {ctx,calls}=fixture({purchaseReceipts:[receipt],invalidateProfitReference:()=>calls.push("invalidate-profit"),supabaseClient:{rpc(name,args){calls.push({name,args:plain(args)});return new Promise(resolve=>finish=resolve)},from(){throw new Error("No financial writes allowed")}}});
  ctx.applyPurchaseLineCostScope(line,{scope:"unassigned",editable:true});
  const input={disabled:false};
  const saving=ctx.savePurchaseLineCostScope("line","importer:07",input);
  assert.equal(input.disabled,true);await ctx.savePurchaseLineCostScope("line","domestic",input);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{name:"set_purchase_line_cost_scope",args:{p_purchase_line_id:"line",p_scope:"importer",p_importer_code:"07"}});
  finish({error:null});await saving;
  assert.equal(calls.at(-1),"invalidate-profit");
  assert.equal(input.disabled,false);assert.equal(line.cost_scope,"importer");assert.equal(line.cost_importer_code,"07");
  assert.equal(receipt.status,"confirmed");assert.equal(receipt.accounts_payable_id,"paid-ap");assert.equal(receipt.subtotal,3000);assert.equal(receipt.total_amount,3240);
  assert.equal(line.actual_qty,2.5);assert.equal(line.unit_price,1200);assert.equal(line.line_amount,3000);assert.equal(line.tax_rate,8);
});

test("existing auto-source lines remain readonly and failed metadata edit restores selection",async()=>{
  const line={id:"line",cost_scope:"importer",cost_importer_code:"01",cost_scope_editable:false};
  const {ctx,calls,alerts}=fixture({purchaseReceipts:[{lines:[line]}]});
  assert.match(ctx.purchaseLineCostScopeSelectHtml(line),/disabled/);
  await ctx.savePurchaseLineCostScope("line","shared");assert.equal(calls.length,0);
  line.cost_scope_editable=true;
  ctx.supabaseClient.rpc=async()=>({error:{message:"not authorized"}});
  const input={disabled:false};await ctx.savePurchaseLineCostScope("line","shared",input);
  assert.equal(line.cost_importer_code,"01");assert.equal(line.cost_scope,"importer");
  assert.match(input.innerHTML,/value="importer:01" selected/);assert.equal(input.disabled,false);assert.deepEqual(alerts,["not authorized"]);
});

test("confirmed receipt retains financial locks but permits only server-approved scope edits",()=>{
  const {ctx}=fixture({
    currentUserIsAdmin:()=>false,purchaseUnitOptions:()=>"",purchaseTaxRateOptions:()=>"",purchaseSiteOptions:()=>"",
    purchaseJpyAmount:Number,siteNameFromCode:value=>value,purchaseReceiptTypeLabel:()=>"直接入力",purchaseStatusLabel:()=>"確定済み"
  });
  vm.runInContext(source("function purchaseReceiptCardHtml(","function renderPurchaseReceipts("),ctx);
  const line={id:"line",product_code:"1198",product_name:"Product",actual_qty:2.5,unit_price:1200,tax_rate:8,line_amount:3000,cost_scope:"shared",cost_scope_editable:true};
  const markup=ctx.purchaseReceiptCardHtml({id:"receipt",status:"confirmed",total_amount:3240,lines:[line]});
  assert.match(markup,/value="1200" disabled onchange="savePurchaseLineField/);
  assert.match(markup,/value="2.5" disabled onchange="savePurchaseLineField/);
  assert.match(markup,/data-purchase-cost-scope="line"  onchange="savePurchaseLineCostScope/);
  line.cost_scope_editable=false;
  assert.match(ctx.purchaseReceiptCardHtml({id:"receipt",status:"confirmed",total_amount:3240,lines:[line]}),/data-purchase-cost-scope="line" disabled/);
});

test("Enter traverses manual scope and skips quoted readonly scope without losing focus",()=>{
  const {ctx,elements}=fixture();
  vm.runInContext(source("function focusAdvancePurchaseCell(","function moveAdvancePurchaseVertical("),ctx);
  const visited=[];
  for(const field of ["productName","costChoice","origin"]){
    elements.set(`[data-advance-row-index="0"][data-advance-field="${field}"]`,{focus:()=>visited.push(field),scrollIntoView(){},disabled:false});
  }
  ctx.advancePurchaseRows=[active(ctx)];
  const fromName={dataset:{advanceRowIndex:"0",advanceField:"productName"}};
  ctx.moveAdvancePurchaseFocus(fromName,1);assert.deepEqual(visited,["costChoice"]);
  elements.get('[data-advance-row-index="0"][data-advance-field="costChoice"]').disabled=true;
  ctx.moveAdvancePurchaseFocus(fromName,1);assert.deepEqual(visited,["costChoice","origin"]);
  ctx.moveAdvancePurchaseFocus({dataset:{advanceRowIndex:"0",advanceField:"origin"}},-1);
  assert.deepEqual(visited,["costChoice","origin","productName"]);
});

test("existing receipt reads authoritative scoped metadata in bounded chunks",async()=>{
  const lines=Array.from({length:205},(_,index)=>({id:`line-${index}`,receipt_id:"receipt"}));
  const calls=[];
  const {ctx}=fixture({
    purchaseRefDatabaseRange:()=>({label:"month"}),purchaseRefReadReceipts:async()=>[{id:"receipt",status:"confirmed"}],
    salesRefReadPaged:async()=>lines,
    salesRefReadChunks:async(ids,size,reader)=>{
      const result=[];for(let index=0;index<ids.length;index+=size)result.push(...await reader(ids.slice(index,index+size)));return result;
    },
    purchaseRefResetPage(){},renderPurchaseReceipts(){},
    supabaseClient:{from:()=>({select(){return this},in(){return this},order(){return this}}),rpc:async(name,args)=>{
      calls.push({name,ids:args.p_line_ids});return {data:args.p_line_ids.map(id=>({purchase_line_id:id,scope:"importer",importer_code:"01",assignment_method:"sales_link",editable:false}))};
    }}
  });
  vm.runInContext(source("async function loadPurchaseReceipts(","function purchaseReceiptCardHtml("),ctx);
  await ctx.loadPurchaseReceipts();
  assert.deepEqual(calls.map(call=>call.ids.length),[100,100,5]);
  assert.equal(calls.every(call=>call.name==="get_purchase_line_cost_scopes"),true);
  assert.equal(ctx.purchaseReceipts[0].lines[204].cost_importer_code,"01");
  assert.equal(ctx.purchaseReceipts[0].lines[204].cost_scope_editable,false);
});

test("module is loaded before app code and all inline scripts parse",()=>{
  assert.match(html,/<script src="\.\/purchase-cost-scope.js\?v=20261023-1"><\/script>/);
  assert.match(html,/<th>商品名<\/th><th>輸入社・仕入区分<\/th><th>産地/);
  for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
