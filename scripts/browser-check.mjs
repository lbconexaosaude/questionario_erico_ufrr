// Verificação opcional usando Chrome/Edge com --remote-debugging-port=9223.
// Sempre usa banco isolado em memória; não escreve respostas na pesquisa real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { createApp, flow } from '../server.mjs';
import { createSQLiteStore } from '../lib/sqlite-store.mjs';

const testStore = createSQLiteStore(':memory:');
const server = createApp({ store: testStore });
const onlineMode = process.env.BROWSER_ONLINE === '1';
// Simula a subpasta do GitHub Pages sem tocar no servidor ou banco reais.
const mountPath = process.env.BROWSER_BASE_PATH || '';
if (mountPath) {
  if (!/^\/[a-zA-Z0-9_-]+$/.test(mountPath)) throw new Error('BROWSER_BASE_PATH inválido');
  const handler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (!req.url.startsWith(mountPath + '/')) { res.writeHead(404); return res.end(); }
    req.url = req.url.slice(mountPath.length);
    return handler(req, res);
  });
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${mountPath}`;
const browser = await fetch('http://127.0.0.1:9223/json/version').then(r => r.json());
const socket = new WebSocket(browser.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
const pending = new Map(), errors = [];
let sequence = 0, sessionId, slowRead = false;
const testToken = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({sub:'11111111-1111-1111-1111-111111111111',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url') + '.test';
async function fulfillOnline(params) {
  const request = params.request, url = new URL(request.url);
  let status = 200, body;
  const payload = request.postData ? JSON.parse(request.postData) : {};
  if(process.env.BROWSER_DEBUG) console.log('Mock Supabase:',request.method,url.pathname,payload.p_operation||'');
  if (request.method === 'OPTIONS') body = {};
  else if (url.pathname.startsWith('/auth/v1/token')) {
    body = {access_token:testToken,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user:{id:'11111111-1111-1111-1111-111111111111',email:'browser@example.test',aud:'authenticated',role:'authenticated'}};
  } else if(url.pathname.startsWith('/auth/v1/logout')) body = {};
  else if(url.pathname === '/rest/v1/rpc/Qest_web') {
    const op=payload.p_operation, p=payload.p_payload;
    try {
      if(op==='health') body={schema_version:2};
      else if(op==='list') {
        const rows=(await testStore.list()).sort((a,b)=>a.id.localeCompare(b.id));
        body=rows.filter(r=>!p.after||r.id>p.after).slice(0,p.limit||200);
      } else if(op==='get') { if(slowRead) await new Promise(r=>setTimeout(r,700)); body=await testStore.get(p.id); }
      else if(op==='duplicates') body=await testStore.findDuplicates(p.rows);
      else if(op==='import') body=await testStore.importRows(p.rows);
      else {
        const response=await fetch(base+'/api/interviews'+(op==='save'?'/'+p.id:''),{method:op==='save'?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
        body=await response.json();
        if(!response.ok) {status=response.status;body={code:'PT'+status,message:'Test error'};}
      }
    } catch(e) { status=e.status||400; body={code:'PT'+status,message:'Test error'}; }
  } else {status=404;body={message:'Unexpected test request'};}
  await cdp('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:status,responseHeaders:[
    {name:'Content-Type',value:'application/json'}, {name:'Access-Control-Allow-Origin',value:'*'},
    {name:'Access-Control-Allow-Headers',value:Object.entries(request.headers).find(([k])=>k.toLowerCase()==='access-control-request-headers')?.[1] || 'authorization,apikey,content-type,content-profile,accept-profile,prefer,x-client-info,x-supabase-api-version'}, {name:'Access-Control-Allow-Methods',value:'GET,POST,OPTIONS'},
  ],body:Buffer.from(JSON.stringify(body)).toString('base64')});
}
socket.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (data.id) {
    const task = pending.get(data.id); if (!task) return;
    pending.delete(data.id); data.error ? task.reject(new Error(JSON.stringify(data.error))) : task.resolve(data.result);
  } else if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text + ': ' + data.params.exceptionDetails.exception?.description);
  else if (data.method === 'Fetch.requestPaused') fulfillOnline(data.params).catch(e=>errors.push(e.message));
  else if (data.method === 'Network.loadingFailed' && process.env.BROWSER_DEBUG) console.log('Network:',data.params.errorText,data.params.corsErrorStatus);
});
function cdp(method, params = {}, useSession = true) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(useSession && sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 60)); }
  throw new Error('Tempo excedido: ' + expression);
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const input = (selector, value) => evaluate(`(() => {const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
async function screenshot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.mkdirSync(new URL('../storage/qa/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`../storage/qa/${name}.png`, import.meta.url), Buffer.from(r.data, 'base64'));
}
try {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }, false));
  await cdp('Runtime.enable'); await cdp('Page.enable');
  if(onlineMode) {
    await cdp('Network.enable');
    await cdp('Page.setBypassCSP',{enabled:true});
    await cdp('Fetch.enable',{patterns:[{urlPattern:'https://*.supabase.co/*'}]});
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base + '/' + (onlineMode ? '?online=1' : '') });
  if(onlineMode) {
    await waitFor('!!document.querySelector("#login-form")');
    await screenshot('pages-login');
    await input('[name="email"]','browser@example.test'); await input('[name="password"]','test-only-password');
    await evaluate('document.querySelector("#login-form").requestSubmit()');
  }
  await waitFor(`!!document.querySelector('[data-action="new"]')`);
  await waitFor('document.querySelector("lb-dev-footer")?.shadowRoot?.querySelector("video")?.currentTime > 0');
  assert.equal(await evaluate('document.querySelector("lb-dev-footer").shadowRoot.querySelector("video").muted'), true);
  assert.equal(await evaluate('!!document.querySelector("lb-dev-footer").shadowRoot.querySelector("button, dialog")'), false);
  await evaluate(`(() => {
    window.footerEnds = 0;
    const video = document.querySelector('lb-dev-footer').shadowRoot.querySelector('video');
    video.addEventListener('ended', () => window.footerEnds++);
    video.playbackRate = 4;
  })()`);
  await evaluate('document.querySelector("lb-dev-footer").scrollIntoView()');
  await screenshot('rodape-desktop');
  await waitFor('window.footerEnds === 5 && document.querySelector("lb-dev-footer").shadowRoot.querySelector("video").ended', 20000);
  await click('[data-action="dashboard"]'); await waitFor('!!document.querySelector(".dashboard")');
  assert.equal(await evaluate('document.querySelector("lb-dev-footer").shadowRoot.querySelector("video").paused'), true, 'Navegar não reinicia o vídeo');
  assert.equal(await evaluate('window.footerEnds'), 5);
  await cdp('Page.reload');
  await waitFor('!!document.querySelector(".home-hero")');
  await waitFor('document.querySelector("lb-dev-footer")?.shadowRoot?.querySelector("video")?.currentTime > 0');
  assert.equal(await evaluate('document.querySelector("lb-dev-footer").shadowRoot.querySelector("video").paused'), false, 'Recarregar inicia outra sequência automaticamente');
  const mediaRange = await fetch(base + '/lb-footer/apresentacao.mp4', { headers: { Range: 'bytes=0-99' } });
  assert.equal(mediaRange.status, 206); assert.equal((await mediaRange.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(base + '/lb-footer/apresentacao.mp4', { headers: { Range: 'bytes=999999999-' } })).status, 416);
  await evaluate('window.scrollTo(0,0)');
  await screenshot('home-desktop');
  assert.equal(await evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('home-mobile');
  await evaluate('document.querySelector("lb-dev-footer").scrollIntoView()');
  await screenshot('rodape-mobile');
  await evaluate('window.scrollTo(0,0)');
  assert.equal(await evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false);
  await click('[data-action="new"]');
  await waitFor('document.querySelector("dialog").open');
  await input('[name="interviewer"]', 'Aplicador de teste');
  await click('dialog [value="confirm"]');
  await waitFor('!!document.querySelector(".question-card")');
  await click('[data-field="value"][value="1"]');
  await click('[data-action="next"]');
  await click('[data-action="next"]');
  await input('[data-field="value"]', 'Resposta para teste de retomada');
  await waitFor('document.querySelector("#save-status").textContent.startsWith("Salvo no banco")');
  await click('[data-action="exit"]');
  await waitFor('!!document.querySelector(".home-hero")');
  await click('[data-action="resume"]');
  await waitFor('!!document.querySelector("[data-action=open]")');
  await click('[data-action="open"]');
  await waitFor('!!document.querySelector("[data-field=value]")');
  assert.equal(await evaluate('document.querySelector("[data-field=value]").value'), 'Resposta para teste de retomada');
  await screenshot('question-mobile');
  await click('[data-action="exit"]');
  await waitFor('!!document.querySelector(".home-hero")');
  await click('[data-action="new"]'); await waitFor('document.querySelector("dialog").open');
  await click('dialog [value="confirm"]'); await waitFor('!!document.querySelector(".question-card")');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  await waitFor('document.querySelector("dialog").open'); await click('dialog [value="confirm"]');
  await waitFor('!!document.querySelector(".end-screen")');
  assert.match(await evaluate('document.querySelector(".end-screen").textContent'), /Interrompida na abertura/);
  console.log('OK: início, salvamento, retomada e interrupção na abertura, em tela móvel.');

  let seeded = await fetch(base + '/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interviewer: 'Teste múltipla escolha' }) }).then(r => r.json());
  seeded = await fetch(base + '/api/interviews/' + seeded.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, position: flow.findIndex(s => s.id === 'q48'), answers: { opening: { value: 1 }, checkpoint: { value: 1 } } }) }).then(r => r.json());
  await click('[data-action="home"]'); await waitFor('!!document.querySelector(".home-hero")');
  await click('[data-action="resume"]'); await waitFor('!!document.querySelector("[data-action=open]")');
  await click(`[data-action="open"][data-id="${seeded.id}"]`);
  await waitFor('document.querySelector(".question-tag")?.textContent === "Q48"');
  await click('[data-field="value"][value="1"]'); await click('[data-field="value"][value="3"]'); await click('[data-field="value"][value="6"]');
  await input('[data-field="detail"]', 'Complemento preservado');
  await click('[data-field="value"][value="6"]');
  assert.equal(await evaluate('document.querySelector("[data-field=detail]").value'), 'Complemento preservado');
  assert.equal(await evaluate('document.querySelectorAll(".choice input:checked").length'), 2);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await screenshot('q48-desktop');
  for (let i = 0; i < 6; i++) await click('[data-action="next"]');
  await waitFor('!!document.querySelector(".review-sections")');
  await click('[data-action="complete"]'); await waitFor('document.querySelector("dialog").open'); await click('dialog [value="confirm"]');
  await waitFor('!!document.querySelector(".end-screen")');
  assert.match(await evaluate('document.querySelector(".end-screen").textContent'), /Entrevista concluída/);
  await click('[data-action="home"]'); await waitFor('!!document.querySelector(".home-hero")');
  await click('[data-action="dashboard"]'); await waitFor('!!document.querySelector(".dashboard")');
  await screenshot('dashboard-desktop');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('dashboard-mobile');
  assert.equal(await evaluate('document.documentElement.clientWidth'), 390);
  assert.equal(await evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false);
  assert.equal(await evaluate('document.querySelector(".metrics strong").textContent'), '3');
  await evaluate(`window.testExports = []; const originalCreateURL = URL.createObjectURL; URL.createObjectURL = function(blob) { window.testExports.push(blob); return originalCreateURL.call(URL, blob); };`);
  await click('[data-action="csv"]');
  const csv = await evaluate('window.testExports[0].text()');
  assert.match(csv, /"q48"/);
  assert.match(csv, /Complemento preservado/);
  await evaluate(`document.querySelector('[name="status"]').value = 'completed'; document.querySelector('#filters').requestSubmit();`);
  assert.equal(await evaluate('document.querySelector(".metrics strong").textContent'), '1');
  await click('[data-action="json"]');
  const exported = JSON.parse(await evaluate('window.testExports[1].text()'));
  assert.equal(exported.interviews.length, 1);
  assert.deepEqual(exported.interviews[0].answers.q48.value, [1, 3]);
  assert.equal(exported.interviews[0].answers.q48.detail, 'Complemento preservado');

  // Impressão individual e lote: chama a mesma composição usada pelo diálogo nativo.
  await evaluate('window.printCalls = 0; window.print = () => { window.printCalls++; };');
  await click('[data-action="print"]');
  await waitFor('window.printCalls === 1');
  assert.equal(await evaluate('document.querySelectorAll("#print-area .print-interview").length'), 1);
  await click('[data-action="read"]');
  await waitFor('!!document.querySelector(".read-page")');
  const readMetadata = await evaluate('Object.fromEntries([...document.querySelectorAll(".read-metadata > div")].map(el => [el.querySelector("dt").textContent, el.querySelector("dd").textContent]))');
  assert.deepEqual(Object.keys(readMetadata), ['Nome', 'Aplicador', 'Início', 'Encerramento', 'Situação', 'Instrumento']);
  const printedInterview = exported.interviews[0];
  assert.equal(readMetadata.Nome, printedInterview.answers.q1?.value || 'Não informado');
  assert.equal(readMetadata.Aplicador, printedInterview.interviewer || 'Não informado');
  assert.equal(readMetadata.Instrumento, 'Versão ' + printedInterview.instrument_version);
  assert.equal(readMetadata.Situação, 'Concluída');
  assert.notEqual(readMetadata.Encerramento, 'Ainda não encerrada');
  assert.equal(await evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), false);
  await screenshot('consulta-dados-mobile');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await screenshot('consulta-contraste');
  await click('.read-actions [data-action="print"]'); await waitFor('window.printCalls === 2');
  await click('[data-action="dashboard"]'); await waitFor('!!document.querySelector(".dashboard")');
  await evaluate(`document.querySelector('[name="status"]').value = ''; document.querySelector('#filters').requestSubmit();`);
  await click('[data-print-id]');
  await evaluate('document.querySelectorAll("[data-print-id]")[1].click()');
  await click('[data-action="print-selected"]'); await waitFor('window.printCalls === 3');
  assert.equal(await evaluate('document.querySelectorAll("#print-area .print-interview").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll("#print-area .read-answer").length'), 112);
  const pdf = await cdp('Page.printToPDF', { printBackground: false, preferCSSPageSize: true });
  const pdfBuffer = Buffer.from(pdf.data, 'base64');
  assert.equal(pdfBuffer.subarray(0, 5).toString(), '%PDF-');
  fs.writeFileSync(new URL('../storage/qa/lote-entrevistas.pdf', import.meta.url), pdfBuffer);
  await screenshot('painel-impressao');

  // Salto de Q7.1, revisão da resposta principal e retenção do complemento.
  const seed = async (id, answers) => {
    const created = await fetch(base + '/api/interviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
    const updated = await fetch(base + '/api/interviews/' + created.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, position: flow.findIndex(s => s.id === id), answers: { opening: { value: 1 }, ...answers } }) }).then(r => r.json());
    await click('[data-action="home"]'); await waitFor('!!document.querySelector(".home-hero")');
    await click('[data-action="resume"]'); await waitFor(`!!document.querySelector('[data-id="${updated.id}"]')`);
    await click(`[data-action="open"][data-id="${updated.id}"]`); await waitFor(`document.querySelector('.question-tag')?.textContent === '${id.toUpperCase()}'`);
    return updated;
  };
  const conditional = await seed('q7', {});
  await click('[data-field="value"][value="1"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q7.1');
  await input('[data-field="value"]', '12'); await click('[data-action="previous"]');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  assert.ok(await evaluate('!!document.querySelector(".section-card")'));
  await click('[data-action="next"]');
  for (let n = 0; n < 3; n++) await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q11');
  await click('[data-field="value"][value="1"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q11.1');
  await click('[data-field="value"][value="1"]'); await click('[data-field="value"][value="2"]');
  assert.equal(await evaluate('document.querySelectorAll(".choice input:checked").length'), 2);
  await click('[data-action="previous"]'); await click('[data-field="value"][value="0"]');
  await click('[data-action="next"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q12');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q15');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q17');
  await click('[data-action="next"]'); await click('[data-field="value"][value="1"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q19');
  await click('[data-field="value"][value="1"]'); await click('[data-field="value"][value="2"]');
  assert.equal(await evaluate('document.querySelectorAll(".choice input:checked").length'), 2);
  await click('[data-action="previous"]'); await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q20');
  await click('[data-field="value"][value="2"]'); await click('[data-field="value"][value="3"]');
  assert.equal(await evaluate('document.querySelectorAll(".choice input:checked").length'), 2);
  await click('[data-action="next"]'); assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q21');
  await input('[data-field="value"]', '20'); await click('[data-action="previous"]');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q22');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q25');
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  assert.match(await evaluate('document.querySelector(".question-card h1").textContent'), /continuar respondendo/);
  await click('[data-field="value"][value="0"]'); await click('[data-action="next"]');
  await waitFor('document.querySelector("dialog").open');
  assert.match(await evaluate('document.querySelector("dialog p").textContent'), /Não,/);
  await click('dialog [value="confirm"]'); await waitFor('!!document.querySelector(".end-screen")');
  const savedConditional = await fetch(base + '/api/interviews/' + conditional.id).then(r => r.json());
  assert.equal(savedConditional.answers['q7.1'].value, 12);
  assert.equal(savedConditional.answers.q21.value, 20);
  assert.deepEqual(savedConditional.answers['q11.1'].value, [1, 2]);
  assert.deepEqual(savedConditional.answers.q19.value, [1, 2]);
  assert.equal(savedConditional.status, 'interrupted_checkpoint');
  console.log('OK: todos os saltos na interface, retorno, Q20 múltipla e pausa preservada ao pular Q26.');

  await click('[data-action="home"]'); await waitFor('!!document.querySelector(".home-hero")');
  await click('[data-action="dashboard"]'); await waitFor('!!document.querySelector(".dashboard")');
  await click('[data-action="import"]'); await waitFor('document.querySelector("dialog").open');
  const upload = async (filename, buffer) => {
    await evaluate(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(buffer).toString('base64'))}), c => c.charCodeAt(0)); const data = new DataTransfer(); data.items.add(new File([bytes], ${JSON.stringify(filename)})); const input = document.querySelector('#import-input'); input.files = data.files; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await click('[data-action="import-file"]');
    await waitFor('!!document.querySelector(".import-summary")');
  };
  await upload('invalidas.csv', 'q1;q4\nTeste;99');
  assert.ok(await evaluate('!!document.querySelector(".import-errors")'));
  assert.equal(await evaluate('document.querySelector("[data-action=import-confirm]").disabled'), true);
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Entrevistas');
  worksheet.addRow(['code', 'q1', 'q20', 'opening']); worksheet.addRow(['TESTE-XLSX', 'Teste Excel', '2,3', 1]);
  await upload('entrevistas.xlsx', await workbook.xlsx.writeBuffer());
  await screenshot('importacao-excel');
  assert.match(await evaluate('document.querySelector(".import-summary").textContent'), /1 novas entrevistas/);
  assert.equal((await fetch(base + '/api/interviews').then(r => r.json())).length, 4, 'Prévia não grava');
  await click('[data-action="import-confirm"]'); await waitFor('!document.querySelector("dialog").open');
  await waitFor('document.querySelector(".metrics strong")?.textContent === "5"');
  const imported = await fetch(base + '/api/interviews').then(r => r.json());
  assert.deepEqual(imported.find(i => i.code === 'TESTE-XLSX').answers.q20.value, [2, 3]);
  console.log('OK: impressão individual, lote em PDF e importação real de XLSX com prévia e validação.');

  // Outra sessão altera o mesmo campo e um campo diferente enquanto há edição local.
  // O modal deve resolver automaticamente e restaurar pergunta, foco e rolagem.
  const syncingInterview = await seed('q13', { q12: { value: 1 }, q13: { value: 'Antes' } });
  const remoteResponse = await fetch(base + '/api/interviews/' + syncingInterview.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: syncingInterview.revision, position: syncingInterview.position,
      answers: { ...syncingInterview.answers, q13: { value: 'Outra sessão' }, q2: { value: 68 } } }),
  });
  assert.equal(remoteResponse.status, 200);
  slowRead = true;
  await evaluate(`(() => {
    const original = window.fetch; window.restoreFetch = () => { window.fetch = original; };
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/interviews/') && !args[1]?.method) await new Promise(r => setTimeout(r, 700));
      return original(...args);
    };
    const el = document.querySelector('[data-field=value]'); el.focus(); window.scrollTo(0, 120);
    window.beforeSyncScroll = window.scrollY;
  })()`);
  await input('[data-field="value"]', 'Minha edição pendente');
  await waitFor('document.querySelector("#sync-dialog").open');
  await screenshot('sincronizacao-automatica');
  await waitFor('!document.querySelector("#sync-dialog").open');
  assert.equal(await evaluate('document.querySelector(".question-tag").textContent'), 'Q13');
  assert.equal(await evaluate('document.querySelector("[data-field=value]").value'), 'Minha edição pendente');
  assert.equal(await evaluate('document.activeElement.dataset.field'), 'value');
  assert.equal(await evaluate('Math.abs(window.scrollY - window.beforeSyncScroll) < 2'), true);
  assert.equal(await evaluate('!!document.querySelector("[data-action=reload]")'), false);
  await evaluate('window.restoreFetch()');
  slowRead = false;
  const synced = await fetch(base + '/api/interviews/' + syncingInterview.id).then(r => r.json());
  assert.equal(synced.answers.q13.value, 'Minha edição pendente'); assert.equal(synced.answers.q2.value, 68);
  // O preenchimento continua normalmente depois do fechamento automático.
  await input('[data-field="value"]', 'Continuei preenchendo');
  await waitFor('document.querySelector("#save-status").textContent.startsWith("Salvo no banco")');
  assert.equal((await fetch(base + '/api/interviews/' + synced.id).then(r => r.json())).answers.q13.value, 'Continuei preenchendo');
  console.log('OK: conflito real reconciliado sem cliques, respostas locais/remotas preservadas e preenchimento retomado.');
  assert.deepEqual(errors, []);
  console.log('OK: Q48 múltipla, complemento preservado, revisão, conclusão e painel responsivo.');
  console.log('OK: filtro por situação e exportações CSV/JSON com códigos e complementos.');
  console.log('OK: seis dados da consulta, rodapé responsivo e vídeo automático: cinco ciclos, parada e reinício ao recarregar.');
  console.log('Capturas: storage/qa/. Nenhuma resposta de teste no banco real.');
  await cdp('Target.closeTarget', { targetId }, false);
} finally {
  server.closeAllConnections();
  socket.close(); await new Promise(resolve => server.close(resolve));
}
