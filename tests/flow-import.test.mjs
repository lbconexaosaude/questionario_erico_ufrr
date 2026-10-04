import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { createApp, flow } from '../server.mjs';
import { isApplicable, movePosition, normalizePosition } from '../public/flow.js';
import { parseCSV } from '../spreadsheet.mjs';

const instrument = JSON.parse(fs.readFileSync(new URL('../public/questionnaire.json', import.meta.url)));
const position = id => flow.findIndex(s => s.id === id);

test('todos os saltos: ida, volta, perguntas em branco e checkpoint obrigatório', () => {
  const cases = [
    ['q7', 0, 'q7.1', false], ['q7', 1, 'q7.1', true], ['q7', undefined, 'q7.1', false],
    ['q11', 1, 'q11.1', true], ['q11', 0, 'q11.1', false], ['q11', undefined, 'q11.1', false],
    ['q12', 0, 'q13', false], ['q12', 0, 'q14', false], ['q12', 1, 'q13', true], ['q12', undefined, 'q14', true],
    ['q15', 0, 'q16', false], ['q15', 1, 'q16', true], ['q18', 0, 'q19', false], ['q18', 1, 'q19', true],
    ['q20', [0], 'q21', false], ['q20', [1], 'q21', false], ['q20', [0, 2], 'q21', false],
    ['q20', [2, 3], 'q21', true], ['q20', [], 'q21', true], ['q20', 0, 'q21', false],
    ['q22', 0, 'q23', false], ['q22', 0, 'q24', false], ['q22', 1, 'q24', true],
    ['q25', 0, 'q26', false], ['q25', 1, 'q26', true],
  ];
  for (const [parent, value, child, expected] of cases) assert.equal(isApplicable(child, { [parent]: { value } }), expected, `${parent}=${value} → ${child}`);
  const answers = { q12: { value: 0 }, q25: { value: 0 } };
  assert.equal(flow[movePosition(flow, position('q12'), answers)].id, 'q15');
  assert.equal(flow[movePosition(flow, position('q15'), answers, -1)].id, 'q12');
  assert.equal(flow[movePosition(flow, position('q25'), answers)].id, 'checkpoint');
  assert.equal(flow[movePosition(flow, position('checkpoint'), answers, -1)].id, 'q25');
  assert.equal(flow[normalizePosition(flow, position('q26'), answers)].id, 'checkpoint');
  for (const id of ['q11.1', 'q19', 'q20']) assert.equal(instrument.questions.find(q => q.id === id).type, 'multiple');
  assert.equal(isApplicable('q7.1', { q7: { value: 0 } }, '1.2'), true, 'Consulta histórica conserva a regra original');
});

test('CSV: aspas, acentos, quebra de linha e campos vazios', () => {
  assert.deepEqual(parseCSV('\ufeffq1;q49;q20\r\n"Érico; teste";"Linha 1\nLinha ""2""";"2,3"'), [['q1', 'q49', 'q20'], ['Érico; teste', 'Linha 1\nLinha "2"', '2,3']]);
  assert.deepEqual(parseCSV('q1,q2\nAna,\n'), [['q1', 'q2'], ['Ana', '']]);
  assert.throws(() => parseCSV('q1\n"sem fim'));
});

