const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"..","sales-finalize-importers.js"),"utf8");
const app=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const previewRpc="work_importer_finalization_preview";
const finalizeRpc="finalize_work_session_importers";
const clone=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
  return {promise,resolve,reject};
}

// Only the dialog's controls and event lifecycle are modeled; no browser is launched.
class Control{
  constructor(tag,attributes={}){
    this.tagName=tag;this.attributes=attributes;this.dataset={};this.textContent="";
    this.checked="checked" in attributes;this.disabled="disabled" in attributes;
    this.value=attributes.value??"";this.focused=false;
    for(const [key,value] of Object.entries(attributes)){
      if(key.startsWith("data-"))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
    }
  }
  matches(selector){
    if(selector.endsWith(":checked"))return this.checked&&this.matches(selector.slice(0,-8));
    if(selector.startsWith("."))return (this.attributes.class||"").split(/\s+/).includes(selector.slice(1));
    const attribute=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if(attribute)return attribute[1] in this.attributes&&(attribute[2]===undefined||this.attributes[attribute[1]]===attribute[2]);
    return this.tagName===selector;
  }
  closest(selector){return this.matches(selector)?this:null}
  focus(){this.focused=true}
}
class Dialog extends Control{
  constructor(document){super("dialog");this.document=document;this.listeners=new Map();this.isConnected=false;this.open=false}
  setAttribute(name,value){this.attributes[name]=value}
  set innerHTML(html){
    this.html=html;this.controls=[];
    for(const match of html.matchAll(/<(input|button|div)\b([^>]*)>/g)){
      const attributes={};
      for(const attr of match[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g))attributes[attr[1]]=attr[2]??"";
      this.controls.push(new Control(match[1],attributes));
    }
  }
  get innerHTML(){return this.html}
  querySelectorAll(selector){return this.controls.filter(control=>selector.split(",").some(part=>control.matches(part)))}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  addEventListener(type,handler,options={}){
    if(!this.listeners.has(type))this.listeners.set(type,[]);
    this.listeners.get(type).push({handler,once:options.once});
  }
  async fire(type,target=this){
    const event={target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};
    const listeners=[...(this.listeners.get(type)||[])];
    for(const listener of listeners){
      if(listener.once)this.listeners.set(type,this.listeners.get(type).filter(item=>item!==listener));
      await listener.handler(event);
    }
    return event;
  }
  showModal(){this.open=true}
  close(){if(!this.open)return;this.open=false;return this.fire("close")}
  remove(){this.isConnected=false;this.document.dialogs=this.document.dialogs.filter(dialog=>dialog!==this)}
  click(selector){return this.fire("click",this.querySelector(selector))}
  async select(index,checked){
    const control=this.querySelector(`[data-importer-index="${index}"]`);
    control.checked=checked;await this.fire("change",control);
  }
  async escape(){const event=await this.fire("cancel");if(!event.defaultPrevented)await this.close();return event}
}

function fixture(options={}){
  const document={dialogs:[],createElement(tag){assert.equal(tag,"dialog");return new Dialog(this)}};
  document.body={append(dialog){dialog.isConnected=true;document.dialogs.push(dialog)}};
  const groups=options.groups||[
    {importer_code:"01",importer_name:"FBI",line_count:2,net_sales:1200,shipping:100,incomplete:0,finalized:false},
    {importer_code:"03",importer_name:"DIM",line_count:3,net_sales:2400,shipping:250,incomplete:0,finalized:false},
    {importer_code:"08",importer_name:"Domestic",line_count:1,net_sales:900,shipping:500,incomplete:2,finalized:true}
  ];
  const preview={session:{id:"work-1",name:"Osaka",work_date:"2026-10-22",locked:false},version:"version-1",groups};
  const calls=[],alerts=[],confirms=[],toasts=[],saveStates=[],locks=[];
  const context=vm.createContext({
    document,currentSessionId:"work-1",currentPhase:1,activeCountry:"FBI",activeImporter:"DIM",
    currentSessionFinalizedImporters:["08"],orderLineSaveQueues:new Map(),boxSaveInFlight:new Set(),
    isAdmin:!!options.admin,
    invoiceImporterCode(value){
      const code=String(value??"").normalize("NFKC").trim().toUpperCase();
      return ({FBI:"01",DIM:"03",DOMESTIC:"08"})[code]||(/^\d{1,3}$/.test(code)?code.padStart(2,"0"):"");
    },
    esc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;")},
    async loadCurrentUserRoleTrial(){if(options.loadRole)await options.loadRole(context)},
    currentUserIsAdmin(){return context.isAdmin},
    alert(message){alerts.push(message)},
    confirm(message){confirms.push(message);return options.confirm?options.confirm(context):true},
    toast(message){toasts.push(message)},
    setSaveState(...args){saveStates.push(args)},
    setSessionLockStateTrial(session){locks.push(clone(session));context.currentSessionFinalizedImporters=session.finalized_importer_codes},
    supabaseClient:{async rpc(name,args){
      calls.push({name,args:clone(args)});
      if(name===previewRpc)return options.preview?options.preview(context):{data:clone(preview)};
      assert.equal(name,finalizeRpc);
      return options.finalize?options.finalize(args,context):{
        data:{session:{id:"work-1",locked:false,finalized_importer_codes:["01","08"]},saved_rows:2,importer_codes:["01"],pending_importers:["03"]}
      };
    }}
  });
  Object.assign(context,options.globals||{});
  vm.runInContext(source,context);
  return {context,document,preview,groups,calls,alerts,confirms,toasts,saveStates,locks,
    writes:()=>calls.filter(call=>call.name===finalizeRpc)};
}
async function open(f){
  const completion=f.context.openSalesImporterFinalization();await tick();
  assert.equal(f.document.dialogs.length,1);
  return {dialog:f.document.dialogs[0],completion};
}
const checkbox=(dialog,index)=>dialog.querySelector(`[data-importer-index="${index}"]`);
const shipping=(dialog,index)=>dialog.querySelector(`[data-shipping-index="${index}"]`);
const submit=dialog=>dialog.querySelector("[data-submit]");
const error=dialog=>dialog.querySelector(".refinalize-error").textContent;

