const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const display=require('../purchase-tax-display.js');
const source=fs.readFileSync(path.join(__dirname,'../purchase-tax-display.js'),'utf8');
const rates=[0,8,10];

function sqlTax(lines){
  const bases=new Map(rates.map(rate=>[rate,0n]));
  for(const line of lines)bases.set(line.taxRate,bases.get(line.taxRate)+BigInt(line.net));
  // PostgreSQL numeric floor for nonnegative bases, ceil for negative bases: BigInt division truncates.
  return [...bases].reduce((sum,[rate,net])=>sum+net*BigInt(rate)/100n,0n);
}

function assertAllocation(lines){
  const result=display.allocate(lines);
  assert.equal(result.lines.length,lines.length);
  const net=lines.reduce((sum,line)=>sum+BigInt(line.net),0n),tax=sqlTax(lines);
  assert.equal(result.net,Number(net));
  assert.equal(result.tax,Number(tax));
  assert.equal(result.gross,Number(net+tax));
  for(const rate of rates){
    const group=lines.map((line,index)=>({line,index})).filter(({line})=>line.taxRate===rate);
    const groupNet=group.reduce((sum,{line})=>sum+BigInt(line.net),0n);
    assert.equal(group.reduce((sum,{index})=>sum+BigInt(result.lines[index].tax),0n),groupNet*BigInt(rate)/100n);
  }
  result.lines.forEach((line,index)=>{
    assert.equal(line.net,lines[index].net===0?0:lines[index].net);
    assert.equal(line.gross,line.net+line.tax);
    const raw=BigInt(line.net)*BigInt(lines[index].taxRate),allocated=BigInt(line.tax)*100n;
    assert.ok(raw-allocated> -100n&&raw-allocated<100n,'Each tax allocation is within one yen of the exact rational tax');
    for(const amount of Object.values(line)){
      assert.ok(Number.isSafeInteger(amount));
      assert.ok(!Object.is(amount,-0));
    }
  });
  assert.equal(result.lines.reduce((sum,line)=>sum+BigInt(line.gross),0n),net+tax);
  return result;
}

test('CommonJS, browser global and AMD expose only the requested pure API',()=>{
  assert.deepEqual(Object.keys(display).sort(),['allocate','lineNet','receipt','unitGross']);
  const browser=vm.createContext({});
  vm.runInContext(source,browser);
  assert.deepEqual(Object.keys(browser.PurchaseTaxDisplay).sort(),Object.keys(display).sort());
  assert.equal(browser.PurchaseTaxDisplay.lineNet('1.13','3050'),3447);
  let amd;
  const define=(dependencies,factory)=>{assert.equal(dependencies.length,0);amd=factory();};
  define.amd={};
  const context=vm.createContext({define});
  vm.runInContext(source,context);
  assert.deepEqual(Object.keys(amd).sort(),Object.keys(display).sort());
  assert.equal(context.PurchaseTaxDisplay,undefined);
});

test('empty input stays empty and zero/tax-free lines remain real lines',()=>{
  assert.deepEqual(display.allocate([]),{lines:[],net:0,tax:0,gross:0});
  const result=assertAllocation([{net:0,taxRate:8},{net:-0,taxRate:10},{net:123,taxRate:0},{net:-45,taxRate:0}]);
  assert.deepEqual(result,{lines:[{net:0,tax:0,gross:0},{net:0,tax:0,gross:0},{net:123,tax:0,gross:123},{net:-45,tax:0,gross:-45}],net:78,tax:0,gross:78});
});

test('8%, 10% and exempt bases truncate independently at the rate-group level',()=>{
  const result=assertAllocation([{net:7,taxRate:8},{net:7,taxRate:8},{net:5,taxRate:10},{net:5,taxRate:10},{net:99,taxRate:0}]);
  assert.deepEqual(result.lines.map(line=>line.tax),[1,0,1,0,0]);
  assert.deepEqual([result.net,result.tax,result.gross],[123,2,125]);
});

test('group rounding is neither per-line rounding nor truncation after combining different rates',()=>{
  assert.deepEqual(display.allocate([{net:7,taxRate:8},{net:7,taxRate:8}]).lines.map(line=>line.tax),[1,0]);
  assert.equal(display.allocate([{net:12,taxRate:8},{net:9,taxRate:10}]).tax,0);
  assert.equal(display.allocate([{net:12,taxRate:8},{net:-9,taxRate:10}]).tax,0);
});

