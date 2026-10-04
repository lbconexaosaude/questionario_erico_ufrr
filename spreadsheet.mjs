import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { isApplicable, normalizePosition } from './public/flow.js';

const metadata = ['id', 'code', 'instrument_version', 'interviewer', 'status', 'position', 'started_at', 'updated_at', 'ended_at'];
const statuses = ['in_progress', 'completed', 'interrupted_opening', 'interrupted_checkpoint'];
const empty = value => value === undefined || value === null || value === '';

export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; closed = false;
    } else {
      if (closed && c.trim()) throw new Error('CSV inválido: conteúdo após o fechamento das aspas.');
      if (!closed) cell += c;
    }
  }
  if (quoted) throw new Error('CSV inválido: aspas sem fechamento.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function parseSpreadsheet({ filename, content }) {
  if (typeof filename !== 'string' || typeof content !== 'string' || !/\.(xlsx|csv)$/i.test(filename)) throw new Error('Selecione um arquivo .xlsx ou .csv. Para .xls, salve como .xlsx no Excel.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Arquivo inválido.');
  const buffer = Buffer.from(content, 'base64');
  if (!buffer.length || buffer.length > 5_000_000) throw new Error('Use um arquivo de até 5 MB.');
  if (/\.csv$/i.test(filename)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder('windows-1252').decode(buffer); }
    return { sheet: filename, cells: parseCSV(text) };
  }
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer, { ignoreNodes: ['dataValidations', 'drawing', 'picture', 'extLst'] }); }
  catch { throw new Error('Não foi possível ler o Excel. Verifique se é um arquivo .xlsx válido, sem senha.'); }
  const sheet = workbook.getWorksheet('Entrevistas') || workbook.worksheets[0];
  if (!sheet) throw new Error('O arquivo não contém uma planilha.');
  if (sheet.rowCount > 501 || sheet.columnCount > 200) throw new Error('Importe até 500 entrevistas e 200 colunas por arquivo.');
  const cells = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    const values = [];
    for (let n = 1; n <= sheet.columnCount; n++) {
      const v = row.getCell(n).value;
      if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) throw new Error(`Célula ${row.getCell(n).address}: substitua a fórmula pelo seu valor antes de importar.`);
      if (v instanceof Date) values.push(v.toISOString());
      else if (v?.richText) values.push(v.richText.map(r => r.text).join(''));
      else if (v && typeof v === 'object') throw new Error(`Célula ${row.getCell(n).address}: use texto, número ou data.`);
      else values.push(v ?? '');
    }
    cells.push(values);
  });
  return { sheet: sheet.name, cells };
}

