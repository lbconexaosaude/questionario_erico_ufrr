import { loadLocalEnv } from '../lib/config.mjs';
import { createSupabaseStore } from '../lib/supabase-store.mjs';

loadLocalEnv();
try {
  const store = createSupabaseStore({ url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY });
  const result = await store.health();
  if (result.schema_version !== 1 || result.prefix !== 'Qest_') throw new Error('Versão SQL inesperada. Execute sql/001_Qest_supabase.sql.');
  console.log('Conexão Supabase confirmada. Objetos Qest_ disponíveis. Nenhuma entrevista foi criada ou modificada.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
