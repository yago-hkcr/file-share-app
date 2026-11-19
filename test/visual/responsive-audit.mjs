#!/usr/bin/env node
/**
 * Auditoria responsiva automatizada do Arquive Online.
 *
 * Uso local (servidor já rodando em http://localhost:3100):
 *   npm run test:visual
 *   npm run test:visual:quick
 *   npm run test:visual -- --landscape
 *   npm run test:visual:update
 *
 * Também aceita uma URL externa e credenciais por variáveis de ambiente:
 *   FILESHARE_TEST_BASE_URL=https://www.arquive.online \
 *   FILESHARE_TEST_USER=admin FILESHARE_TEST_PASSWORD=... \
 *   npm run test:visual -- --public --no-fixtures
 *
 * Para reaproveitar fixtures existentes (sem criar sala/coleta/link):
 *   FILESHARE_TEST_ROOM_SLUG=minha-sala
 *   FILESHARE_TEST_SHARE_URL=https://.../f/TOKEN
 *   FILESHARE_TEST_COLLECTION_URL=https://.../enviar/TOKEN
 *
 * O teste falha com código 1 em overflow horizontal, conteúdo escapando de
 * cards, controles de toque pequenos, erro de JavaScript ou link quebrado.
 * As capturas de referência ficam em test/visual/__screenshots__/baseline.
 */
import { chromium, request } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE = (process.env.FILESHARE_TEST_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '');
const USER = process.env.FILESHARE_TEST_USER || 'admin';
const PASS = process.env.FILESHARE_TEST_PASSWORD || '1234';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const valueOf = name => {
  const item = argv.find(arg => arg.startsWith(name + '='));
  return item ? item.slice(name.length + 1) : null;
};

const QUICK = flag('--quick');
const UPDATE_SNAPSHOTS = flag('--update-snapshots');
const NO_SNAPSHOTS = flag('--no-snapshots');
const LANDSCAPE = flag('--landscape');
const PUBLIC_ONLY = flag('--public');
const NO_FIXTURES = flag('--no-fixtures');
const WORKERS = Math.max(1, Math.min(8, Number(process.env.FILESHARE_VISUAL_WORKERS) || 4));

const DEFAULT_WIDTHS = [
  320, 344, 360, 375, 390, 414, 430, 480, 540, 640, 768,
  820, 912, 1024, 1280, 1366, 1440, 1600, 1920, 2160, 2560, 3440
];
const QUICK_WIDTHS = [320, 390, 768, 1024, 1440, 2560];
const LANDSCAPE_SIZES = [
  [640, 360], [844, 390], [1024, 600], [1280, 720], [1920, 800]
];

const widths = (() => {
  const custom = valueOf('--widths');
  if (custom) return custom.split(',').map(Number).filter(n => Number.isFinite(n) && n >= 240);
  return QUICK ? QUICK_WIDTHS : DEFAULT_WIDTHS;
})();

const resultDir = path.join(ROOT, 'test-results', 'visual');
const baselineDir = path.join(__dirname, '__screenshots__', 'baseline');
const currentShotDir = path.join(resultDir, 'screenshots');
const failureDir = path.join(resultDir, 'failures');

const SNAPSHOT_ROUTES = [
  ['login', '/'],
  ['register', '/register'],
  ['forgot', '/forgot-password'],
  ['reset', '/reset-password'],
  ['privacy', '/privacidade']
];

const IGNORE_SOURCE = String.raw`cy-b-|cyberRain|cy-grid|cy-scan|fx-orb|fx-pointer|toast-container|slide-panel|dashboard-sidebar|dashboard-menu-backdrop|notif-panel`;

function viewportFor(width) {
  if (width <= 480) return { width, height: 844 };
  if (width <= 820) return { width, height: 1024 };
  if (width >= 1920) return { width, height: 1200 };
  return { width, height: 900 };
}

function waitForRoute(routeName) {
  if (routeName === 'sala') return 1500;
  if (routeName === 'dashboard') return 1200;
  if (routeName === 'admin') return 950;
  if (routeName === 'collection' || routeName === 'collection-ui') return 950;
  return 550;
}

