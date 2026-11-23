"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const Export=require("../domestic-delivery-export.js");

const labels=[
  "\u5148\u65b9\u53d7\u6ce8\u756a\u53f7","\u30ab\u30fc\u30c8\u30f3NO","\u5546\u54c1\u540d",
  "\u898f\u683c\u30fb\u6570\u91cf","\u7523\u5730","\u5546\u54c1\u91cd\u91cf","\u5358\u4fa1 \u5186","\u5408\u8a08\u91d1\u984d \u5186"
];
const keys=["orderNo","cartonNo","productName","spec","origin","weight","unitPrice","amount"];
const customer="\u5927\u962a\u5e97";
const product="\u78ba\u5b9a\u30de\u30b0\u30ed";
const origin="\u5317\u6d77\u9053";

function fixture(lineChanges={},sourceChanges={},saleChanges={}){
  const line={id:"line-1",sale_id:"sale-1",line_no:1,source_sales_record_id:"source-1",
    product_name_snapshot:product,quantity:"2.5",unit:"Kg",unit_price_jpy:"123.4567",net_amount_jpy:"300.25",
    delivery_export_revision:0,memo:"DOMESTIC MEMO IS NOT A SPEC",...lineChanges};
  const source={id:"source-1",session_id:"session-1",importer_code:"JNX",external_order_no:"00001230",
    box_no:"SUP-X/007",product_name:"STALE PRODUCT",origin,net_weight:"88",input_qty:"99",input_unit:"Kg",
    ordered_qty:"4",ordered_unit:"PC",store_name:customer,memo:"SOURCE MEMO IS NOT A SPEC",unit_price:999,amount:999,...sourceChanges};
  return {sale:{id:"sale-1",status:"confirmed",source_session_id:"session-1",source_importer_code:"JNX",
    shipping_amount_jpy:999,total_amount_jpy:9999,lines:[line],...saleChanges},source};
}
function make(lineChanges={},sourceChanges={},saleChanges={}){
  const {sale,source}=fixture(lineChanges,sourceChanges,saleChanges);
  return Export.makeRows(sale,[source]);
}
function freezeDeep(value){
  if(value&&typeof value==="object"){
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function parseCsv(csv){
  assert.equal(csv[0],"\ufeff");
  const rows=[];
  let row=[],cell="",quoted=false;
  for(let i=1;i<csv.length;i++){
    const char=csv[i];
    if(quoted){
      if(char==='"'&&csv[i+1]==='"'){cell+='"';i++;}
      else if(char==='"')quoted=false;
      else cell+=char;
    }else if(char==='"'){
      assert.equal(cell,"");quoted=true;
    }else if(char===","){
      row.push(cell);cell="";
    }else if(char==="\r"){
      assert.equal(csv[++i],"\n");row.push(cell);rows.push(row);row=[];cell="";
    }else{
      assert.notEqual(char,"\n");cell+=char;
    }
  }
  assert.equal(quoted,false);assert.deepEqual(row,[]);assert.equal(cell,"");
  return rows;
}

class FakeRow{
  constructor(values){this.cells=values.map(value=>({value}));}
  getCell(index){assert.ok(index>=1&&index<=this.cells.length);return this.cells[index-1];}
}
class FakeWorksheet{
  constructor(name,options){
    this.name=name;this.views=options.views;this.pageSetup=options.pageSetup;
    this.headerFooter={};this.columns=[];this.rows=[];
  }
  addRow(values){const row=new FakeRow(values);this.rows.push(row);return row;}
  getRow(index){return this.rows[index-1];}
  getCell(row,column){return this.getRow(row).getCell(column);}
}
class FakeWorkbook{
  constructor(){
    this.worksheets=[];
    this.xlsx={writeBuffer(){assert.fail("The export module must not save a workbook.");}};
  }
  addWorksheet(name,options){const sheet=new FakeWorksheet(name,options);this.worksheets.push(sheet);return sheet;}
}
const FakeExcelJS={Workbook:FakeWorkbook};
function workbookData(book){return book.worksheets[0].rows.map(row=>row.cells.map(cell=>cell.value));}

test("exports the precise API and immutable nine-column schema",()=>{
  assert.deepEqual(Object.keys(Export),["columns","defaultColumns8","makeRows","validateRows","cartonNumber","sheetRows","csv","createWorkbook"]);
  assert.deepEqual(Export.defaultColumns8,keys);
  assert.deepEqual(Export.columns.map(column=>column.key),[...keys,"customerName"]);
  assert.deepEqual(Export.columns.slice(0,8).map(column=>column.label),labels);
  assert.ok(Object.isFrozen(Export.columns));assert.ok(Object.isFrozen(Export.defaultColumns8));
  for(const column of Export.columns){
    assert.deepEqual(Object.keys(column),["key","label","width"]);
    assert.ok(column.width>0);assert.ok(Object.isFrozen(column));
  }
});

test("loads without Node or DOM dependencies as DomesticDeliveryExport",()=>{
  const sandbox={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","domestic-delivery-export.js"),"utf8"),sandbox);
  assert.equal(typeof sandbox.DomesticDeliveryExport.makeRows,"function");
  assert.equal(sandbox.DomesticDeliveryExport.cartonNumber("007"),"JNX/No,Y007");
});

test("uses exact standardized keys and confirmed domestic product, quantity, price and persisted amount",()=>{
  assert.deepEqual(make(),[{
    id:"line-1",lineNo:1,orderNo:"00001230",cartonNo:"SUP-X/007",productName:product,spec:"4PC",origin,
    weight:2.5,unitPrice:123.4567,amount:300.25,customerName:customer,sourceCartonNo:"SUP-X/007",revision:0
  }]);
  assert.notEqual(make()[0].amount,2.5*123.4567);
  assert.deepEqual(make({net_amount_jpy:"123.45"})[0].amount,123.45);
});

test("does not mutate frozen input or consult shipping and summary totals",()=>{
  const {sale,source}=fixture();
  const before=structuredClone({sale,source});freezeDeep(sale);freezeDeep(source);
  const rows=Export.makeRows(sale,Object.freeze([source]));
  Export.sheetRows(freezeDeep(rows));Export.csv(rows);Export.createWorkbook(FakeExcelJS,rows);
  assert.deepEqual({sale,source},before);assert.equal(rows.length,1);assert.equal(rows[0].amount,300.25);
});

test("requires a confirmed sale and actual domestic lines",()=>{
  for(const status of [undefined,null,"draft","cancelled",""]){
    assert.throws(()=>Export.makeRows({status,lines:[{}]}),/confirmed/);
  }
  for(const lines of [undefined,null,[],{}])assert.throws(()=>Export.makeRows({status:"confirmed",lines}),/lines/);
  assert.throws(()=>make({sale_id:"other-sale"}),/another sale/);
  assert.throws(()=>make({product_name_snapshot:" "}),/product_name_snapshot/);
  assert.throws(()=>make({unit:""}),/unit/);
});

test("joins ONLY by the exact source_sales_record_id, never product, order or position",()=>{
  const {sale,source}=fixture({source_sales_record_id:"missing",quantity:3,unit:"PC",product_code:"same"});
  const rows=Export.makeRows(sale,[{...source,product_id:"same",source_row_no:1}]);
  assert.deepEqual(rows,[{id:"line-1",lineNo:1,orderNo:"",cartonNo:"",productName:product,spec:"",origin:"",weight:"",
    unitPrice:123.4567,amount:300.25,customerName:"",sourceCartonNo:"",revision:0}]);
  assert.equal(Export.makeRows({...sale,lines:[{...sale.lines[0],source_sales_record_id:"1"}]},[{...source,id:1}])[0].orderNo,"");
  assert.equal(Export.makeRows(sale)[0].spec,"");
});

test("rejects duplicate or missing source IDs, even on otherwise unused records",()=>{
  const {sale,source}=fixture();
  assert.throws(()=>Export.makeRows(sale,[source,{...source}]),/Duplicate source id/);
  assert.throws(()=>Export.makeRows(sale,[source,{id:"unused"},{id:"unused"}]),/Duplicate source id/);
  for(const row of [{},null,{id:" "}])assert.throws(()=>Export.makeRows(sale,[row]),/Source id/);
  assert.throws(()=>Export.makeRows(sale,{}),/sourceSales/);
});

test("rejects matched source session/importer mismatches when both scopes are provided",()=>{
  assert.throws(()=>make({}, {session_id:"foreign"}),/foreign session_id/);
  assert.throws(()=>make({}, {importer_code:"foreign"}),/foreign importer_code/);
  assert.throws(()=>make({}, {importer_code:null,importer_id:"foreign"}),/foreign importer_code/);
  assert.equal(make({}, {session_id:null,importer_code:null,importer_id:null})[0].orderNo,"00001230");
  assert.equal(make({}, {importer_code:null,importer_id:"JNX"})[0].orderNo,"00001230");
  assert.equal(make({}, {session_id:"other",importer_code:"other"}, {source_session_id:null,source_importer_code:null})[0].orderNo,"00001230");
  const {sale,source}=fixture();
  assert.equal(Export.makeRows(sale,[source,{id:"unlinked",session_id:"foreign",importer_code:"foreign"}]).length,1);
});

test("sorts numerically by line_no and preserves original order for ties",()=>{
  const {sale,source}=fixture();const base=sale.lines[0];
  sale.lines=[{...base,id:"ten",line_no:"10"},{...base,id:"two-a",line_no:2},{...base,id:"two-b",line_no:2}];
  const rows=Export.makeRows(sale,[source]);
  assert.deepEqual(rows.map(row=>row.id),["two-a","two-b","ten"]);
  assert.deepEqual(sale.lines.map(row=>row.id),["ten","two-a","two-b"]);
  for(const line_no of [null,"",0,-1,1.5,NaN])assert.throws(()=>make({line_no}),/line_no/);
});

test("metadata overrides source fields without changing sourceCartonNo",()=>{
  for(const delivery_metadata_saved of [false,true,undefined]){
    const row=make({external_order_no:"00099",delivery_carton_no:"JNX/No,Y0007",delivery_spec:"CUSTOM\nSPEC",
      delivery_customer_name:"CUSTOMER",delivery_metadata_saved})[0];
    assert.deepEqual([row.orderNo,row.cartonNo,row.spec,row.customerName,row.sourceCartonNo],
      ["00099","JNX/No,Y0007","CUSTOM\nSPEC","CUSTOMER","SUP-X/007"]);
  }
  const row=make({external_order_no:"",delivery_carton_no:"",delivery_spec:"",delivery_customer_name:""})[0];
  assert.deepEqual([row.orderNo,row.cartonNo,row.spec,row.customerName],["","","",""]);
});

test("saved SQL NULL metadata is explicitly cleared; revision alone never disables source fallback",()=>{
  const metadata={external_order_no:null,delivery_carton_no:null,delivery_spec:null,delivery_customer_name:null};
  const cleared=make({...metadata,delivery_metadata_saved:true,delivery_export_revision:4})[0];
  assert.deepEqual([cleared.orderNo,cleared.cartonNo,cleared.spec,cleared.customerName,cleared.sourceCartonNo,cleared.revision],
    ["","","","","SUP-X/007",4]);
  for(const delivery_metadata_saved of [undefined,null,false]){
    const inherited=make({...metadata,delivery_metadata_saved,delivery_export_revision:4})[0];
    assert.deepEqual([inherited.orderNo,inherited.cartonNo,inherited.spec,inherited.customerName,inherited.revision],
      ["00001230","SUP-X/007","4PC",customer,4]);
  }
  const inserted=make({external_order_no:"000-COPIED",delivery_metadata_saved:false})[0];
  assert.equal(inserted.orderNo,"000-COPIED");
  assert.throws(()=>Export.validateRows([cleared],{requireOrderNumber:true}),/orderNo/);
  assert.throws(()=>Export.validateRows([cleared],{requireCarton:true}),/cartonNo/);
});

test("revision is only the validated nonnegative delivery_export_revision token",()=>{
  assert.equal(make({delivery_export_revision:"7",revision:900},{},{revision:901})[0].revision,7);
  assert.equal(make({delivery_export_revision:null,revision:900})[0].revision,0);
  assert.equal(make({delivery_export_revision:undefined})[0].revision,0);
  for(const delivery_export_revision of [-1,1.5,"",true,Infinity,"NaN",Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>make({delivery_export_revision}),/delivery_export_revision/);
  }
});

test("Kg weight always follows the corrected domestic quantity, not stale source data",()=>{
  for(const unit of ["Kg","kg"," KG ","\uff2b\uff27"]){
    assert.equal(make({quantity:"1.125",unit},{net_weight:88,input_qty:99})[0].weight,1.125);
  }
  assert.equal(make({quantity:3},{net_weight:"corrupt"})[0].weight,3);
});

test("non-Kg weight is usable only when domestic quantity AND normalized unit match source inputs",()=>{
  assert.equal(make({quantity:"4",unit:"PC"},{input_qty:4,input_unit:" pc ",net_weight:"1.75"})[0].weight,1.75);
  assert.equal(make({quantity:4,unit:"PC"},{input_qty:"4.0000",input_unit:"PC",net_weight:0})[0].weight,0);
  for(const input_qty of [3,null,"",false,"garbage"]){
    assert.equal(make({quantity:4,unit:"PC"},{input_qty,input_unit:"PC",net_weight:99})[0].weight,"");
  }
  for(const input_unit of ["Kg","pkt",null,""]){
    assert.equal(make({quantity:4,unit:"PC"},{input_qty:4,input_unit,net_weight:99})[0].weight,"");
  }
  assert.equal(make({quantity:4,unit:"PC"},{input_qty:3,input_unit:"PC",net_weight:"corrupt"})[0].weight,"");
  for(const net_weight of [null,undefined,""]){
    assert.equal(make({quantity:4,unit:"PC"},{input_qty:4,input_unit:"PC",net_weight})[0].weight,"");
  }
  for(const net_weight of [-1,"corrupt",Infinity,false]){
    assert.throws(()=>make({quantity:4,unit:"PC"},{input_qty:4,input_unit:"PC",net_weight}),/net_weight/);
  }
});

test("spec comes ONLY from ordered_qty + ordered_unit or an explicit metadata override",()=>{
  assert.equal(make({quantity:1,unit:"Kg"},{ordered_qty:8,ordered_unit:"pkt",memo:"NOT A SPEC"})[0].spec,"8pkt");
  assert.equal(make({}, {ordered_qty:0})[0].spec,"0PC");
  for(const sourceChanges of [{ordered_qty:null},{ordered_qty:""},{ordered_unit:null},{ordered_unit:""}]){
    assert.equal(make({},sourceChanges)[0].spec,"");
  }
  assert.equal(make({delivery_spec:"USER SPEC"},{ordered_qty:"invalid"})[0].spec,"USER SPEC");
  assert.equal(make({delivery_metadata_saved:true,delivery_spec:null},{ordered_qty:"invalid"})[0].spec,"");
  assert.throws(()=>make({}, {ordered_qty:"invalid"}),/ordered_qty/);
});

test("numeric validation never converts missing, boolean or malformed financial input to zero",()=>{
  const invalid=[null,undefined,""," ",false,true,[],{},"1,234","0x10","nope",NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1];
  for(const field of ["quantity","unit_price_jpy","net_amount_jpy"]){
    for(const value of [...invalid,-1])assert.throws(()=>make({[field]:value}),new RegExp(field));
  }
  assert.throws(()=>make({quantity:0}),/quantity/);
  const row=make({quantity:"0.1250",unit_price_jpy:"0",net_amount_jpy:"0"})[0];
  assert.deepEqual([row.weight,row.unitPrice,row.amount],[0.125,0,0]);
});

test("validateRows is chainable, validates exported numbers, and makes order/carton requirements opt-in",()=>{
  const rows=make({external_order_no:null,delivery_carton_no:null,delivery_metadata_saved:true,unit_price_jpy:0,net_amount_jpy:0});
  assert.equal(Export.validateRows(rows),rows);
  assert.throws(()=>Export.validateRows(rows,{requireOrderNumber:true}),/orderNo/);
  assert.throws(()=>Export.validateRows(rows,{requireCarton:true}),/cartonNo/);
  assert.equal(Export.sheetRows(rows).length,2);
  const complete=make({unit_price_jpy:0,net_amount_jpy:0});
  assert.equal(Export.validateRows(complete,{requireOrderNumber:true,requireCarton:true}),complete);
  for(const key of ["unitPrice","amount"]){
    for(const value of [null,undefined,""," ",false,NaN,Infinity,-1]){
      assert.throws(()=>Export.validateRows([{...complete[0],[key]:value}]),new RegExp(key));
    }
  }
  assert.throws(()=>Export.validateRows([{...complete[0],weight:-1}]),/weight/);
  assert.throws(()=>Export.validateRows([{...complete[0],productName:" "}]),/productName/);
  assert.throws(()=>Export.validateRows({}),/array/);
  assert.throws(()=>Export.validateRows([null]),/Invalid row/);
});

test("order numbers remain literal text with leading zeros and a 120-character maximum",()=>{
  const orderNo="0".repeat(120);
  assert.equal(make({external_order_no:orderNo})[0].orderNo,orderNo);
  assert.equal(make({external_order_no:"\ud83d\ude00".repeat(120)})[0].orderNo.length,240);
  assert.throws(()=>make({external_order_no:"0".repeat(121)}),/120 characters/);
  assert.throws(()=>Export.validateRows([{...make()[0],orderNo:"x".repeat(121)}]),/120 characters/);
  assert.throws(()=>Export.validateRows([{...make()[0],orderNo:" \t "}],{requireOrderNumber:true}),/orderNo/);
});

test("carton formatter accepts digit strings only, composes the exact prefix and is never applied implicitly",()=>{
  assert.equal(Export.cartonNumber("0007"),"JNX/No,Y0007");
  assert.equal(Export.cartonNumber("0007","CUSTOM/No, Y "),"CUSTOM/No, Y 0007");
  assert.equal(Export.cartonNumber("007",""),"007");
  for(const digits of [7,null,undefined,""," 7","7 ","-7","7.0","7/8","Y7","\uff17","7\n"]){
    assert.throws(()=>Export.cartonNumber(digits),/digit string/);
  }
  assert.throws(()=>Export.cartonNumber("7",null),/prefix/);
  assert.equal(make()[0].cartonNo,"SUP-X/007");
  assert.equal(make({delivery_carton_no:"ANY SUPPLIER PREFIX 007"})[0].sourceCartonNo,"SUP-X/007");
});

test("sheetRows defaults to eight columns, header first, numeric types, and customer below the carton",()=>{
  assert.deepEqual(Export.sheetRows(make()),[
    labels,["00001230","SUP-X/007",product,"4PC",origin,2.5,123.4567,300.25],
    ["",customer,"","","","","",""]
  ]);
  const rows=make({quantity:4,unit:"PC"},{input_qty:3});
  assert.equal(Export.sheetRows(rows)[1][5],"");
  assert.equal(typeof Export.sheetRows(rows)[1][6],"number");
});

test("custom selection keeps exact order and puts subrows under the selected carton position",()=>{
  const selected=["amount","cartonNo","orderNo"];
  assert.deepEqual(Export.sheetRows(make(),selected),[
    [labels[7],labels[1],labels[0]],[300.25,"SUP-X/007","00001230"],["",customer,""]
  ]);
  assert.deepEqual(Export.sheetRows(make(),["amount","orderNo"]),[[labels[7],labels[0]],[300.25,"00001230"]]);
  assert.deepEqual(Export.sheetRows(make(),[...keys,"customerName"]),[
    [...labels,Export.columns[8].label],["00001230","SUP-X/007",product,"4PC",origin,2.5,123.4567,300.25,customer]
  ]);
  assert.deepEqual(Export.sheetRows(make(),["customerName","cartonNo"]),[
    [Export.columns[8].label,labels[1]],[customer,"SUP-X/007"]
  ]);
  assert.equal(Export.sheetRows(make(),undefined,{customerSubrows:false}).length,2);
  assert.equal(Export.sheetRows(make({delivery_customer_name:""})).length,2);
});

test("all output APIs reject unknown, duplicate and empty selected columns",()=>{
  const rows=make();
  for(const selected of [[],["missing"],["orderNo","orderNo"],"orderNo",null,[undefined],[{}]]){
    assert.throws(()=>Export.sheetRows(rows,selected),/column/);
    assert.throws(()=>Export.csv(rows,selected),/column/);
    assert.throws(()=>Export.createWorkbook(FakeExcelJS,rows,selected),/column/);
  }
});

test("labels support editable multiline headers and identical order/subrows across CSV and workbook",()=>{
  const rows=make(),selected=["amount","orderNo","cartonNo"];
  const options={labels:{orderNo:"J NEXT\u69d8\u306e\n\u30aa\u30fc\u30c0\u30fc\u756a\u53f7",amount:"Persisted, \"JPY\"",cartonNo:""}};
  const expected=[["Persisted, \"JPY\"",options.labels.orderNo,""],[300.25,"00001230","SUP-X/007"],["","",customer]];
  assert.deepEqual(Export.sheetRows(rows,selected,options),expected);
  assert.deepEqual(workbookData(Export.createWorkbook(FakeExcelJS,rows,selected,options)),expected);
  assert.deepEqual(parseCsv(Export.csv(rows,selected,options)),expected.map(row=>row.map(String)));
  assert.equal(Export.columns[0].label,labels[0]);
  for(const output of [()=>Export.sheetRows(rows,keys,{labels:[]}),()=>Export.csv(rows,keys,{labels:"bad"}),
    ()=>Export.createWorkbook(FakeExcelJS,rows,keys,{labels:{orderNo:{formula:"1"}}})])assert.throws(output,/labels|Label/);
});

test("CSV has a UTF-8 BOM, quoted text, CRLF records, and exact persisted decimal values",()=>{
  const csv=Export.csv(make());
  assert.equal(csv,`\ufeff${labels.map(label=>'"'+label+'"').join(",")}\r\n`+
    `"00001230","SUP-X/007","${product}","4PC","${origin}",2.5,123.4567,300.25\r\n`+
    `"","${customer}","","","","","",""\r\n`);
  assert.deepEqual(Array.from(Buffer.from(csv,"utf8").subarray(0,3)),[0xef,0xbb,0xbf]);
  assert.deepEqual(parseCsv(csv),Export.sheetRows(make()).map(row=>row.map(String)));
});

test("CSV quotes commas, quotes and multiline cells without altering their content",()=>{
  const rows=make({product_name_snapshot:'Fish, "fresh"\r\nSecond line',delivery_spec:"4PC\n2pkt",
    delivery_customer_name:'Store, "A"\nBranch'});
  const csv=Export.csv(rows);
  assert.ok(csv.includes('"Fish, ""fresh""\r\nSecond line"'));
  assert.deepEqual(parseCsv(csv),Export.sheetRows(rows).map(row=>row.map(String)));
});

test("CSV neutralizes formula prefixes after leading spaces and controls, without touching numeric cells",()=>{
  const attacks=["=1+1","+SUM(1,2)","-1+1","@SUM(A1)","   =1"," \t+1","\tplain","\rtext","\ntext",
    "\u0000=1"," \u001ftext","\u007f@x"," \u0085text","\ufeff=1","\u3000-2"];
  for(const value of attacks){
    const rows=make({external_order_no:value,delivery_carton_no:value,product_name_snapshot:value,delivery_spec:value,
      delivery_customer_name:value},{origin:value});
    const parsed=parseCsv(Export.csv(rows));
    assert.deepEqual(parsed[1],[...Array(5).fill("'"+value),"2.5","123.4567","300.25"]);
    assert.deepEqual(parsed[2],["","'"+value,"","","","","",""]);
    assert.equal(Export.sheetRows(rows)[1][0],value);
  }
  const rows=make({external_order_no:"  000123",product_name_snapshot:"Normal - product"});
  assert.equal(parseCsv(Export.csv(rows))[1][0],"  000123");
  assert.equal(parseCsv(Export.csv(rows))[1][2],"Normal - product");
  const options={labels:{orderNo:"  =UNTRUSTED HEADER"}};
  assert.equal(parseCsv(Export.csv(make(),keys,options))[0][0],"'  =UNTRUSTED HEADER");
});

test("every format shares selection, labels and the customerSubrows switch",()=>{
  const rows=make({unit_price_jpy:0,net_amount_jpy:0});
  for(const selected of [keys,[...keys,"customerName"],["cartonNo","amount"],["customerName"],["amount","orderNo"]]){
    for(const customerSubrows of [true,false]){
      const options={customerSubrows,labels:{amount:"Saved amount"}};
      const expected=Export.sheetRows(rows,selected,options);
      assert.deepEqual(workbookData(Export.createWorkbook(FakeExcelJS,rows,selected,options)),expected);
      assert.deepEqual(parseCsv(Export.csv(rows,selected,options)),expected.map(row=>row.map(String)));
    }
  }
});

test("workbook is one bordered eight-column A4 portrait report, with repeated header and no totals or shipping",()=>{
  const rows=make(),book=Export.createWorkbook(FakeExcelJS,rows);
  assert.equal(book.worksheets.length,1);
  const sheet=book.worksheets[0];
  assert.equal(sheet.columns.length,8);assert.equal(sheet.rows.length,3);
  assert.deepEqual(sheet.columns,Export.columns.slice(0,8).map(({key,width})=>({key,width})));
  assert.deepEqual(workbookData(book),Export.sheetRows(rows));
  assert.deepEqual(sheet.views,[{state:"frozen",ySplit:1,showGridLines:false}]);
  assert.equal(sheet.pageSetup.paperSize,9);assert.equal(sheet.pageSetup.orientation,"portrait");
  assert.equal(sheet.pageSetup.fitToPage,true);assert.equal(sheet.pageSetup.fitToWidth,1);assert.equal(sheet.pageSetup.fitToHeight,0);
  assert.equal(sheet.pageSetup.printTitlesRow,"1:1");assert.equal(sheet.pageSetup.printArea,"A1:H3");
  assert.equal(sheet.headerFooter.oddFooter,"&R&P / &N");
  for(const row of sheet.rows){
    assert.ok(row.height>=20);
    for(const cell of row.cells){
      assert.equal(cell.alignment.wrapText,true);assert.equal(cell.alignment.vertical,"middle");
      for(const edge of ["top","bottom","left","right"])assert.equal(cell.border[edge].style,"thin");
      assert.ok(typeof cell.value==="number"||typeof cell.value==="string");
    }
  }
  assert.equal(sheet.getCell(1,1).font.bold,true);assert.equal(sheet.getCell(1,1).alignment.horizontal,"center");
  assert.equal(sheet.getCell(2,1).value,"00001230");assert.equal(sheet.getCell(2,1).numFmt,"@");
  assert.equal(sheet.getCell(2,6).value,2.5);assert.equal(sheet.getCell(2,6).numFmt,"0.####");
  assert.equal(sheet.getCell(2,7).value,123.4567);assert.equal(sheet.getCell(2,7).alignment.horizontal,"right");
  assert.equal(sheet.getCell(2,8).value,300.25);assert.equal(sheet.getCell(2,8).numFmt,"#,##0.##");
  assert.equal(sheet.getCell(3,2).value,customer);assert.equal(sheet.getCell(3,2).alignment.horizontal,"left");
});

test("workbook preserves untrusted text as string cells, never formula objects",()=>{
  const rows=make({external_order_no:"=1+1",delivery_carton_no:"+box",product_name_snapshot:"@product",delivery_spec:"-spec"});
  const sheet=Export.createWorkbook(FakeExcelJS,rows).worksheets[0];
  assert.deepEqual(sheet.getRow(2).cells.slice(0,4).map(cell=>cell.value),["=1+1","+box","@product","-spec"]);
  for(const cell of sheet.getRow(2).cells.slice(0,4))assert.equal(cell.numFmt,"@");
  assert.throws(()=>Export.createWorkbook(null,rows),/ExcelJS.Workbook/);
});

test("workbook wraps multiline edited headers and custom nine-column output",()=>{
  const rows=make({product_name_snapshot:"Long product\n".repeat(5)+"end"});
  const options={labels:{orderNo:"First\nSecond\nThird"}};
  const sheet=Export.createWorkbook(FakeExcelJS,rows,[...keys,"customerName"],options).worksheets[0];
  assert.equal(sheet.columns.length,9);assert.equal(sheet.rows.length,2);
  assert.equal(sheet.pageSetup.printArea,"A1:I2");assert.ok(sheet.getRow(1).height>=45);assert.ok(sheet.getRow(2).height>=84);
  assert.equal(sheet.getCell(1,1).value,options.labels.orderNo);assert.equal(sheet.getCell(2,9).value,customer);
});

test("empty datasets produce a header only, consistently in each format",()=>{
  assert.deepEqual(Export.sheetRows([]),[labels]);
  assert.deepEqual(parseCsv(Export.csv([])),[labels]);
  const book=Export.createWorkbook(FakeExcelJS,[]);
  assert.deepEqual(workbookData(book),[labels]);assert.equal(book.worksheets[0].pageSetup.printArea,"A1:H1");
});

let actualExcelJS;
try{actualExcelJS=require(process.env.EXCELJS_PATH||"exceljs");}
catch(error){if(error.code!=="MODULE_NOT_FOUND")throw error;}
test("actual installed ExcelJS round-trips literal text and persisted numbers without a save",{skip:!actualExcelJS},async()=>{
  const rows=make({external_order_no:"00000012",product_name_snapshot:"=literal product"});
  const options={labels:{orderNo:"Order\nnumber"}};
  const book=Export.createWorkbook(actualExcelJS,rows,undefined,options);
  const buffer=await book.xlsx.writeBuffer();
  const restored=new actualExcelJS.Workbook();await restored.xlsx.load(buffer);
  assert.equal(restored.worksheets.length,1);
  const expected=Export.sheetRows(rows,undefined,options),sheet=restored.worksheets[0];
  assert.deepEqual(expected.map((values,r)=>values.map((value,c)=>sheet.getCell(r+1,c+1).value??"")),expected);
  assert.equal(sheet.getCell(2,1).numFmt,"@");assert.equal(sheet.getCell(2,3).type,3);
  assert.equal(sheet.getCell(2,8).value,300.25);
});
