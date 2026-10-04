import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('Conta da entrevista: sessão confiável, histórico preservado, importação e migração idempotente', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  const first = '11111111-1111-1111-1111-111111111111';
  const second = '22222222-2222-2222-2222-222222222222';
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.outro_site(id integer); insert into public.outro_site values(9);
    insert into auth.users values ('${first}','first@example.test',now()),('${second}','second@example.test',now());`);
  const sql = file => fs.readFileSync(new URL('../sql/' + file, import.meta.url), 'utf8');
  for (const file of ['001_Qest_supabase.sql', '003_Qest_acesso_web.sql']) await pg.exec(sql(file));
  await pg.exec(`insert into public."Qest_access"(email) values('first@example.test'),('second@example.test');`);
  const user = id => pg.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  const rpc = async (operation, payload = {}) => (await pg.query('select public."Qest_web"($1,$2::jsonb) as data', [operation, JSON.stringify(payload)])).rows[0].data;
  await user(first);
  const legacy = await rpc('create', { interviewer: 'Antigo' });
  await pg.exec(sql('005_Qest_conta_da_entrevista.sql'));
  await pg.exec(sql('005_Qest_conta_da_entrevista.sql'));
  assert.equal((await rpc('get', { id: legacy.id })).created_by_email, null);
  await pg.exec('set role authenticated');
  const record = await rpc('create', { interviewer: 'Aplicador', created_by_email: 'forged@example.test', created_by_user_id: second });
  assert.equal(record.created_by_user_id, first);
  assert.equal(record.created_by_email, 'first@example.test');
  await user(second);
  assert.equal((await rpc('get', { id: record.id })).created_by_email, 'first@example.test');
  const changed = await rpc('save', { id: record.id, revision: 0, position: 2, answers: { opening: { value: 1 }, q1: { value: 'Teste' } }, created_by_email: 'second@example.test' });
  assert.equal(changed.created_by_email, 'first@example.test');
  assert.equal(changed.created_by_user_id, first);
  // Retomar uma entrevista anterior ao recurso não atribui o autor à sessão atual.
  const oldSaved = await rpc('save', { id: legacy.id, revision: 0, position: 0, answers: {} });
  assert.equal(oldSaved.created_by_email, null);
  const row = { code: 'IMPORT-CREATOR', instrument_version: '1.3', interviewer: 'Planilha', position: 0,
    status: 'in_progress', fingerprint: 'a'.repeat(64), answers: {}, created_by_email: 'forged@example.test' };
  const imported = await rpc('import', { rows: [row] });
  assert.equal((await rpc('get', { id: imported.ids[0] })).created_by_email, 'second@example.test');
  assert.equal((await rpc('import', { rows: [row] })).skipped, 1);
  await assert.rejects(() => pg.query('select * from public."Qest_interviews"'), /permission denied/);
  await assert.rejects(() => pg.query('select public."Qest_stamp_creator"()'), /permission denied/);
  await pg.exec('reset role');
  await assert.rejects(() => pg.query('update public."Qest_interviews" set created_by_email=$1 where id=$2', ['changed@example.test', record.id]), e => e.code === 'PT400');
  // Mesmo uma mudança posterior no e-mail da conta não reescreve o histórico.
  await pg.query('update auth.users set email=$1 where id=$2', ['renamed@example.test', first]);
  await pg.exec(sql('005_Qest_conta_da_entrevista.sql'));
  assert.equal((await rpc('get', { id: record.id })).created_by_email, 'first@example.test');
  assert.equal((await rpc('list')).find(r => r.id === record.id).created_by_user_id, first);
  // INSERT direto recebe a identidade real, mesmo se tentar fornecer outra.
  const direct = await pg.query(`insert into public."Qest_interviews"(code,instrument_version,created_by_email)
    values ('DIRECT','1.3','forged@example.test') returning created_by_email`);
  assert.equal(direct.rows[0].created_by_email, 'second@example.test');
  // Sem sessão de usuário (Node/service_role), não inventa uma conta.
  await user(''); await pg.exec('set role service_role');
  const local = (await pg.query(`select public."Qest_store"('create','{"instrument_version":"1.3","created_by_email":"forged@example.test"}') as data`)).rows[0].data;
  assert.equal(local.created_by_email, null); assert.equal(local.created_by_user_id, null);
  await pg.exec('reset role');
  assert.deepEqual((await pg.query('select * from public.outro_site')).rows, [{ id: 9 }]);
  await user(first); await pg.exec('set role authenticated');
  await assert.rejects(() => rpc('create'), e => e.code === 'PT403');
});
