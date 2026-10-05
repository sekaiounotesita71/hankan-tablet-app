const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','domestic-sales.html'),'utf8');
const customer=(code,day=31,changes={})=>({customer_code:code,customer_name:`Customer ${code}`,closing_day:day,payment_day:31,payment_month_offset:1,active:true,...changes});
const sale=(id,code,date,amount=100,changes={})=>({id,customer_code:code,invoice_date:date,amount_jpy:amount,status:'unpaid',source_type:'sale',...changes});
const closing=(id,code,from,to,changes={})=>({id,customer_code:code,period_from:from,period_to:to,status:'closed',sales_amount_jpy:100,billing_amount_jpy:100,snapshot:{charges:[{id:'s'}]},...changes});
const json=value=>JSON.parse(JSON.stringify(value));
function setup(changes={}){
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id)){
      const node={value:'',textContent:'',hidden:false,disabled:false,open:false,scrollIntoView(){this.scrolled=true}};
      Object.defineProperty(node,'innerHTML',{get(){return this.html||''},set(value){this.html=value;if(id.endsWith('-day'))this.value=''}});
      elements.set(id,node);
    }
    return elements.get(id);
  };
  get('closing-month').value='2026-09';
  const buttons=['pending','closed','all'].map(status=>({dataset:{closingQueueStatus:status},setAttribute(key,value){this[key]=value}}));
  const context={
    customers:[customer('01')],receivableRows:[],receivablePayments:[],domesticClosingRows:[],
    domesticClosingQueueCache:null,domesticClosingQueueStatus:'pending',domesticClosingLoaded:true,domesticClosingDbReady:true,domesticClosingLoadError:'',
    today:()=> '2026-10-05',value:id=>get(id).value,
    normalize:value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,''),
    esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    money:value=>Math.round(Number(value)||0).toLocaleString('ja-JP'),
    document:{getElementById:get,querySelectorAll:()=>buttons},...changes
  };
  context.findCustomer=code=>context.customers.find(row=>row.customer_code===code);
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('function domesticClosingDay('),html.indexOf('function domesticClosingPayload(')),context);
  return {c:context,get,buttons};
}

test('queue shows all customers with activity before customer selection, including paid but unclosed sales',()=>{
  const {c}=setup({customers:[customer('01'),customer('02'),customer('03')],receivableRows:[sale('a','01','2026-09-02'),sale('b','02','2026-09-06',50,{status:'paid'}),sale('c','03','2026-09-06',99,{status:'cancelled'})]});
  const rows=c.domesticClosingQueueForMonth('2026-09');
  assert.deepEqual(json(rows.map(r=>[r.customer.customer_code,r.status])),[['01','pending'],['02','pending']]);
});

test('15-day closing shows both cycles and prerequisite, then updates only the first cycle to closed',()=>{
  const {c}=setup({customers:[customer('01',15)],receivableRows:[sale('a','01','2026-09-10'),sale('b','01','2026-09-16',200)]});
  let rows=c.domesticClosingQueueForMonth('2026-09');
  assert.deepEqual(json(rows.map(r=>[r.range.from,r.range.to,r.status])),[['2026-09-01','2026-09-15','pending'],['2026-09-16','2026-09-30','blocked']]);
  assert.match(rows[1].note,/15日締め/);
  c.domesticClosingRows.push(closing('cl1','01','2026-09-01','2026-09-15'));
  rows=c.domesticClosingQueueForMonth('2026-09');
  assert.deepEqual(json(rows.map(r=>r.status)),['closed','pending']);
});

test('10-day terms expose all three periods and no aggregate row hides a missing cycle',()=>{
  const {c}=setup({customers:[customer('01',10)],receivableRows:[sale('a','01','2026-09-02'),sale('b','01','2026-09-13'),sale('c','01','2026-09-27')]});
  const rows=c.domesticClosingQueueForMonth('2026-09');
  assert.deepEqual(json(rows.map(r=>r.closingDay)),[10,20,31]);
  assert.equal(rows.filter(r=>r.status==='closed').length,0);
});

