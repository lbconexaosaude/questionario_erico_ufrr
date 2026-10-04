import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createSupabaseStore } from '../lib/supabase-store.mjs';
import { createApp, flow } from '../server.mjs';

test('SQL Qest_: PostgreSQL, isolamento, RLS, RPC e transações', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.outro_site (id integer primary key, texto text);
    insert into public.outro_site values (1, 'Não alterar');
    grant select on public.outro_site to anon;
  `);
  const migration = fs.readFileSync(new URL('../sql/001_Qest_supabase.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration); // Reaplicação sem apagar objetos/dados de outros sites.
  const other = await pg.query('select * from public.outro_site');
  assert.deepEqual(other.rows, [{ id: 1, texto: 'Não alterar' }]);
  assert.equal((await pg.query(`select has_table_privilege('anon','public.outro_site','SELECT') as allowed`)).rows[0].allowed, true);
  const tables = await pg.query(`select relname, relrowsecurity from pg_class where relkind='r' and relname like 'Qest\_%' escape '\' order by relname`);
  assert.deepEqual(tables.rows.map(r => r.relname), ['Qest_import_keys', 'Qest_interviews', 'Qest_responses']);
  assert.ok(tables.rows.every(r => r.relrowsecurity));
  const verification = await pg.exec(fs.readFileSync(new URL('../sql/002_Qest_verificar.sql', import.meta.url), 'utf8'));
  assert.deepEqual(verification.at(-1).rows[0], { anon_pode_executar: false, usuario_pode_executar: false, servidor_pode_executar: true });
  for (const role of ['anon', 'authenticated']) {
    await pg.exec(`set role ${role}`);
    await assert.rejects(() => pg.query('select * from public."Qest_interviews"'), /permission denied/);
    await assert.rejects(() => pg.query(`select public."Qest_store"('health','{}')`), /permission denied/);
    await pg.exec('reset role');
  }
  await pg.exec('set role service_role');
  const rpc = async (operation, payload = {}) => (await pg.query(`select public."Qest_store"($1,$2::jsonb) as data`, [operation, JSON.stringify(payload)])).rows[0].data;
  assert.deepEqual(await rpc('health'), { prefix: 'Qest_', schema_version: 1 });
  let record = await rpc('create', { instrument_version: '1.2', interviewer: 'Teste' });
  assert.match(record.code, /^BIO-\d{4}-000001$/);
  assert.deepEqual(record.answers, {});
  await assert.rejects(() => rpc('save', { id: record.id, revision: 0, position: 2, status: 'in_progress', instrument_version: '1.2', answers: {} }), e => e.code === 'PT400');
  record = await rpc('save', { id: record.id, revision: 0, position: 33, status: 'in_progress', instrument_version: '1.2', answers: { opening: { value: 1 }, q20: { value: [2, 3] }, q1: { value: 'Nome <teste>' } } });
  assert.equal(flow.findIndex(s => s.id === 'checkpoint'), 33);
  assert.equal(flow.length - 1, 65);
  assert.equal(record.revision, 1);
  assert.deepEqual(record.answers.q20.value, [2, 3]);
  await assert.rejects(() => rpc('save', { ...record, revision: 0 }), e => e.code === 'PT409');
  const oldDate = (await pg.query('select created_at,updated_at from public."Qest_responses" where interview_id=$1 and question_id=$2', [record.id, 'q20'])).rows[0];
  record = await rpc('save', { ...record, position: 65, status: 'completed', answers: { ...record.answers, checkpoint: { value: 1 } } });
  assert.equal(record.status, 'completed');
  assert.ok(record.ended_at);
  assert.deepEqual((await pg.query('select created_at,updated_at from public."Qest_responses" where interview_id=$1 and question_id=$2', [record.id, 'q20'])).rows[0], oldDate);
  await assert.rejects(() => rpc('save', record), e => e.code === 'PT409');
  const stopped = await rpc('create', { instrument_version: '1.2', interviewer: '' });
  const ended = await rpc('save', { ...stopped, status: 'interrupted_opening', answers: { opening: { value: 0 } } });
  assert.equal(ended.status, 'interrupted_opening');

  const hash = text => createHash('sha256').update(text).digest('hex');
  const row = { code: 'EXCEL-001', instrument_version: '1.2', interviewer: 'Importação', status: 'completed', position: 65, answers: { opening: { value: 1 }, checkpoint: { value: 1 }, q48: { value: [2, 5] } }, fingerprint: hash('import-one') };
  const result = await rpc('import', { rows: [row] });
  assert.equal(result.imported, 1);
  assert.equal((await rpc('import', { rows: [row] })).skipped, 1);
  assert.deepEqual(await rpc('duplicates', { rows: [row, { code: 'NEW', fingerprint: hash('new') }] }), [true, false]);
  const before = (await rpc('list')).length;
  await assert.rejects(() => rpc('import', { rows: [{ ...row, code: 'ATOMIC-A', fingerprint: hash('a') }, { ...row, code: 'ATOMIC-B', fingerprint: hash('b'), answers: { invalid_question: {} } }] }));
  assert.equal((await rpc('list')).length, before, 'Falha reverte o lote inteiro');
  const page = await rpc('list', { limit: 2 });
  const next = await rpc('list', { after: page.at(-1).id });
  assert.equal(page.length + next.length, before);
  assert.equal(new Set([...page, ...next].map(r => r.id)).size, before);
  await pg.exec('reset role');
  await pg.exec(migration);
  assert.equal((await rpc('list')).length, before, 'Reaplicação mantém entrevistas');

  // O adaptador usa a mesma RPC real; somente o transporte HTTP é simulado neste teste.
  await pg.exec('set role service_role');
  const seen = [];
  const store = createSupabaseStore({ url: 'https://test.supabase.co', secretKey: 'sb_secret_TEST_ONLY', fetchImpl: async (url, options) => {
    seen.push({ url, headers: options.headers });
    const body = JSON.parse(options.body);
    try { return Response.json(await rpc(body.p_operation, body.p_payload)); }
    catch (e) { return Response.json({ code: e.code, message: 'Internal details never exposed' }, { status: 400 }); }
  } });
  const server = createApp({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(base + '/api/config').then(r => r.json());
    assert.equal(config.storage.provider, 'supabase');
    assert.equal(JSON.stringify(config).includes('TEST_ONLY'), false);
    const created = await fetch(base + '/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
    const patch = await fetch(base + '/api/interviews/' + created.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, position: 65, action: 'complete', answers: { opening: { value: 1 }, checkpoint: { value: 1 } } }) });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).status, 'completed');
    const listed = await fetch(base + '/api/interviews').then(r => r.json());
    assert.ok(listed.some(r => r.id === created.id));
    assert.ok(seen.every(r => r.url === 'https://test.supabase.co/rest/v1/rpc/Qest_store'));
    assert.ok(seen.every(r => r.headers.apikey === 'sb_secret_TEST_ONLY' && !r.headers.Authorization));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Supabase: configuração, erros sem segredos, chave legada e paginação', async () => {
  assert.throws(() => createSupabaseStore({}), /Configure/);
  assert.throws(() => createSupabaseStore({ url: 'http://test.supabase.co', secretKey: 'sb_secret_TEST' }), /HTTPS/);
  assert.throws(() => createSupabaseStore({ url: 'https://test.supabase.co', secretKey: 'sb_publishable_TEST' }), /secret/);
  const legacyKey = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.test';
  let headers;
  const legacy = createSupabaseStore({ url: 'https://test.supabase.co', secretKey: legacyKey, fetchImpl: async (_, options) => { headers = options.headers; return Response.json({ schema_version: 1 }); } });
  await legacy.health();
  assert.equal(headers.Authorization, 'Bearer ' + legacyKey);
  const bad = createSupabaseStore({ url: 'https://test.supabase.co', secretKey: 'sb_secret_DONT_LEAK', fetchImpl: async () => Response.json({ code: 'PT409', message: 'sb_secret_DONT_LEAK' }, { status: 409 }) });
  await assert.rejects(() => bad.get('id'), e => e.status === 409 && !e.message.includes('DONT_LEAK'));
  const down = createSupabaseStore({ url: 'https://test.supabase.co', secretKey: 'sb_secret_DONT_LEAK', fetchImpl: async () => { throw new Error('sb_secret_DONT_LEAK'); } });
  await assert.rejects(() => down.list(), e => e.status === 503 && !e.message.includes('DONT_LEAK'));
  let calls = 0;
  const large = createSupabaseStore({ url: 'https://test.supabase.co', secretKey: 'sb_secret_TEST', fetchImpl: async (_, options) => {
    const { p_payload } = JSON.parse(options.body); calls++;
    const start = p_payload.after ? Number(p_payload.after) + 1 : 0;
    return Response.json(Array.from({ length: Math.min(200, 1205 - start) }, (_, i) => ({ id: String(start + i), started_at: '2026-01-01T00:00:00Z' })));
  } });
  assert.equal((await large.list()).length, 1205);
  assert.equal(calls, 7);
});
