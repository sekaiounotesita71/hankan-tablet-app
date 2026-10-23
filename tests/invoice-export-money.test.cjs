const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

function source(name,last=false){
  let start=last?html.lastIndexOf(`function ${name}(`):html.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  if(html.slice(start-6,start)==='async ')start-=6;
  const firstEnd=html.indexOf('\n',start);
  if(html.slice(start,firstEnd).endsWith('}'))return html.slice(start,firstEnd);
  const end=html.indexOf('\n}',firstEnd);
  return html.slice(start,end+2);
}
function app(){
  const context=vm.createContext({
    currentSessionWorkDate:'2026-10-22',
    normalizeWorkDate:value=>value,
    currentWorkDateValue:()=> '2026-10-22',
    customsInvoiceRowImporter:record=>record.code||'01',
    customsInvoiceNo:()=> '20261022001',
    customsInvoiceShipping:settings=>settings.shipping||0,
    customsInvoiceNumber:value=>value===''||value==null?null:Number(value),
    customsInvoiceCf:()=> 'C',
    customsInvoiceRuleFor:()=>null,
    customsInvoiceNameFallback:()=>({english:'',source:'',ambiguous:false})
  });
  for(const name of ['financialDecimalParts','roundFinancialProduct','roundFinancialAmount','roundJpyAmount','roundInvoiceAmount',
    'billingInvoiceLine','customsInvoiceLine','invoiceExportMode','buildCustomsInvoiceContexts','adjustedInvoiceRawRows']){
    vm.runInContext(source(name),context);
  }
  return context;
}
function record(qty,price,options={}){
  return {'商品コード':'150','エンドユーザー店名':'CUSTOMER','商品名':'Product','英名・学術名':'Product',
    '産地':'Japan','ケース番号':'18','現場入力数量':qty,'現場入力単位':'Kg','単価':price,'金額':Number(qty)*Number(price),
    __sourceRow:{product_name:'Product'},__isPending:false,...options};
}
function settings(currency='JPY',shipping=0){
  return {importerCodes:['01'],profiles:new Map([['01',{currency,shipper_name:'Shipper',shipper_address:'Address',
    consignee_name:'Consignee',consignee_address:'Address',destination_port:'Singapore'}]]),rules:[],shipping};
}

test('decimal operands round half away from zero before binary multiplication can lose the half yen',()=>{
  const a=app();
  for(const [qty,price,expected] of [[1.13,3050,3447],[-1.13,3050,-3447],[0.29,50,15],
    [1.005,100,101],[1.13,-3050,-3447],[3.57,3050,10889],[0,3050,0],[2e-7,2500000,1],
    [0.9999999999,0.5,0],[-0.9999999999,0.5,0]]){
    assert.equal(a.roundFinancialProduct(qty,price),expected,`${qty} * ${price}`);
  }
  assert.equal(a.roundFinancialAmount(1.005,2),1.01);
  assert.equal(a.roundFinancialAmount(-1.005,2),-1.01);
});

function appliedApp(tables={}){
  const a=app();
  a.currentSessionId='current';a.currentSessionSiteCode='OSA';
  a.pendingInvoiceTargetDate=()=> '2026-10-22';
  a.pendingInvoiceTargetImporters=()=> ['01'];
  a.pendingInvoiceReference=()=> '20261022001';
  a.invoiceImporterCode=value=>String(value);
  a.normalizeImporterCode=value=>String(value);
  a.ReferenceSites=require('../reference-sites.js');
  const reads=[];
  a.supabaseClient={from(table){
    const filters=[];
    const query={select(){return query},order(){return query},
      eq(key,value){filters.push(row=>row[key]===value);return query},
      in(key,values){filters.push(row=>values.includes(row[key]));return query},
      async range(from,to){reads.push(table);return {data:(tables[table]||[]).filter(row=>filters.every(fn=>fn(row))).slice(from,to+1),error:null}}
    };
    return query;
  }};
  vm.runInContext(source('loadAppliedInvoiceEntries')+'\n'+source('invoiceEntriesForExport'),a);
  return {a,reads};
}
const applied=(id,customer_code,extra={})=>({id,customer_code,importer_code:'01',status:'applied',applied_invoice_no:'20261022001',applied_work_date:'2026-10-22',...extra});

test('re-export includes applied entries only for the exact linked session or customer code/importer/site',async()=>{
  const {a}=appliedApp({pending_entries:[applied('osaka','C1'),applied('tokyo','C2'),applied('other-session','C1'),
    applied('this-session','C2'),applied('other-date','C1',{applied_work_date:'2026-10-21'}),
    applied('other-importer','C1',{importer_code:'03'}),applied('hold','C1',{status:'hold'})],
    accounts_receivable:[{id:'ar1',source_key:'pending:other-session',source_session_id:'other'},
      {id:'ar2',source_key:'pending:this-session',source_session_id:'current'}],
    customer_master:[{id:'c1',customer_code:'C1',importer_code:'01',site_code:'OSA'},
      {id:'c2',customer_code:'C2',importer_code:'01',site_code:'TYO'},
      {id:'c3',customer_code:'C1',importer_code:'03',site_code:'TYO'}]});
  assert.deepEqual(Array.from(await a.loadAppliedInvoiceEntries('01'),x=>x.id),['osaka','this-session']);
  const merged=a.invoiceEntriesForExport([applied('osaka','C1')],[applied('osaka','C1'),applied('new','C1')]);
  assert.deepEqual(Array.from(merged,x=>x.id),['osaka','new']);
});

