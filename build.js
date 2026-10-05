// Builds the single-file app from src/. Run: node build.js  (or npm run build)
//   dist/artifact.html – page body only (for publishing as a claude.ai artifact)
//   dist/index.html    – full standalone page (open locally or host on GitHub Pages)
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const XLSX_CDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const page = read('src/page.html');
const scripts = ['core.js', 'charts.js', 'sample.js', 'app.js']
  .map((name) => `<script>\n${read('src/' + name)}\n</script>`)
  .join('\n');
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
