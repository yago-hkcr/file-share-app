/**
 * bg-3d.js — Global 3D animated background for Arquive Online.
 * Renders a fixed canvas behind page content: perspective grid, floating
 * particles and drifting wireframe cubes. Respects prefers-reduced-motion
 * and adapts to light/dark theme.
 */
(function () {
  'use strict';
  if (window.__arquiveBg3dInit) return;
  window.__arquiveBg3dInit = true;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canvas, ctx, W = 0, H = 0, dpr = 1, raf = 0, t0 = 0;
  var particles = [], cubes = [];

  function themeIsDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }
  function palette() {
    var dark = themeIsDark();
    return dark
      ? { bg0: '#010503', bg1: '#03140c', bg2:'#062018', grid: 'rgba(34,211,238,', grid2: 'rgba(34,197,94,', particle: 'rgba(120,255,170,', glow: '34,197,94', fog: 'rgba(1,5,3,', cube:'rgba(34,211,238,' }
      : { bg0: '#ecebe6', bg1: '#f8f8f5', bg2:'#ffffff', grid: 'rgba(40,40,40,', grid2: 'rgba(70,70,70,', particle: 'rgba(20,20,20,', glow: '40,40,40', fog: 'rgba(236,235,230,', cube:'rgba(50,50,50,' };
  }


  function ensureStyle() {
    if (document.getElementById('site-bg-3d-style')) return;
    var st = document.createElement('style');
    st.id = 'site-bg-3d-style';
    st.textContent = 'html.has-bg3d,html.has-bg3d body{background:transparent!important;background-color:transparent!important;background-image:none!important;}';
    document.head.appendChild(st);
  }

  function initCanvas() {
    ensureStyle();
    document.documentElement.classList.add('has-bg3d');
    canvas = document.getElementById('site-bg-3d');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'site-bg-3d';
      canvas.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(canvas, document.body.firstChild);
    }
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:block;';
    ctx = canvas.getContext('2d', { alpha: true });
    resize();
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function seed() {
    var count = Math.min(220, Math.floor((W * H) / 9000));
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: rand(-W * 0.7, W * 0.7), y: rand(-H * 0.2, H * 1.2), z: rand(0.15, 1.6),
        s: rand(0.5, 3.0), vx: rand(-0.10, 0.10), vy: rand(-0.22, -0.03),
        tw: rand(0, Math.PI * 2), ts: rand(0.4, 1.6)
      });
    }
    cubes = [];
    var cc = Math.min(28, Math.floor(W / 60));
    for (var j = 0; j < cc; j++) {
      cubes.push({
        x: rand(-1.2, 1.2), y: rand(-0.2, 1.0), z: rand(0.4, 2.2),
        size: rand(0.04, 0.13), rx: rand(0, Math.PI), ry: rand(0, Math.PI),
        vrx: rand(-0.004, 0.004), vry: rand(0.002, 0.01), vz: rand(0.0006, 0.0018)
      });
    }
  }

  function project(x, y, z) {
    var fov = Math.min(W, H) * 0.9;
    var cx = W * 0.5, cy = H * 0.52;
    var scale = fov / (fov + z * fov);
    return { x: cx + x * scale, y: cy + y * scale, s: scale };
  }

  function drawGrid(time, pal, dark) {
    var horizon = H * 0.48;
    var speed = ((time * 0.00006) % 1 + 1) % 1;
    var depthLines = 26;
    for (var i = 0; i < depthLines; i++) {
      var p = (i / depthLines + speed) % 1;
      var persp = p * p;
      var y = horizon + persp * (H * 0.62);
      var alpha = (dark ? 0.38 : 0.14) * (0.2 + persp * 1.15);
      ctx.strokeStyle = pal.grid + alpha + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    var vCount = 22;
    var cx = W * 0.5;
    for (var v = -vCount; v <= vCount; v++) {
      var spread = v / vCount;
      var bx = cx + spread * W * 1.25;
      var alphaV = (dark ? 0.30 : 0.11) * (1 - Math.abs(spread) * 0.45);
      if (alphaV <= 0) continue;
      ctx.strokeStyle = pal.grid2 + alphaV + ')';
      ctx.beginPath();
      ctx.moveTo(cx + spread * W * 0.02, horizon);
      ctx.lineTo(bx, H * 1.05);
      ctx.stroke();
    }
    var hg = ctx.createLinearGradient(0, horizon - H * 0.18, 0, horizon + H * 0.08);
    hg.addColorStop(0, 'rgba(' + pal.glow + ',0)');
    hg.addColorStop(0.5, 'rgba(' + pal.glow + ',' + (dark ? 0.22 : 0.07) + ')');
    hg.addColorStop(1, 'rgba(' + pal.glow + ',0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, horizon - H * 0.25, W, H * 0.40);
  }

  function drawParticles(time, pal, dark) {
    var cx = W * 0.5;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (!reduced) {
        p.x += p.vx; p.y += p.vy; p.tw += 0.016 * p.ts;
        if (p.y < -H * 0.15) { p.y = H * 1.1; p.x = rand(-W * 0.6, W * 0.6); }
        if (p.x < -W * 0.7) p.x = W * 0.7; if (p.x > W * 0.7) p.x = -W * 0.7;
      }
      var pr = project(p.x, (p.y - H * 0.5), p.z * Math.min(W, H) * 0.9);
      var a = (dark ? 0.85 : 0.34) * (0.35 + 0.65 * Math.abs(Math.sin(p.tw))) * (1.3 - p.z * 0.45);
      var r = p.s * pr.s * (dark ? 1.8 : 1.25);
      ctx.fillStyle = pal.particle + Math.max(0, Math.min(1, a)) + ')';
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, Math.max(0.2, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function rotatePoint(pt, rx, ry) {
    var x = pt[0], y = pt[1], z = pt[2];
    var y1 = y * Math.cos(rx) - z * Math.sin(rx);
    var z1 = y * Math.sin(rx) + z * Math.cos(rx);
    var x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
    var z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
    return [x2, y1, z2];
  }

  function drawCubes(time, pal, dark) {
    var verts = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
    var edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    var cx = W * 0.5, cy = H * 0.46;
    var fov = Math.min(W, H) * 0.95;
    for (var i = 0; i < cubes.length; i++) {
      var c = cubes[i];
      if (!reduced) { c.rx += c.vrx; c.ry += c.vry; c.z -= c.vz; if (c.z < 0.25) { c.z = 2.4; c.x = rand(-1.2, 1.2); c.y = rand(-0.2, 1.0); } }
      var sc = fov / (fov + c.z * fov);
      var ox = cx + c.x * W * 0.45 * sc;
      var oy = cy + c.y * H * 0.35 * sc;
      var sz = c.size * Math.min(W, H) * sc;
      var alpha = (dark ? 0.40 : 0.16) * (1.4 - c.z * 0.4);
      if (alpha < 0.01) continue;
      ctx.strokeStyle = (pal.cube || pal.grid2) + Math.max(0, alpha) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (var e = 0; e < edges.length; e++) {
        var a = rotatePoint(verts[edges[e][0]], c.rx, c.ry);
        var b = rotatePoint(verts[edges[e][1]], c.rx, c.ry);
        ctx.moveTo(ox + a[0] * sz, oy + a[1] * sz);
        ctx.lineTo(ox + b[0] * sz, oy + b[1] * sz);
      }
      ctx.stroke();
    }
  }

  function splashActive() {
    var el = document.getElementById('splashIntro');
    return !!(el && el.isConnected && !el.classList.contains('leaving'));
  }

  function frame(ts) {
    if (!t0) t0 = ts;
    // Pause heavy background rendering while the centered splash intro is on screen
    if (splashActive()) {
      if (!reduced) raf = requestAnimationFrame(frame);
      return;
    }
    var time = ts - t0;
    var pal = palette();
    var dark = themeIsDark();
    ctx.clearRect(0, 0, W, H);
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, pal.bg0); g.addColorStop(0.35, pal.bg1); g.addColorStop(0.55, pal.bg2 || pal.bg1); g.addColorStop(1, pal.bg0);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    var rg = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.min(W, H) * 0.7);
    rg.addColorStop(0, 'rgba(' + pal.glow + ',' + (dark ? 0.16 : 0.05) + ')');
    rg.addColorStop(1, 'rgba(' + pal.glow + ',0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

    drawGrid(time, pal, dark);
    drawParticles(time, pal, dark);
    drawCubes(time, pal, dark);

    var fade = ctx.createLinearGradient(0, 0, 0, H);
    fade.addColorStop(0, pal.fog + (dark ? '0.18)' : '0.22)'));
    fade.addColorStop(0.15, pal.fog + '0)');
    fade.addColorStop(0.85, pal.fog + '0)');
    fade.addColorStop(1, pal.fog + (dark ? '0.28)' : '0.30)'));
    ctx.fillStyle = fade; ctx.fillRect(0, 0, W, H);
    // depth vignette for 3D focus
    var vig = ctx.createRadialGradient(W*0.5, H*0.5, Math.min(W,H)*0.2, W*0.5, H*0.55, Math.max(W,H)*0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,' + (dark ? '0.28' : '0.10') + ')');
    ctx.fillStyle = vig; ctx.fillRect(0,0,W,H);

    if (!reduced) raf = requestAnimationFrame(frame);
  }

  function start() {
    try {
      initCanvas();
      if (reduced) {
        // draw once when splash is gone
        var tryOnce = function (ts) {
          if (splashActive()) { requestAnimationFrame(tryOnce); return; }
          frame(ts || performance.now());
        };
        requestAnimationFrame(tryOnce);
      } else {
        raf = requestAnimationFrame(frame);
      }
    } catch (e) { /* background is decorative; never break the app */ }
  }

  window.addEventListener('resize', function () { try { resize(); if (reduced) requestAnimationFrame(frame); } catch (e) {} }, { passive: true });
  window.addEventListener('fileshare:theme-change', function () { try { seed(); if (reduced) requestAnimationFrame(frame); } catch (e) {} });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
