import { createClient } from '@supabase/supabase-js';
import { buildFlow } from '../public/flow.js';
import { validateAnswers } from '../shared/validation.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
export function createOnlineClient(config, instrument) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url) || !config.publishableKey?.startsWith('sb_publishable_')) {
    throw new Error('A conexão pública com o Supabase ainda não foi configurada.');
  }
  const project = new URL(config.url).hostname.split('.')[0];
  const client = createClient(config.url, config.publishableKey, {
    auth: { storage: sessionStorage, storageKey: `qest.auth.${project}`, detectSessionInUrl: false },
  });
  const previews = new Map(), flow = buildFlow(instrument);
  async function rpc(operation, payload = {}) {
    const { data, error } = await client.rpc('Qest_web', { p_operation: operation, p_payload: payload }).abortSignal(AbortSignal.timeout(30000));
    if (!error) return data;
    const errors = {
      PT403: [403, 'Este e-mail ainda não tem acesso a esta pesquisa. Solicite a autorização ao responsável.'],
      PT404: [404, 'Entrevista não encontrada.'],
      PT409: [409, 'Existe uma versão mais recente desta entrevista.'],
      PT400: [400, 'Confira as respostas, a posição e os pontos de continuidade da entrevista.'],
      PGRST202: [503, 'A conexão está aguardando a instalação do SQL 003_Qest_acesso_web.sql no Supabase.'],
      PGRST301: [401, 'Sua sessão expirou. Entre novamente para continuar.'],
      PGRST303: [401, 'Sua sessão expirou. Entre novamente para continuar.'],
      '42501': [403, 'Entre com uma conta autorizada para acessar esta pesquisa.'],
    };
    throw fail(...(errors[error.code] || [503, 'Não foi possível conectar ao Supabase. Suas alterações continuam pendentes.']));
  }
  async function list() {
    const rows = []; let after = null;
    while (true) {
      const page = await rpc('list', { after, limit: 200 });
      rows.push(...page);
      if (page.length < 200) break;
      const last = page.at(-1).id;
      if (last === after) throw fail(502, 'Não foi possível continuar a consulta.');
      after = last;
    }
    return rows.sort((a,b)=>b.started_at.localeCompare(a.started_at));
  }
  const spreadsheet = () => import('./spreadsheet-online.js');
  async function fingerprint(row, content) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content(row)));
    return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  return {
    async session() { const {data,error} = await client.auth.getSession(); if (error) return null; return data.session; },
    async signIn(email,password) {
      const {error} = await client.auth.signInWithPassword({email,password});
      if (error) throw fail(401,'Não foi possível entrar. Confira o e-mail e a senha da sua conta.');
      await rpc('health');
    },
    async signOut() { previews.clear(); const {error} = await client.auth.signOut({scope:'local'}); if (error) throw fail(503,'Não foi possível encerrar a sessão.'); },
    async checkAccess() { return rpc('health'); },
    async template() { return (await spreadsheet()).createTemplate(instrument); },
    async api(url, options = {}) {
      const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : {};
      if (url === '/api/config') return {storage:{provider:'supabase',label:'Banco Supabase',scope:`supabase-web-${project}`}};
      if (url === '/api/interviews') return method === 'POST' ? rpc('create',body) : list();
      const match = /^\/api\/interviews\/([a-f0-9-]+)$/.exec(url);
      if (match) {
        if (method === 'GET') return rpc('get',{id:match[1]});
        validateAnswers(body.answers,instrument);
        return rpc('save',{...body,id:match[1]});
      }
      if (url === '/api/import/preview') {
        const {parseSpreadsheet,prepareImport,fingerprintContent} = await spreadsheet();
        const parsed = await parseSpreadsheet(body);
        const prepared = prepareImport(parsed,instrument,flow,a=>validateAnswers(a,instrument));
        const rows = await Promise.all(prepared.rows.map(async row=>({...row,fingerprint:await fingerprint(row,fingerprintContent)})));
        const duplicates = await rpc('duplicates',{rows:rows.map(({code,fingerprint})=>({code,fingerprint}))});
        const codes = new Set(), fingerprints = new Set();
        rows.forEach((row,index)=>{
          row.duplicate = !!duplicates[index] || !!(row.code && codes.has(row.code)) || fingerprints.has(row.fingerprint);
          if(row.code) codes.add(row.code); fingerprints.add(row.fingerprint);
        });
        for (const [key,preview] of previews) if(preview.expires<Date.now()) previews.delete(key);
        if(previews.size>=10) previews.delete(previews.keys().next().value);
        const token = crypto.randomUUID();
        previews.set(token,{rows,errors:prepared.errors,expires:Date.now()+15*60000});
        return {token,sheet:parsed.sheet,errors:prepared.errors,total:rows.length+prepared.errors.length,
          duplicates:rows.filter(r=>r.duplicate).length,ready:rows.filter(r=>!r.duplicate).length,
          rows:rows.map(r=>({line:r.line,code:r.code||'Gerado automaticamente',name:r.answers.q1?.value||'',status:r.status,duplicate:r.duplicate}))};
      }
      if (url === '/api/import/commit') {
        const preview = previews.get(body.token);
        if(!preview || preview.expires<Date.now()) throw fail(400,'Prévia expirada. Selecione a planilha novamente.');
        if(preview.errors.length) throw fail(400,'Corrija os erros da planilha antes de importar.');
        const result = await rpc('import',{rows:preview.rows}); previews.delete(body.token); return result;
      }
      throw fail(404,'Operação desconhecida.');
    },
  };
}
