// main.js
// Zuständig für: Upload-Dialog, Datei lesen, parseGpx() aufrufen,
// Tabelle rendern (mit Spalten-Whitelist), CSV-Export in DE-Format (; + ,)

import { parseGpx } from './gpxparser.js';

// byId gleich nach oben (robust, klar lesbar)
function byId(id) { return document.getElementById(id); }

// Fallback-Init, falls das Modul früher lädt als erwartet
document.addEventListener('DOMContentLoaded', () => {
  try { typeof initControls === 'function' && initControls(); } catch {}
});


// ---- Sichtbare Spalten (Reihenfolge & Benennung) ----
const VISIBLE_COLS = [
  //'Lat',
  //'Lon',
  'Datum',
  'Uhrzeit',
  'Zeit t seit Start [s]',
  'Δt zum Vorpunkt [s]',
  'Δs zum Vorpunkt [m]',
  'Gesamtstrecke s [m]',
  'Höhe h [m]',
];

// ---- DOM-Refs ----
const uploadBtn = byId('uploadBtn');
const fileInput  = byId('fileInput');
const statusEl   = byId('status');
const tableHost  = byId('tableHost');
const dlCsv      = byId('downloadCsv');

// Slider/Buttons
const ctrlBox    = byId('controls');
const vSliderEl  = byId('vSlider');
const tSliderEl  = byId('tSlider');
const eSliderEl  = byId('eSlider');
const kSliderEl  = byId('kSlider');
const vValueEl   = byId('vValue');
const tValueEl   = byId('tValue');
const eValueEl   = byId('eValue');
const kValueEl   = byId('kValue');
const applyBtn   = byId('applySimplify');

// ===  ===
const proModeEl     = byId('proMode');
const modeFieldset  = byId('modeFieldset');
const modeKEl       = byId('modeK');
const modeEEl       = byId('modeE');

const vRow          = byId('vRow');
const tRow          = byId('tRow');
const eRow          = byId('eRow');
const kRow          = byId('kRow');

// ---- State ----
let simplMode = 'k'; // 'k' (Anzahl Punkte) oder 'eps' (Max. Abweichung)
let originalRows = [];   // ungefiltert (aus Parser)
let currentRows  = [];   // evtl. vereinfacht
let defaults     = null; // { v0, tau0, eps0 }
let parameters      = { v:1, t:1, e:1, k:10 };

uploadBtn?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  resetUI();
  info(`Lese Datei: ${file.name} …`);
  try {
    const text = await file.text();
    validateXmlPlausibility(text);

    // Parser liefert bereits dt0, dtPrev, ds und s kumuliert
    originalRows = parseGpx(text);
    if (!Array.isArray(originalRows) || originalRows.length === 0) {
      throw new Error('Keine Trackpunkte (trkpt) gefunden.');
    }

    // NEW: Defaults aus Daten berechnen
    defaults = computeDefaults(originalRows);   // { v0, tau0, eps0 }

    const { tArr, sArr } = extractTS(originalRows);
    refreshKSliderBounds(tArr, sArr, {
      vThresh: defaults.v0 * Number(vSliderEl.value || 1),
      tau:     defaults.tau0 * Number(tSliderEl.value || 1),
    });

    // Startzustand der UI
    if (modeKEl) modeKEl.checked = true;
    if (modeEEl) modeEEl.checked = false;
    simplMode = 'k';
    updateVisibilityFromState();

    updateSliderLabels();  // Zahlen neben den Slidern anzeigen                    
    ctrlBox.hidden = false;                     // UI sichtbar
    updateVisibilityFromState();                // ⬅️ NEU: Sichtbarkeiten sauber setzen


    // Startansicht: noch nicht vereinfacht
    currentRows = originalRows;
    renderTable(currentRows);
    prepareCsv(currentRows);

    ok(`OK: ${currentRows.length} Punkte geladen.`);
  } catch (err) {
    console.error(err);
    error(`Fehler: ${err?.message ?? err}`);
    clearTable();
    hideCsv();
    ctrlBox.hidden = true;
    originalRows = currentRows = [];
  } finally {
    if (fileInput) fileInput.value = '';
  }
});

