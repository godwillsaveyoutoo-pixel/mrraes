/*
  Mr Raes — gedeelde bewijs-helper (v2025.10.27 patched+dyscalc)
  Eén bestand voor alle spellen (1B & 2B) om een PNG-bewijsje te genereren
  en/of een tabellaire export te downloaden. Inclusief normalisatie van naam/klas/gameId
  en nette DPI-schaal voor scherpe afbeeldingen.

  Publieke API (window.MR_SHARED):
  - MR_SHARED.finishSession(summary:Object): Promise<{blob, filename}>
  - MR_SHARED.trySharedProof(summary:Object): boolean   // safe wrapper
  - MR_SHARED.cert.downloadTable(opts:Object): void     // tabellaire PNG-export
  - MR_SHARED.version: string
  - MR_SHARED.normalizeSummary(raw:Object): Object      // kan je in spellen hergebruiken
  - MR_SHARED.modeLabel(mode:string): string            // 'vrij'|'taak'|'toets' → label
  - MR_SHARED.format: { dateTime, duration }
  - MR_SHARED.askName(modeOrOpts[, opts]) → Promise<string | {name, class, flags:{...}}>

  Vereiste velden in summary (losjes — er zijn fallbacks):
  {
    name?, class?, gameId?, mode?, seconds?, score?, total?,
    goals?: string[] | string,                    // ✅ ondersteund & behouden
    flags?: { dyscalculie?: boolean, ... },       // ✅ nieuw
    accommodations?: string[],                    // ✅ nieuw
    questions?: Array<{ q?, correct?, given?, a?, ok?, points?, secs? } | string>
  }
*/
(function initMRShared(global){
  if (global.MR_SHARED && global.MR_SHARED.__lock) return; // enkel 1x

  const MR_SHARED = global.MR_SHARED || (global.MR_SHARED = {});
  MR_SHARED.__lock = true;
  MR_SHARED.version = '2025.10.27-compat+dyscalc';

  // ------------------------ Helpers ------------------------
  const TZO = 'Europe/Brussels';
  const fmtDT = new Intl.DateTimeFormat('nl-BE', {
    timeZone: TZO, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });

  function formatDateTimeBE(d){ return fmtDT.format(d); }
  function formatDurationSec(s){
    s = Math.max(0, Math.round(Number(s)||0));
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    return (h>0? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${m}:${String(ss).padStart(2,'0')}`);
  }
  function safe(str){ return String(str==null?'':str).trim(); }
  function onlyDigits(x){ return String(x==null?'':x).replace(/[^0-9]/g,''); }
  function fileSafe(x){ return safe(x).replace(/[\/:*?"<>|]/g,'').slice(0,80); }

  function takeTitleOrPath(){
    const fromMeta = document.querySelector('meta[name="x-game-id"]')?.content || '';
    if (fromMeta.trim()) return fromMeta.trim();
    const title = document.title || '';
    if (title.trim()) return title.trim();
    const path = location.pathname.split('/').pop()||'';
    return path.replace(/\?.*$/, '').replace(/#.*$/, '');
  }

  function modeLabel(m){
    const key = safe(m).toLowerCase();
    if (key.startsWith('toet')) return 'toets';
    if (key.startsWith('taa') || key === 'task') return 'taak';
    if (key === 'oefen' || key === 'free' || key === 'vrij' || key==='practice') return 'vrij';
    return key || 'vrij';
  }

  function normalizeSummary(raw = {}){
    const name = safe(raw.name || raw.playerName || raw.student || raw.studentName || localStorage.getItem('mr_name'));
    const klas = safe(raw.class || raw.klas || raw.group || localStorage.getItem('mr_class'));

    const metaGameId = safe(document.querySelector('meta[name="x-game-id"]')?.content);
    const constGameId = safe(global.GAME_ID);
    const fromUrl = safe((location.pathname.split('/').pop()||'').replace(/\.html?$/,''));
    const fromTitle = safe(document.title);
    const gameId = safe(raw.gameId || metaGameId || constGameId || fromUrl || fromTitle);

    // Mode normaliseren
    const mode = modeLabel(raw.mode);

    const seconds = Math.max(0, Math.round(Number(raw.seconds)||0));
    const score = Number(raw.score)||0;
    const total = Number(raw.total)|| (Array.isArray(raw.questions)? raw.questions.length : 0);
    const questions = Array.isArray(raw.questions) ? raw.questions.slice() : [];

    // ✅ Goals normaliseren (backwards-compatible): array van strings
    let goals = [];
    if (Array.isArray(raw.goals)) goals = raw.goals.filter(Boolean).map(String);
    else if (raw.goals) goals = String(raw.goals).split(/[,\s]+/).filter(Boolean);

    // ✅ Flags / accommodations (optioneel)
    const flags = (raw.flags && typeof raw.flags === 'object') ? {...raw.flags} : {};
    let accommodations = Array.isArray(raw.accommodations) ? raw.accommodations.map(String) : [];
    if (!accommodations.length && flags.dyscalculie) accommodations = ['dyscalculie'];

    return { ...raw, name, class: klas, gameId, mode, seconds, score, total, questions, goals, flags, accommodations };
  }

  // Text wrap helper for canvas
  function wrapText(ctx, text, x, y, maxWidth, lineHeight){
    const words = String(text||'').split(/\s+/);
    let line = '', outY = y; const lines = [];
    for (let n=0; n<words.length; n++){
      const test = line ? line + ' ' + words[n] : words[n];
      if (ctx.measureText(test).width > maxWidth && n>0){
        lines.push(line); outY += lineHeight; line = words[n];
      } else { line = test; }
    }
    lines.push(line);
    lines.forEach((ln, i) => ctx.fillText(ln, x, y + i*lineHeight));
    return outY + lineHeight; // bottom y of last line
  }

  function drawRoundedRect(ctx, x, y, w, h, r){
    r = Math.max(0, Math.min(r, Math.min(w,h)/2));
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y,   x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x,   y+h, r);
    ctx.arcTo(x,   y+h, x,   y,   r);
    ctx.arcTo(x,   y,   x+w, y,   r);
    ctx.closePath();
  }

  function mkCanvas(W, H){
    const DPR = Math.ceil(global.devicePixelRatio||1);
    const c = document.createElement('canvas');
    c.width = Math.ceil(W*DPR); c.height = Math.ceil(H*DPR);
    c.style.width = W+'px'; c.style.height = H+'px';
    const ctx = c.getContext('2d');
    ctx.scale(DPR, DPR);
    return { c, ctx, DPR };
  }

  function downloadBlob(blob, filename){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  function tickOrCross(ctx, x, y, ok){
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = ok ? '#10b981' : '#ef4444';
    if (ok){
      ctx.beginPath(); ctx.moveTo(x-8, y); ctx.lineTo(x-1, y+7); ctx.lineTo(x+10, y-8); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(x-8, y-8); ctx.lineTo(x+8, y+8); ctx.moveTo(x+8, y-8); ctx.lineTo(x-8, y+8); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------ Core: PNG bewijs ------------------------
  function buildCertificatePNG(summary){
    const S = normalizeSummary(summary||{});
    const rows = S.questions || []; // geen slice of limiet!

    // — Naam met label indien dyscalculie actief —
    const dys = !!(S.flags && S.flags.dyscalculie) || (Array.isArray(S.accommodations) && S.accommodations.includes('dyscalculie'));
    const dispName = (S.name || '—') + (dys ? ' (dyscalculie)' : '');

    // Layout metrics
    const W = 1200;
    const top = 40;
    const left = 40;
    const rowH = 44;            // tabelrij hoogte
    const baseH = 560;          // vaste kop/metadata ruimte
    const H = Math.max(780, baseH + rows.length * rowH);

    const { c, ctx } = mkCanvas(W, H);

    // Background
    const grad = ctx.createLinearGradient(0,0,W,H);
    grad.addColorStop(0,'#f7f9fc');
    grad.addColorStop(1,'#fbfdff');
    ctx.fillStyle = grad; ctx.fillRect(0,0,W,H);

    // Header titel
    ctx.fillStyle = '#0b132b';
    ctx.font = '900 28px Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.fillText('Bewijsje — '+(S.gameId || 'Spel'), left, top+10);

    // Meta blok
    ctx.font = '600 18px Inter, system-ui, Arial';
    const metaY = top + 50;

    // ✅ Doelen samenvatting
    const goalsLine = (Array.isArray(S.goals) && S.goals.length) ? S.goals.join(', ') : '—';
    // ✅ Aanpassingen
    const accLine = (Array.isArray(S.accommodations) && S.accommodations.length)
      ? S.accommodations.join(', ')
      : (dys ? 'dyscalculie' : '—');

    const meta = [
      ['Naam',   dispName],
      ['Klas',   S.class||'—'],
      ['Spel-ID', S.gameId||'—'],
      ['Datum',  formatDateTimeBE(new Date())],
      ['Modus',  modeLabel(S.mode)],
      ['Tijd',   formatDurationSec(S.seconds)],
      ['Score',  `${S.score||0}/${S.total||rows.length}`],
      ['Doelen', goalsLine],
      ['Aanpassingen', accLine]
    ];

    const col1x = left, col2x = left + 150;
    let y = metaY;
    meta.forEach(([k,v])=>{
      ctx.fillStyle = '#6b7280'; ctx.fillText(k+':', col1x, y);
      ctx.fillStyle = '#111827'; ctx.fillText(String(v), col2x, y);
      y += 28;
    });

    // Tabel container
    const tabX = left; const tabY = y + 20; const tabW = W - left*2; const tabR = 14;
    const tabH = Math.max(120, 60 + rows.length*rowH);

    // Kaart achtergrond
    ctx.shadowColor = 'rgba(15,23,42,0.06)';
    ctx.shadowBlur = 24; ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#ffffff';
    drawRoundedRect(ctx, tabX, tabY, tabW, tabH, tabR); ctx.fill();
    ctx.shadowColor = 'transparent';

    // Tabel header
    const hY = tabY + 24;
    ctx.font = '700 16px Inter, system-ui, Arial';
    ctx.fillStyle = '#111827';

    // kolombreedtes
    const colNo = 50;                          // #
    const colQ  = Math.floor(tabW*0.52);       // vraag
    const colC  = Math.floor(tabW*0.16);       // correct
    const colG  = Math.floor(tabW*0.16);       // gegeven
    const colR  = tabW - (colNo+colQ+colC+colG); // resultaat icon

    let x = tabX + 20;
    ctx.fillText('#', x, hY); x += colNo;
    ctx.fillText('Vraag', x, hY); x += colQ;
    ctx.fillText('Correct', x, hY); x += colC;
    ctx.fillText('Gegeven', x, hY); x += colG;
    ctx.fillText('✓/✗', x, hY);

    // header bottom rule
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(tabX, tabY+40, tabW, 1);

    // Rijen
    ctx.font = '500 15px Inter, system-ui, Arial';
    let ry = tabY + 40 + 12;
    for (let i=0; i<rows.length; i++){
      const r = rows[i];

      // Support zowel string-rijen als objecten
      const no = String(i+1);
      const q  = typeof r === 'string' ? r : (r.q!=null? String(r.q): '');
      const correct = typeof r === 'string' ? '' : safe(r.correct);
      // ✅ alias: accepteer 'given' of legacy 'a'/'answer'/'gegeven'
      const given   = typeof r === 'string' ? '' : safe(r.given ?? r.a ?? r.answer ?? r.gegeven);
      const ok      = typeof r === 'string' ? null : (r.ok===true || r.ok==='ok' || r.ok===1);

      // zebra background
      if (i%2===1){ ctx.fillStyle = '#f8fafc'; drawRoundedRect(ctx, tabX+2, ry-12, tabW-4, rowH, 6); ctx.fill(); }

      // columns
      let cx = tabX + 20;
      ctx.fillStyle = '#111827';
      ctx.fillText(no, cx, ry); cx += colNo;

      // Vraag wrap
      ctx.fillStyle = '#111827';
      const maxWq = colQ - 16; // padding
      const qBottom = wrapText(ctx, q, cx, ry, maxWq, 18);
      cx += colQ;

      ctx.fillStyle = '#0b132b';
      ctx.fillText(correct, cx, ry); cx += colC;
      ctx.fillStyle = '#374151';
      ctx.fillText(given, cx, ry); cx += colG;

      if (ok!=null){ tickOrCross(ctx, cx+14, ry-6, !!ok); }

      ry = Math.max(ry + rowH, qBottom + 16);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(tabX, ry-12, tabW, 1);
    }

    return c; // caller zet om naar blob & download
  }

  async function finishSession(summary){
    const S = normalizeSummary(summary||{});
    const c = buildCertificatePNG(S);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));

    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}-${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}`;

    // naam met (dyscalculie) in bestandsnaam is ok: zet niet in safeFile filter
    const dys = !!(S.flags && S.flags.dyscalculie) || (Array.isArray(S.accommodations) && S.accommodations.includes('dyscalculie'));
    const nameForFile = (S.name || 'anoniem') + (dys ? ' (dyscalculie)' : '');
    const fname = fileSafe(`${S.gameId||'Spel'} — ${nameForFile} — ${stamp}.png`);
    downloadBlob(blob, fname);

    return { blob, filename: fname };
  }

  function trySharedProof(summary){
    try{
      const maybe = finishSession(summary);
      // niet awaiten; caller mag door
      if (maybe && typeof maybe.then === 'function') maybe.catch(()=>{});
      return true;
    }catch(e){
      console.error('MR_SHARED.trySharedProof failed', e);
      return false;
    }
  }

  // ------------------------ Tabellaire export ------------------------
  // opts: {
  //   meta?: { title?, name?, class?, gameId?, mode?, seconds?, score?, total?, goals?, flags?, accommodations? }
  //   table: { columns: string[], rows: string[][] }
  //   filename?: string
  // }
  async function downloadTable(opts){
    const meta = opts?.meta || {};
    const S = normalizeSummary(meta);

    const cols = (opts?.table?.columns || ['#','Vraag','Correct','Gegeven','✓/✗']).slice();
    const rows = Array.isArray(opts?.table?.rows) ? opts.table.rows.slice() : [];

    // layout
    const W = 1200; const rowH = 40; const baseH = 520; const H = Math.max(760, baseH + rows.length*rowH);
    const { c, ctx } = mkCanvas(W,H);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,W,H);

    // header/meta
    ctx.fillStyle = '#0b132b'; ctx.font = '900 28px Inter, system-ui, Arial';
    ctx.fillText('Bewijsje — '+(S.gameId||'Spel'), 40, 50);

    // naam + dyscalc-label
    const dys = !!(S.flags && S.flags.dyscalculie) || (Array.isArray(S.accommodations) && S.accommodations.includes('dyscalculie'));
    const dispName = (S.name || '—') + (dys ? ' (dyscalculie)' : '');

    ctx.font = '600 18px Inter, system-ui, Arial';
    let y = 90;
    const goalsLine = (Array.isArray(S.goals) && S.goals.length) ? S.goals.join(', ') : '—';
    const accLine = (Array.isArray(S.accommodations) && S.accommodations.length)
      ? S.accommodations.join(', ')
      : (dys ? 'dyscalculie' : '—');

    const kv = [
      ['Naam', dispName], ['Klas', S.class||'—'], ['Spel-ID', S.gameId||'—'],
      ['Datum', formatDateTimeBE(new Date())], ['Modus', modeLabel(S.mode)], ['Tijd', formatDurationSec(S.seconds)],
      ['Score', `${S.score||0}/${S.total||rows.length}`], ['Doelen', goalsLine], ['Aanpassingen', accLine]
    ];

    kv.forEach(([k,v])=>{ ctx.fillStyle='#6b7280'; ctx.fillText(k+':',40,y); ctx.fillStyle='#111827'; ctx.fillText(String(v), 190, y); y+=26; });

    const tabX=40, tabY=y+16, tabW=W-80; const colW = Math.floor((tabW-40)/cols.length);
    // header row
    ctx.fillStyle = '#111827'; ctx.font = '700 16px Inter, system-ui, Arial';
    cols.forEach((cname,i)=>{ ctx.fillText(String(cname), tabX+20 + i*colW, tabY); });
    ctx.fillStyle='#e5e7eb'; ctx.fillRect(tabX, tabY+10, tabW, 1);

    // rows
    ctx.font = '500 15px Inter, system-ui, Arial';
    let ry = tabY + 34;
    for (let i=0;i<rows.length;i++){
      const r = rows[i];
      if (i%2===1){ ctx.fillStyle='#f8fafc'; drawRoundedRect(ctx, tabX+2, ry-24, tabW-4, rowH, 6); ctx.fill(); }
      ctx.fillStyle='#111827';
      for (let j=0;j<cols.length;j++){
        const cell = r[j]!=null ? String(r[j]) : '';
        ctx.fillText(cell, tabX+20 + j*colW, ry);
      }
      ctx.fillStyle='#e5e7eb'; ctx.fillRect(tabX, ry-14, tabW, 1);
      ry += rowH;
    }

    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}-${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}`;
    const nameForFile = dispName || 'anoniem';
    const fname = fileSafe(opts?.filename || `${S.gameId||'Spel'} — ${nameForFile} — ${stamp}.png`);
    downloadBlob(blob, fname);
  }

  // ------------------------ Expose ------------------------
  MR_SHARED.normalizeSummary = normalizeSummary;
  MR_SHARED.format = { dateTime: formatDateTimeBE, duration: formatDurationSec };
  MR_SHARED.modeLabel = modeLabel;
  MR_SHARED.buildCertificatePNG = buildCertificatePNG; // nuttig voor debug/uitbreiding
  MR_SHARED.finishSession = finishSession;
  MR_SHARED.trySharedProof = trySharedProof;

  function safeFilePart(name){
    const cleaned = String(name==null?'':name)
      .trim()
      .replace(/[^\w\s-]+/g,'')
      .replace(/\s+/g,'_')
      .slice(0,80);
    return cleaned || 'leerling';
  }

  function makeMeta(opts){
    const cfg = opts || {};
    const extra = [];
    if (cfg.extra != null){
      if (Array.isArray(cfg.extra)){ extra.push(...cfg.extra.map(String)); }
      else extra.push(String(cfg.extra));
    }
    const scoreValue = cfg.includeScore === false
      ? undefined
      : (cfg.score ?? cfg.ok ?? (cfg.total != null && cfg.total - (cfg.err ?? 0)));

    const dateValue = cfg.includeDate === false
      ? undefined
      : (cfg.date ? new Date(cfg.date) : new Date());

    return {
      name: cfg.name || '-',
      class: cfg.class || cfg.klas || cfg.group || '',
      gameId: cfg.gameId || '',
      mode: modeLabel(cfg.mode),
      score: scoreValue,
      total: cfg.total != null ? cfg.total : (scoreValue != null && cfg.err != null ? scoreValue + cfg.err : undefined),
      seconds: Math.max(0, Math.floor(Number(cfg.seconds)||0)),
      goals: cfg.goals, // doorgeven naar normalizeSummary → buildCertificatePNG
      flags: cfg.flags,
      accommodations: cfg.accommodations,
      date: dateValue,
      extra: extra.length ? extra : undefined
    };
  }

  MR_SHARED.cert = MR_SHARED.cert || {};
  MR_SHARED.cert.safeFilePart = MR_SHARED.cert.safeFilePart || safeFilePart;
  MR_SHARED.cert.makeMeta = MR_SHARED.cert.makeMeta || makeMeta;
  MR_SHARED.cert.downloadTable = downloadTable;

})(window);

// ------- UI helper: naam/klas vragen (met optionele extraFlags) -------
// Usage:
// - MR_SHARED.askName('toets', { extraFlags:[{id:'dyscalculie', label:'Ik heb dyscalculie', checked:true}] })
//   → Promise<{ name, class, flags:{ dyscalculie:true } }>
MR_SHARED.askName = function askName(modeOrOpts='taak', maybeOpts){
  // Normaliseer argumenten
  let mode = 'taak';
  let opts = {};
  if (typeof modeOrOpts === 'string'){ mode = modeOrOpts; opts = maybeOpts || {}; }
  else if (modeOrOpts && typeof modeOrOpts === 'object'){ opts = modeOrOpts; mode = opts.mode || 'taak'; }
  const extraFlags = Array.isArray(opts.extraFlags) ? opts.extraFlags : [];

  return new Promise((resolve)=>{
    // 1) Styles (éénmalig injecteren)
    if (!document.getElementById('mrAskNameStyles')){
      const style = document.createElement('style');
      style.id = 'mrAskNameStyles';
      style.textContent = `
#mrAskBackdrop{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
.mrAskDlg{width:min(560px,94vw);background:#fff;border:1px solid #e6ecf8;border-radius:16px;padding:16px;box-shadow:0 24px 80px rgba(0,0,0,.12)}
.mrAskRow{display:grid;gap:.5rem;grid-template-columns:1fr 1fr}
.mrAskInput{width:100%;padding:10px 12px;border-radius:10px;background:#fff;border:1px solid #e5e7eb;color:#111827;font:600 14px Inter,system-ui,Arial}
.mrAskBtns{display:flex;justify-content:flex-end;gap:.5rem;margin-top:.8rem}
.mrAskBtn{background:#fff;border:1px solid #e6ecf8;border-radius:999px;padding:.35rem .7rem;font:800 14px Inter,system-ui,Arial;cursor:pointer;box-shadow:0 10px 28px rgba(15,23,42,.06)}
.mrAskBtn.primary{background:#2563eb;color:#fff;border-color:#1e40af}
.mrAskFlags{margin-top:.6rem;display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
.mrAskFlag{display:flex;gap:.4rem;align-items:center;font:700 14px Inter,system-ui,Arial;color:#0b132b}
.mrAskFlag input{width:18px;height:18px}
      `;
      document.head.appendChild(style);
    }

    // 2) Backdrop + dialog
    const backdrop = document.createElement('div');
    backdrop.id = 'mrAskBackdrop';
    const flagsHtml = extraFlags.map(f =>
      `<label class="mrAskFlag"><input type="checkbox" data-flag="${String(f.id||'flag').trim()}" ${f.checked?'checked':''}> ${f.label||f.id}</label>`
    ).join('');
    backdrop.innerHTML = `
      <div class="mrAskDlg" role="dialog" aria-modal="true" aria-labelledby="mrAskTitle">
        <h2 id="mrAskTitle" style="margin:0 0 8px;font:900 20px Inter,system-ui,Arial;color:#0b132b">
          ${mode==='toets' ? 'Start toets' : 'Start taak'}
        </h2>
        <p style="margin:.2rem 0 .8rem; color:#6b7280">Vul je naam en klas in en klik <strong>Start</strong>.</p>
        <div class="mrAskRow">
          <input id="mrAskName"  class="mrAskInput" placeholder="Naam" />
          <input id="mrAskClass" class="mrAskInput" placeholder="Klas (bv. 2B)" />
        </div>
        ${extraFlags.length ? `<div class="mrAskFlags">${flagsHtml}</div>` : ``}
        <div class="mrAskBtns">
          <button id="mrAskCancel" class="mrAskBtn">Annuleer</button>
          <button id="mrAskOk"     class="mrAskBtn primary">Start</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    // 3) Prefill + focus
    const inName  = backdrop.querySelector('#mrAskName');
    const inClass = backdrop.querySelector('#mrAskClass');
    inName.value  = (localStorage.getItem('mr_name')  || '').trim();
    inClass.value = (localStorage.getItem('mr_class') || '').trim();
    inName.focus();

    // 4) Handlers
    const cleanup = () => {
      backdrop.removeEventListener('keydown', keyHandler);
      backdrop.remove();
    };
    const cancel = () => { cleanup(); resolve(null); };
    const ok = () => {
      const nm = inName.value.trim();
      if (!nm){ inName.focus(); return; }
      const klas = (inClass.value||'').trim();
      localStorage.setItem('mr_name', nm);
      localStorage.setItem('mr_class', klas);

      const flags = {};
      backdrop.querySelectorAll('[data-flag]').forEach(chk => {
        const id = String(chk.getAttribute('data-flag')||'flag').trim();
        flags[id] = !!chk.checked;
      });

      cleanup();
      // Backwards-compat: als geen extra flags, return alleen de naam (string)
      if (!extraFlags.length) resolve(nm);
      else resolve({ name: nm, class: klas, flags });
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); cancel(); }
      if (e.key === 'Enter'){  e.preventDefault(); ok(); }
    };

    backdrop.querySelector('#mrAskCancel').onclick = cancel;
    backdrop.querySelector('#mrAskOk').onclick     = ok;
    backdrop.addEventListener('keydown', keyHandler);
  });
};