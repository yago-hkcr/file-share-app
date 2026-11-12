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
  function syncShadow() {
    if (!shadow || !card || !card.parentNode) return;
    var r = card.getBoundingClientRect();
    var pr = card.parentNode.getBoundingClientRect();
    shadow.style.position = 'absolute';
    shadow.style.left = ((r.left - pr.left) + r.width * 0.08) + 'px';
    shadow.style.top = ((r.top - pr.top) + r.height - 16) + 'px';
    shadow.style.width = (r.width * 0.84) + 'px';
    shadow.style.height = Math.max(26, r.height * 0.16) + 'px';
    shadow.style.pointerEvents = 'none';
  }
  syncShadow();
  window.addEventListener('resize', syncShadow, { passive: true });
  setTimeout(syncShadow, 120);
  setTimeout(syncShadow, 700);

  if (reduce) {
    // Static 3D pose, no animation
    card.style.setProperty('--tilt-x', '4deg');
    card.style.setProperty('--tilt-y', '-6deg');
    shadow.style.opacity = '0.4';
    shadow.style.filter = 'blur(24px)';
    return;
  }

  var maxTilt = coarse ? 4 : 10;
  var targetRX = 4, targetRY = -6, currentRX = 4, currentRY = -6;
  var targetFloat = 0, currentFloat = 0;
  var targetScale = 1, currentScale = 1;
  var hovering = false;
  var rect = null;
  var raf = 0;
  var t0 = performance.now();

  function lerp(a, b, t) { return a + (b - a) * t; }

  function updateRect() {
    // Use layout rect approximation: temporarily neutralize vars? easier to read current rect
    // but transforms affect it. Cache on enter and on resize/scroll when not interacting heavily.
    rect = card.getBoundingClientRect();
  }

  function tick(now) {
    raf = 0;
    var t = (now - t0) * 0.001;

    if (!hovering) {
      // Smooth idle float + gentle sway
      targetFloat = Math.sin(t * 1.1) * 14;
      targetRX = 4 + Math.sin(t * 0.7) * 2.2;
      targetRY = -6 + Math.cos(t * 0.55) * 3.2;
      targetScale = 1;
    } else {
      targetFloat = -18;
      targetScale = 1.02;
    }

    var k = hovering ? 0.18 : 0.08;
    currentRX = lerp(currentRX, targetRX, k);
    currentRY = lerp(currentRY, targetRY, k);
    currentFloat = lerp(currentFloat, targetFloat, hovering ? 0.16 : 0.07);
    currentScale = lerp(currentScale, targetScale, 0.14);

    card.style.setProperty('--tilt-x', currentRX.toFixed(3) + 'deg');
    card.style.setProperty('--tilt-y', currentRY.toFixed(3) + 'deg');
    card.style.setProperty('--float-y', currentFloat.toFixed(2) + 'px');
    card.style.setProperty('--card-scale', currentScale.toFixed(4));

    if (showcase) {
      var srx = 2 + (currentRX - 4) * 0.25;
      var sry = 4 + (currentRY + 6) * 0.25;
      showcase.style.setProperty('--tilt-x', srx.toFixed(3) + 'deg');
      showcase.style.setProperty('--tilt-y', sry.toFixed(3) + 'deg');
      showcase.style.setProperty('--float-y', (currentFloat * 0.45).toFixed(2) + 'px');
    }

    if (shadow) {
      var liftNorm = clamp((18 - currentFloat) / 36, 0, 1); // higher when floating up
      var sx = 1 + liftNorm * 0.22 + Math.abs(currentRY) * 0.01;
      var sy = 1 + liftNorm * 0.28;
      var op = 0.52 - liftNorm * 0.22;
      var blur = 22 + liftNorm * 20;
      shadow.style.transform = 'translateX(' + (currentRY * 1.4).toFixed(1) + 'px) scaleX(' + sx.toFixed(3) + ') scaleY(' + sy.toFixed(3) + ')';
      shadow.style.opacity = String(Math.max(0.16, op));
      shadow.style.filter = 'blur(' + blur.toFixed(1) + 'px)';
    }

    // keep running for smooth idle float; cheap
    raf = requestAnimationFrame(tick);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function onMove(e) {
    if (!rect) updateRect();
    var r = rect;
    if (!r || r.width <= 0 || r.height <= 0) return;
    // clamp pointer inside rect to avoid jumps at edges
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
    card.classList.remove('is-tilting');
    // target returns to idle in tick; refresh rect after transition settles
    setTimeout(updateRect, 350);
  }

  // Use pointer events when available for stability
  if (window.PointerEvent) {
    card.addEventListener('pointerenter', onEnter, { passive: true });
    card.addEventListener('pointermove', function (e) { if (hovering && e.pointerType !== 'touch') onMove(e); }, { passive: true });
    card.addEventListener('pointerleave', onLeave, { passive: true });
  } else {
    card.addEventListener('mouseenter', onEnter, { passive: true });
    card.addEventListener('mousemove', onMove, { passive: true });
    card.addEventListener('mouseleave', onLeave, { passive: true });
  }

  window.addEventListener('resize', function () { if (!hovering) updateRect(); syncShadow(); }, { passive: true });
  window.addEventListener('scroll', function () { if (!hovering) updateRect(); }, { passive: true });

  // keep shadow in sync with animated card
  setInterval(syncShadow, 800);

  raf = requestAnimationFrame(tick);
})();
