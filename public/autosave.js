const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Mantém mudanças remotas em campos não editados aqui. Em um mesmo campo,
// prevalece a edição local pendente, conforme a preferência do aplicador.
export function mergeAnswers(base, local, remote) {
  const merged = copy(remote);
  for (const id of new Set([...Object.keys(base), ...Object.keys(local)])) {
    const before = base[id] || {}, after = local[id] || {};
    if (equal(before, after)) continue;
    const answer = merged[id] ||= {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (equal(before[key], after[key])) continue;
      if (Object.hasOwn(after, key)) answer[key] = copy(after[key]);
      else delete answer[key];
    }
  }
  return merged;
}

export function createAutosave({ record, baseline = record.answers, pending = false, read, write,
  normalize = () => {}, onState = () => {}, onSync = () => {}, onClosed = () => {} }) {
  let base = copy(baseline), dirty = pending, generation = 0, running = null, requestedAction;
  const notify = (event, error) => onState({ event, dirty, error, record });
  async function drain() {
    let conflicts = 0, synchronizing = false;
    try {
      while (dirty || requestedAction) {
        const action = requestedAction, token = generation, sent = copy(record.answers);
        const payload = { revision: record.revision, answers: sent, position: record.position, ...(action ? { action } : {}) };
        notify('saving');
        try {
          const result = await write(record.id, payload);
          // Digitação/navegação durante a requisição não é perdida ao receber a confirmação.
          const answers = mergeAnswers(sent, record.answers, result.answers);
          const position = record.position;
          Object.assign(record, result, { answers, position });
          base = copy(result.answers);
          dirty = token !== generation;
          if (action === requestedAction) requestedAction = undefined;
          notify('saved');
          if (result.status !== 'in_progress') { dirty = false; requestedAction = undefined; break; }
        } catch (error) {
          if (error.status !== 409 || ++conflicts > 3) throw error;
          if (!synchronizing) { synchronizing = true; onSync(true); }
          const latest = await read(record.id);
          if (latest.deleted_at || latest.status !== 'in_progress') {
            // Não reabre nem sobrescreve uma entrevista encerrada por outra sessão.
            await onClosed(copy(record), latest);
            Object.assign(record, latest);
            base = copy(latest.answers); dirty = false; requestedAction = undefined;
            notify('closed');
            return false;
          }
          const position = record.position;
          const answers = mergeAnswers(base, record.answers, latest.answers);
          Object.assign(record, latest, { answers, position });
          base = copy(latest.answers);
          normalize(record);
          dirty = true;
          notify('rebased');
        }
      }
      return true;
    } catch (error) {
      dirty = true; requestedAction = undefined;
      notify('error', error);
      return false;
    } finally { if (synchronizing) onSync(false); }
  }
  return {
    get dirty() { return dirty; },
    get saving() { return running !== null; },
    snapshot: () => ({ ...copy(record), _syncBase: copy(base) }),
    markDirty() { dirty = true; generation++; notify('pending'); },
    flush(action) {
      if (action) requestedAction = action;
      // Todos os disparadores compartilham UMA fila. Nunca iniciam PATCHs concorrentes.
      if (!running) running = Promise.resolve().then(drain).finally(() => { running = null; });
      return running;
    },
  };
}
