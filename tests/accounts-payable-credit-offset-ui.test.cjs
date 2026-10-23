const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const Report=require('../accounting-period-report.js');
const html=fs.readFileSync(path.join(__dirname,'..','order-entry-beta.html'),'utf8');
const extract=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
function context(){
  const nodes={},storage=new Map(),alerts=[],calls=[];
  const node=id=>nodes[id]||(nodes[id]={_value:'',get value(){return this._value},set value(v){this._value=String(v)},textContent:'',readOnly:false,focus(){},replaceChildren(text){this.textContent=text}});
  const c={nodes,storage,alerts,calls,console,crypto:{randomUUID},currentUser:{id:'admin'},payablePaymentSaving:false,payablePaymentAttempt:null,payablePaymentClosingId:'',payablePayments:[],
    payableRows:[{id:'positive',supplier_code:'16',invoice_date:'2026-09-24',amount_jpy:878877,tax_amount_jpy:65102,source_type:'purchase',closing_id:'close'},
      {id:'credit',supplier_code:'16',invoice_date:'2026-09-24',amount_jpy:-2754,tax_amount_jpy:-204,source_type:'purchase',closing_id:'close'}],
    payableClosings:[{id:'close',supplier_code:'16',period_from:'2026-09-01',period_to:'2026-09-30',status:'closed'}],
    arNumber:v=>Number(v)||0,arRound:v=>Math.round(Number(v)*100)/100,today:()=> '2026-10-23',
    val:id=>node(id).value,document:{getElementById:node,querySelector:()=>node('save'),createTextNode:t=>t},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    alert:t=>alerts.push(t),confirm:()=>true,esc:String,salesRefMoney:v=>Number(v).toLocaleString('ja-JP'),
    lookupSupplierByCode:()=>({name:'たかくわ'}),currentUserIsAdmin:()=>true,
    ensureCurrentUser:async()=>c.currentUser,setAppBusy:()=>{},renderPayables:()=>{},renderPayableClosingHistory:()=>{},
    loadPayables:async()=>{},apDbErrorMessage:e=>e.message||String(e),
    initSupabase:()=>({rpc:async(name,args)=>{calls.push({name,args:{...args}});return {data:{},error:null}}})};
  vm.createContext(c);
  vm.runInContext(extract('function apSameSupplier(','async function apReadSupplierProfiles('),c);
  vm.runInContext(extract('function apRecordState(','function apFilteredRows('),c);
  vm.runInContext(extract('function selectPayableForPayment(','async function deletePayable(id)'),c);
  c.renderPayablePaymentHistory=()=>{};
  node('ap-payment-date').value='2026-10-23';node('ap-payment-fee').value='0';
  return c;
}
test('signed balance, credit status and closing target display the net amount',()=>{
  const c=context();c.selectPayableClosingForPayment('close');
  assert.equal(c.apClosingCurrentBalance(c.payableClosings[0]),876123);
  assert.equal(c.nodes['ap-payment-amount'].value,'876123');
  assert.match(c.nodes['ap-payment-target'].textContent,/赤伝等相殺 ¥2,754/);
  assert.equal(c.apRecordState(c.payableRows[1]).label,'赤伝・相殺待ち');
  c.selectPayableForPayment('positive');assert.equal(c.nodes['ap-payment-closing-id'].value,'close');
  c.payablePayments=[{payable_id:'positive',amount_jpy:876123},{payable_id:'positive',amount_jpy:0,credit_offset_jpy:2754},{payable_id:'credit',amount_jpy:0,credit_offset_jpy:-2754}];
  assert.equal(c.apClosingCurrentBalance(c.payableClosings[0]),0);
  assert.equal(c.apRecordState(c.payableRows[1]).label,'相殺済');
  assert.equal(c.apRecordState(c.payableRows[0]).paid,876123);
  assert.equal(c.apNetBalance(c.payableRows[1]).net,0);
});
test('double click is guarded before authentication resolves',async()=>{
  const c=context();c.selectPayableClosingForPayment('close');
  let resume;c.ensureCurrentUser=()=>new Promise(r=>{resume=r});
  const first=c.savePayablePayment();await c.savePayablePayment();
  assert.equal(c.payablePaymentSaving,true);resume(c.currentUser);await first;
  assert.equal(c.calls.length,1);assert.equal(c.calls[0].name,'register_accounts_payable_net_payment');
  assert.equal(c.calls[0].args.p_amount_jpy,876123);assert.equal(c.payablePaymentSaving,false);
  assert.equal(c.storage.size,0);
});
test('uncertain network outcome retries the same immutable request and survives reload',async()=>{
  const c=context();c.selectPayableClosingForPayment('close');
  c.initSupabase=()=>({rpc:async(name,args)=>{c.calls.push({name,args:{...args}});throw Error('network')}});
  await c.savePayablePayment();
  const pending=JSON.parse(JSON.stringify(c.payablePaymentAttempt));
  assert.ok(pending.p_request_id);assert.equal(c.nodes['ap-payment-amount'].readOnly,true);
  c.clearPayablePaymentForm();assert.equal(c.nodes['ap-payment-closing-id'].value,'close');
  c.payablePaymentAttempt=null;c.restorePayablePaymentAttempt();
  assert.equal(c.payablePaymentAttempt.p_request_id,pending.p_request_id);
  c.initSupabase=()=>({rpc:async(name,args)=>{c.calls.push({name,args:{...args}});return {error:null}}});
  await c.savePayablePayment();
  assert.deepEqual(c.calls[0].args,c.calls[1].args);
  assert.equal(c.storage.size,0);assert.equal(c.payablePaymentAttempt,null);
});
test('validation rejects gross amount and invalid input; zero cash is allowed for real offsets',async()=>{
  const c=context();c.selectPayableClosingForPayment('close');
  c.nodes['ap-payment-amount'].value='878877';await c.savePayablePayment();assert.equal(c.calls.length,0);
  c.nodes['ap-payment-amount'].value='invalid';await c.savePayablePayment();assert.equal(c.calls.length,0);
  c.payableRows[0].amount_jpy=100;c.payableRows[1].amount_jpy=-200;
  c.selectPayableClosingForPayment('close');assert.equal(c.nodes['ap-payment-amount'].value,'0');
  await c.savePayablePayment();assert.equal(c.calls[0].args.p_amount_jpy,0);
});
test('single invoice history deletion routes the whole payment/offset group to RPC',async()=>{
  const c=context();c.payablePayments=[{id:'offset',payment_group_id:'g',payable_id:'credit',credit_offset_jpy:-2754}];
  await c.deletePayablePayment('offset');
  assert.equal(c.calls[0].name,'cancel_accounts_payable_payment_group');
  assert.equal(c.calls[0].args.p_group_id,'g');
});
test('AP reports show cash, signed offsets and as-of balances without double-counting',()=>{
  const records=[{id:'a',code:'16',date:'2026-09-24',amount:1000,tax:0,taxKnown:true},
    {id:'b',code:'16',date:'2026-09-24',amount:-200,tax:0,taxKnown:true}];
  const payments=[{id:'cash',recordId:'a',date:'2026-10-23',cash:800},
    {id:'off-a',recordId:'a',date:'2026-10-23',cash:0,offset:200},
    {id:'off-b',recordId:'b',date:'2026-10-23',cash:0,offset:-200}];
  const sep=Report.build({records,payments,range:{from:'2026-09-01',to:'2026-09-30'},kind:'ap'});
  assert.equal(sep.totals.balance,800);assert.equal(sep.totals.cash,0);
  const oct=Report.build({records,payments,range:{from:'2026-10-01',to:'2026-10-31'},kind:'ap'});
  assert.equal(oct.totals.cash,800);assert.equal(oct.totals.offset,0);assert.equal(oct.totals.balance,0);
  assert.equal(oct.items[0].events.filter(e=>e.type==='相殺').length,2);
  const onlyDebit=Report.build({records:records.slice(0,1),payments,range:{from:'2026-10-01',to:'2026-10-31'},kind:'ap'});
  assert.equal(onlyDebit.totals.balance,0);
});
