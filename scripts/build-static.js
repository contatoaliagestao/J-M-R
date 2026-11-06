// Empacota os arquivos da pasta public/ dentro do código do Worker (src/generated/static.js).
// Roda automaticamente antes de dev, test e deploy.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = {};
for (const full of walk(ROOT)) {
  const rel = '/' + path.relative(ROOT, full).split(path.sep).join('/');
  const type = TYPES[path.extname(full).toLowerCase()];
  if (!type) continue;
  files[rel] = { type, b64: readFileSync(full).toString('base64') };
}

mkdirSync(path.resolve(import.meta.dirname, '..', 'src', 'generated'), { recursive: true });
writeFileSync(path.resolve(import.meta.dirname, '..', 'src', 'generated', 'static.js'),
  '// Arquivo gerado por scripts/build-static.js — não edite.\nexport default ' + JSON.stringify(files) + ';\n');
console.log(`${Object.keys(files).length} arquivos empacotados.`);
