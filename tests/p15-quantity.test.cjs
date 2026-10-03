const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const app=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(start,end){
  const a=app.indexOf(start),b=app.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start);
  return app.slice(a,b);
}
function fixture(overrides={}){
  const patches=[],messages=[],refreshes=[];
  const row={_idx:12,_qty:2.5,_unit:'PC',_net:7.2,_box:'A-1',csv_qty:9,unit:'CS',origin:'Osaka',unit_price:1200};
  const ctx={rows:[row],currentSessionId:'session-A',requireEditableTrial:()=>true,
    numberOrNull:v=>v===''?null:Number(v),toast:m=>messages.push(m),
    updateOrderLineFieldsToSupabase:async(r,fields)=>{patches.push({...fields});return true},
    scheduleP15Refresh:()=>refreshes.push('p15'),scheduleP1InlineRefresh:r=>refreshes.push(r),...overrides};
  vm.createContext(ctx);
  vm.runInContext(source('const p15PendingFields=', 'function setImportPanelVisible'),ctx);
  return {ctx,row,patches,messages,refreshes};
}

test('quantity saves actual input_qty only, finds source row despite gaps, and refreshes phase 1',async()=>{
  const {ctx,row,patches,refreshes}=fixture();
  assert.equal(await ctx.saveP15Field(12,'_qty','3.75'),true);
  assert.equal(row._qty,'3.75');
  assert.deepEqual(patches,[{input_qty:3.75}]);
  assert.equal(row.csv_qty,9);assert.equal(row.unit,'CS');assert.equal(row._unit,'PC');
  assert.equal(row._net,7.2);assert.equal(row._box,'A-1');assert.equal(row.unit_price,1200);assert.equal(row.origin,'Osaka');
  assert.ok(refreshes.includes(row));
  assert.equal(vm.runInContext('p15QuantityChanged',ctx),true);
});
test('zero, empty, decimals and full-width numeric input are handled without guessing invalid values',async()=>{
  for(const [input,expected] of [['0',0],['',null],['.25',0.25],['１２．５',12.5]]){
    const {ctx,patches}=fixture();
    assert.equal(await ctx.saveP15Field(12,'_qty',input),true);
    assert.deepEqual(patches,[{input_qty:expected}]);
  }
  for(const input of ['-1','1,5','1e3','NaN','1..2','abc','9'.repeat(400)]){
    const {ctx,row,patches,messages}=fixture();
    assert.equal(await ctx.saveP15Field(12,'_qty',input),false);
    assert.equal(row._qty,2.5);assert.equal(patches.length,0);assert.equal(messages.length,1);
  }
});
test('unchanged Enter/blur does not double save and a failed save restores the last confirmed quantity',async()=>{
  const pending=[];
  const {ctx,row}=fixture({updateOrderLineFieldsToSupabase:()=>new Promise(resolve=>pending.push(resolve))});
  const first=ctx.saveP15Field(12,'_qty','3');
  await ctx.saveP15Field(12,'_qty','3');
  assert.equal(pending.length,1);
  const second=ctx.saveP15Field(12,'_qty','4');
  pending[0](false);await first;
  assert.equal(row._qty,'4');
  pending[1](false);await second;
  assert.equal(row._qty,2.5);
});
test('later failure rolls back to a preceding successful save, not an unconfirmed draft',async()=>{
  const pending=[];
  const {ctx,row}=fixture({updateOrderLineFieldsToSupabase:()=>new Promise(resolve=>pending.push(resolve))});
  const first=ctx.saveP15Field(12,'_qty','3'),second=ctx.saveP15Field(12,'_qty','4');
  pending[0](true);await first;pending[1](false);await second;
  assert.equal(row._qty,'3');
});
test('locks and stockouts block changes; unsaved work keeps its quantity locally',async()=>{
  const locked=fixture({requireEditableTrial:()=>false});
  assert.equal(await locked.ctx.saveP15Field(12,'_qty','3'),false);
  assert.equal(locked.row._qty,2.5);assert.equal(locked.patches.length,0);
  const stockout=fixture();stockout.row._stockout=true;
  assert.equal(await stockout.ctx.saveP15Field(12,'_qty','3'),false);assert.equal(stockout.patches.length,0);
  const local=fixture({currentSessionId:null});
  assert.equal(await local.ctx.saveP15Field(12,'_qty','3'),true);assert.equal(local.row._qty,'3');assert.equal(local.patches.length,0);
});
test('network exceptions rollback and old-session completion cannot repaint a newly opened work session',async()=>{
  const failed=fixture({updateOrderLineFieldsToSupabase:async()=>{throw Error('offline')}});
  assert.equal(await failed.ctx.saveP15Field(12,'_qty','3'),false);assert.equal(failed.row._qty,2.5);
  assert.match(failed.messages[0],/offline/);
  let resolve;
  const pending=fixture({updateOrderLineFieldsToSupabase:()=>new Promise(r=>resolve=r)});
  const task=pending.ctx.saveP15Field(12,'_qty','3');pending.ctx.currentSessionId='session-B';
  resolve(true);await task;assert.equal(pending.refreshes.length,0);
});
test('origin and price keep their own database fields',async()=>{
  const {ctx,patches}=fixture();
  await ctx.saveP15Field(12,'origin','Nagano');await ctx.saveP15Field(12,'unit_price','1250');
  assert.deepEqual(patches,[{origin:'Nagano'},{unit_price:1250}]);
});
test('queued field patches retain the work session they were created for',async()=>{
  const calls=[];let release;
  const queue=new Promise(r=>release=r);
  const ctx={currentSessionId:'session-A',currentUser:{id:'user'},requireEditableTrial:()=>true,
    orderLineSaveQueues:new Map([['session-A:13',queue]]),setSaveState:()=>{},toast:()=>{},
    supabaseClient:{from:()=>({update(payload){calls.push(payload);return this},eq(k,v){calls.push([k,v]);return this},is(k,v){calls.push([k,v]);return this},select(){return this},async maybeSingle(){return {data:{source_row_no:13},error:null}}})}};
  vm.createContext(ctx);vm.runInContext(source('function updateOrderLineFieldsToSupabase(', 'async function saveBoxToSupabase('),ctx);
  const task=ctx.updateOrderLineFieldsToSupabase({_idx:12},{input_qty:3});ctx.currentSessionId='session-B';release();
  assert.equal(await task,true);assert.ok(calls.some(v=>v[0]==='session_id'&&v[1]==='session-A'));
});
test('Enter and vertical arrows move between editable fields without opening price history or interrupting IME',()=>{
  const moves=[],saves=[],closed=[];
  const ctx={setTimeout:fn=>fn(),document:{querySelectorAll:()=>inputs},saveP15Field:(...args)=>saves.push(args),closeP15History:i=>closed.push(i)};
  const inputs=['_qty','origin','unit_price','_qty','origin'].map((col,i)=>({dataset:{p15Order:i,p15Col:col},offsetParent:{},disabled:i===3,value:'3',focus(){moves.push(i)},select(){}}));
  ctx.document.querySelectorAll=selector=>selector.includes('data-p15-col')?inputs.filter(i=>selector.includes(`"${i.dataset.p15Col}"`)):inputs;
  vm.createContext(ctx);vm.runInContext(source('function moveP15Focus(', 'let p15RefreshTimer='),ctx);
  ctx.handleP15Key({key:'Enter',currentTarget:inputs[0],preventDefault(){}},12,'_qty');assert.deepEqual(moves,[1]);assert.equal(saves.length,1);
  ctx.handleP15Key({key:'Enter',currentTarget:inputs[2],preventDefault(){}},12,'unit_price');assert.deepEqual(moves,[1,4]);
  ctx.handleP15Key({key:'ArrowDown',currentTarget:inputs[1],preventDefault(){}},12,'origin');assert.equal(moves.at(-1),4);
  ctx.handleP15Key({key:'ArrowUp',currentTarget:inputs[4],preventDefault(){}},13,'origin');assert.equal(moves.at(-1),1);
  const count=saves.length;ctx.handleP15Key({key:'Enter',isComposing:true,currentTarget:inputs[1]},12,'origin');assert.equal(saves.length,count);
});
test('quantity uses native inline editing, read-only unit and existing focus/refresh protection',()=>{
  const ctx={esc:v=>String(v??'')};vm.createContext(ctx);
  vm.runInContext(source('function p15QuantityInput(', 'function renderP15Importer('),ctx);
  const html=ctx.p15QuantityInput({_idx:12,_qty:0,_unit:'PC'},0);
  assert.match(html,/value="0"/);assert.match(html,/inputmode="decimal"/);assert.match(html,/>PC<\/span>/);
  assert.match(html,/class="p15-input p15-quantity"/);assert.doesNotMatch(html,/<select|openP1NP/);
  assert.match(ctx.p15QuantityInput({_idx:13,_stockout:true},3),/disabled/);
  assert.match(source('function renderP15Importer(', 'function moveP15Focus('),/<th>実績数量<\/th>/);
  assert.match(source('function renderP15Importer(', 'function moveP15Focus('),/colspan="9"/);
  assert.match(source('function applyLockToInputsTrial(', 'function requireEditableTrial('),/\.p15-input/);
  assert.match(source('function scheduleP15Refresh(', 'const p15PendingFields='),/if\(p15EntryActive\(\)\)/);
  assert.match(source('function inlineEntryActive(', 'function scheduleDeferredRemoteRender('),/contains\("p15-input"\)/);
  assert.match(app,/if\(n===1&&p15QuantityChanged\)\{buildP1Tabs\(\);p15QuantityChanged=false\}/);
});
test('actual quantity controls remain disabled for stockout, final and provisional locks',()=>{
  const inputs=[{dataset:{stockout:'false'},removeAttribute(){}},{dataset:{stockout:'true'},removeAttribute(){}}];
  const ctx={currentSessionLocked:true,currentSessionProvisionalLocked:false,document:{querySelectorAll:selector=>selector.startsWith('#cloud-save-bar')?[]:inputs}};
  vm.createContext(ctx);vm.runInContext(source('function applyLockToInputsTrial(', 'function requireEditableTrial('),ctx);
  ctx.applyLockToInputsTrial();assert.ok(inputs.every(i=>i.disabled));
  ctx.currentSessionLocked=false;ctx.currentSessionProvisionalLocked=true;
  ctx.applyLockToInputsTrial();assert.ok(inputs.every(i=>i.disabled));
  ctx.currentSessionProvisionalLocked=false;ctx.applyLockToInputsTrial();
  assert.equal(inputs[0].disabled,false);assert.equal(inputs[1].disabled,true);
});
test('scheduled refresh waits until phase 1.5 editing finishes',()=>{
  let callback,count=0;
  const ctx={currentPhase:1.5,document:{activeElement:{classList:{contains:()=>true}}},
    clearTimeout:()=>{},setTimeout:fn=>{callback=fn;return 1},buildP15:()=>count++};
  vm.createContext(ctx);vm.runInContext(source('let p15RefreshTimer=', '// Keep the last acknowledged'),ctx);
  ctx.scheduleP15Refresh();callback();assert.equal(count,0);
  ctx.document.activeElement=null;callback();assert.equal(count,1);
});
test('work app scripts compile',()=>{
  for(const match of app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
});

if(process.env.P15_FIXTURE_PATH){
  const css=app.match(/<style>([\s\S]*?)<\/style>/)[1];
  const sample=[['養殖ハマチ',2.5,'Kg','Kagoshima',1800],['真鯛フィレ',4,'PC','Ehime',2400],['冷凍 ボタンエビ',0,'pkt','Hokkaido',''],['ほたて貝柱','','CS','Hokkaido',1200],['天然真鯛（欠品）','','Kg','','']];
  const rows=sample.map(([product_name,_qty,_unit,origin,unit_price],i)=>({_idx:i+10,product_name,_qty,_unit,origin,unit_price,importer_id:'01',customer:i<2?'確認用店舗A':'確認用店舗B',product_id:`P00${i}`,csv_qty:10,_net:5,_box:'A-1',_stockout:i===4}));
  const script=`
    const rows=${JSON.stringify(rows)};
    const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    const workProductCell=row=>esc(row.product_name);
    const cid=v=>v,importerCode=v=>v,importerDisplayName=()=>"DIM";
    const p15MasterPriceSelections=new Set(),p15HistoryOpenRowIdx=null;
    const p15MasterPriceScope=()=>"contract",p15MasterSelectedRows=()=>[];
    const p15HistorySuggestionHtml=()=>"",p15HistoryDetailHtml=()=>"";
    const closeP15History=()=>{},toggleP15History=()=>{},showP15History=()=>{};
    let currentSessionId='local-test',currentPhase=1.5,currentSessionLocked=false,currentSessionProvisionalLocked=false;
    const requireEditableTrial=()=>!currentSessionLocked&&!currentSessionProvisionalLocked;
    const numberOrNull=v=>v===''?null:Number(v);
    const toast=m=>document.getElementById('test-result').textContent=m;
    const patches=[];
    const updateOrderLineFieldsToSupabase=async(row,fields)=>{patches.push({id:row._idx,...fields});document.getElementById('test-result').textContent=JSON.stringify(patches);return true};
    const scheduleP1InlineRefresh=()=>{};
    const buildP15=()=>{const host=document.querySelector('.table-scroll'),left=host?.scrollLeft||0;renderP15Importer('01');document.querySelector('.table-scroll').scrollLeft=left};
    ${source('function p15RowState(', 'function setImportPanelVisible')}
    ${source('function applyLockToInputsTrial(', 'function requireEditableTrial(')}
    renderP15Importer('01');
    document.getElementById('test-lock').onchange=e=>{currentSessionLocked=e.target.checked;applyLockToInputsTrial()};
    document.getElementById('test-refresh').onclick=()=>scheduleP15Refresh();
  `;
  fs.writeFileSync(process.env.P15_FIXTURE_PATH,`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phase 1.5 数量入力テスト</title><style>${css}</style><body><main><h2>Phase 1.5 産地・売価</h2><label><input id="test-lock" type="checkbox">確定ロック（検証用）</label><button id="test-refresh">再表示（検証用）</button><output id="test-result"></output><div id="p15-tabs-wrap"><div id="p15content-01"></div></div></main><script>${script}</script></body></html>`);
}
