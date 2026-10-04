import { build } from 'esbuild';
import fs from 'node:fs';
await build({ entryPoints: ['browser/online.js'], outdir: 'public/web', bundle: true, splitting: true,
  format: 'esm', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'eof', metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (!fs.existsSync('public/hosting.json')) throw new Error('Configure public/hosting.json com URL e chave PUBLICÁVEL antes de publicar.');
const config = JSON.parse(fs.readFileSync('public/hosting.json','utf8'));
if (!config.publishableKey?.startsWith('sb_publishable_') || JSON.stringify(config).includes('sb_secret_')) throw new Error('Somente chave pública pode ser publicada.');
console.log('Interface preparada para GitHub Pages.');
