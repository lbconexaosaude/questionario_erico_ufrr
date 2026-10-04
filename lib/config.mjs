import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createSQLiteStore } from './sqlite-store.mjs';
import { createSupabaseStore } from './supabase-store.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function loadLocalEnv() {
  const filename = path.join(root, '.env');
  if (fs.existsSync(filename)) loadEnvFile(filename);
}
export function configuredStore(env = process.env) {
  const provider = env.STORAGE_PROVIDER || 'sqlite';
  if (provider === 'sqlite') return createSQLiteStore(env.DB_PATH || path.join(root, 'storage/research.sqlite'));
  if (provider === 'supabase') return createSupabaseStore({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY });
  throw new Error('STORAGE_PROVIDER deve ser sqlite ou supabase.');
}
