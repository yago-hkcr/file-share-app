(function () {
  'use strict';
  if (document.body.dataset.auth3dFloatInit === '1') return;
  document.body.dataset.auth3dFloatInit = '1';
  if (!document.body.classList.contains('auth-page')) return;

  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  var card = document.querySelector('.auth-card');
  var showcase = document.querySelector('.auth-showcase');
  if (!card) return;

  var LITE = { minimal: 1, basic: 1, low: 1 };
  function liteGfx() {
    var level = root.getAttribute('data-gfx') || 'medium';
    return !!LITE[level];
  }

  // Base/fallback transform so cards are visibly 3D even if JS stops early.
  card.style.setProperty('--tilt-x', '4deg');
  card.style.setProperty('--tilt-y', '-6deg');
  card.style.setProperty('--float-y', '0px');
  card.style.setProperty('--card-scale', '1');
  if (showcase) {
    showcase.style.setProperty('--tilt-x', '2deg');
    showcase.style.setProperty('--tilt-y', '4deg');
    showcase.style.setProperty('--float-y', '0px');
  }

  // Floor shadow element for floating illusion
  var shadow = document.createElement('div');
  shadow.className = 'auth-card-floor-shadow';
  shadow.setAttribute('aria-hidden', 'true');
  if (card.parentNode) {
    var parentPos = getComputedStyle(card.parentNode).position;
    if (parentPos === 'static') card.parentNode.style.position = 'relative';
    card.parentNode.insertBefore(shadow, card.nextSibling);
  }

  function syncShadowBase() {
    if (!shadow || !card || !card.parentNode) return;
    var cw = card.offsetWidth, ch = card.offsetHeight;
    var cl = card.offsetLeft, ct = card.offsetTop;
    shadow.style.position = 'absolute';
    shadow.style.left = (cl + cw * 0.08) + 'px';
    shadow.style.top = (ct + ch - 16) + 'px';
    shadow.style.width = (cw * 0.84) + 'px';
    shadow.style.height = Math.max(26, ch * 0.16) + 'px';
    shadow.style.pointerEvents = 'none';
    // Blur fixo: animar `filter` a cada frame custava caro e gerava tremida.
    shadow.style.filter = 'blur(26px)';
  }

  var baseRect = null;
  // Mede a caixa do card SEM a transformação 3D. Usar getBoundingClientRect()
  // do card já inclinado mudava o alvo do hover a cada frame (efeito de
  // realimentação) — era isso que fazia o card tremer.
  function measureBase() {
    var prev = card.style.transform;
    card.style.transform = 'none';
    var r = card.getBoundingClientRect();
    card.style.transform = prev;
    baseRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    return baseRect;
  }

  syncShadowBase();
  measureBase();
  window.addEventListener('resize', function () { syncShadowBase(); measureBase(); }, { passive: true });
  setTimeout(syncShadowBase, 120);
  setTimeout(function () { syncShadowBase(); measureBase(); }, 700);

  var maxTilt = coarse ? 4 : 8;
  var targetRX = 4, targetRY = -6, currentRX = 4, currentRY = -6;
  var targetFloat = 0, currentFloat = 0;
  var targetScale = 1, currentScale = 1;
  var hovering = false;
  var frozen = false;
  var raf = 0;
  var lastFrame = 0;
  var lastSet = { rx: '', ry: '', fy: '', sc: '' };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function isInteracting() {
    return hovering || (card && card.matches && card.matches(':focus-within'));
  }

  function setStatic() {
    card.style.setProperty('--tilt-x', '4deg');
    card.style.setProperty('--tilt-y', '-6deg');
    card.style.setProperty('--float-y', '0px');
    card.style.setProperty('--card-scale', '1');
    if (showcase) {
      showcase.style.setProperty('--tilt-x', '2deg');
      showcase.style.setProperty('--tilt-y', '4deg');
      showcase.style.setProperty('--float-y', '0px');
    }
    if (shadow) { shadow.style.opacity = '0.4'; shadow.style.transform = 'none'; }
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function tick(t) {
    raf = 0;
    if (document.hidden || liteGfx()) { stop(); setStatic(); return; }

    var modal = document.getElementById('gfxModal');
    var modalOpen = !!(modal && modal.style.display && modal.style.display !== 'none');
    var paused = frozen || modalOpen;

    var dt = lastFrame ? clamp((t - lastFrame) / 1000, 0.001, 0.08) : 0.016;
    lastFrame = t;
    var time = t * 0.001;
    var active = isInteracting();

    if (paused) {
      // Pausa total enquanto o ponteiro está sobre a engrenagem: o botão não
      // escapa do cursor e o clique sempre acerta.
      raf = requestAnimationFrame(tick);
      return;
    }

    if (!active) {
      // Flutuação suave e curta (amplitude menor = sem sensação de tremor)
      targetFloat = Math.sin(time * 0.7) * 4;
      targetRX = 4 + Math.sin(time * 0.45) * 0.8;
      targetRY = -6 + Math.cos(time * 0.38) * 1.1;
      targetScale = 1;
    } else if (hovering) {
      targetFloat = -9;
      targetScale = 1.01;
    } else {
      // Focado/trocando de campo: estável, sem balanço
      targetFloat = -3;
      targetScale = 1;
    }

    var speed = active ? 0.16 : 0.06;
    var k = 1 - Math.pow(1 - speed, dt * 60);

    currentRX += (targetRX - currentRX) * k;
    currentRY += (targetRY - currentRY) * k;
    currentFloat += (targetFloat - currentFloat) * k;
    currentScale += (targetScale - currentScale) * k;

    // Só escreve no DOM quando muda o suficiente (evita micro-oscilação visual)
    var nx = currentRX.toFixed(2), ny = currentRY.toFixed(2), nf = currentFloat.toFixed(1), ns = currentScale.toFixed(3);
    if (nx !== lastSet.rx) { card.style.setProperty('--tilt-x', nx + 'deg'); lastSet.rx = nx; }
    if (ny !== lastSet.ry) { card.style.setProperty('--tilt-y', ny + 'deg'); lastSet.ry = ny; }
    if (nf !== lastSet.fy) { card.style.setProperty('--float-y', nf + 'px'); lastSet.fy = nf; }
    if (ns !== lastSet.sc) { card.style.setProperty('--card-scale', ns); lastSet.sc = ns; }

    if (showcase) {
      showcase.style.setProperty('--tilt-x', (2 + (currentRX - 4) * 0.2).toFixed(2) + 'deg');
      showcase.style.setProperty('--tilt-y', (4 + (currentRY + 6) * 0.2).toFixed(2) + 'deg');
      showcase.style.setProperty('--float-y', (currentFloat * 0.35).toFixed(1) + 'px');
    }

    if (shadow) {
      var liftNorm = clamp((10 - currentFloat) / 22, 0, 1);
      var sx = 1 + liftNorm * 0.14 + Math.abs(currentRY) * 0.005;
      var sy = 1 + liftNorm * 0.18;
      var op = 0.46 - liftNorm * 0.14;
      var tx = currentRY * 1.0;
      var ty = currentFloat * 0.5;
      shadow.style.transform = 'translateX(' + tx.toFixed(1) + 'px) translateY(' + ty.toFixed(1) + 'px) scaleX(' + sx.toFixed(3) + ') scaleY(' + sy.toFixed(3) + ')';
      shadow.style.opacity = String(Math.max(0.2, op));
    }

    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (reduce || liteGfx() || frozen) { setStatic(); return; }
    if (raf) return;
    lastFrame = 0;
    raf = requestAnimationFrame(tick);
  }

  if (reduce) {
    if (shadow) { shadow.style.opacity = '0.4'; }
    setStatic();
    return;
  }

  // Congela o card enquanto o ponteiro estiver sobre a engrenagem de configurações.
  var settingsBtn = document.getElementById('authSettingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('pointerenter', function () { frozen = true; }, { passive: true });
    settingsBtn.addEventListener('pointerleave', function () { frozen = false; }, { passive: true });
    settingsBtn.addEventListener('focus', function () { frozen = true; }, { passive: true });
    settingsBtn.addEventListener('blur', function () { frozen = false; }, { passive: true });
  }

  function onMove(e) {
    if (!baseRect) measureBase();
    var r = baseRect;
    if (!r || r.width <= 0 || r.height <= 0) return;
    var px = clamp((e.clientX - r.left) / r.width, 0, 1);
    var py = clamp((e.clientY - r.top) / r.height, 0, 1);
    // Zona morta central: sem inclinação para deslocamentos mínimos
    var dx = Math.abs(px - 0.5) < 0.06 ? 0 : px - 0.5;
    var dy = Math.abs(py - 0.5) < 0.06 ? 0 : 0.5 - py;
    targetRY = -6 + dx * maxTilt * 2;
    targetRX = 4 + dy * maxTilt * 2;
  }

  // Histerese de entrada/saída: sem isso o card "pisca" entre inclinar e voltar
  // quando o ponteiro fica parado na borda (a forma inclinada muda de lugar).
  function pointerInside(e, margin) {
    if (!baseRect) measureBase();
    var r = baseRect;
    if (!r) return false;
    return e.clientX >= r.left - margin && e.clientX <= r.left + r.width + margin &&
      e.clientY >= r.top - margin && e.clientY <= r.top + r.height + margin;
  }

  function onWindowMove(e) {
    if (e.pointerType === 'touch') return;
    var inside = hovering ? pointerInside(e, 18) : pointerInside(e, 6);
    if (inside) {
      if (!hovering) { hovering = true; card.classList.add('is-tilting'); }
      if (!frozen) onMove(e);
    } else if (hovering) {
      hovering = false;
      if (!(card.matches && card.matches(':focus-within'))) card.classList.remove('is-tilting');
    }
  }

  function onEnter(e) {
    hovering = true;
    if (!baseRect) measureBase();
    card.classList.add('is-tilting');
    if (e) onMove(e);
  }

  function onLeave() {
    hovering = false;
    frozen = false;
    if (!(card && card.matches && card.matches(':focus-within'))) card.classList.remove('is-tilting');
    syncShadowBase();
  }

  if (window.PointerEvent) {
    window.addEventListener('pointermove', onWindowMove, { passive: true });
    document.addEventListener('pointerleave', onLeave, { passive: true });
  } else {
    window.addEventListener('mousemove', function (e) { if (!frozen) onWindowMove(e); }, { passive: true });
    document.addEventListener('mouseleave', onLeave, { passive: true });
  }

  card.addEventListener('pointerenter', onEnter, { passive: true });

  card.addEventListener('focusin', function () { card.classList.add('is-tilting'); }, { passive: true });
  card.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!hovering && !(card && card.matches && card.matches(':focus-within'))) card.classList.remove('is-tilting');
    }, 0);
  }, { passive: true });

  window.addEventListener('resize', function () { measureBase(); }, { passive: true });
  window.addEventListener('scroll', function () { if (!hovering) measureBase(); }, { passive: true });

  // Reage à troca automática de nível gráfico (economia de bateria/CPU)
  window.addEventListener('fileshare:gfx-change', function () { start(); }, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else { lastFrame = 0; start(); }
  });

  start();
})();