test("finalized helper normalizes names and codes without treating unknown values as locks",()=>{
  const f=fixture(),isFinalized=f.context.importerSalesCodeFinalized;
  assert.equal(isFinalized("Domestic"),true);
  assert.equal(isFinalized("８"),true);
  assert.equal(isFinalized("FBI"),false);
  for(const array of [undefined,null,{},[],["unknown"],[""]]){
    f.context.currentSessionFinalizedImporters=array;
    assert.equal(isFinalized(""),false);assert.equal(isFinalized("unknown"),false);assert.equal(isFinalized("08"),false);
  }
  delete f.context.currentSessionFinalizedImporters;
  assert.equal(isFinalized("08"),false);
  f.context.currentSessionFinalizedImporters=["FBI"];
  assert.equal(isFinalized("１"),true);
});

test("opening is read-only; pending states, counts, saved shipping and finalized controls are shown",async()=>{
  const f=fixture(),{dialog,completion}=await open(f);
  assert.deepEqual(f.calls,[{name:previewRpc,args:{p_session_id:"work-1"}}]);
  assert.equal(dialog.className,"refinalize-dialog");
  assert.equal(checkbox(dialog,0).checked,true);
  assert.equal(checkbox(dialog,1).checked,false);
  assert.equal(checkbox(dialog,2).disabled,true);
  assert.equal(shipping(dialog,0).value,"100");assert.equal(shipping(dialog,0).disabled,false);
  assert.equal(shipping(dialog,1).disabled,true);assert.equal(shipping(dialog,2).disabled,true);
  assert.match(dialog.innerHTML,/商品売上 1,200円/);
  assert.match(dialog.innerHTML,/確定済み/);assert.match(dialog.innerHTML,/作業未完了 2件/);
  assert.match(dialog.querySelector("[data-summary]").textContent,/未確定 2社 \/ 確定済み 1社 \/ 選択 1社・2明細/);
  await dialog.click("[data-close]");assert.equal(await completion,false);
  assert.equal(f.writes().length,0);assert.deepEqual(f.locks,[]);assert.deepEqual(f.saveStates,[]);
});

test("default selection follows the current phase, not the other phase's active importer",async t=>{
  for(const [name,globals,expected] of [
    ["phase 1",{currentPhase:1,activeCountry:"１",activeImporter:"03"},0],
    ["phase 1.5",{currentPhase:1.5,activeCountry:"01",activeImporter:"DIM"},1],
    ["phase 2",{currentPhase:2,activeCountry:"01",activeImporter:"３"},1],
    ["unknown current importer",{activeCountry:"unknown"},-1],
    ["finalized current importer",{activeCountry:"08"},-1]
  ])await t.test(name,async()=>{
    const f=fixture({globals}),{dialog,completion}=await open(f);
    assert.deepEqual([0,1,2].filter(i=>checkbox(dialog,i).checked),expected<0?[]:[expected]);
    assert.equal(submit(dialog).disabled,expected<0);
    await dialog.escape();assert.equal(await completion,false);
  });
});

test("one pending importer can preselect; all-finalized previews cannot submit",async()=>{
  const f=fixture({globals:{activeCountry:"unknown"}});f.groups[1].finalized=true;
  let {dialog,completion}=await open(f);
  assert.equal(checkbox(dialog,0).checked,true);await dialog.escape();assert.equal(await completion,false);
  f.groups[0].finalized=true;
  ({dialog,completion}=await open(f));
  assert.equal(submit(dialog).disabled,true);
  assert.ok([0,1,2].every(i=>checkbox(dialog,i).disabled&&!checkbox(dialog,i).checked));
  await dialog.click("[data-submit]");assert.equal(f.writes().length,0);
  await dialog.escape();assert.equal(await completion,false);
});

test("only selected pending importers and their fees are sent, with expected version and no override",async()=>{
  const f=fixture(),{dialog,completion}=await open(f);
  await dialog.select(0,false);await dialog.select(1,true);
  shipping(dialog,0).value="bad unselected fee";shipping(dialog,1).value="0";shipping(dialog,2).value="-5";
  checkbox(dialog,2).checked=true;
  await dialog.click("[data-submit]");assert.equal(await completion,true);
  assert.deepEqual(f.writes()[0].args,{
    p_session_id:"work-1",p_importer_codes:["03"],p_shipping_fees:{"03":0},p_expected_version:"version-1",p_allow_incomplete:false
  });
  assert.equal(f.confirms.length,0);assert.equal(f.document.dialogs.length,0);
});