test('largest fractional remainders receive the remaining yen before smaller remainders',()=>{
  const result=assertAllocation([{net:1,taxRate:8},{net:11,taxRate:8},{net:6,taxRate:8}]);
  assert.deepEqual(result.lines.map(line=>line.tax),[0,1,0]);
});

test('remainder ties are deterministic by original input index regardless of optional IDs',()=>{
  const lines=[{net:7,taxRate:8,id:'z'},{net:7,taxRate:8,id:'a'},{net:7,taxRate:8,id:'a'}];
  assert.deepEqual(display.allocate(lines).lines.map(line=>line.tax),[1,0,0]);
  assert.deepEqual(display.allocate(lines).lines,display.allocate(lines).lines);
  assert.deepEqual(display.allocate([{net:-7,taxRate:8,id:'z'},{net:-7,taxRate:8,id:'a'}]).lines.map(line=>line.tax),[0,-1]);
});

test('negative credit groups truncate toward zero rather than rounding down',()=>{
  const result=assertAllocation([{net:-7,taxRate:8},{net:-7,taxRate:8},{net:-5,taxRate:10},{net:-5,taxRate:10},{net:-99,taxRate:0}]);
  assert.deepEqual(result.lines.map(line=>line.tax),[0,-1,0,-1,0]);
  assert.deepEqual([result.net,result.tax,result.gross],[-123,-2,-125]);
  assert.equal(assertAllocation([{net:-1,taxRate:8}]).tax,0);
});

test('mixed signs use mathematical floor remainders without absolute-value or per-credit shortcuts',()=>{
  assert.deepEqual(assertAllocation([{net:8,taxRate:8},{net:-6,taxRate:8}]).lines,[{net:8,tax:1,gross:9},{net:-6,tax:-1,gross:-7}]);
  assert.deepEqual(assertAllocation([{net:-20,taxRate:8},{net:7,taxRate:8}]).lines.map(line=>line.tax),[-2,1]);
  assert.deepEqual(assertAllocation([{net:13,taxRate:8},{net:-1,taxRate:8}]).lines.map(line=>line.tax),[1,-1]);
  assertAllocation([{net:7,taxRate:8},{net:-7,taxRate:8},{net:8,taxRate:10},{net:-8,taxRate:10}]);
});

test('neither allocation nor receipt mutates frozen input arrays, objects or unrelated fields',()=>{
  const lines=Object.freeze([Object.freeze({net:7,taxRate:8,id:'one'}),Object.freeze({net:7,taxRate:8,id:'two'})]);
  const before=JSON.stringify(lines);
  display.allocate(lines);
  assert.equal(JSON.stringify(lines),before);
  const saved=Object.freeze({lines:Object.freeze([Object.freeze({line_amount:'100.00',tax_rate:'8.00',id:'x'})]),subtotal:100,tax_amount:9,total_amount:109,note:'unchanged'});
  display.receipt(saved);
  assert.equal(saved.lines[0].line_amount,'100.00');
  assert.equal(saved.tax_amount,9);
  assert.equal(saved.note,'unchanged');
});

test('allocation rejects invalid inputs and sparse rows rather than making phantom or zero-value rows',()=>{
  for(const lines of [undefined,null,{},'[]',new Array(1),[null],[undefined],[[]],[1]])assert.throws(()=>display.allocate(lines),TypeError);
  for(const net of [undefined,null,'1',1.5,NaN,Infinity,-Infinity,true,{},1n])assert.throws(()=>display.allocate([{net,taxRate:8}]),TypeError);
  for(const taxRate of [undefined,null,'8',5,7,8.5,-8,NaN,Infinity,{},8n])assert.throws(()=>display.allocate([{net:100,taxRate}]),TypeError);
});

