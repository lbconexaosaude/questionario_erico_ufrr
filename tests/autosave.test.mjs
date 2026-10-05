import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave, mergeAnswers } from '../public/autosave.js';
import { validateAnswers } from '../server.mjs';

const initial = () => ({ id: 'test', revision: 0, status: 'in_progress', position: 2, answers: { q1: { value: 'Original' } } });
const conflict = () => Object.assign(new Error('Revision'), { status: 409 });
const deferred = () => Promise.withResolvers();

test('fila única preserva edições e navegação durante uma gravação lenta', async () => {
  const record = initial(), first = deferred(), started = deferred(), payloads = [];
  let active = 0, maximum = 0;
  const saver = createAutosave({ record, write: async (id, payload) => {
    maximum = Math.max(maximum, ++active); payloads.push(payload);
    if (payloads.length === 1) { started.resolve(); await first.promise; }
    active--;
    return { ...initial(), ...payload, revision: payload.revision + 1 };
  } });
  record.answers.q1.value = 'Primeira'; saver.markDirty();
  const flushing = saver.flush(); await started.promise;
  record.answers.q1.value = 'Última edição'; record.position = 3; saver.markDirty();
  const waiting = Array.from({ length: 10 }, () => saver.flush());
  first.resolve();
  assert.ok((await Promise.all([flushing, ...waiting])).every(Boolean));
  assert.equal(maximum, 1); assert.equal(payloads.length, 2);
  assert.equal(payloads[1].revision, 1);
  assert.equal(record.answers.q1.value, 'Última edição'); assert.equal(record.position, 3);
  assert.equal(saver.dirty, false);
});

test('reconcilia automaticamente conflitos por campo, mantendo a posição local', async () => {
  const record = initial(), sync = [], payloads = [];
  record.answers.q19 = { value: [1], detail: 'Antes' };
  const saver = createAutosave({ record, onSync: value => sync.push(value),
    read: async () => ({ ...initial(), revision: 5, position: 20, answers: {
      q1: { value: 'Edição remota do mesmo campo' }, q2: { value: 70 }, q19: { value: [2], detail: 'Outro detalhe' },
    } }),
    write: async (id, payload) => {
      payloads.push(payload); if (payload.revision === 0) throw conflict();
      return { ...record, ...payload, revision: payload.revision + 1 };
    },
  });
  record.answers.q1.value = 'Edição local'; record.answers.q19.value = [1, 3]; saver.markDirty();
  assert.equal(await saver.flush(), true);
  assert.deepEqual(sync, [true, false]); assert.equal(payloads.length, 2);
  assert.deepEqual(record.answers, { q1: { value: 'Edição local' }, q2: { value: 70 }, q19: { value: [1, 3], detail: 'Outro detalhe' } });
  assert.equal(record.position, 2); assert.equal(saver.dirty, false);
});

test('falha de rede após confirmação no banco recupera a cópia sem duplicar nem perder respostas', async () => {
  const record = initial(); let remote = structuredClone(record), lost = true;
  const write = async (id, payload) => {
    if (payload.revision !== remote.revision) throw conflict();
    remote = { ...remote, ...payload, revision: remote.revision + 1 };
    if (lost) { lost = false; throw new TypeError('Conexão interrompida'); }
    return structuredClone(remote);
  };
  const saver = createAutosave({ record, write });
  record.answers.q1.value = 'Resposta preservada'; saver.markDirty();
  assert.equal(await saver.flush(), false); assert.equal(saver.dirty, true);
  const snapshot = saver.snapshot();
  const restored = createAutosave({ record: snapshot, baseline: snapshot._syncBase, pending: true, write, read: async () => structuredClone(remote) });
  assert.equal(await restored.flush(), true);
  assert.equal(remote.answers.q1.value, 'Resposta preservada'); assert.equal(restored.dirty, false);
});

test('encerramento em outra sessão preserva a cópia pendente e não reabre entrevista', async () => {
  const record = initial(), sync = []; let recovery, writes = 0;
  const saver = createAutosave({ record, write: async () => { writes++; throw conflict(); },
    read: async () => ({ ...initial(), revision: 3, status: 'completed' }),
    onSync: value => sync.push(value), onClosed: local => { recovery = local; },
  });
  record.answers.q1.value = 'Ainda não salva'; saver.markDirty();
  assert.equal(await saver.flush(), false);
  assert.equal(recovery.answers.q1.value, 'Ainda não salva'); assert.equal(record.status, 'completed');
  assert.equal(saver.dirty, false); assert.equal(writes, 1); assert.deepEqual(sync, [true, false]);
});

test('tentativas limitadas fecham modal, preservam pendência e permitem tentar novamente', async () => {
  const record = initial(), sync = []; let writes = 0;
  const saver = createAutosave({ record, write: async () => { writes++; throw conflict(); },
    read: async () => ({ ...initial(), revision: writes }), onSync: value => sync.push(value),
  });
  record.answers.q1.value = 'Pendente'; saver.markDirty();
  assert.equal(await saver.flush(), false); assert.equal(writes, 4);
  assert.equal(saver.dirty, true); assert.equal(saver.saving, false); assert.deepEqual(sync, [true, false]);
  assert.equal(saver.snapshot().answers.q1.value, 'Pendente');
});

test('exclusão em outra aba interrompe autosave e preserva cópia sem restaurar o registro', async () => {
  const record = initial(); let recovery, writes = 0;
  const saver = createAutosave({ record,
    write: async () => { writes++; throw conflict(); },
    read: async () => ({ ...initial(), revision: 2, deleted_at: '2026-10-04T12:00:00Z' }),
    onClosed: local => { recovery = local; },
  });
  record.answers.q1.value = 'Pendente quando excluída'; saver.markDirty();
  assert.equal(await saver.flush(), false);
  assert.equal(writes, 1); assert.equal(saver.dirty, false);
  assert.equal(recovery.answers.q1.value, 'Pendente quando excluída');
  assert.ok(record.deleted_at); assert.equal(record.status, 'in_progress');
});

test('concluir durante salvamento aguarda a fila e envia a última revisão', async () => {
  const record = initial(), gate = deferred(), started = deferred(), actions = [];
  const saver = createAutosave({ record, write: async (id, payload) => {
    actions.push(payload.action);
    if (actions.length === 1) { started.resolve(); await gate.promise; }
    return { ...record, ...payload, revision: payload.revision + 1, status: payload.action === 'complete' ? 'completed' : 'in_progress' };
  } });
  saver.markDirty(); const first = saver.flush(); await started.promise;
  const complete = saver.flush('complete'); gate.resolve();
  assert.equal(await first, true); assert.equal(await complete, true);
  assert.deepEqual(actions, [undefined, 'complete']); assert.equal(record.revision, 2); assert.equal(record.status, 'completed');
});

test('limpar resposta local preserva alterações remotas de outras perguntas', () => {
  assert.deepEqual(mergeAnswers({ q1: { value: 'Antes' } }, { q1: {} }, { q1: { value: 'Remoto' }, q2: { value: 40 } }), { q1: {}, q2: { value: 40 } });
});

test('Q11.1, Q19 e Q27 aceitam múltiplas alternativas e respostas escalares anteriores', () => {
  for (const id of ['q11.1', 'q19', 'q27']) {
    assert.doesNotThrow(() => validateAnswers({ [id]: { value: [1, 2] } }));
    assert.doesNotThrow(() => validateAnswers({ [id]: { value: 1 } }));
    assert.throws(() => validateAnswers({ [id]: { value: [999] } }));
  }
});
