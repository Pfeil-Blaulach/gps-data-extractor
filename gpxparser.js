// parsers/gpxparser.js
// Liest GPX (trk->trkseg->trkpt) und gibt ein Array mit genau deinen Spalten zurück:
// A Lat | B Lon | C Datum | D Uhrzeit | E Δt seit Start [s] | F Δt zum Vorpunkt [s]
// G ds zum Vorpunkt [m] | H s kumuliert [m] | I Höhe [m]
//
// Optionale Filter (wie zuvor):
// parseGpx(xml, { distThresholdMeters: <m>, timeThresholdSeconds: <s> })

export function parseGpx(xmlText, options = {}) {
  const { distThresholdMeters = 0, timeThresholdSeconds = 0 } = options;

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Ungültiges XML/GPX.');
  }

  const pts = [...doc.getElementsByTagName('trkpt')];
  if (pts.length === 0) return [];

  // Rohpunkte einlesen
  const raw = pts.map(pt => {
    const lat = Number(pt.getAttribute('lat'));
    const lon = Number(pt.getAttribute('lon'));
    const ele = Number(pt.getElementsByTagName('ele')[0]?.textContent ?? '');
    const timeStr = pt.getElementsByTagName('time')[0]?.textContent ?? '';
    const tSec = timeStr ? Date.parse(timeStr) / 1000 : NaN; // UTC -> Sekunden
    return { lat, lon, ele, timeStr, tSec };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (raw.length === 0) return [];

  // Vor/Nachbar-Deltas (für Filter)
  const n = raw.length;
  const dsPrev = new Array(n).fill(0);
  const dsNext = new Array(n).fill(0);
  const dtPrev = new Array(n).fill(0);
  const dtNext = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      dsPrev[i] = haversineMeters(raw[i - 1].lat, raw[i - 1].lon, raw[i].lat, raw[i].lon);
      dtPrev[i] = diffSec(raw[i - 1].tSec, raw[i].tSec);
    }
    if (i < n - 1) {
      dsNext[i] = haversineMeters(raw[i].lat, raw[i].lon, raw[i + 1].lat, raw[i + 1].lon);
      dtNext[i] = diffSec(raw[i].tSec, raw[i + 1].tSec);
    } else {
      dsNext[i] = Number.POSITIVE_INFINITY;
      dtNext[i] = Number.POSITIVE_INFINITY;
    }
  }

  // Filtern (Endpunkte bleiben)
  const keep = raw.map((_, i) => {
    if (i === 0 || i === n - 1) return true;
    const condDist = (Math.abs(dsPrev[i]) < distThresholdMeters) && (Math.abs(dsNext[i]) < distThresholdMeters);
    const condTime = (dtPrev[i] < timeThresholdSeconds) && (dtNext[i] < timeThresholdSeconds);
    return !(condDist || condTime);
  });

  const filtered = raw.filter((_, i) => keep[i]);
  if (filtered.length === 0) return [];

  // Ausgabe berechnen (Zeitzone Europe/Berlin)
  const out = [];
  let sCum = 0;
  const t0 = filtered[0].tSec;

  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i];
    const prev = i > 0 ? filtered[i - 1] : null;

    const ds_m = prev ? haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon) : 0;
    sCum += ds_m;

    const dt0_s   = Number.isFinite(cur.tSec) && Number.isFinite(t0) ? (cur.tSec - t0) : 0;
    const dtPrev_s= prev && Number.isFinite(cur.tSec) && Number.isFinite(prev.tSec) ? (cur.tSec - prev.tSec) : 0;

    const { datePart, timePart } = toBerlinParts(cur.timeStr);

    out.push({
      'Lat': cur.lat,
      'Lon': cur.lon,
      'Datum': datePart,                 // Europe/Berlin
      'Uhrzeit': timePart,               // Europe/Berlin
      'Zeit t seit Start [s]': roundN(dt0_s, 3),
      'Δt zum Vorpunkt [s]': roundN(dtPrev_s, 3),
      'ds zum Vorpunkt [m]': roundN(ds_m, 3),
      'Gesamtstrecke s [m]': roundN(sCum, 3),
      'Höhe h [m]': Number.isFinite(cur.ele) ? cur.ele : ''
    });
  }
  return out;
}

// ---------- Utils ----------

function diffSec(t1, t2) {
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Number.POSITIVE_INFINITY;
  return Math.max(0, t2 - t1);
}

function roundN(x, n = 3) {
  return Number.isFinite(x) ? Number(x.toFixed(n)) : '';
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function toRad(deg) { return deg * Math.PI / 180; }

// Europe/Berlin (CET/CEST) – Datum als YYYY-MM-DD, Zeit als HH:MM:SS
const dtfDate = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
});
const dtfTime = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function toBerlinParts(iso) {
  if (!iso) return { datePart: '', timePart: '' };
  const d = new Date(iso); // UTC-ISO
  // dtfDate gibt "dd.mm.yyyy" -> in ISO-ähnlich "yyyy-mm-dd" umwandeln (bessere Sortierbarkeit)
  const [dd, mm, yyyy] = dtfDate.format(d).split('.');
  const datePart = `${yyyy}-${mm}-${dd}`;
  const timePart = dtfTime.format(d); // "HH:MM:SS"
  return { datePart, timePart };
}
