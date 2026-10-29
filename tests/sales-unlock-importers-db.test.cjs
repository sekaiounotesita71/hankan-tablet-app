const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),session='00000000-0000-0000-0000-000000000001';
const migration=fs.readFileSync(path.join(root,'sales-unlock-importers-migration.sql'),'utf8');
const fixtureSource=fs.readFileSync(path.join(__dirname,'sales-finalize-importers-db.test.cjs'),'utf8').split("test('initial finalization")[0];
const fixtures=vm.runInNewContext(fixtureSource+';({database,preview,finalize,state})',{require,__dirname,process});
async function database(){
  const db=await fixtures.database();
  await db.exec('alter table work_sessions add unlocked_at timestamptz,add unlocked_by uuid');
  await db.exec(migration);return db;
}
async function unlock(db,codes=['01'],reason='Price correction',version){return (await db.query('select unlock_work_session_importers($1,$2,$3,$4) as r',[session,codes,reason,version??(await fixtures.preview(db)).version])).rows[0].r}
async function repreview(db){return (await db.query('select work_reopened_importer_preview($1) as r',[session])).rows[0].r}
async function refinalize(db,codes=['01'],fees={'01':100},version){return (await db.query('select refinalize_work_session_importers($1,$2,$3,$4) as r',[session,codes,fees,version??(await repreview(db)).version])).rows[0].r}
async function state(db){return (await db.query(`select jsonb_build_object(
  'work',(select jsonb_agg(to_jsonb(w) order by id) from work_sessions w),
  'lines',(select jsonb_agg(to_jsonb(l) order by source_row_no) from order_lines l),
  'boxes',(select jsonb_agg(to_jsonb(b) order by importer_code) from boxes b),
  'sales',(select jsonb_agg(to_jsonb(s) order by id) from sales_records s),
  'ar',(select jsonb_agg(to_jsonb(r) order by id) from accounts_receivable r),
  'ds',(select jsonb_agg(to_jsonb(d) order by id) from domestic_sales d),
  'dr',(select jsonb_agg(to_jsonb(d) order by id) from domestic_receivables d),
  'dl',(select jsonb_agg(to_jsonb(d) order by id) from domestic_sale_lines d),
  'logs',(select jsonb_agg(to_jsonb(l) order by id) from sales_correction_log l)) as r`)).rows[0].r}
function financial(s){return {sales:s.sales,ar:s.ar,ds:s.ds,dr:s.dr,dl:s.dl}}

test('partial unlock preserves money and other locks; re-finalization reuses IDs before pending initial work closes',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','03'],{'01':100,'03':20});const before=await state(db);
    const result=await unlock(db,['DIM']);
    assert.deepEqual(result.session.finalized_importer_codes,['03']);assert.deepEqual(result.session.reopened_importer_codes,['01']);
    assert.equal(result.session.finalized_at,null);assert.equal(result.session.locked,false);
    const reopened=await state(db);assert.deepEqual(financial(reopened),financial(before));assert.deepEqual(reopened.lines,before.lines);assert.deepEqual(reopened.boxes,before.boxes);
    await db.exec('grant usage on schema public to authenticated;grant select,insert,update,delete on all tables in schema public to authenticated;set role authenticated');
    await db.exec('update order_lines set unit_price=20 where source_row_no=1');
    await assert.rejects(()=>db.exec('update order_lines set unit_price=999 where source_row_no=2'),/確定済み/);
    await assert.rejects(()=>db.exec("update boxes set gross_weight=999 where importer_code='03'"),/確定済み/);
    await db.exec('reset role');
    const p=await repreview(db);assert.deepEqual(p.groups.filter(g=>g.changed).map(g=>g.importer_code),['01']);
    const done=await refinalize(db,['01'],{'01':110});assert.equal(done.session.locked,false);assert.equal(done.session.finalized_at,null);
    assert.deepEqual(done.session.finalized_importer_codes,['01','03']);assert.deepEqual(done.session.reopened_importer_codes,[]);assert.deepEqual(done.pending_importers,['08']);
    const after=await state(db);assert.equal(after.sales.length,2);assert.equal(after.ar.length,2);
    const sale=after.sales.find(s=>s.importer_code==='01'),ar=after.ar.find(r=>r.importer_code==='01');
    assert.equal(sale.id,before.sales.find(s=>s.importer_code==='01').id);assert.equal(sale.amount,25);
    assert.equal(ar.id,before.ar.find(r=>r.importer_code==='01').id);assert.equal(ar.amount_jpy,135);assert.equal(ar.invoice_no,before.ar.find(r=>r.importer_code==='01').invoice_no);
    assert.deepEqual(after.sales.find(s=>s.importer_code==='03'),before.sales.find(s=>s.importer_code==='03'));
    assert.deepEqual(after.ar.find(r=>r.importer_code==='03'),before.ar.find(r=>r.importer_code==='03'));
    assert.equal((await fixtures.finalize(db,['08'],{'08':0})).session.locked,true);
  }finally{await db.close()}
});

