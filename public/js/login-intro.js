/* Arquive Online — cinematic first-run motion presentation with generative sound. */
(function () {
  'use strict';

  const STORAGE_KEY = 'fileshare-login-intro-seen-v4';
  const SCENE_DURATION = 5200;
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scenes = [
    {
      eyebrow: 'Uma nova era de compartilhar',
      title: ['O futuro', 'chegou.'],
      copy: 'Arquivos, pessoas e ideias colidem em um espaço feito para fluir.',
      tag: 'INÍCIO',
      hue: 158
    },
    {
      eyebrow: 'Envio sem limites de atrito',
      title: ['Solte.', 'Simples assim.'],
      copy: 'Arraste, envie e acompanhe cada arquivo em tempo real — sem perder o ritmo.',
      tag: 'ENVIO',
      hue: 175
    },
    {
      eyebrow: 'Colaboração em outro nível',
      title: ['Salas que', 'respiram.'],
      copy: 'Cada projeto ganha seu próprio universo: arquivos, conversa e contexto juntos.',
      tag: 'SALAS',
      hue: 145
    },
    {
      eyebrow: 'Receba de qualquer pessoa',
      title: ['Peça.', 'Receba. Pronto.'],
      copy: 'Coletas organizam envios por pessoa, com prazo, controle e download em um clique.',
      tag: 'COLETAS',
      hue: 190
    },
    {
      eyebrow: 'Seu acervo, seu poder',
      title: ['Tudo seu.', 'Para sempre.'],
      copy: 'Guarde o que importa, organize do seu jeito e acesse quando precisar.',
      tag: 'ACERVO',
      hue: 165
    },
    {
      eyebrow: 'Bem-vindo ao Arquive Online',
      title: ['Entre e', 'faça história.'],
      copy: 'Sua próxima grande troca começa agora.',
      tag: 'ENTRAR',
      hue: 152,
      final: true
    }
  ];

  /* -------------------- Generative Audio -------------------- */
  function createAudio() {
    let ctx = null;
    let master = null;
    let comp = null;
    let noiseBuffer = null;
    let started = false;
    let muted = true;
    let droneNodes = [];
    let pulseTimer = 0;

    function ensure() {
      if (ctx) return ctx;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 18;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(comp);
      comp.connect(ctx.destination);
      // white noise buffer for sweeps/impacts
      const len = ctx.sampleRate * 2;
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return ctx;
    }

    function resume() {
      ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }

    function setMuted(value) {
      muted = value;
      ensure();
      if (!ctx || !master) return;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(muted ? 0 : 0.85, now, 0.08);
      if (!muted) { resume(); if (!started) startDrone(); }
    }

    function toggle() { setMuted(!muted); return !muted; }
    function isMuted() { return muted; }

    function noiseSource(duration, filterFreq, type, gainVal, when, attack, decay) {
      if (!ctx || !noiseBuffer) return;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = type || 'bandpass';
      filter.frequency.setValueAtTime(filterFreq, when);
      filter.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainVal), when + (attack || 0.02));
      g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      src.connect(filter); filter.connect(g); g.connect(master);
      src.start(when); src.stop(when + duration + 0.05);
      if (decay) filter.frequency.exponentialRampToValueAtTime(Math.max(40, decay), when + duration);
    }

    function tone(freq, when, duration, type, gainVal, detune, slideTo) {
      if (!ctx) return;
      const osc = ctx.createOscillator();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, when);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), when + duration);
      if (detune) osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainVal), when + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      osc.connect(g); g.connect(master);
      osc.start(when); osc.stop(when + duration + 0.05);
    }

    function startDrone() {
      if (!ctx || started) return;
      started = true;
      const base = 55; // A1
      const freqs = [base, base * 1.5, base * 2, base * 3];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'sine' : 'triangle';
        osc.frequency.value = f;
        if (i > 1) osc.detune.value = (i % 2 ? 4 : -4);
        const g = ctx.createGain();
        g.gain.value = i === 0 ? 0.045 : 0.012;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 220 + i * 80;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.05 + i * 0.03;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 0.004;
        lfo.connect(lfoG); lfoG.connect(g.gain);
        osc.connect(filter); filter.connect(g); g.connect(master);
        osc.start(); lfo.start();
        droneNodes.push(osc, lfo, g, filter, lfoG);
      });
      schedulePulse();
    }

    function schedulePulse() {
      if (!ctx) return;
      clearTimeout(pulseTimer);
      const beat = () => {
        if (!ctx || ctx.state === 'closed') return;
        if (!muted) {
          const now = ctx.currentTime;
          tone(110, now, 0.6, 'sine', 0.03, 0, 55);
          tone(220, now + 0.02, 0.25, 'triangle', 0.012);
        }
        pulseTimer = setTimeout(beat, 2600);
      };
      pulseTimer = setTimeout(beat, 1200);
    }

    function sceneChange(index, isFinal) {
      if (!ctx || muted) return;
      const now = ctx.currentTime;
      // whoosh sweep
      noiseSource(0.7, 600, 'bandpass', 0.18, now, 0.01, 0.7);
      if (ctx && noiseBuffer) {
        const src = ctx.createBufferSource(); src.buffer = noiseBuffer;
        const f = ctx.createBiquadFilter(); f.type = 'highpass';
        f.frequency.setValueAtTime(200, now);
        f.frequency.exponentialRampToValueAtTime(4200, now + 0.35);
        f.frequency.exponentialRampToValueAtTime(300, now + 0.7);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.12, now + 0.18);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
        src.connect(f); f.connect(g); g.connect(master);
        src.start(now); src.stop(now + 0.75);
      }
      // impact thud
      tone(70, now + 0.05, 0.5, 'sine', 0.22, 0, 30);
      tone(140, now + 0.06, 0.18, 'triangle', 0.08);
      // harmonic shimmer per scene
      const scale = [220, 261.63, 329.63, 392, 440, 523.25];
      const root = scale[index % scale.length];
      [1, 1.25, 1.5, 2].forEach((m, i) => {
        tone(root * m, now + 0.12 + i * 0.06, 0.9 - i * 0.1, i < 2 ? 'sine' : 'triangle', 0.045 - i * 0.008);
      });
      if (isFinal) {
        // triumphant chord
        [261.63, 329.63, 392, 523.25, 659.25].forEach((f, i) => {
          tone(f, now + 0.25 + i * 0.04, 1.8, 'sine', 0.06);
          tone(f, now + 0.25 + i * 0.04, 1.2, 'triangle', 0.025);
        });
        noiseSource(1.2, 2000, 'lowpass', 0.08, now + 0.2, 0.08, 1.2);
      }
    }

    function click() {
      if (!ctx || muted) return;
      const now = ctx.currentTime;
      tone(880, now, 0.08, 'sine', 0.05, 0, 1200);
      noiseSource(0.06, 3000, 'highpass', 0.04, now, 0.005);
    }

    function close() {
      clearTimeout(pulseTimer);
      if (!ctx) return;
      try {
        if (master) {
          const now = ctx.currentTime;
          master.gain.cancelScheduledValues(now);
          master.gain.setTargetAtTime(0, now, 0.12);
        }
        setTimeout(() => { try { ctx.close(); } catch (_) {} ctx = null; }, 600);
      } catch (_) {}
    }

    return { ensure, resume, setMuted, toggle, isMuted, sceneChange, click, close };
  }

  /* -------------------- Canvas FX -------------------- */
  function createCanvasFX(container, getHue) {
    const canvas = document.createElement('canvas');
    canvas.className = 'intro-canvas-fx';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);
    const c = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1, raf = 0, t = 0;
    let particles = [];
    let beams = [];
    let flash = 0;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function initParticles() {
      const count = prefersReducedMotion() ? 40 : Math.min(140, Math.floor((w * h) / 12000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random() * 1 + 0.2,
        r: Math.random() * 1.8 + 0.2,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        a: Math.random() * 0.6 + 0.15
      }));
      beams = Array.from({ length: prefersReducedMotion() ? 0 : 6 }, (_, i) => ({
        x: Math.random() * w,
        w: Math.random() * 180 + 80,
        a: Math.random() * 0.06 + 0.02,
        s: Math.random() * 0.15 + 0.05,
        o: i * 1.3
      }));
    }

    function burst() { flash = 1; }

    function draw() {
      t += 0.016;
      c.clearRect(0, 0, w, h);
      const hue = getHue();
      // ambient beams
      beams.forEach(b => {
        const x = (b.x + Math.sin(t * b.s + b.o) * 120 + w) % (w + b.w) - b.w / 2;
        const grad = c.createLinearGradient(x, 0, x + b.w, h);
        grad.addColorStop(0, `hsla(${hue},90%,60%,0)`);
        grad.addColorStop(0.5, `hsla(${hue},90%,60%,${b.a})`);
        grad.addColorStop(1, `hsla(${hue},90%,60%,0)`);
        c.fillStyle = grad;
        c.save();
        c.translate(x + b.w / 2, h / 2);
        c.rotate(-0.35);
        c.fillRect(-b.w / 2, -h, b.w, h * 2);
        c.restore();
      });
      // particles
      particles.forEach(p => {
        if (!prefersReducedMotion()) {
          p.x += p.vx * p.z; p.y += p.vy * p.z;
          if (p.x < -10) p.x = w + 10; if (p.x > w + 10) p.x = -10;
          if (p.y < -10) p.y = h + 10; if (p.y > h + 10) p.y = -10;
        }
        const tw = 0.6 + 0.4 * Math.sin(t * 2 + p.x * 0.01);
        c.beginPath();
        c.arc(p.x, p.y, p.r * p.z, 0, Math.PI * 2);
        c.fillStyle = `hsla(${hue}, 80%, ${70 + p.z * 20}%, ${p.a * tw})`;
        c.fill();
      });
      // subtle connections
      if (!prefersReducedMotion()) {
        for (let i = 0; i < particles.length; i++) {
          for (let j = i + 1; j < particles.length; j++) {
            const a = particles[i], b = particles[j];
            const dx = a.x - b.x, dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 9000) {
              c.strokeStyle = `hsla(${hue},70%,70%,${(1 - d2 / 9000) * 0.12})`;
              c.lineWidth = 0.6;
              c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
            }
          }
        }
      }
      // flash overlay
      if (flash > 0.01) {
        c.fillStyle = `hsla(${hue},100%,95%,${flash * 0.18})`;
        c.fillRect(0, 0, w, h);
        flash *= 0.88;
      }
      raf = requestAnimationFrame(draw);
    }

    function start() {
      resize(); initParticles();
      window.addEventListener('resize', () => { resize(); initParticles(); });
      raf = requestAnimationFrame(draw);
    }
    function stop() { cancelAnimationFrame(raf); }

    return { start, stop, burst, canvas };
  }

  /* -------------------- Mount -------------------- */
  function mount() {
    let seen = false;
    try { seen = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
    if (seen) return;

    const audio = createAudio();

    const wrap = document.createElement('section');
    wrap.className = 'epic-intro';
    wrap.id = 'loginIntro';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Apresentação Arquive Online');

    const reduced = prefersReducedMotion();
    wrap.innerHTML = `
      <div class="epic-bg" aria-hidden="true">
        <div class="epic-gradient"></div>
        <div class="epic-grid"></div>
        <div class="epic-vignette"></div>
        <div class="epic-noise"></div>
        <div class="epic-orb epic-orb-a"></div>
        <div class="epic-orb epic-orb-b"></div>
        <div class="epic-orb epic-orb-c"></div>
      </div>
      <header class="epic-top">
        <div class="epic-brand"><span class="epic-brand-mark"><i class="fas fa-share-nodes"></i></span><span class="epic-brand-text">ARQUIVE ONLINE</span></div>
        <div class="epic-top-actions">
          <button type="button" class="epic-btn epic-sound" data-action="sound" aria-label="Ativar som" title="Ativar som"><i class="fas fa-volume-xmark"></i><span>Som</span></button>
          <button type="button" class="epic-btn epic-skip" data-action="close"><span>Pular</span><i class="fas fa-forward-step"></i></button>
        </div>
      </header>
      <main class="epic-stage">
        <div class="epic-scenes" id="epicScenes"></div>
      </main>
      <footer class="epic-footer">
        <div class="epic-progress" id="epicProgress" aria-label="Progresso"></div>
        <div class="epic-controls">
          <div class="epic-meta"><span class="epic-tag" id="epicTag"></span><span class="epic-counter" id="epicCounter"></span></div>
          <div class="epic-nav">
            <button type="button" class="epic-icon-btn" data-action="back" aria-label="Anterior"><i class="fas fa-arrow-left"></i></button>
            <button type="button" class="epic-icon-btn" data-action="toggle" aria-label="Pausar"><i class="fas fa-pause"></i></button>
            <button type="button" class="epic-cta" data-action="next"><span>Continuar</span><i class="fas fa-arrow-right"></i></button>
          </div>
        </div>
        <div class="epic-hint" id="epicHint"><i class="fas fa-headphones"></i> Toque para ativar o som e mergulhar na experiência</div>
      </footer>
    `;

    const scenesRoot = wrap.querySelector('#epicScenes');
    const progressRoot = wrap.querySelector('#epicProgress');

    scenes.forEach((s, i) => {
      const article = document.createElement('article');
      article.className = 'epic-scene' + (i === 0 ? ' active' : '') + (s.final ? ' final' : '');
      article.dataset.index = String(i);
      article.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
      const words1 = s.title[0].split(' ').map(w => `<span class="w">${w}</span>`).join(' ');
      const words2 = s.title[1].split(' ').map(w => `<span class="w accent">${w}</span>`).join(' ');
      article.innerHTML = `
        <div class="epic-scene-inner">
          <div class="epic-kicker"><span class="epic-kicker-line"></span><span class="epic-kicker-text">${s.eyebrow}</span></div>
          <h1 class="epic-title"><span class="line">${words1}</span><span class="line">${words2}</span></h1>
          <p class="epic-copy">${s.copy}</p>
        </div>
      `;
      scenesRoot.appendChild(article);
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'epic-seg' + (i === 0 ? ' active' : '');
      seg.dataset.scene = String(i);
      seg.setAttribute('aria-label', 'Ir para etapa ' + (i + 1));
      seg.innerHTML = '<i></i>';
      progressRoot.appendChild(seg);
    });

    document.body.appendChild(wrap);

    let currentHue = scenes[0].hue;
    const fx = createCanvasFX(wrap.querySelector('.epic-bg'), () => currentHue);
    fx.start();

    const sceneEls = [...wrap.querySelectorAll('.epic-scene')];
    const segEls = [...wrap.querySelectorAll('.epic-seg')];
    const counter = wrap.querySelector('#epicCounter');
    const tagEl = wrap.querySelector('#epicTag');
    const hint = wrap.querySelector('#epicHint');
    const playBtn = wrap.querySelector('[data-action="toggle"]');
    const nextBtn = wrap.querySelector('[data-action="next"]');
    const soundBtn = wrap.querySelector('[data-action="sound"]');
    const grad = wrap.querySelector('.epic-gradient');

    let idx = 0;
    let playing = !reduced;
    let startedAt = performance.now();
    let raf = 0;
    let touchX = null;
    let interacted = false;

    function applyHue(h) {
      currentHue = h;
      wrap.style.setProperty('--h', String(h));
      if (grad) grad.style.setProperty('--h', String(h));
    }

    function syncSoundUI() {
      const on = !audio.isMuted();
      soundBtn.classList.toggle('on', on);
      soundBtn.innerHTML = on ? '<i class="fas fa-volume-high"></i><span>Som</span>' : '<i class="fas fa-volume-xmark"></i><span>Som</span>';
      soundBtn.setAttribute('aria-label', on ? 'Desativar som' : 'Ativar som');
      soundBtn.setAttribute('title', on ? 'Desativar som' : 'Ativar som');
      if (on) hint.classList.add('hidden');
    }

    function tryEnableAudioFromGesture() {
      if (interacted) return;
      interacted = true;
      audio.setMuted(false);
      syncSoundUI();
    }

    function setPlaying(v) {
      playing = v && !prefersReducedMotion() && idx < scenes.length - 1;
      playBtn.innerHTML = playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
      playBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproduzir');
      if (playing) { startedAt = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
      else cancelAnimationFrame(raf);
    }

    function renderProgress(elapsedRatio) {
      segEls.forEach((seg, i) => {
        seg.classList.toggle('active', i === idx);
        seg.classList.toggle('done', i < idx);
        const bar = seg.querySelector('i');
        if (bar) bar.style.transform = `scaleX(${i < idx ? 1 : i === idx ? Math.min(1, elapsedRatio) : 0})`;
      });
    }

    function go(next, resume) {
      const prev = idx;
      idx = Math.max(0, Math.min(scenes.length - 1, next));
      const dir = idx >= prev ? 1 : -1;
      sceneEls.forEach((el, i) => {
        const active = i === idx;
        el.classList.toggle('active', active);
        el.classList.toggle('exit-left', !active && i === prev && dir > 0);
        el.classList.toggle('exit-right', !active && i === prev && dir < 0);
        if (!active && i !== prev) { el.classList.remove('exit-left', 'exit-right'); }
        el.setAttribute('aria-hidden', active ? 'false' : 'true');
      });
      if (prev !== idx) {
        wrap.classList.remove('scene-flash');
        void wrap.offsetWidth;
        wrap.classList.add('scene-flash');
        fx.burst();
        audio.sceneChange(idx, !!scenes[idx].final);
      }
      applyHue(scenes[idx].hue);
      counter.textContent = String(idx + 1).padStart(2, '0') + ' / ' + String(scenes.length).padStart(2, '0');
      tagEl.textContent = scenes[idx].tag;
      nextBtn.innerHTML = scenes[idx].final ? '<span>Entrar</span><i class="fas fa-arrow-right"></i>' : '<span>Continuar</span><i class="fas fa-arrow-right"></i>';
      nextBtn.classList.toggle('final', !!scenes[idx].final);
      startedAt = performance.now();
      renderProgress(0);
      setPlaying(Boolean(resume) && idx < scenes.length - 1);
    }

    function tick(now) {
      if (!playing) return;
      const elapsed = Math.max(0, now - startedAt);
      const ratio = Math.min(1, elapsed / SCENE_DURATION);
      renderProgress(ratio);
      if (ratio >= 1) { go(idx + 1, true); return; }
      raf = requestAnimationFrame(tick);
    }

    function close() {
      cancelAnimationFrame(raf);
      fx.stop();
      audio.close();
      wrap.classList.add('leaving');
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
      setTimeout(() => wrap.remove(), 900);
      const username = document.getElementById('username');
      if (username) setTimeout(() => username.focus({ preventScroll: true }), 250);
    }

    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        const a = btn.dataset.action;
        if (a === 'sound') { audio.click(); const on = audio.toggle(); if (on) interacted = true; syncSoundUI(); return; }
        tryEnableAudioFromGesture();
        audio.click();
        if (a === 'close') return close();
        if (a === 'next') return scenes[idx].final ? close() : go(idx + 1, false);
        if (a === 'back') return go(idx - 1, false);
        if (a === 'toggle') return setPlaying(!playing);
      }
      const seg = e.target.closest('[data-scene]');
      if (seg) { tryEnableAudioFromGesture(); audio.click(); go(Number(seg.dataset.scene), false); }
    });

    // first interaction anywhere enables audio (gesture policy)
    const gestureUnlock = () => { tryEnableAudioFromGesture(); };
    wrap.addEventListener('pointerdown', gestureUnlock, { once: true, passive: true });
    wrap.addEventListener('keydown', gestureUnlock, { once: true });

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); scenes[idx].final ? close() : go(idx + 1, false); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1, false); }
      else if (e.key === ' ' && !e.target.closest('button,input,textarea')) { e.preventDefault(); setPlaying(!playing); }
      else if (e.key.toLowerCase() === 'm') { const on = audio.toggle(); if (on) interacted = true; syncSoundUI(); }
    });

    wrap.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
    wrap.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX; touchX = null;
      if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1), false);
    }, { passive: true });

    document.addEventListener('visibilitychange', () => { if (document.hidden && playing) setPlaying(false); });

    applyHue(scenes[0].hue);
    syncSoundUI();
    go(0, playing);
    wrap.querySelector('.epic-skip').focus({ preventScroll: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
