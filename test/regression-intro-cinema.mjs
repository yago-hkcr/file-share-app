// Regressão da abertura para visitantes novos.
// A introdução (splash + apresentação com som) deve aparecer só na primeira
// visita; quem já usa o site abre direto no login.
// Uso: node test/regression-intro-cinema.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = file => readFileSync(path.join(PUBLIC, file), 'utf8');

const index = read('index.html');
const intro = read('js/login-intro.js');
const cinema = read('js/intro-cinema.js');
const css = read('css/intro-cinema.css');
const sw = read('sw.js');

// 1) Arquivos existem e estão referenciados na página de entrada.
for (const file of ['js/intro-cinema.js', 'css/intro-cinema.css']) {
  assert.ok(existsSync(path.join(PUBLIC, file)), file + ' existe');
}
assert.match(index, /<link rel="stylesheet" href="\/css\/intro-cinema\.css\?v=[0-9A-Za-z]+">/, 'CSS da apresentação carregado');
assert.match(index, /<script src="\/js\/intro-cinema\.js\?v=[0-9A-Za-z]+"><\/script>/, 'JS da apresentação carregado');
assert.ok(index.indexOf('intro-cinema.js') < index.indexOf('login-intro.js'), 'a apresentação carrega antes do splash');

// 2) A abertura só acontece na primeira visita.
assert.match(intro, /if \(!forced\(\) && alreadySeen\(\)\) \{ focusLogin\(\); return; \}/, 'quem já viu não recebe o splash');
assert.match(intro, /arquive_intro_v1/, 'a marca fica no aparelho');
assert.match(cinema, /var SEEN_KEY = 'arquive_intro_v1';/, 'a marca é compartilhada com a apresentação');
assert.match(cinema, /looksReturning\(\)/, 'quem já configurou o site não vê a introdução de novo');
for (const key of ['fileshare-theme', 'fileshare-gfx-manual']) {
  assert.ok(cinema.includes("'" + key + "'"), 'reconhece usuário existente por ' + key);
}
assert.equal(/fileshare-gfx'/.test(cinema), false, 'não confunde a detecção automática de desempenho com usuário antigo');

// 3) Depois do splash vem a apresentação com som.
assert.match(intro, /api\.welcome\(\{ onDone: focusLogin \}\)/, 'o splash entrega a vez para a apresentação');
assert.match(cinema, /function welcome\(options\)/, 'apresentação tem porta de entrada própria');
assert.match(cinema, /Assistir com som/, 'o áudio começa por um toque do usuário');
assert.match(cinema, /new Ctx\(\)/, 'usa WebAudio');
assert.equal(/https?:\/\/[^\s'"]+\.(?:mp3|ogg|wav|m4a)/i.test(cinema), false, 'nenhum áudio de terceiros para baixar');

// 4) Ela se explica: 5 cenas, cada uma com título e texto.
const scenes = [...cinema.matchAll(/kicker: '([A-ZÁÉÍÓÚÂÊÔÃÕÇ ]+)'/g)].map(match => match[1]);
assert.deepEqual(scenes, ['ENVIO', 'SALAS', 'COLETAS', 'ACERVO', 'COMECE'], 'as cinco cenas estão na ordem');
assert.match(cinema, /var SCENE_MS = \d+;/, 'as cenas têm duração definida');
assert.match(cinema, /data-cine-skip/, 'dá para pular a qualquer momento');
assert.match(cinema, /event\.key === 'Escape'/, 'Esc encerra a apresentação');

// 5) Conteúdo não pode depender de animação para aparecer: nas configurações
// de desempenho baixas o site desliga animações com !important.
const hiddenBase = [...css.matchAll(/\n([^{}\n]+)\{[^}]*opacity:\s*0[^}]*\}/g)]
  .map(match => match[1].trim())
  .filter(selector => !/^@|^to$|^from$|^0%,|^100%|#cineIntro|\.cine-gate|is-past|keyframes|^\.cine-scene$/.test(selector));
assert.deepEqual(hiddenBase, [], 'nenhum elemento fica invisível sem animação: ' + hiddenBase.join(' | '));
assert.equal(/\.cine-title span[^{]*\{[^}]*opacity:\s*0/.test(css.replace(/\s+/g, ' ')), false, 'título visível por padrão');

// 6) Quem pediu menos movimento não recebe a sequência.
assert.match(cinema, /prefers-reduced-motion: reduce/, 'respeita prefers-reduced-motion');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'o CSS também respeita');

// 7) Versão do service worker atualizada para entregar os arquivos novos.
assert.match(sw, /const CACHE_NAME = 'fileshare-v\d+-[a-z-]+';/, 'cache do service worker versionado');

console.log('Abertura de primeira visita, apresentação com som e respeito a movimento reduzido passaram.');
