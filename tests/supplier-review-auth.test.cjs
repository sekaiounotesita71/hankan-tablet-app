const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");

const html=fs.readFileSync(path.join(__dirname,"..","order-entry-beta.html"),"utf8");
function source(start,end){
  const from=html.indexOf(start),to=html.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from);
  return html.slice(from,to);
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const user={id:"internal-user"};
const signedIn={data:{session:{user}},error:null};
function setup({session=async()=>signedIn,rpc=async()=>({data:[{line_id:"line-1"}],error:null}),clientMissing=false}={}){
  const elements=Object.fromEntries(["supplier-review-list","supplier-review-summary","supplier-review-tabs","supplier-review-date","supplier-review-status"].map(id=>[id,{innerHTML:"",value:""}]));
  elements["supplier-review-date"].value="2026-09-24";
  elements["supplier-review-status"].value="unordered";
  const calls=[];
  const client={auth:{getSession:session},rpc:async(name,args)=>{calls.push({name,args});return rpc(name,args)}};
  const ctx={dbReady:false,currentUser:null,supabaseClient:null,supplierReviewLoadRequest:0,supplierReviewRows:[],supplierReviewGroups:[],renders:0,
    document:{getElementById:id=>elements[id]},val:id=>elements[id]?.value||"",initSupabase:()=>clientMissing?null:client,
    updateAuthStatus:()=>{},renderSupplierReviewBoard:()=>{ctx.renders++},
    esc:value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")};
  vm.runInNewContext(source("function supplierReviewDbError(","function supplierReviewVisibleRows("),ctx);
  vm.runInNewContext(source("async function loadSupplierReviewBoard(","function loadAllUnorderedSupplierReview("),ctx);
  return {ctx,elements,calls};
}

test("direct board entry waits for session restoration and does not require the full DB preload",async()=>{
  const pending=deferred();const {ctx,elements,calls}=setup({session:()=>pending.promise});
  const loading=ctx.loadSupplierReviewBoard();
  assert.equal(calls.length,0);
  assert.match(elements["supplier-review-summary"].innerHTML,/認証を確認中/);
  pending.resolve(signedIn);await loading;
  assert.equal(ctx.dbReady,false);
  assert.equal(ctx.currentUser.id,user.id);
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,"list_order_supplier_review");
  assert.equal(calls[0].args.p_order_date,"2026-09-24");
  assert.equal(ctx.renders,1);
  assert.equal(ctx.supplierReviewRows.length,1);
});

test("a signed-out session does not request protected rows or keep old rows and tabs",async()=>{
  const {ctx,elements,calls}=setup({session:async()=>({data:{session:null},error:null})});
  ctx.supplierReviewRows=[{line_id:"old"}];ctx.supplierReviewGroups=[{}];elements["supplier-review-tabs"].innerHTML="old";
  await ctx.loadSupplierReviewBoard();
  assert.equal(calls.length,0);assert.equal(ctx.renders,0);
  assert.equal(ctx.supplierReviewRows.length,0);assert.equal(ctx.supplierReviewGroups.length,0);
  assert.equal(elements["supplier-review-tabs"].innerHTML,"");
  assert.match(elements["supplier-review-summary"].innerHTML,/ログイン後/);
});

test("session errors are shown instead of a misleading missing-SQL or signed-out message",async()=>{
  const {ctx,elements,calls}=setup({session:async()=>({data:null,error:{code:"PGRST301",message:"JWT expired"}})});
  await ctx.loadSupplierReviewBoard();
  assert.equal(calls.length,0);
  assert.match(elements["supplier-review-summary"].innerHTML,/読込失敗/);
  assert.match(elements["supplier-review-list"].innerHTML,/再ログイン/);
  assert.doesNotMatch(elements["supplier-review-list"].innerHTML,/SQL/);
});

test("network failure and denied access stay visible without changing database permissions",async()=>{
  for(const message of ["Network unavailable <retry>","Internal access is required."]){
    const {ctx,elements}=setup({rpc:async()=>({data:null,error:{message}})});
    await ctx.loadSupplierReviewBoard();
    assert.equal(ctx.renders,0);
    assert.match(elements["supplier-review-summary"].innerHTML,/読込失敗/);
    assert.match(elements["supplier-review-list"].innerHTML,message.startsWith("Network")?/&lt;retry&gt;/:/権限がありません/);
  }
});

test("the board can retry successfully after a failed request",async()=>{
  let failed=true;const {ctx,elements}=setup({rpc:async()=>{if(failed)throw new Error("offline");return {data:[{line_id:"recovered"}]}}});
  await ctx.loadSupplierReviewBoard();assert.match(elements["supplier-review-list"].innerHTML,/offline/);
  failed=false;await ctx.loadSupplierReviewBoard();
  assert.equal(ctx.supplierReviewRows[0].line_id,"recovered");assert.equal(ctx.renders,1);
});

test("a slower earlier date response cannot overwrite a newer request",async()=>{
  const old=deferred(),entered=deferred();
  const {ctx,elements}=setup({rpc:async(name,args)=>{if(args.p_order_date==="2026-09-24"){entered.resolve();return old.promise}return {data:[{line_id:"new"}]}}});
  const first=ctx.loadSupplierReviewBoard();await entered.promise;
  elements["supplier-review-date"].value="2026-09-25";await ctx.loadSupplierReviewBoard();
  old.resolve({data:[{line_id:"old"}]});await first;
  assert.equal(ctx.supplierReviewRows[0].line_id,"new");assert.equal(ctx.renders,1);
});

test("a superseded failed request cannot replace a successful newer result",async()=>{
  const old=deferred(),entered=deferred();let first=true;
  const {ctx,elements}=setup({rpc:async()=>{if(first){first=false;entered.resolve();return old.promise}return {data:[{line_id:"new"}]}}});
  const pending=ctx.loadSupplierReviewBoard();await entered.promise;await ctx.loadSupplierReviewBoard();
  old.resolve({error:{message:"stale failure"}});await pending;
  assert.equal(ctx.supplierReviewRows[0].line_id,"new");assert.doesNotMatch(elements["supplier-review-list"].innerHTML,/stale failure/);
});

test("an in-flight response cannot render after logout or account switch",async()=>{
  for(const nextUser of [null,{id:"different-user"}]){
    const pending=deferred(),entered=deferred();
    const {ctx}=setup({rpc:async()=>{entered.resolve();return pending.promise}});
    const loading=ctx.loadSupplierReviewBoard();await entered.promise;ctx.currentUser=nextUser;
    pending.resolve({data:[{line_id:"previous-user-data"}]});await loading;
    assert.equal(ctx.renders,0);assert.equal(ctx.supplierReviewRows.length,0);
  }
});

test("no-date searches keep the existing unordered-only rule",async()=>{
  const {ctx,elements,calls}=setup();elements["supplier-review-date"].value="";elements["supplier-review-status"].value="";
  await ctx.loadSupplierReviewBoard();
  assert.equal(calls[0].args.p_order_date,null);assert.equal(calls[0].args.p_only_unordered,true);
  assert.equal(elements["supplier-review-status"].value,"unordered");
});

test("missing SDK is a service-load failure, not a successful login check",async()=>{
  const {ctx,elements,calls}=setup({clientMissing:true});await ctx.loadSupplierReviewBoard();
  assert.equal(calls.length,0);assert.match(elements["supplier-review-list"].innerHTML,/認証サービスを読み込めません/);
});