test("multiple selection updates counts and submits both shipping fees",async()=>{
  const f=fixture(),{dialog,completion}=await open(f);
  await dialog.select(1,true);shipping(dialog,1).value="350";
  assert.match(dialog.querySelector("[data-summary]").textContent,/選択 2社・5明細/);
  await dialog.click("[data-submit]");assert.equal(await completion,true);
  assert.deepEqual(f.writes()[0].args.p_importer_codes,["01","03"]);
  assert.deepEqual(f.writes()[0].args.p_shipping_fees,{"01":100,"03":350});
});

test("selected shipping must be a nonnegative safe integer and missing selection cannot submit",async()=>{
  const f=fixture(),{dialog,completion}=await open(f),fee=shipping(dialog,0);
  for(const value of [""," ","-1","1.5","NaN","Infinity","9007199254740992"]){
    fee.value=value;fee.focused=false;await dialog.click("[data-submit]");
    assert.match(error(dialog),/0以上の整数/);assert.equal(fee.focused,true);assert.equal(f.writes().length,0);
  }
  await dialog.select(0,false);assert.equal(fee.disabled,true);assert.equal(submit(dialog).disabled,true);
  await dialog.click("[data-submit]");assert.equal(f.writes().length,0);
  await dialog.select(0,true);fee.value="42";
  await dialog.click("[data-submit]");assert.equal(await completion,true);
  assert.deepEqual(f.writes()[0].args.p_shipping_fees,{"01":42});
});

test("nonadmins cannot finalize selected incomplete work, but unselected incomplete work does not block",async()=>{
  const f=fixture();f.groups[0].incomplete=2;
  const {dialog,completion}=await open(f);
  assert.equal(submit(dialog).disabled,true);assert.match(error(dialog),/管理者/);
  await dialog.click("[data-submit]");assert.equal(f.writes().length,0);assert.equal(f.confirms.length,0);
  await dialog.select(0,false);await dialog.select(1,true);
  assert.equal(submit(dialog).disabled,false);assert.equal(error(dialog),"");
  await dialog.click("[data-submit]");assert.equal(await completion,true);
  assert.equal(f.writes()[0].args.p_allow_incomplete,false);
});

test("admins confirm selected incomplete work once; declining is read-only and restores controls",async t=>{
  for(const accepted of [false,true])await t.test(String(accepted),async()=>{
    const reply=deferred(),f=fixture({admin:true,confirm:()=>accepted,finalize:()=>reply.promise});f.groups[0].incomplete=2;
    const {dialog,completion}=await open(f);
    const request=dialog.click("[data-submit]");await tick();
    assert.equal(f.confirms.length,1);assert.match(f.confirms[0],/2件/);
    if(accepted){
      await dialog.click("[data-submit]");assert.equal(f.confirms.length,1);assert.equal(f.writes().length,1);
      assert.equal(f.writes()[0].args.p_allow_incomplete,true);
      reply.resolve({data:{session:{id:"work-1",locked:false},saved_rows:2,importer_codes:["01"],pending_importers:["03"]}});
      await request;assert.equal(await completion,true);
    }else{
      await request;assert.equal(f.writes().length,0);assert.equal(submit(dialog).disabled,false);
      await dialog.escape();assert.equal(await completion,false);
    }
  });
});

test("opening and submitting are guarded against double clicks; Escape and close are blocked while busy",async()=>{
  const reply=deferred(),f=fixture({finalize:()=>reply.promise}),{dialog,completion}=await open(f);
  assert.equal(await f.context.openSalesImporterFinalization(),false);assert.equal(f.calls.length,1);
  const request=dialog.click("[data-submit]");await tick();
  assert.equal(submit(dialog).disabled,true);assert.equal(checkbox(dialog,0).disabled,true);
  assert.equal(checkbox(dialog,2).disabled,true);assert.equal(shipping(dialog,0).disabled,true);
  assert.equal(dialog.querySelector("[data-close]").disabled,true);
  assert.equal((await dialog.escape()).defaultPrevented,true);
  await dialog.click("[data-close]");assert.equal(dialog.open,true);
  await dialog.click("[data-submit]");assert.equal(f.writes().length,1);
  reply.resolve({data:{session:{id:"work-1",locked:false,finalized_importer_codes:["01","08"]},saved_rows:2,importer_codes:["01"],pending_importers:["03"]}});
  await request;assert.equal(await completion,true);
  assert.equal(f.locks[0].locked,false);assert.deepEqual(f.locks[0].finalized_importer_codes,["01","08"]);
  assert.match(f.saveStates[0][0],/未確定 1社/);assert.match(f.toasts[0],/1社・2明細/);
  assert.equal(f.context.importerSalesCodeFinalized("01"),true);
  const reopened=await open(f);await reopened.dialog.escape();assert.equal(await reopened.completion,false);
});

