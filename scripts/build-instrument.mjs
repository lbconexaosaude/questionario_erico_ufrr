import fs from 'node:fs';

// O texto integral é extraído do Word, nunca reescrito por componentes.
const paragraphs = JSON.parse(fs.readFileSync(new URL('../data/instrument-source.json', import.meta.url), 'utf8'));
const sections = [
  ['identification', 'IDENTIFICAÇÃO E DADOS DEMOGRÁFICOS', 'Identificação e dados demográficos', 'Q1 — Q7.1'],
  ['family', 'CONTEXTO FAMILIAR', 'Contexto familiar', 'Q8 — Q11.1'],
  ['mental', 'HISTÓRICO DE SAÚDE MENTAL', 'Histórico de saúde mental', 'Q12 — Q19'],
  ['health', 'COMORBIDADES E HÁBITOS', 'Comorbidades e hábitos', 'Q20 — Q26'],
  ['work', 'ASPECTOS LABORAIS/FINANCEIROS', 'Aspectos laborais/financeiros', 'Q27 — Q32'],
  ['social', 'CONTEXTO SOCIAL', 'Contexto social', 'Q33 — Q39'],
  ['history', 'ANTECEDENTES E HISTÓRIA ATUAL', 'Antecedentes e história atual', 'Q40 — Q53'],
].map(([id, sourceTitle, title, range]) => ({ id, sourceTitle, title, range }));
const opening = paragraphs.find(p => p.startsWith('Você se sente à vontade para responder'));
const checkpoint = paragraphs.find(p => p.startsWith('Você se sente à vontade para continuar'));
let section;
const collected = [];
for (const p of paragraphs) {
  const heading = sections.find(s => s.sourceTitle === p.trim());
  if (heading) { section = heading.id; continue; }
  if (!section || !p.trim() || p === checkpoint) continue;
  // Algumas questões compartilham o mesmo parágrafo no documento.
  for (const fragment of p.split(/(?=Q\d+(?:\.\d+)?[.\s])/u)) {
    const match = fragment.match(/^Q(\d+(?:\.\d+)?)(?:\.|\s)/u);
    if (match) collected.push({ id: `q${match[1]}`, number: `Q${match[1]}`, section, text: fragment.trim() });
    else if (collected.length) collected.at(-1).text += '\n' + fragment.trim();
  }
}
const numeric = ['q2', 'q7.1', 'q14', 'q21', 'q24'];
const free = ['q1', 'q13', 'q26'];
const long = ['q32', 'q49', 'q50', 'q51'];
const details = {
  q3: [3, 'Outros:'], q11: null, 'q11.1': [5, 'Outros:'], q19: [6, 'outros'],
  q27: [5, 'Outra:'], q28: [1, 'Se sim, qual mudança?'], q30: [1, 'Se sim, quais?'],
  q34: [1, 'Quais?'], q35: [1, 'Se sim, descreva (ex.: passou a se isolar, parou de sair):'],
  q36: [1, 'Quem?'], q38: [1, 'Se sim, descrever brevemente:'],
  q39: [1, 'Se sim, o que mudou? (ex.: mais triste, irritado, agitado, apático, dormindo demais, etc.)'],
  q40: [1, 'Se sim, descreva:'], q44: [4, 'Outro:'], q52: [5, 'Outro:'],
};
function options(text) {
  return [...text.matchAll(/\((\d+)\)\s*([\s\S]*?)(?=\(\d+\)|$)/g)].map(m => ({
    value: Number(m[1]), label: m[2].split(/\s*Se sim[.,]|\s*Quais\?|\s*Quem\?/u)[0].replace(/_+/g, '').replace(/\s*\|\s*$/, '').trim(),
  }));
}
const questions = collected.map(q => {
  if (q.id === 'q20') q = { ...q, text: q.text.replace(' (Marque 0 para Não / 1 para Sim):', '') };
  const type = numeric.includes(q.id) ? 'integer' : free.includes(q.id) ? 'text' : long.includes(q.id) ? 'long_text' : q.id === 'q31' ? 'events' : ['q11.1', 'q19', 'q20', 'q37', 'q48'].includes(q.id) ? 'multiple' : q.id === 'q34.1' ? 'religion' : 'single';
  const result = { ...q, type, prompt: q.text.split(/\(\d+\)/)[0].replace(/_+/g, '').replace(/\s*\|\s*$/, '').trim() };
  if (['single', 'multiple', 'events', 'religion', 'provisional'].includes(type)) result.options = options(q.text);
  if (q.id === 'q11') result.options = [{ value: 0, label: 'Não' }, { value: 1, label: 'Sim' }];
  if (q.id === 'q31') { result.events = result.options.slice(2); result.options = result.options.slice(0, 2); result.options[1].label = 'Sim'; }
  if (q.id === 'q34.1') result.options = [{ value: 0, label: 'Não' }, { value: 1, label: 'sim.' }];
  if (q.id === 'q53') result.options[1].label = 'Sim.';
  if (details[q.id]) result.detail = { when: details[q.id][0], label: details[q.id][1] };
  if (q.id === 'q37') result.detail = { when: 7, label: 'Outra característica marcante:' };
  if (q.id === 'q20') result.detail = { when: 12, label: 'Outra' };
  if (q.id === 'q48') result.detail = { when: 6, label: 'Outras:' };
  return result;
});
if (questions.length !== 56 || new Set(questions.map(q => q.id)).size !== 56) throw new Error('Contagem inesperada de questões');
const instrument = { version: '1.3', title: paragraphs[0].trim(), sections, opening, checkpoint, questions };
fs.writeFileSync(new URL('../public/questionnaire.json', import.meta.url), JSON.stringify(instrument, null, 2) + '\n');
console.log(`${questions.length} questões e subquestões preservadas em sete blocos.`);
