const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const A=require('../unit-price-analysis-core.js');
const base={id:'1',work_date:'2026-09-01',importer_code:'01',customer_code:'0101',store_name:'Store',product_id:'001',product_name:'Fish',origin:'Osaka',input_qty:1,input_unit:'Kg',unit_price:1000,amount:1000};
const sales=rows=>A.sales(rows.map(row=>({...base,...row}))).rows;
test('quantity-weighted prices, latest-day prices, ranges and year deltas use raw prices, not rounded invoice amounts',()=>{
  const now=sales([{id:'1',input_qty:1,amount:1001},{id:'2',input_qty:3,unit_price:2000,work_date:'2026-09-02'},{id:'3',input_qty:1,unit_price:1000,work_date:'2026-09-02'}]);
  const old=sales([{work_date:'2025-09-03',unit_price:800}]);
  const g=A.groups(now,old)[0];
  assert.equal(g.current.avg,1600);assert.equal(g.current.latest,1750);assert.equal(g.current.latestDate,'2026-09-02');
  assert.equal(g.current.min,1000);assert.equal(g.current.max,2000);assert.equal(g.current.spread,1000);
  assert.equal(g.delta,800);assert.equal(g.ratio,100);assert.equal(g.current.qty,5);
  assert.equal(g.current.prior,1000);assert.equal(g.recentDelta,750);
});
test('previous-day prices are order independent and aggregate all transactions on the same day',()=>{
  const rows=sales([{work_date:'2026-09-15',unit_price:2000},{work_date:'2026-09-10',unit_price:1000},{work_date:'2026-09-01',unit_price:100},
    {work_date:'2026-09-12',unit_price:1400,input_qty:3},{work_date:'2026-09-12',unit_price:1000}]);
  assert.equal(A.stats(rows).prior,1300);assert.equal(A.stats(rows).priorDate,'2026-09-12');
  assert.deepEqual(A.stats(rows),A.stats(rows.slice().reverse()));
});
test('product codes, units and origins do not accidentally merge; names may change under the same code',()=>{
  const rows=sales([{},{id:'2',product_name:'Renamed Fish'},{id:'3',product_id:'002'},{id:'4',input_unit:'PC'},{id:'5',origin:'Tokyo'}]);
  assert.equal(A.groups(rows,[]).length,4);
  assert.equal(A.groups(rows,[],{origin:false}).length,3);
  assert.equal(A.unit('ｋｇ'),'Kg');assert.equal(A.unit('pc'),'PC');assert.notEqual(A.unit('g'),A.unit('Kg'));
});
test('same-name customers remain separate by customer code and importer; unknown codes are not guessed',()=>{
  const rows=sales([{},{id:'2',customer_code:'0102'},{id:'3',importer_code:'07'},{id:'4',customer_code:''}]);
  assert.equal(A.groups(rows,[],{party:true}).length,4);
});
test('returns, adjustments, stockouts, provisional, missing and invalid values are reported outside price comparison; zero prices are legitimate',()=>{
  const result=A.sales([{...base},{...base,unit_price:0},{...base,unit_price:null},{...base,unit_price:'NaN'},
    {...base,input_qty:0},{...base,input_qty:-1},{...base,is_stockout:true},{...base,_sales_provisional:true},
    {...base,pending_entry_id:'p'},{...base,amount:-1000},{...base,input_unit:''}]);
  assert.equal(result.rows.length,2);assert.equal(result.excluded.length,9);assert.equal(result.rows[1].price,0);
});
test('purchase prices are exclusive of fees/tax and only confirmed, same-unit quantities are comparable',()=>{
  const receipt={id:'p',purchase_date:'2026-09-02',supplier_code:'02',supplier_name_snapshot:'Supplier',status:'confirmed',tax_amount:999,shipping_fee:888,
    lines:[{id:'l',product_code:'001',product_name:'Fish',actual_qty:2,actual_unit:'Kg',price_unit:'kg',unit_price:1200,line_amount:2400}]};
  const output=A.purchases([receipt,{...receipt,id:'credit',receipt_type:'credit_note'},
    {...receipt,id:'pending',status:'expected'},{...receipt,id:'cancelled',status:'cancelled'},
    {...receipt,id:'different',lines:[{...receipt.lines[0],price_unit:'PC'}]}]);
  assert.equal(output.rows.length,1);assert.equal(output.excluded.length,4);
  const g=A.groups(output.rows,[])[0];assert.equal(g.current.avg,1200);assert.equal(g.current.qty,2);
});
test('previous-only products and zero denominators stay visible without fake infinity/new-sale claims',()=>{
  const g=A.groups(sales([{}]),sales([{product_id:'002',work_date:'2025-09-01'}]));
  assert.equal(g.length,2);assert.ok(g.every(row=>row.delta===null));
  const zero=A.groups(sales([{}]),sales([{unit_price:0,work_date:'2025-09-01'}]))[0];
  assert.equal(zero.delta,1000);assert.equal(zero.ratio,null);
});
test('monthly year comparisons align months and retain price ranges and quantities',()=>{
  const result=A.monthly({rows:sales([{}, {id:'2',work_date:'2026-10-02',unit_price:1100}]),previousRows:sales([{work_date:'2025-09-02',unit_price:900}])});
  assert.deepEqual(result.map(row=>row.month),['2026-09','2026-10']);assert.equal(result[0].previous.avg,900);assert.equal(result[1].previous.avg,null);
});
test('sorting uses numeric deltas and code order, and search supports names, code, partner and origin',()=>{
  const groups=A.groups(sales([{product_id:'10',product_name:'Red Fish',unit_price:200},{product_id:'2',unit_price:100}]),sales([{product_id:'10',unit_price:100},{product_id:'2',unit_price:300}]),{party:true});
  assert.equal(A.filterSort(groups,{sort:'code'})[0].code,'2');assert.equal(A.filterSort(groups,{sort:'increase'})[0].code,'10');
  assert.equal(A.filterSort(groups,{sort:'decrease'})[0].code,'2');assert.equal(A.filterSort(groups,{query:'Store osaka Red'}).length,1);
});
test('large datasets retain every line and do not use network requests',()=>{
  const source=Array.from({length:30000},(_,i)=>({...base,id:String(i),product_id:String(i%200),unit_price:100+i%100}));
  const result=A.groups(A.sales(source).rows,[]);
  assert.equal(result.reduce((sum,g)=>sum+g.current.count,0),30000);assert.equal(result.length,200);
});
test('partner search narrows price samples even in product mode without mixing another customer into the average',()=>{
  const rows=sales([{store_name:'Alpha',unit_price:1000},{store_name:'Bravo',unit_price:3000}]);
  const filtered=A.filterRows(rows,{query:'Alpha Osaka',unit:'Kg'});
  assert.equal(filtered.length,1);assert.equal(A.groups(filtered,[])[0].current.avg,1000);
  assert.equal(A.filterRows(rows,{query:'Alpha',unit:'PC'}).length,0);
});
test('UI integrations are read-only and require complete loaded current/previous ranges',()=>{
  const root=path.join(__dirname,'..'),ui=fs.readFileSync(path.join(root,'unit-price-analysis.js'),'utf8'),html=fs.readFileSync(path.join(root,'order-entry-beta.html'),'utf8');
  new vm.Script(ui);
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  assert.doesNotMatch(ui,/supabaseClient|\.rpc\(|fetch\(|\.upsert\(|\.update\(/);
  assert.match(html,/markUnitPriceDataLoaded\("sales",range.ranges\)/);assert.match(html,/markUnitPriceDataLoaded\("purchase",range.ranges\)/);
  assert.match(ui,/unitPriceRangeCovered\(loaded,previousRange\)/);
  const context={};vm.createContext(context);
  const fn=ui.slice(ui.indexOf('function unitPriceRangeCovered'),ui.indexOf('function unitPriceSnapshot'));
  vm.runInContext(fn,context);
  assert.equal(context.unitPriceRangeCovered([{from:'2026-09-01',to:'2026-09-30'}],{from:'2026-09-01',to:'2026-09-30'}),true);
  assert.equal(context.unitPriceRangeCovered([{from:'2026-09-01',to:'2026-09-30'}],{from:'2025-09-01',to:'2025-09-30'}),false);
  assert.equal(context.unitPriceRangeCovered([{from:'2026-09-01',to:'2026-09-30'}],{from:'',to:''}),false);
  assert.equal(context.unitPriceRangeCovered([{from:'',to:''}],{from:'',to:''}),true);
});
test('Excel export includes all selected groups and both periods without rounding the stored unit prices',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'..','unit-price-analysis.js'),'utf8');
  const groups=A.groups(sales([{unit_price:123.4567}]),sales([{unit_price:100.11,work_date:'2025-09-01'}]));
  const sheets=[],ctx={unitPriceState:{sales:{filtered:groups,snapshot:{excluded:[]}}},XLSX:{utils:{book_new:()=>({}),json_to_sheet:rows=>rows,book_append_sheet:(book,rows,name)=>sheets.push({name,rows})},writeFile:()=>{}},alert:()=>{throw new Error('unexpected alert')}};
  vm.createContext(ctx);vm.runInContext(ui.slice(ui.indexOf('function unitPriceExcelRows'),ui.indexOf('function openUnitPriceDetail')),ctx);
  ctx.exportUnitPriceAnalysis('sales',groups);
  assert.equal(sheets.length,2);assert.equal(sheets[0].rows[0]['数量加重平均単価'],123.4567);
  assert.equal(sheets[1].rows.length,2);assert.equal(sheets[1].rows[1]['期間'],'前年同期間');
});
