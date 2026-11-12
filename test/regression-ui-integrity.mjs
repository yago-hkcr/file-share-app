// Regressões de integridade da interface: CSS válido, HTML balanceado,
// variáveis CSS definidas e abas do ADM sem sobrescrita.
// Uso: node test/regression-ui-integrity.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const csstree = require(path.join(ROOT, 'node_modules', 'css-tree'));
const PUBLIC = path.join(ROOT, 'public');

function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const cssFiles = walk(PUBLIC, name => name.endsWith('.css'));
const htmlFiles = walk(PUBLIC, name => name.endsWith('.html'));
assert.ok(cssFiles.length > 0 && htmlFiles.length > 0);

// 1) Todo CSS precisa ser sintaticamente válido (um comentário aberto ou uma
// chave sobrando já deslocava regras inteiras de layout).
for (const file of cssFiles) {
  const errors = [];
  csstree.parse(readFileSync(file, 'utf8'), {
    positions: true,
    onParseError(error) { errors.push(error.formattedMessage || error.message); }
  });
  assert.deepEqual(errors, [], 'CSS inválido em ' + path.relative(ROOT, file));
}

// 2) Variáveis usadas por var() precisam existir em algum CSS ou ser criadas
// via JS. Uma variável sem definição deixa a propriedade inteira inválida.
let cssSource = '';
for (const file of cssFiles) cssSource += readFileSync(file, 'utf8') + '\n';
const jsSource = walk(path.join(PUBLIC, 'js'), name => /\.(js|mjs)$/.test(name) && !name.startsWith('_'))
  .map(file => readFileSync(file, 'utf8')).join('\n');
const defined = new Set([...cssSource.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
for (const match of jsSource.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) defined.add(match[1]);
for (const match of jsSource.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
// var() com fallback (ex.: var(--x, #fff)) é seguro mesmo sem definição.
const missing = [...new Set([...cssSource.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(match => match[1]))]
  .filter(name => !defined.has(name));
assert.deepEqual(missing, [], 'Variáveis CSS usadas sem definição: ' + missing.join(', '));

// 3) HTML precisa ter tags balanceadas. O fechamento errado de um <section>
// como </div> desorganizava o bloco de armazenamento do painel ADM.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const stack = [];
  const problems = [];
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    const tag = match[1].toLowerCase();
    if (VOID.has(tag) || match[2] === '/') continue;
    if (match[0][1] !== '/') { stack.push(tag); continue; }
    const opened = stack.pop();
    if (opened !== tag) problems.push('esperava </' + opened + '> e veio </' + tag + '>');
  }
  for (const tag of stack) problems.push('não fechou <' + tag + '>');
  assert.deepEqual(problems, [], 'HTML desbalanceado em ' + path.relative(ROOT, file));
}

// 4) O service worker usa cache-first para /css e /js. A versão pré-cacheada
// precisa ser a mesma referenciada pelo HTML; senão o usuário recebe o arquivo
// antigo do cache mesmo depois de uma correção.
const sw = readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const htmlSource = htmlFiles.map(file => readFileSync(file, 'utf8')).join('\n');
const swAssets = [...sw.matchAll(/'(\/(?:css|js)\/[^']+)\?v=([0-9A-Za-z]+)'/g)]
  .map(match => ({ pathname: match[1], version: match[2] }));
const htmlVersions = new Map();
for (const match of htmlSource.matchAll(/(\/(?:css|js)\/[^?"']+)\?v=([0-9A-Za-z]+)/g)) {
  const versions = htmlVersions.get(match[1]) || new Set();
  versions.add(match[2]);
  htmlVersions.set(match[1], versions);
}
for (const asset of swAssets) {
  const versions = htmlVersions.get(asset.pathname);
  if (!versions) continue;
  assert.ok(versions.has(asset.version),
    'Versão do SW desatualizada para ' + asset.pathname + ': SW=' + asset.version + ', HTML=' + [...versions].join('/'));
}

// 5) admin-plus.js deve encadear o showTab existente. Substituí-lo apagava a
// aba "Salas privadas e amizades" registrada por admin-social.js.
const adminPlus = readFileSync(path.join(PUBLIC, 'js', 'admin-plus.js'), 'utf8');
assert.match(adminPlus, /const baseShowTab = window\.showTab;/, 'admin-plus captura o showTab anterior');
assert.match(adminPlus, /baseShowTab\(name\)/, 'admin-plus encadeia o showTab anterior');
assert.match(adminPlus, /if \(LOAD\[name\]\) LOAD\[name\]\(\);/, 'admin-plus mantém o carregamento das abas dinâmicas');

// 6) Ações de amigos usam atributos de dados (delegação) em vez de montar
// onclick com nome de usuário, que pode conter aspas/barra invertida.
const social = readFileSync(path.join(PUBLIC, 'js', 'social.js'), 'utf8');
assert.match(social, /data-friend-accept=/, 'aceitar amizade via data attribute');
assert.match(social, /data-friend-remove=/, 'remover/recusar amizade via data attribute');
assert.ok(!/onclick="friend(?:Accept|Remove)\(/.test(social), 'sem onclick com dados de usuário');

console.log('Todas as verificações de integridade da interface passaram.');
