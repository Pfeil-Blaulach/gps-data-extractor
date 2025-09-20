// main.js
// Zuständig für: Upload-Dialog, Datei lesen, parseGpx() aufrufen, Tabelle rendern, CSV-Export
// Parsing steckt in ./parsers/gpxParser.js

import { parseGpx } from './gpxparser.js';

// ---- DOM-Refs ----
const uploadBtn = byId('uploadBtn');
const fileInput  = byId('fileInput');
const statusEl   = byId('status');
const tableHost  = byId('tableHost');
const dlCsv      = byId('downloadCsv');

// ---- Events ----
uploadBtn?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  resetUI();
  info(`Lese Datei: ${file.name} …`);

  try {
    // Minimaler Typ-/Endungs-Check (nicht sicherheitskritisch, nur UX)
    const isLikelyGpx = /\.gpx$/i.test(file.name) || file.type.includes('xml') || file.type.includes('text');
    if (!isLikelyGpx) {
      warn('Hinweis: Die Datei wirkt nicht wie eine GPX/XML – ich versuche es trotzdem …');
    }

    const text = await file.text();
    validateXmlPlausibility(text);

    const rows = parseGpx(text); // [{lat,lon,ele,time}, ...]
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Keine Trackpunkte (trkpt) gefunden.');
    }

    // Normiere Spalten (falls mal ele/time fehlen)
    const normalized = rows.map(r => ({
      lat: toNumOrEmpty(r.lat),
      lon: toNumOrEmpty(r.lon),
      ele: toNumOrEmpty(r.ele),
      time: r.time ?? ''
    }));

    renderTable(normalized);
    prepareCsv(normalized);
    ok(`OK: ${normalized.length} Punkte geladen.`);
  } catch (err) {
    console.error(err);
    error(`Fehler: ${err?.message ?? err}`);
    clearTable();
    hideCsv();
  } finally {
    // Reset für wiederholte Uploads derselben Datei
    if (fileInput) fileInput.value = '';
  }
});

// ---- UI Helpers ----
function byId(id) { return document.getElementById(id); }

function resetUI() {
  if (statusEl) statusEl.textContent = '';
}

function setStatus(text, cls) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = cls || ''; // Optional: in CSS farblich differenzieren
}
const info  = (t) => setStatus(t, 'msg info');
const ok    = (t) => setStatus(t, 'msg ok');
const warn  = (t) => setStatus(t, 'msg warn');
const error = (t) => setStatus(t, 'msg error');

// ---- Table rendering ----
function renderTable(rows) {
  if (!tableHost) return;
  if (!rows?.length) {
    tableHost.innerHTML = '<p class="subtle">Keine Daten gefunden.</p>';
    return;
  }
  const cols = Object.keys(rows[0]);

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  cols.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // Performance: Fragment für große Tabellen
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      td.textContent = safeCell(r[c]);
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  table.appendChild(tbody);

  tableHost.innerHTML = '';
  tableHost.appendChild(table);
}

function clearTable() {
  if (tableHost) tableHost.innerHTML = '';
}

function safeCell(v) {
  if (v === null || v === undefined) return '';
  // Kleine Formatierung: Zahlen kompakt anzeigen
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 7 signifikante Stellen reichen für Koordinaten und Höhen
    return Number(v.toPrecision(7)).toString();
  }
  return String(v);
}

// ---- CSV ----
function toCsv(rows) {
  if (!rows?.length) return '';
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const needQuotes = /[",\n;]/.test(s);
    const esc = s.replace(/"/g, '""');
    return needQuotes ? `"${esc}"` : esc;
  };
  const head = cols.map(escape).join(',');
  const body = rows.map(r => cols.map(c => escape(r[c])).join(',')).join('\n');
  return head + '\n' + body;
}

function prepareCsv(rows) {
  if (!dlCsv) return;
  const csv = toCsv(rows);
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8' }); // BOM für Excel
  const url = URL.createObjectURL(blob);
  dlCsv.href = url;
  dlCsv.download = suggestCsvName() + '.csv';
  dlCsv.hidden = false;
}

function hideCsv() {
  if (dlCsv) {
    dlCsv.hidden = true;
    dlCsv.removeAttribute('href');
  }
}

function suggestCsvName() {
  // Versuche Datum/Uhrzeit aus der Seite (Header) oder fallback auf "geodaten"
  // Du kannst das leicht anpassen, z.B. GPX-<YYYYMMDD-HHMM>
  const header = document.querySelector('header h1')?.textContent?.trim();
  const base = header && header.length < 60 ? header : 'geodaten';
  return base.replace(/\s+/g, '_').toLowerCase();
}

// ---- Validation / Plausibility ----
function validateXmlPlausibility(text) {
  if (!text || text.length < 20) throw new Error('Datei ist leer oder zu kurz.');
  // Minimalcheck: <gpx ...> vorhanden?
  if (!/<gpx[\s>]/i.test(text)) {
    // Nicht hart abbrechen – manche Dateien sind ohne Präambel, aber Hinweis geben:
    warn('Hinweis: Kein <gpx>-Tag gefunden – ist dies wirklich eine GPX-Datei?');
  }
}

function toNumOrEmpty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}