test('unsafe input, row gross and final totals throw instead of losing yen',()=>{
  for(const net of [Number.MAX_SAFE_INTEGER+1,-Number.MAX_SAFE_INTEGER-1])assert.throws(()=>display.allocate([{net,taxRate:0}]),RangeError);
  assert.throws(()=>display.allocate([{net:Number.MAX_SAFE_INTEGER,taxRate:8}]),RangeError);
  assert.throws(()=>display.allocate([{net:Number.MAX_SAFE_INTEGER,taxRate:0},{net:1,taxRate:0}]),RangeError);
  assert.throws(()=>display.allocate([{net:-Number.MAX_SAFE_INTEGER,taxRate:0},{net:-1,taxRate:0}]),RangeError);
  const max=Number.MAX_SAFE_INTEGER;
  assert.equal(display.allocate([{net:max,taxRate:0},{net:max,taxRate:0},{net:-max,taxRate:0}]).net,max);
});

test('large safe yen values keep exact rational tax without intermediate Number products',()=>{
  assertAllocation([{net:8000000000000011,taxRate:8},{net:-7999999999999999,taxRate:8},{net:7000000000000009,taxRate:10},{net:-7000000000000000,taxRate:10}]);
});

test('receipt keeps saved totals and manual tax differences separate from allocated display lines',()=>{
  const result=display.receipt({lines:[{line_amount:1001,tax_rate:8},{line_amount:101,tax_rate:10}],subtotal:1102,shipping_fee:50,other_fee:10,tax_amount:100,total_amount:1262,tax_override:true});
  assert.deepEqual(result,{lines:[{net:1001,tax:80,gross:1081},{net:101,tax:10,gross:111}],net:1102,tax:90,gross:1192,netTotal:1162,grossTotal:1262,actualTax:100,taxDifference:10,netDifference:0});
});

test('authoritative saved zero is never replaced by calculated subtotal, tax or gross',()=>{
  const result=display.receipt({lines:[{line_amount:78,tax_rate:8}],subtotal:0,shipping_fee:0,other_fee:0,tax_amount:0,total_amount:0,tax_override:false});
  assert.deepEqual([result.net,result.tax,result.gross],[78,6,84]);
  assert.deepEqual([result.netTotal,result.actualTax,result.grossTotal,result.netDifference,result.taxDifference],[0,0,0,-78,-6]);
  assert.equal(display.receipt({lines:[{line_amount:78,tax_rate:8}],subtotal:'0.00',tax_amount:'0',total_amount:'0e2'}).grossTotal,0);
});

test('saved tax is authoritative even without an override flag and saved inconsistent gross is retained',()=>{
  const result=display.receipt({lines:[{line_amount:100,tax_rate:8}],subtotal:100,tax_amount:11,total_amount:115,tax_override:false});
  assert.equal(result.actualTax,11);
  assert.equal(result.taxDifference,3);
  assert.equal(result.grossTotal,115);
  assert.equal(result.lines[0].gross,108);
});

test('orphaned subtotal differences are explicit without inventing or redistributing lines',()=>{
  const result=display.receipt({lines:[{line_amount:100,tax_rate:8}],subtotal:300,tax_amount:24,total_amount:324});
  assert.equal(result.lines.length,1);
  assert.deepEqual(result.lines[0],{net:100,tax:8,gross:108});
  assert.deepEqual([result.netDifference,result.taxDifference,result.netTotal,result.grossTotal],[200,16,300,324]);
  const empty=display.receipt({subtotal:300,tax_amount:24,total_amount:324});
  assert.deepEqual(empty.lines,[]);
  assert.deepEqual([empty.netDifference,empty.taxDifference],[300,24]);
});

test('missing saved fields derive only the missing totals and include fees without charging extra line tax',()=>{
  const result=display.receipt({lines:[{line_amount:14,tax_rate:8}],shipping_fee:50,other_fee:10});
  assert.deepEqual([result.net,result.tax,result.netTotal,result.actualTax,result.grossTotal],[14,1,74,1,75]);
  assert.deepEqual([result.netDifference,result.taxDifference],[0,0]);
  assert.equal(display.receipt({lines:[{line_amount:14,tax_rate:8}],tax_amount:0}).grossTotal,14);
  assert.equal(display.receipt({lines:[{line_amount:14,tax_rate:8}],subtotal:20}).netDifference,6);
  assert.equal(display.receipt({lines:[{line_amount:14,tax_rate:8}],subtotal:20}).grossTotal,21);
  assert.deepEqual(display.receipt({}),{lines:[],net:0,tax:0,gross:0,netTotal:0,grossTotal:0,actualTax:0,taxDifference:0,netDifference:0});
});

