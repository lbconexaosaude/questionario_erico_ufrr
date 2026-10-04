import fs from 'node:fs';
import { buildFlow } from '../public/flow.js';
const instrument = JSON.parse(fs.readFileSync(new URL('../public/questionnaire.json',import.meta.url),'utf8'));
const config = { version: instrument.version, flow: buildFlow(instrument).map(s=>s.id), questions: Object.fromEntries([
  ...instrument.questions.map(q=>[q.id,{type:q.type,options:q.options?.map(o=>o.value)||[]}]),
  ['opening',{type:'single',options:[0,1]}],['checkpoint',{type:'single',options:[0,1]}],
]) };
const template = fs.readFileSync(new URL('../sql/templates/web-access.sql',import.meta.url),'utf8');
const sql = template.replace('-- INSTRUMENT_CONFIG',`insert into public."Qest_web_config" (singleton,instrument) values (true,'${JSON.stringify(config).replaceAll("'","''")}'::jsonb) on conflict (singleton) do update set instrument=excluded.instrument;`);
fs.writeFileSync(new URL('../sql/003_Qest_acesso_web.sql',import.meta.url),sql);
console.log('SQL de acesso web gerado.');
