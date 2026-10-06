// Builds the single-file app from src/. Run: npm run build
//   dist/artifact.html – page body only (for publishing as a claude.ai artifact)
//   dist/index.html    – full standalone page (open locally or host on GitHub Pages)
// TypeScript sources are turned into plain JavaScript with Node's built-in type
// stripping (node:module stripTypeScriptTypes), so the build needs no npm packages.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { stripTypeScriptTypes }: typeof import('node:module') = require('node:module');

const ROOT = __dirname;
const XLSX_CDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>';
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Browser scripts in load order. `.ts` files have their types removed. */
const SOURCES = ['core.js', 'charts.ts', 'sample.js', 'app.ts'];

function toJs(name: string): string {
  const code = read('src/' + name);
  return name.endsWith('.ts') ? stripTypeScriptTypes(code, { mode: 'strip' }) : code;
}

const page = read('src/page.html');
const scripts = SOURCES.map((name) => `<script>\n${toJs(name)}\n</script>`).join('\n');
const body = `${page}\n${XLSX_CDN}\n${scripts}\n`;

const out = path.join(ROOT, 'dist');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'artifact.html'), body);
const standalone =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  '<style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>\n' +
  '</head>\n<body>\n' + body + '</body>\n</html>\n';
fs.writeFileSync(path.join(out, 'index.html'), standalone);
console.log(`built dist/artifact.html (${Math.floor(Buffer.byteLength(body) / 1024)} KB) and dist/index.html`);