test("full completion applies server session lock, success status and toast",async()=>{
  const f=fixture({finalize:async()=>({data:{session:{id:"work-1",locked:true,finalized_importer_codes:["01","03","08"]},saved_rows:5,importer_codes:["01","03"],pending_importers:[]}})});
  const {dialog,completion}=await open(f);await dialog.select(1,true);
  await dialog.click("[data-submit]");assert.equal(await completion,true);
  assert.equal(f.locks[0].locked,true);assert.match(f.saveStates[0][0],/請求候補反映済み/);
  assert.match(f.toasts[0],/2社・5明細/);assert.doesNotMatch(f.toasts[0],/未確定/);
});

test("opening waits for line and box saves, including successor queues, before preview",async()=>{
  const line=deferred(),box=deferred(),next=deferred(),f=fixture();
  f.context.orderLineSaveQueues.set("line",line.promise);f.context.boxSaveInFlight.add(box.promise);
  const completion=f.context.openSalesImporterFinalization();await tick();
  assert.equal(f.calls.length,0);assert.equal(await f.context.openSalesImporterFinalization(),false);
  f.context.orderLineSaveQueues.set("line",next.promise);line.resolve(true);await tick();assert.equal(f.calls.length,0);
  box.resolve(true);await tick();assert.equal(f.calls.length,0);
  next.resolve(true);await tick();assert.equal(f.calls.length,1);
  await f.document.dialogs[0].escape();assert.equal(await completion,false);
});

test("failed or rejected saves prevent preview and release the opening guard",async t=>{
  for(const rejected of [false,true])await t.test(String(rejected),async()=>{
    const save=deferred(),f=fixture();f.context.boxSaveInFlight.add(save.promise);
    const completion=f.context.openSalesImporterFinalization();await tick();
    if(rejected)save.reject(new Error("offline"));else save.resolve(false);
    assert.equal(await completion,false);assert.equal(f.calls.length,0);assert.match(f.alerts[0],/未保存/);
    f.context.boxSaveInFlight.clear();const reopened=await open(f);await reopened.dialog.escape();assert.equal(await reopened.completion,false);
  });
});

test("submit also drains new saves, prevents cancellation while waiting, and stops on failed saves",async()=>{
  const f=fixture(),{dialog,completion}=await open(f),save=deferred();
  f.context.orderLineSaveQueues.set("line",save.promise);
  const request=dialog.click("[data-submit]");await tick();
  assert.equal(f.writes().length,0);assert.equal((await dialog.escape()).defaultPrevented,true);
  save.resolve(false);await request;assert.equal(f.writes().length,0);assert.match(error(dialog),/未保存/);
  assert.equal(submit(dialog).disabled,false);assert.equal(checkbox(dialog,2).disabled,true);
  await dialog.escape();assert.equal(await completion,false);
});

test("admin override cannot proceed after permission changes while waiting for saves",async()=>{
  const f=fixture({admin:true});f.groups[0].incomplete=1;
  const {dialog,completion}=await open(f),save=deferred();
  f.context.boxSaveInFlight.add(save.promise);
  const request=dialog.click("[data-submit]");await tick();
  f.context.isAdmin=false;save.resolve(true);await request;
  assert.equal(f.confirms.length,1);assert.equal(f.writes().length,0);assert.match(error(dialog),/管理者/);
  assert.equal(submit(dialog).disabled,true);await dialog.escape();assert.equal(await completion,false);
});

test("session switch during role loading, save draining or preview cannot open a dialog",async t=>{
  for(const phase of ["role","saves","preview"])await t.test(phase,async()=>{
    const gate=deferred();
    const f=fixture({loadRole:phase==="role"?()=>gate.promise:undefined,preview:phase==="preview"?()=>gate.promise:undefined});
    if(phase==="saves")f.context.orderLineSaveQueues.set("line",gate.promise);
    const completion=f.context.openSalesImporterFinalization();await tick();f.context.currentSessionId="work-2";
    gate.resolve(phase==="preview"?{data:clone(f.preview)}:true);
    assert.equal(await completion,false);assert.equal(f.document.dialogs.length,0);assert.equal(f.writes().length,0);
    assert.match(f.alerts[0],/作業が切り替わった/);assert.deepEqual(f.locks,[]);
    assert.equal(f.calls.length,phase==="preview"?1:0);
  });
});

test("session switch before submit or while waiting for saves prevents the write",async t=>{
  for(const waiting of [false,true])await t.test(String(waiting),async()=>{
    const f=fixture({admin:true});f.groups[0].incomplete=1;
    const {dialog,completion}=await open(f),save=deferred();let request;
    if(waiting){f.context.boxSaveInFlight.add(save.promise);request=dialog.click("[data-submit]");await tick()}
    f.context.currentSessionId="work-2";
    if(waiting){save.resolve(true);await request}else await dialog.click("[data-submit]");
    assert.equal(f.writes().length,0);assert.equal(submit(dialog).disabled,true);assert.match(error(dialog),/作業が切り替わった/);
    assert.equal(f.confirms.length,waiting?1:0);
    await dialog.escape();assert.equal(await completion,false);
  });
});

test("a response for the previous session cannot overwrite the newly selected session state",async()=>{
  const reply=deferred(),f=fixture({finalize:()=>reply.promise}),{dialog,completion}=await open(f);
  const request=dialog.click("[data-submit]");await tick();f.context.currentSessionId="work-2";
  reply.resolve({data:{session:{id:"work-1",locked:true},saved_rows:2,importer_codes:["01"],pending_importers:[]}});
  await request;assert.equal(await completion,true);
  assert.deepEqual(f.locks,[]);assert.deepEqual(f.saveStates,[]);assert.match(f.toasts[0],/Osaka/);
});

