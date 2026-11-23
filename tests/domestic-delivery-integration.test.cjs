const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const work=fs.readFileSync(path.join(root,'index.html'),'utf8');
const order=fs.readFileSync(path.join(root,'order-entry-beta.html'),'utf8');
const domestic=fs.readFileSync(path.join(root,'domestic-sales.html'),'utf8');
const core=require('../domestic-delivery-export.js');
function section(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return text.slice(a,b)}
function context(values={}){return vm.createContext({console,...values})}

test('external order number retains text and leading zeros through order/work/sales mappings',()=>{
  const a=context();vm.runInContext(section(order,'function dbBatchToBatch(', 'async function saveConfirmedBatchToDb('),a);
  const batch=a.dbBatchToBatch({id:'batch'},[{id:'line',external_order_no:'0005A'}]);
  assert.equal(batch.rows[0].externalOrderNo,'0005A');
  const ctx=context({currentSessionId:'s',currentUser:{id:'u'},sitePartnerSchemaReady:true,numberOrNull:v=>v===''||v==null?null:Number(v),importerCodeFromRow:()=> '08',countryCode:()=> '08'});
  vm.runInContext(section(work,'function rowToOrderLinePayload(', 'function syncOrderRowsFromRows('),ctx);
  const row=ctx.orderLineToLocalRow({external_order_no:'0005A',source_row_no:3,product_name:'魚'});
  assert.equal(row.external_order_no,'0005A');
  assert.equal(ctx.rowToOrderLinePayload(row).external_order_no,'0005A');
  assert.equal(ctx.rowToOrderLinePayload({...row,external_order_no:''}).external_order_no,'');
  Object.assign(ctx,{importerCode:v=>v,boxMap:{},currentSessionSiteCode:'OSA',currentWorkDateValue:()=> '2026-11-19',roundFinancialProduct:(a,b)=>Math.round(a*b)});
  vm.runInContext(section(work,'function salesRecordPayloadTrial(', 'async function finalizeSalesTrial('),ctx);
  assert.equal(ctx.salesRecordPayloadTrial({...row,importer_id:'08'}).external_order_no,'0005A');
  assert.equal(ctx.salesRecordPayloadTrial({...row,importer_id:'08',external_order_no:''}).external_order_no,'');
});

