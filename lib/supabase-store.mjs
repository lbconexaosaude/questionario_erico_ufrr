import { createHash } from 'node:crypto';

export function createSupabaseStore({ url, secretKey, fetchImpl = fetch }) {
  if (!url || !secretKey) throw new Error('Configure SUPABASE_URL e SUPABASE_SECRET_KEY no .env antes de selecionar Supabase.');
  let origin;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error();
    origin = parsed.origin;
  } catch { throw new Error('SUPABASE_URL deve ser a URL HTTPS do projeto, sem caminhos adicionais.'); }
  const legacy = secretKey.startsWith('eyJ');
  if (legacy) {
    try {
      const payload = JSON.parse(Buffer.from(secretKey.split('.')[1], 'base64url').toString());
      if (payload.role !== 'service_role') throw new Error();
    } catch { throw new Error('Use a chave secret do servidor ou a chave legada service_role, nunca anon/publishable.'); }
  } else if (!secretKey.startsWith('sb_secret_')) throw new Error('SUPABASE_SECRET_KEY deve conter a chave secret do servidor (sb_secret_...).');

  async function rpc(operation, payload = {}) {
    let response;
    try {
      response = await fetchImpl(origin + '/rest/v1/rpc/Qest_store', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', apikey: secretKey, ...(legacy ? { Authorization: `Bearer ${secretKey}` } : {}) },
        body: JSON.stringify({ p_operation: operation, p_payload: payload }),
      });
    } catch { throw Object.assign(new Error('Não foi possível conectar ao Supabase. Verifique a conexão e tente novamente.'), { status: 503 }); }
    let result;
    try { result = await response.json(); } catch { throw Object.assign(new Error('Resposta inválida do Supabase.'), { status: 502 }); }
    if (!response.ok) {
      // Nunca repassar detalhes internos do provedor, credenciais ou respostas da pesquisa.
      const messages = {
        PT404: [404, 'Entrevista não encontrada.'],
        PT409: [409, 'A entrevista foi alterada ou encerrada em outra sessão. Preserve sua cópia pendente e recarregue.'],
        PT400: [400, 'O banco recusou os dados da entrevista. Confira o preenchimento.'],
        PGRST202: [503, 'Execute o SQL Qest_ no projeto Supabase antes de conectar.'],
        '42501': [503, 'A chave configurada não tem permissão para os objetos Qest_. Confira a configuração.'],
      };
      const [status, message] = messages[result?.code] || [503, response.status === 401 || response.status === 403 ? 'Confira a URL e a chave secreta do Supabase no .env.' : 'O Supabase não confirmou a operação. As alterações continuam pendentes.'];
      throw Object.assign(new Error(message), { status });
    }
    return result;
  }
  return {
    info: { provider: 'supabase', label: 'Banco Supabase', scope: 'supabase-' + createHash('sha256').update(origin).digest('hex').slice(0, 16) },
    health: () => rpc('health'),
    get: id => rpc('get', { id }),
    create: data => rpc('create', data),
    save: data => rpc('save', data),
    findDuplicates: rows => rpc('duplicates', { rows: rows.map(r => ({ code: r.code, fingerprint: r.fingerprint })) }),
    importRows: rows => rpc('import', { rows }),
    async list() {
      const rows = []; let after = null;
      do {
        const page = await rpc('list', { after, limit: 200 });
        if (!Array.isArray(page)) throw Object.assign(new Error('Lista de entrevistas inválida no Supabase.'), { status: 502 });
        if (!page.length) break;
        rows.push(...page);
        const last = page.at(-1).id;
        if (last === after) throw Object.assign(new Error('Paginação inválida no Supabase.'), { status: 502 });
        after = last;
        if (page.length < 200) break;
      } while (true);
      return rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
    },
    close() {},
  };
}
