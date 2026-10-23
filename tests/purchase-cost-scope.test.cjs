const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const policy=require('../purchase-cost-scope.js');
const importers=[
  {code:'01',name:'DIM Company',aliases:['DIM','DIM Singapore']},
  {importer_code:'02',importer_name:'FBI Company',aliases:'FBI|FBI Singapore'},
  {code:'TOKYO-X',name:'Tokyo Import',aliases:['Tokyo']}
];
const unknown={scope:'unassigned',importerCode:''};

test('CommonJS and browser global expose the same pure API without DOM dependencies',()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../purchase-cost-scope.js'),'utf8'),context);
  assert.deepEqual(Object.keys(context.PurchaseCostScope).sort(),Object.keys(policy).sort());
  assert.equal(context.PurchaseCostScope.normalizeCode(1),'01');
  assert.equal(context.PurchaseCostScope.deriveFromSources(['a'],{a:'DIM'},importers).importerCode,'01');
});

test('numeric codes normalize without floating-point conversion or losing codes longer than two digits',()=>{
  for(const value of [1,'1','01','001','\uff11',' \uff10\uff11 '])assert.equal(policy.normalizeCode(value,importers),'01');
  assert.equal(policy.normalizeCode('000'),'00');
  assert.equal(policy.normalizeCode('100'),'100');
  assert.equal(policy.normalizeCode('12345678901234567890'),'12345678901234567890');
  for(const value of [null,undefined,{},[],NaN,Infinity,-1,'1.5','+1'])assert.equal(policy.normalizeCode(value,importers),'');
});

test('only exact registered importer names, aliases and explicit codes resolve',()=>{
  for(const value of ['DIM','dim',' DIM Company ','DIM Singapore'])assert.equal(policy.normalizeCode(value,importers),'01');
  assert.equal(policy.normalizeCode('FBI',importers),'02');
  assert.equal(policy.normalizeCode('FBI Company',importers),'02');
  assert.equal(policy.normalizeCode('Tokyo',importers),'TOKYO-X');
  assert.equal(policy.normalizeCode('tokyo-x',importers),'TOKYO-X');
  for(const value of ['DI','DIM Veg','DIM tuna','tuna','Company','DIMCompany','DIM  Company','DIM']){
    assert.equal(policy.normalizeCode(value,value==='DIM'?[]:importers),'');
  }
});

test('ambiguous names and aliases fail closed; explicit master code has precedence',()=>{
  const masters=[{code:'01',name:'Same',aliases:['SAME','TWO']},{code:'02',name:'Same',aliases:['ONE','TWO']}];
  assert.equal(policy.normalizeCode('Same',masters),'');
  assert.equal(policy.normalizeCode('TWO',masters),'');
  assert.equal(policy.normalizeCode('ONE',masters),'02');
  assert.equal(policy.normalizeCode('01',masters),'01');
  assert.equal(policy.normalizeCode('A',[{code:'A',name:'first'},{code:'02',aliases:['A']}]),'A');
  assert.equal(policy.normalizeCode('DIM',[...importers,{code:'001',name:'DIM'}]),'01');
});

test('individual and duplicate source IDs auto assign the same canonical importer',()=>{
  assert.deepEqual(policy.deriveFromSources(['a'],{a:'DIM'},importers),{scope:'importer',importerCode:'01'});
  assert.deepEqual(policy.deriveFromSources(['a','a',' a '],new Map([['a',1]]),importers),{scope:'importer',importerCode:'01'});
  assert.deepEqual(policy.deriveFromSources(['a','b','c'],{a:'DIM',b:'001',c:{scope:'importer',importerCode:'1'}},importers),{scope:'importer',importerCode:'01'});
  assert.deepEqual(policy.deriveFromSources(['a'],{a:{importer_code:'02'}},importers),{scope:'importer',importerCode:'02'});
});

test('grouped different importers are shared rather than allocated',()=>{
  assert.deepEqual(policy.deriveFromSources(['a','b'],{a:'01',b:'02'},importers),{scope:'shared',importerCode:''});
  assert.deepEqual(policy.deriveFromSources(['b','a','a'],{a:'DIM',b:'FBI'},importers),{scope:'shared',importerCode:''});
});