test('confirmed-order import and CSV preserve the dedicated number, independent of memo',()=>{
  const ctx=context({rememberImporterDisplayName(){},masterMap:{},normalizeProductId:v=>v,workMasterPriceResolution:()=>({value:100,source:'受注価格'}),workOriginRomanize:v=>v,countryCode:v=>v});
  vm.runInContext(section(work,'function orderEntryLineToWorkRow(', 'async function loadConfirmedOrderBatchesForWork('),ctx);
  const row=ctx.orderEntryLineToWorkRow({importer_code:'08'},{id:'source',external_order_no:'0016',product_name_snapshot:'魚',purchase_note:'備考'},0);
  assert.equal(row.external_order_no,'0016');assert.equal(row._memo,'備考');
  assert.match(order,/externalOrderNo:orderCsvValue\(row,headers,\["external_order_no","先方受注番号"/);
  assert.match(order,/external_order_no:dbText\(row.externalOrderNo\)/);
  assert.match(work,/external_order_no:\["external_order_no","先方受注番号"/);
  assert.match(work,/external_order_no:r.external_order_no\|\|"",customer:customer/);
});

test('external order number stays optional for ordinary orders but rejects oversized imported numbers before writes',async()=>{
  let writes=0;
  const ctx=context({dbReady:true,supabaseClient:{},saveConfirmedBatchToDb:async()=>{writes++;return {id:'new',created:true}}});
  vm.runInContext(section(order,'function validateOrderExternalNumbers(', 'async function saveConfirmedBatchToDb('),ctx);
  const rows=[{}, {externalOrderNo:''},{externalOrderNo:'0005A'},{externalOrderNo:'あ'.repeat(120)}];
  ctx.validateOrderExternalNumbers(rows);
  assert.equal(rows[2].externalOrderNo,'0005A');
  assert.throws(()=>ctx.validateOrderExternalNumbers([{externalOrderNo:'x'.repeat(121)}]),/1行目.*120/);
  vm.runInContext(section(order,'async function saveImportedBatchesToDbAtomically(', 'async function persistImportedConfirmedBatches('),ctx);
  await assert.rejects(ctx.saveImportedBatchesToDbAtomically([{rows},{rows:[{externalOrderNo:'x'.repeat(121)}]}]),/先方受注番号/);
  assert.equal(writes,0);
  assert.ok(order.indexOf('validateOrderExternalNumbers(batch.rows);',order.indexOf('async function saveConfirmedBatchToDb('))<order.indexOf('prepareBatchPrices(batch);',order.indexOf('async function saveConfirmedBatchToDb(')));
});

test('metadata lengths are checked before saving and messages name the affected field',()=>{
  const app=appContext(),row={revision:0,lineNo:1,orderNo:'',cartonNo:'',productName:'商品',spec:'',origin:'',weight:'',unitPrice:0,amount:0,customerName:''};
  core.validateRows([row]);
  for(const [field,limit,label] of [['orderNo',120,'先方受注番号'],['cartonNo',120,'提出用箱番号'],['spec',300,'規格・数量'],['customerName',300,'得意先']]){
    assert.doesNotThrow(()=>core.validateRows([{...row,[field]:'あ'.repeat(limit)}]));
    let error;try{core.validateRows([{...row,[field]:'あ'.repeat(limit+1)}])}catch(e){error=e}
    assert.ok(error);
    assert.ok(app.errorText(error).includes(label));
    assert.ok(app.errorText(error).includes(String(limit)));
  }
});

test('phase 1.5 patches the order number only, not money or quantity',async()=>{
  const patches=[],row={_idx:3,external_order_no:'0005',_qty:3,unit_price:1800};
  const ctx=context({rows:[row],currentSessionId:'session',requireEditableTrial:()=>true,numberOrNull:v=>Number(v),toast(){},scheduleP15Refresh(){},scheduleP1InlineRefresh(){},updateOrderLineFieldsToSupabase:async(r,p)=>{patches.push(p);return true}});
  vm.runInContext(section(work,'const p15PendingFields=', 'function setImportPanelVisible('),ctx);
  assert.equal(await ctx.saveP15Field(3,'external_order_no','0006A'),true);
  assert.equal(patches[0].external_order_no,'0006A');assert.equal(Object.keys(patches[0]).length,1);
  assert.equal(row._qty,3);assert.equal(row.unit_price,1800);
  assert.equal(await ctx.saveP15Field(3,'external_order_no','x'.repeat(121)),false);
});

test('remote number clears propagate while payloads without the field preserve it',()=>{
  const row={_idx:0,external_order_no:'0005',customer:'店',importer_id:'08'};
  const ctx=context({rows:[row],syncOrderRowsFromRows(){},countryCode:v=>v});
  vm.runInContext(section(work,'function upsertRemoteOrderLine(', 'function boxToPayload('),ctx);
  ctx.upsertRemoteOrderLine({source_row_no:1});assert.equal(row.external_order_no,'0005');
  ctx.upsertRemoteOrderLine({source_row_no:1,external_order_no:null});assert.equal(row.external_order_no,'');
});

test('existing print remains present alongside the new export; all inline scripts compile',()=>{
  assert.match(domestic,/onclick="printDomesticDeliveryNote\('\$\{row.id\}'\)">納品書/);
  assert.match(domestic,/onclick="openDomesticDeliveryExport\('\$\{row.id\}'\)">納品書データ/);
  for(const [name,html] of [['work',work],['order',order],['domestic',domestic]])for(const [i,match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries())if(match[1].trim())new vm.Script(match[1],{filename:`${name}-${i}`});
});

function appContext(stored){
  const ctx=context({DomesticDeliveryExport:core,localStorage:{getItem(){if(stored===undefined)throw Error('quota');return JSON.stringify(stored)},setItem(){throw Error('quota')}}});
  vm.runInContext(fs.readFileSync(path.join(root,'domestic-delivery-export-app.js'),'utf8'),ctx);return ctx.DomesticDeliveryExportApp;
}
test('display carton normalization never strips supplier prefixes or mutates field box numbers',()=>{
  const app=appContext(),input=[{cartonNo:'009',sourceCartonNo:'009'},{cartonNo:'MAR-1',sourceCartonNo:'MAR-1'}];
  const result=app.normalizeCartons(input,'JNX/No,Y');
  assert.equal(result[0].cartonNo,'JNX/No,Y009');assert.equal(result[1].cartonNo,'');
  assert.equal(input[0].cartonNo,'009');assert.equal(input[1].cartonNo,'MAR-1');
  assert.throws(()=>app.validateCartons([{lineNo:1,sourceCartonNo:'MAR-1',cartonNo:'JNX/No,Y1'},{lineNo:2,sourceCartonNo:'YUK-1',cartonNo:'JNX/No,Y1'}],'JNX/No,Y'),/重複/);
  assert.throws(()=>app.validateCartons([{lineNo:1,sourceCartonNo:'MAR-1',cartonNo:'JNX/No,Y1'},{lineNo:2,sourceCartonNo:'MAR-1',cartonNo:'JNX/No,Y2'}],'JNX/No,Y'),/複数/);
});
test('metadata payload excludes finances and saved comparison checks exact identities',()=>{
  const app=appContext(),row={id:'one',revision:2,orderNo:'0005',cartonNo:'JNX/No,Y9',spec:'3kg',customerName:'店',amount:5400,unitPrice:1800};
  const payload=app.metadataRows([row])[0];
  assert.deepEqual(Object.keys(payload).sort(),['delivery_carton_no','delivery_customer_name','delivery_spec','expected_revision','external_order_no','id']);
  assert.equal(payload.external_order_no,'0005');assert.equal(app.sameMetadata([row],[{...row}]),true);
  assert.equal(app.sameMetadata([{...row,id:'foreign'}],[row]),false);
  assert.equal(app.sameMetadata([row,{...row,id:'new'}],[row]),false);
  assert.equal(app.sameMetadata([row,row],[row,row]),false);
  assert.equal(app.preferences('code','10').prefix,'JNX/No,Y');
  assert.equal(app.preferences('code','01').prefix,'');
});

test('new and legacy preferences include the independent customer column after order number',()=>{
  const expected=['orderNo','customerName','cartonNo','productName','spec','origin','weight','unitPrice','amount'];
  assert.deepEqual(Array.from(appContext().preferences('new').columns),expected);
  const legacy={columns:[...core.defaultColumns8],prefix:'JNX/No,Y',orderLabel:'Client order'};
  const upgraded=appContext(legacy).preferences('old');
  assert.equal(upgraded.version,2);assert.equal(upgraded.orderLabel,'Client order');
  assert.deepEqual(Array.from(upgraded.columns),expected);
  assert.deepEqual(legacy.columns,core.defaultColumns8);
  const moved={...legacy,columns:['amount','orderNo','cartonNo']};
  assert.deepEqual(Array.from(appContext(moved).preferences('custom').columns),['amount','orderNo','customerName','cartonNo']);
  const saved={...legacy,version:2,columns:['amount','customerName','orderNo']};
  assert.deepEqual(Array.from(appContext(saved).preferences('v2').columns),saved.columns);
});

test('standard Excel and CSV layout has nine columns, one customer on each goods row and no duplicate subrows',()=>{
  const columns=Array.from(appContext().preferences('new').columns);
  const row={id:'line',revision:0,lineNo:1,orderNo:'0005',cartonNo:'JNX/No,Y9',productName:'アサリ',spec:'3kg',origin:'北海道',weight:3,unitPrice:1800,amount:5400,customerName:'FB(TMR10)'};
  const data=core.sheetRows([row],columns);
  assert.equal(data.length,2);assert.equal(data[0].length,9);
  assert.deepEqual(data[1],['0005','FB(TMR10)','JNX/No,Y9','アサリ','3kg','北海道',3,1800,5400]);
  assert.match(core.csv([row],columns),/"0005","FB\(TMR10\)","JNX\/No,Y9"/);
  assert.equal(core.validateRows([row],{requireCustomer:true})[0],row);
  assert.throws(()=>core.validateRows([{...row,customerName:' '}],{requireCustomer:true}),/customerName is required/);
  assert.match(appContext().errorText(Error('Row 1 customerName is required.')),/1行目の得意先/);
});

test('only planned importer 10 gets the J NEXT carton prefix; other importers retain every existing carton format',()=>{
  const app=appContext({prefix:'JNX/No,Y'});
  for(const code of ['10','１０',' 10 '])assert.equal(app.preferences('same-customer',code).prefix,'JNX/No,Y');
  for(const code of ['01','08','010','11','JNX','',null,undefined]){
    const prefs=app.preferences('same-customer',code);
    assert.equal(prefs.prefix,'');
    assert.equal(prefs.orderLabel,'先方受注番号');
    const rows=[{lineNo:1,cartonNo:'MAR-1',sourceCartonNo:'MAR-1'},
      {lineNo:2,cartonNo:'0012',sourceCartonNo:'0012'},
      {lineNo:3,cartonNo:'Supplier/2-A',sourceCartonNo:'Supplier/2-A'}];
    assert.deepEqual(Array.from(app.normalizeCartons(rows,prefs.prefix),r=>({...r})),rows);
    assert.doesNotThrow(()=>app.validateCartons(rows,prefs.prefix));
  }
});

test('only importer 10 updates the old default column order to the supplied carton-before-customer layout',()=>{
  const oldDefault=Array.from(appContext().preferences('code','01').columns);
  const expected=['orderNo','cartonNo','customerName',...oldDefault.slice(3)];
  assert.deepEqual(Array.from(appContext().preferences('code','10').columns),expected);
  const previous={version:2,columns:oldDefault,orderLabel:'J NEXT order'};
  const updated=appContext(previous).preferences('code','10');
  assert.equal(updated.version,3);
  assert.deepEqual(Array.from(updated.columns),expected);
  assert.equal(updated.orderLabel,'J NEXT order');
  assert.deepEqual(Array.from(appContext(previous).preferences('code','01').columns),oldDefault);
  assert.deepEqual(Array.from(appContext({...previous,version:3}).preferences('code','10').columns),oldDefault);
  const custom=['customerName','orderNo','cartonNo','amount'];
  assert.deepEqual(Array.from(appContext({...previous,columns:custom}).preferences('code','10').columns),custom);
});

test('column and heading preferences are scoped to importer plus billing customer, not the customer alone',()=>{
  const stored=new Map([
    ['domestic-delivery-export-v2:10:SAME',{version:2,columns:['amount','orderNo'],prefix:'JNX/No,Y',orderLabel:'J NEXT order'}],
    ['domestic-delivery-export-v2:01:SAME',{version:2,columns:['productName','cartonNo'],prefix:'JNX/No,Y',orderLabel:'Other order'}],
    ['domestic-delivery-export-v1:SAME',{version:2,columns:['amount'],prefix:'JNX/No,Y',orderLabel:'Unscoped legacy'}]
  ]);
  const ctx=context({DomesticDeliveryExport:core,localStorage:{getItem:key=>JSON.stringify(stored.get(key)||null)}});
  vm.runInContext(fs.readFileSync(path.join(root,'domestic-delivery-export-app.js'),'utf8'),ctx);
  const app=ctx.DomesticDeliveryExportApp;
  assert.deepEqual(Array.from(app.preferences('SAME','10').columns),['amount','orderNo']);
  assert.deepEqual(Array.from(app.preferences('SAME','01').columns),['productName','cartonNo']);
  assert.equal(app.preferences('SAME','01').prefix,'');
  assert.equal(app.preferences('SAME','01').orderLabel,'Other order');
  assert.equal(app.preferences('SAME','08').orderLabel,'先方受注番号');
  assert.equal(app.preferences('OTHER','10').orderLabel,'J NEXT様の\nオーダー番号');
});