test('full work unlocks only the selected importer and re-locks even when no amounts change',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','03','08'],{'01':100,'03':20,'08':10});const before=await state(db);
    const result=await unlock(db,['03']);assert.deepEqual(result.session.finalized_importer_codes,['01','08']);assert.ok(result.session.finalized_at);
    assert.deepEqual(financial(await state(db)),financial(before));
    const done=await refinalize(db,['03'],{'03':20});assert.equal(done.session.locked,true);assert.deepEqual(done.session.finalized_importer_codes,['01','03','08']);assert.deepEqual(done.session.reopened_importer_codes,[]);
    assert.equal((await state(db)).sales.length,3);
  }finally{await db.close()}
});

test('multiple reopened importers finish independently while never-finalized work uses the original route',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','03'],{'01':100,'03':20});await unlock(db,['01','03']);
    let result=await refinalize(db,['01'],{'01':100});assert.deepEqual(result.session.reopened_importer_codes,['03']);assert.deepEqual(result.pending_importers,['03','08']);
    result=await fixtures.finalize(db,['08'],{'08':10});assert.deepEqual(result.session.reopened_importer_codes,['03']);assert.equal(result.session.locked,false);
    result=await refinalize(db,['03'],{'03':20});assert.equal(result.session.locked,true);assert.deepEqual(result.session.reopened_importer_codes,[]);
    const saved=await state(db);assert.equal(saved.sales.length,3);assert.equal(saved.ds.length,1);assert.equal(saved.dr.length,1);assert.equal(saved.ar.length,2);
  }finally{await db.close()}
});

test('domestic-linked correction preserves linked IDs and never creates a second domestic invoice',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','08'],{'01':100,'08':10});const before=await state(db);await unlock(db,['08']);
    assert.deepEqual(financial(await state(db)),financial(before));
    await db.exec('update order_lines set input_qty=5 where source_row_no=3');
    await refinalize(db,['08'],{'08':20});const after=await state(db);
    assert.equal(after.ds.length,1);assert.equal(after.dr.length,1);assert.equal(after.dl.length,1);
    assert.equal(after.ds[0].id,before.ds[0].id);assert.equal(after.dr[0].id,before.dr[0].id);assert.equal(after.dl[0].id,before.dl[0].id);
    assert.equal(after.sales.find(s=>s.importer_code==='08').id,before.sales.find(s=>s.importer_code==='08').id);
    assert.equal(after.ds[0].total_amount_jpy,562);assert.equal(after.dr[0].amount_jpy,562);assert.deepEqual(after.ar,before.ar);
  }finally{await db.close()}
});

test('closed or paid export invoices block only their importer and roll back multi-selection',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','03'],{'01':100,'03':20});
    await db.exec("update accounts_receivable set closing_id=gen_random_uuid() where importer_code='03'");let before=await state(db);
    await assert.rejects(()=>unlock(db,['01','03']),/請求締め/);assert.deepEqual(await state(db),before);
    await unlock(db,['01']);
    await db.exec("update accounts_receivable set closing_id=null where importer_code='03';insert into accounts_receivable_payments(receivable_id) select id from accounts_receivable where importer_code='03'");
    before=await state(db);await assert.rejects(()=>unlock(db,['03']),/入金/);assert.deepEqual(await state(db),before);
    await refinalize(db,['01'],{'01':100});
  }finally{await db.close()}
});

test('domestic closing, payments and cancelled receivables prevent reopening',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['08'],{'08':10});await db.exec("select set_config('test.closed','true',false)");
    let before=await state(db);await assert.rejects(()=>unlock(db,['08']),/請求締め/);assert.deepEqual(await state(db),before);
    await db.exec("select set_config('test.closed','false',false);update domestic_receivables set paid_amount_jpy=1");
    before=await state(db);await assert.rejects(()=>unlock(db,['08']),/入金状態/);assert.deepEqual(await state(db),before);
    await db.exec("update domestic_receivables set paid_amount_jpy=0,status='cancelled'");
    before=await state(db);await assert.rejects(()=>unlock(db,['08']),/取消/);assert.deepEqual(await state(db),before);
  }finally{await db.close()}
});