function parsePath(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, BASE);
    return parsed.pathname + parsed.search;
  } catch {
    return url.startsWith('/') ? url : '/' + url;
  }
}

async function loginAndPrepare(api) {
  const response = await api.post('/api/login', { data: { username: USER, password: PASS } });
  if (!response.ok()) {
    throw new Error(`login ${response.status()}: ${(await response.text()).slice(0, 180)}`);
  }
  return api.storageState();
}

async function createFixtures(api) {
  const roomResponse = await api.post('/api/rooms', {
    data: {
      name: 'Sala de auditoria responsiva',
      description: 'Sala criada automaticamente para a auditoria de layout adaptativo em todas as larguras.',
      duration_minutes: 30,
      is_public: true
    }
  });
  if (!roomResponse.ok()) throw new Error(`criar sala ${roomResponse.status()}: ${(await roomResponse.text()).slice(0, 180)}`);
  const room = await roomResponse.json();

  const specs = [
    {
      name: 'documento-de-auditoria-com-nome-extremamente-longo-para-testar-quebra-de-linha.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Arquive Online - auditoria responsiva.\n'.repeat(28))
    },
    {
      name: 'planilha-de-controle-financeiro-2026-com-descricao-longa.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('mes,receita,despesa\njan,100,80\nfev,120,90\n')
    },
    {
      name: 'imagem-de-referencia-visual.png',
      mimeType: 'image/png',
      // PNG 1x1 transparente: serve para exercitar o card de mídia sem depender de arquivos externos.
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    }
  ];

  const files = [];
  for (const spec of specs) {
    const response = await api.post(`/api/rooms/${room.id}/files`, {
      multipart: { files: { name: spec.name, mimeType: spec.mimeType, buffer: spec.buffer } }
    });
    if (!response.ok()) throw new Error(`upload ${response.status()}: ${(await response.text()).slice(0, 180)}`);
    const inserted = await response.json();
    if (Array.isArray(inserted) && inserted[0]) files.push(inserted[0]);
  }
  if (!files.length) throw new Error('nenhum arquivo foi aceito na sala de teste');

  const shareResponse = await api.post(`/api/files/${files[0].id}/shares`, {
    data: { expires_in: 604800, max_downloads: 100, password: '1234', allow_preview: true }
  });
  if (!shareResponse.ok()) throw new Error(`criar link ${shareResponse.status()}: ${(await shareResponse.text()).slice(0, 180)}`);
  const share = await shareResponse.json();
  const sharePath = parsePath(share.url);

  const collectionResponse = await api.post('/api/coletas', {
    data: {
      title: 'Coleta de documentos para auditoria visual',
      instructions: 'Envie os documentos solicitados para concluir a auditoria de layout.',
      destination_type: 'room',
      room_id: room.id,
      expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
      items: [
        { label: 'Documento principal', required: true, quantity: 1 },
        { label: 'Comprovante complementar com nome longo', required: false, quantity: 2 }
      ],
      participants: ['Link multiuso'],
      multi_use_link: true
    }
  });
  if (!collectionResponse.ok()) throw new Error(`criar coleta ${collectionResponse.status()}: ${(await collectionResponse.text()).slice(0, 180)}`);
  const collection = await collectionResponse.json();
  const token = collection.recipients && collection.recipients[0] && collection.recipients[0].token;
  if (!token) throw new Error('a coleta foi criada sem token de participante');

  return {
    roomSlug: room.slug,
    roomPath: `/sala/${encodeURIComponent(room.slug)}`,
    sharePath,
    collectionPath: `/enviar/${encodeURIComponent(token)}`
  };
}

