/* FileShare first-run product film: controllable, short, and reduced-motion aware. */
(function () {
  'use strict';

  // Keep the existing first-visit flag so returning users are not interrupted again.
  const STORAGE_KEY = 'fileshare-login-intro-seen-v3';
  const SCENE_DURATION = 3600;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const scenes = [
    {
      eyebrow: 'Seu espa√ßo para compartilhar',
      title: 'Tudo que importa.<br><span>Em movimento.</span>',
      copy: 'Arquivos, pessoas e ideias conectados em um s√≥ lugar.',
      visual: '<div class="motion-hero-mark" aria-hidden="true"><span class="motion-ring ring-a"></span><span class="motion-ring ring-b"></span><span class="motion-ring ring-c"></span><span class="motion-core"><i class="fas fa-share-nodes"></i></span><span class="motion-satellite satellite-a"><i class="fas fa-file-image"></i></span><span class="motion-satellite satellite-b"><i class="fas fa-folder-open"></i></span><span class="motion-satellite satellite-c"><i class="fas fa-message"></i></span></div>'
    },
    {
      eyebrow: 'Envie sem atrito',
      title: 'Arraste. Solte.<br><span>J√° chegou.</span>',
      copy: 'Envie v√°rios arquivos de uma vez e acompanhe o progresso sem sair da sala.',
      visual: '<div class="motion-window upload-window" aria-hidden="true"><div class="motion-window-top"><span class="motion-window-dots"><i></i><i></i><i></i></span><span>ENVIO PARA A SALA</span><span class="∂ªßq´^