const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'sales-unlock-importers.js'),'utf8'),refinalizeSource=fs.readFileSync(path.join(root,'sales-refinalize.js'),'utf8'),app=fs.readFileSync(path.join(root,'index.html'),'utf8');
const model=fs.readFileSync(path.join(__dirname,'sales-finalize-importers-ui.test.cjs'),'utf8');
const {Dialog}=vm.runInNewContext(model.slice(model.indexOf('class Control{'),model.indexOf('function fixture('))+';({Dialog})');
const clone=x=>JSON.parse(JSON.stringify(x)),tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}}
function fixture(options={}){
  const document={dialogs:[],createElement(){return new Dialog(this)}};
  document.body={append(dialog){dialog.isConnected=true;document.dialogs.push(dialog)}};
  const preview={session:{id:'work',name:'Tokyo',work_date:'2026-10-29',locked:false,finalized_importer_codes:['01','03'],reopened_importer_codes:[]},version:'v1',groups:[
    {importer_code:'01',importer_name:'DIM',line_count:102,finalized:true,shipping:100},
    {importer_code:'03',importer_name:'FBI',line_count:3,finalized:true,shipping:20},
    {importer_code:'07',importer_name:'JKT',line_count:30,finalized:false,shipping:0}
  ]};
  const calls=[],alerts=[],locks=[],states=[],toasts=[];
  const context=vm.createContext({
    document,currentSessionId:'work',currentPhase:1,activeCountry:'DIM',activeImporter:'JKT',salesFinalizeInProgress:false,
    currentSessionFinalizedImporters:['01','03'],currentSessionReopenedImporters:[],orderLineSaveQueues:new Map(),boxSaveInFlight:new Set(),admin:options.admin!==false,
    invoiceImporterCode:value=>({DIM:'01',FBI:'03',JKT:'07'})[value]||value,
    currentUserIsAdmin:()=>context.admin,loadCurrentUserRoleTrial:async()=>{},updateLockUITrial(){},
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    alert:message=>alerts.push(message),toast:message=>toasts.push(message),confirm:()=>true,
    setSessionLockStateTrial:session=>{locks.push(clone(session));context.currentSessionFinalizedImporters=session.finalized_importer_codes;context.currentSessionReopenedImporters=session.reopened_importer_codes;},
    setSaveState:message=>states.push(message),
    supabaseClient:{async rpc(name,args){
      calls.push({name,args:clone(args)});
      if(name==='work_importer_finalization_preview')return options.preview?options.preview(context):{data:clone(preview)};
      if(name==='work_reopened_importer_preview')return {data:{...clone(preview),groups:clone(preview.groups).map((g,i)=>({...g,changed:i===0,reopened:i===0}))}};
      if(options.save)return options.save(name,args,context);
      return {data:{session:{id:'work',locked:false,finalized_importer_codes:['03'],reopened_importer_codes:['01']},pending_importers:['07']}};
    }}
  });
  vm.runInContext(source,context);
  return {context,document,preview,calls,alerts,locks,states,toasts,writes:()=>calls.filter(call=>!call.name.includes('preview'))};
}
async function open(f){const completion=f.context.openSalesImporterUnlock();await tick();assert.equal(f.document.dialogs.length,1);return {dialog:f.document.dialogs[0],completion}}
const box=(dialog,i)=>dialog.querySelector(`[data-importer-index="${i}"]`);

test('opening partial or full work is read-only; only finalized importers are selectable, and cancellation is harmless',async()=>{
  for(const locked of [false,true]){
    const f=fixture();f.preview.session.locked=locked;
    const {dialog,completion}=await open(f);
    assert.equal(box(dialog,0).checked,true);assert.equal(box(dialog,0).disabled,false);assert.equal(box(dialog,1).disabled,false);assert.equal(box(dialog,2).disabled,true);
    assert.equal(f.writes().length,0);await dialog.click('[data-close]');assert.equal(await completion,false);assert.equal(f.locks.length,0);
  }
});

test('the selected code, reason and optimistic version are submitted exactly once and apply the returned scoped locks',async()=>{
  const f=fixture(),{dialog,completion}=await open(f);
  await dialog.click('[data-submit]');assert.equal(f.writes().length,0);
  dialog.querySelector('[data-reason]').value='Correct price';await dialog.click('[data-submit]');
  assert.equal(await completion,true);assert.deepEqual(f.writes()[0].args,{p_session_id:'work',p_importer_codes:['01'],p_reason:'Correct price',p_expected_version:'v1'});
  assert.deepEqual(f.locks[0].finalized_importer_codes,['03']);assert.deepEqual(f.locks[0].reopened_importer_codes,['01']);
});

test('double submission, Escape, and closing are blocked while saving; session switches do not overwrite another work session',async()=>{
  const wait=deferred(),f=fixture({save:()=>wait.promise}),{dialog,completion}=await open(f);
  dialog.querySelector('[data-reason]').value='Correct price';const saving=dialog.click('[data-submit]');await tick();
  await dialog.click('[data-submit]');assert.equal(f.writes().length,1);assert.equal((await dialog.escape()).defaultPrevented,true);
  await dialog.click('[data-close]');assert.equal(dialog.open,true);
  f.context.currentSessionId='other';wait.resolve({data:{session:{id:'work',finalized_importer_codes:['03'],reopened_importer_codes:['01']}}});
  await saving;assert.equal(await completion,true);assert.equal(f.locks.length,0);
});