test('saved database numeric strings, signed fees, tax-free and credit receipts are supported exactly',()=>{
  const result=display.receipt({lines:[{line_amount:'-1,001.000',tax_rate:'8.00'},{line_amount:'-1.01e2',tax_rate:10},{line_amount:'-5',tax_rate:0}],subtotal:'-1107.00',shipping_fee:'-50',other_fee:'-10',tax_amount:'-90',total_amount:'-1257.00'});
  assert.deepEqual([result.net,result.tax,result.netTotal,result.actualTax,result.grossTotal],[-1107,-90,-1167,-90,-1257]);
  assert.deepEqual([result.taxDifference,result.netDifference],[0,0]);
});

test('receipt rejects invalid or fractional stored amounts rather than silently rewriting accounting values',()=>{
  for(const source of [undefined,null,[],false])assert.throws(()=>display.receipt(source),TypeError);
  for(const lines of [null,{},[null],[{line_amount:100}],[{line_amount:100,tax_rate:5}],[{line_amount:0.1,tax_rate:8}],new Array(1)])assert.throws(()=>display.receipt({lines}),TypeError);
  for(const field of ['subtotal','shipping_fee','other_fee','tax_amount','total_amount']){
    for(const value of [null,'',true,'bad','1.5',NaN,Infinity])assert.throws(()=>display.receipt({[field]:value}),TypeError);
    assert.throws(()=>display.receipt({[field]:'9007199254740993'}),RangeError);
  }
  assert.throws(()=>display.receipt({subtotal:Number.MAX_SAFE_INTEGER,shipping_fee:1}),RangeError);
  assert.throws(()=>display.receipt({subtotal:Number.MAX_SAFE_INTEGER,tax_amount:1}),RangeError);
  assert.throws(()=>display.receipt({lines:[{line_amount:-1,tax_rate:0}],subtotal:Number.MAX_SAFE_INTEGER,total_amount:0}),RangeError);
});

test('lineNet fixes binary floating-point half-yen errors and rounds ties symmetrically away from zero',()=>{
  assert.ok(1.13*3050<3446.5);
  for(const [qty,price,expected] of [[1.13,3050,3447],['1.13','3050',3447],[-1.13,3050,-3447],[1.13,-3050,-3447],[-1.13,-3050,3447],['1.005',100,101],['-1.005',100,-101],[1,'0.5',1],[-1,'0.5',-1],['0.4999999999999999999999',1,0],['-0.4999999999999999999999',1,0],['123.49',1,123],['-123.49',1,-123]])assert.equal(display.lineNet(qty,price),expected);
});

test('lineNet parses exact decimal exponents and valid comma-separated numeric input',()=>{
  for(const [qty,price,expected] of [[' 1.13 ','3,050.00',3447],['+1.13e0','3.05E+3',3447],['.5','1.e1',5],['-5e-1','10',-5],['1e-20','1e20',1],['100e-2','0.5',1],['1e-1000','1',0],['0e100','0',0],['-0',100,0]]){
    assert.equal(display.lineNet(qty,price),expected);
    assert.ok(!Object.is(display.lineNet(qty,price),-0));
  }
});

test('lineNet rejects malformed/nonfinite numbers, excessive decimal work and unsafe rounded results',()=>{
  const invalid=[null,undefined,'',false,{},[],1n,NaN,Infinity,-Infinity,'Infinity','NaN','0x10','1/2','1 000','1,13','1,000,00','1,000.1,2','1e','1e309','--1'];
  for(const value of invalid){
    assert.throws(()=>display.lineNet(value,1),TypeError);
    assert.throws(()=>display.lineNet(1,value),TypeError);
  }
  for(const value of ['1e-10001','1'.repeat(10001),'1e-99999999999999999999'])assert.throws(()=>display.lineNet(value,1),RangeError);
  assert.equal(display.lineNet('9007199254740991.49',1),Number.MAX_SAFE_INTEGER);
  assert.equal(display.lineNet('-9007199254740991.49',1),-Number.MAX_SAFE_INTEGER);
  for(const value of ['9007199254740991.50','-9007199254740991.50','9007199254740993'])assert.throws(()=>display.lineNet(value,1),RangeError);
  assert.throws(()=>display.lineNet(Number.MAX_SAFE_INTEGER,2),RangeError);
});