test("stale versions block retries until reopened; reopening fetches a fresh preview",async()=>{
  const f=fixture({finalize:async()=>({error:{code:"40001",message:"stale"}})}),{dialog,completion}=await open(f);
  await dialog.click("[data-submit]");assert.match(error(dialog),/開き直してください/);
  assert.equal(submit(dialog).disabled,true);assert.equal(dialog.querySelector("[data-close]").disabled,false);
  await dialog.click("[data-submit]");assert.equal(f.writes().length,1);assert.deepEqual(f.locks,[]);
  await dialog.escape();assert.equal(await completion,false);
  f.preview.version="version-2";const reopened=await open(f);await reopened.dialog.click("[data-submit]");
  assert.equal(f.writes()[1].args.p_expected_version,"version-2");
  await reopened.dialog.escape();assert.equal(await reopened.completion,false);
});

test("ordinary submission errors allow retry while keeping finalized rows disabled",async()=>{
  const f=fixture({finalize:async()=>{throw new Error("connection failed")}}),{dialog,completion}=await open(f);
  await dialog.click("[data-submit]");assert.match(error(dialog),/connection failed/);
  assert.equal(submit(dialog).disabled,false);assert.equal(checkbox(dialog,2).disabled,true);assert.equal(shipping(dialog,2).disabled,true);
  assert.deepEqual(f.locks,[]);assert.deepEqual(f.saveStates,[]);
  await dialog.click("[data-close]");assert.equal(await completion,false);
});

test("a committed finalization cannot be submitted again if updating the surrounding UI fails",async()=>{
  const f=fixture({globals:{setSaveState(){throw new Error("UI failed")}}}),{dialog,completion}=await open(f);
  await dialog.click("[data-submit]");assert.match(error(dialog),/売上確定は完了/);
  assert.equal(submit(dialog).disabled,true);await dialog.click("[data-submit]");assert.equal(f.writes().length,1);
  await dialog.click("[data-close]");assert.equal(await completion,true);
});

test("missing or mismatched result sessions cannot report success or be retried blindly",async t=>{
  for(const data of [{},{session:{id:"work-2"},pending_importers:[]},{session:{id:"work-1"}}])await t.test(JSON.stringify(data),async()=>{
    const f=fixture({finalize:async()=>({data})}),{dialog,completion}=await open(f);
    await dialog.click("[data-submit]");assert.match(error(dialog),/結果を確認できません/);assert.equal(submit(dialog).disabled,true);
    assert.deepEqual(f.locks,[]);assert.deepEqual(f.toasts,[]);
    await dialog.escape();assert.equal(await completion,false);
  });
});

test("missing session, invalid preview, RPC errors and locked work produce no writes",async t=>{
  const cases=[
    {name:"unsaved",options:{globals:{currentSessionId:null}},message:/保存/},
    {name:"missing SQL",options:{preview:async()=>({error:{code:"PGRST202"}})},message:/SQL/},
    {name:"old SQL",options:{preview:async()=>({error:{code:"42883"}})},message:/SQL/},
    {name:"network",options:{preview:async()=>{throw new Error("offline")}},message:/offline/},
    {name:"empty",options:{preview:async()=>({data:{session:{},version:"v",groups:[]}})},message:/明細/},
    {name:"no version",options:{preview:async()=>({data:{session:{},groups:[{}]}})},message:/明細/},
    {name:"other session",options:{preview:async()=>({data:{session:{id:"work-2"},version:"v",groups:[{}]}})},message:/一致/},
    {name:"reopened correction",options:{preview:async()=>({data:{session:{id:"work-1",locked:false,finalized_at:"2026-10-21T00:00:00Z"},version:"v",groups:[{}]}})},message:/売上再確定/},
    {name:"locked",options:{preview:async()=>({data:{session:{id:"work-1",locked:true},version:"v",groups:[{}]}})},locked:true}
  ];
  for(const item of cases)await t.test(item.name,async()=>{
    const f=fixture(item.options);assert.equal(await f.context.openSalesImporterFinalization(),false);
    assert.equal(f.writes().length,0);assert.equal(f.document.dialogs.length,0);
    if(item.locked){assert.equal(f.locks[0].locked,true);assert.match(f.toasts[0],/すでに売上確定済み/)}
    else assert.match(f.alerts[0],item.message);
  });
});

test("server-provided labels and shipping values are escaped in dialog markup",async()=>{
  const f=fixture();f.groups[0].importer_name='<img src=x onerror="bad()">';f.groups[0].shipping='" onfocus="bad()';
  f.preview.session.name="<script>bad()</script>";
  const {dialog,completion}=await open(f);
  assert.doesNotMatch(dialog.innerHTML,/<img|<script|value="" onfocus=/);
  assert.match(dialog.innerHTML,/&lt;img/);assert.match(dialog.innerHTML,/&quot; onfocus=&quot;/);
  await dialog.escape();assert.equal(await completion,false);
});