test('closed rows use frozen invoice amounts, even when current receivables differ',()=>{
  const {c}=setup({receivableRows:[sale('a','01','2026-09-02',999)],domesticClosingRows:[closing('cl','01','2026-09-01','2026-09-30',{sales_amount_jpy:123,billing_amount_jpy:456})]});
  const [row]=c.domesticClosingQueueForMonth('2026-09');
  assert.equal(row.status,'closed');assert.equal(row.sales,123);assert.equal(row.total,456);assert.equal(row.saleCount,1);
});

test('reopened closing returns to pending instead of disappearing in history',()=>{
  const {c}=setup({receivableRows:[sale('a','01','2026-09-02')],domesticClosingRows:[closing('cl','01','2026-09-01','2026-09-30',{status:'reopened'})]});
  assert.equal(c.domesticClosingQueueForMonth('2026-09')[0].status,'pending');
});

test('closed monthly invoice is shown once if master terms later change to 15 days',()=>{
  const {c}=setup({customers:[customer('01',15)],receivableRows:[sale('a','01','2026-09-02')],domesticClosingRows:[closing('cl','01','2026-09-01','2026-09-30')]});
  const rows=c.domesticClosingQueueForMonth('2026-09');
  assert.equal(rows.length,1);assert.equal(rows[0].status,'closed');assert.equal(rows[0].range.to,'2026-09-30');
});

test('partial overlap is flagged, not shown as a fully closed month',()=>{
  const {c}=setup({receivableRows:[sale('a','01','2026-09-02'),sale('b','01','2026-09-20')],domesticClosingRows:[closing('cl','01','2026-09-01','2026-09-15')]});
  const rows=c.domesticClosingQueueForMonth('2026-09');
  assert.equal(rows.filter(r=>r.status==='blocked').length,1);
  assert.equal(rows.filter(r=>r.status==='closed').length,1);
});

test('inactive and orphan customers with open balances stay visible as blocked',()=>{
  const {c}=setup({customers:[customer('01',31,{active:false})],receivableRows:[sale('a','01','2026-09-02'),sale('b','MISSING','2026-09-02')]});
  const rows=c.domesticClosingQueueForMonth('2026-09');
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='blocked'));
  assert.match(rows[1].note,/未登録/);
});

test('previous-month omissions remain visible independently of the current month and filters',()=>{
  const {c,get}=setup({receivableRows:[sale('a','01','2026-08-05')],customers:[customer('01')]});
  const data=c.domesticClosingQueueData('2026-09');
  assert.deepEqual(json(data.older),[{month:'2026-08',count:1}]);
  get('closing-queue-customer').value='no-match';c.renderDomesticClosingQueue();
  assert.equal(get('closing-overdue').hidden,false);
  assert.match(get('closing-overdue').innerHTML,/2026-08：1件/);
});

test('opening baseline does not create missed pre-operation invoices; settled months do not create carryover-only invoices',()=>{
  const {c}=setup({receivableRows:[sale('opening','01','2026-07-31',1000,{source_type:'opening'}),sale('a','01','2026-08-05')],receivablePayments:[{id:'p',receivable_id:'opening',payment_date:'2026-08-31',amount_jpy:1100}],domesticClosingRows:[closing('cl','01','2026-08-01','2026-08-31')]});
  const data=c.domesticClosingQueueData('2026-09');
  assert.deepEqual(json(data.older),[]);assert.equal(data.rows.length,0);
});

test('unclosed carryover is not confused with unpaid status of a closed invoice',()=>{
  const {c}=setup({receivableRows:[sale('a','01','2026-08-05',1000)],domesticClosingRows:[closing('cl','01','2026-08-01','2026-08-31',{billing_amount_jpy:1000})]});
  const data=c.domesticClosingQueueData('2026-09');
  assert.deepEqual(json(data.older),[]);
  assert.equal(data.rows[0].status,'pending');assert.equal(data.rows[0].snapshot.carryover,1000);
});

test('future period is identified as not yet due, not a historical omission',()=>{
  const {c}=setup({receivableRows:[sale('a','01','2026-10-03')]});
  assert.equal(c.domesticClosingQueueForMonth('2026-10')[0].status,'upcoming');
});

