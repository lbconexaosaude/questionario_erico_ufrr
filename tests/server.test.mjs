import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, flow } from '../server.mjs';

test('instrumento: numeração, alterações autorizadas e códigos originais', () => {
  const q = JSON.parse(fs.readFileSync(new URL('../public/questionnaire.json', import.meta.url)));
  assert.equal(q.sections.length, 7);
  assert.equal(q.questions.length, 56);
  for (let n = 1; n <= 53; n++) assert.ok(q.questions.some(q => q.id === `q${n}`));
  for (const id of ['q7.1', 'q11.1', 'q34.1']) assert.ok(q.questions.some(q => q.id === id));
  const q20 = q.questions.find(q => q.id === 'q20');
  assert.equal(q20.text.includes('Marque 0 para Não'), false);
  assert.deepEqual(q20.options.map(o => o.value), Array.from({ length: 13 }, (_, i) => i));
  assert.equal(q20.options[1].label, 'não sabe informar');
  assert.equal(q.questions.find(q => q.id === 'q48').type, 'multiple');
  assert.equal(q.questions.find(q => q.id === 'q31').events.length, 9);
  assert.equal(flow[flow.findIndex(s => s.id === 'q26') + 1].id, 'checkpoint');
});

test('persistência, continuidade, edição, conflitos e encerramento', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ufrr-test-'));
  const dbPath = path.join(directory, 'test.sqlite');
  let server = createApp({ dbPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async () => (await call('/api/interviews', 'POST', { interviewer: 'Teste automatizado' })).body;
  const patch = (i, values) => call(`/api/interviews/${i.id}`, 'PATCH', { revision: i.revision, answers: i.answers, position: i.position, ...values });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  let interview = await create();
  assert.equal(interview.status, 'in_progress');
  assert.match(interview.code, /^BIO-\d{4}-000001$/);
  assert.equal((await patch(interview, { position: 2 })).status, 400);
  assert.equal((await patch(interview, { action: 'complete' })).status, 400);
  assert.equal((await patch(interview, { answers: { q4: { value: 99 } } })).status, 400);
  const answers = { opening: { value: 1 }, q1: { value: 'Participante de teste' }, q3: { value: 3, detail: 'Texto preservado' }, q31: { value: 1, events: [2, 9], detail: 'Evento descrito' }, q48: { value: [1, 3, 6], detail: 'Outro motivo' } };
  interview = (await patch(interview, { answers, position: flow.findIndex(s => s.id === 'q26') })).body;
  assert.equal(interview.answers.q48.value.length, 3);
  assert.equal(interview.revision, 1);
  assert.equal((await patch(interview, { revision: 0 })).status, 409);
  const changed = structuredClone(interview.answers); changed.q3.value = 1; changed.q31.value = 0;
  interview = (await patch(interview, { answers: changed })).body;
  assert.equal(interview.answers.q3.detail, 'Texto preservado');
  assert.equal(interview.answers.q31.detail, 'Evento descrito');
  const q27 = flow.findIndex(s => s.id === 'q27');
  assert.equal((await patch(interview, { position: q27 })).status, 400);
  await new Promise(resolve => server.close(resolve));
  server = createApp({ dbPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const restored = (await call(`/api/interviews/${interview.id}`)).body;
  assert.deepEqual(restored, interview);
  interview = (await patch(interview, { answers: { ...interview.answers, checkpoint: { value: 1 } }, position: flow.length - 1, action: 'complete' })).body;
  assert.equal(interview.status, 'completed');
  assert.ok(interview.ended_at);
  assert.equal((await patch(interview, { answers: {} })).status, 409);
  for (const gate of ['opening', 'checkpoint']) {
    let i = await create();
    i = (await patch(i, { answers: gate === 'opening' ? { opening: { value: 0 } } : { opening: { value: 1 }, q17: { value: 0 }, checkpoint: { value: 0 } }, position: flow.findIndex(s => s.id === gate), action: 'interrupt' })).body;
    assert.equal(i.status, `interrupted_${gate}`);
    if (gate === 'checkpoint') assert.equal(i.answers.q17.value, 0);
    assert.equal((await patch(i, {})).status, 409);
  }
  assert.equal((await call('/api/interviews', 'POST', {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await call('/api/interviews')).body.length, 3);
});