function indexSection(start,end,{last=false}={}){
  const from=last?app.lastIndexOf(start):app.indexOf(start),to=app.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,`Missing index integration section: ${start}`);
  return app.slice(from,to);
}

class LockControl extends Control{
  constructor(tag,attributes={},children=[]){
    super(tag,attributes);this.children=children;this.style={};
    for(const child of children)child.parent=this;
  }
  matches(selector){
    const descendant=selector.match(/^(\.[\w-]+) (\w+)$/);
    if(descendant)return this.tagName===descendant[2]&&!!this.parent?.closest(descendant[1]);
    return super.matches(selector);
  }
  closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null}
  descendants(){return this.children.flatMap(child=>[child,...child.descendants()])}
  querySelector(selector){return this.descendants().find(child=>child.matches(selector))||null}
  removeAttribute(name){delete this.attributes[name];delete this[name]}
}

function indexFixture(options={}){
  const f=fixture(options),c=f.context;
  Object.assign(c,{
    currentSessionLocked:false,currentSessionProvisionalLocked:false,currentSessionFinalizedAt:"",
    currentSessionFinalizedImporters:[],salesFinalizeInProgress:false,
    importerDisplayNames:{"01":"DIM","03":"FBI","08":"EN"},
    rows:[{_idx:0,importer_id:"01-DIM"},{_idx:1,importer_code:"03",importer_id:"03-FBI"}],
    activeCountry:"01",activeImporter:"03"
  });
  const controls={},tableRows=[];
  const control=(name,tag,attributes,children)=>controls[name]=new LockControl(tag,attributes,children);
  for(const [prefix,index,imp] of [["finalized",0,"01-DIM"],["pending",1,"03-FBI"]]){
    const fields=[
      control(`${prefix}Qty`,"input",{class:"inline-work-input","data-row-idx":String(index)}),
      control(`${prefix}BoxNumber`,"input",{class:"inline-box-input","data-row-idx":String(index)}),
      control(`${prefix}Price`,"input",{class:"p15-input","data-row-idx":String(index)}),
      control(`${prefix}Stockout`,"button",{class:"btn-stockout"}),
      control(`${prefix}Reset`,"button",{class:"btn-reset"}),
      control(`${prefix}Undo`,"button",{class:"btn-undo"}),
      control(`${prefix}Product`,"button",{class:"work-product-edit"}),
      control(`${prefix}Touch`,"td",{class:"touch-input-cell"})
    ];
    tableRows.push(new LockControl("tr",{},fields));
    tableRows.push(new LockControl("tr",{"data-row-idx":String(index)},[
      control(`${prefix}RowDataset`,"button",{class:"btn-stockout"})
    ]));
    const dry=control(`${prefix}DryIce`,"input",{type:"checkbox"});
    tableRows.push(new LockControl("tr",{},[
      control(`${prefix}Gross`,"input",{class:"inline-work-input","data-imp":imp,"data-box":"1","data-box-field":"gross"}),
      control(`${prefix}BoxSize`,"select",{class:"box-size-select"}),
      new LockControl("label",{class:"di-toggle"},[dry])
    ]));
  }
  const add=control("add","button",{class:"btn"});add.textContent="追加オーダー";
  const finalizeButton=control("finalize","button",{id:"finalize-btn"});
  const dom=[...tableRows.flatMap(row=>[row,...row.descendants()]),add,finalizeButton];
  f.document.querySelectorAll=selector=>selector==="#cloud-save-bar .btn"?[add]:
    dom.filter(el=>selector.split(",").some(part=>el.matches(part)));
  f.document.getElementById=id=>dom.find(el=>el.attributes.id===id)||null;
  vm.runInContext([
    indexSection("function countryCode(id)","function workImporterKey("),
    indexSection("function normalizeImporterCode(value)","function importerContractCodes("),
    indexSection("function invoiceImporterCode(value)","function pendingInvoiceReference("),
    indexSection("function setSessionLockStateTrial(session)","async function setProvisionalLockTrial(")
  ].join("\n"),c);
  return {...f,controls,tableRows};
}

test("index loads the importer dialog and scoped edit checks use actual normalization and session state",()=>{
  assert.match(app,/<script\b[^>]*src="\.\/sales-finalize-importers\.js(?:\?[^"]*)?"[^>]*defer/);
  const f=indexFixture(),c=f.context;
  c.setSessionLockStateTrial({locked:false,finalized_importer_codes:["01"]});
  for(const scope of ["01","01-DIM","ＤＩＭ",{importer_code:"01"},{importer_id:"01-DIM"},{country:"DIM"}]){
    assert.equal(c.workImporterFinalizedTrial(scope),true,JSON.stringify(scope));
    assert.equal(c.requireEditableTrial(scope),false,JSON.stringify(scope));
  }
  for(const scope of ["03","FBI",c.rows[1],{importer_code:"03",importer_id:"01",country:"DIM"},undefined]){
    assert.equal(c.requireEditableTrial(scope),true,JSON.stringify(scope));
  }
  c.isAdmin=true;
  assert.equal(c.requireEditableTrial(c.rows[0]),false,"admin edits still use the correction workflow");
  assert.match(c.lockBadgeHtml(),/一部確定/);
  c.setSessionLockStateTrial({locked:false});
  assert.equal(c.requireEditableTrial(c.rows[0]),true,"a fresh session clears importer locks");
  assert.deepEqual(clone(c.currentSessionFinalizedImporters),[]);
});

