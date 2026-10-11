import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const URL = BASE + '/dashboard.html';
const ADMIN_PASSWORD = process.env.DIAG_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('Defina DIAG_ADMIN_PASSWORD no ambiente antes de executar este diagnóstico.');
const DEVICES = [
  { name: 'iPhone-SE', width: 375, height: 667, mobile: true },
  { name: 'iPhone-14', width: 390, height: 844, mobile: true },
  { name: 'Galaxy-S', width: 360, height: 800, mobile: true },
  { name: 'Desktop', width: 1280, height: 800, mobile: false },
];

const browser = await chromium.launch({ headless: true });

for (const d of DEVICES) {
  const ctx = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
  const page = await ctx.newPage();

  // LOGIN via request API (contexto compartilha cookie) usando form-urlencoded
  let logged = false;
  try {
    const res = await ctx.request.post(BASE + '/api/login', {
      form: { username: 'admin', password: ADMIN_PASSWORD },
      headers: { 'Origin': BASE, 'Referer': BASE + '/' },
    });
    const body = await res.text().catch(() => '');
    logged = res.status() < 400;
    console.log(`  login resp: ${res.status()} ${body.slice(0, 80)}`);
  } catch (e) { console.log('  login err: ' + e.message); }
  console.log(`\n=== ${d.name} (${d.width}x${d.height}) | login=${logged} ===`);

  // cria algumas salas para ter conteudo real e testar rolagem de verdade
  for (let i = 0; i < 6; i++) {
    await ctx.request.post(BASE + '/api/rooms', {
      form: { name: 'Sala de teste ' + (i + 1), duration_minutes: '60' },
      headers: { 'Origin': BASE, 'Referer': BASE + '/' },
    }).catch(() => {});
  }

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const info = await page.evaluate(() => {
    const de = document.documentElement, b = document.body;
    const vw = innerWidth, vh = innerHeight;
    const offenders = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width >= vw * 0.9 && r.height >= vh * 0.85) {
        const cs = getComputedStyle(el);
        const blocks = (cs.overflowY !== 'visible' && cs.overflowY !== 'clip') || cs.position === 'fixed';
        if (blocks) offenders.push({
          sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().split(' ')[0] : ''),
          pos: cs.position, oy: cs.overflowY, h: Math.round(r.height),
        });
      }
    });
    return {
      url: location.pathname,
      docScrollH: de.scrollHeight, docClientH: de.clientHeight,
      bodyClass: b.className, bodyOY: getComputedStyle(b).overflowY,
      htmlOY: getComputedStyle(de).overflowY,
      offenders: offenders.slice(0, 10),
    };
  });

  const can = info.docScrollH > info.docClientH + 2;
  console.log(`  url=${info.url}`);
  console.log(`  documento rola? ${can ? 'SIM' : 'NAO'} (scrollH=${info.docScrollH} clientH=${info.docClientH})`);
  console.log(`  body.${info.bodyClass} overflowY=${info.bodyOY} | html overflowY=${info.htmlOY}`);
  // tenta rolar de verdade
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(200);
  const y = await page.evaluate(() => window.scrollY);
  console.log(`  apos scrollTo(500): scrollY=${y} ${y > 10 ? '(ROLANDO OK)' : '(TRAVADO!)'}`);
  if (!can || y <= 10) {
    console.log('  >>> SUSPEITOS:');
    for (const o of info.offenders) console.log(`      ${o.sel} pos=${o.pos} overflowY=${o.oy} h=${o.h}`);
  }
  await ctx.close();
}
await browser.close();
console.log('\nFIM');
