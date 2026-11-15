// Aplica a la app la funcion de presupuesto con premio y castigo.
// Uso: node tools/apply-budget-feature.mjs [ruta/al/index.html]
//
// - Anade un presupuesto inicial de 100 USD.
// - Cada respuesta apuesta segun la complejidad del patron (2, 4 u 8 USD).
// - Al acertar salta un canon que dispara billetes.
// - Al fallar aparece un ladron que se lleva el dinero y un cartel.
// - Recalcula el hash SHA-256 de la CSP para que el script siga ejecutandose.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const archivo = process.argv[2] || path.join(process.cwd(), 'work-app', 'desktop', 'index.html');
let html = fs.readFileSync(archivo, 'utf8');
const antes = html.length;

function reemplazar(buscado, nuevo, etiqueta) {
  if (!html.includes(buscado)) throw new Error('No encontrado: ' + etiqueta);
  html = html.replace(buscado, () => nuevo);
}

/* 1. Presupuesto inicial en el estado nuevo */
reemplazar(
  "function fresh() { return { name: '', xp: 0, streak: 0,",
  "function fresh() { return { name: '', xp: 0, cash: 100, streak: 0,",
  'estado inicial'
);

/* 2. Migracion para instalaciones que ya tienen progreso guardado */
reemplazar(
  'let S = load();',
  "let S = load();\nif (typeof S.cash !== 'number' || !Number.isFinite(S.cash)) S.cash = 100;",
  'migracion de estado'
);

/* 3. Helpers: complejidad, formato de dinero y animaciones */
const helpers = `
/* ---------- presupuesto, canon y ladron ---------- */
const APUESTA = { 1: 2, 2: 4, 3: 8 };
function dificultad(p, modo) {
  const velas = Number(p && p.n) || 1;
  const parecidos = Array.isArray(p && p.rel) ? p.rel.length : 0;
  let nivel = 1 + (velas >= 3 ? 1 : 0) + (parecidos >= 2 ? 1 : 0);
  if (modo === 'dir') nivel -= 1;
  return Math.max(1, Math.min(3, nivel));
}
function dinero(v) { return '$' + Number(v).toFixed(2); }
function playResult(ok, delta, dif) {
  const quieto = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const capa = document.createElement('div');
  capa.className = 'fx' + (quieto ? ' quiet' : '');
  if (ok) {
    capa.innerHTML = '<div class="cannon"><i class="barrel"></i><i class="wheel"></i><i class="boom"></i></div>';
    document.body.appendChild(capa);
    const cuantos = 6 + dif * 3;
    for (let i = 0; i < cuantos; i++) {
      const b = document.createElement('span');
      b.className = 'bill';
      b.textContent = '💸';
      b.style.left = (66 + Math.random() * 10) + 'px';
      b.style.bottom = (106 + Math.random() * 12) + 'px';
      b.style.setProperty('--dx', (120 + Math.random() * 240) + 'px');
      b.style.setProperty('--dy', (-110 - Math.random() * 190) + 'px');
      b.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      b.style.animationDelay = (i * 45) + 'ms';
      capa.appendChild(b);
    }
    const sube = document.createElement('span');
    sube.className = 'billup';
    sube.textContent = '+' + dinero(delta);
    sube.style.left = '50%';
    sube.style.top = '44%';
    capa.appendChild(sube);
  } else {
    capa.innerHTML = '<div class="thief">🥷</div>'
      + '<div class="cartel">ESTUDIA MÁS<br>O QUEMAS LA CUENTA</div>'
      + '<div class="loss">' + dinero(delta) + '</div>';
    document.body.appendChild(capa);
  }
  setTimeout(() => capa.remove(), 3200);
}
function pick(`;

reemplazar('\nfunction pick(', helpers, 'helpers antes de pick');

/* 4. Apuesta y resultado dentro de pick() */
reemplazar(
  '  const rec = S.pat[q.pid] || (S.pat[q.pid] = { seen: 0, ok: 0, hist: [] });',
  `  const ptn = P(q.pid), dif = dificultad(ptn, q.mode), apuesta = APUESTA[dif];
  const antesSaldo = S.cash;
  S.cash = Math.max(0, Math.round((S.cash + (unsure ? 0 : (ok ? apuesta : -apuesta))) * 100) / 100);
  const movido = Math.round((S.cash - antesSaldo) * 100) / 100;
  const rec = S.pat[q.pid] || (S.pat[q.pid] = { seen: 0, ok: 0, hist: [] });`,
  'apuesta en pick'
);

reemplazar(
  '  const g = addXP(ok ? 20 : (unsure ? 2 : 5)); SS.xp += g;\n  save(); showQ();\n}',
  '  const g = addXP(ok ? 20 : (unsure ? 2 : 5)); SS.xp += g;\n  save(); showQ();\n  if (!unsure) playResult(ok, movido, dif);\n}',
  'efecto al responder'
);

