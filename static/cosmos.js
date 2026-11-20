/* Studiora AI — universe engine
 *  - Cosmos : interactive starfield (parallax, cursor constellations, warp, bursts, shooting stars)
 *  - Orb    : the rotating, glowing energy orb (logo + "thinking" indicator)
 *  - Splash : warp-speed loading screen
 *  Exposes window.Studiora. Vanilla JS, no dependencies.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('studiora.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('studiora.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const prefs = {
    cosmos: store.get('cosmos', true),
    calm: store.get('calm', reduceMQ.matches),
  };

  /* ===================================================================
     ORB
     =================================================================== */
  function orbHTML(size = 40, cls = '') {
    return `<span class="orb ${cls}" style="--s:${size}px" data-state="idle" aria-hidden="true">` +
      '<span class="orb-halo"></span><span class="orb-wave"></span>' +
      '<span class="orb-ring r1"></span><span class="orb-ring r2"></span>' +
      '<span class="orb-body"><span class="orb-swirl s1"></span><span class="orb-swirl s2"></span>' +
      '<span class="orb-stars"></span><span class="orb-gloss"></span></span>' +
      '<span class="orb-sparks"><i></i><i></i><i></i></span></span>';
  }

  function hydrateOrbs(scope = document) {
    scope.querySelectorAll('[data-orb]').forEach((n) => {
      const size = +n.dataset.orb || 40;
      const wrap = document.createElement('span');
      wrap.innerHTML = orbHTML(size, n.dataset.cls || '');
      const orb = wrap.firstChild;
      if (n.dataset.logo !== undefined) orb.dataset.logo = '';
      n.replaceWith(orb);
    });
  }

  // Smoothly change how fast the orb's animations run (no visual jump when speeding up).
  function rampOrb(orb, state, instant) {
    if (!orb.getAnimations) return;
    const thinking = state === 'thinking';
    const anims = orb.getAnimations({ subtree: true });
    const targets = anims.map((a) => {
      const n = a.animationName || '';
      if (!thinking) return 1;
      if (n.includes('spin')) return 5.5;
      if (n.includes('halo')) return 3;
      return 1.4;
    });
    cancelAnimationFrame(orb._ramp);
    if (instant) { anims.forEach((a, i) => { a.playbackRate = targets[i]; }); return; }
    const step = () => {
      let moving = false;
      anims.forEach((a, i) => {
        const d = targets[i] - a.playbackRate;
        if (Math.abs(d) > 0.02) { a.playbackRate += d * 0.09; moving = true; } else a.playbackRate = targets[i];
      });
      if (moving) orb._ramp = requestAnimationFrame(step);
    };
    orb._ramp = requestAnimationFrame(step);
  }

  function setOrbState(orb, state, instant = false) {
    if (!orb || orb.dataset.state === state) return;
    orb.dataset.state = state;
    rampOrb(orb, state, instant);
  }

  /* ===================================================================
     COSMOS (canvas starfield)
     =================================================================== */
  const Cosmos = (() => {
    const cv = document.getElementById('cosmos');
    const noop = { warp() {}, setThinking() {}, burst() {}, refresh() {} };
    if (!cv) return noop;
    const ctx = cv.getContext('2d');
    const IDLE = 0.022, BUSY = 0.085;
    let W = 0, H = 0, DPR = 1, stars = [], parts = [], shoot = null;
    let speed = IDLE, target = IDLE, thinking = false;
    let running = false, last = 0, nextShoot = 0;
    const ptr = { x: -9999, y: -9999, px: 0, py: 0, sx: 0, sy: 0, on: false };
    const COLORS = ['255,255,255', '255,255,255', '214,196,255', '196,181,253', '244,184,255', '165,200,255'];

    function spawn(s, fresh) {
      s.x = (Math.random() * 2 - 1) * 1.6;
      s.y = (Math.random() * 2 - 1) * 1.6;
      s.z = fresh ? Math.random() * 0.98 + 0.02 : 1;
      s.pz = s.z;
      s.c = COLORS[(Math.random() * COLORS.length) | 0];
      s.tw = Math.random() * 6.28;
      s.ts = 0.6 + Math.random() * 1.8;
      return s;
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const n = Math.min(320, Math.round((W * H) / 7500));
      while (stars.length < n) stars.push(spawn({}, true));
      stars.length = n;
      if (!running) frame(performance.now(), true);
    }

    function frame(now, once) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      const calm = prefs.calm;
      const eff = calm ? 0 : speed;
      speed += (target - speed) * (1 - Math.exp(-dt * 2.4));
      ptr.sx += (ptr.px - ptr.sx) * 0.05;
      ptr.sy += (ptr.py - ptr.sy) * 0.05;

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2, f = Math.max(W, H) * 0.55;
      const streak = eff > 0.35;
      const t = now / 1000;

      for (const s of stars) {
        s.pz = s.z;
        s.z -= eff * dt;
        const k = f / s.z;
        const depth = 1 - s.z;
        const sx = cx + s.x * k - ptr.sx * 70 * depth;
        const sy = cy + s.y * k - ptr.sy * 70 * depth;
        if (s.z <= 0.02 || sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) { spawn(s, false); continue; }
        const tw = calm ? 0.8 : 0.65 + 0.35 * Math.sin(t * s.ts + s.tw);
        const a = Math.min(1, (depth * 0.95 + 0.1) * tw);
        const size = depth * 2.1 + 0.35;
        s._x = sx; s._y = sy;
        if (streak) {
          const pk = f / s.pz;
          const px = cx + s.x * pk - ptr.sx * 70 * (1 - s.pz);
          const py = cy + s.y * pk - ptr.sy * 70 * (1 - s.pz);
          ctx.strokeStyle = `rgba(${s.c},${a})`;
          ctx.lineWidth = Math.max(0.6, size * 0.9);
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx, sy); ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${s.c},${a})`;
          if (size > 1.5) { ctx.beginPath(); ctx.arc(sx, sy, size * 0.55, 0, 6.283); ctx.fill(); }
          else ctx.fillRect(sx, sy, size, size);
        }
      }

      // constellation lines that reach for the cursor
      if (ptr.on && !calm && !streak) {
        ctx.lineWidth = 1;
        for (const s of stars) {
          const dx = s._x - ptr.x, dy = s._y - ptr.y, d = Math.hypot(dx, dy);
          if (d < 150) {
            const a = (1 - d / 150) * 0.55;
            ctx.strokeStyle = `rgba(196,160,255,${a})`;
            ctx.beginPath(); ctx.moveTo(ptr.x, ptr.y); ctx.lineTo(s._x, s._y); ctx.stroke();
            ctx.fillStyle = `rgba(255,255,255,${a + 0.2})`;
            ctx.beginPath(); ctx.arc(s._x, s._y, 1.6, 0, 6.283); ctx.fill();
          }
        }
      }

      // shooting star
      if (!calm && !streak) {
        if (!shoot && now > nextShoot) {
          const fromLeft = Math.random() < 0.5;
          shoot = { x: fromLeft ? Math.random() * W * 0.5 : W * 0.5 + Math.random() * W * 0.5, y: Math.random() * H * 0.35,
            vx: (fromLeft ? 1 : -1) * (520 + Math.random() * 260), vy: 220 + Math.random() * 120, life: 1 };
        }
        if (shoot) {
          shoot.x += shoot.vx * dt; shoot.y += shoot.vy * dt; shoot.life -= dt * 0.9;
          const g = ctx.createLinearGradient(shoot.x, shoot.y, shoot.x - shoot.vx * 0.16, shoot.y - shoot.vy * 0.16);
          g.addColorStop(0, `rgba(255,255,255,${Math.max(0, shoot.life)})`);
          g.addColorStop(1, 'rgba(168,85,247,0)');
          ctx.strokeStyle = g; ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.moveTo(shoot.x, shoot.y); ctx.lineTo(shoot.x - shoot.vx * 0.16, shoot.y - shoot.vy * 0.16); ctx.stroke();
          if (shoot.life <= 0) { shoot = null; nextShoot = now + 5000 + Math.random() * 7000; }
        }
      }

      // click bursts
      if (parts.length) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= dt * 1.3;
          if (p.life <= 0) { parts.splice(i, 1); continue; }
          ctx.fillStyle = `hsla(${p.h},90%,70%,${p.life * 0.9})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, 1 + p.life * 2.2, 0, 6.283); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      if (!once && running) requestAnimationFrame((n) => frame(n));
    }

    function start() {
      if (running || prefs.calm || !prefs.cosmos) return;
      running = true; last = performance.now(); nextShoot = last + 3500;
      requestAnimationFrame((n) => frame(n));
    }
    function stop() { running = false; }

    function applyPrefs() {
      cv.style.display = prefs.cosmos ? '' : 'none';
      document.querySelector('.nebula')?.classList.toggle('off', !prefs.cosmos);
      if (prefs.cosmos && !prefs.calm) start(); else { stop(); if (prefs.cosmos) frame(performance.now(), true); }
    }

    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true;
      ptr.px = (e.clientX / W - 0.5); ptr.py = (e.clientY / H - 0.5);
    }, { passive: true });
    document.addEventListener('pointerleave', () => { ptr.on = false; });
    window.addEventListener('pointerdown', (e) => {
      if (prefs.calm || !prefs.cosmos) return;
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * 6.283, v = 60 + Math.random() * 190;
        parts.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, h: 255 + Math.random() * 90 });
      }
    }, { passive: true });

    resize();
    applyPrefs();

    return {
      warp(power = 2.6) { if (!prefs.calm) speed = Math.max(speed, power); target = thinking ? BUSY : IDLE; },
      setThinking(on) { thinking = on; target = on ? BUSY : IDLE; },
      burst(x, y) { for (let i = 0; i < 26; i++) { const a = Math.random() * 6.283, v = 80 + Math.random() * 260; parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, h: 255 + Math.random() * 90 }); } },
      refresh: applyPrefs,
    };
  })();

  /* ===================================================================
     SPLASH (loading screen)
     =================================================================== */
  const Splash = (() => {
    const el = document.getElementById('splash');
    if (!el) return { ready() { return Promise.resolve(); }, hide() { return Promise.resolve(); } };
    const seen = (() => { try { return sessionStorage.getItem('studiora.seen') === '1'; } catch { return false; } })();
    const minMs = seen ? 1100 : 2800;
    const t0 = performance.now();
    let skipped = false, hidden = false;
    const status = el.querySelector('.splash-status');
    const lines = ['Charting the stars…', 'Waking the model…', 'Opening your universe…'];

    if (seen) el.classList.add('quick');
    const so = el.querySelector('.orb'); if (so) setOrbState(so, 'thinking', true);
    Cosmos.warp(seen ? 1.8 : 3.4);
    lines.forEach((l, i) => setTimeout(() => { if (status && !hidden) { status.textContent = l; status.classList.remove('swap'); void status.offsetWidth; status.classList.add('swap'); } }, (minMs / lines.length) * i));

    // the orb leans toward the cursor; click to send out a pulse
    const tilt = el.querySelector('.splash-orb');
    el.addEventListener('pointermove', (e) => {
      if (!tilt) return;
      const x = (e.clientX / window.innerWidth - 0.5) * 2, y = (e.clientY / window.innerHeight - 0.5) * 2;
      tilt.style.transform = `perspective(700px) rotateY(${x * 16}deg) rotateX(${-y * 16}deg) translateZ(0)`;
    });
    el.addEventListener('pointerdown', () => { skipped = true; const o = el.querySelector('.orb'); if (o) { o.classList.remove('zap'); void o.offsetWidth; o.classList.add('zap'); } Cosmos.warp(1.6); });
    window.addEventListener('keydown', () => { skipped = true; }, { once: true });
    setTimeout(() => hide(), 12000); // failsafe

    function ready() {
      const wait = Math.max(0, minMs - (performance.now() - t0));
      return new Promise((res) => {
        const tick = () => { if (skipped) res(); else setTimeout(res, wait); };
        tick();
      });
    }
    function hide() {
      if (hidden) return Promise.resolve();
      hidden = true;
      try { sessionStorage.setItem('studiora.seen', '1'); } catch { /* ignore */ }
      Cosmos.warp(1.5);
      el.classList.add('out');
      document.body.classList.add('entered');
      return new Promise((res) => setTimeout(() => { el.remove(); res(); }, 900));
    }
    return { ready, hide };
  })();

  /* ===================================================================
     Global thinking state + prefs + effects
     =================================================================== */
  function setThinking(on) {
    document.body.classList.toggle('is-thinking', on);
    document.querySelectorAll('.orb[data-logo]').forEach((o) => setOrbState(o, on ? 'thinking' : 'idle'));
    Cosmos.setThinking(on);
  }

  function applyPrefs() {
    root.classList.toggle('calm', prefs.calm);
    Cosmos.refresh();
  }
  function setPref(k, v) { prefs[k] = v; store.set(k, v); applyPrefs(); }

  // cursor-following spotlight + ripple on interactive surfaces
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('[data-spot]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    t.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest && e.target.closest('.rip-host');
    if (!t || prefs.calm) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--rx', (e.clientX - r.left) + 'px');
    t.style.setProperty('--ry', (e.clientY - r.top) + 'px');
    t.classList.remove('rip'); void t.offsetWidth; t.classList.add('rip');
  }, { passive: true });

  hydrateOrbs();
  applyPrefs();

  window.Studiora = { orbHTML, hydrateOrbs, setOrbState, setThinking, Cosmos, Splash, prefs, setPref, store };
})();