test('stale versions disable retry until reopened; permission errors and missing SQL do not change locks',async()=>{
  const f=fixture({save:async()=>({error:{code:'40001',message:'changed'}})}),{dialog,completion}=await open(f);
  dialog.querySelector('[data-reason]').value='Correct price';await dialog.click('[data-submit]');await dialog.click('[data-submit]');
  assert.equal(f.writes().length,1);assert.equal(dialog.querySelector('[data-submit]').disabled,true);assert.equal(f.locks.length,0);
  await dialog.click('[data-close]');await completion;
  for(const options of [{admin:false},{preview:async()=>({data:{session:{id:'work'},groups:[],version:'v1'}})}]){
    const denied=fixture(options);assert.equal(await denied.context.openSalesImporterUnlock(),false);assert.equal(denied.writes().length,0);assert.equal(denied.document.dialogs.length,0);
  }
});

test('save queues are drained and a work switch or unsaved data prevents an unlock request',async()=>{
  for(const switchWork of [true,false]){
    const wait=deferred(),f=fixture();f.context.orderLineSaveQueues.set('line',wait.promise);
    const opening=f.context.openSalesImporterUnlock();await tick();assert.equal(f.calls.length,0);
    if(switchWork)f.context.currentSessionId='other';wait.resolve(!switchWork?false:true);
    assert.equal(await opening,false);assert.equal(f.calls.length,0);assert.equal(f.document.dialogs.length,0);
  }
});

test('an ambiguous committed result cannot be resubmitted and UI failures after success are not retried',async()=>{
  for(const badResult of [true,false]){
    const f=fixture({save:async()=>({data:badResult?{}:{session:{id:'work',finalized_importer_codes:['03'],reopened_importer_codes:['01']}}})});
    if(!badResult)f.context.setSessionLockStateTrial=()=>{throw new Error('render failed')};
    const {dialog,completion}=await open(f);dialog.querySelector('[data-reason]').value='Correct price';await dialog.click('[data-submit]');await dialog.click('[data-submit]');
    assert.equal(f.writes().length,1);assert.equal(dialog.querySelector('[data-submit]').disabled,true);await dialog.click('[data-close]');await completion;
  }
});

test('scoped re-finalization selects reopened importers only, retaining other pending and finalized work disabled',async()=>{
  const f=fixture();f.context.currentSessionReopenedImporters=['01'];vm.runInContext(refinalizeSource,f.context);
  const completion=f.context.openSalesRefinalization();await tick();const dialog=f.document.dialogs[0];
  assert.equal(f.calls[0].name,'work_reopened_importer_preview');assert.equal(box(dialog,0).checked,true);assert.equal(box(dialog,1).disabled,true);assert.equal(box(dialog,2).disabled,true);
  box(dialog,1).checked=true;await dialog.fire('change',box(dialog,1));assert.equal(box(dialog,1).checked,false);
  await dialog.click('[data-submit]');assert.equal(await completion,true);assert.deepEqual(f.writes()[0].args.p_importer_codes,['01']);
});

test('actual lock UI exposes the unlock button for partial and full locks, only to admins',()=>{
  const f=fixture();const controls={};
  f.context.document.getElementById=id=>controls[id]??=({style:{},dataset:{},textContent:'',innerHTML:''});
  Object.assign(f.context,{currentSessionLocked:false,currentSessionProvisionalLocked:false,currentSessionFinalizedAt:'',applyLockToInputsTrial(){}});
  const start=app.indexOf('function setSessionLockStateTrial(session)'),end=app.indexOf('async function setProvisionalLockTrial(',start);
  vm.runInContext(app.slice(start,end),f.context);
  f.context.applyLockToInputsTrial=()=>{};
  f.context.setSessionLockStateTrial({locked:false,finalized_importer_codes:['01'],reopened_importer_codes:[]});assert.equal(controls['unlock-btn'].style.display,'');
  f.context.setSessionLockStateTrial({locked:true});assert.equal(controls['unlock-btn'].style.display,'');
  f.context.admin=false;f.context.updateLockUITrial();assert.equal(controls['unlock-btn'].style.display,'none');
  f.context.admin=true;f.context.setSessionLockStateTrial({locked:false,finalized_importer_codes:[],reopened_importer_codes:['01']});
  assert.equal(controls['unlock-btn'].style.display,'none');assert.equal(controls['finalize-btn'].textContent,'\u58f2\u4e0a\u518d\u78ba\u5b9a');
});

test('all deployed scripts compile and the scoped unlock entry replaces global direct updates',()=>{
  new vm.Script(source);new vm.Script(refinalizeSource);
  for(const match of app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  const unlock=app.slice(app.indexOf('async function unlockSessionTrial(){'),app.indexOf('const __updateSupabaseStatusLockBase='));
  assert.match(unlock,/openSalesImporterUnlock/);assert.doesNotMatch(unlock,/\.update\(/);
  assert.match(app,/sales-unlock-importers\.js\?v=20261029-1/);
});