/* 5. Saldo visible en el reto y en Inicio */
reemplazar(
  '<span class="pill mono" style="font-size:12px">${q.sm.tk} · ${q.sm.tf}</span>',
  '<span class="pill mono" style="font-size:12px">${q.sm.tk} · ${q.sm.tf}</span> <span class="pill mono cash-pill" style="font-size:12px">${dinero(S.cash)}</span>',
  'saldo en el reto'
);

reemplazar(
  '<span class="row" style="gap:6px">${ic(\'bolt\')}Nivel ${level()}</span>',
  '<span class="row" style="gap:6px">${ic(\'bolt\')}Nivel ${level()}</span><span class="row cash-mini" style="gap:6px">💰 ${dinero(S.cash)}</span>',
  'saldo en Inicio'
);

/* 6. Estilos y animaciones */
const estilos = `
/* --- presupuesto: canon, billetes y ladron --- */
.cash-pill{color:var(--up);border-color:var(--line)}
.cash-mini{color:var(--up);font-weight:600}
.fx{position:fixed;inset:0;pointer-events:none;z-index:70}
.cannon{position:absolute;left:16px;bottom:84px;width:62px;height:46px}
.cannon .barrel{position:absolute;left:2px;bottom:14px;width:48px;height:16px;border-radius:9px;background:linear-gradient(180deg,#4a5568,#141c2b);transform:rotate(-26deg)}
.cannon .wheel{position:absolute;left:8px;bottom:0;width:20px;height:20px;border-radius:50%;background:#141c2b;border:3px solid var(--accent)}
.cannon .boom{position:absolute;left:48px;top:-6px;width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,#ffe08a 0%,rgba(255,224,138,0) 70%);animation:boom .4s ease-out forwards}
.bill{position:absolute;font-size:26px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.25));animation:fly 1.15s cubic-bezier(.2,.6,.4,1) forwards}
.billup{position:absolute;transform:translate(-50%,-50%);font-weight:800;color:var(--up);font-size:22px;animation:billup 1.2s ease-out forwards}
.thief{position:absolute;right:-90px;bottom:82px;font-size:44px;animation:steal 1.7s ease-in forwards}
.loss{position:absolute;right:26px;bottom:134px;font-weight:800;color:var(--down);font-size:20px;animation:billup2 1.5s ease-out forwards}
.cartel{position:absolute;left:50%;top:15%;transform:translate(-50%,-160%);background:linear-gradient(180deg,#ff6b6b,#d03b55);color:#fff;padding:14px 18px;border-radius:14px;font-weight:800;font-size:14px;line-height:1.25;letter-spacing:.6px;text-align:center;max-width:86vw;box-shadow:0 14px 34px rgba(0,0,0,.35);animation:cartel 2.8s ease forwards}
@keyframes boom{from{transform:scale(.3);opacity:.9}to{transform:scale(2.4);opacity:0}}
@keyframes fly{0%{opacity:1;transform:translate(0,0) rotate(0)}70%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--rot))}}
@keyframes billup{0%{opacity:1;transform:translate(-50%,-50%)}100%{opacity:0;transform:translate(-50%,-140%)}}
@keyframes billup2{0%{opacity:1}100%{opacity:0;transform:translateY(-46px)}}
@keyframes steal{0%{right:-90px;opacity:0}18%{right:22px;opacity:1}72%{right:22px;opacity:1}100%{right:-100px;opacity:0}}
@keyframes cartel{0%{transform:translate(-50%,-160%)}12%{transform:translate(-50%,0) rotate(-2deg)}20%{transform:translate(-50%,0) rotate(2deg)}26%{transform:translate(-50%,0)}80%{transform:translate(-50%,0)}100%{transform:translate(-50%,-170%)}}
.fx.quiet *{animation:none!important}
.fx.quiet .cartel{transform:translate(-50%,0)}
.fx.quiet .thief{right:22px;opacity:1}
</style>`;

if (!html.includes('</style>')) throw new Error('No encontrado: cierre de estilos');
html = html.replace('</style>', () => estilos);

/* 7. Recalcular el hash de la CSP para el script inline */
const script = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/);
if (!script) throw new Error('No encontrado: script inline');
const hash = crypto.createHash('sha256').update(script[1], 'utf8').digest('base64');
const cspAntes = html.match(/script-src 'sha256-([^']+)'/);
if (!cspAntes) throw new Error('No encontrado: hash en la CSP');
html = html.replace(cspAntes[1], hash);

fs.writeFileSync(archivo, html);
console.log('parche aplicado:', archivo);
console.log('  tamano:', antes, '->', html.length);
console.log('  hash CSP:', cspAntes[1].slice(0, 12) + '... ->', hash.slice(0, 12) + '...');