test("actual applyLockToInputsTrial locks mixed finalized rows and boxes while pending controls stay editable",()=>{
  const f=indexFixture(),c=f.context;
  c.setSessionLockStateTrial({locked:false,finalized_importer_codes:["01"]});
  for(const [name,control] of Object.entries(f.controls)){
    if(name.startsWith("finalized")){
      assert.equal(control.disabled,true,name);assert.match(control.title,/売上確定済み/,name);
    }else assert.equal(control.disabled,false,name);
  }
  f.controls.pendingBoxNumber.dataset.boxRoutingBlocked="true";
  f.controls.pendingQty.dataset.stockout="true";
  c.applyLockToInputsTrial();
  assert.equal(f.controls.pendingBoxNumber.disabled,true);
  assert.equal(f.controls.pendingQty.disabled,true);
  assert.equal(f.controls.pendingPrice.disabled,false);
  assert.equal(f.controls.pendingGross.disabled,false);
  assert.equal(f.controls.pendingDryIce.disabled,false);
  c.setSessionLockStateTrial({locked:false,finalized_importer_codes:[]});
  assert.equal(f.controls.finalizedQty.disabled,false);assert.equal(f.controls.finalizedQty.title,undefined);
  assert.equal(f.controls.finalizedBoxSize.disabled,false);assert.equal(f.controls.finalizedDryIce.disabled,false);
  assert.equal(f.controls.pendingQty.disabled,true,"stockout remains disabled after importer unlock");
  assert.equal(f.controls.pendingBoxNumber.disabled,true,"routing restrictions survive importer unlock");
});

test("global and provisional locks still override importer editability, including additional orders",()=>{
  const f=indexFixture(),c=f.context;
  for(const state of [{locked:true},{locked:false,provisional_locked:true}]){
    c.setSessionLockStateTrial({...state,finalized_importer_codes:["01"]});
    for(const [name,control] of Object.entries(f.controls)){
      if(name!=="finalize")assert.equal(control.disabled,true,name);
    }
    assert.equal(c.requireEditableTrial("03"),false);assert.equal(c.requireEditableTrial(),false);
    assert.match(f.controls.pendingGross.title,state.locked?/売上確定済み/:/仮締め中/);
  }
  c.setSessionLockStateTrial({locked:false,finalized_importer_codes:["01"]});
  assert.equal(f.controls.add.disabled,false);assert.equal(f.controls.pendingQty.disabled,false);
  assert.equal(f.controls.finalizedQty.disabled,true);
});

test("dialog success applies the actual index lock state without freezing pending importer fields",async()=>{
  const f=indexFixture(),{dialog,completion}=await open(f);
  assert.equal(f.controls.finalizedQty.disabled,false);
  await dialog.click("[data-submit]");assert.equal(await completion,true);
  assert.deepEqual(clone(f.context.currentSessionFinalizedImporters),["01","08"]);
  assert.equal(f.context.currentSessionLocked,false);
  assert.equal(f.controls.finalizedQty.disabled,true);assert.equal(f.controls.finalizedGross.disabled,true);
  assert.equal(f.controls.finalizedBoxSize.disabled,true);assert.equal(f.controls.finalizedDryIce.disabled,true);
  assert.equal(f.controls.pendingQty.disabled,false);assert.equal(f.controls.pendingGross.disabled,false);
  assert.equal(f.controls.pendingBoxSize.disabled,false);assert.equal(f.controls.pendingDryIce.disabled,false);
  assert.equal(f.controls.add.disabled,false);assert.equal(f.controls.finalize.disabled,false);
});

test("actual index save and row-action wrappers reject finalized scopes and preserve pending work",async()=>{
  const f=indexFixture(),c=f.context,calls=[],boxReply=deferred();
  const spy=name=>(...args)=>{calls.push({name,args});return true};
  Object.assign(c,{
    saveAllBoxesToSupabase:async()=>true,
    saveOrderLineToSupabase:spy("line"),saveBoxToSupabase:(...args)=>{calls.push({name:"box",args});return boxReply.promise},
    renderP1Cell:spy("renderP1"),renderP2Importer:spy("renderP2"),addManualOrder:spy("add"),
    executeStockout:spy("stockout"),undoStockout:spy("undo"),resetP1Row:spy("reset"),pendingStockoutIdx:0
  });
  vm.runInContext(indexSection("const __saveOrderLineLockBase=","const __resetLocalStateLockBase="),c);
  c.setSessionLockStateTrial({locked:false,finalized_importer_codes:["01"]});
  assert.equal(await c.saveOrderLineToSupabase(c.rows[0]),false);
  assert.equal(await c.saveBoxToSupabase("DIM","1"),false);
  c.executeStockout();c.undoStockout(0);c.resetP1Row(0);assert.equal(calls.length,0);
  assert.equal(await c.saveOrderLineToSupabase(c.rows[1]),true);
  const saving=c.saveBoxToSupabase("FBI","1");assert.equal(c.boxSaveInFlight.size,1);
  boxReply.resolve(true);assert.equal(await saving,true);assert.equal(c.boxSaveInFlight.size,0);
  c.pendingStockoutIdx=1;c.executeStockout();c.undoStockout(1);c.resetP1Row(1);c.addManualOrder();
  assert.deepEqual(calls.map(call=>call.name),["line","box","stockout","undo","reset","add"]);
  assert.equal(calls[0].args[0],c.rows[1]);assert.deepEqual(calls[1].args,["FBI","1"]);
  f.controls.finalizedQty.disabled=false;c.renderP1Cell("01","customer");assert.equal(f.controls.finalizedQty.disabled,true);
  f.controls.finalizedGross.disabled=false;c.renderP2Importer("01");assert.equal(f.controls.finalizedGross.disabled,true);
  assert.equal(f.controls.pendingGross.disabled,false);
});

