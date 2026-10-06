/* FileShare — login cinematic intro, ~30s */
(function(){
  'use strict';
  var KEY='fileshare-login-intro-seen-v1', reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function mount(){
    var body=document.body;
    var wrap=document.createElement('section'); wrap.className='login-intro'; wrap.id='loginIntro';
    wrap.setAttribute('aria-label','Apresentação do FileShare');
    wrap.innerHTML='<div class="login-intro-bg"></div><div class="login-intro-grid"></div><div class="login-intro-noise"></div>'+
      '<button class="login-intro-replay" type="button" id="introReplay">REVER APRESENTAÇÃO</button>'+
      '<div class="login-intro-stage">'+
      '<article class="intro-scene active"><div><div class="intro-kicker">01 / FILESHARE</div><div class="intro-logo">FILESHARE</div><p class="intro-sub">Seus arquivos. Suas salas. Tudo conectado em um só lugar.</p></div></article>'+
      '<article class="intro-scene"><div><div class="intro-kicker">02 / COMPARTILHE</div><div class="intro-word">ENVIE.<br><span>ORGANIZE.</span></div><p class="intro-sub">Crie uma sala, arraste seus arquivos e compartilhe com quem precisa.</p></div></article>'+
      '<article class="intro-scene"><div class="intro-demo"><div class="intro-demo-bar"><i></i><i></i><i></i></div><div class="intro-demo-row"><div class="intro-demo-card"><strong><i class="fas fa-folder-open"></i> SALA</strong><div class="intro-file"><i class="fas fa-file"></i><span><b>projeto-final.zip</b><br>24.8 MB</span></div><div class="intro-file"><i class="fas fa-file-image"></i><span><b>preview.png</b><br>2.4 MB</span></div></div><div class="intro-demo-card"><strong><i class="fas fa-bolt"></i> FLUXO</strong><div class="intro-flow"><b>UPLOAD</b><i class="fas fa-arrow-right"></i><b>SALA</b><i class="fas fa-arrow-right"></i><b>DOWNLOAD</b></div></div></div></div></article>'+
      '<article class="intro-scene"><div><div class="intro-kicker">04 / FEITO PARA FLUIR</div><div class="intro-big">RÁPIDO.<br><em>SIMPLES.</em><br>SEGURO.</div><p class="intro-sub">Upload, download e chat da sala sem sair da experiência.</p></div></article>'+
      '<article class="intro-scene"><div><div class="intro-check"><i class="fas fa-circle-check"></i></div><div class="intro-word">PRONTO.</div><p class="intro-sub">Entre e comece a compartilhar.</p></div></article>'+
      '</div><div class="intro-bottom"><button class="intro-skip" id="introSkip" type="button">PULAR</button><div class="intro-progress"><i id="introProgress"></i></div><span id="introTimer" style="font:600 10px var(--mono,'Share Tech Mono',monospace);color:rgba(255,255,255,.5);min-width:30px;text-align:right">30s</span></div>';
    body.appendChild(wrap);
    var scenes=[].slice.call(wrap.querySelectorAll('.intro-scene')), progress=wrap.querySelector('#introProgress'), timer=wrap.querySelector('#introTimer'), skip=wrap.querySelector('#introSkip'), replay=wrap.querySelector('#introReplay'), start=0, raf=0, running=false;
    function finish(){ running=false; cancelAnimationFrame(raf); wrap.classList.add('is-hidden'); setTimeout(function(){wrap.remove()},750); try{localStorage.setItem(KEY,'1')}catch(e){} }
    function startIntro(){ if(running)return; running=true; wrap.classList.remove('is-hidden'); start=performance.now(); scenes.forEach(function(s,i){s.classList.toggle('active',i===0)}); function loop(now){ if(!running)return; var elapsed=now-start, pct=Math.min(1,elapsed/30000), idx=Math.min(scenes.length-1,Math.floor(pct*scenes.length)); scenes.forEach(function(s,i){s.classList.toggle('active',i===idx)}); progress.style.width=(pct*100)+'%'; timer.textContent=Math.max(0,30-Math.floor(elapsed/1000))+'s'; if(pct>=1){finish();return} raf=requestAnimationFrame(loop)} raf=requestAnimationFrame(loop)}
    skip.addEventListener('click',finish); replay.addEventListener('click',function(e){e.stopPropagation();startIntro()});
    if(reduce){ finish(); return; }
    var seen=false; try{seen=localStorage.getItem(KEY)==='1'}catch(e){}
    if(seen){wrap.classList.add('is-hidden')}else{setTimeout(startIntro,450)}
    window.fileshareReplayIntro=function(){startIntro()};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();