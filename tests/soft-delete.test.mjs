import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createSQLiteStore } from '../lib/sqlite-store.mjs';
import { createApp } from '../server.mjs';

test('SQL 006: excluir/restaurar preserva registros, rejeita conflitos e bloqueia salvamento em excluídos', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  const first = '11111111-1111-1111-1111-111111111111', second = '22222222-2222-2222-2222-222222222222';
  const sql = file => fs.readFileSync(new URL('../sql/' + file, import.meta.url), 'utf8');
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.outro_site(id integer); insert into public.outro_site values(11);
    insert into auth.users values ('${first}','first@example.test',now()),('${second}','second@example.test',now());`);
  for (const file of ['001_Qest_supabase.sql', '003_Qest_acesso_web.sql', '005_Qest_conta_da_entrevista.sql']) await pg.exec(sql(file));
  await pg.exec(`insert into public."Qest_access"(email) values('first@example.test');`);
  const user = id => pg.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  const rpc = async (op, payload = {}, name = 'Qest_web') => (await pg.query(`select public."${name}"($1,$2::jsonb) as data`, [op, JSON.stringify(payload)])).rows[0].data;
  await user(first);
  let record = await rpc('create', { interviewer: 'Aplicador' });
  record = await rpc('save', { id: record.id, revision: record.revision, position: 2, answers: { opening: { value: 1 }, q1: { value: 'Respostas preservadas' } } });
  // Simula uma instalação sem as colunas novas, com entrevistas já existentes.
  await pg.exec('alter table public."Qest_interviews" drop column deleted_at, drop column deleted_by_user_id, drop column deleted_by_email;');
  await pg.exec(sql('006_Qest_exclusao_reversivel.sql'));
  await pg.exec(sql('006_Qest_exclusao_reversivel.sql'));
  await pg.exec('set role authenticated');
  for (const op of ['soft_delete', 'restore']) {
    await assert.rejects(() => rpc(op, { id: record.id }), e => e.code === 'PT400');
    await assert.rejects(() => rpc(op, { id: record.id, revision: -1 }), e => e.code === 'PT400');
  }
  const change = (op, row, extra = {}) => rpc(op, { id: row.id, revision: row.revision, ...extra });
  await assert.rejects(() => change('restore', record), e => e.code === 'PT409');
  await assert.rejects(() => change('soft_delete', record, { revision: 0 }), e => e.code === 'PT409');
  const deleted = await change('soft_delete', record, { actor_email: 'forged@example.test', actor_user_id: second });
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by_email, 'first@example.test');
  assert.equal(deleted.deleted_by_user_id, first);
  assert.equal(deleted.revision, record.revision + 1);
  for (const key of ['id', 'code', 'instrument_version', 'interviewer', 'status', 'position', 'started_at', 'ended_at', 'answers', 'created_by_email']) assert.deepEqual(deleted[key], record[key], key);
  assert.equal((await rpc('get', { id: record.id })).deleted_at, deleted.deleted_at);
  assert.equal((await rpc('list')).length, 1, 'Excluídos continuam disponíveis para a seção de recuperação');
  await assert.rejects(() => change('soft_delete', deleted), e => e.code === 'PT409');
  await assert.rejects(() => rpc('save', { id: deleted.id, revision: deleted.revision, position: 2, answers: { q1: { value: 'Não gravar' } } }), e => e.code === 'PT409');
  // Uma segunda conta não autorizada não pode excluir nem restaurar.
  await user(second);
  for (const op of ['soft_delete', 'restore']) await assert.rejects(() => change(op, deleted), e => e.code === 'PT403');
  await pg.exec('reset role');
  await pg.exec(`insert into public."Qest_access"(email) values('second@example.test');`);
  await pg.exec(sql('006_Qest_exclusao_reversivel.sql'));
  await pg.exec('set role authenticated');
  const restored = await change('restore', deleted);
  assert.equal(restored.deleted_at, null); assert.equal(restored.deleted_by_email, null);
  assert.equal(restored.created_by_email, 'first@example.test');
  assert.deepEqual(restored.answers, record.answers); assert.equal(restored.status, 'in_progress');
  assert.equal(restored.revision, deleted.revision + 1);
  await assert.rejects(() => change('restore', restored), e => e.code === 'PT409');
  // Concluídas e interrompidas recuperam o estado anterior, sem reabrir edição.
  for (const [status, position, answers] of [
    ['completed', 65, { opening: { value: 1 }, checkpoint: { value: 1 }, q1: { value: 'Finalizada' } }],
    ['interrupted_opening', 0, { opening: { value: 0 } }],
  ]) {
    const row = { code: status, status, position, answers, instrument_version: '1.3', interviewer: 'Importado', fingerprint: (status === 'completed' ? 'a' : 'b').repeat(64) };
    const imported = await rpc('import', { rows: [row] });
    const original = await rpc('get', { id: imported.ids[0] });
    const archived = await change('soft_delete', original);
    assert.equal((await rpc('import', { rows: [row] })).skipped, 1, 'Excluída não é reimportada como nova');
    const recovered = await change('restore', archived);
    assert.equal(recovered.status, status); assert.equal(recovered.ended_at, original.ended_at);
    assert.deepEqual(recovered.answers, answers);
    await assert.rejects(() => rpc('save', { id: recovered.id, revision: recovered.revision, position, answers }), e => e.code === 'PT409');
  }
  await assert.rejects(() => pg.query('select * from public."Qest_interviews"'), /permission denied/);
  await pg.exec('reset role; set role anon');
  await assert.rejects(() => change('soft_delete', restored), /permission denied/);
  await pg.exec('reset role; set role service_role');
  const serviceDeleted = await rpc('soft_delete', { id: restored.id, revision: restored.revision }, 'Qest_store');
  await assert.rejects(() => rpc('save', { ...serviceDeleted, answers: record.answers }, 'Qest_store'), e => e.code === 'PT409');
  await pg.exec('reset role');
  assert.deepEqual((await pg.query('select * from public.outro_site')).rows, [{ id: 11 }]);
});

test('API local: exclusão reversível com controle de revisão, restauração e respostas preservadas', async t => {
  const store = createSQLiteStore(':memory:');
  const server = createApp({ store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  let record = (await request('/api/interviews', 'POST', { interviewer: 'Teste' })).data;
  const path = '/api/interviews/' + record.id;
  record = (await request(path, 'PATCH', { revision: 0, position: 2, answers: { opening: { value: 1 }, q1: { value: 'Preservada' } } })).data;
  assert.equal((await request(path + '/delete', 'POST', {})).status, 400);
  assert.equal((await request(path + '/delete', 'POST', { revision: 0 })).status, 409);
  const removed = await request(path + '/delete', 'POST', { revision: record.revision });
  assert.equal(removed.status, 200); assert.ok(removed.data.deleted_at);
  assert.equal((await request(path, 'PATCH', { revision: removed.data.revision, position: 2, answers: {} })).status, 409);
  assert.throws(() => store.save({ ...removed.data, answers: {} }), e => e.status === 409);
  assert.equal((await request('/api/interviews')).data.length, 1);
  assert.equal((await request(path)).data.answers.q1.value, 'Preservada');
  const restored = await request(path + '/restore', 'POST', { revision: removed.data.revision });
  assert.equal(restored.status, 200); assert.equal(restored.data.deleted_at, null);
  assert.deepEqual(restored.data.answers, record.answers); assert.equal(restored.data.code, record.code);
  assert.equal((await request(path + '/restore', 'POST', { revision: restored.data.revision })).status, 409);
});