test('importação Excel/CSV: prévia, confirmação, duplicadas, atomicidade e preservação', async t => {
  const server = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, body) => {
    const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const preview = (filename, content) => call('/api/import/preview', { filename, content: Buffer.from(content).toString('base64') });
  const template = await fetch(base + '/api/import/template');
  assert.equal(template.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await template.arrayBuffer());
  const sheet = workbook.getWorksheet('Entrevistas');
  assert.ok(workbook.getWorksheet('Instruções'));
  const headers = sheet.getRow(1).values.slice(1);
  const values = { code: 'IMPORT-01', interviewer: 'Aplicador', q1: 'Pessoa <teste>', status: 'completed', opening: 1, checkpoint: 1, q7: 0, 'q7.1': 12, q20: '2,3,12', q20_detail: 'Complemento', q31: 1, q31_events: '1,9', q31_detail: 'Evento', q48: '2,6', q48_detail: 'Outro motivo', q49: 'Linha 1\nLinha 2' };
  sheet.addRow(headers.map(h => values[h] ?? ''));
  const buffer = await workbook.xlsx.writeBuffer();
  const p = await preview('dados.xlsx', buffer);
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.errors, []);
  assert.equal(p.body.ready, 1);
  assert.equal((await call('/api/interviews')).body.length, 0, 'Prévia não grava dados');
  const committed = await call('/api/import/commit', { token: p.body.token });
  assert.equal(committed.body.imported, 1);
  let records = (await call('/api/interviews')).body;
  assert.deepEqual(records[0].answers.q20.value, [2, 3, 12]);
  assert.deepEqual(records[0].answers.q31.events, [1, 9]);
  assert.equal(records[0].answers.q49.value, 'Linha 1\nLinha 2');
  assert.equal(records[0].answers.q20.detail, 'Complemento');
  assert.equal(records[0].code, 'IMPORT-01');
  const again = await preview('dados.xlsx', buffer);
  assert.equal(again.body.duplicates, 1);
  assert.equal((await call('/api/import/commit', { token: again.body.token })).body.imported, 0);
  assert.equal((await call('/api/interviews')).body.length, 1);
  assert.equal((await call('/api/import/commit', { token: p.body.token })).status, 400, 'Token só pode ser usado uma vez');

  const invalid = await preview('erros.csv', 'code;q1;q4\nVALIDA;Pessoa;1\nINVALIDA;Outra;99');
  assert.equal(invalid.body.errors.length, 1);
  assert.equal(invalid.body.errors[0].line, 3);
  assert.equal((await call('/api/import/commit', { token: invalid.body.token })).status, 400);
  assert.equal((await call('/api/interviews')).body.length, 1, 'Importação com erro não grava parcialmente');
  const badCompleted = await preview('erro.csv', 'q1;status\nTeste;completed');
  assert.match(badCompleted.body.errors[0].message, /opening=1/);
  const unknown = await preview('colunas.csv', 'q1;coluna_desconhecida\nTeste;Resposta');
  assert.equal(unknown.body.errors.length, 1);
  const csv = 'code;instrument_version;status;opening;checkpoint;q1;q20;q48\nCSV-01;1.1;completed;"{""value"":1}";"{""value"":1}";"{""value"":""Antiga""}";"{""value"":2}";"{""value"":[1,3]}"';
  const legacy = await preview('exportacao.csv', csv);
  assert.deepEqual(legacy.body.errors, []);
  await call('/api/import/commit', { token: legacy.body.token });
  records = (await call('/api/interviews')).body;
  assert.equal(records.find(r => r.code === 'CSV-01').answers.q20.value, 2, 'Q20 antiga escalar preservada');
  assert.equal(records.find(r => r.code === 'CSV-01').instrument_version, '1.1');
  const formulaWorkbook = new ExcelJS.Workbook(), ws = formulaWorkbook.addWorksheet('Entrevistas');
  ws.addRow(['q1']); ws.addRow([{ formula: '1+1', result: 2 }]);
  const formula = await preview('formula.xlsx', await formulaWorkbook.xlsx.writeBuffer());
  assert.equal(formula.status, 400);
  assert.match(formula.body.error, /fórmula/);

  const blankCode = await preview('novas.csv', 'q1;opening;q7\nIguais;1;0\nIguais;1;0');
  assert.equal(blankCode.body.ready, 2, 'Linhas distintas sem código não são fundidas');
  const added = await call('/api/import/commit', { token: blankCode.body.token });
  assert.equal(added.body.imported, 2);
  const repeated = await preview('novas.csv', 'q1;opening;q7\nIguais;1;0\nIguais;1;0');
  assert.equal(repeated.body.duplicates, 2);
});

test('API: Q20 múltipla, posição pulada recusada e dados anteriores preservados', async t => {
  const server = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let i = await fetch(base + '/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
  const patch = async (answers, id) => {
    const response = await fetch(base + '/api/interviews/' + i.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: i.revision, position: position(id), answers }) });
    const result = await response.json(); if (response.ok) i = result;
    return response.status;
  };
  assert.equal(await patch({ opening: { value: 1 }, q12: { value: 1 }, q13: { value: 'Preservar' }, q20: { value: [2, 3] }, q21: { value: 36 } }, 'q21'), 200);
  assert.equal(await patch({ q12: { value: 0 }, q20: { value: [0] } }, 'q20'), 200);
  assert.equal(i.answers.q13.value, 'Preservar');
  assert.equal(i.answers.q21.value, 36);
  assert.equal(await patch({}, 'q13'), 400);
  assert.equal(await patch({}, 'q21'), 400);
  assert.equal(await patch({ q25: { value: 0 } }, 'checkpoint'), 200);
});
