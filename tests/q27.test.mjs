import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { flow, validateAnswers } from '../server.mjs';
import { prepareImport } from '../shared/spreadsheet.js';

const instrument = JSON.parse(fs.readFileSync(new URL('../public/questionnaire.json', import.meta.url), 'utf8'));

test('Q27: importação de múltiplas respostas e de CSV antigo com resposta escalar', () => {
  const result = prepareImport({ cells: [
    ['q1', 'q27', 'q27_detail', 'instrument_version'],
    ['Múltipla', '1,3,5', 'Outra ocupação', '1.4'],
    ['Anterior', '{"value":2}', '', '1.3'],
    ['Inválida', '1,99', '', '1.4'],
  ] }, instrument, flow, validateAnswers);
  assert.equal(result.errors.length, 1); assert.equal(result.errors[0].line, 4);
  assert.deepEqual(result.rows[0].answers.q27, { value: [1, 3, 5], detail: 'Outra ocupação' });
  assert.equal(result.rows[1].answers.q27.value, 2);
  assert.equal(result.rows[1].instrument_version, '1.3');
});

test('SQL 007: migração Q27 preserva histórico, salva listas e recusa alternativas inválidas', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    insert into auth.users values ('11111111-1111-1111-1111-111111111111','test@example.test',now());`);
  const sql = file => fs.readFileSync(new URL('../sql/' + file, import.meta.url), 'utf8');
  for (const file of ['001_Qest_supabase.sql', '003_Qest_acesso_web.sql']) await pg.exec(sql(file));
  await pg.exec(`insert into public."Qest_access"(email) values ('test@example.test');
    update public."Qest_web_config" set instrument=jsonb_set(jsonb_set(instrument,'{questions,q27,type}','"single"'),'{version}','"1.3"');`);
  const rpc = async (op, payload = {}) => (await pg.query('select public."Qest_web"($1,$2::jsonb) as data', [op, JSON.stringify(payload)])).rows[0].data;
  const old = await rpc('create');
  const closed = await rpc('save', { id: old.id, revision: 0, position: 65, action: 'complete', answers: { opening: { value: 1 }, checkpoint: { value: 1 }, q27: { value: 2 } } });
  await pg.exec(sql('007_Qest_q27_multiplas_respostas.sql'));
  await pg.exec(sql('007_Qest_q27_multiplas_respostas.sql'));
  await pg.exec('set role authenticated');
  assert.deepEqual(await rpc('get', { id: old.id }), closed, 'Migração não altera entrevista encerrada');
  let record = await rpc('create');
  assert.equal(record.instrument_version, '1.4');
  const position = flow.findIndex(s => s.id === 'q27');
  const save = answers => rpc('save', { id: record.id, revision: record.revision, position, answers: { opening: { value: 1 }, checkpoint: { value: 1 }, ...answers } });
  record = await save({ q27: { value: [1, 3, 5], detail: 'Outra ocupação' } });
  assert.deepEqual(record.answers.q27, { value: [1, 3, 5], detail: 'Outra ocupação' });
  await assert.rejects(() => save({ q27: { value: [1, 99] } }), e => e.code === 'PT400');
  record = await save({ q27: { value: 2 } });
  assert.equal(record.answers.q27.value, 2, 'Resposta antiga permanece válida');
  const imported = await rpc('import', { rows: [{ code: 'OLD-Q27', instrument_version: '1.3', interviewer: '', status: 'completed', position: 65, answers: closed.answers, fingerprint: 'a'.repeat(64) }] });
  assert.equal(imported.imported, 1);
  assert.equal((await rpc('get', { id: imported.ids[0] })).instrument_version, '1.3');
});
