// Nivel de graficos: minimal, basic, low, medium e high.
// Detecção AUTOMÁTICA da capacidade do aparelho + ajuste contínuo:
//   1. Lê sinais do dispositivo (núcleos, memória, GPU, tela, rede, bateria).
//   2. Mede o FPS real da página (não um canvas sintético) depois que ela assenta.
//   3. Reajusta sozinho se o site começar a engasgar (ou se sobrar folga).
// O usuário pode fixar um nível manualmente; nesse caso a automação respeita.
(function () {
  'use strict';
  var KEY = 'fileshare-gfx';
  var MANUAL_KEY = 'fileshare-gfx-manual';
  var DETECTED_KEY = 'fileshare-gfx-detected';
  var LEVELS = ['minimal', 'basic', 'low', 'medium', 'high'];
  var root = document.documentElement;

  var currentLevel = 'high';
  var detectedLevel = 'high';
  var userManual = false;
  var adjustments = 0;
  var watchdog = 0;
  var badSamples = 0;
  var busy = false;

  function normalize(value) { return LEVELS.indexOf(value) >= 0 ? value : 'high'; }
  function levelIndex(level) { return LEVELS.indexOf(normalize(level)); }
  function clampLevel(level) { return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level))]; }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function readStored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  function paintButtons(level) {
    document.querySelectorAll('[data-gfx-option]').forEach(function (btn) {
      // No modo automático só o botão "Automático" fica destacado; o nível
      // aplicado aparece no texto de status.
      var active = userManual && btn.dataset.gfxOption === level;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-gfx-auto]').forEach(function (btn) {
      btn.classList.toggle('is-active', !userManual);
      btn.setAttribute('aria-pressed', String(!userManual));
    });
  }

  function status(message) {
    var el = document.getElementById('gfxAutoStatus');
    if (el && message) el.textContent = message;
    return message;
  }

  function apply(level) {
    var gfx = normalize(level);
    currentLevel = gfx;
    root.removeAttribute('data-gfx');
    if (gfx !== 'high') root.setAttribute('data-gfx', gfx);
    // Classe única usada por scripts de efeito (fx/cyber/bg-3d) para parar loops.
    if (levelIndex(gfx) <= levelIndex('low')) root.classList.add('gfx-lite');
    else root.classList.remove('gfx-lite');
    paintButtons(gfx);
    try { window.dispatchEvent(new CustomEvent('fileshare:gfx-change', { detail: { level: gfx, auto: !userManual } })); } catch (e) {}
    return gfx;
  }

  function commit(level) {
    var gfx = apply(level);
    store(KEY, gfx);
    return gfx;
  }

  // ------------------------------------------------------------------ sinais
  function detectCapabilities() {
    var signals = {
      cores: navigator.hardwareConcurrency || 2,
      memory: navigator.deviceMemory || 2,
      mobile: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
      touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
      reducedMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      screenWidth: window.screen ? window.screen.width : window.innerWidth,
      screenHeight: window.screen ? window.screen.height : window.innerHeight,
      pixelRatio: window.devicePixelRatio || 1,
      connection: (navigator.connection && navigator.connection.effectiveType) || '4g',
      saveData: (navigator.connection && navigator.connection.saveData) || false,
      batteryLevel: 1,
      charging: true
    };
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          signals.gpu = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
          signals.gpuVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '';
        }
        signals.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      } else {
        signals.gpu = 'none';
      }
    } catch (e) {
      signals.gpu = 'unknown';
    }
    return signals;
  }

  function detectRecommendedLevel(signals) {
    if (!signals) signals = detectCapabilities();
    var score = 0;
    if (signals.cores >= 8) score += 3;
    else if (signals.cores >= 4) score += 2;
    else if (signals.cores >= 2) score += 1;
    else score -= 1;
    if (signals.memory >= 8) score += 3;
    else if (signals.memory >= 4) score += 2;
    else if (signals.memory >= 2) score += 1;
    else score -= 1;
    if (signals.mobile) score -= 2;
    if (signals.touch) score -= 1;
    var totalPixels = signals.screenWidth * signals.screenHeight * signals.pixelRatio * signals.pixelRatio;
    if (totalPixels > 4000000) score -= 1;
    else if (totalPixels <= 2000000) score += 1;
    if (signals.reducedMotion) return 'minimal';
    if (signals.saveData) score -= 3;
    if (signals.connection === 'slow-2g' || signals.connection === '2g') score -= 2;
    else if (signals.connection === '3g') score -= 1;
    if (signals.gpu) {
      var gpuLower = String(signals.gpu).toLowerCase();
      if (gpuLower.indexOf('nvidia') >= 0 || gpuLower.indexOf('radeon') >= 0 || gpuLower.indexOf('amd') >= 0) score += 2;
      if (gpuLower.indexOf('iris') >= 0 || gpuLower.indexOf('xe') >= 0) score += 1;
      if (gpuLower.indexOf('intel') >= 0 && gpuLower.indexOf('iris') < 0 && gpuLower.indexOf('xe') < 0) score -= 1;
      if (gpuLower.indexOf('software') >= 0 || gpuLower.indexOf('llvmpipe') >= 0 || gpuLower.indexOf('swiftshader') >= 0) score -= 3;
      if (signals.gpu === 'none' || signals.gpu === 'unknown') score -= 2;
    } else {
      score -= 2;
    }
    if (signals.batteryLevel < 0.2 && !signals.charging) score -= 2;
    else if (signals.batteryLevel < 0.4 && !signals.charging) score -= 1;
    if (signals.maxTextureSize >= 16384) score += 1;
    else if (signals.maxTextureSize < 4096) score -= 1;
    if (score <= 0) return 'minimal';
    if (score <= 2) return 'basic';
    if (score <= 4) return 'low';
    if (score <= 7) return 'medium';
    return 'high';
  }

  // --------------------------------------------------------------------- FPS
  // Mede o FPS REAL da página pela mediana do intervalo entre frames.
  // A mediana ignora picos isolados de carregamento (o benchmark antigo media
  // canvas sintético durante o load e rebaixava aparelhos bons por engano).
  function sampleFps(duration) {
    return new Promise(function (resolve) {
      var ms = duration || 1200;
      if (document.hidden) { resolve(0); return; }
      var times = [];
      var last = 0;
      var start = performance.now();
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        if (times.length < 5) { resolve(0); return; }
        times.sort(function (a, b) { return a - b; });
        var median = times[Math.floor(times.length / 2)];
        resolve(median > 0 ? Math.round(1000 / median) : 0);
      }
      function frame(t) {
        if (settled) return;
        if (document.hidden) { finish(); return; }
        if (last) times.push(t - last);
        last = t;
        if (performance.now() - start >= ms) { finish(); return; }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      setTimeout(finish, ms + 700);
    });
  }

  function adjustForFps(base, fps) {
    var idx = levelIndex(base);
    if (!fps) return base;
    if (fps < 20) return clampLevel(idx - 3);
    if (fps < 30) return clampLevel(idx - 2);
    if (fps < 40) return clampLevel(idx - 1);
    return base;
  }

  // ------------------------------------------------------------------ intro
  function whenIntroDone(cb) {
    var tries = 0;
    (function check() {
      var splash = document.getElementById('splashIntro');
      if (!splash || !splash.isConnected) { cb(); return; }
      if (++tries > 40) { cb(); return; }
      setTimeout(check, 400);
    })();
  }

  function refine() {
    if (userManual) return;
    whenIntroDone(function () {
      setTimeout(function () {
        sampleFps(1400).then(function (fps) {
          if (userManual || !fps) return;
          var tuned = adjustForFps(detectedLevel, fps);
          commit(tuned);
          status('Automático · nível ' + tuned + ' · ' + fps + ' fps medidos');
        });
      }, 900);
    });
  }

  function autoDetect() {
    var signals = detectCapabilities();
    detectedLevel = detectRecommendedLevel(signals);
    store(DETECTED_KEY, detectedLevel);
    commit(detectedLevel);
    status('Automático · nível ' + detectedLevel + ' detectado');
    refine();
    startWatchdog();
    return detectedLevel;
  }

  // -------------------------------------------------------------- watchdog
  // Acompanha o desempenho real e só CORRIGE PARA BAIXO quando o site engasga.
  // Subir sozinho de novo faria o nível oscilar (sobe -> pesa -> cai -> alivia),
  // então o aumento acontece apenas se o usuário pedir "Automático" de novo.
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(function () {
      if (userManual || busy || document.hidden || adjustments > 4) return;
      busy = true;
      sampleFps(1200).then(function (fps) {
        busy = false;
        if (!fps || userManual || document.hidden) return;
        if (fps < 30) {
          badSamples++;
          // Histerese: só rebaixa após duas medições ruins seguidas.
          if (badSamples >= 2) {
            var next = adjustForFps(currentLevel, fps);
            if (next !== currentLevel) {
              commit(next);
              adjustments++;
              badSamples = 0;
              status('Automático · nível ' + next + ' · ajustado para ' + fps + ' fps');
            }
          }
        } else {
          badSamples = 0;
        }
      });
    }, 8000);
  }

  // ------------------------------------------------------------------- API
  window.fileShareGfx = function (level) {
    userManual = true;
    store(MANUAL_KEY, '1');
    var gfx = commit(level);
    status('Manual · nível ' + gfx);
    return gfx;
  };

  window.fileShareGfxAuto = function () {
    userManual = false;
    try { localStorage.removeItem(MANUAL_KEY); } catch (e) {}
    adjustments = 0;
    badSamples = 0;
    var level = autoDetect();
    if (typeof window.toast === 'function') window.toast('Gráficos automáticos: nível ' + level);
    return level;
  };

  window.fileShareGfxDetect = function () {
    return window.fileShareGfxAuto();
  };

  // Repinta o destaque dos botões (usado pelas Configurações do painel).
  window.fileShareGfxPaint = function () {
    paintButtons(currentLevel);
    return currentLevel;
  };

  window.fileShareGfxInfo = function () {    return {
      level: currentLevel,
      detected: detectedLevel,
      manual: userManual,
      signals: detectCapabilities()
    };
  };

  // ------------------------------------------------------------- inicialização
  (function boot() {
    var storedLevel = readStored(KEY);
    userManual = readStored(MANUAL_KEY) === '1';
    if (userManual && storedLevel !== null) {
      apply(normalize(storedLevel));
      status('Manual · nível ' + currentLevel);
      startWatchdog();
      return;
    }
    // Sem escolha manual: detecta a cada carregamento (o aparelho/energia mudam).
    autoDetect();
  })();

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target.closest) return;

    if (target.closest('#authSettingsBtn')) {
      var modal = document.getElementById('gfxModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        paintButtons(currentLevel);
      }
      return;
    }
    if (target.closest('[data-gfx-close]')) {
      var modal2 = document.getElementById('gfxModal');
      if (modal2) { modal2.style.display = 'none'; modal2.setAttribute('aria-hidden', 'true'); }
      return;
    }
    if (target.closest('[data-gfx-auto]')) {
      window.fileShareGfxAuto();
      return;
    }
    var option = target.closest('[data-gfx-option]');
    if (option) {
      window.fileShareGfx(option.dataset.gfxOption);
      if (typeof window.toast === 'function') window.toast('Gráficos ajustados.');
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var modal = document.getElementById('gfxModal');
    if (modal && modal.style.display !== 'none') {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    }
  });

  // Reavalia ao voltar para a aba (economiza quando a página ficou parada).
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) badSamples = 0;
  });
})();