test('any missing or explicitly unknown source makes the entire group unassigned, even with known mixed sources',()=>{
  const source={a:'01',b:'02',missing:null,blank:'',invalid:{scope:'unassigned',importerCode:'01'},shared:{scope:'shared'},product:{product_name:'DIM'}};
  for(const ids of [[],['not-there'],['a','not-there'],['a','b','not-there'],['a','missing'],['a','blank'],['a','invalid'],['a','shared'],['product'],['a','']]){
    assert.deepEqual(policy.deriveFromSources(ids,source,importers),unknown);
  }
  assert.deepEqual(policy.deriveFromSources(null,source,importers),unknown);
  assert.deepEqual(policy.deriveFromSources(['a'],null,importers),unknown);
  assert.deepEqual(policy.deriveFromSources(['constructor'],{},importers),unknown);
  assert.deepEqual(policy.deriveFromSources(['inherited'],Object.create({inherited:'01'}),importers),unknown);
});

test('domestic is explicit, all-domestic remains domestic, mixed domestic and importer becomes shared',()=>{
  const sources={a:{scope:'domestic',importerCode:''},b:{scope:'domestic'},c:'01',label:'domestic'};
  assert.deepEqual(policy.deriveFromSources(['a','b'],sources,importers),{scope:'domestic',importerCode:''});
  assert.deepEqual(policy.deriveFromSources(['a','c'],sources,importers),{scope:'shared',importerCode:''});
  assert.deepEqual(policy.deriveFromSources(['a','label'],sources,importers),unknown);
});

test('choice values round trip known scopes and canonical numeric or custom codes',()=>{
  for(const resolved of [{scope:'importer',importerCode:'01'},{scope:'importer',importerCode:'TOKYO-X'},{scope:'shared',importerCode:''},{scope:'domestic',importerCode:''},unknown]){
    assert.deepEqual(policy.parseChoice(policy.choiceValue(resolved.scope,resolved.importerCode)),resolved);
  }
  assert.equal(policy.choiceValue('importer',1),'importer:01');
  assert.deepEqual(policy.parseChoice('importer:001'),{scope:'importer',importerCode:'01'});
  for(const value of ['',null,undefined,'unassigned','importer:','importer:01:02','importer:1.5','other','01','DIM'])assert.deepEqual(policy.parseChoice(value),unknown);
  assert.equal(policy.choiceValue('importer',''),'unassigned');
  assert.equal(policy.choiceValue('invalid','01'),'unassigned');
});

test('summary preserves signed integer purchase amounts, optional fees and zero-cost row counts',()=>{
  const rows=[
    {scope:'importer',importer_code:'2',amount:'100',fees:5},
    {scope:'importer',importer_code:'01',amount:700,fees:10},
    {scope:'importer',importerCode:'1',amount:-100,fees:-2},
    {scope:'importer',importer_code:'01',amount:0},
    {scope:'shared',importer_code:'02',amount:50,fees:3},
    {scope:'shared',amount:-10},
    {scope:'domestic',amount:200},
    {scope:'unassigned',amount:30},
    {scope:'importer',importer_code:'',amount:40},
    {scope:'invalid',importer_code:'01',amount:-5}
  ];
  const before=JSON.stringify(rows),summary=policy.buildSummary(rows);
  assert.deepEqual(summary.importers,[
    {scope:'importer',importerCode:'01',amount:600,fees:8,cost:608,count:3},
    {scope:'importer',importerCode:'02',amount:100,fees:5,cost:105,count:1}
  ]);
  assert.deepEqual(summary.shared,{scope:'shared',importerCode:'',amount:40,fees:3,cost:43,count:2});
  assert.deepEqual(summary.domestic,{scope:'domestic',importerCode:'',amount:200,fees:0,cost:200,count:1});
  assert.deepEqual(summary.unassigned,{scope:'unassigned',importerCode:'',amount:65,fees:0,cost:65,count:3});
  assert.deepEqual([summary.amount,summary.fees,summary.cost,summary.count],[1005,16,1021,10]);
  assert.equal(summary.cost,summary.importers.reduce((sum,row)=>sum+row.cost,0)+summary.shared.cost+summary.domestic.cost+summary.unassigned.cost);
  assert.equal(JSON.stringify(rows),before);
});