// NEW: Slider reagieren live (Labels updaten)
[vSliderEl, tSliderEl, eSliderEl].forEach(inp => {
  inp?.addEventListener('input', () => {
    parameters.v = Number(vSliderEl.value);
    parameters.t = Number(tSliderEl.value);
    parameters.e = Number(eSliderEl.value);
    parameters.k = Number(kSliderEl.value);  // bleibt vorerst hier ungenutzt
    updateSliderLabels();
    // Wenn v/t sich ändert, ändern sich die Pflichtpunkte -> K-Bounds neu setzen
    if (originalRows.length && defaults) {
      const { tArr, sArr } = extractTS(originalRows);
      const opts = {
        vThresh: defaults.v0 * parameters.v,
        tau:     defaults.tau0 * parameters.t,
      };
      refreshKSliderBounds(tArr, sArr, opts);
    }
  });
});

// NEU: K-Slider eigenes Event
kSliderEl?.addEventListener('input', () => {
  parameters.k = Number(kSliderEl.value);
  if (kValueEl) kValueEl.textContent = kSliderEl.value;
});

// Profimodus umschalten
proModeEl?.addEventListener('change', () => {
  const pro = !!proModeEl.checked;
  if (!pro) {
    // Profimodus AUS: Radiowahl auf "K", v/t/ε resetten
    if (modeKEl) modeKEl.checked = true;
    if (modeEEl) modeEEl.checked = false;
    setSimplMode('k');
    resetProDefaults();
  } else {
    // Profimodus EIN: aktuelle Radiowahl übernehmen (Default: K)
    setSimplMode(modeKEl?.checked ? 'k' : 'eps');
  }
});

// Radiobuttons (Art der Vereinfachung)
modeKEl?.addEventListener('change', () => {
  if (modeKEl.checked) setSimplMode('k');
});
modeEEl?.addEventListener('change', () => {
  if (modeEEl.checked) setSimplMode('eps');
});

// Vereinfachung anwenden -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
applyBtn?.addEventListener('click', () => {
  if (!originalRows?.length || !defaults) return;

  const vThresh = defaults.v0  * Number(vSliderEl?.value || 1);
  const tau     = defaults.tau0* Number(tSliderEl?.value || 1);
  const eps     = defaults.eps0* Number(eSliderEl?.value || 1);
  const K       = Number(kSliderEl?.value || parameters.k || 50);

  const { tArr, sArr } = extractTS(originalRows);

  // K-Grenzen sicherheitshalber frisch (falls v/t geändert)
  refreshKSliderBounds(tArr, sArr, { vThresh, tau });

  let keepIdx;
  if (!proModeEl?.checked || simplMode === 'k') {
    // Einfacher Modus ODER Profimodus + "Anzahl Datenpunkte"
    keepIdx = simplifyForST_K(tArr, sArr, K, { vThresh, tau, eps, timeToMeters: 0.1 });
  } else {
    // Profimodus + "Maximale Abweichung"
    keepIdx = simplifyForST(tArr, sArr, { vThresh, tau, eps, timeToMeters: 0.1 });
  }

  currentRows = originalRows.filter((_, i) => keepIdx.includes(i));
  renderTable(currentRows);
  prepareCsv(currentRows);

  const modeStr = (!proModeEl?.checked || simplMode==='k') ? `K=${K}` : `ε≈${roundN(eps)} m`;
  //info(`Vereinfacht: ${currentRows.length}/${originalRows.length} – ${modeStr}, vₜₕ=${roundN(vThresh)} m/s, τ=${roundN(tau)} s`);
  //info(`Vereinfacht: ${currentRows.length} Punkte (von ${originalRows.length}) – vThresh=${fmt(vThresh)} m/s, τ=${fmt(tau)} s, ε=${fmt(eps)} m`);
  //info(`Vereinfacht: ${currentRows.length} Punkte (von ${originalRows.length}) – vThresh=${fmt(vThresh)} m/s, τ=${fmt(tau)} s`);
  info(`${modeStr}: Vereinfacht auf ${currentRows.length} Datenpunkte (von ${originalRows.length})`);
});

// ---- UI Helpers & Rendering (wie zuvor) ----
function byId(id) { return document.getElementById(id); }
function resetUI() { if (statusEl) statusEl.textContent = ''; }
function setStatus(text, cls) { if (!statusEl) return; statusEl.textContent = text; statusEl.className = cls || ''; }
const info  = (t) => setStatus(t, 'msg info');
const ok    = (t) => setStatus(t, 'msg ok');
const warn  = (t) => setStatus(t, 'msg warn');
const error = (t) => setStatus(t, 'msg error');

