// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Visuels canvas du réacteur ΣIRIUS : médaillon rotatif, cœur holographique
// et visualiseur vocal (onde + particules). Extraits d'App.js à l'identique.
import { useEffect, useRef, useState } from "react";

import { STATES } from "@/appLogic";

// Anneau d'or réel superposé au médaillon du trône — même rotation que la page de présentation
export function MedallionRing({ status }) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    const upd = () => {
      const s = Math.max(window.innerWidth / 1264, window.innerHeight / 848);
      setBox({
        x: (window.innerWidth - 1264 * s) / 2 + 631 * s,
        y: (window.innerHeight - 848 * s) / 2 + 351 * s,
        d: 840 * s,
      });
    };
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);
  if (!box) return null;
  return (
    <div
      className="live-medallion"
      style={{ left: box.x, top: box.y, width: box.d, height: box.d }}
      data-testid="sirius-live-ring"
    >
      <img src="/holo/ring-gold.png" alt="" className="live-medallion-img" draggable={false} />
      <img src="/holo/ring-gold.png" alt="" className="live-medallion-img inner-rev" draggable={false} />
      <img src="/holo/sirius-title.png" alt="ΣIRIUS" className="live-medallion-title" data-testid="sirius-hud-title" draggable={false} />
    </div>
  );
}

