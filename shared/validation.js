function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function validateAnswers(answers, instrument) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) fail(400, 'Respostas inválidas.');
  for (const [id, a] of Object.entries(answers)) {
    const q = instrument.questions.find(q => q.id === id);
    if (!q && !['opening', 'checkpoint'].includes(id)) fail(400, 'Questão desconhecida.');
    if (!a || typeof a !== 'object' || Array.isArray(a)) fail(400, 'Formato de resposta inválido.');
    if (Object.keys(a).some(k => !['value', 'detail', 'events', 'religion', 'regular', 'frequency'].includes(k))) fail(400, 'Campo de resposta desconhecido.');
    for (const k of ['detail', 'religion', 'regular', 'frequency']) if (a[k] !== undefined && typeof a[k] !== 'string') fail(400, 'Complemento inválido.');
    if (a.events !== undefined && (!Array.isArray(a.events) || a.events.some(v => !Number.isInteger(v) || v < 1 || v > 9))) fail(400, 'Eventos inválidos.');
    if (a.value === undefined || a.value === null || a.value === '') continue;
    const type = q?.type || 'single';
    if (['single', 'events', 'religion'].includes(type)) {
      const allowed = q ? q.options.map(o => o.value) : [0, 1];
      if (!allowed.includes(a.value)) fail(400, 'Código de alternativa inválido.');
    } else if (type === 'multiple') {
      // Mantém compatibilidade com respostas escalares dos instrumentos anteriores.
      if (['q20', 'q11.1', 'q19', 'q27'].includes(id) && Number.isInteger(a.value) && q.options.some(o => o.value === a.value)) continue;
      if (!Array.isArray(a.value) || a.value.some(v => !q.options.some(o => o.value === v))) fail(400, 'Alternativas inválidas.');
    } else if (type === 'integer') {
      if (!Number.isSafeInteger(a.value) || a.value < 0) fail(400, 'Informe um número inteiro não negativo.');
    } else if (typeof a.value !== 'string') fail(400, 'Resposta textual inválida.');
  }
}