test('applied-entry loading is paginated and read-only; missing or ambiguous site does not default to Osaka',async()=>{
  const entries=Array.from({length:501},(_,i)=>applied(`p${i}`,'C1'));
  const tables={pending_entries:entries,customer_master:[{id:'c1',customer_code:'C1',importer_code:'01',site_code:'OSA'}]};
  const before=JSON.stringify(tables),{a,reads}=appliedApp(tables);
  assert.equal((await a.loadAppliedInvoiceEntries('01')).length,501);
  assert.equal(reads.filter(table=>table==='pending_entries').length,2);
  assert.equal(JSON.stringify(tables),before);
  tables.customer_master=[];
  await assert.rejects(()=>a.loadAppliedInvoiceEntries('01'),/作業拠点を特定できません/);
  tables.customer_master=[{id:'c1',customer_code:'C1',importer_code:'01',site_code:'OSA'},
    {id:'c2',customer_code:'C1',importer_code:'01',site_code:'TYO'}];
  await assert.rejects(()=>a.loadAppliedInvoiceEntries('01'),/作業拠点を特定できません/);
});

test('repeated billing exports retain prior credits without claiming or rolling back applied financial entries',async()=>{
  const {a}=appliedApp({pending_entries:[applied('credit','C1',{'amount':-1})],
    customer_master:[{id:'c1',customer_code:'C1',importer_code:'01',site_code:'OSA'}]});
  const exported=[];let claims=0,rollbacks=0;
  Object.assign(a,{ExcelJS:{Workbook:class{}},rows:[],closeExportPicker(){},requireSupabaseLogin:async()=>true,
    loadPendingInvoiceCandidates:async()=>[],setSaveState(){},toast(){},pendingInvoiceDbErrorMessage:String,
    alert:message=>{throw new Error(message)},loadCustomsInvoiceSettings:async()=>({...settings(),schemaReady:true}),
    buildExportPayload:(country,entries)=>({headers:[],p2Sheets:[],boxNumberList:[],p1data:[record(1.13,3050),
      ...entries.map(entry=>record(1,-1,{__isPending:true,'金額':entry.amount}))]}),
    buildCommercialInvoiceExcelJs:(workbook,context)=>{exported.push(context)},
    customsInvoiceSheetName:name=>name,importerDisplayName:()=> 'Importer',invoiceExportModeLabel:()=> 'Billing',
    addInvoiceCheckExcelJs(){},addExcelJsJsonSheet(){},saveExcelJsWorkbook:async()=>{},saveCustomsInvoiceExportLogs:async()=>{},
    claimPendingInvoiceEntries:async()=>{claims++;throw new Error('must not reapply')},
    rollbackPendingInvoiceEntries:async()=>{rollbacks++}
  });
  vm.runInContext(source('doExport',true),a);
  await a.doExport('01','billing');await a.doExport('01','billing');
  assert.deepEqual(exported.map(context=>context.total),[3446,3446]);
  assert.equal(claims,0);assert.equal(rollbacks,0);
});

for(const mode of ['billing','customs'])test(`${mode} invoice and Invoice Data keep the same rounded lines, credits and totals`,()=>{
  const a=app();
  const records=[record(1.13,3050),record(0.29,50),record(1.005,100),
    record(0.165,-190000,{__isPending:true,'金額':-31350}),
    record(1,-5040,{__isPending:true,'金額':-5040}),
    record(1,0),record(10,9000,{'欠品':'欠品'})];
  const payload={headers:['商品コード','商品名','現場入力数量','単価','金額','欠品'],p1data:records};
  const contexts=a.buildCustomsInvoiceContexts(payload,settings('JPY',170583),mode);
  const invoice=contexts[0];
  assert.deepEqual(Array.from(invoice.lines,line=>line.amount),[3447,15,101,-31350,-5040,0]);
  assert.equal(invoice.subtotal,-32827);
  assert.equal(invoice.shipping,170583);
  assert.equal(invoice.total,137756);
  const raw=a.adjustedInvoiceRawRows(payload,contexts);
  assert.deepEqual(Array.from(raw.slice(0,6),row=>row['金額']),Array.from(invoice.lines,line=>line.amount));
  assert.equal(records[0]['金額'],3446.4999999999995,'input was not changed');
});

test('foreign currency retains two decimal places and pending entries retain their explicit amount',()=>{
  const a=app();
  const records=[record(0.29,0.5),record(1.005,1),record(0.5,-0.29),record(2,20,{__isPending:true,'金額':17.005})];
  const invoice=a.buildCustomsInvoiceContexts({p1data:records},settings('USD',1.005),'billing')[0];
  assert.deepEqual(Array.from(invoice.lines,line=>line.amount),[0.15,1.01,-0.15,17.01]);
  assert.equal(invoice.subtotal,18.02);assert.equal(invoice.shipping,1.01);assert.equal(invoice.total,19.03);
});

test('invoice rounding agrees with PostgreSQL numeric across decimal quantities, unit prices and half boundaries',async()=>{
  const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
  const db=new PGlite();
  try{
    const a=app(),pairs=[];
    for(const q of ['1.13','-1.13','0.29','1.005','3.57','0.9999999999','0.0000002','2.675']){
      for(const p of ['3050','50','100','0.5','-3050','2500000']){
        for(const digits of [0,2])pairs.push({q,p,digits});
      }
    }
    const {rows}=await db.query(`select q,p,digits,round(q::numeric*p::numeric,digits)::text as expected
      from jsonb_to_recordset($1::jsonb) as x(q text,p text,digits integer)`,[JSON.stringify(pairs)]);
    for(const row of rows)assert.equal(a.roundFinancialProduct(row.q,row.p,row.digits),Number(row.expected),JSON.stringify(row));
  }finally{await db.close()}
});