test('indexed and individual previews use identical amounts and date boundaries',()=>{
  const {c}=setup({receivableRows:[sale('a','01','2026-08-05',1000),sale('b','01','2026-09-15',550),sale('c','01','2026-10-01',999)],receivablePayments:[{receivable_id:'a',payment_date:'2026-08-15',amount_jpy:200},{receivable_id:'b',payment_date:'2026-09-30',amount_jpy:150},{receivable_id:'unknown',payment_date:'2026-09-15',amount_jpy:123}]});
  const indexed=c.domesticClosingQueueForMonth('2026-09')[0];
  const single=c.domesticClosingCalculation(c.customers[0],'2026-09',31);
  assert.deepEqual(json(indexed.snapshot),json(single.snapshot));
  assert.equal(single.snapshot.total,1200);
});

test('status, day and customer filters show accurate counts without changing receipt inputs',()=>{
  const {c,get,buttons}=setup({customers:[customer('01'),customer('02')],receivableRows:[sale('a','01','2026-09-05'),sale('b','02','2026-09-05')],domesticClosingRows:[closing('cl','02','2026-09-01','2026-09-30')]});
  get('payment-amount').value='500';c.renderDomesticClosingQueue();
  assert.equal(get('closing-pending-count').textContent,'1');assert.equal(get('closing-closed-count').textContent,'1');
  assert.doesNotMatch(get('closing-queue-body').innerHTML,/Customer 02/);
  c.setDomesticClosingQueueStatus('closed');assert.match(get('closing-queue-body').innerHTML,/Customer 02/);
  assert.equal(buttons[1]['aria-pressed'],'true');
  get('closing-queue-customer').value='01';c.setDomesticClosingQueueStatus('all');
  assert.equal(get('closing-all-count').textContent,'1');assert.equal(get('payment-amount').value,'500');
});

test('row selection opens the correct customer and cycle without submitting anything',()=>{
  const {c,get}=setup({customers:[customer('01',15)],receivableRows:[sale('a','01','2026-09-05')]});
  c.selectDomesticClosingQueueRow('01',15);
  assert.equal(get('closing-customer').value,'01');assert.equal(get('closing-day').value,'15');
  assert.equal(get('closing-selection').open,true);assert.equal(get('close-billing-button').disabled,false);
  assert.equal(get('closing-total').textContent,'100');
  c.changeDomesticClosingMonth('2026-08');
  assert.equal(get('closing-customer').value,'');assert.equal(get('closing-selection').open,false);assert.equal(get('close-billing-button').disabled,true);
});

test('read failures and missing schema cannot display a false zero pending count',()=>{
  const {c,get}=setup({domesticClosingLoaded:false,domesticClosingLoadError:'Network failure'});
  c.renderDomesticClosingQueue();c.refreshDomesticClosingPreview();
  assert.equal(get('closing-pending-count').textContent,'-');assert.match(get('closing-queue-state').textContent,/Network failure/);assert.equal(get('close-billing-button').disabled,true);
  c.domesticClosingLoaded=true;c.domesticClosingDbReady=false;c.domesticClosingLoadError='';c.renderDomesticClosingQueue();
  assert.equal(get('closing-all-count').textContent,'-');
});

test('queue escapes customer text, defaults to last month and preserves explicit close confirmation',()=>{
  const {c,get}=setup({customers:[customer('01',31,{customer_name:'<script>bad</script>'})],receivableRows:[sale('a','01','2026-09-02')]});
  c.renderDomesticClosingQueue();assert.doesNotMatch(get('closing-queue-body').innerHTML,/<script>/);
  c.setDomesticClosingMonthPreset('previous');assert.equal(get('closing-month').value,'2026-09');
  assert.match(html,/if\(!confirm\(`/);
  assert.match(html,/rpc\("close_domestic_billing_period"/);
  assert.match(html,/domesticClosingQueueCache=null/);
  for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script[1].trim())new vm.Script(script[1]);
});
