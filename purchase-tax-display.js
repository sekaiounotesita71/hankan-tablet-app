(function(root,factory){
  "use strict";
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else if(typeof define==="function"&&define.amd)define([],factory);
  else root.PurchaseTaxDisplay=factory();
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const MAX_SAFE=BigInt(Number.MAX_SAFE_INTEGER);
  const MAX_DECIMAL_DIGITS=10000;

  function safeNumber(value,label){
    if(value>MAX_SAFE||value< -MAX_SAFE)throw new RangeError(label+" exceeds safe integer precision");
    return Number(value);
  }

  function integer(value,label){
    if(typeof value!=="number"||!Number.isFinite(value)||!Number.isInteger(value))throw new TypeError(label+" must be an integer number");
    if(!Number.isSafeInteger(value))throw new RangeError(label+" exceeds safe integer precision");
    return BigInt(value);
  }

  function taxRate(value){
    if(value!==0&&value!==8&&value!==10)throw new TypeError("Tax rate must be 0, 8 or 10");
    return value;
  }

  function decimal(value,label){
    if(typeof value!=="string"&&typeof value!=="number")throw new TypeError(label+" must be a finite decimal");
    let text=String(value).trim();
    if(text.length>MAX_DECIMAL_DIGITS)throw new RangeError(label+" exceeds supported decimal precision");
    if(text.includes(",")){
      if(!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(text))throw new TypeError(label+" has invalid comma grouping");
      text=text.replace(/,/g,"");
    }
    const match=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
    if(!match||!Number.isFinite(Number(text)))throw new TypeError(label+" must be a finite decimal");
    const exponent=Number(match[5]||0);
    if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>MAX_DECIMAL_DIGITS)throw new RangeError(label+" exceeds supported decimal precision");
    const fraction=match[3]??match[4]??"";
    let digits=((match[2]||"0")+fraction).replace(/^0+/,"");
    if(!digits)return {coefficient:0n,scale:0};
    const trailing=digits.length-digits.replace(/0+$/,"").length;
    if(trailing)digits=digits.slice(0,-trailing);
    const scale=fraction.length-exponent-trailing;
    if(Math.abs(scale)>MAX_DECIMAL_DIGITS)throw new RangeError(label+" exceeds supported decimal precision");
    return {coefficient:BigInt(digits)*(match[1]==="-"?-1n:1n),scale};
  }

  function roundedInteger(coefficient,scale){
    if(scale<=0)return coefficient*10n**BigInt(-scale);
    const divisor=10n**BigInt(scale),absolute=coefficient<0n?-coefficient:coefficient;
    const rounded=absolute/divisor+(absolute%divisor*2n>=divisor?1n:0n);
    return coefficient<0n?-rounded:rounded;
  }

  function savedInteger(value,label){
    const parsed=decimal(value,label);
    let amount;
    if(parsed.scale<=0)amount=parsed.coefficient*10n**BigInt(-parsed.scale);
    else{
      const divisor=10n**BigInt(parsed.scale);
      if(parsed.coefficient%divisor!==0n)throw new TypeError(label+" must be whole yen");
      amount=parsed.coefficient/divisor;
    }
    safeNumber(amount,label);
    return amount;
  }

  // Floor each exact rational tax, then distribute to the group target; ties use input order, not IDs.
  // The target truncates toward zero per rate, matching purchase_receipt_calculated_tax for credits too.
  function allocate(lines){
    if(!Array.isArray(lines))throw new TypeError("Purchase lines must be an array");
    const groups=new Map(),allocated=[];
    for(let index=0;index<lines.length;index++){
      const line=lines[index];
      if(!line||typeof line!=="object"||Array.isArray(line))throw new TypeError("Each purchase line must be an object");
      const net=integer(line.net,"Line net"),rate=taxRate(line.taxRate),raw=net*BigInt(rate);
      let floor=raw/100n;
      if(raw<0n&&raw%100n!==0n)floor--;
      allocated.push({net,tax:floor,remainder:raw-floor*100n,index});
      if(!groups.has(rate))groups.set(rate,{raw:0n,floor:0n,indices:[]});
      const group=groups.get(rate);
      group.raw+=raw;
      group.floor+=floor;
      group.indices.push(index);
    }
    for(const group of groups.values()){
      const remaining=group.raw/100n-group.floor;
      const ranked=group.indices.slice().sort((left,right)=>{
        const a=allocated[left],b=allocated[right];
        return a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1;
      });
      for(let index=0;index<Number(remaining);index++)allocated[ranked[index]].tax++;
    }
    let net=0n,tax=0n;
    const result=allocated.map(line=>{
      net+=line.net;
      tax+=line.tax;
      return {net:safeNumber(line.net,"Line net"),tax:safeNumber(line.tax,"Line tax"),gross:safeNumber(line.net+line.tax,"Line gross")};
    });
    return {lines:result,net:safeNumber(net,"Net total"),tax:safeNumber(tax,"Tax total"),gross:safeNumber(net+tax,"Gross total")};
  }

  // Only absent (undefined) saved fields fall back. Saved zeroes and manual adjustments remain authoritative.
  // Fees belong to netTotal, not the taxable line groups; differences never create or alter display lines.
  function receipt(source){
    if(!source||typeof source!=="object"||Array.isArray(source))throw new TypeError("Purchase receipt must be an object");
    const lines=source.lines===undefined?[]:source.lines;
    if(!Array.isArray(lines))throw new TypeError("Receipt lines must be an array");
    const result=allocate(lines.map(line=>{
      if(!line||typeof line!=="object"||Array.isArray(line))throw new TypeError("Each receipt line must be an object");
      return {net:Number(savedInteger(line.line_amount,"Saved line amount")),taxRate:Number(savedInteger(line.tax_rate,"Saved tax rate"))};
    }));
    const subtotal=source.subtotal===undefined?BigInt(result.net):savedInteger(source.subtotal,"Saved subtotal");
    const shipping=source.shipping_fee===undefined?0n:savedInteger(source.shipping_fee,"Saved shipping fee");
    const other=source.other_fee===undefined?0n:savedInteger(source.other_fee,"Saved other fee");
    const netTotal=subtotal+shipping+other;
    const actualTax=source.tax_amount===undefined?BigInt(result.tax):savedInteger(source.tax_amount,"Saved tax amount");
    const grossTotal=source.total_amount===undefined?netTotal+actualTax:savedInteger(source.total_amount,"Saved total amount");
    return {...result,netTotal:safeNumber(netTotal,"Receipt net total"),grossTotal:safeNumber(grossTotal,"Receipt gross total"),actualTax:safeNumber(actualTax,"Receipt actual tax"),taxDifference:safeNumber(actualTax-BigInt(result.tax),"Receipt tax difference"),netDifference:safeNumber(subtotal-BigInt(result.net),"Receipt net difference")};
  }

  // PostgreSQL numeric round: exact decimal multiplication, with half yen rounded away from zero.
  function lineNet(qty,price){
    const left=decimal(qty,"Quantity"),right=decimal(price,"Unit price");
    return safeNumber(roundedInteger(left.coefficient*right.coefficient,left.scale+right.scale),"Line amount");
  }

  // Reference display only: round the exact gross unit price to two decimals, never to a saved line amount.
  function unitGross(value,rate){
    const parsed=decimal(value,"Unit price");
    const cents=roundedInteger(parsed.coefficient*BigInt(100+taxRate(rate)),parsed.scale);
    return safeNumber(cents,"Gross unit price cents")/100;
  }

  return {allocate,receipt,lineNet,unitGross};
});