test('stale versions, invalid codes, repeat calls, short reasons, nonadmins and external users cannot reopen',async()=>{
  const db=await database();try{
    await fixtures.finalize(db);const p=await fixtures.preview(db);await db.exec('update order_lines set input_qty=4 where source_row_no=2');let before=await state(db);
    await assert.rejects(()=>unlock(db,['01'],'Correction',p.version),/確認中/);assert.deepEqual(await state(db),before);
    for(const [codes,reason] of [[[], 'Correction'],[['03'],'Correction'],[['99'],'Correction'],[['01'],'x']]){
      await assert.rejects(()=>unlock(db,codes,reason));assert.deepEqual(await state(db),before);
    }
    await db.exec("select set_config('test.admin','false',false)");await assert.rejects(()=>unlock(db),/管理者/);
    await db.exec("select set_config('test.admin','true',false);select set_config('test.internal','false',false)");await assert.rejects(()=>unlock(db,['01'],'Correction',p.version),/管理者/);
    await db.exec("select set_config('test.internal','true',false)");await unlock(db);before=await state(db);
    await assert.rejects(()=>unlock(db),/確定済みでは/);assert.deepEqual(await state(db),before);
  }finally{await db.close()}
});

test('refinalization cannot touch another importer, accept stale versions, or bypass a newly closed invoice',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','03'],{'01':100,'03':20});await unlock(db);let before=await state(db);
    await assert.rejects(()=>refinalize(db,['03'],{'03':20}),/解除した輸入社のみ/);assert.deepEqual(await state(db),before);
    const p=await repreview(db);await db.exec('update order_lines set unit_price=30 where source_row_no=1');before=await state(db);
    await assert.rejects(()=>refinalize(db,['01'],{'01':100},p.version),/確認中/);assert.deepEqual(await state(db),before);
    await db.exec("update accounts_receivable set closing_id=gen_random_uuid() where importer_code='01'");before=await state(db);
    await assert.rejects(()=>refinalize(db),/請求締め/);assert.deepEqual(await state(db),before);
  }finally{await db.close()}
});

test('state columns and dates reject direct changes; migration reruns preserve reopened work and finances',async()=>{
  const db=await database();try{
    await fixtures.finalize(db);await unlock(db);const before=await state(db);await db.exec(migration);assert.deepEqual(await state(db),before);
    for(const sql of ["update work_sessions set reopened_importer_codes='{}'","update work_sessions set finalized_importer_codes='{01}'","update work_sessions set work_date='2026-10-30'"]){
      await assert.rejects(()=>db.exec(sql));assert.deepEqual(await state(db),before);
    }
    const grants=(await db.query("select has_function_privilege('anon','public.unlock_work_session_importers(uuid,text[],text,text)','EXECUTE') as anon,has_function_privilege('authenticated','public.unlock_work_session_importers(uuid,text[],text,text)','EXECUTE') as internal")).rows[0];
    assert.equal(grants.anon,false);assert.equal(grants.internal,true);
  }finally{await db.close()}
});

test('legacy full locks without importer flags support selective reopening',async()=>{
  const db=await database();try{
    await fixtures.finalize(db,['01','03','08'],{'01':100,'03':20,'08':10});
    await db.exec(`select set_config('app.importer_finalization_session','${session}',false);update work_sessions set finalized_importer_codes='{}';select set_config('app.importer_finalization_session','',false)`);
    const before=await state(db);const result=await unlock(db,['01']);
    assert.deepEqual(result.session.finalized_importer_codes,['03','08']);assert.deepEqual(financial(await state(db)),financial(before));
    assert.equal((await refinalize(db)).session.locked,true);
  }finally{await db.close()}
});

test('reopening an all-stockout importer does not invent a zero-value invoice on re-finalization',async()=>{
  const db=await database();try{
    await db.exec('update order_lines set is_stockout=true,input_qty=null,net_weight=null,box_no=null where source_row_no=1');
    await fixtures.finalize(db,['01'],{'01':0});assert.equal((await state(db)).ar,null);
    await unlock(db);await refinalize(db,['01'],{'01':0});const saved=await state(db);
    assert.equal(saved.ar,null);assert.equal(saved.sales.length,1);assert.deepEqual(saved.work[0].reopened_importer_codes,[]);
  }finally{await db.close()}
});