test('unitGross is a max-two-decimal reference price using exact decimal arithmetic',()=>{
  for(const [value,rate,expected] of [[3050,8,3294],[3050,10,3355],[3050,0,3050],['1.13',8,1.22],['-1.13',8,-1.22],['1.005',0,1.01],['-1.005',0,-1.01],['.125',0,.13],['0.01',10,.01],['3,050.00',8,3294],['1.13e0',8,1.22],[-0,8,0]])assert.equal(display.unitGross(value,rate),expected);
  for(const rate of ['8',7,null,undefined,NaN])assert.throws(()=>display.unitGross(1,rate),TypeError);
  assert.throws(()=>display.unitGross('bad',8),TypeError);
  assert.throws(()=>display.unitGross(Number.MAX_SAFE_INTEGER,0),RangeError);
  assert.ok(!Object.is(display.unitGross('-0.001',8),-0));
});

test('a thousand mixed-sign/rate rows reconcile exactly with rate-group PostgreSQL mathematics',()=>{
  const lines=Array.from({length:1000},(_,index)=>({net:(index%5===0?-1:1)*(index*79%1007),taxRate:rates[index%3],id:'row-'+index}));
  const result=assertAllocation(lines);
  assert.equal(result.tax,Number(sqlTax(lines)));
  const saved=display.receipt({lines:lines.map(line=>({line_amount:String(line.net),tax_rate:String(line.taxRate)}))});
  assert.deepEqual(saved.lines,result.lines);
  assert.equal(saved.netTotal,result.net);
  assert.equal(saved.grossTotal,result.gross);
});

test('seeded random allocation properties match exact SQL targets for positive, credit and mixed receipts',()=>{
  let seed=0x5b0f123;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
  for(let trial=0;trial<400;trial++){
    const sign=trial%3;
    const lines=Array.from({length:random()%81},()=>{
      const amount=random()%200001;
      return {net:sign===0?amount:sign===1?-amount:random()%2?amount:-amount,taxRate:rates[random()%3]};
    });
    assertAllocation(lines);
  }
});

test('exhaustive small signed pairs agree with truncation and floor-based largest-remainder allocation',()=>{
  for(const rate of rates){
    for(let a=-25;a<=25;a++){
      for(let b=-25;b<=25;b++){
        const lines=[{net:a,taxRate:rate},{net:b,taxRate:rate}],result=display.allocate(lines);
        assert.equal(result.tax,Number(BigInt(a+b)*BigInt(rate)/100n));
        const floors=[a,b].map(value=>{
          const raw=BigInt(value)*BigInt(rate);
          return Number(raw/100n-(raw<0n&&raw%100n!==0n?1n:0n));
        });
        const remainders=[a,b].map((value,index)=>value*rate-floors[index]*100);
        const rank=remainders[1]>remainders[0]?[1,0]:[0,1];
        const extra=result.tax-floors[0]-floors[1];
        for(let index=0;index<extra;index++)floors[rank[index]]++;
        assert.deepEqual(result.lines.map(line=>line.tax),floors);
      }
    }
  }
});

test('seeded decimal products match PostgreSQL numeric half-away-from-zero rounding exactly',()=>{
  let seed=0x12aaff;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let trial=0;trial<1000;trial++){
    const qty=BigInt(random()%2000001)-1000000n,price=BigInt(random()%2000001)-1000000n;
    const qtyScale=random()%7,priceScale=random()%7;
    const numerator=qty*price,denominator=10n**BigInt(qtyScale+priceScale);
    const absolute=numerator<0n?-numerator:numerator;
    const expected=(absolute+denominator/2n)/denominator*(numerator<0n?-1n:1n);
    assert.equal(display.lineNet(qty+'e-'+qtyScale,price+'e-'+priceScale),Number(expected));
    const rate=rates[random()%3],grossNumerator=price*BigInt(100+rate),grossDenominator=10n**BigInt(priceScale);
    const grossAbsolute=grossNumerator<0n?-grossNumerator:grossNumerator;
    const cents=(grossAbsolute+grossDenominator/2n)/grossDenominator*(grossNumerator<0n?-1n:1n);
    assert.equal(display.unitGross(price+'e-'+priceScale,rate),Number(cents)/100);
  }
});
