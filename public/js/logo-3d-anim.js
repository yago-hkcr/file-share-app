/**
 * logo-3d-anim.js — Laser intro animation for Arquive Online logo.
 * Draws the share-nodes mark and brand text with laser tracing, sparks and glow.
 * API: new ArquiveLogo3D(canvas, opts).play()/stop()/resize()
 */
(function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  function buildPaths() {
    var nodes = [
      { x: 0, y: -95, r: 28 },
      { x: -82, y: 58, r: 28 },
      { x: 82, y: 58, r: 28 },
      { x: 0, y: 8, r: 22 }
    ];
    var links = [[3, 0], [3, 1], [3, 2]];
    var segs = [];
    for (var i = 0; i < links.length; i++) {
      var a = nodes[links[i][0]], b = nodes[links[i][1]];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      segs.push({ type: 'line', x1: a.x + ux * a.r, y1: a.y + uy * a.r, x2: b.x - ux * b.r, y2: b.y - uy * b.r, w: 7 });
    }
    for (var n = 0; n < nodes.length; n++) {
      segs.push({ type: 'circle', cx: nodes[n].x, cy: nodes[n].y, r: nodes[n].r, w: 3.5 });
    }
    segs.push({ type: 'arc', cx: 0, cy: 8, r: 150, a1: -Math.PI * 0.15, a2: Math.PI * 1.05, w: 2, thin: true });
    segs.push({ type: 'arc', cx: 0, cy: 8, r: 170, a1: Math.PI * 0.9, a2: Math.PI * 2.15, w: 2, thin: true });
    return segs;
  }

  function segLen(s) {
    if (s.type === 'line') { var dx = s.x2 - s.x1, dy = s.y2 - s.y1; return Math.sqrt(dx * dx + dy * dy); }
    if (s.type === 'circle') return Math.PI * 2 * s.r;
    if (s.type === 'arc') return Math.abs(s.a2 - s.a1) * s.r;
    return 0;
  }
  function pointAt(s, t) {
    if (s.type === 'line') return { x: lerp(s.x1, s.x2, t), y: lerp(s.y1, s.y2, t) };
    if (s.type === 'circle') { var a = -Math.PI / 2 + t * Math.PI * 2; return { x: s.cx + Math.cos(a) * s.r, y: s.cy + Math.sin(a) * s.r }; }
    if (s.type === 'arc') { var aa = lerp(s.a1, s.a2, t); return { x: s.cx + Math.cos(aa) * s.r, y: s.cy + Math.sin(aa) * s.r }; }
    return { x: 0, y: 0 };
  }

  function Logo3D(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.dpr = 1; this.W = 0; this.H = 0; this.raf = 0; this.start = 0;
    this.playing = false; this.done = false;
    this.paths = buildPaths();
    this.totalLen = 0;
    for (var i = 0; i < this.paths.length; i++) { this.paths[i].len = segLen(this.paths[i]); this.totalLen += this.paths[i].len; }
    this.sparks = [];
    this.resize();
  }

  Logo3D.prototype.resize = function () {
    var c = this.canvas;
    var r = c.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(1, Math.floor((r.width || 600) * this.dpr));
    this.H = Math.max(1, Math.floor((r.height || 420) * this.dpr));
    c.width = this.W; c.height = this.H;
  };

  Logo3D.prototype.spawnSparks = function (x, y, n, accent) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(40, 220);
      this.sparks.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(20, 90), life: rand(0.25, 0.75), age: 0, s: rand(0.8, 2.8), accent: accent });
    }
  };

  Logo3D.prototype.drawPathPartial = function (seg, tEnd, cx, cy, scale, color, alpha, glow, lineW) {
    var ctx = this.ctx;
    tEnd = clamp(tEnd, 0, 1);
    if (tEnd <= 0) return null;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.strokeStyle = 'rgba(' + color + ',' + alpha + ')';
    ctx.lineWidth = lineW || seg.w || 3;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(' + color + ',' + (glow || 0.9) + ')';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    var tip = null;
    if (seg.type === 'line') {
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(lerp(seg.x1, seg.x2, tEnd), lerp(seg.y1, seg.y2, tEnd));
      tip = pointAt(seg, tEnd);
    } else if (seg.type === 'circle') {
      ctx.arc(seg.cx, seg.cy, seg.r, -Math.PI / 2, -Math.PI / 2 + tEnd * Math.PI * 2);
      tip = pointAt(seg, tEnd);
    } else if (seg.type === 'arc') {
      ctx.arc(seg.cx, seg.cy, seg.r, seg.a1, lerp(seg.a1, seg.a2, tEnd));
      tip = pointAt(seg, tEnd);
    }
    ctx.stroke();
    ctx.restore();
    if (tip) return { x: cx + tip.x * scale, y: cy + tip.y * scale };
    return null;
  };

  Logo3D.prototype.drawFullLogo = function (cx, cy, scale, dark, reveal, pulse) {
    var ctx = this.ctx;
    var accent = '74,222,128';
    var accent2 = '34,211,238';
    var a = clamp(reveal, 0, 1);
    var nodes = [{ x: 0, y: -95, r: 28 }, { x: -82, y: 58, r: 28 }, { x: 82, y: 58, r: 28 }, { x: 0, y: 8, r: 22 }];
    var links = [[3, 0], [3, 1], [3, 2]];
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(scale, scale);
    var rg = ctx.createRadialGradient(0, 0, 0, 0, 0, 190);
    rg.addColorStop(0, 'rgba(' + accent + ',' + (0.13 * a * (0.85 + pulse * 0.15)) + ')');
    rg.addColorStop(1, 'rgba(' + accent + ',0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 10, 190, 0, Math.PI * 2); ctx.fill();

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(' + accent + ',' + (0.95 * a) + ')';
    ctx.shadowBlur = 26;

    ctx.strokeStyle = 'rgba(' + accent + ',' + (0.95 * a) + ')';
    ctx.lineWidth = 7;
    for (var i = 0; i < links.length; i++) {
      var na = nodes[links[i][0]], nb = nodes[links[i][1]];
      var dx = nb.x - na.x, dy = nb.y - na.y, len = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / len, uy = dy / len;
      ctx.beginPath(); ctx.moveTo(na.x + ux * na.r, na.y + uy * na.r); ctx.lineTo(nb.x - ux * nb.r, nb.y - uy * nb.r); ctx.stroke();
    }
    for (var n = 0; n < nodes.length; n++) {
      var nd = nodes[n];
      ctx.fillStyle = 'rgba(' + accent + ',' + (0.14 * a) + ')';
      ctx.strokeStyle = 'rgba(' + accent + ',' + (0.98 * a) + ')';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(255,255,255,' + 0.92 * a + ')';
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r * 0.28, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 26;
    }
    ctx.shadowBlur = 16;
    ctx.strokeStyle = 'rgba(' + accent2 + ',' + (0.55 * a) + ')'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 8, 150, -Math.PI * 0.15, Math.PI * 1.05); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 8, 170, Math.PI * 0.9, Math.PI * 2.15); ctx.stroke();
    ctx.restore();
  };

  Logo3D.prototype.drawLaserTip = function (x, y, dark, intensity) {
    var ctx = this.ctx;
    var c = '120,255,180';
    var c2 = '34,211,238';
    ctx.save();
    var g = ctx.createRadialGradient(x, y, 0, x, y, 28 * intensity);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.95 * intensity) + ')');
    g.addColorStop(0.25, 'rgba(' + c + ',' + (0.85 * intensity) + ')');
    g.addColorStop(0.6, 'rgba(' + c2 + ',' + (0.25 * intensity) + ')');
    g.addColorStop(1, 'rgba(' + c + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 28 * intensity, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.75 * intensity) + ')';
    ctx.lineWidth = 1.5; ctx.shadowColor = 'rgba(' + c + ',0.9)'; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(x - 20 * intensity, y); ctx.lineTo(x + 20 * intensity, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - 20 * intensity); ctx.lineTo(x, y + 20 * intensity); ctx.stroke();
    ctx.restore();
  };

  Logo3D.prototype.updateAndDrawSparks = function (dt, dark) {
    var ctx = this.ctx;
    for (var si = this.sparks.length - 1; si >= 0; si--) {
      var sp = this.sparks[si];
      sp.age += dt; sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.vy += 260 * dt; sp.vx *= 0.985;
      var life = 1 - sp.age / sp.life;
      if (life <= 0) { this.sparks.splice(si, 1); continue; }
      var col = sp.accent || '74,222,128';
      ctx.save();
      ctx.fillStyle = 'rgba(' + col + ',' + (life * 0.9) + ')';
      ctx.shadowColor = 'rgba(' + col + ',0.8)'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, sp.s * life * this.dpr, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  };

  Logo3D.prototype.drawText = function (cx, cy, scale, dark, ta) {
    ta = clamp(ta, 0, 1);
    if (ta <= 0) return;
    var ctx = this.ctx;
    var accent = '74,222,128';
    var ty = cy + 175 * scale;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var wipeW = this.W * easeOutCubic(ta);
    ctx.beginPath(); ctx.rect(cx - wipeW / 2, ty - 60 * scale, wipeW, 120 * scale); ctx.clip();
    ctx.globalAlpha = clamp(ta * 1.5, 0, 1);
    ctx.shadowColor = 'rgba(74,222,128,0.7)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#eafff3';
    ctx.font = '800 ' + Math.round(34 * scale) + 'px Inter, system-ui, sans-serif';
    ctx.fillText('ARQUIVE ONLINE', cx, ty);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = clamp((ta - 0.3) / 0.7, 0, 1) * 0.85;
    ctx.fillStyle = 'rgba(' + accent2 + ',0.95)';
    ctx.font = '700 ' + Math.round(12 * scale) + 'px Inter, system-ui, sans-serif';
    ctx.fillText('SEU ESPAÇO · SUAS CONEXÕES', cx, ty + 30 * scale);
    ctx.restore();
    if (ta < 1) {
      var edgeX = cx - wipeW / 2 + wipeW;
      var eg = ctx.createLinearGradient(edgeX - 18, 0, edgeX + 18, 0);
      eg.addColorStop(0, 'rgba(34,211,238,0)'); eg.addColorStop(0.5, 'rgba(255,255,255,' + 0.85 + ')'); eg.addColorStop(1, 'rgba(34,211,238,0)');
      ctx.fillStyle = eg; ctx.fillRect(edgeX - 18, ty - 55 * scale, 36, 110 * scale);
    }
  };

  Logo3D.prototype.render = function (ts) {
    var self = this;
    if (!self.start) self.start = ts;
    var elapsed = ts - self.start;
    var duration = this.opts.duration || 5200;
    var progress = clamp(elapsed / duration, 0, 1);
    var ctx = self.ctx, W = self.W, H = self.H;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var accent = '74,222,128';
    var accent2 = '34,211,238';
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H * 0.44;
    var scale = Math.min(W, H) / 520;

    var sweepP = clamp(progress / 0.85, 0, 1);
    var sweepY = -H * 0.1 + sweepP * H * 1.2;
    var sg = ctx.createLinearGradient(0, sweepY - 40 * this.dpr, 0, sweepY + 40 * this.dpr);
    sg.addColorStop(0, 'rgba(' + accent2 + ',0)');
    sg.addColorStop(0.5, 'rgba(' + accent2 + ',' + 0.13 + ')');
    sg.addColorStop(1, 'rgba(' + accent2 + ',0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);

    var traceEnd = 0.72;
    var traceP = clamp(progress / traceEnd, 0, 1);
    var solidP = clamp((progress - traceEnd) / (1 - traceEnd), 0, 1);
    var drawnLen = traceP * this.totalLen;
    var accum = 0;
    var tip = null;

    for (var i = 0; i < this.paths.length; i++) {
      var seg = this.paths[i];
      var segStart = accum; var segEnd = accum + seg.len;
      var localT = 0;
      if (drawnLen >= segEnd) localT = 1;
      else if (drawnLen > segStart) localT = (drawnLen - segStart) / seg.len;
      accum = segEnd;
      if (localT <= 0) continue;
      var segAlpha = 0.5 + 0.5 * localT;
      var col = (i >= 7) ? accent2 : accent;
      var p = this.drawPathPartial(seg, localT, cx, cy, scale, col, segAlpha, 0.85, seg.thin ? 2 : seg.w);
      if (localT > 0 && localT < 1) tip = p;
    }

    if (tip && traceP < 1) {
      ctx.save();
      var beamStartX = -20 * this.dpr, beamStartY = sweepY;
      var grad = ctx.createLinearGradient(beamStartX, beamStartY, tip.x, tip.y);
      grad.addColorStop(0, 'rgba(' + accent2 + ',0)');
      grad.addColorStop(0.7, 'rgba(' + accent2 + ',' + 0.22 + ')');
      grad.addColorStop(1, 'rgba(255,255,255,' + 0.55 + ')');
      ctx.strokeStyle = grad; ctx.lineWidth = 2.2 * this.dpr;
      ctx.shadowColor = 'rgba(' + accent2 + ',0.9)'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.moveTo(beamStartX, beamStartY); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,' + 0.78 + ')';
      ctx.lineWidth = 1; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(beamStartX, beamStartY); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      ctx.restore();
      this.drawLaserTip(tip.x, tip.y, dark, 1);
      if (!reduceMotion && Math.random() < 0.75) this.spawnSparks(tip.x, tip.y, 2, accent);
    }

    if (solidP > 0) {
      var pulse = 0.5 + 0.5 * Math.sin(elapsed * 0.004);
      this.drawFullLogo(cx, cy, scale, dark, easeOutCubic(solidP), pulse);
      if (solidP < 0.22) {
        ctx.save();
        ctx.globalAlpha = (1 - solidP / 0.22) * 0.16;
        ctx.fillStyle = '#eafff8';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    this.updateAndDrawSparks(0.016, dark);
    this.drawText(cx, cy, scale, dark, clamp((progress - 0.62) / 0.28, 0, 1));

    if (progress < 1) {
      self.raf = requestAnimationFrame(function (t) { self.render(t); });
    } else {
      self.done = true; self.playing = false;
      if (!reduceMotion) {
        self.raf = requestAnimationFrame(function (t) { self.idle(t); });
      } else if (self.opts.onComplete) {
        try { self.opts.onComplete(); } catch (e) {}
      }
      if (self.opts.onComplete && !reduceMotion) {
        // onComplete called after main sequence; idle continues
        try { self.opts.onComplete(); } catch (e2) {}
      }
    }
  };

  Logo3D.prototype.idle = function (ts) {
    var self = this;
    if (!self.start) self.start = ts;
    var elapsed = ts - self.start;
    var ctx = self.ctx, W = self.W, H = self.H;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var accent = '74,222,128';
    var cx = W / 2, cy = H * 0.44;
    var scale = Math.min(W, H) / 520;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var pulse = 0.5 + 0.5 * Math.sin(elapsed * 0.003);
    self.drawFullLogo(cx, cy, scale, dark, 1, pulse);
    self.drawText(cx, cy, scale, dark, 1);
    if (Math.random() < 0.04) {
      var nds = [{ x: 0, y: -95 }, { x: -82, y: 58 }, { x: 82, y: 58 }, { x: 0, y: 8 }];
      var nd = nds[Math.floor(Math.random() * nds.length)];
      self.spawnSparks(cx + nd.x * scale, cy + nd.y * scale, 1, accent);
    }
    self.updateAndDrawSparks(0.016, dark);
    self.raf = requestAnimationFrame(function (t) { self.idle(t); });
  };

  Logo3D.prototype.play = function () {
    if (this.playing) return;
    this.playing = true; this.done = false; this.start = 0; this.sparks = [];
    var self = this;
    try { this.resize(); } catch (e) {}
    this.raf = requestAnimationFrame(function (t) { self.render(t); });
  };
  Logo3D.prototype.stop = function () {
    this.playing = false;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  };

  window.ArquiveLogo3D = Logo3D;
  window.Logo3DAnim = {
    start: function (opts) {
      try {
        var c = opts && opts.canvas;
        if (!c) return null;
        var inst = new Logo3D(c, opts);
        inst.play();
        return inst;
      } catch (e) { return null; }
    }
  };
})();
