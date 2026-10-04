import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {flow} from '../server.mjs';

test('Pages: acesso autenticado, isolamento de outros sites, validação no banco e transações', async t => {
  const pg = new PGlite(); t.after(()=>pg.close());
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.outro_site(id integer); insert into public.outro_site values(7);
    insert into auth.users values
    ('11111111-1111-1111-1111-111111111111','allowed@example.test',now()),
    ('22222222-2222-2222-2222-222222222222','other@example.test',now()),
    ('33333333-3333-3333-3333-333333333333','unconfirmed@example.test',null);`);
  for(const file of ['001_Qest_supabase.sql','003_Qest_acesso_web.sql']) await pg.exec(fs.readFileSync(new URL('../sql/'+file,import.meta.url),'utf8'));
  await pg.exec(fs.readFileSync(new URL('../sql/003_Qest_acesso_web.sql',import.meta.url),'utf8'));
  await pg.exec(`insert into public."Qest_access"(email) values('allowed@example.test'),('unconfirmed@example.test')`);
  const rpc = async (operation,payload={})=>(await pg.query('select public."Qest_web"($1,$2::jsonb) as result',[operation,JSON.stringify(payload)])).rows[0].result;
  const user = async id=>{await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
  await pg.exec('set role anon');
  await assert.rejects(()=>rpc('list'),/permission denied/);
  await pg.exec('reset role; set role authenticated');
  await assert.rejects(()=>rpc('list'),e=>e.code==='PT403');
  await user('22222222-2222-2222-2222-222222222222');
  for(const operation of ['health','list','get','create','save','duplicates','import']) await assert.rejects(()=>rpc(operation),e=>e.code==='PT403');
  await user('33333333-3333-3333-3333-333333333333');
  await assert.rejects(()=>rpc('health'),e=>e.code==='PT403');
  await user('11111111-1111-1111-1111-111111111111');
  assert.equal((await rpc('health')).schema_version,2);
  for(const table of ['Qest_interviews','Qest_responses','Qest_access','Qest_web_config']) await assert.rejects(()=>pg.query(`select * from public."${table}"`),/permission denied/);
  await assert.rejects(()=>pg.query(`select public."Qest_store"('list','{}')`),/permission denied/);
  let record=await rpc('create',{interviewer:'Aplicador web',instrument_version:'malicious'});
  assert.equal(record.instrument_version,'1.3');
  const save=body=>rpc('save',{id:record.id,revision:record.revision,position:2,answers:{opening:{value:1}},...body});
  await assert.rejects(()=>save({answers:{opening:{value:1},q4:{value:999}}}),e=>e.code==='PT400');
  await assert.rejects(()=>save({answers:{opening:{value:1},q2:{value:1.5}}}),e=>e.code==='PT400');
  await assert.rejects(()=>save({answers:{opening:{value:1},q19:{value:[999]}}}),e=>e.code==='PT400');
  await assert.rejects(()=>save({answers:{opening:{value:1},q1:{private:'x'}}}),e=>e.code==='PT400');
  await assert.rejects(()=>save({position:flow.findIndex(s=>s.id==='q7.1'),answers:{opening:{value:1},q7:{value:0}}}),e=>e.code==='PT400');
  record=await save({position:flow.findIndex(s=>s.id==='q7.1'),answers:{opening:{value:1},q7:{value:1},'q11.1':{value:[1,2]},q19:{value:[1,2]}}});
  assert.equal(record.revision,1); assert.deepEqual(record.answers.q19.value,[1,2]);
  await assert.rejects(()=>save({revision:0}),e=>e.code==='PT409');
  await assert.rejects(()=>save({position:65,action:'complete'}),e=>e.code==='PT400');
  record=await save({position:65,action:'complete',answers:{checkpoint:{value:1}}});
  assert.equal(record.status,'completed'); assert.equal(record.answers.q7.value,1);
  await assert.rejects(()=>save({}),e=>e.code==='PT409');
  const row={code:'WEB-IMPORT',instrument_version:'1.2',interviewer:'Teste',position:65,status:'completed',fingerprint:'a'.repeat(64),answers:{opening:{value:1},checkpoint:{value:1},q19:{value:[1,2]}}};
  assert.equal((await rpc('import',{rows:[row]})).imported,1);
  assert.equal((await rpc('import',{rows:[row]})).skipped,1);
  await assert.rejects(()=>rpc('import',{rows:[{...row,code:'NEW',fingerprint:'b'.repeat(64)},{...row,code:'BAD',fingerprint:'c'.repeat(64),answers:{q1:{value:10}}}]}),e=>e.code==='PT400');
  assert.equal((await rpc('list')).length,2);
  await pg.exec('reset role');
  assert.deepEqual((await pg.query('select * from public.outro_site')).rows,[{id:7}]);
  await pg.exec(`update public."Qest_access" set active=false where email='allowed@example.test'; set role authenticated`);
  await assert.rejects(()=>rpc('list'),e=>e.code==='PT403');
});