async function createForcedPasswordUser(api) {
  // Usuário fixo: o primeiro teste cria, os seguintes reaproveitam. Isso evita
  // consumir o limite de cadastros a cada execução da auditoria.
  const username = 'auditoria_layout';
  const listUsers = async () => {
    const response = await api.get('/api/admin/users');
    if (!response.ok()) throw new Error(`listar usuários ${response.status()}`);
    return response.json();
  };

  let user = (await listUsers()).find(item => item.username === username);
  if (!user) {
    const registration = await api.post('/api/register', {
      data: { username, email: `${username}@example.test`, password: '1234' }
    });
    if (!registration.ok()) throw new Error(`cadastro de auditoria ${registration.status()}: ${(await registration.text()).slice(0, 160)}`);
    user = (await listUsers()).find(item => item.username === username);
  }
  if (!user) throw new Error('usuário de auditoria não encontrado após o cadastro');

  const approve = await api.post(`/api/admin/users/${user.id}/approve`);
  if (!approve.ok()) throw new Error(`aprovar usuário ${approve.status()}`);
  const reset = await api.post(`/api/admin/users/${user.id}/reset-password`);
  if (!reset.ok()) throw new Error(`redefinir senha ${reset.status()}`);
  const temporary = (await reset.json()).password;

  const forcedApi = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  const login = await forcedApi.post('/api/login', { data: { username, password: temporary } });
  if (!login.ok()) throw new Error(`login forçado ${login.status()}`);
  return { id: user.id, state: await forcedApi.storageState(), api: forcedApi };
}

function buildRoutes(fixtures, hasAuth, hasForcedUser) {
  const routes = [
    ['login', '/'],
    ['register', '/register'],
    ['forgot', '/forgot-password'],
    ['reset', '/reset-password'],
    ['privacy', '/privacidade']
  ];

  if (fixtures && fixtures.sharePath) routes.push(['share', fixtures.sharePath]);
  if (fixtures && fixtures.collectionPath) routes.push(['collection', fixtures.collectionPath]);

  if (hasAuth) {
    routes.push(
      ['dashboard', '/dashboard', true, 'admin'],
      ['admin', '/admin', true, 'admin']
    );
    if (hasForcedUser) routes.push(['change-password', '/change-password', true, 'forced']);
    if (fixtures && fixtures.roomPath) routes.push(['sala', fixtures.roomPath, true, 'admin']);
  }
  return routes;
}

