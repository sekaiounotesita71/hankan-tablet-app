const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function setup(locked=false,provisional=false){
 const writes=[],ctx={currentSessionId:'work',currentUser:{id:'u'},currentSessionLocked:locked,currentSessionProvisionalLocked:provisional,
  boxMap:{'01':{'MAR-1':{gross:5}},'03':{'MAR-1':{gross:6}}},boxSaveInFlight:new Set(),
  workImporterFinalizedTrial:code=>code==='01',boxToPayload:(imp,bn,b)=>({importer_code:imp,box_no:bn,...b}),
  setSaveState(){},toast(){},supabaseClient:{from(){return {upsert(chunk){writes.push(chunk);return {select:async()=>({data:chunk})}}}}}};
 vm.createContext(ctx);
 vm.runInContext(app.slice(app.indexOf('async function saveAllBoxesToSupabase(){'),app.indexOf('function closeSessionPicker(){')),ctx);
 vm.runInContext(app.slice(app.indexOf('const __saveAllBoxesLockBase='),app.indexOf('saveBoxToSupabase=async function(imp,bn){')),ctx);
 return {ctx,writes};
}
test('phase 2 bulk persistence skips finalized boxes and participates in finalization save draining',async()=>{
 const {ctx,writes}=setup();const pending=ctx.saveAllBoxesToSupabase();
 assert.equal(ctx.boxSaveInFlight.size,1);assert.equal(await pending,true);assert.equal(ctx.boxSaveInFlight.size,0);
 assert.equal(writes.length,1);assert.equal(writes[0].length,1);assert.equal(writes[0][0].importer_code,'03');assert.equal(writes[0][0].gross,6);
});
test('full and provisional locks do not attempt bulk box writes',async()=>{
 for(const flags of [[true,false],[false,true]]){const {ctx,writes}=setup(...flags);assert.equal(await ctx.saveAllBoxesToSupabase(),true);assert.equal(writes.length,0)}
});
test('all-finalized box groups do not produce an empty upsert',async()=>{
 const {ctx,writes}=setup();ctx.workImporterFinalizedTrial=()=>true;
 assert.equal(await ctx.saveAllBoxesToSupabase(),true);assert.equal(writes.length,0);
});