test('empty and legacy rows remain separate unassigned; product names cannot assign costs',()=>{
  const empty=policy.buildSummary([]);
  assert.deepEqual([empty.amount,empty.fees,empty.cost,empty.count,empty.importers.length],[0,0,0,0,0]);
  const summary=policy.buildSummary([{product_name:'DIM',amount:78},{scope:'shared',amount:0}]);
  assert.equal(summary.unassigned.amount,78);
  assert.equal(summary.unassigned.count,1);
  assert.equal(summary.shared.count,1);
  assert.equal(summary.importers.length,0);
});

test('malformed, fractional and unsafe amounts cannot silently become zero or rounded costs',()=>{
  for(const amount of [1.5,'1.5','NaN',NaN,Infinity,true,{},[],Number.MAX_SAFE_INTEGER+1,'9007199254740993']){
    assert.throws(()=>policy.buildSummary([{scope:'shared',amount}]),/integer/);
  }
  assert.throws(()=>policy.buildSummary([{scope:'shared',amount:1,fees:'bad'}]),/integer/);
  assert.throws(()=>policy.buildSummary([{scope:'shared',amount:Number.MAX_SAFE_INTEGER},{scope:'shared',amount:1}]),/precision/);
  assert.throws(()=>policy.buildSummary([{scope:'shared',amount:Number.MAX_SAFE_INTEGER,fees:1}]),/precision/);
  const negative=policy.buildSummary([{scope:'shared',amount:-78,fees:-2}]);
  assert.equal(negative.cost,-80);
});

test('importer profit unions sales and cost groups with canonical codes and explicit domestic scope',()=>{
  const result=policy.buildImporterProfit([
    {scope:'importer',importerCode:'1',amount:1000},
    {scope:'importer',importerCode:'001',amount:-100},
    {scope:'importer',importerCode:'02',amount:400},
    {scope:'domestic',importerCode:'01',amount:200}
  ],[
    {scope:'importer',importer_code:'01',amount:'500',line_count:'3'},
    {scope:'importer',importer_code:'1',amount:-50,line_count:1},
    {scope:'importer',importer_code:'03',amount:70,line_count:2},
    {scope:'domestic',importer_code:'02',amount:100,line_count:1}
  ]);
  assert.deepEqual(result.rows,[
    {scope:'importer',importerCode:'01',sales:900,cost:450,grossProfit:450,margin:50,lineCount:4},
    {scope:'importer',importerCode:'02',sales:400,cost:0,grossProfit:400,margin:100,lineCount:0},
    {scope:'importer',importerCode:'03',sales:0,cost:70,grossProfit:-70,margin:null,lineCount:2},
    {scope:'domestic',importerCode:'',sales:200,cost:100,grossProfit:100,margin:50,lineCount:1}
  ]);
  assert.equal(result.totalCost,620);
});

test('shared, unknown and fee costs remain sidecars, never apportioned or subtracted from importer profits',()=>{
  const result=policy.buildImporterProfit([{scope:'importer',importerCode:'01',amount:1000}],[
    {scope:'importer',importer_code:'01',amount:400,line_count:4},
    {scope:'shared',importer_code:'01',amount:250,line_count:7},
    {scope:'shared',amount:-50,line_count:1},
    {scope:'unassigned',amount:78,line_count:2},
    {scope:'importer',importer_code:'',amount:22,line_count:1},
    {scope:'fees',importer_code:'01',amount:80,line_count:3},
    {scope:'fees',amount:-10,line_count:0}
  ]);
  assert.deepEqual(result.rows,[{scope:'importer',importerCode:'01',sales:1000,cost:400,grossProfit:600,margin:60,lineCount:4}]);
  assert.deepEqual(result.shared,{amount:200,count:8});
  assert.deepEqual(result.unassigned,{amount:100,count:3});
  assert.deepEqual(result.fees,{amount:70,count:3});
  assert.equal(result.totalCost,770);
  assert.equal(result.totalCost,result.rows.reduce((sum,row)=>sum+row.cost,0)+result.shared.amount+result.unassigned.amount+result.fees.amount);
});

