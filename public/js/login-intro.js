/* FileShare — premium 30s login presentation */
(function(){
'use strict';
const KEY='fileshare-login-intro-seen-v2';
function mount(){
 if(!document.body)return;
 const wrap=document.createElement('section'); wrap.className='login-intro'; wrap.id='loginIntro';
 wrap.innerHTML='<div class="login-intro-bg"></div><div class="login-intro-orb"></div><div class="login-intro-grid"></div><div class="login-intro-vignette"></div><button class="login-intro-replay" id="introReplay" type="button">REVER</button><div class="login-intro-stage">'+
 '<article class="intro-scene active"><div><div class="intro-eyebrow"><i></i> sua central de arquivos</div><div class="intro-logo">FILESHARE</div><p class="intro-copy">Compartilhe arquivos com uma experiência rápida, elegante e feita para não atrapalhar o seu fluxo.</p><div class="intro-pills"><span class="intro-pill">Salas</span><span class="intro-pill">Arquivos</span><span class="intro-pill">Chat</span></div></div></article>'+
 '<article class="intro-scene"><div><div class="intro-eyebrow"><i></i> tudo começa aqui</div><div class="intro-title">Crie uma sala.<br><span>Comece o fluxo.</span></div><p class="intro-copy">Um espaço simples para juntar arquivos, pessoas e conversas no mesmo lugar.</p></div></article>'+
 '<article class="intro-scene"><div class="intro-product"><div class="intro-windowbar"><i class="intro-dot"></i><i class="intro-dot"></i><i class="intro-dot"></i><b>FILESHARE / SALA</b></div><div class="intro-product-body"><aside class="intro-sidebar"><div class="intro-side-logo">FILESHARE</div><div class="intro-nav"><div class="sel">Visão geral</div><div>Arquivos</div><div>Chat</div></div></aside><main class="intro-main"><div class="intro-main-top"><h4>Seus arquivos</h4><span class="intro-action">+ Adicionar</span></div><div class="intro-files"><div class="intro-file-card"><i class="fas fa-file-zipper"></i><strong>projeto-final.zip</strong><small>24,8 MB · agora</small></div><div class="intro-file-card"><i class="fas fa-image"></i><strong>preview.png</strong><small>2,4 MB · agora</small></div></div><div class="intro-flow"><span class="intro-node active">ENVIAR</span><i class="intro-arrow fas fa-arrow-right"></i><span class="intro-node">SALA</span><i class="intro-arrow fas fa-arrow-right"></i><span class="intro-node">BAIXAR</span></div></main></div></div></article>'+
 '<article class="intro-scene"><div><div class="intro-eyebrow"><i></i> pensado para você</div><div class="intro-title">Menos cliques.<br><span>Mais fluxo.</span></div><p class="intro-copy">Upload, download e conversa. Tudo no mesmo espaço, com uma interface que desaparece e deixa o trabalho aparecer.</p></div></article>'+
 '<article class="intro-scene"><div><div class="intro-check"><i class="fas fa-circle-check"></i></div><div class="intro-title">Você está <span>pronto.</span></div><p class="intro-copy">Entre na sua conta e descubra o FileShare.</p></div></article>'+
 '</div><div class="intro-bottom"><button class="intro-skip" id="introSkip" type="button">PULAR</button><div class="intro-progress"><i id="introProgress"></i></div><span class="intro-time" id="introTime">30s</span></div>';
 document.body.appendChild(wrap);
 const scenes=[...wrap.querySelectorAll('.intro-scene')], progress=wrap.querySelector('#introProgress'), time=wrap.querySelector('#introTime'), skip=wrap.querySelector('#introSkip'), replay=wrap.querySelector('#introReplay');
 let raf=0,start=0,running=false;
 function hide(){running=false;cancelAnimationFrame(raf);wrap.classList.add('is-hidden');setTimeout(()=>wrap.remove(),850);try{localStorage.setItem(KEY,'1')}catch(e){}}
 function play(){if(running)return;running=true;wrap.classList.remove('is-hidden');start=performance.now();function tick(now){if(!running)return;const elapsed=now-start,p=Math.min(1,elapsed/30000),i=Math.min(scenes.length-1,Math.floor(p*scenes.length));scenes.forEach((s,n)=>s.classList.toggle('active',n===i));progress.style.width=p*100+'%';time.textContent=Math.max(0,30-Math.floor(elapsed/1000))+'s';if(p>=1){hide();return}raf=requestAnimationFrame(tick)}raf=requestAnimationFrame(tick)}
 skip.onclick=hide;replay.onclick=e=>{e.stopPropagation();play()};window.fileshareReplayIntro=play;
 let seen=false;try{seen=localStorage.getItem(KEY)==='1'}catch(e){}if(seen){wrap.classList.add('is-hidden');setTimeout(()=>wrap.remove(),850)}else if(matchMedia('(prefers-reduced-motion: reduce)').matches){hide()}else setTimeout(play,350);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();