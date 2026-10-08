/* FileShare onboarding for new accounts and the replayable dashboard tour. */
(function () {
  'use strict';

  const baseSteps = [
    { selector: '#roomsTab', icon: 'fa-door-open', title: 'Seu espaço de trabalho', text: 'Salas são espaços próprios para compartilhar arquivos e conversar sem misturar projetos.' },
    { selector: '#newRoomBtn', icon: 'fa-plus', optional: true, title: 'Crie uma sala', text: 'Dê um nome, escolha a duração e convide as pessoas que vão participar.' },
    { selector: '#roomsGrid', icon: 'fa-folder-open', title: 'Tudo organizado', text: 'Abra uma sala para enviar arquivos, acompanhar os envios e conversar com o grupo.' },
    { selector: '#collectionsTab', icon: 'fa-inbox', title: 'Peça arquivos com Coletas', text: 'Crie uma solicitação com prazo e itens. Cada pessoa recebe seu link e só consegue ver o próprio envio; você acompanha o andamento e baixa tudo em ZIP.' },
    { selector: '#libraryTab', icon: 'fa-bookmark', title: 'Seu Acervo pessoal', text: 'Guarde arquivos importantes das salas, organize em prateleiras e acrescente anotações privadas para encontrar tudo depois.' },
    { selector: '#friendsBtn', icon: 'fa-user-group', optional: true, title: 'Convide com mais rapidez', text: 'Adicione amizades à sala e selecione esses nomes diretamente ao criar uma Coleta.' },
    { selector: '.header-right', icon: 'fa-sliders', title: 'Seu perfil e preferências', text: 'Acesse configurações, altere sua senha e personalize tema, atualização e animações.' },
    { selector: '#tutorialBtn', icon: 'fa-compass', title: 'Volte quando quiser', text: 'Pronto. A bússola no topo reabre este tutorial sempre que você precisar.' }
  ];

  let overlay;
  let card;
  let active = false;
  let steps = [];
  let index = 0;
  let highlighted = null;
  let previousFocus = null;
  let resizeTimer = 0;
  let scrollTimer = 0;

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');

  function getAvailableSteps() {
    return baseSteps.filter(step => {
      const target = document.querySelector(step.selector);
      return target && (step.optional ? visible(target) : true);
    });
  }

  function ensureUI() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'fs-tour-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    card = document.createElement('section');
    card.className = 'fs-tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Tutorial do FileShare');
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML =
      '<div class="fs-tour-head"><div class="fs-tour-icon" id="tourIcon"><i></i></div><div class="fs-tour-meta"><span class="fs-tour-kicker" id="tourKicker"></span><span class="fs-tour-dots" id="tourDots"></span></div></div>' +
      '<h2 class="fs-tour-title" id="tourTitle"></h2><p class="fs-tour-text" id="tourText"></p>' +
      '<div class="fs-tour-progress" aria-hidden="true"><i id="tourBar"></i></div>' +
      '<div class="fs-tour-actions"><button class="fs-tour-skip" id="tourSkip" type="button">Pular tutorial</button><div class="fs-tour-nav"><button class="fs-tour-back" id="tourBack" type="button"><i class="fas fa-arrow-left"></i><span>Voltar</span></button><button class="fs-tour-next" id="tourNext" type="button"><span>Próximo</span><i class="fas fa-arrow-right"></i></button></div></div>';

    document.body.append(overlay, card);
    overlay.addEventListener('click', close);
    card.querySelector('#tourSkip').addEventListener('click', close);
    card.querySelector('#tourBack').addEventListener('click', () => { if (index > 0) { index--; render(); } });
    card.querySelector('#tourNext').addEventListener('click', () => { if (index >= steps.length - 1) close(); else { index++; render(); } });
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', () => {
      if (!active) return;
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => render(false), 90);
    });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (active) render(false); });
  }

  function onKeydown(event) {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (index >= steps.length - 1) close(); else { index++; render(); }
      return;
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); if (index > 0) { index--; render(); } return; }
    if (event.key === 'Tab') {
      const controls = [...card.querySelectorAll('button:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function complete() {
    fetch('/api/onboarding/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  }

  function close() {
    if (!active) return;
    active = false;
    clearTimeout(scrollTimer);
    document.body.classList.remove('fs-tour-open');
    if (highlighted) highlighted.classList.remove('fs-tour-highlight');
    highlighted = null;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    card.classList.remove('show');
    card.setAttribute('aria-hidden', 'true');
    card.inert = true;
    window.setTimeout(() => { if (!active) card.style.visibility = 'hidden'; }, 360);
    complete();
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
  }

  function positionCard(target, scrollIntoView) {
    const viewport = window.visualViewport;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    const mobile = width <= 640;
    const gutter = mobile ? 10 : 14;
    const cardWidth = Math.min(mobile ? 440 : 410, width - gutter * 2);
    card.style.width = cardWidth + 'px';
    card.style.left = gutter + 'px';
    card.style.top = '12px';
    card.style.maxHeight = Math.max(220, height - 24) + 'px';
    card.style.visibility = 'hidden';
    card.style.display = 'block';

    if (scrollIntoView && target !== document.body) {
      const rect = target.getBoundingClientRect();
      if (rect.top < 12 || rect.bottom > height - 12) {
        target.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
        clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => { if (active) positionCard(target, false); }, reduceMotion() ? 0 : 320);
      }
    }

    const rect = target === document.body ? { left: width / 2, right: width / 2, top: height / 2, bottom: height / 2, width: 0, height: 0 } : target.getBoundingClientRect();
    const cardHeight = Math.min(card.scrollHeight, height - 24);
    const gap = mobile ? 13 : 17;
    const below = height - rect.bottom - gap - 12;
    const above = rect.top - gap - 12;
    let side = 'center';
    let top = Math.max(12, (height - cardHeight) / 2);
    if (below >= cardHeight || below >= above) { top = Math.max(12, Math.min(height - cardHeight - 12, rect.bottom + gap)); side = 'bottom'; }
    else if (above > 0) { top = Math.max(12, rect.top - cardHeight - gap); side = 'top'; }
    let left = Math.max(gutter, Math.min(width - cardWidth - gutter, rect.left + rect.width / 2 - cardWidth / 2));
    if (target === document.body) left = (width - cardWidth) / 2;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.dataset.side = side;
    card.style.setProperty('--tour-arrow-x', Math.max(18, Math.min(cardWidth - 26, rect.left + rect.width / 2 - left)) + 'px');
    card.style.visibility = 'visible';
  }

  function render(allowScroll = true) {
    if (!active || !steps.length) return;
    clearTimeout(scrollTimer);
    const step = steps[index];
    const target = document.querySelector(step.selector) || document.body;
    if (highlighted) highlighted.classList.remove('fs-tour-highlight');
    highlighted = target;
    if (target !== document.body) target.classList.add('fs-tour-highlight');

    card.querySelector('#tourIcon').firstElementChild.className = 'fas ' + step.icon;
    card.querySelector('#tourKicker').textContent = 'PASSO ' + String(index + 1).padStart(2, '0') + ' / ' + String(steps.length).padStart(2, '0');
    card.querySelector('#tourTitle').textContent = step.title;
    card.querySelector('#tourText').textContent = step.text;
    card.querySelector('#tourBar').style.width = ((index + 1) / steps.length * 100) + '%';
    card.querySelector('#tourDots').innerHTML = steps.map((_, stepIndex) => '<i class="' + (stepIndex === index ? 'active' : stepIndex < index ? 'complete' : '') + '"></i>').join('');
    card.querySelector('#tourBack').disabled = index === 0;
    card.querySelector('#tourNext').innerHTML = index === steps.length - 1 ? '<span>Começar</span><i class="fas fa-arrow-right"></i>' : '<span>Próximo</span><i class="fas fa-arrow-right"></i>';
    positionCard(target, allowScroll);
    card.classList.remove('show');
    card.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => card.classList.add('show'));
  }

  function start() {
    ensureUI();
    if (active) return;
    steps = getAvailableSteps();
    if (!steps.length) return;
    previousFocus = document.activeElement;
    index = 0;
    active = true;
    card.inert = false;
    document.body.classList.add('fs-tour-open');
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    render();
    requestAnimationFrame(() => card.querySelector('#tourNext').focus({ preventScroll: true }));
  }

  function boot() {
    if (!document.body.classList.contains('app-page')) return;
    ensureUI();
    window.fileshareStartTour = start;
    const tutorialButton = document.getElementById('tutorialBtn');
    if (tutorialButton && !tutorialButton.dataset.tourBound) {
      tutorialButton.dataset.tourBound = '1';
      tutorialButton.addEventListener('click', event => { event.preventDefault(); start(); });
    }
    fetch('/api/me').then(response => response.ok ? response.json() : null).then(user => {
      if (user && Number(user.onboarding_seen) === 0) window.setTimeout(start, 900);
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