// Sichtbarkeiten gemäß Profimodus & Radiowahl
function updateVisibilityFromState() {
  const pro = !!proModeEl?.checked;

  modeFieldset.hidden = !pro;
  vRow.hidden = !pro;
  tRow.hidden = !pro;

  if (!pro) {
    // Einfacher Modus: nur K sichtbar
    eRow.hidden = true;
    kRow.hidden = false;
    return;
  }

  // Profimodus aktiv: je nach Radiobutton
  if (simplMode === 'k') {
    kRow.hidden = false;
    eRow.hidden = true;
  } else {
    kRow.hidden = true;
    eRow.hidden = false;
  }
}

// Profimodus aus → v/t/ε auf Default (Faktor 1), Labels/Bereiche updaten (K bleibt)
function resetProDefaults() {
  if (vSliderEl) vSliderEl.value = '1';
  if (tSliderEl) tSliderEl.value = '1';
  if (eSliderEl) eSliderEl.value = '1';

  parameters.v = 1;
  parameters.t = 1;
  parameters.e = 1;

  if (typeof updateSliderLabels === 'function') updateSliderLabels();

  // K-Bounds hängen von vThresh/tau ab → neu setzen (falls Daten vorhanden)
  if (typeof defaults !== 'undefined' && defaults && originalRows?.length) {
    const { tArr, sArr } = extractTS(originalRows);
    refreshKSliderBounds(tArr, sArr, {
      vThresh: defaults.v0 * 1,
      tau:     defaults.tau0 * 1,
    });
  }
}

function setSimplMode(mode) {
  simplMode = mode; // 'k' | 'eps'
  updateVisibilityFromState();
}


function renderTable(rows) {
  if (!tableHost) return;
  if (!rows?.length) { tableHost.innerHTML = '<p class="subtle">Keine Daten gefunden.</p>'; return; }
  const cols = VISIBLE_COLS.filter(c => c in rows[0]);
  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; trh.appendChild(th); });
  thead.appendChild(trh); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    cols.forEach(c => { const td = document.createElement('td'); td.textContent = safeCell(r[c]); tr.appendChild(td); });
    frag.appendChild(tr);
  });
  tbody.appendChild(frag); table.appendChild(tbody);
  tableHost.innerHTML = ''; tableHost.appendChild(table);
}
function clearTable() { if (tableHost) tableHost.innerHTML = ''; }
function safeCell(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return v.toLocaleString('de-DE', { maximumFractionDigits: 3 });
  return String(v);
}

function roundN(x, n = 1) {
  return Number.isFinite(x) ? Number(x.toFixed(n)) : '';
}
// CSV (DE-freundlich)
function toCsv(rows) {
  if (!rows?.length) return '';
  const cols = VISIBLE_COLS.filter(c => c in rows[0]);
  const sep = ';';
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && Number.isFinite(v)) return v.toLocaleString('de-DE', { maximumFractionDigits: 10 });
    const s = String(v); const needQuotes = /["\n;]/.test(s); const esc = s.replace(/"/g, '""');
    return needQuotes ? `"${esc}"` : esc;
  };
  const head = cols.map(escape).join(sep);
  const body = rows.map(r => cols.map(c => escape(r[c])).join(sep)).join('\n');
  return head + '\n' + body;
}
function prepareCsv(rows) {
  if (!dlCsv) return;
  const csv = toCsv(rows);
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  dlCsv.href = url; dlCsv.download = suggestCsvName() + '.csv'; dlCsv.hidden = false;
}
function hideCsv() { if (dlCsv) { dlCsv.hidden = true; dlCsv.removeAttribute('href'); } }
function suggestCsvName() {
  const header = document.querySelector('header h1')?.textContent?.trim();
  const base = header && header.length < 60 ? header : 'geodaten';
  return base.replace(/\s+/g, '_').toLowerCase();
}
function validateXmlPlausibility(text) {
  if (!text || text.length < 20) throw new Error('Datei ist leer oder zu kurz.');
  if (!/<gpx[\s>]/i.test(text)) warn('Hinweis: Kein <gpx>-Tag gefunden – ist dies wirklich eine GPX-Datei?');
}

// ========= NEW: Default-Berechnung, Vereinfachung, Hilfen =========

