/* FileShare — onboarding inicial
 * Mostrado automaticamente apenas para contas novas.
 * O botão de bússola permite reabrir manualmente depois.
 */
(function(){
'use strict';

const steps = [
  { sel: '.dashboard-intro', icon: 'fa-sparkles', title: 'Bem-vindo ao FileShare', text: 'Este é o seu painel. Aqui você acompanha suas salas e acessa rapidamente tudo o que precisa para compartilhar arquivos.' },
  { sel: '#newRoomBtn', icon: 'fa-plus', title: 'Crie uma sala', text: 'Comece por aqui. Crie uma sala temporária em poucos segundos e escolha por quanto tempo ela ficará disponível.' },
  { sel: '#roomsGrid', icon: 'fa-folder-open', title: 'Suas salas', text: 'As salas disponíveis aparecem nesta área. Abra uma sala para enviar arquivos, conversar e compartilhar o link público.' },
  { sel: '.header-right', icon: 'fa-user-circle', title: 'Seu perfil', text: 'Nesta área ficam seu perfil, configurações de acesso, o botão para rever este tutorial e a opção de sair.' },
  { sel: '#roomsGrid', icon: 'fa-check', title: 'Tudo pronto', text: 'Você já conhece o essencial. O tutorial automático não aparecerá novamente, mas você pode abri-lo pela bússola no topo.' }
];

let overlay, card, idx = 0, active = false, last = null, resizeTimer;

function ensureUI(){
  if(overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'fs-tour-overlay';
  overlay.setAttribute('aria-hidden','true');

  card = document.createElement('section');
  card.className = 'fs-tour-card';
  card.setAttribute('role','dialog');
  card.setAttribute('aria-modal','true');
  card.setAttribute('aria-label','Tutorial do FileShare');
  card.innerHTML =
    '<div class="fs-tour-head">' +
      '<div class="fs-tour-icon" id="tourIcon"><i></i></div>' +
      '<div class="fs-tour-meta"><span class="fs-tour-kicker" id="tourKicker"></span><span class="fs-tour-dots" id="tourDots"></span></div>' +
    '</div>' +
    '<div class="fs-tour-title" id="tourTitle"></div>' +
    '<div class="fs-tour-text" id="tourText"></div>' +
    '<div class="fs-tour-progress" aria-hidden="true"><i id="tourBar"></i></div>' +
    '<div class="fs-tour-actions">' +
      '<button class="fs-tour-skip" id="tourSkip" type="button">Pular</button>' +
      '<div class="fs-tour-nav">' +
        '<button class="fs-tour-back" id="tourBack" type="button"><i class="fas fa-arrow-left"></i><span>Voltar</span></button>' +
        '<button class="fs-tour-next" id="tourNext" type="button"><span>Próximo</span><i class="fas fa-arrow-right"></i></button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  document.body.appendChild(card);

  overlay.addEventListener('click', close);
  document.getElementById('tourSkip').addEventListener('click', close);
  document.getElementById('tourBack').addEventListener('click', () => { if(idx > 0){ idx--; render(); } });
  document.getElementById('tourNext').addEventListener('click', () => { if(idx >= steps.length - 1) close(); else { idx++; render(); } });
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => {
    if(!active) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 80);
  });
}

function onKey(e){
  if(!active) return;
  if(e.key === 'Escape') close();
  if(e.key === 'ArrowRight' || e.key === 'Enter') document.getElementById('tourNext').click();
  if(e.key === 'ArrowLeft') document.getElementById('tourBack').click();
}

function complete(){
  fetch('/api/onboarding/complete',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    keepalive:true
  }).catch(() => {});
}

function close(){
  if(!active) return;
  active = false;
  document.body.classList.remove('fs-tour-open');
  if(last) last.classList.remove('fs-tour-highlight');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden','true');
  card.classList.remove('show');
  complete();
}

function getTarget(){
  let step = steps[idx], el = document.querySelector(step.sel);
  if(!el && idx < steps.length - 1){ idx++; return getTarget(); }
  return el || document.body;
}

function render(){
  if(!active) return;
  const step = steps[idx];
  const el = getTarget();
  if(last) last.classList.remove('fs-tour-highlight');
  last = el;
  last.classList.add('fs-tour-highlight');

  const r = el.getBoundingClientRect();
  const mobile = innerWidth <= 640;
  const cardW = Math.min(390, innerWidth - (mobile ? 20 : 28));
  const cardH = mobile ? 235 : 245;
  const gap = mobile ? 12 : 18;

  /* Garante que o elemento destacado esteja visível antes de posicionar o card. */
  const visibleTop = r.top >= 0 && r.bottom <= innerHeight;
  if(!visibleTop && el !== document.body) el.scrollIntoView({behavior:'smooth', block:'center', inline:'nearest'});

  const rr = el.getBoundingClientRect();
  let top = rr.bottom + gap;
  let side = 'bottom';

  if(top + cardH > innerHeight - 12){
    top = rr.top - cardH - gap;
    side = 'top';
  }
  if(top < 12){
    top = Math.max(12, (innerHeight - cardH) / 2);
    side = 'center';
  }

  let left = rr.left;
  if(mobile) left = 10;
  else left = Math.max(14, Math.min(innerWidth - cardW - 14, left));

  card.style.width = cardW + 'px';
  card.style.left = left + 'px';
  card.style.top = top + 'px';
  card.dataset.side = side;

  document.getElementById('tourIcon').firstElementChild.className = 'fas ' + step.icon;
  document.getElementById('tourKicker').textContent = 'GUIA ' + String(idx + 1).padStart(2,'0');
  document.getElementById('tourTitle').textContent = step.title;
  document.getElementById('tourText').textContent = step.text;
  document.getElementById('tourBar').style.width = ((idx + 1) / steps.length * 100) + '%';
  document.getElementById('tourDots').innerHTML = steps.map((_, i) => '<i class="' + (i === idx ? 'active' : '') + '"></i>').join('');

  const back = document.getElementById('tourBack');
  const next = document.getElementById('tourNext');
  back.disabled = idx === 0;
  next.innerHTML = idx === steps.length - 1
    ? '<span>Concluir</span><i class="fas fa-check"></i>'
    : '<span>Próximo</span><i class="fas fa-arrow-right"></i>';

  card.classList.remove('show');
  requestAnimationFrame(() => card.classList.add('show'));
}

function start(){
  ensureUI();
  if(active) return;
  active = true;
  idx = 0;
  document.body.classList.add('fs-tour-open');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden','false');
  card.style.display = 'block';
  requestAnimationFrame(() => render());
}

function boot(){
  if(!document.body.classList.contains('app-page')) return;
  ensureUI();
  window.fileshareStartTour = start;
  const tutorialBtn = document.getElementById('tutorialBtn');
  if (tutorialBtn && !tutorialBtn.dataset.tourBound) {
    tutorialBtn.dataset.tourBound = '1';
    tutorialBtn.addEventListener('click', function(e){ e.preventDefault(); start(); });
  }

  fetch('/api/me')
    .then(r => r.ok ? r.json() : null)
    .then(user => {
      if(user && Number(user.onboarding_seen) === 0) setTimeout(start, 700);
    })
    .catch(() => {});
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();