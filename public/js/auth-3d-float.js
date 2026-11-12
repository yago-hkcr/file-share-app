(function () {
  'use strict';
  if (document.body.dataset.auth3dFloatInit === '1') return;
  document.body.dataset.auth3dFloatInit = '1';
  if (!document.body.classList.contains('auth-page')) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  var card = document.querySelector('.auth-card');
  var showcase = document.querySelector('.auth-showcase');
  if (!card) return;

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
  }
  syncShadowBase();
  window.addEventListener('resize', syncShadowBase, { passive: true });
  setTimeout(syncShadowBase, 120);
  setTimeout(syncShadowBase, 700);

  if (reduce) {
    // Static 3D pose, no animation
    card.style.setProperty('--tilt-x', '4deg');
    card.style.setProperty('--tilt-y', '-6deg');
    card.style.setProperty('--float-y', '0px');
    if (shadow) { shadow.style.opacity = '0.4'; shadow.style.filter = 'blur(24px)'; }
    return;
  }

  var maxTilt = coarse ? 4 : 9;
  var targetRX = 4, targetRY = -6, currentRX = 4, currentRY = -6;
  var targetFloat = 0, currentFloat = 0;
  var targetScale = 1, currentScale = 1;
  var hovering = false;
  var rect = null;
  var raf = 0;
  var t0 = performance.now();

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function updateRect() {
    rect = card.getBoundingClientRect();
  }

  function isInteracting() {
    return hovering || (card && card.matches && card.matches(':focus-within'));
  }

  function tick(now) {
    raf = 0;
    var t = (now - t0) * 0.001;
    var active = isInteracting();

    if (!active) {
      // Gentle idle float (kept subtle to avoid perceived tremble)
      targetFloat = Math.sin(t * 0.85) * 7;
      targetRX = 4 + Math.sin(t * 0.55) * 1.0;
      targetRY = -6 + Math.cos(t * 0.45) * 1.5;
      targetScale = 1;
    } else if (hovering) {
      targetFloat = -12;
      targetScale = 1.012;
    } else {
      // Focused/typing: stable, no bobbing
      targetFloat = -4;
      targetScale = 1.0;
      targetRX = lerp(targetRX, 4, 0.12);
      targetRY = lerp(targetRY, -6, 0.12);
    }

    var k = active ? 0.14 : 0.05;
    currentRX = lerp(currentRX, targetRX, k);
    currentRY = lerp(currentRY, targetRY, k);
    currentFloat = lerp(currentFloat, targetFloat, active ? 0.12 : 0.045);
    currentScale = lerp(currentScale, targetScale, 0.1);

    card.style.setProperty('--tilt-x', currentRX.toFixed(3) + 'deg');
    card.style.setProperty('--tilt-y', currentRY.toFixed(3) + 'deg');
    card.style.setProperty('--float-y', currentFloat.toFixed(2) + 'px');
    card.style.setProperty('--card-scale', currentScale.toFixed(4));

    if (showcase) {
      var srx = 2 + (currentRX - 4) * 0.22;
      var sry = 4 + (currentRY + 6) * 0.22;
      showcase.style.setProperty('--tilt-x', srx.toFixed(3) + 'deg');
      showcase.style.setProperty('--tilt-y', sry.toFixed(3) + 'deg');
      showcase.style.setProperty('--float-y', (currentFloat * 0.4).toFixed(2) + 'px');
    }

    if (shadow) {
      // Animate shadow via transform only (no per-frame layout reads) for smoothness
      var liftNorm = clamp((12 - currentFloat) / 24, 0, 1);
      var sx = 1 + liftNorm * 0.16 + Math.abs(currentRY) * 0.006;
      var sy = 1 + liftNorm * 0.2;
      var op = 0.48 - liftNorm * 0.16;
      var blur = 20 + liftNorm * 14;
      var tx = currentRY * 1.1;
      var ty = currentFloat * 0.5;
      shadow.style.transform = 'translateX(' + tx.toFixed(2) + 'px) translateY(' + ty.toFixed(2) + 'px) scaleX(' + sx.toFixed(3) + ') scaleY(' + sy.toFixed(3) + ')';
      shadow.style.opacity = String(Math.max(0.18, op));
      shadow.style.filter = 'blur(' + blur.toFixed(1) + 'px)';
    }

    raf = requestAnimationFrame(tick);
  }

  function onMove(e) {
    if (!rect) updateRect();
    var r = rect;
    if (!r || r.width <= 0 || r.height <= 0) return;
    var px = clamp((e.clientX - r.left) / r.width, 0, 1);
    var py = clamp((e.clientY - r.top) / r.height, 0, 1);
    targetRY = -6 + (px - 0.5) * maxTilt * 2;
    targetRX = 4 + (0.5 - py) * maxTilt * 2;
  }

  function onEnter(e) {
    hovering = true;
    updateRect();
    card.classList.add('is-tilting');
    if (e) onMove(e);
  }

  function onLeave() {
    hovering = false;
    if (!(card && card.matches && card.matches(':focus-within'))) card.classList.remove('is-tilting');
    setTimeout(updateRect, 350);
  }

  if (window.PointerEvent) {
    card.addEventListener('pointerenter', onEnter, { passive: true });
    card.addEventListener('pointermove', function (e) { if (hovering && e.pointerType !== 'touch') onMove(e); }, { passive: true });
    card.addEventListener('pointerleave', onLeave, { passive: true });
  } else {
    card.addEventListener('mouseenter', onEnter, { passive: true });
    card.addEventListener('mousemove', onMove, { passive: true });
    card.addEventListener('mouseleave', onLeave, { passive: true });
  }

  card.addEventListener('focusin', function () { card.classList.add('is-tilting'); }, { passive: true });
  card.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!hovering && !(card && card.matches && card.matches(':focus-within'))) card.classList.remove('is-tilting');
    }, 0);
  }, { passive: true });

  window.addEventListener('resize', function () { if (!hovering) updateRect(); syncShadowBase(); }, { passive: true });
  window.addEventListener('scroll', function () { if (!hovering) updateRect(); }, { passive: true });

  raf = requestAnimationFrame(tick);
})();
