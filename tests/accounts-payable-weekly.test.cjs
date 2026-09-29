const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'order-entry-beta.html'),'utf8');
const sql=fs.readFileSync(path.join(root,'accounts-payable-weekly-migration.sql'),'utf8');
const shift=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const profile={supplier_code:'45',payment_mode:'credit',closing_day:7,closing_anchor_date:'2026-09-26',payment_days_after_closing:6};
function context(){
  const elements={};
  const c={arNumber:Number,arShiftDate:shift,apSameSupplier:(a,b)=>a===b,
    payableSupplierProfiles:[profile],payableRows:[],payablePayments:[],payableClosings:[],payablesLoaded:true,
    arRound:n=>Math.round(n*100)/100, getMasters:()=>({suppliers:[{code:'45',name:'金芳'}]}),
    today:()=> '2026-09-29',val:id=>elements[id]?.value||'',
    document:{getElementById:id=>elements[id]||null},elements};
  const start=html.indexOf('function apClosingSnapshot('),end=html.indexOf('function renderPayableClosingDayOptions()',start);
  vm.runInNewContext(html.slice(start,end),c);
  return c;
}
test('weekly periods cross months and years, include leap days, and never reset at month end',()=>{
  const c=context();
  for(const [date,from,due] of [['2026-09-26','2026-09-20','2026-10-02'],['2026-10-03','2026-09-27','2026-10-09'],['2027-01-02','2026-12-27','2027-01-08'],['2028-03-04','2028-02-27','2028-03-10']]){
    const result=c.apWeeklyClosingCalculation({code:'45'},profile,date);
    assert.equal(result.error,'');assert.equal(result.range.from,from);assert.equal(result.range.to,date);assert.equal(result.dueDate,due);
  }
  assert.deepEqual(Array.from(c.apWeeklyDatesForMonth(profile,'2026-09')),['2026-09-05','2026-09-12','2026-09-19','2026-09-26']);
  assert.deepEqual(Array.from(c.apWeeklyDatesForMonth(profile,'2026-10')),['2026-10-03','2026-10-10','2026-10-17','2026-10-24','2026-10-31']);
  assert.equal(c.apWeeklyClosingOnOrAfter('2026-09-20','2026-09-26'),'2026-09-26');
  assert.equal(c.apWeeklyClosingOnOrAfter('2026-09-19','2026-09-26'),'2026-09-19');
  assert.equal(c.apWeeklyClosingOnOrAfter('2026-09-27','2026-09-26'),'2026-10-03');
});
test('weekly configuration and actual closing date are required, and cash stays cash',()=>{
  const c=context();
  for(const date of [null,'','2026-02-30','2026-13-01'])assert.ok(c.apWeeklyProfileError({...profile,closing_anchor_date:date}));
  for(const days of [null,undefined,'',-1,1.5,366,'x'])assert.ok(c.apWeeklyProfileError({...profile,payment_days_after_closing:days}));
  assert.equal(c.apWeeklyProfileError({...profile,payment_days_after_closing:0}),'');
  assert.ok(c.apWeeklyClosingCalculation({code:'45'},profile,'2026-09-30').error);
  assert.ok(c.apClosingCalculationFor({code:'45'},'2026-09',profile,7).error);
  assert.deepEqual(Array.from(c.apPayableClosingDays(profile)),[-7]);
  assert.equal(c.apIsWeeklyClosingProfile({...profile,payment_mode:'cash_on_entry'}),false);
});
test('selected week alone is current purchase; older amounts and payments remain carryforward',()=>{
  const c=context();
  c.payableRows=[{id:'a',supplier_code:'45',invoice_date:'2026-09-19',amount_jpy:100},{id:'b',supplier_code:'45',invoice_date:'2026-09-20',amount_jpy:200},{id:'c',supplier_code:'45',invoice_date:'2026-09-26',amount_jpy:300},{id:'d',supplier_code:'45',invoice_date:'2026-09-27',amount_jpy:400},{id:'other',supplier_code:'46',invoice_date:'2026-09-26',amount_jpy:999}];
  c.payablePayments=[{id:'p',payable_id:'a',payment_date:'2026-09-20',amount_jpy:100}];
  const result=c.apWeeklyClosingCalculation({code:'45'},profile,'2026-09-26');
  assert.equal(result.snapshot.openingBalance,100);assert.equal(result.snapshot.purchaseAmount,500);assert.equal(result.snapshot.paymentAmount,100);assert.equal(result.snapshot.closingBalance,500);
  c.payableClosings=[{supplier_code:'45',status:'closed',period_from:'2026-09-20',period_to:'2026-09-26'}];
  assert.ok(c.apWeeklyClosingCalculation({code:'45'},profile,'2026-09-26').existing);
  assert.equal(c.apWeeklyClosingCalculation({code:'45'},profile,'2026-10-03').existing,undefined);
  c.payableClosings[0].status='reopened';
  assert.equal(c.apWeeklyClosingCalculation({code:'45'},profile,'2026-09-26').existing,undefined);
});
test('group selector lists real dates by month, preserves selection on reload and filters suppliers',()=>{
  const c=context();
  for(const [id,value] of Object.entries({'ap-closing-month':'2026-09','ap-closing-day':'-7','ap-closing-supplier':'45','ap-closing-weekly-date':''}))c.elements[id]={value,style:{}};
  c.elements['ap-closing-weekly-date-label']={style:{}};
  c.renderPayableWeeklyDates();assert.equal(c.elements['ap-closing-weekly-date'].value,'2026-09-26');
  c.elements['ap-closing-weekly-date'].value='2026-09-12';c.renderPayableWeeklyDates();assert.equal(c.elements['ap-closing-weekly-date'].value,'2026-09-12');
  c.payablesLoaded=false;assert.equal(c.apClosingGroupCalculations()[0].range.to,'2026-09-12');
  c.elements['ap-closing-month'].value='2026-10';c.renderPayableWeeklyDates();assert.equal(c.elements['ap-closing-weekly-date'].value,'2026-10-03');
  assert.equal(c.apClosingGroupCalculations()[0].range.from,'2026-09-27');
  c.elements['ap-closing-supplier'].value='different';assert.equal(c.apClosingGroupCalculations().length,0);
  c.elements['ap-closing-day'].value='31';c.renderPayableWeeklyDates();assert.equal(c.elements['ap-closing-weekly-date-label'].style.display,'none');
});
test('SQL migration preserves historical records and protects both sync due dates and old-client closings', {skip:!process.env.PGLITE_PATH},async()=>{
  const {PGlite}=require(process.env.PGLITE_PATH);const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;
      create table accounts_payable_supplier_profiles(supplier_code text primary key,payment_mode text,closing_day smallint);
      create table accounts_payable(id text primary key,source_type text,supplier_code text,invoice_date date,due_date date,closing_id text,amount_jpy numeric);
      create table accounts_payable_closings(id text primary key,supplier_code text,status text,period_from date,period_to date,due_date date);
      insert into accounts_payable_supplier_profiles values('45','credit',7),('15','credit',15),('cash','cash_on_entry',7);
      insert into accounts_payable values('old','purchase','45','2026-08-25','2026-09-07','closed',1234);
      insert into accounts_payable_closings values('closed','45','closed','2026-08-01','2026-08-31','2026-09-07');`);
    const before=await db.query('select * from accounts_payable');
    await db.exec(sql);await db.exec(sql);
    assert.deepEqual((await db.query('select * from accounts_payable')).rows,before.rows);
    await db.exec("update accounts_payable_supplier_profiles set closing_anchor_date='2026-09-26',payment_days_after_closing=6 where supplier_code='45'");
    const c=context();
    for(let days=-50;days<=200;days++){
      const date=shift('2026-09-26',days);
      const result=await db.query('select accounts_payable_weekly_closing_date($1::date,$2::date)::text d',[date,'2026-09-26']);
      assert.equal(result.rows[0].d,c.apWeeklyClosingOnOrAfter(date,'2026-09-26'));
    }
    await db.exec("insert into accounts_payable values('new','purchase','45','2026-09-27','2026-10-07',null,222),('monthly','purchase','15','2026-09-27','2026-10-15',null,333),('cash','purchase','cash','2026-09-27','2026-09-27',null,444)");
    assert.equal((await db.query("select due_date::text d from accounts_payable where id='new'")).rows[0].d,'2026-10-09');
    await db.exec("update accounts_payable set due_date='2026-10-07' where id='new'");
    assert.equal((await db.query("select due_date::text d from accounts_payable where id='new'")).rows[0].d,'2026-10-09');
    assert.equal((await db.query("select due_date::text d from accounts_payable where id='monthly'")).rows[0].d,'2026-10-15');
    assert.equal((await db.query("select due_date::text d from accounts_payable where id='cash'")).rows[0].d,'2026-09-27');
    await assert.rejects(()=>db.exec("insert into accounts_payable_closings values('bad','45','closed','2026-09-01','2026-09-07','2026-09-07')"),/締め期間/);
    await assert.rejects(()=>db.exec("insert into accounts_payable_closings values('bad','45','closed','2026-09-20','2026-09-26','2026-10-03')"),/支払期限/);
    await db.exec("insert into accounts_payable_closings values('valid','45','closed','2026-09-20','2026-09-26','2026-10-02')");
    await db.exec("update accounts_payable set closing_id='valid',due_date='2026-10-02' where id='new'");
    assert.equal((await db.query("select due_date::text d from accounts_payable where id='new'")).rows[0].d,'2026-10-02');
    await db.exec("update accounts_payable_closings set status='reopened' where id='closed'");
    assert.deepEqual((await db.query("select * from accounts_payable where id='old'")).rows,before.rows);
  }finally{await db.close()}
});
