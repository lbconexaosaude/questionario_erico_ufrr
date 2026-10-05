// Posições persistidas permanecem estáveis; a navegação ignora somente etapas não aplicáveis.
export function buildFlow(instrument) {
  const steps = [{ id: 'opening', type: 'gate' }];
  for (const section of instrument.sections) {
    steps.push({ id: `section-${section.id}`, type: 'section', section: section.id });
    for (const q of instrument.questions.filter(q => q.section === section.id)) {
      steps.push({ id: q.id, type: 'question', section: section.id });
      if (q.id === 'q26') steps.push({ id: 'checkpoint', type: 'gate' });
    }
  }
  steps.push({ id: 'review', type: 'review' });
  return steps;
}

export function isApplicable(id, answers = {}, version = '1.4') {
  const value = key => answers[key]?.value;
  if (id === 'q7.1') return value('q7') === (version === '1.2' ? 0 : 1);
  if (id === 'q11.1') return value('q11') === 1;
  const skipOnNo = { q13: 'q12', q14: 'q12', q16: 'q15', q19: 'q18', q23: 'q22', q24: 'q22', q26: 'q25' };
  if (skipOnNo[id]) return value(skipOnNo[id]) !== 0;
  if (id === 'q21') {
    const selected = Array.isArray(value('q20')) ? value('q20') : [value('q20')];
    return !selected.some(v => v === 0 || v === 1);
  }
  return true;
}

export function movePosition(flow, position, answers, direction = 1) {
  let next = position;
  do { next += direction; } while (next > 0 && next < flow.length - 1 && !isApplicable(flow[next].id, answers));
  return Math.max(0, Math.min(next, flow.length - 1));
}

export function normalizePosition(flow, position, answers) {
  return isApplicable(flow[position]?.id, answers) ? position : movePosition(flow, position, answers);
}
