import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSQLiteStore } from './lib/sqlite-store.mjs';
import { configuredStore, loadLocalEnv } from './lib/config.mjs';
import { buildFlow, isApplicable } from './public/flow.js';
import { parseSpreadsheet, prepareImport, createTemplate, importFingerprint } from './spreadsheet.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const instrument = JSON.parse(fs.readFileSync(path.join(root, 'public/questionnaire.json'), 'utf8'));
export const flow = buildFlow(instrument);
const checkpointIndex = flow.findIndex(s => s.id === 'checkpoint');
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

export function validateAnswers(answers) {
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
      if (['q20', 'q11.1', 'q19'].includes(id) && Number.isInteger(a.value) && q.options.some(o => o.value === a.value)) continue;
      if (!Array.isArray(a.value) || a.value.some(v => !q.options.some(o => o.value === v))) fail(400, 'Alternativas inválidas.');
    } else if (type === 'integer') {
      if (!Number.isSafeInteger(a.value) || a.value < 0) fail(400, 'Informe um número inteiro não negativo.');
    } else if (typeof a.value !== 'string') fail(400, 'Resposta textual inválida.');
  }
}

export function createApp({ dbPath, store: suppliedStore } = {}) {
  const store = suppliedStore || (dbPath !== undefined ? createSQLiteStore(dbPath) : configuredStore());
  const previews = new Map();
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      if (!/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) fail(403, 'Acesso permitido apenas neste computador.');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== url.origin) fail(403, 'Origem não permitida.');
        if (req.headers['content-type'] !== 'application/json') fail(415, 'Envie JSON.');
      }
      let body = {};
      if (['POST', 'PATCH'].includes(req.method)) {
        const chunks = []; let length = 0;
        const limit = url.pathname === '/api/import/preview' ? 8_000_000 : 2_000_000;
        for await (const chunk of req) { length += chunk.length; if (length > limit) fail(413, 'Arquivo ou conteúdo excede o limite permitido.'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail(400, 'JSON inválido.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Objeto JSON inválido.');
      }
      if (url.pathname === '/api/config' && req.method === 'GET') return send(200, { storage: store.info });
      if (url.pathname === '/api/import/template' && req.method === 'GET') {
        const buffer = await createTemplate(instrument);
        res.writeHead(200, { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="modelo-entrevistas-ufrr.xlsx"' });
        return res.end(buffer);
      }
      if (url.pathname === '/api/import/preview' && req.method === 'POST') {
        let parsed;
        try { parsed = await parseSpreadsheet(body); } catch (e) { fail(400, e.message); }
        const result = prepareImport(parsed, instrument, flow, validateAnswers);
        const codes = new Set(), fingerprints = new Set();
        const preparedRows = result.rows.map(row => ({ ...row, fingerprint: importFingerprint(row) }));
        const duplicates = await store.findDuplicates(preparedRows);
        const rows = preparedRows.map((row, index) => {
          const fingerprint = importFingerprint(row);
          const repeated = !!duplicates[index] || !!(row.code && codes.has(row.code)) || fingerprints.has(fingerprint);
          if (row.code) codes.add(row.code);
          fingerprints.add(fingerprint);
          return { ...row, duplicate: repeated };
        });
        for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
        if (previews.size >= 10) previews.delete(previews.keys().next().value);
        const token = randomUUID();
        previews.set(token, { rows, errors: result.errors, expires: Date.now() + 15 * 60_000 });
        return send(200, { token, sheet: parsed.sheet, errors: result.errors, total: rows.length + result.errors.length,
          duplicates: rows.filter(r => r.duplicate).length, ready: rows.filter(r => !r.duplicate).length,
          rows: rows.map(r => ({ line: r.line, code: r.code || 'Gerado automaticamente', name: r.answers.q1?.value || '', status: r.status, duplicate: r.duplicate })) });
      }
      if (url.pathname === '/api/import/commit' && req.method === 'POST') {
        const preview = previews.get(body.token);
        if (!preview || preview.expires < Date.now()) fail(400, 'Prévia expirada. Selecione a planilha novamente.');
        if (preview.errors.length) fail(400, 'Corrija os erros da planilha antes de importar.');
        const result = await store.importRows(preview.rows);
        previews.delete(body.token);
        return send(201, result);
      }
      if (url.pathname === '/api/interviews' && req.method === 'GET') {
        return send(200, await store.list());
      }
      if (url.pathname === '/api/interviews' && req.method === 'POST') {
        if (body.interviewer !== undefined && (typeof body.interviewer !== 'string' || body.interviewer.length > 200)) fail(400, 'Nome de aplicador inválido.');
        return send(201, await store.create({ interviewer: body.interviewer || '', instrument_version: instrument.version }));
      }
      const match = url.pathname.match(/^\/api\/interviews\/([a-f0-9-]+)$/);
      if (match && req.method === 'GET') return send(200, await store.get(match[1]));
      if (match && req.method === 'PATCH') {
        const existing = await store.get(match[1]);
        if (existing.status !== 'in_progress') fail(409, 'Esta entrevista está encerrada e disponível somente para leitura.');
        if (body.revision !== existing.revision) fail(409, 'A entrevista foi alterada em outra aba. Preserve suas respostas pendentes e recarregue antes de continuar.');
        validateAnswers(body.answers);
        const answers = { ...existing.answers, ...body.answers };
        validateAnswers(answers);
        const position = body.position;
        if (!Number.isInteger(position) || position < 0 || position >= flow.length) fail(400, 'Posição inválida.');
        if (!isApplicable(flow[position].id, answers)) fail(400, 'Esta questão foi pulada conforme as respostas anteriores.');
        if (position > 0 && answers.opening?.value !== 1) fail(400, 'Confirme a pergunta de abertura antes de continuar.');
        if (position > checkpointIndex && answers.checkpoint?.value !== 1) fail(400, 'Confirme a disposição para continuar na pausa intermediária.');
        let status = 'in_progress';
        if (body.action === 'complete') {
          if (position !== flow.length - 1 || answers.opening?.value !== 1 || answers.checkpoint?.value !== 1) fail(400, 'Revise a entrevista e os pontos de continuidade antes de concluir.');
          status = 'completed';
        } else if (body.action === 'interrupt') {
          const gate = flow[position].id;
          if (!['opening', 'checkpoint'].includes(gate) || answers[gate]?.value !== 0) fail(400, 'Interrupção disponível apenas após Não em uma pergunta de continuidade.');
          status = gate === 'opening' ? 'interrupted_opening' : 'interrupted_checkpoint';
        } else if (body.action !== undefined) fail(400, 'Ação desconhecida.');
        const saved = await store.save({ id: existing.id, revision: body.revision, answers, position, status, instrument_version: instrument.version });
        return send(200, saved);
      }
      if (url.pathname.startsWith('/api/')) fail(404, 'Recurso não encontrado.');
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Método não permitido.');
      const files = { '/': 'index.html', '/app.js': 'app.js', '/flow.js': 'flow.js', '/autosave.js': 'autosave.js', '/style.css': 'style.css', '/questionnaire.json': 'questionnaire.json', '/favicon.svg': 'favicon.svg',
        '/lb-footer/footer.js': 'lb-footer/footer.js', '/lb-footer/footer.css': 'lb-footer/footer.css',
        '/lb-footer/logo.png': 'lb-footer/logo.png', '/lb-footer/apresentacao.mp4': 'lb-footer/apresentacao.mp4' };
      const name = files[url.pathname];
      if (!name) fail(404, 'Página não encontrada.');
      const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', mp4: 'video/mp4' };
      if (name.endsWith('.mp4')) {
        const file = path.join(root, 'public', name), size = fs.statSync(file).size;
        const videoHeaders = { ...headers, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
        let start = 0, end = size - 1;
        if (req.headers.range && req.method === 'GET') {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (range && (range[1] || range[2])) {
            start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
            end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          } else start = size;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
            res.writeHead(416, { ...videoHeaders, 'Content-Range': `bytes */${size}` }); return res.end();
          }
          res.writeHead(206, { ...videoHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        } else res.writeHead(200, { ...videoHeaders, 'Content-Length': size });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy());
        return stream.pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Type': mime[name.split('.').at(-1)] });
      res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(root, 'public', name)));
    } catch (e) {
      if (!e.status) console.error(e);
      send(e.status || 500, { error: e.status ? e.message : 'Não foi possível salvar. Suas alterações continuam pendentes; tente novamente.' });
    }
  });
  server.on('close', () => store.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  const port = Number(process.env.PORT || 3000);
  const store = configuredStore();
  await store.health();
  const server = createApp({ store });
  server.listen(port, '127.0.0.1', () => console.log(`Pesquisa UFRR disponível em http://localhost:${port}\nArmazenamento: ${store.info.label}`));
}