export function ReactorCore({ status, volume, color, eco }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ status, volume, color, eco, t: 0, rot: 0 });
  stateRef.current.status = status;
  stateRef.current.volume = volume;
  stateRef.current.color = color;
  stateRef.current.eco = eco;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let raf;
    const DPR = 1; // léger pour PC peu puissants

    const resize = () => {
      const size = canvas.clientWidth;
      canvas.width = size * DPR;
      canvas.height = size * DPR;
    };
    resize();
    window.addEventListener("resize", resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const hexToRgb = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };

    let lastFrame = 0;
    const draw = (ts) => {
      raf = requestAnimationFrame(draw);
      const s = stateRef.current;
      // Mode économie : on ralentit fortement le rafraîchissement (surtout en veille)
      const minDt = s.eco ? (s.status === "idle" || s.status === "listening" ? 110 : 55) : 33;
      if (ts && ts - lastFrame < minDt) return;
      const dt = lastFrame ? Math.min(0.2, (ts - lastFrame) / 1000) : 0.033;
      lastFrame = ts || 0;
      s.t += dt;
      const blur = s.eco ? 0 : 18; // shadowBlur coûteux → désactivé en éco
      const conf = STATES[s.status] || STATES.idle;
      const [r, g, b] = hexToRgb(s.color || conf.color);
      const W = canvas.width;
      const H = canvas.height;
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) / 2;
      ctx.clearRect(0, 0, W, H);

      const pulse = s.status === "speaking" ? s.volume : 0.26 + 0.22 * Math.sin(s.t * 1.8);
      const energy = s.status === "thinking" ? 0.5 + 0.4 * Math.abs(Math.sin(s.t * 3)) : pulse;

      // Vitesse de rotation dynamique du cœur
      let rotSpeed;
      if (s.status === "speaking") rotSpeed = 0.9 + s.volume * 4.8;            // parle : + fort = + vite
      else if (s.status === "thinking") rotSpeed = 3.0 + 1.3 * Math.abs(Math.sin(s.t * 3.2)); // recherche : très rapide & nerveux
      else if (s.status === "listening") rotSpeed = 1.3;                        // écoute : réactif
      else rotSpeed = 0.4;                                                      // veille : posé
      s.rot += rotSpeed * dt;

      // halo bleu intensifié (double couche : cœur dense + diffusion large)
      const halo = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * (1.15 + energy * 0.35));
      halo.addColorStop(0, `rgba(${r},${g},${b},${0.65 + energy * 0.35})`);
      halo.addColorStop(0.35, `rgba(${r},${g},${b},${0.3 + energy * 0.2})`);
      halo.addColorStop(0.65, `rgba(${r},${g},${b},0.12)`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
      if (!s.eco) {
        const halo2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
        halo2.addColorStop(0, `rgba(${r},${g},${b},${0.35 + energy * 0.3})`);
        halo2.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = halo2;
        ctx.fillRect(0, 0, W, H);
      }
      // onde de pulse lumineuse prononcée (anneau bleu qui respire)
      const pw = 0.72 + 0.28 * Math.sin(s.t * 2.2);
      const pr = R * (0.55 + energy * 0.35) * pw;
      const pgrad = ctx.createRadialGradient(cx, cy, pr * 0.45, cx, cy, pr);
      pgrad.addColorStop(0, "rgba(0,0,0,0)");
      pgrad.addColorStop(0.78, `rgba(${r},${g},${b},${0.4 + energy * 0.45})`);
      pgrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = pgrad;
      ctx.beginPath();
      ctx.arc(cx, cy, pr, 0, Math.PI * 2);
      ctx.fill();
      // 2e onde de pulse déphasée (expansion visible vers l'extérieur)
      if (!s.eco) {
        const pw2 = ((s.t * 0.55) % 1);
        const pr2 = R * (0.5 + pw2 * 0.55);
        ctx.save();
        ctx.lineWidth = 2.5 * DPR;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - pw2) * (0.35 + energy * 0.35)})`;
        ctx.shadowBlur = blur;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        ctx.beginPath();
        ctx.arc(cx, cy, pr2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // anneaux rotatifs
      const active = s.status === "thinking" || s.status === "speaking";
      const drawRing = (radius, lw, segs, gap, speed, alpha) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(s.rot * speed);
        ctx.lineWidth = lw * DPR;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.shadowBlur = blur;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        const arc = ((Math.PI * 2) / segs) * (1 - gap);
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(0, 0, radius, a0, a0 + arc);
          ctx.stroke();
        }
        // reflets spéculaires vifs sur l'anneau (blanc incandescent + scintillement)
        if (!s.eco) {
          const shimmer = 0.75 + 0.25 * Math.sin(s.t * 5 + radius);
          ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, alpha * 0.85 * shimmer)})`;
          ctx.lineWidth = lw * 0.55 * DPR;
          ctx.shadowBlur = blur + 12;
          ctx.shadowColor = "rgba(255,255,255,1)";
          for (let i = 0; i < segs; i++) {
            const a0 = (i / segs) * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(0, 0, radius, a0, a0 + arc * 0.35);
            ctx.stroke();
          }
        }
        ctx.restore();
      };
      // cercle pointillé rotatif
      const drawDashed = (radius, lw, dash, gap, speed, alpha) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(s.rot * speed);
        ctx.setLineDash([dash * DPR, gap * DPR]);
        ctx.lineWidth = lw * DPR;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.shadowBlur = blur;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      };
      // fragments d'arcs irréguliers (façon hologramme technique)
      const drawFragments = (radius, lw, frags, speed, alpha) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(s.rot * speed);
        ctx.lineWidth = lw * DPR;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.shadowBlur = blur;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        for (const [a0, len] of frags) {
          ctx.beginPath();
          ctx.arc(0, 0, radius, a0, a0 + len);
          ctx.stroke();
        }
        ctx.restore();
      };
      // rayons internes entre deux rayons
      const drawSpokes = (r1, r2, n, speed, alpha) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(s.rot * speed);
        ctx.lineWidth = 1.5 * DPR;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
          ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
          ctx.stroke();
        }
        ctx.restore();
      };

      const FRAGS_A = [[0.15, 0.55], [1.35, 0.3], [2.5, 0.85], [4.0, 0.4], [5.15, 0.65]];
      const FRAGS_B = [[0.7, 0.35], [1.9, 0.6], [3.3, 0.25], [4.6, 0.5], [5.8, 0.3]];

      drawRing(R * 0.86, 2, 3, 0.18, 0.25, 0.5);
      drawRing(R * 0.74, 5, 24, 0.45, -0.35, 0.55);
      drawRing(R * 0.62, 2, 6, 0.25, 0.6, 0.7);
      if (!s.eco) {
        // Structure holographique riche — VISIBLE EN PERMANENCE (intensifiée quand Sirius réfléchit/parle)
        drawFragments(R * 0.97, 1.5, FRAGS_A, 0.14, active ? 0.55 : 0.42);
        drawFragments(R * 0.93, 3, FRAGS_B, -0.3, active ? 0.6 + energy * 0.3 : 0.45);
        drawDashed(R * 0.68, 1.5, 6, 10, -0.5, active ? 0.6 : 0.45);
        drawDashed(R * 0.44, 1, 3, 7, 0.9, active ? 0.55 : 0.4);
        drawRing(R * 0.5, 3, 48, 0.5, -0.9, 0.4 + energy * 0.4);
        drawSpokes(R * 0.4, R * 0.56, 12, 0.2, active ? 0.4 + energy * 0.25 : 0.28);

        // Anneau épais lumineux avec encoches (comme le grand cercle brillant)
        drawRing(R * 0.8, 7, 18, 0.22, 0.32, active ? 0.5 + energy * 0.4 : 0.34);
        // Arc d'énergie qui balaie (façon radar) — plus rapide en réflexion
        const sweepSpeed = s.status === "thinking" ? 2.6 : s.status === "speaking" ? 1.4 : 0.7;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(s.rot * sweepSpeed);
        ctx.lineWidth = 4 * DPR;
        ctx.lineCap = "round";
        ctx.strokeStyle = `rgba(255,255,255,${active ? 0.55 + energy * 0.35 : 0.3})`;
        ctx.shadowBlur = blur + 6;
        ctx.shadowColor = `rgba(${r},${g},${b},1)`;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.88, 0, 1.15);
        ctx.stroke();
        // Marqueurs orbitaux (3 points lumineux)
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          ctx.beginPath();
          ctx.fillStyle = `rgba(${r},${g},${b},${active ? 0.95 : 0.6})`;
          ctx.arc(Math.cos(a) * R * 0.68, Math.sin(a) * R * 0.68, 3.2 * DPR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // graduations fines (désactivées en mode éco)
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-s.rot * 0.15);
        for (let i = 0; i < 90; i++) {
          const a = (i / 90) * Math.PI * 2;
          const len = i % 5 === 0 ? R * 0.05 : R * 0.025;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${r},${g},${b},${i % 5 === 0 ? 0.5 : 0.22})`;
          ctx.lineWidth = 1 * DPR;
          ctx.moveTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9);
          ctx.lineTo(Math.cos(a) * (R * 0.9 + len), Math.sin(a) * (R * 0.9 + len));
          ctx.stroke();
        }
        ctx.restore();
      } else if (active) {
        // Mode éco : version allégée de l'animation active
        drawRing(R * 0.8, 6, 18, 0.22, 0.32, 0.45 + energy * 0.3);
        drawDashed(R * 0.68, 1.5, 6, 10, -0.5, 0.4);
      }

      // coeur central — plus incandescent
      const coreR = R * (0.34 + energy * 0.18);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0, `rgba(255,255,255,1)`);
      core.addColorStop(0.3, `rgba(${Math.min(255, r + 80)},${Math.min(255, g + 80)},${Math.min(255, b)},1)`);
      core.addColorStop(0.6, `rgba(${r},${g},${b},0.85)`);
      core.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.save();
      if (!s.eco) {
        ctx.shadowBlur = blur + 14;
        ctx.shadowColor = `rgba(${r},${g},${b},1)`;
      }
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // triangle réacteur : remplacé par le grand triangle holographique au premier plan
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      resizeObserver.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="reactor-canvas" data-testid="sirius-reactor" />;
}

// ----- Visualiseur audio -----
// Visualiseur vocal dynamique : onde fluide (Canvas) réagissant en temps réel
// - écoute : niveau réel du micro (getUserMedia + AnalyserNode)
// - Sirius parle : enveloppe synthétique animée
// - repos : ligne douce ondulante
export function Waveform({ status, color }) {
  const canvasRef = useRef(null);
  const levelRef = useRef(0.05);
  const particlesRef = useRef([]);
  const statusRef = useRef(status);
  statusRef.current = status;

  // Micro réel uniquement pendant l'écoute
  useEffect(() => {
    if (status !== "listening") return;
    let ctx, analyser, raf, stream, buf;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctx();
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          levelRef.current = Math.min(1, rms * 3.2);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {}
    })();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      try { ctx && ctx.close(); } catch (e) {}
      levelRef.current = 0.05;
    };
  }, [status]);

  // Boucle de dessin
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let raf, t = 0;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * DPR;
      canvas.height = r.height * DPR;
    };
    resize();
    window.addEventListener("resize", resize);
    let lastWave = 0;
    const draw = (ts) => {
      if (ts && ts - lastWave < 33) { raf = requestAnimationFrame(draw); return; }
      lastWave = ts || 0;
      t += 0.05;
      const w = canvas.width, h = canvas.height, mid = h / 2;
      ctx.clearRect(0, 0, w, h);
      const st = statusRef.current;
      if (st !== "speaking" && st !== "listening" && st !== "thinking") {
        raf = requestAnimationFrame(draw);
        return;
      }
      let amp;
      if (st === "listening") amp = 0.1 + levelRef.current * 0.85;
      else if (st === "speaking") amp = 0.35 + 0.35 * Math.abs(Math.sin(t * 1.6)) + 0.12 * Math.sin(t * 4.3);
      else if (st === "thinking") amp = 0.14 + 0.06 * Math.sin(t * 2.2);
      else amp = 0.06 + 0.03 * Math.sin(t);
      const waveY = (nx, li) => {
        const env = Math.sin(nx * Math.PI);
        return mid + Math.sin(nx * 18 + t * (2.2 + li)) * mid * amp * env
                   + Math.sin(nx * 41 - t * 3) * mid * amp * 0.35 * env;
      };
      // Dégradé cyan ↔ or animé le long de l'onde — palette resynchronisée avec les anneaux
      // du globe (cyan #4ff0ff/#7fd8ff/#b6f0ff, or #ffd166/#ffc978) : la ligne se fond
      // désormais dans le HUD actuel au lieu de garder l'ancien cyan/or plus vif et isolé.
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      const ph = (Math.sin(t * 0.7) + 1) / 2;
      grad.addColorStop(0, "#7fd8ff");
      grad.addColorStop(Math.max(0.12, Math.min(0.88, 0.5 - ph * 0.25)), "#ffd166");
      grad.addColorStop(Math.max(0.14, Math.min(0.9, 0.5 + ph * 0.25)), "#ffc978");
      grad.addColorStop(1, "#7fd8ff");
      // Spectre pointu (pics verticaux symétriques) — style hologramme cyan
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3 * DPR) {
        const nx = x / w;
        const env = Math.pow(Math.sin(nx * Math.PI), 0.75);
        const n = Math.sin(nx * 57 + t * 5.1) * Math.sin(nx * 23 - t * 3.7) * Math.sin(nx * 91 + t * 2.3);
        const sh = Math.abs(n) * mid * amp * env * 1.5 + 1;
        ctx.moveTo(x, mid - sh);
        ctx.lineTo(x, mid + sh);
      }
      ctx.strokeStyle = "#4ff0ff";
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.3 * DPR;
      ctx.shadowBlur = 10;
      ctx.shadowColor = "#7fd8ff";
      ctx.stroke();
      // Onde fluide dorée en surimpression
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const nx = x / w;
        const env = Math.sin(nx * Math.PI);
        const y = mid + Math.sin(nx * 18 + t * 2.2) * mid * amp * 0.5 * env
                      + Math.sin(nx * 41 - t * 3) * mid * amp * 0.2 * env;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.6 * DPR;
      ctx.shadowBlur = 12;
      ctx.shadowColor = "#ffd166";
      ctx.stroke();
      // Ligne d'horizon lumineuse
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1 * DPR;
      ctx.shadowBlur = 8;
      ctx.shadowColor = "#b6f0ff";
      ctx.stroke();
      // Particules dorées émises par l'onde quand Sirius parle (ou fort niveau micro)
      const emitting = st === "speaking" || (st === "listening" && levelRef.current > 0.25);
      if (emitting && particlesRef.current.length < 110) {
        for (let i = 0; i < 3; i++) {
          const nx = 0.08 + Math.random() * 0.84;
          particlesRef.current.push({
            x: nx * w, y: waveY(nx, 0),
            vx: (Math.random() - 0.5) * 0.6 * DPR,
            vy: (-0.5 - Math.random() * 1.1) * DPR,
            r: (0.8 + Math.random() * 1.8) * DPR,
            life: 1, decay: 0.012 + Math.random() * 0.015,
            gold: Math.random() > 0.25,
          });
        }
      }
      ctx.shadowBlur = 8;
      particlesRef.current = particlesRef.current.filter((p) => {
        p.x += p.vx; p.y += p.vy; p.vy *= 0.985; p.life -= p.decay;
        if (p.life <= 0) return false;
        ctx.globalAlpha = p.life * 0.9;
        ctx.fillStyle = p.gold ? "#ffd166" : "#b6f0ff";
        ctx.shadowColor = p.gold ? "#ffc978" : "#7fd8ff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.6 + p.life * 0.6), 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, [color]);

  return <canvas ref={canvasRef} className="waveform-canvas" data-testid="sirius-waveform" />;
}