function finalOverrideFixture(options={}){
  const f=indexFixture(),c=f.context,routeCalls=[],readCalls=[];
  const latest={locked:false,status:"active",finalized_at:null,finalized_importer_codes:["01"],...options.latest};
  const unexpected=name=>()=>assert.fail(`Unexpected global write or prompt: ${name}`);
  Object.assign(c,{
    checkSalesLockSetupTrial:async()=>true,
    saveCurrentSessionToSupabase:unexpected("saveCurrentSessionToSupabase"),
    upsertSalesRecordsTrial:unexpected("upsertSalesRecordsTrial"),
    syncFinalizedSessionToReceivables:unexpected("syncFinalizedSessionToReceivables"),
    refreshCurrentSessionFromSupabase:unexpected("refreshCurrentSessionFromSupabase"),
    confirmOutstandingExternalWorkBeforeSales:unexpected("confirmOutstandingExternalWorkBeforeSales"),
    salesShippingFeesPromptValue:unexpected("salesShippingFeesPromptValue"),
    confirm:unexpected("confirm"),
    openSalesImporterFinalization:async()=>{routeCalls.push("initial");return options.result?options.result():false},
    openSalesRefinalization:async()=>{routeCalls.push("refinalize");return false},
    supabaseClient:{
      from(table){assert.equal(table,"work_sessions");return {
        select(columns){readCalls.push(columns);return this},
        eq(key,value){assert.equal(key,"id");assert.equal(value,"work-1");return this},
        async maybeSingle(){return options.read?options.read():{data:clone(latest)}}
      }},
      rpc:unexpected("RPC before dialog")
    }
  });
  const override=indexSection("finalizeSalesTrial=async function(){","function sessionListStatusLabelTrial(",{last:true});
  vm.runInContext(override,c);
  return {...f,override,routeCalls,readCalls};
}

test("final index override routes initial and reopened work without any global row upsert or shipping prompts",async t=>{
  for(const [name,latest,route] of [
    ["new",{finalized_importer_codes:[]},"initial"],
    ["partial",{finalized_importer_codes:["01"]},"initial"],
    ["reopened",{finalized_at:"2026-10-21T00:00:00Z",finalized_importer_codes:[]},"refinalize"]
  ])await t.test(name,async()=>{
    const f=finalOverrideFixture({latest});
    assert.doesNotMatch(f.override,/upsertSalesRecordsTrial|salesRecordPayloadTrial|finalize_export_revenue_route|syncFinalizedSessionToReceivables|salesShippingFeesPromptValue/);
    assert.equal(await f.context.finalizeSalesTrial(),false);
    assert.deepEqual(f.routeCalls,[route]);assert.equal(f.readCalls.length,1);
    assert.match(f.readCalls[0],/finalized_importer_codes/);
    assert.equal(f.context.salesFinalizeInProgress,false);assert.equal(f.controls.finalize.disabled,false);
  });
});

test("final index override stays busy until dialog completion and stops on a switched session or locked result",async t=>{
  await t.test("busy",async()=>{
    const reply=deferred(),f=finalOverrideFixture({result:()=>reply.promise});
    const first=f.context.finalizeSalesTrial();await tick();
    assert.equal(f.context.salesFinalizeInProgress,true);assert.equal(f.controls.finalize.disabled,true);
    assert.equal(await f.context.finalizeSalesTrial(),false);assert.deepEqual(f.routeCalls,["initial"]);
    reply.resolve(true);assert.equal(await first,true);
    assert.equal(f.context.salesFinalizeInProgress,false);assert.equal(f.controls.finalize.disabled,false);
  });
  await t.test("session switch",async()=>{
    const reply=deferred(),f=finalOverrideFixture({read:()=>reply.promise});
    const result=f.context.finalizeSalesTrial();await tick();f.context.currentSessionId="work-2";
    reply.resolve({data:{locked:true,finalized_importer_codes:["01"]}});
    assert.equal(await result,false);assert.deepEqual(f.routeCalls,[]);assert.equal(f.context.currentSessionLocked,false);
    assert.match(f.alerts[0],/作業が切り替わった/);assert.equal(f.context.salesFinalizeInProgress,false);
  });
  await t.test("locked",async()=>{
    const f=finalOverrideFixture({latest:{locked:true,status:"closed"}});
    assert.equal(await f.context.finalizeSalesTrial(),false);assert.deepEqual(f.routeCalls,[]);
    assert.equal(f.controls.finalize.disabled,true);assert.equal(f.context.salesFinalizeInProgress,false);
  });
});