// Defaultwerte nach Datenlage
function computeDefaults(rows) {
  const n = rows.length;
  const tArr = rows.map(r => num(r['Zeit t seit Start [s]']));
  const sArr = rows.map(r => num(r['Gesamtstrecke s [m]']));
  let vmax = 0;
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-9, tArr[i] - tArr[i-1]);
    const ds = Math.max(0, sArr[i] - sArr[i-1]);
    vmax = Math.max(vmax, ds / dt);
  }
  const totalT = tArr[n-1] - tArr[0];
  const totalS = sArr[n-1] - sArr[0];
  return {
    v0: 0.01 * vmax,   // 1 % von v_max
    tau0: 0.01 * totalT, // 1 % von Gesamtdauer
    eps0: 0.01 * totalS, // 1 % von Gesamtstrecke
  };
}

// Slider-Labels updaten
function updateSliderLabels() {
  if (!defaults) return;
  const vThresh = roundN(defaults.v0 * Number(vSliderEl.value || 1));
  const tau     = roundN(defaults.tau0 * Number(tSliderEl.value || 1));
  const eps     = roundN(defaults.eps0 * Number(eSliderEl.value || 1));
  if (vValueEl) vValueEl.textContent = fmt(vThresh);
  if (tValueEl) tValueEl.textContent = fmt(tau);
  if (eValueEl) eValueEl.textContent = fmt(eps);
  if (kValueEl && kSliderEl) kValueEl.textContent = kSliderEl.value; // NEU
}
function fmt(x) { return Number(x).toLocaleString('de-DE', { maximumFractionDigits: 3 }); }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

// aus Rows die t- und s-Arrays extrahieren
function extractTS(rows) {
  return {
    tArr: rows.map(r => num(r['Zeit t seit Start [s]'])),
    sArr: rows.map(r => num(r['Gesamtstrecke s [m]'])),
  };
}

// Vereinfachung mit fixer Zielanzahl K (globales Greedy über einen Max-Heap) -------------------------------------------------------------------------------------------------------------------------------
function refreshKSliderBounds(tArr, sArr, { vThresh, tau }) {
  if (!kSliderEl) return;
  const minKeep = countMandatoryPoints(tArr, sArr, { vThresh, tau });
  const n = Math.min(tArr.length, sArr.length);

  // Grenzen setzen
  kSliderEl.min = Math.max(2, minKeep);
  kSliderEl.max = n;

  // aktuellen/gewünschten Wert einklemmen
  const wanted = Number(kSliderEl.value) || Math.round(n * 0.10);
  const clamped = Math.max(minKeep, Math.min(n, wanted));
  kSliderEl.value = String(clamped);
  parameters.k = clamped;
  if (kValueEl) kValueEl.textContent = kSliderEl.value;
}

function countMandatoryPoints(t, s, { vThresh=0.2, tau=10 } = {}) {
  const n = Math.min(t.length, s.length);
  if (n <= 2) return n;

  // v[i] zwischen i-1 und i
  const v = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-9, t[i] - t[i-1]);
    const ds = Math.max(0, s[i] - s[i-1]);
    v[i] = ds / dt;
  }

  // Stopps finden
  const stopSegments = [];
  for (let i = 1; i < n;) {
    if (v[i] < vThresh) {
      let j = i + 1;
      while (j < n && v[j] < vThresh) j++;
      const dtSeg = t[j-1] - t[i-1];
      if (dtSeg >= tau) stopSegments.push([i-1, j-1]);
      i = j;
    } else i++;
  }

  // Pflichtpunkte: Start/Ende + alle Stopp-Grenzen
  const keep = new Array(n).fill(false);
  keep[0] = keep[n-1] = true;
  for (const [a,b] of stopSegments) { keep[a] = true; keep[b] = true; }
  return keep.reduce((acc, v) => acc + (v ? 1 : 0), 0);
}

