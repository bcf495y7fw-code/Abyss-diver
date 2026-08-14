/* ABYSS DIVER — game + PWA wiring */
(() => {
'use strict';

/* ---------- DOM ---------- */
const $ = s => document.querySelector(s);
const APP_VERSION = '1.0.4';
const canvas = $('#game'), ctx = canvas.getContext('2d');
const hudDepth = $('#hudDepth'), hudPearls = $('#hudPearls'),
      hudAir = $('#hudAir'), hudAirFill = $('#hudAirFill'), heartsEl = $('#hearts');
const menuEl = $('#menu'), overEl = $('#over'), pauseEl = $('#pause');
const overTitle = $('#overTitle'), statDepth = $('#statDepth'),
      statPearls = $('#statPearls'), statBest = $('#statBest'), newBest = $('#newBest');
const toastEl = $('#toast'), installBtn = $('#installBtn'), hurtEl = $('#hurt'),
      menuBest = $('#menuBest');
const soundBtns = [...document.querySelectorAll('[data-sound]')];

/* ---------- utils ---------- */
const rnd  = (a,b) => a + Math.random()*(b-a);
const clamp= (v,a,b) => v<a?a:v>b?b:v;
const lerp = (a,b,t) => a+(b-a)*t;
const hexA = (h,a) => { const n=parseInt(h.slice(1),16);
  return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`; };
const mix  = (a,b,t) => `rgb(${lerp(a[0],b[0],t)|0},${lerp(a[1],b[1],t)|0},${lerp(a[2],b[2],t)|0})`;
const store = {
  get(k,d){ try{ return localStorage.getItem(k) ?? d; }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch{} }
};
const buzz = p => { try{ navigator.vibrate && navigator.vibrate(p); }catch{} };

/* ---------- sizing ---------- */
let W=0, H=0;
function resize(){
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = W*dpr; canvas.height = H*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  P.x = clamp(W*.18, 60, 170);
}
addEventListener('resize', resize);

/* ---------- state ---------- */
const S = { mode:'menu', t:0, depth:0, pearls:0, hearts:3, air:100,
            inv:0, shake:0, speed:150, best:+(store.get('abyss.best','0')||0) };
const P = { x:120, y:200, vy:0, r:15, diving:false, angle:0, prop:0 };

let jellies=[], mines=[], pearlsA=[], bubbles=[], anglers=[],
    parts=[], pops=[], plankton=[];
let spawnT = {jelly:1.6, mine:3, pearl:.9, bubble:1.4, angler:9};
let lastMs=0, trailT=0, menuT={bub:0, jelly:2}, overShown=false;

function seedPlankton(){
  plankton = [];
  for(let i=0;i<70;i++)
    plankton.push({x:Math.random()*W, y:Math.random()*H, z:rnd(.3,1), tw:rnd(0,6.28)});
}

/* ---------- audio (all synthesized) ---------- */
const AudioFX = {
  ctx:null, gain:null, amb:null,
  muted: store.get('abyss.mute','0')==='1',
  init(){
    if(this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : .5;
    this.gain.connect(this.ctx.destination);
  },
  resume(){ if(this.ctx && this.ctx.state==='suspended') this.ctx.resume(); },
  setMuted(m){ this.muted=m; store.set('abyss.mute', m?'1':'0');
    if(this.gain) this.gain.gain.value = m?0:.5; },
  tone(f0,f1,dur,type='sine',vol=.3,delay=0){
    if(!this.ctx) return;
    const t=this.ctx.currentTime+delay;
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type=type;
    o.frequency.setValueAtTime(f0,t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1,1), t+dur);
    g.gain.setValueAtTime(vol,t);
    g.gain.exponentialRampToValueAtTime(.0001, t+dur);
    o.connect(g); g.connect(this.gain);
    o.start(t); o.stop(t+dur+.02);
  },
  noise(dur=.25, vol=.4){
    if(!this.ctx) return;
    const t=this.ctx.currentTime, sr=this.ctx.sampleRate, len=sr*dur;
    const buf=this.ctx.createBuffer(1,len,sr), d=buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*(1-i/len);
    const n=this.ctx.createBufferSource(); n.buffer=buf;
    const f=this.ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value=900;
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(vol,t); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    n.connect(f); f.connect(g); g.connect(this.gain); n.start(t);
  },
  pearl(){ this.tone(880,1760,.12,'sine',.25); this.tone(1320,2200,.14,'sine',.18,.06); },
  bubble(){ this.tone(300,900,.15,'triangle',.2); },
  hit(){ this.noise(.3,.5); this.tone(160,50,.3,'square',.35); },
  over(){ this.tone(440,110,.7,'sawtooth',.22); },
  start(){ this.tone(330,660,.18,'triangle',.25); this.tone(495,990,.18,'triangle',.2,.09); },
  milestone(){ this.tone(700,700,.09,'sine',.14); },
  startAmbient(){
    if(!this.ctx || this.amb) return;
    const o1=this.ctx.createOscillator(), o2=this.ctx.createOscillator(),
          g=this.ctx.createGain(), lfo=this.ctx.createOscillator(), lg=this.ctx.createGain();
    o1.frequency.value=54; o2.frequency.value=54.7;
    g.gain.value=.04; lfo.frequency.value=.08; lg.gain.value=.02;
    lfo.connect(lg); lg.connect(g.gain);
    o1.connect(g); o2.connect(g); g.connect(this.gain);
    o1.start(); o2.start(); lfo.start();
    this.amb={o1,o2,lfo};
  }
};

/* ---------- fx helpers ---------- */
function pop(x,y,text,color='#ffc95c'){ pops.push({x,y,text,color,t:0}); }
function burst(x,y,color,n=10,spd=140){
  for(let i=0;i<n;i++){
    const a=Math.random()*6.283, s=rnd(.3,1)*spd;
    parts.push({kind:'spark',x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,
                life:rnd(.4,.8),t:0,color,r:rnd(1.5,3.5)});
  }
}
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(()=>toastEl.classList.remove('show'), 2600);
}
function flashHurt(){
  hurtEl.classList.add('on');
  setTimeout(()=>hurtEl.classList.remove('on'), 90);
}

/* ---------- spawners ---------- */
const diff = () => clamp(S.depth/900, 0, 1);

function spawnJelly(){
  const base = rnd(H*.18, H*.8);
  jellies.push({x:W+50, y:base, base, r:rnd(12,20), ph:rnd(0,6.28),
                amp:rnd(12,30), hue: Math.random()<.5 ? '#7ef0ff' : '#ff8ad8'});
}
function spawnMine(){
  mines.push({x:W+50, y:rnd(H*.12,H*.88), r:rnd(14,20), rot:rnd(0,6.28), vr:rnd(-.6,.6)});
}
function spawnPearls(){
  const n=3+Math.floor(Math.random()*3), by=rnd(H*.2,H*.8), ph=rnd(0,6.28);
  for(let i=0;i<n;i++)
    pearlsA.push({x:W+50+i*36, y:by+Math.sin(ph+i*.9)*26, r:7, ph:rnd(0,6.28)});
}
function spawnBubble(){
  bubbles.push({x:W+rnd(20,120), y:rnd(H*.35,H*1.05), r:rnd(7,11), vy:rnd(-40,-20)});
}

/* ---------- flow ---------- */
function reset(){
  S.depth=0; S.pearls=0; S.hearts=3; S.air=100; S.inv=0; S.shake=0;
  S.speed=150; lastMs=0; trailT=0;
  P.y=H*.45; P.vy=0; P.diving=false; P.angle=0;
  jellies.length=0; mines.length=0; pearlsA.length=0; bubbles.length=0;
  anglers.length=0; parts.length=0; pops.length=0;
  spawnT={jelly:1.6, mine:3, pearl:.9, bubble:1.4, angler:9};
}
function startGame(){
  AudioFX.init(); AudioFX.resume();
  reset();
  S.mode='playing'; overShown=false;
  menuEl.hidden=true; overEl.hidden=true; pauseEl.hidden=true;
  document.body.dataset.mode='playing';
  AudioFX.start(); AudioFX.startAmbient();
}
function toMenu(){
  S.mode='menu';
  jellies.length=0; mines.length=0; pearlsA.length=0; bubbles.length=0;
  anglers.length=0; pops.length=0;
  menuEl.hidden=false; overEl.hidden=true; pauseEl.hidden=true;
  document.body.dataset.mode='menu';
  menuBest.innerHTML = `Best depth — <b>${S.best} m</b>`;
}
function togglePause(){
  if(S.mode==='playing'){
    S.mode='paused'; P.diving=false;
    pauseEl.hidden=false; document.body.dataset.mode='paused';
    AudioFX.ctx && AudioFX.ctx.suspend();
  } else if(S.mode==='paused'){
    S.mode='playing'; pauseEl.hidden=true;
    document.body.dataset.mode='playing';
    AudioFX.resume();
  }
}
function die(cause){
  S.mode='dead'; P.diving=false;
  burst(P.x,P.y,'#ff6b57',26,260);
  burst(P.x,P.y,'#ffc95c',18,200);
  for(let i=0;i<12;i++)
    parts.push({kind:'bub',x:P.x+rnd(-14,14),y:P.y+rnd(-10,10),
                r:rnd(2,5),t:0,life:rnd(1,2),seed:rnd(0,6)});
  S.shake=22; AudioFX.over(); buzz([90,60,140]);
  const prev=S.best, dep=Math.floor(S.depth);
  if(dep>S.best){ S.best=dep; store.set('abyss.best',String(dep)); }
  overTitle.textContent = cause==='air' ? 'OUT OF AIR' : 'HULL BREACH';
  statDepth.textContent = dep+'m';
  statPearls.textContent = S.pearls;
  statBest.textContent = S.best+'m';
  newBest.hidden = dep<=prev;
  setTimeout(()=>{ if(S.mode==='dead'){ overEl.hidden=false; overShown=true; } }, 650);
}
function hurt(){
  S.hearts--; S.inv=1.9; S.shake=15;
  flashHurt(); AudioFX.hit(); buzz([70,50,90]);
  burst(P.x,P.y,'#ff6b57',14,180);
  if(S.hearts<=0) die('hull');
}

/* ---------- update ---------- */
function updatePlayer(dt){
  const acc = P.diving ? 640 : -420;          // thrust down vs buoyancy up
  P.vy += acc*dt; P.vy -= P.vy*1.1*dt;
  P.vy = clamp(P.vy, -380, 380);
  P.y += P.vy*dt;
  const top=70, bot=H-P.r-6;
  if(P.y<top){ P.y=top; P.vy*=-.3; }
  if(P.y>bot){ P.y=bot; P.vy*=-.3; }
  P.angle = lerp(P.angle, clamp(P.vy/700,-.45,.45), 1-Math.pow(.001,dt));
  P.prop += dt*(10 + (P.diving?8:0));

  trailT -= dt;
  if(trailT<=0){
    trailT=.16;
    parts.push({kind:'bub',x:P.x-24,y:P.y+rnd(-4,4),r:rnd(1.5,3.5),
                t:0,life:rnd(.8,1.4),seed:rnd(0,6)});
  }
}

function worldStep(dt, spd, live){
  const d = diff();
  for(let i=jellies.length-1;i>=0;i--){ const j=jellies[i];
    j.x -= spd*.92*dt; j.y = j.base + Math.sin(S.t*1.5+j.ph)*j.amp;
    if(j.x<-70) jellies.splice(i,1); }
  for(let i=mines.length-1;i>=0;i--){ const m=mines[i];
    m.x -= spd*dt; m.rot += m.vr*dt;
    if(m.x<-60) mines.splice(i,1); }
  for(let i=pearlsA.length-1;i>=0;i--){ const p=pearlsA[i];
    p.x -= spd*dt; if(p.x<-30) pearlsA.splice(i,1); }
  for(let i=bubbles.length-1;i>=0;i--){ const b=bubbles[i];
    b.x -= spd*.85*dt; b.y += b.vy*dt;
    if(b.x<-40 || b.y<-30) bubbles.splice(i,1); }
  for(let i=anglers.length-1;i>=0;i--){ const a=anglers[i];
    if(a.state==='warn'){ a.t+=dt;
      if(live && a.t>.95){ a.state='dash'; a.vx=-(560+260*d); } }
    else { a.x += a.vx*dt; if(a.x<-90) anglers.splice(i,1); } }

  if(!live) return;

  /* spawns */
  spawnT.jelly-=dt; if(spawnT.jelly<=0){ spawnJelly(); spawnT.jelly=lerp(2.4,1.05,d)*rnd(.7,1.3); }
  spawnT.mine -=dt; if(spawnT.mine<=0 && S.depth>120){ spawnMine(); spawnT.mine=lerp(3.4,1.5,d)*rnd(.7,1.3); }
  spawnT.pearl-=dt; if(spawnT.pearl<=0){ spawnPearls(); spawnT.pearl=rnd(1.6,2.8); }
  spawnT.bubble-=dt; if(spawnT.bubble<=0){ spawnBubble(); spawnT.bubble=lerp(3.1,2.1,d)*rnd(.8,1.4); }
  spawnT.angler-=dt; if(spawnT.angler<=0 && S.depth>450){
    anglers.push({state:'warn',t:0,y:clamp(P.y+rnd(-60,60),80,H-80),x:W+60,vx:0});
    spawnT.angler=rnd(6,11);
  }

  /* pickups */
  for(let i=pearlsA.length-1;i>=0;i--){ const p=pearlsA[i];
    if(Math.hypot(p.x-P.x,p.y-P.y) < P.r+12){
      pearlsA.splice(i,1); S.pearls++;
      pop(p.x,p.y-14,'+1','#f2fbff'); burst(p.x,p.y,'#f2fbff',8,110);
      AudioFX.pearl(); buzz(15);
    } }
  for(let i=bubbles.length-1;i>=0;i--){ const b=bubbles[i];
    if(Math.hypot(b.x-P.x,b.y-P.y) < P.r+b.r+4){
      bubbles.splice(i,1); S.air=clamp(S.air+30,0,100);
      pop(b.x,b.y-14,'+AIR','#4fe3c1'); burst(b.x,b.y,'#6fd9ff',8,110);
      AudioFX.bubble(); buzz(10);
    } }

  /* hazards */
  if(S.inv<=0){
    for(const j of jellies) if(Math.hypot(j.x-P.x,j.y-P.y) < j.r*.85+P.r*.8){ hurt(); break; }
    if(S.inv<=0) for(const m of mines) if(Math.hypot(m.x-P.x,m.y-P.y) < m.r*1.05+P.r*.75){ hurt(); break; }
    if(S.inv<=0) for(const a of anglers) if(a.state==='dash' && Math.hypot(a.x-P.x,a.y-P.y) < 18+P.r*.8){ hurt(); break; }
  }
}

function updateParts(dt){
  for(let i=parts.length-1;i>=0;i--){ const p=parts[i]; p.t+=dt;
    if(p.t>=p.life){ parts.splice(i,1); continue; }
    if(p.kind==='bub'){
      p.y -= (26+p.r*9)*dt;
      p.x += Math.sin(p.t*5+p.seed)*10*dt;
      if(S.mode==='playing') p.x -= S.speed*.35*dt;
    } else {
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.vx *= (1-2.2*dt); p.vy *= (1-2.2*dt);
      if(S.mode==='playing') p.x -= S.speed*.4*dt;
    } }
  for(let i=pops.length-1;i>=0;i--){ pops[i].t+=dt; if(pops[i].t>1.05) pops.splice(i,1); }
}

function menuAmbient(dt){
  P.x=clamp(W*.18,60,170);
  P.y=H*.48+Math.sin(S.t*1.3)*16;
  P.angle=Math.sin(S.t*.9)*.06;
  P.prop+=dt*7;
  menuT.bub-=dt; if(menuT.bub<=0){ menuT.bub=rnd(.35,.7);
    parts.push({kind:'bub',x:P.x-24,y:P.y+rnd(-5,5),r:rnd(1.5,3.5),t:0,life:rnd(.9,1.6),seed:rnd(0,6)}); }
  menuT.jelly-=dt; if(menuT.jelly<=0){ menuT.jelly=rnd(3,5.5); spawnJelly(); }
  worldStep(dt, 26, false);
}

function update(dt){
  if(S.mode==='paused') return;
  S.t += dt;

  const scroll = S.mode==='playing' ? S.speed : S.mode==='dead' ? 40 : 30;
  for(const p of plankton){
    p.x -= (scroll*.22*p.z+4)*dt;
    if(p.x<-6){ p.x=W+6; p.y=Math.random()*H; }
  }
  updateParts(dt);
  S.shake = Math.max(0, S.shake-34*dt);

  if(S.mode==='menu'){ menuAmbient(dt); return; }
  if(S.mode==='dead'){ worldStep(dt, 40, false); return; }

  /* playing */
  const d = diff();
  S.speed = 150 + 200*d + Math.max(0,S.depth-900)*.05;
  S.depth += S.speed*dt*.06;
  const ms = Math.floor(S.depth/250);
  if(ms>lastMs && S.depth>50){ lastMs=ms;
    pop(P.x+50,P.y-34,(ms*250)+'m','#7ef0ff'); AudioFX.milestone(); }

  updatePlayer(dt);
  worldStep(dt, S.speed, true);

  S.air -= dt*(1.3 + 1.1*d);
  if(S.air<=0){ S.air=0; die('air'); }
  S.inv = Math.max(0, S.inv-dt);
}

/* ---------- drawing ---------- */
function drawBG(){
  const f = clamp(S.depth/1100,0,1);
  const g = ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,  mix([16,104,128],[6,15,32],f));
  g.addColorStop(.6, mix([7,52,74],[3,9,20],f));
  g.addColorStop(1,  mix([3,30,48],[1,3,9],f));
  ctx.fillStyle=g; ctx.fillRect(-40,-40,W+80,H+80);
}
function drawRays(){
  const f = 1-clamp(S.depth/380,0,1);
  if(f<=0) return;
  ctx.save(); ctx.globalCompositeOperation='lighter';
  for(let i=0;i<5;i++){
    const sp=.006+(i%3)*.003;
    const x=(((i*.23)+S.t*sp)%1.3-.15)*W;
    const w=W*(.045+.02*(i%2));
    const g=ctx.createLinearGradient(0,0,0,H*.9);
    g.addColorStop(0,`rgba(170,230,255,${.12*f})`);
    g.addColorStop(1,'rgba(170,230,255,0)');
    ctx.fillStyle=g; ctx.beginPath();
    ctx.moveTo(x,0); ctx.lineTo(x+w,0);
    ctx.lineTo(x+w*2.6+90,H*.9); ctx.lineTo(x+w*1.6-40,H*.9);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function drawPlankton(){
  for(const p of plankton){
    const a=.14+.22*(.5+.5*Math.sin(S.t*1.8+p.tw));
    ctx.fillStyle=`rgba(159,232,255,${a*p.z})`;
    ctx.fillRect(p.x,p.y,p.z*2.2,p.z*2.2);
  }
}
function drawJelly(j){
  const s=1+Math.sin(S.t*3+j.ph)*.08;
  ctx.save(); ctx.translate(j.x,j.y); ctx.scale(s,2-s);
  ctx.shadowColor=j.hue; ctx.shadowBlur=16;
  ctx.fillStyle=hexA(j.hue,.28); ctx.strokeStyle=hexA(j.hue,.9); ctx.lineWidth=2;
  ctx.beginPath();
  ctx.arc(0,0,j.r,Math.PI,0);
  ctx.quadraticCurveTo(j.r*.6,j.r*.5,0,j.r*.45);
  ctx.quadraticCurveTo(-j.r*.6,j.r*.5,-j.r,0);
  ctx.fill(); ctx.stroke();
  ctx.shadowBlur=0;
  ctx.strokeStyle=hexA(j.hue,.6); ctx.lineWidth=1.6;
  for(let k=0;k<4;k++){
    const bx=(k-1.5)*j.r*.5, sway=Math.sin(S.t*3.2+j.ph+k)*j.r*.35;
    ctx.beginPath(); ctx.moveTo(bx,j.r*.25);
    ctx.bezierCurveTo(bx+sway*.4,j.r*.9, bx-sway*.4,j.r*1.4, bx+sway,j.r*1.9);
    ctx.stroke();
  }
  ctx.restore();
}
function drawMine(m){
  ctx.save(); ctx.translate(m.x,m.y); ctx.rotate(m.rot);
  ctx.strokeStyle='#2c4152'; ctx.lineWidth=3;
  for(let k=0;k<10;k++){
    const a=k*Math.PI/5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*m.r*.75, Math.sin(a)*m.r*.75);
    ctx.lineTo(Math.cos(a)*m.r*1.3, Math.sin(a)*m.r*1.3);
    ctx.stroke();
  }
  const g=ctx.createRadialGradient(-m.r*.3,-m.r*.3,2,0,0,m.r);
  g.addColorStop(0,'#22384a'); g.addColorStop(1,'#0c1620');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,m.r,0,6.283); ctx.fill();
  ctx.strokeStyle='#2c4152'; ctx.lineWidth=2; ctx.stroke();
  const blink=.4+.6*Math.abs(Math.sin(S.t*5+m.rot*3));
  ctx.fillStyle=`rgba(255,107,87,${blink})`;
  ctx.shadowColor='#ff6b57'; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.arc(0,0,m.r*.18,0,6.283); ctx.fill();
  ctx.restore();
}
function drawPearl(p){
  const y=p.y+Math.sin(S.t*2.4+p.ph)*3;
  ctx.save();
  ctx.shadowColor='#eafcff'; ctx.shadowBlur=14;
  ctx.fillStyle='#f6feff'; ctx.beginPath(); ctx.arc(p.x,y,p.r,0,6.283); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='rgba(120,180,200,.45)';
  ctx.beginPath(); ctx.arc(p.x+2,y+2,p.r*.55,0,6.283); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.arc(p.x-2.5,y-2.5,1.8,0,6.283); ctx.fill();
  ctx.restore();
}
function drawBubblePickup(b){
  ctx.strokeStyle='rgba(170,235,255,.9)'; ctx.lineWidth=1.5;
  ctx.fillStyle='rgba(140,220,255,.1)';
  ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,6.283); ctx.fill(); ctx.stroke();
  ctx.strokeStyle='rgba(255,255,255,.85)';
  ctx.beginPath(); ctx.arc(b.x-b.r*.25,b.y-b.r*.25,b.r*.5,Math.PI*1.1,Math.PI*1.6); ctx.stroke();
}
function drawAnglers(){
  for(const a of anglers){
    if(a.state==='warn'){
      const p=(a.t%.5)/.5;
      ctx.save(); ctx.translate(W-30,a.y);
      ctx.strokeStyle=`rgba(255,107,87,${.9-.5*p})`; ctx.lineWidth=3;
      ctx.beginPath(); ctx.arc(0,0,14+p*10,0,6.283); ctx.stroke();
      ctx.fillStyle='#ff6b57'; ctx.font='16px Bungee, sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('!',0,1);
      ctx.restore();
    } else {
      ctx.save(); ctx.translate(a.x,a.y);
      ctx.strokeStyle='rgba(174,255,220,.8)'; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(-16,-8); ctx.quadraticCurveTo(-26,-20,-34,-16); ctx.stroke();
      ctx.fillStyle='#ccffe9'; ctx.shadowColor='#9fffd8'; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(-34,-16,3,0,6.283); ctx.fill();
      ctx.shadowBlur=0;
      ctx.fillStyle='#0d1822'; ctx.strokeStyle='#22384a'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.ellipse(0,0,20,11,0,0,6.283); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(18,0); ctx.lineTo(30,-8); ctx.lineTo(30,8); ctx.closePath(); ctx.fill();
      ctx.fillStyle='#ff6b57';
      ctx.beginPath(); ctx.arc(-9,-3,2,0,6.283); ctx.fill();
      ctx.restore();
    }
  }
}
function drawPlayer(){
  const blink = S.inv>0 && Math.floor(S.t*14)%2===0;
  ctx.save(); ctx.translate(P.x,P.y); ctx.rotate(P.angle);
  if(blink) ctx.globalAlpha=.35;

  const f=clamp(S.depth/1100,0,1), ba=.08+.2*f;       // headlamp, stronger deeper
  const g=ctx.createLinearGradient(16,0,260,0);
  g.addColorStop(0,`rgba(255,241,196,${ba})`);
  g.addColorStop(1,'rgba(255,241,196,0)');
  ctx.fillStyle=g; ctx.beginPath();
  ctx.moveTo(16,-3); ctx.lineTo(260,-44); ctx.lineTo(260,44); ctx.lineTo(16,7);
  ctx.closePath(); ctx.fill();

  ctx.save(); ctx.translate(-27,0);                    // spinning prop
  const s=Math.sin(P.prop);
  ctx.fillStyle='#c98f2b';
  ctx.beginPath(); ctx.ellipse(0,0,3,11*Math.max(.15,Math.abs(s)),0,0,6.283); ctx.fill();
  ctx.restore();

  const hg=ctx.createLinearGradient(0,-14,0,14);       // hull
  hg.addColorStop(0,'#ffdb8a'); hg.addColorStop(1,'#e2972f');
  ctx.fillStyle=hg; ctx.strokeStyle='#8a5c14'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.ellipse(0,0,22,13,0,0,6.283); ctx.fill(); ctx.stroke();

  ctx.fillStyle='#e8a33d'; ctx.beginPath();            // sail
  ctx.moveTo(-6,-11); ctx.lineTo(1,-19); ctx.lineTo(8,-10);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle='#bfefff'; ctx.strokeStyle='#0e5f74'; ctx.lineWidth=2.5;
  ctx.beginPath(); ctx.arc(7,-1,6.5,0,6.283); ctx.fill(); ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,.85)';
  ctx.beginPath(); ctx.arc(5,-3,2,0,6.283); ctx.fill();

  ctx.fillStyle='#fff6d8';
  ctx.beginPath(); ctx.arc(19,2,2.6,0,6.283); ctx.fill();
  ctx.restore();
}
function drawParts(){
  for(const p of parts){
    const k=1-p.t/p.life;
    if(p.kind==='bub'){
      ctx.strokeStyle=`rgba(190,240,255,${.7*k})`; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.283); ctx.stroke();
    } else {
      ctx.fillStyle=hexA(p.color,.9*k);
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.283); ctx.fill();
    }
  }
}
function drawPops(){
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.font='13px Bungee, sans-serif';
  for(const p of pops){
    const k=1-p.t/1.05;
    ctx.fillStyle=hexA(p.color, Math.min(1,k*1.4));
    ctx.fillText(p.text, p.x, p.y - p.t*34);
  }
}
function draw(){
  const sh=S.shake;
  ctx.save();
  ctx.translate((Math.random()-.5)*sh, (Math.random()-.5)*sh);
  drawBG(); drawRays(); drawPlankton();
  for(const b of bubbles) drawBubblePickup(b);
  for(const p of pearlsA) drawPearl(p);
  for(const m of mines) drawMine(m);
  drawAnglers();
  for(const j of jellies) drawJelly(j);
  if(S.mode!=='dead') drawPlayer();
  drawParts(); drawPops();
  ctx.restore();
}

/* ---------- HUD ---------- */
function syncHUD(){
  hudDepth.textContent = Math.floor(S.depth)+'m';
  hudPearls.textContent = S.pearls;
  hudAirFill.style.width = clamp(S.air,0,100)+'%';
  hudAir.classList.toggle('low', S.air<28 && S.mode==='playing');
  [...heartsEl.children].forEach((h,i)=>h.classList.toggle('lost', i>=S.hearts));
}

/* ---------- input ---------- */
function pressDown(e){ if (e.cancelable) e.preventDefault(); AudioFX.init(); AudioFX.resume(); if(S.mode==='playing') P.diving=true; }
function pressUp(){ P.diving=false; }

canvas.addEventListener('pointerdown', pressDown);
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointerup', pressUp);
addEventListener('pointercancel', pressUp);
addEventListener('keydown', e=>{
  if(e.code==='Space'||e.code==='ArrowDown'){ e.preventDefault(); if(!e.repeat) pressDown(); }
  if(e.code==='KeyP') togglePause();
  if(e.code==='Enter'){
    if(S.mode==='menu') startGame();
    else if(S.mode==='dead' && overShown) startGame();
  }
});
addEventListener('keyup', e=>{
  if(e.code==='Space'||e.code==='ArrowDown') pressUp();
});
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden && S.mode==='playing') togglePause();
});

$('#btnStart').addEventListener('click', startGame);
$('#btnAgain').addEventListener('click', startGame);
$('#btnMenu').addEventListener('click', toMenu);
$('#btnQuit').addEventListener('click', toMenu);
$('#btnResume').addEventListener('click', togglePause);
$('#btnPause').addEventListener('click', togglePause);

/* sound toggle */
function setSoundUI(){
  soundBtns.forEach(b=>{
    b.classList.toggle('off', AudioFX.muted);
    b.textContent = AudioFX.muted ? '✕' : '♪';
  });
}
soundBtns.forEach(b=>b.addEventListener('click', e=>{
  e.stopPropagation();
  AudioFX.init();
  AudioFX.setMuted(!AudioFX.muted);
  setSoundUI();
}));
setSoundUI();

/* ---------- PWA: install prompt ---------- */
let deferredPrompt=null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  deferredPrompt=e;
  if(!standalone) installBtn.hidden=false;
});
installBtn.addEventListener('click', async ()=>{
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  const {outcome} = await deferredPrompt.userChoice;
  if(outcome==='accepted') installBtn.hidden=true;
  deferredPrompt=null;
});
addEventListener('appinstalled', ()=>{
  installBtn.hidden=true;
  toast('Installed — play offline anytime ⚓');
});

/* ---------- PWA: service worker ---------- */
if('serviceWorker' in navigator){
  addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').then(()=>{
      if(!sessionStorage.getItem('abyss.sw')){
        sessionStorage.setItem('abyss.sw','1');
        setTimeout(()=>toast('Ready — playable offline'), 900);
      }
    }).catch(()=>{});
  });
}

/* ---------- boot ---------- */
resize();
seedPlankton();
toMenu();

let last=performance.now();
function frame(now){
  const dt=Math.min((now-last)/1000, 1/30);
  last=now;
  update(dt);
  draw();
  syncHUD();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

})();