async function auditPage(browser, states, route, viewport) {
  const [name, routePath, needsAuth = false, stateKind = 'admin'] = route;
  const context = await browser.newContext({
    viewport,
    storageState: needsAuth ? states[stateKind] : undefined,
    reducedMotion: 'reduce',
    hasTouch: viewport.width <= 640 || viewport.height <= 430
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('arquive_intro_v1', '1');
      localStorage.setItem('fileshare-theme', 'light');
      localStorage.setItem('fileshare-gfx', 'minimal');
      localStorage.setItem('fileshare-gfx-manual', '1');
    } catch {}
  });

  const page = await context.newPage();
  const pageErrors = [];
  const assetErrors = [];
  const mainOrigin = new URL(BASE).origin;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() < 400) return;
    try {
      const url = new URL(response.url());
      if (url.origin === mainOrigin && /\.(css|js)$/.test(url.pathname)) {
        assetErrors.push(`${response.status()} ${url.pathname}`);
      }
    } catch {}
  });

  try {
    const navigation = await page.goto(BASE + routePath, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(waitForRoute(name));
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.waitForTimeout(80);

    const result = await page.evaluate(({ ignoreSource, checkTaps }) => {
      const ignored = new RegExp(ignoreSource);
      const vw = innerWidth;
      const vh = innerHeight;
      const visible = element => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= 1 && rect.height >= 1 && !(rect.bottom < -vh * 2 || rect.top > vh * 3);
      };
      const insideScrollerOrClip = (element, rect) => {
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.documentElement) {
          const style = getComputedStyle(ancestor);
          if (/auto|scroll/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 2) return true;
          if (/hidden|clip/.test(style.overflowX)) {
            if (style.textOverflow === 'ellipsis') return true;
            const ancestorRect = ancestor.getBoundingClientRect();
            if (rect.right > ancestorRect.right + 2 || rect.left < ancestorRect.left - 2) return true;
          }
          if (ancestor.matches('.dashboard-sidebar') && !ancestor.closest('.menu-open')) return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      };

      const outside = [];
      for (const element of document.querySelectorAll('body *')) {
        if (element.closest('svg') || !visible(element)) continue;
        const className = (element.className && element.className.baseVal !== undefined
          ? element.className.baseVal
          : element.className || '').toString();
        if (ignored.test(className) || ignored.test(element.id)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.right > vw + 1.5 || rect.left < -1.5) {
          if (!insideScrollerOrClip(element, rect)) {
            outside.push({
              tag: element.tagName,
              cls: className.slice(0, 56),
              id: element.id,
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              width: Math.round(rect.width)
            });
          }
        }
      }

      // Texto comprimido não gera overflow: a caixa encolhe e as letras caem
      // uma por linha. Detecta inclusive elementos com largura zero.
      const narrowText = [];
      for (const element of document.querySelectorAll('body *')) {
        if (element.closest('svg,script,style,noscript,canvas,select,option,textarea,input')) continue;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        if (style.writingMode && style.writingMode !== 'horizontal-tb') continue;
        const className = (element.className && element.className.baseVal !== undefined
          ? element.className.baseVal
          : element.className || '').toString();
        if (ignored.test(className) || ignored.test(element.id)) continue;
        const text = Array.from(element.childNodes)
          .filter(node => node.nodeType === 3)
          .map(node => node.textContent)
          .join(' ').replace(/\s+/g, ' ').trim();
        if (text.length < 4) continue;
        const rect = element.getBoundingClientRect();
        if (rect.height < 1 || rect.top > vh * 3 || rect.bottom < -vh * 2) continue;
        if (rect.width < 105 && rect.height > Math.max(64, rect.width * 2.2)) {
          narrowText.push({
            tag: element.tagName,
            cls: className.slice(0, 60),
            id: element.id,
            text: text.slice(0, 70),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      }

      const escapedContainers = [];
      const containerSelectors = [
        '.header', '.wrap', '.dashboard-content', '.main-content', '.sala-container',
        '.auth-container', '.collection-shell', '.modal-content:not([hidden])'
      ];
      for (const selector of containerSelectors) {
        const element = document.querySelector(selector);
        if (!element || !visible(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left < -1.5 || rect.right > vw + 1.5) {
          escapedContainers.push({ selector, left: Math.round(rect.left), right: Math.round(rect.right) });
        }
      }

      const escapedCards = [];
      const compressedText = [];
      for (const selector of ['.room-card', '.sala-file-card', '.stat-card', '.collection-public-card', '.share-card']) {
        for (const card of document.querySelectorAll(selector)) {
          if (!visible(card)) continue;
          const cardRect = card.getBoundingClientRect();
          for (const child of card.children) {
            if (!visible(child)) continue;
            const childRect = child.getBoundingClientRect();
            if (childRect.right > cardRect.right + 2 || childRect.left < cardRect.left - 2) {
              escapedCards.push({
                selector,
                child: (child.className || child.tagName).toString().slice(0, 50),
                left: Math.round(childRect.left),
                right: Math.round(childRect.right),
                cardRight: Math.round(cardRect.right)
              });
            }
          }

          // Uma coluna de texto esmagada transforma nomes em letras verticais.
          // Isso não gera overflow, então precisa de uma checagem própria.
          if (selector === '.sala-file-card' && cardRect.width >= 380) {
            const info = card.querySelector('.sala-file-info');
            if (info && visible(info)) {
              const infoRect = info.getBoundingClientRect();
              const name = info.querySelector('h4');
              const nameRect = name && visible(name) ? name.getBoundingClientRect() : null;
              if (infoRect.width < 140 || (nameRect && nameRect.width < 90 && nameRect.height > 40)) {
                compressedText.push({
                  cardWidth: Math.round(cardRect.width),
                  infoWidth: Math.round(infoRect.width),
                  nameWidth: nameRect ? Math.round(nameRect.width) : null,
                  nameHeight: nameRect ? Math.round(nameRect.height) : null
                });
              }
            }
          }
        }
      }

      const smallTargets = [];
      if (checkTaps) {
        for (const element of document.querySelectorAll('a.btn, button, .nav-item, .dashboard-tab, .theme-toggle, .icon-btn')) {
          if (!visible(element) || element.disabled) continue;
          const rect = element.getBoundingClientRect();
          if (rect.height < 40 || rect.width < 40) {
            smallTargets.push({
              tag: element.tagName,
              cls: (element.className || '').toString().slice(0, 50),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
          }
        }
      }

      const scrolling = document.scrollingElement;
      return {
        scrollWidth: scrolling.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: vw,
        scrollHeight: scrolling.scrollHeight,
        outside: outside.slice(0, 8),
        escapedContainers,
        escapedCards: escapedCards.slice(0, 8),
        compressedText: compressedText.slice(0, 8),
        narrowText: narrowText.slice(0, 8),
        smallTargets: smallTargets.slice(0, 8)
      };
    }, { ignoreSource: IGNORE_SOURCE, checkTaps: viewport.width <= 640 || viewport.height <= 430 });

    const finalUrl = new URL(page.url());
    const expectedUrl = new URL(BASE + routePath);
    const redirected = needsAuth && finalUrl.pathname !== expectedUrl.pathname;
    const details = {
      ...result,
      status: navigation ? navigation.status() : null,
      finalPath: finalUrl.pathname,
      redirected,
      pageErrors,
      assetErrors
    };
    const bad = details.status >= 400 || details.scrollWidth > viewport.width + 1 ||
      details.outside.length || details.escapedContainers.length || details.escapedCards.length ||
      details.compressedText.length || details.narrowText.length || details.smallTargets.length || pageErrors.length || assetErrors.length || redirected;

    if (bad) {
      await page.screenshot({
        path: path.join(failureDir, `${name}-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
        animations: 'disabled',
        caret: 'hide'
      }).catch(() => {});
    }
    return { name, routePath, viewport, details, bad };
  } catch (error) {
    return {
      name,
      routePath,
      viewport,
      bad: true,
      details: { error: error.message.split('\n')[0], pageErrors, assetErrors }
    };
  } finally {
    await context.close();
  }
}

async function compareImages(browser, baseline, current, diffPath) {
  const comparisonPage = await browser.newPage();
  try {
    const comparison = await comparisonPage.evaluate(async ({ baseline: a, current: b }) => {
      const load = source => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('imagem inválida'));
        image.src = 'data:image/png;base64,' + source;
      });
      const [before, after] = await Promise.all([load(a), load(b)]);
      if (before.width !== after.width || before.height !== after.height) {
        return { sizeMismatch: true, before: [before.width, before.height], after: [after.width, after.height] };
      }
      const canvas = document.createElement('canvas');
      canvas.width = before.width;
      canvas.height = before.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(before, 0, 0);
      const beforeData = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(after, 0, 0);
      const afterData = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const output = context.createImageData(canvas.width, canvas.height);
      let different = 0;
      for (let index = 0; index < beforeData.length; index += 4) {
        const delta = Math.max(
          Math.abs(beforeData[index] - afterData[index]),
          Math.abs(beforeData[index + 1] - afterData[index + 1]),
          Math.abs(beforeData[index + 2] - afterData[index + 2]),
          Math.abs(beforeData[index + 3] - afterData[index + 3])
        );
        if (delta > 24) {
          different++;
          output.data[index] = 255;
          output.data[index + 1] = 38;
          output.data[index + 2] = 64;
          output.data[index + 3] = 255;
        } else {
          output.data[index] = 235;
          output.data[index + 1] = 235;
          output.data[index + 2] = 235;
          output.data[index + 3] = 90;
        }
      }
      context.putImageData(output, 0, 0);
      return {
        sizeMismatch: false,
        different,
        total: canvas.width * canvas.height,
        ratio: different / (canvas.width * canvas.height),
        diffDataUrl: different ? canvas.toDataURL('image/png') : null
      };
    }, {
      baseline: baseline.toString('base64'),
      current: current.toString('base64')
    });
    if (comparison.diffDataUrl) {
      await writeFile(diffPath, Buffer.from(comparison.diffDataUrl.split(',')[1], 'base64'));
    }
    return comparison;
  } finally {
    await comparisonPage.close();
  }
}

async function runSnapshotsWithBrowser(browser) {
  if (NO_SNAPSHOTS) return { checked: 0, failures: [], created: 0, skipped: true };
  const failures = [];
  let checked = 0;
  let created = 0;
  const sizes = [
    { width: 390, height: 844 },
    { width: 1440, height: 900 }
  ];

  for (const [name, routePath] of SNAPSHOT_ROUTES) {
    for (const viewport of sizes) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme: 'light' });
      await context.addInitScript(() => {
        try {
          localStorage.setItem('arquive_intro_v1', '1');
          localStorage.setItem('fileshare-theme', 'light');
          localStorage.setItem('fileshare-gfx', 'minimal');
          localStorage.setItem('fileshare-gfx-manual', '1');
        } catch {}
      });
      const page = await context.newPage();
      try {
        const response = await page.goto(BASE + routePath, { waitUntil: 'domcontentloaded', timeout: 25000 });
        if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()} em ${routePath}`);
        await page.waitForTimeout(500);
        await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
        await page.waitForTimeout(100);
        const fileName = `${name}-${viewport.width}.png`;
        const baselinePath = path.join(baselineDir, fileName);
        const currentPath = path.join(currentShotDir, fileName);
        await page.screenshot({ path: currentPath, animations: 'disabled', caret: 'hide' });
        checked++;

        let baseline = null;
        try {
          baseline = await readFile(baselinePath);
        } catch {}

        if (!baseline) {
          await writeFile(baselinePath, await readFile(currentPath));
          created++;
          console.log(`[snapshot] referência criada: ${fileName}`);
          continue;
        }

        if (UPDATE_SNAPSHOTS) {
          await writeFile(baselinePath, await readFile(currentPath));
          created++;
          continue;
        }

        const current = await readFile(currentPath);
        const comparison = await compareImages(browser, baseline, current, path.join(resultDir, `diff-${fileName}`));
        const failed = comparison.sizeMismatch || comparison.ratio > 0.0025;
        if (failed) {
          failures.push({
            name: `snapshot:${name}`,
            width: viewport.width,
            status: response ? response.status() : null,
            comparison: comparison.sizeMismatch
              ? { sizeMismatch: true, before: comparison.before, after: comparison.after }
              : { ratio: comparison.ratio, different: comparison.different, total: comparison.total }
          });
          console.log(`[snapshot] diferença: ${fileName} (${comparison.sizeMismatch ? 'tamanho' : (comparison.ratio * 100).toFixed(3) + '%'})`);
        }
      } catch (error) {
        failures.push({ name: `snapshot:${name}`, width: viewport.width, error: error.message.split('\n')[0] });
      } finally {
        await context.close();
      }
    }
  }
  return { checked, failures, created, skipped: false };
}

async function runSnapshots() {
  // As capturas usam um navegador próprio: a auditoria de 242 páginas pode
  // deixar o processo do Chrome sob pressão de memória em máquinas pequenas.
  const snapshotBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    return await runSnapshotsWithBrowser(snapshotBrowser);
  } finally {
    await snapshotBrowser.close();
  }
}

async function main() {
  await mkdir(resultDir, { recursive: true });
  await mkdir(baselineDir, { recursive: true });
  await mkdir(currentShotDir, { recursive: true });
  await mkdir(failureDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let api = null;
  let state = null;
  let fixtures = null;
  let forcedUser = null;
  let loginError = null;
  let fixtureError = null;
  let forcedError = null;

  try {
    if (!PUBLIC_ONLY) {
      api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
      try {
        state = await loginAndPrepare(api);
      } catch (error) {
        loginError = error.message;
      }
    }

    if (state && !NO_FIXTURES) {
      try {
        fixtures = await createFixtures(api);
        console.log(`[fixtures] sala=${fixtures.roomPath} share=${fixtures.sharePath} coleta=${fixtures.collectionPath}`);
      } catch (error) {
        fixtureError = error.message;
      }
    }

    if (state) {
      try {
        forcedUser = await createForcedPasswordUser(api);
      } catch (error) {
        forcedError = error.message;
      }
    }

    if (fixtures) {
      if (process.env.FILESHARE_TEST_ROOM_SLUG) fixtures.roomPath = `/sala/${encodeURIComponent(process.env.FILESHARE_TEST_ROOM_SLUG)}`;
      if (process.env.FILESHARE_TEST_SHARE_URL) fixtures.sharePath = parsePath(process.env.FILESHARE_TEST_SHARE_URL);
      if (process.env.FILESHARE_TEST_COLLECTION_URL) fixtures.collectionPath = parsePath(process.env.FILESHARE_TEST_COLLECTION_URL);
    } else if (process.env.FILESHARE_TEST_ROOM_SLUG || process.env.FILESHARE_TEST_SHARE_URL) {
      fixtures = {
        roomPath: process.env.FILESHARE_TEST_ROOM_SLUG ? `/sala/${encodeURIComponent(process.env.FILESHARE_TEST_ROOM_SLUG)}` : null,
        sharePath: parsePath(process.env.FILESHARE_TEST_SHARE_URL),
        collectionPath: parsePath(process.env.FILESHARE_TEST_COLLECTION_URL)
      };
    }

    if (loginError && !PUBLIC_ONLY) {
      console.error(`[auth] ${loginError}`);
      console.error('[auth] use --public para auditar somente páginas públicas ou configure FILESHARE_TEST_USER/PASSWORD.');
    }
    if (fixtureError) console.error(`[fixtures] ${fixtureError}`);
    if (forcedError) console.error(`[forced-user] ${forcedError}`);

    const routes = buildRoutes(fixtures, Boolean(state), Boolean(forcedUser));
    if (!routes.length) throw new Error('nenhuma rota pôde ser montada');

    const jobs = [];
    for (const width of widths) jobs.push({ viewport: viewportFor(width), route: null });
    if (LANDSCAPE) {
      for (const [width, height] of LANDSCAPE_SIZES) jobs.push({ viewport: { width, height }, route: null });
    }

    const allChecks = [];
    for (const job of jobs) {
      for (const route of routes) allChecks.push({ route, viewport: job.viewport });
    }

    console.log(`[audit] ${BASE} · ${routes.length} rotas × ${jobs.length} viewports = ${allChecks.length} verificações · ${WORKERS} workers`);

    let cursor = 0;
    let checked = 0;
    const failures = [];
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= allChecks.length) return;
        const job = allChecks[index];
        const result = await auditPage(browser, { admin: state, forced: forcedUser && forcedUser.state }, job.route, job.viewport);
        checked++;
        if (result.bad) {
          failures.push({
            name: result.name,
            routePath: result.routePath,
            width: result.viewport.width,
            height: result.viewport.height,
            ...result.details
          });
          console.log(`[fail] ${result.name} ${result.viewport.width}x${result.viewport.height}`, JSON.stringify({
            sw: result.details.scrollWidth,
            status: result.details.status,
            outside: result.details.outside,
            containers: result.details.escapedContainers,
            cards: result.details.escapedCards,
            compressed: result.details.compressedText,
            narrow: result.details.narrowText,
            taps: result.details.smallTargets,
            js: result.details.pageErrors,
            assets: result.details.assetErrors
          }));
        } else if (checked % 30 === 0) {
          console.log(`[audit] ${checked}/${allChecks.length}`);
        }
      }
    }));

    const snapshotResult = await runSnapshots();
    const allFailures = [...failures, ...snapshotResult.failures, ...(loginError ? [{ name: 'auth', error: loginError }] : []), ...(fixtureError ? [{ name: 'fixtures', error: fixtureError }] : [])];

    const report = {
      base: BASE,
      startedAt: new Date().toISOString(),
      routes: routes.map(([name, path]) => ({ name, path })),
      widths,
      landscape: LANDSCAPE ? LANDSCAPE_SIZES : [],
      checked,
      failures: allFailures,
      snapshots: snapshotResult
    };
    await writeFile(path.join(resultDir, 'report.json'), JSON.stringify(report, null, 2));

    console.log('');
    console.log(`AUDITADAS ${checked} páginas em ${routes.length} rotas.`);
    console.log(`SNAPSHOTS ${snapshotResult.checked} · novas referências ${snapshotResult.created}.`);
    console.log(`FALHAS ${allFailures.length}.`);
    if (allFailures.length) {
      console.log('Detalhes em test-results/visual/report.json');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    if (forcedUser && forcedUser.api) await forcedUser.api.dispose().catch(() => {});
    if (api) await api.dispose();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