function dateValue(value, name) {
  if (empty(value)) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name}: use uma data do Excel ou formato ISO (AAAA-MM-DD).`);
  return new Date(value).toISOString();
}

function parseAnswer(value, question) {
  if (empty(value)) return undefined;
  let parsed = value;
  if (typeof value === 'string' && (/^\{\s*"(?:value|detail|events|religion|regular|frequency)"\s*:/.test(value.trim()) || value.trim() === '{}' || question.type === 'multiple' && value.trim().startsWith('['))) {
    try { parsed = JSON.parse(value); } catch { throw new Error(`${question.id}: JSON de resposta inválido.`); }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  if (question.type === 'multiple') {
    if (Array.isArray(parsed)) return { value: parsed };
    const codes = String(parsed).split(/[;,|]/).map(v => v.trim());
    if (codes.some(v => !/^\d+$/.test(v))) throw new Error(`${question.id}: separe os códigos por vírgula, por exemplo 2,3.`);
    return { value: [...new Set(codes.map(Number))] };
  }
  if (['single', 'events', 'religion', 'integer'].includes(question.type)) {
    if (!/^\d+$/.test(String(parsed).trim())) throw new Error(`${question.id}: use o código numérico da alternativa ou um número inteiro.`);
    return { value: Number(parsed) };
  }
  return { value: String(parsed) };
}

export function prepareImport({ cells }, instrument, flow, validateAnswers) {
  const errors = [], rows = [];
  if (!cells.length || cells.length > 501) return { rows, errors: [{ line: 1, message: 'Use uma linha de cabeçalhos e até 500 entrevistas.' }] };
  const headers = cells[0].map(v => String(v ?? '').trim().toLowerCase());
  const questions = [...instrument.questions, { id: 'opening', type: 'single' }, { id: 'checkpoint', type: 'single' }];
  const known = new Set([...metadata, ...questions.map(q => q.id), ...questions.flatMap(q => {
    const fields = q.detail ? ['detail'] : [];
    if (q.type === 'events') fields.push('events', 'detail');
    if (q.type === 'religion') fields.push('religion', 'regular', 'frequency');
    return fields.map(field => `${q.id}_${field}`);
  })]);
  const nonemptyHeaders = headers.filter(Boolean);
  if (!headers.includes('q1') || nonemptyHeaders.some(h => !known.has(h)) || new Set(nonemptyHeaders).size !== nonemptyHeaders.length) {
    return { rows, errors: [{ line: 1, message: 'Cabeçalhos inválidos. Inclua q1 e use os nomes do modelo ou da exportação CSV, sem colunas repetidas. Colunas desconhecidas: ' + nonemptyHeaders.filter(h => !known.has(h)).join(', ') }] };
  }
  for (let index = 1; index < cells.length; index++) {
    const values = cells[index];
    if (!values.some(v => !empty(v))) continue;
    try {
      if (values.some((v, n) => !empty(v) && !headers[n])) throw new Error('Há dados em uma coluna sem cabeçalho.');
      const r = Object.fromEntries(headers.filter(Boolean).map(h => [h, values[headers.indexOf(h)]]));
      const answers = {};
      for (const q of questions) {
        const a = parseAnswer(r[q.id], q);
        if (a) answers[q.id] = a;
        for (const field of ['detail', 'events', 'religion', 'regular', 'frequency']) {
          const v = r[`${q.id}_${field}`];
          if (!empty(v)) {
            const answer = answers[q.id] ||= {};
            if (field === 'events') {
              const codes = String(v).split(/[;,|]/).map(v => v.trim());
              if (codes.some(v => !/^\d+$/.test(v))) throw new Error(`${q.id}_events: use códigos separados por vírgula.`);
              answer.events = [...new Set(codes.map(Number))];
            } else answer[field] = String(v);
          }
        }
      }
      validateAnswers(answers);
      const status = empty(r.status) ? 'in_progress' : String(r.status).trim();
      if (!statuses.includes(status)) throw new Error('Situação inválida. Use in_progress, completed, interrupted_opening ou interrupted_checkpoint.');
      if (status === 'completed' && (answers.opening?.value !== 1 || answers.checkpoint?.value !== 1)) throw new Error('Entrevista concluída exige opening=1 e checkpoint=1.');
      if (status === 'interrupted_opening' && answers.opening?.value !== 0) throw new Error('Interrompida na abertura exige opening=0.');
      if (status === 'interrupted_checkpoint' && (answers.opening?.value !== 1 || answers.checkpoint?.value !== 0)) throw new Error('Interrompida na pausa exige opening=1 e checkpoint=0.');
      const checkpoint = flow.findIndex(s => s.id === 'checkpoint');
      let position = 0;
      if (status === 'completed') position = flow.length - 1;
      else if (status === 'interrupted_checkpoint') position = checkpoint;
      else if (status === 'in_progress') {
        if (!empty(r.position)) {
          position = Number(r.position);
          if (!Number.isInteger(position) || position < 0 || position >= flow.length) throw new Error('Posição de retomada inválida.');
          if (position > 0 && answers.opening?.value !== 1 || position > checkpoint && answers.checkpoint?.value !== 1) throw new Error('A posição ultrapassa uma pergunta de continuidade sem resposta Sim.');
          position = normalizePosition(flow, position, answers);
        } else if (answers.opening?.value === 1) {
          position = flow.findIndex((s, i) => i > 0 && isApplicable(s.id, answers) && (
            s.id === 'checkpoint' && answers.checkpoint?.value !== 1 || s.type === 'question' && empty(answers[s.id]?.value) || s.type === 'review'
          ));
        }
      }
      const code = empty(r.code) ? '' : String(r.code).trim();
      if (code && !/^[\w.-]{1,100}$/.test(code)) throw new Error('Código inválido: use até 100 letras, números, pontos ou hífens.');
      const interviewer = empty(r.interviewer) ? '' : String(r.interviewer);
      if (interviewer.length > 200) throw new Error('Aplicador deve ter até 200 caracteres.');
      const version = empty(r.instrument_version) ? instrument.version : String(r.instrument_version);
      if (!['1.0-original', '1.1', '1.2', instrument.version].includes(version)) throw new Error('Versão de instrumento desconhecida.');
      rows.push({ line: index + 1, code, interviewer, status, position, instrument_version: version, answers,
        started_at: dateValue(r.started_at, 'started_at'), updated_at: dateValue(r.updated_at, 'updated_at'), ended_at: dateValue(r.ended_at, 'ended_at') });
    } catch (e) { errors.push({ line: index + 1, message: e.message }); }
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, message: 'A planilha não contém entrevistas preenchidas.' });
  return { rows, errors };
}

export function importFingerprint(row) {
  function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify(sort({ line: row.line, code: row.code, interviewer: row.interviewer, status: row.status, started_at: row.started_at, answers: row.answers }))).digest('hex');
}

export async function createTemplate(instrument) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Entrevistas');
  const headers = ['code', 'interviewer', 'status', 'started_at', 'opening'];
  for (const q of instrument.questions) {
    headers.push(q.id);
    if (q.detail || q.type === 'events') headers.push(`${q.id}_detail`);
    if (q.type === 'events') headers.push(`${q.id}_events`);
    if (q.type === 'religion') headers.push(...['religion', 'regular', 'frequency'].map(k => `${q.id}_${k}`));
  }
  headers.push('checkpoint');
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF205C65' } };
  sheet.columns.forEach(column => { column.width = 23; column.numFmt = '@'; });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const guide = workbook.addWorksheet('Instruções');
  guide.columns = [{ width: 25 }, { width: 110 }];
  const instructions = [
    ['Como preencher', 'Uma entrevista por linha na aba Entrevistas. Não altere os nomes dos cabeçalhos. Até 500 entrevistas e 5 MB.'],
    ['code', 'Opcional. Se vazio, o sistema gera um código. Códigos já cadastrados são ignorados, sem sobrescrever registros.'],
    ['interviewer', 'Nome ou código do aplicador; opcional.'],
    ['status', 'in_progress (padrão), completed, interrupted_opening, interrupted_checkpoint.'],
    ['started_at', 'Data do Excel ou texto ISO: 2026-10-03T14:00:00-04:00. Se vazio, utiliza o horário da importação.'],
    ['opening / checkpoint', 'Código 0 ou 1. Para completed, ambos precisam ser 1. Não invente respostas de continuidade.'],
    ['Questões', 'Use códigos numéricos nas alternativas; texto nas questões abertas. Campos vazios permanecem sem resposta.'],
    ['Q11.1, Q19, Q20, Q37 e Q48', 'Múltipla escolha: códigos separados por vírgula, por exemplo 2,3.'],
    ['Q31', 'q31: 0 ou 1; q31_events: códigos separados por vírgula; q31_detail: texto de Outros.'],
    ['Complementos', 'Colunas com final _detail recebem o texto complementar. Q34.1 tem religion, regular e frequency.'],
    ['CSV exportado', 'Também é possível importar o CSV exportado pelo sistema, inclusive respostas JSON nas células.'],
    ['Fórmulas', 'Cole como valores antes de importar. Arquivos .xls devem ser salvos como .xlsx.'],
  ];
  guide.addRows(instructions);
  guide.addRow(['Instrumento', `Versão ${instrument.version}`]);
  for (const q of instrument.questions) guide.addRow([q.id, q.text]);
  guide.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
