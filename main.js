// main.js
// Zuständig für: Upload-Dialog, Datei lesen, parseGpx() aufrufen,
// Tabelle rendern (mit Spalten-Whitelist), CSV-Export in DE-Format (; + ,)

import { parseGpx } from './parsers/gpxparser.js';

// ---- Sichtbare Spalten (Reihenfolge & Benennung) ----
const VISIBLE_COLS = [
  'Lat',
  'Lon',
  'Datum',
  'Uhrzeit',
  'Δt seit Start [s]',
  'Δt zum Vorpunkt [s]',
  'ds zum Vorpunkt [m]',
  's kumuliert [m]',
  'Höhe [m]',
];

// ---- DOM-Refs ----
const uploadBtn = byId('uploadBtn');
const fileInput  = byId('fileInput');
const statusEl   = byId('status');
const tableHost  = byId('tableHost');
const dlCsv      = byId('downloadCsv');

// (optional) Falls du Regler für Filter hast:
// const thrDistEl = byId('thrDist');    // Meter
// const thrTimeEl = byId('thrTime');    // Sekunden

uploadBtn?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  resetUI();
  info(`Lese Datei: ${file.name} …`);

  try {
    const text = await file.text();
    validateXmlPlausibility(text);

    // Optional: Filter aus UI lesen
    // const distThr = Number(thrDistEl?.value || 0);
    // const timeThr = Number(thrTimeEl?.value || 0);

    const rows = parseGpx(text, {
      // distThresholdMeters: distThr,
      // timeThresholdSeconds: timeThr,
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Keine Trackpunkte (trkpt) gefunden.');
    }

    renderTable(rows);
    prepareCsv(rows);
    ok(`OK: ${rows.length} Punkte geladen.`);
  } catch (err) {
    console.error(err);
    error(`Fehler: ${err?.message ?? err}`);
    clearTable();
    hideCsv();
  } finally {
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
  statusEl.className = cls || '';
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
  const cols = VISIBLE_COLS.filter(c => c in rows[0]);

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
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    // DE-Format: Dezimalkomma, begrenze Anzeige sinnvoll
    return v.toLocaleString('de-DE', { maximumFractionDigits: 3 });
  }
  return String(v);
}

// ---- CSV (DE-Excel-freundlich) ----
function toCsv(rows) {
  if (!rows?.length) return '';
  const cols = VISIBLE_COLS.filter(c => c in rows[0]);
  const sep = ';'; // Semikolon als Feldtrenner (DE)

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v.toLocaleString('de-DE', { maximumFractionDigits: 10 });
    }
    const s = String(v);
    const needQuotes = /["\n;]/.test(s);
    const esc = s.replace(/"/g, '""');
    return needQuotes ? `"${esc}"` : esc;
  };

  const head = cols.map(escape).join(sep);
  const body = rows.map(r => cols.map(c => escape(r[c])).join(sep)).join('\n');
  return head + '\n' + body;
}

function prepareCsv(rows) {
  if (!dlCsv) return;
  const csv = toCsv(rows);
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8' }); // UTF-8 mit BOM
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
  const header = document.querySelector('header h1')?.textContent?.trim();
  const base = header && header.length < 60 ? header : 'geodaten';
  return base.replace(/\s+/g, '_').toLowerCase();
}

// ---- Validation ----
function validateXmlPlausibility(text) {
  if (!text || text.length < 20) throw new Error('Datei ist leer oder zu kurz.');
  if (!/<gpx[\s>]/i.test(text)) {
    warn('Hinweis: Kein <gpx>-Tag gefunden – ist dies wirklich eine GPX-Datei?');
  }
}
