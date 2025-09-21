// parsers/gpxParser.js
// Liest GPX (trk -> trkseg -> trkpt) und gibt ein Array von Zeilenobjekten zurück,
// passend für deine Tabelle/CSV (Spalten A..I, deutsch beschriftet).
//
// Optionales Filtern:
//   parseGpx(xmlText, {
//     distThresholdMeters: number, // z.B. 3  (Punkt wird gelöscht, wenn |ds_prev|<thr UND |ds_next|<thr)
//     timeThresholdSeconds: number // z.B. 2  (Punkt wird gelöscht, wenn dt_prev<thr UND dt_next<thr)
//   })
//
// Hinweis zu Zeiten: Wir verwenden die UTC-Zeit aus dem GPX (Z-Suffix).
// Datum = YYYY-MM-DD, Uhrzeit = HH:MM:SS (UTC).

export function parseGpx(xmlText, options = {}) {
  const { distThresholdMeters = 0, timeThresholdSeconds = 0 } = options;

  // ---------- 1) XML parsen ----------
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  // Fehlerprüfung auf Parser-Error
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Ungültiges XML/GPX.');
  }

  // GPX kann Namespaces haben – getElementsByTagName('trkpt') funktioniert im Browser meist trotzdem.
  const pts = [...doc.getElementsByTagName('trkpt')];
  if (pts.length === 0) return [];

  // ---------- 2) Rohdaten + Epochenzeiten sammeln ----------
  const raw = pts.map((pt) => {
    const lat = Number(pt.getAttribute('lat'));
    const lon = Number(pt.getAttribute('lon'));
    const ele = Number(pt.getElementsByTagName('ele')[0]?.textContent ?? '');
    const timeStr = pt.getElementsByTagName('time')[0]?.textContent ?? '';

    // Epochenzeit in Sekunden (UTC)
    const tSec = timeStr ? Date.parse(timeStr) / 1000 : NaN;

    return { lat, lon, ele, timeStr, tSec };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (raw.length === 0) return [];

  // ---------- 3) Vorab-Deltas zu Vor/Nächstem für Filter ----------
  // Distanz (m) via Haversine; Zeitdifferenzen (s)
  const n = raw.length;
  const dsPrev = new Array(n).fill(0);
  const dsNext = new Array(n).fill(0);
  const dtPrev = new Array(n).fill(0);
  const dtNext = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      dsPrev[i] = haversineMeters(raw[i - 1].lat, raw[i - 1].lon, raw[i].lat, raw[i].lon);
      dtPrev[i] = diffSec(raw[i - 1].tSec, raw[i].tSec);
    } else {
      dsPrev[i] = 0;
      dtPrev[i] = 0;
    }
    if (i < n - 1) {
      dsNext[i] = haversineMeters(raw[i].lat, raw[i].lon, raw[i + 1].lat, raw[i + 1].lon);
      dtNext[i] = diffSec(raw[i].tSec, raw[i + 1].tSec);
    } else {
      // Für das Filter-Kriterium dürfen Randpunkte nicht "grundlos" gelöscht werden:
      dsNext[i] = Number.POSITIVE_INFINITY;
      dtNext[i] = Number.POSITIVE_INFINITY;
    }
  }

  // ---------- 4) Filtern (optional) ----------
  const keep = raw.map((_, i) => {
    if (i === 0 || i === n - 1) return true; // Endpunkte niemals löschen
    const condDist = (Math.abs(dsPrev[i]) < distThresholdMeters) && (Math.abs(dsNext[i]) < distThresholdMeters);
    const condTime = (dtPrev[i] < timeThresholdSeconds) && (dtNext[i] < timeThresholdSeconds);
    // Wenn eine der beiden Regeln greift -> löschen
    return !(condDist || condTime);
  });

  const filtered = raw.filter((_, i) => keep[i]);
  if (filtered.length === 0) return [];

  // ---------- 5) Endgültige Spalten auf gefilterter Folge neu berechnen ----------
  const out = [];
  let sCum = 0;
  const t0 = filtered[0].tSec;

  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i];
    const prev = i > 0 ? filtered[i - 1] : null;

    const ds_m = prev ? haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon) : 0;
    sCum += ds_m;

    const dt0_s = Number.isFinite(cur.tSec) && Number.isFinite(t0) ? (cur.tSec - t0) : 0;
    const dtPrev_s = prev && Number.isFinite(cur.tSec) && Number.isFinite(prev.tSec) ? (cur.tSec - prev.tSec) : 0;

    const { datePart, timePart } = splitIsoUtc(cur.timeStr);

    out.push({
      // Spalten A..I mit gewünschten deutschen Bezeichnungen:
      'Lat': cur.lat,
      'Lon': cur.lon,
      'Datum': datePart,                          // YYYY-MM-DD (aus UTC-Zeitstempel)
      'Uhrzeit': timePart,                        // HH:MM:SS (UTC)
      'Zeit t seit Start [s]': roundN(dt0_s, 3),
      'Zeitspanne Δt zum Vorpunkt [s]': roundN(dtPrev_s, 1),
      'Strecke Δs zum Vorpunkt [m]': roundN(ds_m, 1),
      'Gesamtstrecke s [m]': roundN(sCum, 1),
      'Höhe [m]': Number.isFinite(cur.ele) ? cur.ele : ''
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

// Haversine-Gleichung (Erdradius ~ 6_371_000 m)
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);

  const a = Math.sin(dφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) { return deg * Math.PI / 180; }

// ISO-UTC "YYYY-MM-DDTHH:MM:SSZ" -> { datePart, timePart }
function splitIsoUtc(iso) {
  if (!iso || typeof iso !== 'string') return { datePart: '', timePart: '' };
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z$/);
  if (m) return { datePart: m[1], timePart: m[2] };
  // Fallback: naive Split
  const [datePart, rest] = iso.split('T');
  const timePart = (rest || '').replace(/Z$/, '').slice(0, 8);
  return { datePart: datePart || '', timePart: timePart || '' };
}
