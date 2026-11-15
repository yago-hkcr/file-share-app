/* Arquive Online — cinemática de boas-vindas.
   Primeira visita: apresenta o produto em 5 cenas com trilha sintetizada no
   navegador (WebAudio). Nenhum áudio para baixar, nada de terceiros.
   Depois da primeira vez, o site abre direto no login. */
(function () {
  'use strict';

  var SEEN_KEY = 'arquive_intro_v1';
  // Chaves gravadas só por ação consciente do usuário. Servem para reconhecer
  // quem já usa o site (e não deve ver a apresentação de novo), sem confundir
  // com as chaves automáticas de desempenho.
  var RETURNING_KEYS = ['fileshare-theme', 'fileshare-gfx-manual', 'fileshare-dashboard-compact', 'fileshare-dashboard-tab'];

  var reduceMotion = function () {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  function readFlag() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
  }
  function looksReturning() {
    try {
      for (var i = 0; i < RETURNING_KEYS.length; i++) {
        if (localStorage.getItem(RETURNING_KEYS[i]) !== null) return true;
      }
    } catch (e) {}
    return false;
  }
  function hasSeen() {
    if (readFlag()) return true;
    if (looksReturning()) { markSeen(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- áudio
  function createSoundtrack() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    var ctx;
    try { ctx = new Ctx(); } catch (e) { return null; }
    var master = ctx.createGain();
    master.gain.value = 0;
    // Filtro suave + cauda curta dão o ar "trilha de cinema" sem reverb externo.
    var tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 5200;
    var delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.26;
    var feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    var wet = ctx.createGain();
    wet.gain.value = 0.32;
    tone.connect(master);
    tone.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(master);
    master.connect(ctx.destination);

    var noise = (function () {
      var buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return buffer;
    })();

    var stopped = false;
    var nodes = [];

    function track(node) { nodes.push(node); return node; }

    function envelope(gain, at, attack, hold, release, peak) {
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + attack);
      gain.gain.setValueAtTime(peak, at + attack + hold);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
    }

    function whoosh(at, duration, from, to, peak) {
      var source = ctx.createBufferSource();
      source.buffer = noise;
      var band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 1.1;
      band.frequency.setValueAtTime(from, at);
      band.frequency.exponentialRampToValueAtTime(to, at + duration);
      var gain = ctx.createGain();
      envelope(gain, at, duration * 0.45, 0, duration * 0.6, peak || 0.28);
      source.connect(band); band.connect(gain); gain.connect(tone);
      source.start(at); source.stop(at + duration + 0.1);
      track(source);
    }

    function impact(at) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, at);
      osc.frequency.exponentialRampToValueAtTime(42, at + 0.5);
      var gain = ctx.createGain();
      envelope(gain, at, 0.012, 0.06, 0.42, 0.5);
      osc.connect(gain); gain.connect(master);
      osc.start(at); osc.stop(at + 0.6);
      track(osc);
      whoosh(at, 0.32, 1800, 220, 0.2);
    }

    function chord(at, freqs, duration, peak) {
      freqs.forEach(function (freq, index) {
        var osc = ctx.createOscillator();
        osc.type = index % 2 ? 'triangle' : 'sine';
        osc.frequency.value = freq;
        osc.detune.value = (index - 1) * 4;
        var gain = ctx.createGain();
        envelope(gain, at, 0.16, duration * 0.5, duration * 0.7, (peak || 0.13) / (1 + index * 0.35));
        osc.connect(gain); gain.connect(tone);
        osc.start(at); osc.stop(at + duration + 1);
        track(osc);
      });
    }

    function blip(at, freq, peak) {
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, at);
      var gain = ctx.createGain();
      envelope(gain, at, 0.006, 0.012, 0.1, peak || 0.1);
      osc.connect(gain); gain.connect(tone);
      osc.start(at); osc.stop(at + 0.16);
      track(osc);
    }

    function riser(at, duration) {
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(90, at);
      osc.frequency.exponentialRampToValueAtTime(880, at + duration);
      var low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.setValueAtTime(320, at);
      low.frequency.exponentialRampToValueAtTime(4200, at + duration);
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + duration * 0.92);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(low); low.connect(gain); gain.connect(tone);
      osc.start(at); osc.stop(at + duration + 0.05);
      track(osc);
    }

    var pad = null;
    function startPad(at) {
      pad = ctx.createGain();
      pad.gain.value = 0.0001;
      pad.gain.exponentialRampToValueAtTime(0.055, at + 2);
      var filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 180;
      lfo.connect(lfoGain); lfoGain.connect(filter.frequency);
      [55, 55.6, 82.4].forEach(function (freq) {
        var osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        osc.connect(filter);
        osc.start(at); osc.stop(at + 90);
        track(osc);
      });
      lfo.start(at); lfo.stop(at + 90);
      filter.connect(pad); pad.connect(master);
      track(lfo);
    }

    return {
      context: ctx,
      start: function () {
        try { ctx.resume(); } catch (e) {}
        master.gain.setValueAtTime(0.0001, ctx.currentTime);
        master.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.9);
      },
      mute: function () {
        try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15); } catch (e) {}
      },
      unmute: function () {
        try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.2); } catch (e) {}
      },
      suspend: function () { try { ctx.suspend(); } catch (e) {} },
      resume: function () { try { ctx.resume(); } catch (e) {} },
      pad: startPad,
      whoosh: whoosh,
      impact: impact,
      chord: chord,
      blip: blip,
      riser: riser,
      stop: function () {
        if (stopped) return;
        stopped = true;
        try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.12); } catch (e) {}
        setTimeout(function () {
          nodes.forEach(function (node) { try { node.stop(0); } catch (e) {} });
          try { if (pad) pad.disconnect(); } catch (e) {}
          try { ctx.close(); } catch (e) {}
        }, 420);
      }
    };
  }

  // ---------------------------------------------------------------- cenas
  var SCENES = [
    {
      kicker: 'ENVIO',
      title: [{ text: 'Arquivos' }, { text: 'grandes,' }, { text: 'sem', accent: true }, { text: 'limite.' }],
      text: 'Mande o arquivo inteiro, do tamanho que for. O envio é resumível: se a conexão cair, ele continua de onde parou.',
      visual:
        '<div class="v-upload">' +
          '<div class="v-file"><i class="fas fa-file-zipper"></i><span><b>projeto-final.zip</b><small>4,7 GB · envio direto</small></span></div>' +
          '<div class="v-bar"><i></i></div>' +
          '<div class="v-meta"><span>transferindo</span><b class="v-pct">0%</b></div>' +
        '</div>'
    },
    {
      kicker: 'SALAS',
      title: [{ text: 'Salas' }, { text: 'privadas' }, { text: 'por', }, { text: 'assunto.' }],
      text: 'Cada projeto no seu espaço. Só entra quem você convida, com arquivos e conversa no mesmo lugar.',
      visual:
        '<div class="v-rooms">' +
          '<svg class="v-link" viewBox="0 0 100 100" aria-hidden="true"><line x1="50" y1="50" x2="50" y2="12"/><line x1="50" y1="50" x2="20" y2="84"/><line x1="50" y1="50" x2="80" y2="84"/></svg>' +
          '<div class="v-hub"><i class="fas fa-folder-open"></i><small>EQUIPE</small></div>' +
          '<div class="v-peer" data-pos="0" style="--i:0"><i class="fas fa-user"></i></div>' +
          '<div class="v-peer" data-pos="1" style="--i:1"><i class="fas fa-user"></i></div>' +
          '<div class="v-peer" data-pos="2" style="--i:2"><i class="fas fa-user"></i></div>' +
        '</div>'
    },
    {
      kicker: 'COLETAS',
      title: [{ text: 'Peça' }, { text: 'arquivos' }, { text: 'sem' }, { text: 'dar', accent: true }, { text: 'acesso.' }],
      text: 'Envie um link com prazo. A pessoa manda o que você pediu e não vê nada além do próprio envio.',
      visual:
        '<div class="v-collect">' +
          '<div class="v-chip"><i class="fas fa-link"></i><span class="v-chip-text">arquive.online/enviar/design-2026</span></div>' +
          '<div class="v-flow"><span><i class="fas fa-caret-right"></i></span><span><i class="fas fa-caret-right"></i></span><span><i class="fas fa-caret-right"></i></span></div>' +
          '<div class="v-drop"><i class="fas fa-file-image" style="--i:0"></i><i class="fas fa-file-pdf" style="--i:1"></i><i class="fas fa-file-video" style="--i:2"></i></div>' +
          '<div class="v-lock"><i class="fas fa-lock"></i> cada um vê só o seu</div>' +
        '</div>'
    },
    {
      kicker: 'ACERVO',
      title: [{ text: 'Tudo' }, { text: 'guardado' }, { text: 'no', accent: true }, { text: 'seu', accent: true }, { text: 'espaço.' }],
      text: 'Salve arquivos das salas no seu Acervo pessoal, com anotações, e encontre depois em segundos.',
      visual:
        '<div class="v-shelf">' +
          '<div class="v-tile" style="--i:0"><i class="fas fa-file-lines"></i></div>' +
          '<div class="v-tile" style="--i:1"><i class="fas fa-image"></i></div>' +
          '<div class="v-tile" style="--i:2"><i class="fas fa-file-zipper"></i></div>' +
          '<div class="v-tile" style="--i:3"><i class="fas fa-music"></i></div>' +
          '<div class="v-tile" style="--i:4"><i class="fas fa-video"></i></div>' +
          '<div class="v-tile" style="--i:5"><i class="fas fa-folder"></i></div>' +
        '</div>'
    },
    {
      kicker: 'COMECE',
      title: [{ text: 'Pronto.' }, { text: 'Seu' }, { text: 'espaço', accent: true }, { text: 'está', accent: true }, { text: 'aberto.' }],
      text: 'Compartilhe sem fronteiras. Entre ou crie sua conta — leva menos de um minuto.',
      visual:
        '<div class="v-brand">' +
          '<div class="v-mark"><i class="fas fa-share-nodes"></i></div>' +
          '<div class="v-word">ARQUIVE ONLINE<small>SEU ESPAÇO · SUAS CONEXÕES</small></div>' +
        '</div>'
    }
  ];

  var SCENE_MS = 4300;

  var state = { playing: false, timers: [], sound: null, muted: false, overlay: null, gate: null, onDone: null };

  function clearTimers() {
    state.timers.forEach(function (id) { clearTimeout(id); });
    state.timers = [];
  }
  function later(fn, ms) { state.timers.push(setTimeout(fn, ms)); }

  function titleHTML(words) {
    return words.map(function (word, index) {
      var inner = word.accent ? '<em>' + word.text + '</em>' : word.text;
      return '<span style="--i:' + index + '">' + inner + '</span>';
    }).join(' ');
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'cineIntro';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Apresentação do Arquive Online');
    var scenes = SCENES.map(function (scene, index) {
      return '<section class="cine-scene" data-scene="' + index + '">' +
        '<div class="cine-copy">' +
          '<span class="cine-kicker"><b>' + String(index + 1).padStart(2, '0') + '</b> ' + scene.kicker + '</span>' +
          '<h2 class="cine-title">' + titleHTML(scene.title) + '</h2>' +
          '<p class="cine-text">' + scene.text + '</p>' +
        '</div>' +
        '<div class="cine-visual">' + scene.visual + '</div>' +
      '</section>';
    }).join('');
    overlay.innerHTML =
      '<div class="cine-bg" aria-hidden="true"></div>' +
      '<div class="cine-scan" aria-hidden="true"></div>' +
      '<header class="cine-bar">' +
        '<span class="cine-brand"><i class="fas fa-share-nodes"></i> Arquive Online</span>' +
        '<div class="cine-track"><i></i></div>' +
        '<span class="cine-chapters">01 / 0' + SCENES.length + '</span>' +
        '<button class="cine-btn" type="button" data-cine-sound><i class="fas fa-volume-high"></i><span>Som</span></button>' +
        '<button class="cine-btn" type="button" data-cine-skip>Pular</button>' +
      '</header>' +
      '<main class="cine-stage">' + scenes + '</main>' +
      '<footer class="cine-foot-note">Toque em <b>Pular</b> a qualquer momento · sem áudio de terceiros</footer>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function showScene(overlay, index) {
    overlay.querySelectorAll('.cine-scene').forEach(function (node) {
      var i = Number(node.dataset.scene);
      node.classList.toggle('is-active', i === index);
      node.classList.toggle('is-past', i < index);
    });
    overlay.dataset.scene = String(index);
    var bar = overlay.querySelector('.cine-track i');
    if (bar) bar.style.width = ((index + 1) / SCENES.length * 100) + '%';
    var chapters = overlay.querySelector('.cine-chapters');
    if (chapters) chapters.textContent = String(index + 1).padStart(2, '0') + ' / 0' + SCENES.length;
    if (index === 0) countProgress(overlay);
  }

  // Contador do "envio" na primeira cena, alinhado com a barra.
  function countProgress(overlay) {
    var label = overlay.querySelector('.v-pct');
    if (!label) return;
    var started = performance.now();
    var tick = function (now) {
      if (!state.playing || !label.isConnected) return;
      var pct = Math.min(100, Math.round((now - started) / (SCENE_MS * 0.96) * 100));
      label.textContent = pct + '%';
      if (pct < 100) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function scheduleAudio(sound) {
    if (!sound) return;
    var ctx = sound.context;
    var t0 = ctx.currentTime + 0.15;
    sound.start();
    sound.pad(t0);
    sound.riser(t0, 1.4);
    sound.impact(t0 + 1.4);
    // Cena 1: cliques de progresso subindo.
    [3.0, 3.25, 3.5, 3.75, 4.0].forEach(function (offset, index) {
      sound.blip(t0 + offset, 420 + index * 70, 0.075);
    });
    sound.whoosh(t0 + SCENE_MS / 1000 - 0.35, 0.5, 320, 2600, 0.22);
    // Cena 2: acorde + chegada de cada participante.
    var s2 = t0 + SCENE_MS / 1000;
    sound.chord(s2 + 0.1, [220, 277.2, 329.6], 1.6, 0.12);
    [0.6, 0.76, 0.92].forEach(function (offset, index) { sound.blip(s2 + offset, 660 + index * 110, 0.09); });
    // Cena 3: link enviado, arquivos chegando.
    var s3 = t0 + (SCENE_MS * 2) / 1000;
    sound.whoosh(s3 + 0.05, 0.45, 900, 300, 0.16);
    [1.0, 1.18, 1.36].forEach(function (offset, index) { sound.blip(s3 + offset, 520 + index * 90, 0.08); });
    sound.chord(s3 + 0.2, [174.6, 220, 261.6], 1.4, 0.1);
    // Cena 4: arquivos se organizando.
    var s4 = t0 + (SCENE_MS * 3) / 1000;
    for (var i = 0; i < 6; i++) sound.blip(s4 + 0.35 + i * 0.11, 380 + (i % 3) * 120, 0.06);
    sound.chord(s4 + 0.15, [196, 246.9, 293.7], 1.5, 0.1);
    // Cena 5: impacto final + acorde de resolução.
    var s5 = t0 + (SCENE_MS * 4) / 1000;
    sound.impact(s5);
    sound.chord(s5 + 0.12, [220, 277.2, 329.6, 440], 2.4, 0.14);
    sound.whoosh(s5 + 2.2, 0.7, 1200, 200, 0.12);
  }

  function finish(options) {
    if (!state.playing) return;
    state.playing = false;
    clearTimers();
    markSeen();
    var overlay = state.overlay;
    var sound = state.sound;
    state.sound = null;
    if (sound) sound.stop();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('visibilitychange', onVisibility);
    if (overlay) {
      overlay.classList.add('leaving');
      setTimeout(function () { try { overlay.remove(); } catch (e) {} }, 500);
    }
    state.overlay = null;
    try { document.body.style.overflow = state.previousOverflow || ''; } catch (e) {}
    var done = state.onDone;
    var skipped = !!(options && options.skipped);
    state.onDone = null;
    if (done) { try { done({ skipped: skipped }); } catch (e) {} }
  }

  function onKeydown(event) {
    if (!state.playing) return;
    if (event.key === 'Escape') { event.preventDefault(); finish({ skipped: true }); }
  }
  function onVisibility() {
    if (!state.sound) return;
    if (document.hidden) state.sound.suspend(); else state.sound.resume();
  }

  function play(options) {
    options = options || {};
    if (state.playing || reduceMotion()) {
      markSeen();
      if (options.onDone) options.onDone({ skipped: true });
      return;
    }
    state.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    var overlay = buildOverlay();
    state.overlay = overlay;
    var sound = null;
    if (options.withSound) {
      sound = createSoundtrack();
      state.sound = sound;
      state.muted = !sound;
    } else {
      state.muted = true;
    }
    if (!sound) {
      var soundBtn = overlay.querySelector('[data-cine-sound]');
      if (soundBtn) soundBtn.hidden = true;
    }
    state.playing = true;
    state.onDone = options.onDone || null;
    overlay.querySelector('[data-cine-skip]').addEventListener('click', function () { finish({ skipped: true }); });
    var soundBtn = overlay.querySelector('[data-cine-sound]');
    if (soundBtn) {
      var paintSound = function () {
        soundBtn.innerHTML = state.muted
          ? '<i class="fas fa-volume-xmark"></i><span>Sem som</span>'
          : '<i class="fas fa-volume-high"></i><span>Som</span>';
        soundBtn.setAttribute('aria-pressed', String(!state.muted));
      };
      paintSound();
      soundBtn.addEventListener('click', function () {
        if (!state.sound) return;
        state.muted = !state.muted;
        if (state.muted) state.sound.mute(); else state.sound.unmute();
        paintSound();
      });
    }
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('visibilitychange', onVisibility);
    requestAnimationFrame(function () { overlay.classList.add('show'); });

    scheduleAudio(sound);
    SCENES.forEach(function (_, index) {
      later(function () {
        if (!state.playing) return;
        if (index === SCENES.length - 1) return;
        showScene(overlay, index + 1);
      }, SCENE_MS * index + SCENE_MS * 0.98);
    });
    later(function () { finish({ skipped: false }); }, SCENE_MS * SCENES.length + 300);
    showScene(overlay, 0);
  }

  // Porta de entrada: o áudio precisa de um toque do usuário para tocar.
  function welcome(options) {
    options = options || {};
    if (reduceMotion()) { markSeen(); if (options.onDone) options.onDone({ skipped: true }); return; }
    // Marca já na abertura: se a pessoa fechar a aba nesse ponto, a próxima
    // visita vai direto ao login (o link "Ver como funciona" reabre depois).
    markSeen();
    var gate = document.createElement('div');
    gate.className = 'cine-gate';
    gate.innerHTML =
      '<div class="cine-gate-card" role="dialog" aria-modal="true" aria-labelledby="cineGateTitle">' +
        '<span class="cine-kicker">bem-vindo</span>' +
        '<h2 id="cineGateTitle">Como o Arquive Online funciona</h2>' +
        '<p>Cinco cenas, vinte segundos. Dá para pular quando quiser.</p>' +
        '<div class="cine-gate-actions">' +
          '<button class="cine-start" type="button" data-cine-start="sound"><i class="fas fa-play"></i> Assistir com som</button>' +
          '<button class="cine-quiet" type="button" data-cine-start="mute">Ver sem som</button>' +
          '<button class="cine-quiet" type="button" data-cine-skip>Pular apresentação</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(gate);
    state.gate = gate;
    requestAnimationFrame(function () { gate.classList.add('show'); });
    document.body.style.overflow = 'hidden';

    function closeGate() {
      document.removeEventListener('keydown', onGateKey, true);
      gate.classList.add('leaving');
      setTimeout(function () { try { gate.remove(); } catch (e) {} }, 380);
      state.gate = null;
      document.body.style.overflow = '';
    }
    function skip() {
      closeGate();
      markSeen();
      if (options.onDone) options.onDone({ skipped: true });
    }
    function onGateKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); skip(); }
    }
    document.addEventListener('keydown', onGateKey, true);
    gate.querySelectorAll('[data-cine-start]').forEach(function (button) {
      button.addEventListener('click', function () {
        var withSound = button.dataset.cineStart === 'sound';
        closeGate();
        play({ withSound: withSound, onDone: options.onDone });
      });
    });
    gate.querySelector('[data-cine-skip]').addEventListener('click', skip);
    gate.querySelector('.cine-start').focus({ preventScroll: true });
  }

  window.ArquiveIntroCinema = {
    hasSeen: hasSeen,
    markSeen: markSeen,
    welcome: welcome,
    play: play,
    // Só para testes/depuração: volta a apresentação na próxima abertura.
    reset: function () { try { localStorage.removeItem(SEEN_KEY); } catch (e) {} }
  };
})();
