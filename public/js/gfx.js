// Nivel de graficos: minimal, basic, low, medium ou high.
// Detecta automaticamente a capacidade do PC e adapta os graficos.
(function () {
  'use strict';
  var KEY = 'fileshare-gfx';
  var root = document.documentElement;
  var LEVELS = ['minimal', 'basic', 'low', 'medium', 'high'];

  function normalize(value) {
    return LEVELS.indexOf(value) >= 0 ? value : 'high';
  }

  function current() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === null) return null;
      return normalize(v);
    } catch (e) { return null; }
  }

  function apply(level) {
    var gfx = normalize(level);
    root.removeAttribute('data-gfx');
    if (gfx !== 'high') root.setAttribute('data-gfx', gfx);
    document.querySelectorAll('[data-gfx-option]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.gfxOption === gfx);
      btn.setAttribute('aria-pressed', String(btn.dataset.gfxOption === gfx));
    });
    return gfx;
  }
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
    signals.batteryLevel = 1;
    signals.charging = true;
    return signals;
  }
  function runBenchmark() {
    return new Promise(function (resolve) {
      var canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      var ctx = canvas.getContext('2d');
      var frames = 0;
      var start = performance.now();
      var duration = 500;
      function frame() {
        var now = performance.now();
        if (now - start >= duration) {
          var fps = (frames / ((now - start) / 1000));
          resolve(Math.round(fps));
          return;
        }
        ctx.fillStyle = 'rgba(0,0,0,0.1)';
        ctx.fillRect(0, 0, 200, 200);
        for (var i = 0; i < 50; i++) {
          ctx.fillStyle = 'rgba(' + (Math.random() * 255 | 0) + ',' + (Math.random() * 255 | 0) + ',' + (Math.random() * 255 | 0) + ',0.5)';
          ctx.beginPath();
          ctx.arc(Math.random() * 200, Math.random() * 200, Math.random() * 10 + 2, 0, Math.PI * 2);
          ctx.fill();
        }
        frames++;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
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
  function autoDetect() {
    var saved = current();
    if (saved !== null) {
      apply(saved);
      return saved;
    }
    var signals = detectCapabilities();
    var finish = function () {
      var detected = detectRecommendedLevel(signals);
      try { localStorage.setItem('fileshare-gfx-detected', detected); } catch (e) {}
      apply(detected);
      try { localStorage.setItem(KEY, detected); } catch (e) {}
      runBenchmark().then(function (fps) {
        var adjusted = detected;
        if (fps < 15) adjusted = 'minimal';
        else if (fps < 25) {
          if (LEVELS.indexOf(adjusted) > LEVELS.indexOf('basic')) adjusted = 'basic';
        } else if (fps < 40) {
          if (LEVELS.indexOf(adjusted) > LEVELS.indexOf('low')) adjusted = 'low';
        }
        apply(adjusted);
        try { localStorage.setItem(KEY, adjusted); } catch (e) {}
      });
      return detected;
    };
    if (navigator.getBattery) {
      try {
        var p = navigator.getBattery();
        if (p && typeof p.then === 'function') {
          p.then(function (battery) {
            signals.batteryLevel = battery.level;
            signals.charging = battery.charging;
            finish();
          }).catch(function () { finish(); });
          return null;
        }
      } catch (e) {}
    }
    return finish();
  }

  window.fileShareGfx = function (level) {
    var gfx = apply(level);
    try { localStorage.setItem(KEY, gfx); } catch (e) {}
    return gfx;
  };

  window.fileShareGfxDetect = function () {
    var detected = detectRecommendedLevel();
    runBenchmark().then(function (fps) {
      var adjusted = detected;
      if (fps < 15) adjusted = 'minimal';
      else if (fps < 25) {
        if (LEVELS.indexOf(adjusted) > LEVELS.indexOf('basic')) adjusted = 'basic';
      } else if (fps < 40) {
        if (LEVELS.indexOf(adjusted) > LEVELS.indexOf('low')) adjusted = 'low';
      }
      window.fileShareGfx(adjusted);
      if (typeof window.toast === 'function') window.toast('Graficos ajustados automaticamente para: ' + adjusted);
    });
    return detected;
  };

  window.fileShareGfxInfo = function () {
    return detectCapabilities();
  };

  autoDetect();
  document.addEventListener('click', function (event) {
    var openBtn = event.target.closest && event.target.closest('#authSettingsBtn');
    if (openBtn) {
      var modal = document.getElementById('gfxModal');
      if (modal) { modal.style.display = 'flex'; modal.setAttribute('aria-hidden', 'false'); }
      return;
    }
    if (event.target.closest && event.target.closest('[data-gfx-close]')) {
      var modal2 = document.getElementById('gfxModal');
      if (modal2) { modal2.style.display = 'none'; modal2.setAttribute('aria-hidden', 'true'); }
      return;
    }
    var option = event.target.closest && event.target.closest('[data-gfx-option]');
    if (option) {
      window.fileShareGfx(option.dataset.gfxOption);
      if (typeof window.toast === 'function') window.toast('Graficos ajustados.');
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var modal = document.getElementById('gfxModal');
    if (modal && modal.style.display !== 'none') { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
  });
})();
