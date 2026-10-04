import { buildFlow, isApplicable, movePosition, normalizePosition } from './flow.js';
import { createAutosave } from './autosave.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const statusLabels = { in_progress: 'Em andamento', completed: 'Concluída', interrupted_opening: 'Interrompida na abertura', interrupted_checkpoint: 'Interrompida na pausa' };
const date = value => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
let instrument, flow, interviews = [], current, view = 'home', dirty = false, saveTimer, locked = false, autosave;
let syncView, recoverySnapshot;
let onlineClient;
function showSessionIdentity(session) {
  const email = session?.user?.email || '';
  $('#session-email').textContent = email;
  $('#session-identity').hidden = !email;
}
let filter = { status: '', search: '', from: '', to: '', question: 'q4' };
let saveMessage = 'Todas as alterações salvas';
const selectedPrint = new Set();
let importPreview;
let storageInfo = { provider: 'sqlite', label: 'Banco local', scope: 'local' };
// Mantém as cópias SQLite anteriores; separa pendências por projeto Supabase.
const storageKey = id => storageInfo.provider === 'sqlite' ? `ufrr.pending.${id}` : `ufrr.${storageInfo.scope}.pending.${id}`;
const hasAnswer = a => !!a && Object.values(a).some(v => Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
const applies = (q, i) => i.status !== 'in_progress' && ['1.0-original', '1.1'].includes(i.instrument_version) || isApplicable(q.id, i.answers, i.status === 'in_progress' ? instrument.version : i.instrument_version);
const countAnswers = interview => instrument.questions.filter(q => applies(q, interview) && hasAnswer(interview.answers[q.id])).length;
const applicableCount = interview => instrument.questions.filter(q => applies(q, interview)).length;
const progress = interview => {
  if (interview.status === 'completed') return 100;
  const visible = flow.map((s, index) => ({ ...s, index })).filter(s => isApplicable(s.id, interview.answers));
  const position = visible.findIndex(s => s.index === interview.position);
  return Math.round(Math.max(0, position) / (visible.length - 1) * 100);
};
async function api(url, options) {
  if (onlineClient && url.startsWith('/api/')) {
    try { return await onlineClient.api(url, options); }
    catch (error) {
      if (error.status === 401 || error.status === 403) {
        const account = $('#account-button'); account.hidden = false; account.dataset.action = 'login'; account.textContent = 'Entrar novamente';
      }
      throw error;
    }
  }
  const response = await fetch(new URL('.' + url, import.meta.url), { signal: AbortSignal.timeout(30_000), ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) { const e = new Error(data.error || 'Não foi possível carregar os dados.'); e.status = response.status; throw e; }
  return data;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
function pendingStore() {
  try { localStorage.setItem(storageKey(current.id), JSON.stringify(autosave?.snapshot() || current)); return true; }
  catch { saveMessage = 'Falha na cópia local. Mantenha esta aba aberta até salvar no banco.'; updateSave(); return false; }
}
function updateSave() {
  const el = $('#save-status');
  if (el) { el.textContent = saveMessage; el.classList.toggle('pending', dirty); }
}
function changed() {
  autosave.markDirty();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(), 350);
}
function flush(action) {
  clearTimeout(saveTimer);
  return autosave ? autosave.flush(action) : Promise.resolve(true);
}
function normalizeCurrent(record) {
  record.position = normalizePosition(flow, record.position, record.answers);
  const checkpoint = flow.findIndex(s => s.id === 'checkpoint');
  if (record.position > 0 && record.answers.opening?.value !== 1) record.position = 0;
  else if (record.position > checkpoint && record.answers.checkpoint?.value !== 1) record.position = checkpoint;
}
function syncing(active) {
  const dialog = $('#sync-dialog');
  if (active) {
    const focused = document.activeElement;
    syncView = { y: window.scrollY, x: window.scrollX, field: focused?.dataset?.field,
      value: ['checkbox', 'radio'].includes(focused?.type) ? focused.value : undefined,
      start: focused?.selectionStart, end: focused?.selectionEnd, position: current.position };
    dialog.showModal();
  } else {
    dialog.close();
    if (view === 'interview' || view === 'read') render();
    if (view === 'interview' && syncView) {
      const input = [...document.querySelectorAll('[data-field]')].find(el => el.dataset.field === syncView.field && (syncView.value === undefined || el.value === syncView.value));
      input?.focus({ preventScroll: true });
      if (input && typeof syncView.start === 'number' && ['text', 'textarea'].includes(input.type)) input.setSelectionRange(syncView.start, syncView.end);
      window.scrollTo({ left: syncView.x, top: syncView.position === current.position ? syncView.y : 0 });
    }
    syncView = undefined;
  }
}
function setupAutosave({ pending = false, baseline = current.answers } = {}) {
  autosave = createAutosave({ record: current, baseline, pending, normalize: normalizeCurrent,
    read: id => api(`/api/interviews/${id}`),
    write: (id, payload) => api(`/api/interviews/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    onSync: syncing,
    onClosed(local, remote) {
      recoverySnapshot = local;
      try { localStorage.setItem(storageKey(local.id) + '.recovery', JSON.stringify(local)); } catch { /* a cópia continua disponível nesta aba */ }
      view = 'read'; locked = false;
      toast('Esta entrevista já foi encerrada. Suas alterações pendentes foram preservadas em uma cópia.');
    },
    onState({ event, dirty: pendingChanges, record }) {
      dirty = pendingChanges;
      if (event === 'error') saveMessage = 'Alterações pendentes. Tentaremos sincronizar novamente automaticamente.';
      else if (event === 'saved' && !dirty) saveMessage = `Salvo no banco às ${new Date(record.updated_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      else if (event === 'closed') saveMessage = 'Entrevista encerrada; cópia pendente preservada.';
      else saveMessage = 'Salvando alterações…';
      if (dirty) pendingStore();
      else { try { localStorage.removeItem(storageKey(record.id)); } catch {} }
      updateSave();
    },
  });
}
function go(name) { view = name; render(); main.focus(); window.scrollTo({ top: 0 }); }
function button(label, action, style = 'primary', extra = '') { return `<button class="button ${style}" data-action="${action}" ${extra}>${label}</button>`; }
function breadcrumb(label) { return `<div class="breadcrumb"><button data-action="home">Início</button><span>/</span>${label}</div>`; }
function render() {
  if (view === 'login') renderLogin();
  else if (view === 'home') renderHome();
  else if (view === 'resume') renderResume();
  else if (view === 'interview') renderInterview();
  else if (view === 'dashboard') renderDashboard();
  else if (view === 'read') renderRead();
  else if (view === 'end') renderEnd();
}
function renderHome() {
  const open = interviews.filter(i => i.status === 'in_progress').length;
  main.innerHTML = `<section class="home-hero"><div class="hero-copy">
    <div class="eyebrow"><span class="tiny-line"></span> PESQUISA DE MESTRADO · UFRR</div>
    <p class="research-institution">Universidade Federal de Roraima<br>Centro de Ciências da Saúde</p>
    <h1 class="research-title">Perfil epidemiológico do suicídio em Roraima <em>e seus fatores associados</em></h1>
    <p class="hero-description">Questionário de Pesquisa Biopsicossocial</p>
    <p class="muted hero-support">Instrumento de coleta de dados da pesquisa vinculada ao Programa de Pós-Graduação em Ciências da Saúde (PPG-PROCISA), na área de concentração Gestão de Sistemas de Saúde.</p>
    <div class="research-credits">
      <p><strong>Mestrando:</strong> Érico Macedo Gonçalves</p>
      <p><strong>Orientadora:</strong> Profa. Dra. Bianca Jorge Sequeira</p>
      <p class="research-location">Boa Vista – RR · 2026</p>
    </div>
    <div class="hero-actions">${button('Iniciar nova entrevista <span aria-hidden="true">↗</span>', 'new')}${button('Continuar entrevista <span class="count">' + open + '</span>', 'resume', 'secondary')}</div>
    <div class="hero-note"><span class="small-icon" aria-hidden="true">✓</span><span>Salvamento automático durante a entrevista</span></div>
  </div><aside class="instrument-card"><div class="card-top"><span class="eyebrow">INSTRUMENTO DE PESQUISA</span><span class="document-icon" aria-hidden="true">▤</span></div><h2>Coleta de dados.<br>Sete dimensões.</h2><ol class="section-preview">${instrument.sections.map((s, n) => `<li><span>${String(n + 1).padStart(2, '0')}</span>${esc(s.title)}</li>`).join('')}</ol><div class="instrument-meta"><span>Q1 a Q53 + subquestões</span><span>Versão ${esc(instrument.version)}</span></div></aside></section>
  <section class="home-bottom"><div class="panel-link"><div><div class="eyebrow">ACOMPANHAMENTO DA PESQUISA</div><h2>Registros da pesquisa</h2><p class="muted">Consulte entrevistas, acompanhe as respostas e exporte os dados coletados.</p></div>${button('Abrir painel <span aria-hidden="true">→</span>', 'dashboard', 'primary panel-button')}</div><div class="local-note"><strong>${storageInfo.provider === 'supabase' ? 'Conectado ao Supabase' : 'Neste computador'}</strong><p>${storageInfo.provider === 'supabase' ? 'As entrevistas são salvas no projeto Supabase configurado para esta pesquisa.' : 'As entrevistas são salvas no banco local. O painel reúne os registros desta instalação.'}</p></div></section>`;
}

function interviewRows(rows, resume = false) {
  if (!rows.length) return `<div class="empty-state"><span aria-hidden="true">▤</span><h3>${resume ? 'Nenhuma entrevista em andamento' : 'Nenhum registro encontrado'}</h3><p>${resume ? 'As entrevistas iniciadas aparecerão aqui para você continuar.' : 'Inicie uma entrevista ou ajuste os filtros para visualizar os registros.'}</p></div>`;
  return `<div class="table-wrap"><table><thead><tr>${resume ? '' : '<th><input type="checkbox" id="print-all" aria-label="Selecionar todas as entrevistas filtradas para impressão"></th>'}<th>Entrevista</th><th>Aplicador</th><th>Iniciada em</th><th>Situação</th><th>Respostas</th><th>Ações</th></tr></thead><tbody>${rows.map(i => `<tr>${resume ? '' : `<td><input type="checkbox" data-print-id="${i.id}" aria-label="Selecionar ${esc(i.code)} para impressão" ${selectedPrint.has(i.id) ? 'checked' : ''}></td>`}<td><strong>${esc(i.code)}</strong><small>${esc(i.answers.q1?.value || '')}</small><small>${esc(flow[i.position]?.id === 'review' ? 'Revisão final' : flow[i.position]?.id.toUpperCase())}</small></td><td>${esc(i.interviewer || 'Não informado')}</td><td>${date(i.started_at)}</td><td><span class="status ${i.status}">${statusLabels[i.status]}</span></td><td>${countAnswers(i)} / ${applicableCount(i)}</td><td><div class="row-actions"><button class="row-link" data-action="${resume ? 'open' : 'read'}" data-id="${i.id}">${resume ? 'Continuar →' : 'Consultar →'}</button>${resume ? '' : `<button class="row-link" data-action="print" data-id="${i.id}">Imprimir</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function renderResume() {
  main.innerHTML = `<div class="page">${breadcrumb('Continuar entrevista')}<div class="page-heading"><div><div class="eyebrow">APLICAÇÃO DA ENTREVISTA</div><h1>Continuar de onde parou.</h1><p class="muted">Seus registros permanecem salvos entre uma sessão e outra.</p></div>${button('Nova entrevista +', 'new')}</div>${interviewRows(interviews.filter(i => i.status === 'in_progress'), true)}</div>`;
}
function choices(options, value, field = 'value', multiple = false) {
  if (multiple && typeof value === 'number') value = [value];
  return `<div class="choices ${options.length <= 3 ? 'short' : ''}">${options.map(o => {
    const selected = multiple ? (Array.isArray(value) && value.includes(o.value)) : value === o.value;
    return `<label class="choice ${selected ? 'selected' : ''}"><input type="${multiple ? 'checkbox' : 'radio'}" name="${field}" data-field="${field}" value="${o.value}" ${selected ? 'checked' : ''} ${locked ? 'disabled' : ''}><span class="option-code">${o.value}</span><span>${esc(o.label)}</span><span class="checkmark" aria-hidden="true">${selected ? '✓' : ''}</span></label>`;
  }).join('')}</div>`;
}
function textField(label, field, value, multiline = false) {
  return `<label class="field"><span>${esc(label)}</span>${multiline ? `<textarea data-field="${field}" rows="5" ${locked ? 'disabled' : ''}>${esc(value)}</textarea>` : `<input type="text" data-field="${field}" value="${esc(value)}" ${locked ? 'disabled' : ''}>`}</label>`;
}
function answerInputs(q) {
  const a = current.answers[q.id] || {};
  let html;
  if (['text', 'long_text', 'provisional'].includes(q.type)) html = textField('Resposta', 'value', a.value, q.type !== 'text');
  else if (q.type === 'integer') html = `<label class="field number-field"><span>${q.id === 'q2' || q.id === 'q24' ? 'Anos' : 'Meses'}</span><input type="number" min="0" step="1" inputmode="numeric" data-field="value" value="${esc(a.value)}" ${locked ? 'disabled' : ''}></label>`;
  else html = choices(q.options, a.value, 'value', q.type === 'multiple');
  if (q.type === 'events' && (a.value === 1 || a.events?.length || a.detail)) html += `<div class="detail-fields"><p>Se sim, marque todos:</p>${choices(q.events, a.events, 'events', true)}${a.events?.includes(9) || a.detail ? textField('Outros:', 'detail', a.detail) : ''}</div>`;
  if (q.type === 'religion' && (a.value === 1 || a.religion || a.regular || a.frequency)) html += `<div class="detail-fields">${textField('Se sim. Qual?', 'religion', a.religion)}${textField('Frequentava regularmente?', 'regular', a.regular)}${textField('Qual frequência semanal?', 'frequency', a.frequency)}</div>`;
  if (q.detail && (a.value === q.detail.when || Array.isArray(a.value) && a.value.includes(q.detail.when) || a.detail)) html += `<div class="detail-fields">${textField(q.detail.label, 'detail', a.detail, [28, 30, 35, 38, 39, 40].includes(Number(q.id.slice(1))))}</div>`;
  return html;
}
function renderInterview() {
  const step = flow[current.position], q = instrument.questions.find(q => q.id === step.id);
  const section = instrument.sections.find(s => s.id === step.section);
  const pct = progress(current);
  let body = '';
  if (step.type === 'gate') {
    const opening = step.id === 'opening';
    body = `<div class="gate-icon" aria-hidden="true">${opening ? '◇' : 'Ⅱ'}</div><div class="eyebrow">${opening ? 'ANTES DE COMEÇAR' : 'UMA PAUSA PARA ESCUTAR'}</div><h1>${opening ? 'Você se sente à vontade para responder perguntas sobre a pessoa falecida?' : 'Você se sente à vontade para continuar respondendo?'}</h1><p class="muted">${opening ? 'A entrevista só começa com uma resposta afirmativa.' : 'Se a resposta for não, a entrevista será encerrada e as respostas já registradas serão preservadas.'}</p>${choices([{ value: 0, label: 'Não' }, { value: 1, label: 'Sim' }], current.answers[step.id]?.value)}<details class="source-text"><summary>Texto integral do instrumento</summary><p>${esc(instrument[step.id])}</p></details>`;
  } else if (step.type === 'section') {
    const index = instrument.sections.indexOf(section);
    body = `<span class="section-number">${String(index + 1).padStart(2, '0')}</span><div class="eyebrow">BLOCO ${index + 1} DE 7</div><h1>${esc(section.title)}</h1><p class="section-range">${esc(section.range)}</p><p class="muted">Avance quando estiver pronto para iniciar este bloco.</p>`;
  } else if (step.type === 'question') {
    body = `<div class="question-top"><span class="eyebrow">${esc(section.title)}</span><span class="question-tag">${q.number}</span></div><h1 class="question-heading">${esc(q.prompt)}</h1>${q.type === 'multiple' ? '<p class="selection-hint">Você pode selecionar mais de uma alternativa.</p>' : ''}<div id="answer-inputs">${answerInputs(q)}</div><div class="question-tools"><button data-action="clear" ${locked ? 'disabled' : ''}>Limpar resposta</button><span>O preenchimento pode ficar em branco.</span></div><details class="source-text"><summary>Texto integral do instrumento</summary><p>${esc(q.text)}</p></details>`;
  } else {
    body = `<div class="eyebrow">REVISÃO FINAL</div><h1>Um último olhar<br>antes de concluir.</h1><p class="muted">Confira o preenchimento por bloco. Respostas em branco não impedem a conclusão.</p><div class="review-sections">${instrument.sections.map(s => {
      const all = instrument.questions.filter(q => q.section === s.id), qs = all.filter(q => isApplicable(q.id, current.answers)), answered = qs.filter(q => hasAnswer(current.answers[q.id])).length;
      return `<div><span><strong>${esc(s.title)}</strong><small>${answered} de ${qs.length} aplicáveis preenchidas · ${qs.length - answered} em branco · ${all.length - qs.length} puladas</small></span><button data-action="review-section" data-id="${s.id}" ${locked ? 'disabled' : ''}>Revisar →</button></div>`;
    }).join('')}</div>`;
  }
  main.innerHTML = `<div class="interview-shell"><div class="interview-topbar"><span><strong>${esc(current.code)}</strong><small>${esc(current.interviewer || 'Aplicador não informado')}</small></span><button class="text-link" data-action="exit">Salvar e sair ↗</button></div><div class="progress-header"><span>${section ? esc(section.title) : step.type === 'gate' ? 'Continuidade da entrevista' : 'Revisão da entrevista'}</span><span>${pct}% do percurso</span></div><progress max="100" value="${pct}" aria-label="Progresso da entrevista"></progress><article class="question-card ${step.type === 'section' ? 'section-card' : ''}">${body}</article><div class="interview-navigation"><div>${current.position > 0 ? button('← Anterior', 'previous', 'secondary', locked ? 'disabled' : '') : ''}</div><span id="save-status" class="save-status ${dirty ? 'pending' : ''}" role="status">${esc(saveMessage)}</span><div>${button(step.type === 'review' ? 'Concluir entrevista ✓' : step.type === 'section' ? 'Começar bloco →' : 'Próxima →', step.type === 'review' ? 'complete' : 'next', 'primary', locked ? 'disabled' : '')}</div></div><details class="flow-overview"><summary>Visão da entrevista · 7 blocos</summary><ol>${instrument.sections.map(s => `<li class="${s.id === section?.id ? 'active' : ''}">${esc(s.title)}</li>`).join('')}</ol></details></div>`;
}
function filtered() {
  return interviews.filter(i => (!filter.status || i.status === filter.status) && (!filter.search || `${i.code} ${i.interviewer}`.toLocaleLowerCase().includes(filter.search.toLocaleLowerCase())) && (!filter.from || localDay(i.started_at) >= filter.from) && (!filter.to || localDay(i.started_at) <= filter.to));
}
function localDay(iso) { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function renderDashboard() {
  const rows = filtered(), q = instrument.questions.find(q => q.id === filter.question);
  const chartable = instrument.questions.filter(q => ['single', 'multiple'].includes(q.type));
  const applicableRows = rows.filter(i => applies(q, i));
  const answered = applicableRows.filter(i => hasAnswer(i.answers[q.id])).length;
  main.innerHTML = `<div class="page dashboard">${breadcrumb('Painel de respostas')}<div class="page-heading"><div><div class="eyebrow">ACOMPANHAMENTO DA PESQUISA</div><h1>Painel de respostas</h1><p class="muted">Um panorama dos registros do ${storageInfo.provider === "supabase" ? "Supabase conectado" : "banco local"}.</p></div><div class="export-buttons">${button('Exportar CSV ↓', 'csv', 'secondary')}${button('Importar Excel ↑', 'import', 'secondary')}${button('Exportar JSON ↓', 'json', 'secondary')}</div></div><form id="filters" class="filters"><label class="field"><span>Buscar entrevista ou aplicador</span><input name="search" type="search" value="${esc(filter.search)}" placeholder="Código ou nome do aplicador"></label><label class="field"><span>Situação</span><select name="status"><option value="">Todas as situações</option>${Object.entries(statusLabels).map(([v, l]) => `<option value="${v}" ${filter.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="field"><span>Início do período</span><input name="from" type="date" value="${filter.from}"></label><label class="field"><span>Fim do período</span><input name="to" type="date" value="${filter.to}"></label>${button('Filtrar', 'filter', 'primary', 'type="submit"')}</form><div class="metrics"><div><span>Total de entrevistas</span><strong>${rows.length}</strong><small>No período e filtros selecionados</small></div><div><span>Concluídas</span><strong>${rows.filter(i => i.status === 'completed').length}</strong><small>Aplicação finalizada</small></div><div><span>Em andamento</span><strong>${rows.filter(i => i.status === 'in_progress').length}</strong><small>Disponíveis para retomada</small></div><div><span>Interrompidas</span><strong>${rows.filter(i => i.status.startsWith('interrupted')).length}</strong><small>Na abertura ou pausa intermediária</small></div></div><section class="chart-panel"><div class="chart-heading"><div><div class="eyebrow">DISTRIBUIÇÃO DAS RESPOSTAS</div><h2>O que os registros mostram</h2></div><label class="field"><span>Questão</span><select id="chart-question">${chartable.map(item => `<option value="${item.id}" ${q.id === item.id ? 'selected' : ''}>${esc(item.prompt)}</option>`).join('')}</select></label></div><p class="chart-caption">${answered} entrevistas com resposta · ${applicableRows.length - answered} sem resposta · ${rows.length - applicableRows.length} puladas${q.type === 'multiple' ? ' · Múltiplas escolhas; percentuais podem somar mais de 100%.' : ''}</p><div class="bars">${q.options.map(o => {
    const n = applicableRows.filter(i => { const v = i.answers[q.id]?.value; return Array.isArray(v) ? v.includes(o.value) : v === o.value; }).length;
    const percent = answered ? Math.round(n / answered * 100) : 0;
    return `<div class="bar-row"><span>${o.value} · ${esc(o.label)}</span><div class="bar-track"><div style="width:${percent}%"></div></div><strong>${n} <small>(${percent}%)</small></strong></div>`;
  }).join('')}</div></section><div class="table-heading"><h2>Entrevistas <span>${rows.length} registros</span></h2>${button("Imprimir selecionadas (0)", "print-selected", "secondary", "disabled")}</div><p class="print-help">Marque as entrevistas para imprimir juntas. Na janela de impressão, escolha “Salvar como PDF” se desejar.</p>${interviewRows(rows)}<p class="data-note">A exportação segue os filtros selecionados e inclui respostas identificáveis. Guarde os arquivos no local definido pela equipe de pesquisa.</p></div>`;
  updatePrintSelection();
}
function answerText(q, a) {
  if (!hasAnswer(a)) return 'Sem resposta';
  const format = v => q?.options?.find(o => o.value === v) ? `${v} — ${q.options.find(o => o.value === v).label}` : String(v ?? '');
  const parts = [Array.isArray(a.value) ? a.value.map(format).join('; ') : format(a.value)];
  if (a.events?.length) parts.push('Eventos: ' + a.events.map(v => `${v} — ${q.events.find(o => o.value === v)?.label || ''}`).join('; '));
  for (const [key, label] of [['detail', 'Complemento'], ['religion', 'Religião'], ['regular', 'Frequentava regularmente'], ['frequency', 'Frequência semanal']]) if (a[key]) parts.push(`${label}: ${a[key]}`);
  return parts.filter(Boolean).join('\n');
}
function renderLogin(message = '') {
  showSessionIdentity(null);
  main.innerHTML = `<section class="login-card"><div class="eyebrow">PESQUISA · UFRR</div><h1>Acessar a pesquisa</h1><p>Entre com sua conta autorizada para aplicar o questionário e consultar as entrevistas.</p><form id="login-form"><label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" required></label><label class="field"><span>Senha</span><input name="password" type="password" autocomplete="current-password" required></label><p id="login-error" class="login-error" role="alert">${esc(message)}</p><button class="button primary" type="submit">Entrar →</button></form><p class="login-help">Use a conta cadastrada pelo responsável pela pesquisa.</p></section>`;
}
function renderRead() {
  const metadata = [
    ['Nome', esc(current.answers.q1?.value || 'Não informado')],
    ['Aplicador', esc(current.interviewer || 'Não informado')],
    ['Início', date(current.started_at)],
    ['Encerramento', current.ended_at ? date(current.ended_at) : 'Ainda não encerrada'],
    ['Situação', `<span class="status ${current.status}">${statusLabels[current.status]}</span>`],
    ['Instrumento', `Versão ${esc(current.instrument_version)}`],
  ];
  main.innerHTML = `<div class="page read-page">${breadcrumb('Consulta da entrevista')}<div class="page-heading"><div><div class="eyebrow">CONSULTA · SOMENTE LEITURA</div><h1>${esc(current.code)}</h1></div><div class="read-actions">${button('Voltar ao painel', 'dashboard', 'secondary')}${button('Imprimir / PDF', 'print', 'primary', `data-id="${current.id}"`)}${current.status === 'in_progress' ? button('Continuar entrevista →', 'open', 'secondary', `data-id="${current.id}"`) : ''}</div></div><dl class="read-metadata" aria-label="Dados da entrevista">${metadata.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>${recoverySnapshot?.id === current.id ? `<div class="notice">Alterações não enviadas foram preservadas em uma cópia. ${button('Baixar cópia pendente', 'recovery-export', 'secondary')}</div>` : ''}${recordContent(current)}</div>`;
}
function recordContent(interview, printing = false) {
  const gate = id => interview.answers[id]?.value === 1 ? 'Sim' : interview.answers[id]?.value === 0 ? 'Não' : 'Sem resposta';
  return `<div class="read-gates"><p><strong>Abertura:</strong> ${gate('opening')}</p><p><strong>Pausa intermediária:</strong> ${gate('checkpoint')}</p></div>${instrument.sections.map(s => `<section class="read-section"><h2>${esc(s.title)}</h2>${instrument.questions.filter(q => q.section === s.id).map(q => {
    const applicable = applies(q, interview), filled = hasAnswer(interview.answers[q.id]);
    return `<div class="read-answer"><h3>${esc(printing ? q.text : q.prompt)}</h3>${applicable ? '' : `<p class="skipped-label">Pulada conforme as respostas anteriores.${filled ? ' Resposta anterior preservada abaixo.' : ''}</p>`}<p>${!applicable && !filled ? 'Não se aplica ao percurso desta entrevista.' : esc(answerText(q, interview.answers[q.id]))}</p></div>`;
  }).join('')}</section>`).join('')}`;
}

function updatePrintSelection() {
  const rows = filtered(), selected = rows.filter(i => selectedPrint.has(i.id)).length;
  const all = $('#print-all');
  if (all) { all.checked = rows.length > 0 && selected === rows.length; all.indeterminate = selected > 0 && selected < rows.length; }
  document.querySelectorAll('[data-print-id]').forEach(el => { el.checked = selectedPrint.has(el.dataset.printId); });
  const btn = $('[data-action="print-selected"]');
  if (btn) { btn.disabled = selected === 0; btn.textContent = `Imprimir selecionadas (${selected})`; }
}

async function printInterviews(ids) {
  if (!ids.length) return toast('Selecione ao menos uma entrevista para imprimir.');
  const records = await Promise.all(ids.map(id => api(`/api/interviews/${id}`)));
  let area = $('#print-area');
  if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.append(area); }
  area.innerHTML = records.map(i => `<article class="print-interview"><header class="print-heading"><p>Pesquisa Biopsicossocial · UFRR</p><h1>${esc(i.code)}</h1><p><strong>Nome (Q1):</strong> ${esc(i.answers.q1?.value || 'Não informado')}<br><strong>Aplicador:</strong> ${esc(i.interviewer || 'Não informado')}<br><strong>Início:</strong> ${date(i.started_at)}${i.ended_at ? `<br><strong>Encerramento:</strong> ${date(i.ended_at)}` : ''}<br><strong>Situação:</strong> ${statusLabels[i.status]} · Instrumento ${esc(i.instrument_version)}</p></header>${recordContent(i, true)}</article>`).join('');
  await document.fonts.ready;
  window.print();
}

function showImport() {
  importPreview = null;
  const dialog = $('#dialog'); dialog.classList.add('import-dialog');
  dialog.innerHTML = `<form method="dialog"><div class="eyebrow">IMPORTAR ENTREVISTAS</div><h2>Importar do Excel</h2><p>Escolha um arquivo <strong>.xlsx ou .csv</strong>, com uma entrevista por linha. Confira a prévia antes de gravar. Registros com código já cadastrado serão ignorados.</p><p><a href="./api/import/template" ${onlineClient ? 'data-action="import-template"' : 'download'}>Baixar modelo Excel com instruções ↓</a></p><label class="field"><span>Planilha (até 500 entrevistas / 5 MB)</span><input id="import-input" type="file" accept=".xlsx,.csv"></label><div class="dialog-actions"><button class="button secondary" value="cancel">Fechar</button>${button('Conferir planilha', 'import-file', 'primary', 'type="button"')}</div><div id="import-results" aria-live="polite"></div></form>`;
  dialog.addEventListener('close', () => { dialog.classList.remove('import-dialog'); importPreview = null; }, { once: true });
  dialog.showModal();
}
async function previewImport() {
  const file = $('#import-input').files[0], results = $('#import-results');
  if (!file) { results.innerHTML = '<p class="import-error">Selecione um arquivo para conferir.</p>'; return; }
  if (file.size > 5_000_000) { results.innerHTML = '<p class="import-error">O limite é de 5 MB por arquivo.</p>'; return; }
  const btn = $('[data-action="import-file"]'); btn.disabled = true; $('#import-input').disabled = true;
  importPreview = null; results.textContent = 'Conferindo a planilha…';
  try {
    const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.')); reader.readAsDataURL(file); });
    const preview = await api('/api/import/preview', { method: 'POST', body: JSON.stringify({ filename: file.name, content }) });
    if (!$('#dialog').open || $('#import-results') !== results) return;
    importPreview = preview;
    results.innerHTML = `<div class="import-summary"><strong>${preview.ready} novas entrevistas</strong><span>${preview.duplicates} duplicadas serão ignoradas · ${preview.errors.length} erros</span><small>Planilha: ${esc(preview.sheet)}</small></div>${preview.errors.length ? `<ul class="import-errors">${preview.errors.map(e => `<li>Linha ${e.line}: ${esc(e.message)}</li>`).join('')}</ul><p>Corrija as linhas indicadas e selecione o arquivo novamente. Nenhum registro foi gravado.</p>` : ''}<div class="import-preview-list">${preview.rows.map(r => `<div><strong>Linha ${r.line} · ${esc(r.code)}</strong><span>${esc(r.name || 'Q1 não preenchida')} · ${statusLabels[r.status]}</span><small>${r.duplicate ? 'Duplicada — será ignorada' : 'Nova entrevista'}</small></div>`).join('')}</div>${button('Importar ' + preview.ready + ' entrevistas', 'import-confirm', 'primary', `type="button" ${preview.errors.length || !preview.ready ? 'disabled' : ''}`)}`;
  } catch (e) { results.innerHTML = `<p class="import-error">${esc(e.message)}</p>`; }
  finally { btn.disabled = false; if ($('#import-input')) $('#import-input').disabled = false; }
}
async function commitImport() {
  if (!importPreview || importPreview.errors.length || !importPreview.ready) return;
  const btn = $('[data-action="import-confirm"]'); btn.disabled = true;
  try {
    const result = await api('/api/import/commit', { method: 'POST', body: JSON.stringify({ token: importPreview.token }) });
    $('#dialog').close(); await refresh(); go('dashboard');
    toast(`${result.imported} entrevistas importadas. ${result.skipped} duplicadas ignoradas.`);
  } catch (e) { toast(e.message); btn.disabled = false; }
}
function renderEnd() {
  const completed = current.status === 'completed';
  main.innerHTML = `<section class="end-screen"><span class="end-icon" aria-hidden="true">${completed ? '✓' : 'Ⅱ'}</span><div class="eyebrow">${esc(current.code)}</div><h1>${completed ? 'Entrevista concluída.' : 'Entrevista interrompida.'}</h1><p>${completed ? `As respostas foram registradas no ${storageInfo.provider === 'supabase' ? 'Supabase' : 'banco local'}.` : 'As respostas registradas até este momento foram preservadas.'}</p><span class="status ${current.status}">${statusLabels[current.status]}</span><div class="hero-actions">${button('Voltar ao início', 'home')}${button('Consultar registro', 'read', 'secondary', `data-id="${current.id}"`)}</div></section>`;
}
async function refresh() { interviews = await api('/api/interviews'); }
async function openInterview(id) {
  current = await api(`/api/interviews/${id}`); dirty = false; locked = false;
  let baseline = current.answers;
  recoverySnapshot = undefined;
  try {
    const pending = JSON.parse(localStorage.getItem(storageKey(id)) || 'null');
    recoverySnapshot = JSON.parse(localStorage.getItem(storageKey(id) + '.recovery') || 'null');
    if (pending) {
      baseline = pending._syncBase || (pending.revision === current.revision ? current.answers : {});
      current = pending; dirty = true;
      saveMessage = 'Recuperando alterações pendentes…';
    } else saveMessage = 'Todas as alterações salvas';
  } catch { toast('Não foi possível ler a cópia pendente deste navegador.'); }
  setupAutosave({ pending: dirty, baseline });
  if (current.status !== 'in_progress' && !dirty) return go('read');
  const position = current.position;
  normalizeCurrent(current);
  if (position !== current.position) changed();
  go('interview'); if (dirty) flush();
}
async function confirmDialog(title, message, label) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="dialog-actions"><button value="cancel" class="button secondary">Voltar</button><button value="confirm" class="button primary">${esc(label)}</button></div></form>`;
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function newInterview() {
  const dialog = $('#dialog');
  dialog.innerHTML = `<form method="dialog"><div class="eyebrow">NOVA ENTREVISTA</div><h2>Antes de começar</h2><p>O código e o horário serão registrados automaticamente.</p><label class="field"><span>Aplicador <small>(opcional)</small></span><input name="interviewer" maxlength="200" autocomplete="name" placeholder="Nome ou código do aplicador"></label><div class="dialog-actions"><button value="cancel" class="button secondary">Voltar</button><button value="confirm" class="button primary">Iniciar entrevista →</button></div></form>`;
  dialog.showModal();
  const confirmed = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  if (!confirmed) return;
  const interviewer = $('[name=interviewer]', dialog).value.trim();
  current = await api('/api/interviews', { method: 'POST', body: JSON.stringify({ interviewer }) });
  dirty = false; locked = false; recoverySnapshot = undefined; setupAutosave(); saveMessage = 'Entrevista criada e salva'; go('interview');
}
function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportData(format) {
  const rows = filtered(), name = `pesquisa-ufrr-${localDay(new Date().toISOString())}`;
  if (format === 'json') return download(name + '.json', JSON.stringify({ instrument_version: instrument.version, exported_at: new Date().toISOString(), interviews: rows }, null, 2), 'application/json');
  const columns = ['code', 'instrument_version', 'interviewer', 'status', 'position', 'started_at', 'updated_at', 'ended_at', 'opening', ...instrument.questions.map(q => q.id), 'checkpoint'];
  const cell = value => { let s = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  const csv = [columns, ...rows.map(i => columns.map(c => c in i ? i[c] : i.answers[c] ? JSON.stringify(i.answers[c]) : ''))].map(row => row.map(cell).join(';')).join('\r\n');
  download(name + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
}
async function action(name, el) {
  if (name === 'manual') { $('#manual-dialog').showModal(); return; }
  if (name === 'logout' && onlineClient) {
    if (dirty && !await flush()) return toast('Há respostas pendentes. Aguarde a sincronização antes de sair.');
    await onlineClient.signOut(); current = undefined; autosave = undefined; interviews = []; dirty = false;
    $('#account-button').hidden = true; showSessionIdentity(null); go('login'); return;
  }
  if (name === 'login' && onlineClient) { go('login'); return; }
  if (view === 'login' && onlineClient) return;
  if (name === 'import-template' && onlineClient) {
    download('modelo-entrevistas-ufrr.xlsx', await onlineClient.template(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return;
  }
  if (view === 'interview' && ['previous', 'next', 'complete', 'exit', 'home'].includes(name)) {
    const numeric = $('input[type="number"]');
    if (numeric && !numeric.reportValidity()) return;
  }
  if (name === 'new') return newInterview();
  if (name === 'home' || name === 'resume' || name === 'dashboard') { if (dirty && !await flush()) { toast('Há alterações pendentes. Mantenha esta aba aberta enquanto tentamos salvar novamente.'); return; } await refresh(); go(name); }
  if (name === 'open') return openInterview(el.dataset.id);
  if (name === 'read') {
    current = await api(`/api/interviews/${el.dataset.id}`);
    if (recoverySnapshot?.id !== current.id) recoverySnapshot = undefined;
    try { recoverySnapshot = JSON.parse(localStorage.getItem(storageKey(current.id) + '.recovery') || 'null') || recoverySnapshot; } catch {}
    go('read');
  }
  if (name === 'exit') { if (await flush()) { await refresh(); go('home'); toast('Entrevista salva. Você poderá continuar depois.'); } else toast('O banco ainda não confirmou o salvamento. Sua cópia permanece pendente.'); }
  if (name === 'previous') { if (locked) return; current.position = movePosition(flow, current.position, current.answers, -1); changed(); render(); main.focus(); }
  if (name === 'next') {
    if (locked) return;
    const step = flow[current.position];
    if (step.type === 'gate') {
      const value = current.answers[step.id]?.value;
      if (value === undefined) return toast('Selecione Não ou Sim para registrar a continuidade da entrevista.');
      if (value === 0) {
        if (!await confirmDialog('Encerrar a entrevista?', 'Se a resposta for Não, a entrevista será interrompida neste ponto. Os registros anteriores serão preservados.', 'Registrar interrupção')) return;
        locked = true; render();
        if (await flush('interrupt')) go('end'); else { locked = false; render(); if (view !== 'read') toast('Não foi possível confirmar a interrupção. Tente novamente.'); }
        return;
      }
    }
    current.position = movePosition(flow, current.position, current.answers); changed(); render(); main.focus(); window.scrollTo({ top: 0 });
  }
  if (name === 'clear') { if (locked) return; current.answers[flow[current.position].id] = {}; changed(); render(); }
  if (name === 'review-section') { if (locked) return; current.position = normalizePosition(flow, flow.findIndex(s => s.id === instrument.questions.find(q => q.section === el.dataset.id).id), current.answers); changed(); render(); main.focus(); }
  if (name === 'complete') {
    if (locked || !await confirmDialog('Concluir esta entrevista?', 'Após a conclusão, o registro ficará disponível somente para leitura.', 'Concluir entrevista')) return;
    locked = true; render();
    if (await flush('complete')) go('end'); else { locked = false; render(); if (view !== 'read') toast('A conclusão ainda não foi salva. Tente novamente.'); }
  }
  if (['csv', 'json'].includes(name)) exportData(name);
  if (name === 'print') return printInterviews([el.dataset.id]);
  if (name === 'print-selected') return printInterviews(filtered().filter(i => selectedPrint.has(i.id)).map(i => i.id));
  if (name === 'import') return showImport();
  if (name === 'import-file') return previewImport();
  if (name === 'import-confirm') return commitImport();
  if (name === 'recovery-export' && recoverySnapshot) download(recoverySnapshot.code + '-copia-pendente.json', JSON.stringify(recoverySnapshot, null, 2), 'application/json');
}
document.addEventListener('click', event => {
  const el = event.target.closest('[data-action]');
  if (el && el.dataset.action !== 'filter') { event.preventDefault(); action(el.dataset.action, el).catch(e => toast(e.message)); }
  const font = event.target.closest('[data-font]');
  if (font) { const previous = Number(document.documentElement.dataset.zoom || 0); const next = Number(font.dataset.font) === 0 ? 0 : Math.min(3, Math.max(-1, previous + Number(font.dataset.font))); document.documentElement.dataset.zoom = next; document.documentElement.style.fontSize = `${100 + next * 10}%`; try { localStorage.setItem('ufrr.font', next); } catch {} }
  if (event.target.closest('.brand')) { event.preventDefault(); action('home').catch(e => toast(e.message)); }
});
document.addEventListener('input', event => {
  const field = event.target.dataset.field;
  if (!field || locked || view !== 'interview') return;
  const id = flow[current.position].id, q = instrument.questions.find(q => q.id === id), a = current.answers[id] ||= {};
  const input = event.target;
  if (input.type === 'radio') a[field] = Number(input.value);
  else if (input.type === 'checkbox') { const previous = Array.isArray(a[field]) ? a[field] : typeof a[field] === 'number' ? [a[field]] : []; a[field] = input.checked ? [...new Set([...previous, Number(input.value)])] : previous.filter(v => v !== Number(input.value)); }
  else if (input.type === 'number') {
    if (!input.validity.valid) { input.reportValidity(); return; }
    a[field] = input.value === '' ? '' : Number(input.value);
  } else a[field] = input.value;
  changed();
  if (input.type === 'radio' || input.type === 'checkbox') {
    const focusValue = input.value;
    if (q) $('#answer-inputs').innerHTML = answerInputs(q); else render();
    $(`[data-field="${field}"][value="${focusValue}"]`)?.focus({ preventScroll: true });
  }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'login-form') {
    event.preventDefault();
    const form = event.target, submit = form.querySelector('button[type=submit]'), error = $('#login-error');
    submit.disabled = true; submit.textContent = 'Entrando…'; error.textContent = '';
    onlineClient.signIn(form.elements.email.value.trim(), form.elements.password.value)
      .then(async () => { await refresh(); showSessionIdentity(await onlineClient.session()); const account = $('#account-button'); account.hidden = false; account.dataset.action = 'logout'; account.textContent = 'Sair da conta'; go('home'); })
      .catch(e => { error.textContent = e.message; })
      .finally(() => { form.elements.password.value = ''; submit.disabled = false; submit.textContent = 'Entrar →'; });
    return;
  }
  if (event.target.id !== 'filters') return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  if (values.from && values.to && values.from > values.to) return toast('O início do período deve ser anterior ao fim.');
  filter = { ...filter, ...values }; renderDashboard();
});
document.addEventListener('change', event => {
  if (event.target.id === 'chart-question') { filter.question = event.target.value; renderDashboard(); $('#chart-question').focus(); }
  if (event.target.matches('[data-print-id]')) { if (event.target.checked) selectedPrint.add(event.target.dataset.printId); else selectedPrint.delete(event.target.dataset.printId); updatePrintSelection(); }
  if (event.target.id === 'print-all') { for (const i of filtered()) { if (event.target.checked) selectedPrint.add(i.id); else selectedPrint.delete(i.id); } updatePrintSelection(); }
  if (event.target.id === 'import-input') { importPreview = null; $('#import-results').innerHTML = ''; }
});
window.addEventListener('online', () => { if (dirty) flush(); });
window.addEventListener('beforeunload', event => { if (dirty) { pendingStore(); event.preventDefault(); event.returnValue = ''; } });
$('#sync-dialog').addEventListener('cancel', event => event.preventDefault());
$('#manual-dialog').addEventListener('close', () => $('[data-action="manual"]').focus({ preventScroll: true }));
setInterval(() => { if (dirty && !autosave?.saving) flush(); }, 5000);
try {
  const zoom = Number(localStorage.getItem('ufrr.font') || 0); if (zoom >= -1 && zoom <= 3) { document.documentElement.dataset.zoom = zoom; document.documentElement.style.fontSize = `${100 + zoom * 10}%`; }
} catch {}
try {
  instrument = await api('/questionnaire.json');
  const webMode = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || new URLSearchParams(location.search).get('online') === '1';
  if (webMode) {
    const hosting = await fetch(new URL('./hosting.json', import.meta.url)).then(r => r.json());
    const { createOnlineClient } = await import('./web/online.js');
    onlineClient = createOnlineClient(hosting, instrument);
  }
  const config = await api('/api/config');
  storageInfo = config.storage;
  flow = buildFlow(instrument);
  $('#footer-instrument').textContent = `Instrumento ${instrument.version} · ${storageInfo.label}`;
  $('.local-pill').innerHTML = `<i></i> ${esc(storageInfo.label)}`;
  const session = onlineClient ? await onlineClient.session() : null;
  if (onlineClient && !session) go('login');
  else {
    if (onlineClient) { await onlineClient.checkAccess(); showSessionIdentity(session); $('#account-button').hidden = false; }
    await refresh(); render();
  }
} catch (e) {
  if (onlineClient) { view = 'login'; renderLogin(e.message); }
  else main.innerHTML = `<div class="empty-state"><h1>Não foi possível abrir o sistema</h1><p>${esc(e.message)}</p><p>Verifique a conexão e recarregue a página.</p></div>`;
}