test('unclassified sales stay visible with null profit instead of being treated as domestic or allocated unknown costs',()=>{
  const result=policy.buildImporterProfit([
    {scope:'unassigned',importerCode:'01',amount:100},
    {scope:'importer',importerCode:'',amount:20},
    {scope:'other',importerCode:'02',amount:-10},
    {product_name:'DIM',amount:40},
    {scope:'domestic',amount:10}
  ],[{scope:'unassigned',amount:70,line_count:3},{scope:'other',importer_code:'01',amount:8,line_count:1}]);
  assert.deepEqual(result.rows,[
    {scope:'domestic',importerCode:'',sales:10,cost:0,grossProfit:10,margin:100,lineCount:0},
    {scope:'unassigned',importerCode:'',sales:150,cost:0,grossProfit:null,margin:null,lineCount:0}
  ]);
  assert.deepEqual(result.unassigned,{amount:78,count:4});
  assert.equal(result.totalCost,78);
});

test('zero sales, zero costs, credits and purchase-only domestic retain signed totals and defined margin behavior',()=>{
  const result=policy.buildImporterProfit([
    {scope:'importer',importerCode:'01',amount:100},
    {scope:'importer',importerCode:'01',amount:-100},
    {scope:'importer',importerCode:'02',amount:-100},
    {scope:'importer',importerCode:'03',amount:0}
  ],[
    {scope:'importer',importer_code:'01',amount:40,line_count:1},
    {scope:'importer',importer_code:'02',amount:-60,line_count:1},
    {scope:'importer',importer_code:'03',amount:0,line_count:1},
    {scope:'domestic',amount:-20,line_count:1}
  ]);
  assert.deepEqual(result.rows.map(row=>[row.scope,row.importerCode,row.grossProfit,row.margin,row.lineCount]),[
    ['importer','01',-40,null,1],['importer','02',-40,40,1],['importer','03',0,null,1],['domestic','',20,null,1]
  ]);
  assert.equal(result.totalCost,-40);
});

test('profit summary is pure, has deterministic order, supports the browser global and defaults omitted counts to one',()=>{
  const sales=Object.freeze([Object.freeze({scope:'importer',importerCode:'10',amount:200}),Object.freeze({scope:'importer',importerCode:'2',amount:100})]);
  const costs=Object.freeze([Object.freeze({scope:'importer',importer_code:'2',amount:50}),Object.freeze({scope:'fees',amount:5})]);
  const before=JSON.stringify([sales,costs]);
  const result=policy.buildImporterProfit(sales,costs);
  assert.deepEqual(result.rows.map(row=>row.importerCode),['02','10']);
  assert.equal(result.rows[0].lineCount,1);
  assert.deepEqual(result.fees,{amount:5,count:1});
  assert.equal(JSON.stringify([sales,costs]),before);
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../purchase-cost-scope.js'),'utf8'),context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.PurchaseCostScope.buildImporterProfit(sales,costs))),result);
  assert.deepEqual(policy.buildImporterProfit(),{rows:[],shared:{amount:0,count:0},unassigned:{amount:0,count:0},fees:{amount:0,count:0},totalCost:0});
});

test('profit totals reject unsafe money, negative or fractional counts and overflow without silently rounding',()=>{
  for(const amount of [1.5,'1.5',NaN,'bad',Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>policy.buildImporterProfit([{scope:'importer',importerCode:'01',amount}],[]),/integer/);
    assert.throws(()=>policy.buildImporterProfit([],[{scope:'shared',amount,line_count:1}]),/integer/);
  }
  for(const line_count of [-1,1.5,'bad',Infinity])assert.throws(()=>policy.buildImporterProfit([],[{scope:'shared',amount:10,line_count}]),/integer/);
  assert.throws(()=>policy.buildImporterProfit([],[{scope:'importer',importer_code:'01',amount:Number.MAX_SAFE_INTEGER},{scope:'fees',amount:1}]),/precision/);
  assert.throws(()=>policy.buildImporterProfit([{scope:'importer',importerCode:'01',amount:Number.MAX_SAFE_INTEGER}],[{scope:'importer',importer_code:'01',amount:-1}]),/precision/);
});