function simplifyForST_K(t, s, K, { vThresh=0.2, tau=10, eps=3, timeToMeters=0.1 } = {}) {
  const n = Math.min(t.length, s.length);
  if (n <= 2) return [...Array(n).keys()];

  // 1) Geschwindigkeiten und Stopps bestimmen (wie bisher)
  const v = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-9, t[i] - t[i-1]);
    const ds = Math.max(0, s[i] - s[i-1]);
    v[i] = ds / dt;
  }
  const stopSegments = [];
  let i = 1;
  while (i < n) {
    if (v[i] < vThresh) {
      let j = i + 1;
      while (j < n && v[j] < vThresh) j++;
      const dtSeg = t[j-1] - t[i-1];
      if (dtSeg >= tau) stopSegments.push([i-1, j-1]);
      i = j;
    } else i++;
  }

  // Pflichtpunkte: Start/Ende + Stop-Grenzen
  const keep = new Array(n).fill(false);
  keep[0] = true; keep[n-1] = true;
  for (const [a,b] of stopSegments) { keep[a] = true; keep[b] = true; }

  // Helper: senkrechter Abstand im skalierten s–(k·t)-Koordinatensystem
  const k = timeToMeters;
  function perpDist(i, a, b) {
    const ax = t[a] * k, ay = s[a];
    const bx = t[b] * k, by = s[b];
    const px = t[i] * k, py = s[i];
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
    const u = ((px - ax) * dx + (py - ay) * dy) / (dx*dx + dy*dy);
    const qx = ax + u * dx, qy = ay + u * dy;
    return Math.hypot(px - qx, py - qy);
  }

  // Max-Abweichung und Index auf einem [a,b]-Intervall
  function maxDev(a, b) {
    if (b <= a + 1) return { idx: -1, d: 0 };
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(i, a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    return { idx, d: maxD };
  }

  // Bewegungs-Abschnittsgrenzen konstruieren
  const bounds = [0, ...stopSegments.flat(), n-1].sort((a,b)=>a-b);

  // 2) Max-Heap über alle anfänglichen Bewegungssegmente
  class MaxHeap {
    constructor() { this.a = []; }
    push(x) { this.a.push(x); this._up(this.a.length-1); }
    pop() { 
      if (this.a.length === 0) return null;
      const top = this.a[0];
      const last = this.a.pop();
      if (this.a.length) { this.a[0] = last; this._down(0); }
      return top;
    }
    peek(){ return this.a.length ? this.a[0] : null; }
    _up(i){ 
      while (i>0){ 
        const p=(i-1>>1);
        if (this.a[p].d >= this.a[i].d) break;
        [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i=p;
      }
    }
    _down(i){
      for(;;){
        let l=i*2+1, r=l+1, m=i;
        if (l<this.a.length && this.a[l].d>this.a[m].d) m=l;
        if (r<this.a.length && this.a[r].d>this.a[m].d) m=r;
        if (m===i) break;
        [this.a[m], this.a[i]] = [this.a[i], this.a[m]]; i=m;
      }
    }
    get size(){ return this.a.length; }
  }
  const heap = new MaxHeap();

  // Hilfsfunktion: Segment in den Heap legen (nur Bewegungssegmente)
  function pushSeg(a, b) {
    if (b <= a + 1) return;
    // Wenn [a,b] exakt ein Stopp-Segment ist, nicht vereinfachen
    if (stopSegments.some(([x,y]) => x===a && y===b)) return;
    const { idx, d } = maxDev(a, b);
    if (idx >= 0) heap.push({ a, b, idx, d });
  }

  // Startsegmente einwerfen
  for (let kbi = 0; kbi < bounds.length - 1; kbi++) {
    const L = bounds[kbi], R = bounds[kbi+1];
    // Grenzen merken (werden ohnehin durch keep-Flags gesichert)
    keep[L] = true; keep[R] = true;
    // Nur Bewegungssegmente in den Heap
    pushSeg(L, R);
  }

  // Wie viele Punkte sind „Pflicht“?
  let keepCount = keep.reduce((acc,v)=>acc+(v?1:0), 0);

  // Ziel-K an Pflichtpunkten ausrichten
  const minKeep = keepCount;
  if (K < minKeep) K = minKeep;                 // kann man alternativ auch zurückmelden
  if (K > n) K = n;

  // 3) Globales Greedy: immer die größte Abweichung verfeinern, bis K Punkte erreicht
  while (keepCount < K && heap.size) {
    const seg = heap.pop();
    const { a, b, idx, d } = seg;
    if (idx < 0 || d <= 0) continue;
    if (keep[idx]) {
      // schon gesetzt? Dann nur die Splits neu evaluieren
      pushSeg(a, idx);
      pushSeg(idx, b);
      continue;
    }
    keep[idx] = true;
    keepCount++;

    // Neue Teilsegmente in den Heap
    pushSeg(a, idx);
    pushSeg(idx, b);
  }

  // Falls Heap leer ist, aber K noch nicht erreicht:
  // (selten) fülle gleichmäßig auf, ohne Struktur kaputt zu machen
  if (keepCount < K) {
    // nützliche Kandidaten sind die Mitte größerer Lücken
    const idxs = [];
    for (let p = 0; p < n; p++) if (keep[p]) idxs.push(p);
    while (keepCount < K) {
      let bestGap = -1, bestMid = -1, bestL = -1, bestR = -1;
      for (let j = 0; j < idxs.length - 1; j++) {
        const L = idxs[j], R = idxs[j+1];
        const gap = R - L;
        if (gap > bestGap) {
          bestGap = gap;
          bestMid = Math.floor((L + R) / 2);
          bestL = L; bestR = R;
        }
      }
      if (bestGap <= 1 || bestMid < 0) break;
      keep[bestMid] = true;
      keepCount++;
      // aktualisiere die Lückenliste
      idxs.splice(idxs.indexOf(bestL)+1, 0, bestMid);
    }
  }

  // Ergebnis-Indices
  const idx = [];
  for (let p = 0; p < n; p++) if (keep[p]) idx.push(p);
  return idx;
}


// Vereinfachung mit Stopp-Schutz ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- 
function simplifyForST(t, s, { vThresh=0.2, tau=10, eps=3, timeToMeters=0.1 } = {}) {
  const n = Math.min(t.length, s.length);
  if (n <= 2) return [...Array(n).keys()];

  // v[i] zwischen i-1 und i
  const v = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(1e-9, t[i] - t[i-1]);
    const ds = Math.max(0, s[i] - s[i-1]);
    v[i] = ds / dt;
  }

  // Stopps (v < vThresh) mit Gesamtdauer >= tau
  const stopSegments = [];
  let i = 1;
  while (i < n) {
    if (v[i] < vThresh) {
      let j = i + 1;
      while (j < n && v[j] < vThresh) j++;
      const dtSeg = t[j-1] - t[i-1];
      if (dtSeg >= tau) stopSegments.push([i-1, j-1]);
      i = j;
    } else i++;
  }

  const keep = new Array(n).fill(false);
  keep[0] = keep[n-1] = true;
  for (const [a,b] of stopSegments) { keep[a] = true; keep[b] = true; }

  // Bewegungs-Segmente finden (zwischen Stopp-Grenzen)
  const bounds = [0, ...stopSegments.flat(), n-1].sort((a,b)=>a-b);
  for (let k = 0; k < bounds.length - 1; k++) {
    const L = bounds[k], R = bounds[k+1];
    const isStop = stopSegments.some(([a,b]) => a===L && b===R);
    if (isStop) continue; // Stopp-Abschnitt: nur Grenzen
    douglasPeuckerOnRange(t, s, L, R, keep, eps, timeToMeters);
  }

  const idx = [];
  for (let p = 0; p < n; p++) if (keep[p]) idx.push(p);
  return idx;
}
function douglasPeuckerOnRange(t, s, L, R, keep, eps, k) {
  if (R <= L + 1) { keep[L] = true; keep[R] = true; return; }
  keep[L] = true; keep[R] = true;

  function perpDist(i, a, b) {
    const ax = t[a] * k, ay = s[a];
    const bx = t[b] * k, by = s[b];
    const px = t[i] * k, py = s[i];
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
    const u = ((px - ax) * dx + (py - ay) * dy) / (dx*dx + dy*dy);
    const qx = ax + u * dx, qy = ay + u * dy;
    return Math.hypot(px - qx, py - qy);
  }
  function simplify(a, b) {
    if (b <= a + 1) return;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(i, a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep[idx] = true; simplify(a, idx); simplify(idx, b); }
  }
  simplify(L, R);
}

// ---- INIT: Controls auf Startzustand setzen ----
function initControls() {
  // Profimodus AUS als Start
  if (proModeEl) proModeEl.checked = false;

  // Radiowahl auf "Anzahl Datenpunkte"
  if (modeKEl) modeKEl.checked = true;
  if (modeEEl) modeEEl.checked = false;
  simplMode = 'k';

  // Labels initial befüllen
  if (kValueEl && kSliderEl) kValueEl.textContent = kSliderEl.value;

  // Sichtbarkeit gemäß Zustand herstellen
  updateVisibilityFromState();
}

// Direkt beim Laden ausführen
initControls();
