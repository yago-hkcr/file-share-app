// Teste de regressão: impede que o Acervo volte a criar espaço/prateleira
// ("Principal"/"Geral") automaticamente sem ação do usuário.
//
// Cenário real que causou o defeito: uma tabela legada `personal_library_shelves`
// com uma prateleira vazia ("Vazia") + um item órfão (space_id/bookcase_id NULL).
// A migração antiga varria `personal_library_shelves` a cada boot e recriava um
// espaço + prateleira "Geral" (exibida como "Principal") para cada nome legado —
// mesmo os que o usuário já havia excluído. A migração corrigida só homenageia
// itens realmente órfãos, derivando o espaço do próprio item.
//
// O teste sobe o servidor de verdade em um banco temporário isolado, roda a
// migração em dois ciclos de boot e confere:
//   1) REGRESSÃO: a prateleira legada vazia NÃO vira espaço automático;
//   2) PRESERVAÇÃO: o item órfão ainda ganha um espaço (dado legítimo não se perde).
//
// Uso: node test/regression-auto-create-acervo.mjs
// Sai com código 1 se qualquer asserção falhar.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 4783);
const ADMIN_PASSWORD = 'senha-teste-123456';
const SESSION_SECRET = 'sessao-teste-segura-1234567890';

const { PGlite } = await import(
  pathToFileURL(path.join(ROOT, 'local-runtime', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href
);

const dataDir = mkdtempSync(path.join(tmpdir(), 'acervo-regressao-'));

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FILESHARE_LOCAL: '1',
      FILESHARE_DATA_DIR: dataDir,
      FILESHARE_NO_BROWSER: '1',
      PORT: String(PORT),
      ADMIN_PASSWORD,
      SESSION_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch { /* servidor ainda subindo */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Servidor não respondeu /health a tempo.');
}

function stopServer(child) {
  return new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

// Abre a PGlite do banco temporário. Remove um postmaster.pid residual que a
// PGlite pode deixar tras após o kill, para não travar a reabertura.
async function openDb() {
  const pid = path.join(dataDir, 'database', 'postmaster.pid');
  if (existsSync(pid)) { try { unlinkSync(pid); } catch { /* ignora */ } }
  return PGlite.create(path.join(dataDir, 'database'));
}

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

try {
  // Ciclo A: primeira inicialização cria o schema (migração roda sem dados legados).
  let child = startServer();
  await waitHealthy();
  await stopServer(child);

  // Semeia o cenário que causou o defeito, direto no banco temporário.
  let db = await openDb();
  const admin = (await db.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)).rows[0];
  if (!admin) throw new Error('Admin de teste não encontrado no banco temporário.');
  await db.query(
    `INSERT INTO personal_library_shelves (id, user_id, name, created_at)
     VALUES ('sh-vazia', $1, 'Vazia', '2026-01-01 00:00:00')`,
    [admin.id]
  );
  await db.query(
    `INSERT INTO personal_library_items (id, user_id, file_id, shelf, created_at, updated_at)
     VALUES ('it-orfa', $1, 'fake-file-1', 'ComItem', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    [admin.id]
  );
  await db.close();

  // Ciclo B: segundo boot roda a migração de novo (é ela que recriava tudo).
  child = startServer();
  await waitHealthy();
  await stopServer(child);

  db = await openDb();
  const spaces = (await db.query(
    `SELECT id, name FROM personal_library_spaces WHERE user_id = $1`,
    [admin.id]
  )).rows;
  const orphan = (await db.query(
    `SELECT space_id, bookcase_id FROM personal_library_items WHERE id = 'it-orfa'`
  )).rows[0];
  await db.close();

  const hasVazia = spaces.some(s => s.name === 'Vazia');
  const hasComItem = spaces.some(s => s.name === 'ComItem');

  // 1) Regressão: prateleira legada vazia não pode virar espaço automático.
  check(!hasVazia, 'não cria espaço automático a partir da prateleira legada vazia "Vazia"');
  // 2) Preservação: item órfão legítimo ainda é homenageado em um espaço.
  check(hasComItem && orphan && orphan.space_id && orphan.bookcase_id,
    'item órfão legítimo ainda recebe espaço/prateleira (dado válido preservado)');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} asserção(ões) falhou(aram).`);
  process.exit(1);
}
console.log('\nTodas as asserções passaram.');
