(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.DomesticDeliveryExport=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const columns=Object.freeze([
    {key:"orderNo",label:"\u5148\u65b9\u53d7\u6ce8\u756a\u53f7",width:18},
    {key:"cartonNo",label:"\u30ab\u30fc\u30c8\u30f3NO",width:20},
    {key:"productName",label:"\u5546\u54c1\u540d",width:24},
    {key:"spec",label:"\u898f\u683c\u30fb\u6570\u91cf",width:18},
    {key:"origin",label:"\u7523\u5730",width:10},
    {key:"weight",label:"\u5546\u54c1\u91cd\u91cf",width:12},
    {key:"unitPrice",label:"\u5358\u4fa1 \u5186",width:12},
    {key:"amount",label:"\u5408\u8a08\u91d1\u984d \u5186",width:16},
    {key:"customerName",label:"\u5f97\u610f\u5148\u30fb\u5e97\u8217\u540d",width:22}
  ].map(column=>Object.freeze(column)));
  const defaultColumns8=Object.freeze(columns.slice(0,8).map(column=>column.key));
  const columnMap=new Map(columns.map(column=>[column.key,column]));
  const numericKeys=new Set(["weight","unitPrice","amount"]);
  const numericPattern=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

  function text(value,field){
    if(value==null)return "";
    if(typeof value!=="string"&&!(typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER)){
      throw new TypeError(`${field} must be text.`);
    }
    return String(value);
  }
  function requiredText(value,field){
    const result=text(value,field);
    if(!result.trim())throw new Error(`${field} is required.`);
    return result;
  }
  function number(value,field,{optional=false,positive=false,integer=false}={}){
    if(value==null||(typeof value==="string"&&!value.trim())){
      if(optional)return "";
      throw new Error(`${field} is required.`);
    }
    if(typeof value!=="number"&&(typeof value!=="string"||!numericPattern.test(value.trim()))){
      throw new TypeError(`${field} must be a finite number.`);
    }
    const result=Number(value);
    if(!Number.isFinite(result)||Math.abs(result)>Number.MAX_SAFE_INTEGER||result<0||(positive&&result<=0)||(integer&&!Number.isSafeInteger(result))){
      throw new RangeError(`${field} is out of range.`);
    }
    return result;
  }
  function normalizedUnit(value){
    return text(value,"unit").normalize("NFKC").trim().toLowerCase();
  }
  function sourceMatchesQuantity(source,quantity,unit){
    if(!source||!normalizedUnit(source.input_unit)||normalizedUnit(source.input_unit)!==normalizedUnit(unit))return false;
    try{return number(source.input_qty,"input_qty",{positive:true})===quantity;}
    catch{return false;}
  }
  function checkSourceScope(sale,source){
    if(!source)return;
    if(sale.source_session_id!=null&&source.session_id!=null&&sale.source_session_id!==source.session_id){
      throw new Error(`Source ${source.id} has a foreign session_id.`);
    }
    const importer=source.importer_code??source.importer_id;
    if(sale.source_importer_code!=null&&importer!=null&&sale.source_importer_code!==importer){
      throw new Error(`Source ${source.id} has a foreign importer_code.`);
    }
  }

  function makeRows(sale,sourceSales=[]){
    if(!sale||sale.status!=="confirmed")throw new Error("A confirmed sale is required.");
    if(!Array.isArray(sale.lines)||!sale.lines.length)throw new Error("Sale lines are required.");
    if(!Array.isArray(sourceSales))throw new TypeError("sourceSales must be an array.");
    const sources=new Map();
    for(const source of sourceSales){
      requiredText(source?.id,"Source id");
      if(sources.has(source.id))throw new Error(`Duplicate source id: ${source.id}`);
      sources.set(source.id,source);
    }
    const rows=sale.lines.map(line=>{
      if(!line||typeof line!=="object")throw new TypeError("Invalid sale line.");
      if(sale.id!=null&&line.sale_id!=null&&sale.id!==line.sale_id)throw new Error("A line belongs to another sale.");
      const quantity=number(line.quantity,"quantity",{positive:true});
      const unit=requiredText(line.unit,"unit");
      const source=sources.get(line.source_sales_record_id);
      checkSourceScope(sale,source);
      const sourceCartonNo=text(source?.box_no,"box_no");
      // SQL NULL means an explicit clear only after metadata has been saved.
      const metadataSaved=line.delivery_metadata_saved===true;
      const metadata=(key,fallback)=>line[key]??(metadataSaved?"":fallback);
      let weight="";
      if(normalizedUnit(unit)==="kg")weight=quantity;
      else if(sourceMatchesQuantity(source,quantity,unit))weight=number(source.net_weight,"net_weight",{optional:true});
      let spec=line.delivery_spec;
      if(spec==null&&!metadataSaved){
        const orderedQty=number(source?.ordered_qty,"ordered_qty",{optional:true});
        const orderedUnit=text(source?.ordered_unit,"ordered_unit");
        spec=orderedQty!==""&&orderedUnit.trim()?`${orderedQty}${orderedUnit}`:"";
      }
      return {
        id:line.id??null,
        lineNo:number(line.line_no,"line_no",{positive:true,integer:true}),
        orderNo:text(metadata("external_order_no",source?.external_order_no),"external_order_no"),
        cartonNo:text(metadata("delivery_carton_no",sourceCartonNo),"delivery_carton_no"),
        productName:requiredText(line.product_name_snapshot,"product_name_snapshot"),
        spec:text(spec,"delivery_spec"),
        origin:text(source?.origin,"origin"),
        weight,
        unitPrice:number(line.unit_price_jpy,"unit_price_jpy"),
        // The confirmed domestic amount may deliberately differ from quantity * price.
        amount:number(line.net_amount_jpy,"net_amount_jpy"),
        customerName:text(metadata("delivery_customer_name",source?.store_name),"delivery_customer_name"),
        sourceCartonNo,
        revision:number(line.delivery_export_revision??0,"delivery_export_revision",{integer:true})
      };
    });
    rows.sort((a,b)=>a.lineNo-b.lineNo);
    return validateRows(rows);
  }

  function validateRows(rows,{requireOrderNumber=false,requireCarton=false,requireCustomer=false}={}){
    if(!Array.isArray(rows))throw new TypeError("rows must be an array.");
    rows.forEach((row,index)=>{
      if(!row||typeof row!=="object")throw new TypeError(`Invalid row ${index+1}.`);
      const field=key=>`Row ${index+1} ${key}`;
      number(row.lineNo,field("lineNo"),{positive:true,integer:true});
      number(row.revision,field("revision"),{integer:true});
      requiredText(row.productName,field("productName"));
      const orderNo=text(row.orderNo,field("orderNo"));
      if(Array.from(orderNo).length>120)throw new RangeError(`${field("orderNo")} exceeds 120 characters.`);
      if(requireOrderNumber)requiredText(orderNo,field("orderNo"));
      if(requireCarton)requiredText(row.cartonNo,field("cartonNo"));
      if(requireCustomer)requiredText(row.customerName,field("customerName"));
      for(const key of ["cartonNo","spec","origin","customerName","sourceCartonNo"]){
        const value=text(row[key],field(key));
        const limit={cartonNo:120,spec:300,customerName:300}[key];
        if(limit&&Array.from(value).length>limit)throw new RangeError(`${field(key)} exceeds ${limit} characters.`);
      }
      number(row.weight,field("weight"),{optional:true});
      number(row.unitPrice,field("unitPrice"));
      number(row.amount,field("amount"));
    });
    return rows;
  }

  function cartonNumber(digits,prefix="JNX/No,Y"){
    if(typeof digits!=="string"||!/^\d+$/.test(digits))throw new TypeError("Carton digits must be a nonempty ASCII digit string.");
    if(typeof prefix!=="string")throw new TypeError("Carton prefix must be text.");
    return prefix+digits;
  }
  function selectedColumns(columnKeys){
    const keys=columnKeys===undefined?defaultColumns8:columnKeys;
    if(!Array.isArray(keys)||!keys.length)throw new Error("Select at least one column.");
    const seen=new Set();
    return keys.map(key=>{
      if(!columnMap.has(key))throw new Error(`Unknown column key: ${String(key)}`);
      if(seen.has(key))throw new Error(`Duplicate column key: ${key}`);
      seen.add(key);
      return columnMap.get(key);
    });
  }
  function buildLayout(rows,columnKeys,options){
    validateRows(rows);
    const selected=selectedColumns(columnKeys);
    const labels=options.labels;
    if(labels!=null&&(typeof labels!=="object"||Array.isArray(labels)))throw new TypeError("labels must be a map.");
    const header=selected.map(column=>labels&&Object.prototype.hasOwnProperty.call(labels,column.key)
      ?text(labels[column.key],`Label ${column.key}`):column.label);
    const data=[header],customerRows=new Set();
    const cartonIndex=selected.findIndex(column=>column.key==="cartonNo");
    const subrows=options.customerSubrows!==false&&cartonIndex>=0&&!selected.some(column=>column.key==="customerName");
    for(const row of rows){
      data.push(selected.map(({key})=>numericKeys.has(key)
        ?number(row[key],key,{optional:key==="weight"}):text(row[key],key)));
      if(subrows&&text(row.customerName,"customerName").trim()){
        const subrow=selected.map(()=>"");
        subrow[cartonIndex]=text(row.customerName,"customerName");
        customerRows.add(data.length);
        data.push(subrow);
      }
    }
    return {selected,data,customerRows};
  }
  function sheetRows(rows,columnKeys,options={}){
    return buildLayout(rows,columnKeys,options).data;
  }
  function csvCell(value){
    if(typeof value==="number")return String(value);
    const leading=value.match(/^[\s\u0000-\u001f\u007f-\u009f]*/u)[0];
    if(/^[=+\-@]/.test(value.slice(leading.length))||/[\u0000-\u001f\u007f-\u009f]/.test(leading))value="'"+value;
    return '"'+value.replace(/"/g,'""')+'"';
  }
  function csv(rows,columnKeys,options={}){
    return "\ufeff"+sheetRows(rows,columnKeys,options).map(row=>row.map(csvCell).join(",")).join("\r\n")+"\r\n";
  }

  function wrappedLines(value,width){
    return String(value).split(/\r\n|\r|\n/).reduce((sum,line)=>{
      const length=Array.from(line).reduce((count,char)=>count+(char.codePointAt(0)>255?2:1),0);
      return sum+Math.max(1,Math.ceil(length/Math.max(1,width-2)));
    },0);
  }
  function createWorkbook(ExcelJS,rows,columnKeys,options={}){
    const {selected,data,customerRows}=buildLayout(rows,columnKeys,options);
    if(!ExcelJS||typeof ExcelJS.Workbook!=="function")throw new TypeError("ExcelJS.Workbook is required.");
    const workbook=new ExcelJS.Workbook();
    workbook.creator="YUMIRUME";
    const sheet=workbook.addWorksheet("\u7d0d\u54c1\u660e\u7d30",{
      views:[{state:"frozen",ySplit:1,showGridLines:false}],
      pageSetup:{paperSize:9,orientation:"portrait",fitToPage:true,fitToWidth:1,fitToHeight:0,
        margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.15,footer:0.15}}
    });
    sheet.columns=selected.map(column=>({key:column.key,width:column.width}));
    sheet.pageSetup.printTitlesRow="1:1";
    sheet.pageSetup.printArea=`A1:${String.fromCharCode(64+selected.length)}${data.length}`;
    sheet.headerFooter.oddFooter="&R&P / &N";
    data.forEach((values,index)=>{
      const row=sheet.addRow(values);
      const isHeader=index===0,isCustomer=customerRows.has(index);
      row.height=Math.max(isHeader?28:isCustomer?20:24,...values.map((value,i)=>wrappedLines(value,selected[i].width)*13+6));
      for(let columnIndex=0;columnIndex<selected.length;columnIndex++){
        const cell=row.getCell(columnIndex+1),value=values[columnIndex],key=selected[columnIndex].key;
        cell.font={name:"Yu Gothic",size:isCustomer?9:10,bold:isHeader,color:{argb:"FF222222"}};
        cell.alignment={vertical:"middle",horizontal:isHeader?"center":typeof value==="number"?"right":"left",wrapText:true};
        cell.border={top:{style:"thin",color:{argb:"FF777777"}},bottom:{style:"thin",color:{argb:"FF777777"}},
          left:{style:"thin",color:{argb:"FF777777"}},right:{style:"thin",color:{argb:"FF777777"}}};
        if(isHeader)cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF0F0F0"}};
        cell.numFmt=typeof value!=="number"?"@":Number.isInteger(value)?(key==="weight"?"0":"#,##0"):
          key==="weight"?"0.####":key==="amount"?"#,##0.##":"#,##0.####";
      }
    });
    return workbook;
  }

  return {columns,defaultColumns8,makeRows,validateRows,cartonNumber,sheetRows,csv,createWorkbook};
});
