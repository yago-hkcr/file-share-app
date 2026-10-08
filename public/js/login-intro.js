/* FileShare first-run product film: controllable, short, and reduced-motion aware. */
(function () {
  'use strict';

  // Keep the existing first-visit flag so returning users are not interrupted again.
  const STORAGE_KEY = 'fileshare-login-intro-seen-v3';
  const SCENE_DURATION = 3600;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const scenes = [
    {
      eyebrow: 'Seu espaço para compartilhar',
      title: 'Tudo que importa.<br><span>Em movimento.</span>',
      copy: 'Arquivos, pessoas e ideias conectados em um só lugar.',
      visual: '<div class="motion-hero-mark" aria-hidden="true"><span class="motion-ring ring-a"></span><span class="motion-ring ring-b"></span><span class="motion-ring ring-c"></span><span class="motion-core"><i class="fas fa-share-nodes"></i></span><span class="motion-satellite satellite-a"><i class="fas fa-file-image"></i></span><span class="motion-satellite satellite-b"><i class="fas fa-folder-open"></i></span><span class="motion-satellite satellite-c"><i class="fas fa-message"></i></span></div>'
    },
    {
      eyebrow: 'Envie sem atrito',
      title: 'Arraste. Solte.<br><span>Já chegou.</span>',
      copy: 'Envie vários arquivos de uma vez e acompanhe o progresso sem sair da sala.',
      visual: '<div class="motion-window upload-window" aria-hidden="true"><div class="motion-window-top"><span class="motion-window-dots"><i></i><i></i><i></i></span><span>ENVIO PARA A SALA</span><span class="motion-window-live"><i></i> AO VIVO</span></div><div class="motion-drop-surface"><div class="motion-upload-icon"><i class="fas fa-cloud-arrow-up"></i></div><div class="motion-drop-title">Seus arquivos estão chegando</div><div class="motion-drop-subtitle">Tudo organizado em um só lugar</div><div class="motion-file-row"><i class="fas fa-file-image"></i><span><b>ensaio-final.png</b><small>12,8 MB · imagem</small></span><span class="motion-check"><i class="fas fa-check"></i></span></div><div class="motion-progress"><i></i></div><div class="motion-file-row second"><i class="fas fa-file-pdf"></i><span><b>briefing.pdf</b><small>840 KB · documento</small></span><span class="motion-check"><i class="fas fa-check"></i></span></div></div><span class="motion-cursor"><i class="fas fa-arrow-pointer"></i><small>soltar arquivos</small></span></div>'
    },
    {
      eyebrow: 'Cada projeto tem seu lugar',
      title: 'Uma sala.<br><span>Todo mundo junto.</span>',
      copy: 'Compartilhe arquivos, converse e mantenha cada colaboração no contexto certo.',
      visual: '<div class="motion-room-stage" aria-hidden="true"><div class="motion-room-card"><div class="motion-room-head"><span class="motion-room-icon"><i class="fas fa-folder-open"></i></span><span class="motion-room-label">SALA PRIVADA</span><span class="motion-room-live"><i></i> 3 online</span></div><div class="motion-room-name">Projeto Aurora</div><div class="motion-room-meta">Arquivos e conversa, no mesmo espaço.</div><div class="motion-room-files"><span><i class="fas fa-file-zipper"></i><b>materiais.zip</b><small>24,8 MB</small></span><span><i class="fas fa-image"></i><b>referencia.png</b><small>2,4 MB</small></span></div><div class="motion-room-people"><span class="motion-avatar avatar-one">Y</span><span class="motion-avatar avatar-two">M</span><span class="motion-avatar avatar-three">L</span><span>Compartilhando agora</span></div></div><span class="motion-floating-tag tag-top"><i class="fas fa-lock"></i> Só para convidados</span><span class="motion-floating-tag tag-bottom"><i class="fas fa-message"></i> Uma conversa mais clara</span></div>'
    },
    {
      eyebrow: 'Peça arquivos sem criar contas',
      title: 'Peça. Receba.<br><span>Resolvido.</span>',
      copy: 'Com Coletas, envie links de envio, acompanhe quem concluiu e baixe tudo organizado.',
      visual: '<div class="motion-collection" aria-hidden="true"><div class="motion-collection-heading"><span class="motion-collection-icon"><i class="fas fa-inbox"></i></span><span><b>Coleta de documentos</b><small>Prazo · sexta, 18h</small></span><span class="motion-count">2/3</span></div><div class="motion-collection-line"><span class="motion-person person-a">A</span><b>Ana</b><small>Enviou 4 arquivos</small><i class="fas fa-circle-check"></i></div><div class="motion-collection-line"><span class="motion-person person-b">R</span><b>Rafa</b><small>Enviou 2 arquivos</small><i class="fas fa-circle-check"></i></div><div class="motion-collection-line waiting"><span class="motion-person person-c">+</span><b>Mais uma pessoa</b><small>Link individual</small><i class="fas fa-arrow-right"></i></div><div class="motion-collection-footer"><i class="fas fa-folder-tree"></i> Arquivos separados por pessoa <span>Baixar ZIP <i class="fas fa-arrow-down"></i></span></div></div>'
    },
    {
      eyebrow: 'Pronto para começar?',
      title: 'Seu próximo fluxo<br><span>começa aqui.</span>',
      copy: 'Entre na sua conta e transforme o próximo envio em algo simples.',
      visual: '<div class="motion-finish" aria-hidden="true"><span class="finish-orbit orbit-one"></span><span class="finish-orbit orbit-two"></span><span class="finish-orbit orbit-three"></span><span class="finish-check"><i class="fas fa-check"></i></span><span class="finish-spark spark-one">✦</span><span class="finish-spark spark-two">✧</span><span class="finish-spark spark-three">✦</span></div>'
    }
  ];

  function mount() {
    let seen = false;
    try { seen = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
    if (seen) return;

    const wrap = document.createElement('section');
    wrap.className = 'login-intro';
    wrap.id = 'loginIntro';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Conheça o FileShare');
    wrap.innerHTML =
      '<div class="intro-atmosphere" aria-hidden="true"><span class="atmosphere-glow glow-a"></span><span class="atmosphere-glow glow-b"></span><span class="atmosphere-grid"></span><span class="atmosphere-grain"></span></div>' +
      '<button class="intro-skip" type="button" data-intro-action="close">Pular apresentação <i class="fas fa-forward-step"></i></button>' +
      '<div class="login-intro-stage"><div class="intro-topline"><span class="intro-brand-lockup"><i class="fas fa-share-nodes"></i><b>FILESHARE</b></span><span class="intro-chapter" id="introChapter"></span></div>' +
      '<div class="intro-scenes" id="introScenes"></div>' +
      '<div class="intro-controls"><div class="intro-progress" id="introProgress" aria-label="Progresso da apresentação"></div><div class="intro-control-row"><span class="intro-hint" id="introHint"><i class="fas fa-sparkles"></i> Um tour rápido pelo seu novo espaço</span><div class="intro-nav"><button class="intro-control intro-play" type="button" data-intro-action="toggle" aria-label="Pausar apresentação"><i class="fas fa-pause"></i></button><button class="intro-control intro-back" type="button" data-intro-action="back" aria-label="Cena anterior"><i class="fas fa-arrow-left"></i></button><button class="intro-next" type="button" data-intro-action="next"><span>Próximo</span><i class="fas fa-arrow-right"></i></button></div></div></div></div>';

    const sceneRoot = wrap.querySelector('#introScenes');
    const progress = wrap.querySelector('#introProgress');
    scenes.forEach((scene, index) => {
      const article = document.createElement('article');
      article.className = 'intro-scene' + (index === 0 ? ' active' : '');
      article.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
      article.setAttribute('aria-label', 'Etapa ' + (index + 1) + ' de ' + scenes.length);
      article.innerHTML = '<div class="intro-copy-column"><div class="intro-eyebrow"><i></i>' + scene.eyebrow + '</div><h1 class="intro-title">' + scene.title + '</h1><p class="intro-copy">' + scene.copy + '</p></div><div class="intro-visual">' + scene.visual + '</div>';
      sceneRoot.appendChild(article);
      const segment = document.createElement('button');
      segment.type = 'button';
      segment.className = 'intro-segment' + (index === 0 ? ' active' : '');
      segment.setAttribute('aria-label', 'Ir para a etapa ' + (index + 1));
      segment.dataset.introScene = String(index);
      segment.innerHTML = '<span></span>';
      progress.appendChild(segment);
    });

    document.body.appendChild(wrap);

    const sceneEls = [...wrap.querySelectorAll('.intro-scene')];
    const segments = [...wrap.querySelectorAll('.intro-segment')];
    const chapter = wrap.querySelector('#introChapter');
    const hint = wrap.querySelector('#introHint');
    const playButton = wrap.querySelector('[data-intro-action="toggle"]');
    const nextButton = wrap.querySelector('[data-intro-action="next"]');
    let index = 0;
    let playing = !prefersReducedMotion.matches;
    let sceneStartedAt = performance.now();
    let frame = 0;
    let touchX = null;

    const setPlaying = value => {
      playing = value && !prefersReducedMotion.matches && index < scenes.length - 1;
      playButton.innerHTML = playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
      playButton.setAttribute('aria-label', playing ? 'Pausar apresentação' : 'Reproduzir apresentação');
      hint.innerHTML = playing ? '<i class="fas fa-sparkles"></i> Um tour rápido pelo seu novo espaço' : '<i class="fas fa-hand-pointer"></i> Explore no seu ritmo';
      if (playing) {
        sceneStartedAt = performance.now();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(frame);
      }
    };

    function setScene(nextIndex, resume = playing) {
      index = Math.max(0, Math.min(scenes.length - 1, nextIndex));
      sceneEls.forEach((scene, sceneIndex) => {
        const active = sceneIndex === index;
        scene.classList.toggle('active', active);
        scene.setAttribute('aria-hidden', active ? 'false' : 'true');
      });
      segments.forEach((segment, sceneIndex) => {
        segment.classList.toggle('active', sceneIndex === index);
        segment.classList.toggle('complete', sceneIndex < index);
        segment.querySelector('span').style.transform = 'scaleX(' + (sceneIndex < index ? 1 : 0) + ')';
      });
      chapter.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(scenes.length).padStart(2, '0');
      nextButton.innerHTML = index === scenes.length - 1 ? '<span>Entrar no FileShare</span><i class="fas fa-arrow-right"></i>' : '<span>Próximo</span><i class="fas fa-arrow-right"></i>';
      nextButton.classList.toggle('intro-enter', index === scenes.length - 1);
      sceneStartedAt = performance.now();
      setPlaying(Boolean(resume) && index < scenes.length - 1);
    }

    function tick(now) {
      if (!playing) return;
      const elapsed = Math.max(0, now - sceneStartedAt);
      const currentProgress = Math.min(1, elapsed / SCENE_DURATION);
      segments[index].querySelector('span').style.transform = 'scaleX(' + currentProgress + ')';
      if (currentProgress >= 1) {
        setScene(index + 1, true);
        return;
      }
      frame = requestAnimationFrame(tick);
    }

    function close() {
      cancelAnimationFrame(frame);
      wrap.classList.add('is-hidden');
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
      window.setTimeout(() => wrap.remove(), 650);
      const username = document.getElementById('username');
      if (username) window.setTimeout(() => username.focus({ preventScroll: true }), 180);
    }

    wrap.addEventListener('click', event => {
      const action = event.target.closest('[data-intro-action]');
      if (action) {
        const type = action.dataset.introAction;
        if (type === 'close') close();
        if (type === 'next') index === scenes.length - 1 ? close() : setScene(index + 1, false);
        if (type === 'back') setScene(index - 1, false);
        if (type === 'toggle') setPlaying(!playing);
        return;
      }
      const segment = event.target.closest('[data-intro-scene]');
      if (segment) setScene(Number(segment.dataset.introScene), false);
    });

    wrap.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowRight' && !event.target.closest('button')) { event.preventDefault(); index === scenes.length - 1 ? close() : setScene(index + 1, false); }
      else if (event.key === 'ArrowLeft' && !event.target.closest('button')) { event.preventDefault(); setScene(index - 1, false); }
      else if (event.key === ' ' && !event.target.closest('button')) { event.preventDefault(); setPlaying(!playing); }
    });
    wrap.addEventListener('touchstart', event => { touchX = event.changedTouches[0].clientX; }, { passive: true });
    wrap.addEventListener('touchend', event => {
      if (touchX === null) return;
      const delta = event.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(delta) < 55) return;
      setScene(index + (delta < 0 ? 1 : -1), false);
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && playing) setPlaying(false);
    });

    setScene(0, playing);
    wrap.querySelector('.intro-skip').focus({ preventScroll: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
