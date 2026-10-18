// TeknikDepo - robot süpürge yedek parça depo takibi
// Bağımlılık yok: Node 22+ (yerleşik node:sqlite) ile çalışır.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 5056;
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'depo.db');

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drawers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  r INTEGER NOT NULL,
  c INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  UNIQUE(section_id, r, c)
);
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pn TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  min_stock INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS drawer_parts (
  drawer_id INTEGER NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (drawer_id, part_id)
);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  drawer_id INTEGER REFERENCES drawers(id) ON DELETE SET NULL,
  pn TEXT NOT NULL DEFAULT '',
  part_name TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  delta INTEGER NOT NULL,
  who TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS technicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS room_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 20,
  y INTEGER NOT NULL DEFAULT 20,
  w INTEGER NOT NULL DEFAULT 80,
  h INTEGER NOT NULL DEFAULT 40,
  rot INTEGER NOT NULL DEFAULT 0
);
`);
const addCol = (table, col, def) => {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  return true;
};
// Stok havuzu: parts.total_qty = depodaki toplam adet; çekmecelere dağıtılan kısım drawer_parts'ta.
// Eski veriyi taşı: toplam = çekmecelerdeki mevcut toplam
if (addCol('parts', 'total_qty', 'INTEGER NOT NULL DEFAULT 0')) {
  db.exec(`UPDATE parts SET total_qty = COALESCE((SELECT SUM(qty) FROM drawer_parts WHERE part_id = parts.id), 0)`);
}
if (addCol('movements', 'delta_total', 'INTEGER NOT NULL DEFAULT 0')) db.exec(`UPDATE movements SET delta_total = delta`);
addCol('sections', 'rx', 'INTEGER NOT NULL DEFAULT 20');
addCol('sections', 'ry', 'INTEGER NOT NULL DEFAULT 20');
addCol('sections', 'rrot', 'INTEGER NOT NULL DEFAULT 0');
addCol('movements', 'type', "TEXT NOT NULL DEFAULT 'adjust'");
addCol('movements', 'service_id', "TEXT NOT NULL DEFAULT ''");
addCol('movements', 'undone', 'INTEGER NOT NULL DEFAULT 0');
addCol('movements', 'undo_of', 'INTEGER');
addCol('movements', 'technician', "TEXT NOT NULL DEFAULT ''");

// PN biçimi: rakam grupları, örn. 09.01.4980 -> [2,2,4]
const PN_FORMAT = [2, 2, 4];
const PN_RE = new RegExp('^' + PN_FORMAT.map((n) => `\\d{${n}}`).join('\\.') + '$');
const PN_EXAMPLE = PN_FORMAT.map((n) => '0'.repeat(n)).join('.');

const q = (sql) => db.prepare(sql);
const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
const rowLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const defaultLabel = (r, c) => `${rowLetter(r)}${c + 1}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, parseInt(n, 10) || lo));
const str = (v) => (v == null ? '' : String(v).trim());

class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function placeOf(drawerId) {
  const d = q(`SELECT d.label, s.name FROM drawers d JOIN sections s ON s.id = d.section_id WHERE d.id = ?`).get(drawerId);
  return d ? `${d.name} / ${d.label}` : '';
}

// Boyut değişince: dışarıda kalanları sil, sadece YENİ eklenen konumlara çekmece aç
// (tek tek silinmiş çekmeceler yeniden doğmaz)
function syncDrawers(sectionId, oldRows, oldCols, rows, cols) {
  q(`DELETE FROM drawers WHERE section_id = ? AND (r >= ? OR c >= ?)`).run(sectionId, rows, cols);
  const ins = q(`INSERT OR IGNORE INTO drawers (section_id, r, c, label) VALUES (?,?,?,?)`);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (r >= oldRows || c >= oldCols) ins.run(sectionId, r, c, defaultLabel(r, c));
}

const allocated = (partId) => q(`SELECT COALESCE(SUM(qty),0) n FROM drawer_parts WHERE part_id = ?`).get(partId).n;

// Tek merkezi stok değişimi.
//   dD: çekmecedeki adet değişimi (drawerId null ise 0 olmalı)
//   dT: depo toplamındaki değişim
// Kurallar: çekmece adedi >= 0, toplam >= çekmecelere dağıtılan miktar (boşta havuz eksiye düşemez)
function applyChange(drawerId, partId, dD, dT, who, note, meta = {}) {
  const part = q(`SELECT * FROM parts WHERE id = ?`).get(partId);
  if (!part) throw new HttpError(404, 'Parça bulunamadı');
  if (drawerId && !q(`SELECT 1 FROM drawers WHERE id = ?`).get(drawerId)) throw new HttpError(404, 'Çekmece bulunamadı');
  const have = drawerId ? (q(`SELECT qty FROM drawer_parts WHERE drawer_id = ? AND part_id = ?`).get(drawerId, partId)?.qty || 0) : 0;
  const alloc = allocated(partId);
  if (have + dD < 0) throw new HttpError(400, `Çekmecede sadece ${have} adet var`);
  const newTotal = part.total_qty + dT;
  if (newTotal < alloc + dD) {
    const pool = part.total_qty - alloc;
    throw new HttpError(400, dD > 0 ? `Depoda boşta sadece ${pool} adet var (toplam ${part.total_qty}, çekmecelerde ${alloc})` : `Toplam stok, çekmecelerdeki ${alloc} adedin altına inemez`);
  }
  if (drawerId && dD !== 0) {
    q(`INSERT INTO drawer_parts (drawer_id, part_id, qty) VALUES (?,?,?)
       ON CONFLICT(drawer_id, part_id) DO UPDATE SET qty = excluded.qty`).run(drawerId, partId, have + dD);
  }
  if (dT !== 0) q(`UPDATE parts SET total_qty = ? WHERE id = ?`).run(newTotal, partId);
  if (dD !== 0 || dT !== 0) {
    q(`INSERT INTO movements (part_id, drawer_id, pn, part_name, place, delta, delta_total, who, note, type, service_id, technician, undo_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(partId, drawerId || null, part.pn, part.name, drawerId ? placeOf(drawerId) : 'Depo toplamı', drawerId ? dD : dT, dT, str(who), str(note), meta.type, str(meta.service_id), str(meta.technician), meta.undo_of || null);
  }
}

// ---- API ----
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/state', () => ({
  sections: q(`SELECT * FROM sections ORDER BY sort, id`).all(),
  drawers: q(`SELECT * FROM drawers ORDER BY section_id, r, c`).all(),
  parts: q(`SELECT * FROM parts ORDER BY pn`).all(),
  drawerParts: q(`SELECT * FROM drawer_parts WHERE qty > 0`).all(),
  technicians: q(`SELECT name FROM technicians ORDER BY name COLLATE NOCASE`).all().map((t) => t.name),
  roomItems: q(`SELECT * FROM room_items ORDER BY id`).all(),
  pnFormat: PN_FORMAT,
}));

route('POST', '/api/sections', ({ body }) => tx(() => {
  const name = str(body.name) || 'Yeni Bölüm';
  const rows = clamp(body.rows, 1, 30), cols = clamp(body.cols, 1, 30);
  const sort = q(`SELECT COALESCE(MAX(sort),0)+1 AS n FROM sections`).get().n;
  const rx = 20 + ((sort - 1) % 4) * 300, ry = 20 + Math.floor((sort - 1) / 4) * 150;
  const id = Number(q(`INSERT INTO sections (name, rows, cols, sort, rx, ry) VALUES (?,?,?,?,?,?)`).run(name, rows, cols, sort, rx, ry).lastInsertRowid);
  syncDrawers(id, 0, 0, rows, cols);
  return { id };
}));

// Kuş bakışı oda: dolabın yeri ve dönüşü
route('PUT', '/api/sections/:id/room', ({ params, body }) => {
  q(`UPDATE sections SET rx = ?, ry = ?, rrot = ? WHERE id = ?`).run(Math.round(+body.rx) || 0, Math.round(+body.ry) || 0, (((Math.round(+body.rrot / 90) * 90) % 360) + 360) % 360, params.id);
  return { ok: true };
});

route('POST', '/api/room-items', ({ body }) => ({
  id: Number(q(`INSERT INTO room_items (kind, label, x, y, w, h, rot) VALUES (?,?,?,?,?,?,?)`)
    .run(str(body.kind) || 'box', str(body.label), Math.round(+body.x) || 20, Math.round(+body.y) || 20, clamp(body.w || 80, 10, 2000), clamp(body.h || 40, 10, 2000), 0).lastInsertRowid),
}));
route('PUT', '/api/room-items/:id', ({ params, body }) => {
  q(`UPDATE room_items SET label = ?, x = ?, y = ?, w = ?, h = ?, rot = ? WHERE id = ?`)
    .run(str(body.label), Math.round(+body.x) || 0, Math.round(+body.y) || 0, clamp(body.w, 10, 2000), clamp(body.h, 10, 2000), (((Math.round(+body.rot / 90) * 90) % 360) + 360) % 360, params.id);
  return { ok: true };
});
route('DELETE', '/api/room-items/:id', ({ params }) => {
  q(`DELETE FROM room_items WHERE id = ?`).run(params.id);
  return { ok: true };
});

// Tek çekmece ekle / sil (düzensiz dolaplar için)
route('POST', '/api/drawers', ({ body }) => {
  const s = q(`SELECT * FROM sections WHERE id = ?`).get(body.section_id);
  const r = parseInt(body.r, 10), c = parseInt(body.c, 10);
  if (!s || !(r >= 0 && r < s.rows && c >= 0 && c < s.cols)) throw new HttpError(400, 'Geçersiz konum');
  q(`INSERT OR IGNORE INTO drawers (section_id, r, c, label) VALUES (?,?,?,?)`).run(s.id, r, c, defaultLabel(r, c));
  return { ok: true };
});
route('DELETE', '/api/drawers/:id', ({ params }) => {
  q(`DELETE FROM drawers WHERE id = ?`).run(params.id);
  return { ok: true };
});

route('PUT', '/api/sections/:id', ({ params, body }) => tx(() => {
  const s = q(`SELECT * FROM sections WHERE id = ?`).get(params.id);
  if (!s) throw new HttpError(404, 'Bölüm yok');
  const name = str(body.name) || s.name;
  const rows = clamp(body.rows ?? s.rows, 1, 30), cols = clamp(body.cols ?? s.cols, 1, 30);
  const full = q('SELECT d.label FROM drawers d WHERE d.section_id = ? AND (d.r >= ? OR d.c >= ?) AND EXISTS (SELECT 1 FROM drawer_parts dp WHERE dp.drawer_id = d.id AND dp.qty > 0)').all(s.id, rows, cols);
  if (full.length) throw new HttpError(400, 'Küçültülemez: içinde parça olan çekmeceler var (' + full.map((d) => d.label).join(', ') + '). Önce parçaları başka çekmeceye taşıyın veya çekmeceleri boşaltın.');
  q(`UPDATE sections SET name = ?, rows = ?, cols = ? WHERE id = ?`).run(name, rows, cols, s.id);
  syncDrawers(s.id, s.rows, s.cols, rows, cols);
  return { ok: true };
}));

route('DELETE', '/api/sections/:id', ({ params }) => {
  q(`DELETE FROM sections WHERE id = ?`).run(params.id);
  return { ok: true };
});

route('PUT', '/api/drawers/:id', ({ params, body }) => {
  q(`UPDATE drawers SET label = ? WHERE id = ?`).run(str(body.label), params.id);
  return { ok: true };
});

function partFields(b) {
  const pn = str(b.pn);
  if (!PN_RE.test(pn)) throw new HttpError(400, `PN ${PN_EXAMPLE} biçiminde olmalı (örn. 09.01.4980)`);
  const min = parseInt(b.min_stock, 10);
  if (!(min >= 1)) throw new HttpError(400, 'Minimum stok girilmeli (en az 1)');
  return [pn, str(b.name), str(b.models), min, str(b.note)];
}
function parseTotal(v) {
  const t = parseInt(v, 10);
  if (!(t >= 0)) throw new HttpError(400, 'Toplam adet girilmeli (0 veya daha fazla)');
  return t;
}
const uniqueGuard = (fn) => {
  try { return fn(); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(400, 'Bu PN zaten kayıtlı'); throw e; }
};

// Parça kataloğuna ekle (toplam adet = depodaki toplam stok, henüz hiçbir çekmeceye konmamış)
route('POST', '/api/parts', ({ body }) => uniqueGuard(() => tx(() => {
  const fields = partFields(body), total = parseTotal(body.total_qty);
  const id = Number(q(`INSERT INTO parts (pn, name, models, min_stock, note) VALUES (?,?,?,?,?)`).run(...fields).lastInsertRowid);
  if (total > 0) applyChange(null, id, 0, total, body.who, 'İlk stok', { type: 'stock' });
  return { id };
})));

route('PUT', '/api/parts/:id', ({ params, body }) => uniqueGuard(() => tx(() => {
  const part = q(`SELECT * FROM parts WHERE id = ?`).get(params.id);
  if (!part) throw new HttpError(404, 'Parça bulunamadı');
  const fields = partFields(body), total = parseTotal(body.total_qty);
  q(`UPDATE parts SET pn = ?, name = ?, models = ?, min_stock = ?, note = ? WHERE id = ?`).run(...fields, params.id);
  if (total !== part.total_qty) applyChange(null, part.id, 0, total - part.total_qty, body.who, 'Toplam stok düzenlendi', { type: 'stock' });
  return { ok: true };
})));

route('DELETE', '/api/parts/:id', ({ params }) => {
  q(`DELETE FROM parts WHERE id = ?`).run(params.id);
  return { ok: true };
});

// Toplu içe aktarma: PN varsa günceller, yoksa ekler. "toplam" sütunu isteğe bağlı.
route('POST', '/api/parts/import', ({ body }) => tx(() => {
  let added = 0, updated = 0, skipped = 0;
  for (const r of body.rows || []) {
    const pn = str(r.pn);
    const minS = parseInt(r.min_stock, 10);
    const hasTotal = str(r.total_qty) !== '';
    const total = parseInt(r.total_qty, 10);
    if (!PN_RE.test(pn) || !(minS >= 1) || (hasTotal && !(total >= 0))) { skipped++; continue; }
    const ex = q(`SELECT * FROM parts WHERE pn = ?`).get(pn);
    try {
      if (ex) {
        if (hasTotal && total !== ex.total_qty) applyChange(null, ex.id, 0, total - ex.total_qty, '', 'CSV içe aktarma', { type: 'stock' });
        q(`UPDATE parts SET name = ?, models = ?, min_stock = ?, note = ? WHERE id = ?`).run(str(r.name), str(r.models), minS, str(r.note), ex.id);
        updated++;
      } else {
        const id = Number(q(`INSERT INTO parts (pn, name, models, min_stock, note) VALUES (?,?,?,?,?)`).run(pn, str(r.name), str(r.models), minS, str(r.note)).lastInsertRowid);
        if (hasTotal && total > 0) applyChange(null, id, 0, total, '', 'CSV içe aktarma', { type: 'stock' });
        added++;
      }
    } catch (e) { if (e instanceof HttpError) skipped++; else throw e; }
  }
  return { added, updated, skipped };
}));

// Boştaki stoktan çekmeceye yerleştir (toplam değişmez)
route('POST', '/api/assign', ({ body }) => tx(() => {
  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1)) throw new HttpError(400, 'Adet en az 1 olmalı');
  applyChange(Number(body.drawer_id), Number(body.part_id), qty, 0, body.who, 'Çekmeceye eklendi', { type: 'add' });
  return { ok: true };
}));

// Parça ver: teknisyene + servis ID'sine kayıtlı çıkış (hem çekmeceden hem toplamdan düşer)
route('POST', '/api/issue', ({ body }) => tx(() => {
  const qty = parseInt(body.qty, 10);
  const service = str(body.service_id), tech = str(body.technician);
  if (!(qty >= 1)) throw new HttpError(400, 'Adet en az 1 olmalı');
  if (!service) throw new HttpError(400, 'Servis ID girilmeli');
  if (!tech) throw new HttpError(400, 'Teknisyen seçilmeli');
  q(`INSERT OR IGNORE INTO technicians (name) VALUES (?)`).run(tech);
  applyChange(Number(body.drawer_id), Number(body.part_id), -qty, -qty, body.who, body.note, { type: 'issue', service_id: service, technician: tech });
  return { ok: true };
}));

// Sayım düzeltmesi: çekmecedeki gerçek adet; fark depo toplamına da yansır
route('POST', '/api/set-qty', ({ body }) => tx(() => {
  const cur = q(`SELECT qty FROM drawer_parts WHERE drawer_id = ? AND part_id = ?`).get(Number(body.drawer_id), Number(body.part_id));
  const target = parseInt(body.qty, 10);
  if (!(target >= 0)) throw new HttpError(400, 'Geçerli bir adet girin');
  const diff = target - (cur ? cur.qty : 0);
  applyChange(Number(body.drawer_id), Number(body.part_id), diff, diff, body.who, body.note || 'Sayım düzeltmesi', { type: 'count' });
  return { ok: true };
}));

// Çekmeceden kaldır: adetler boştaki stoğa döner (toplam değişmez)
route('DELETE', '/api/drawer-parts/:drawer/:part', ({ params, query }) => tx(() => {
  const cur = q(`SELECT qty FROM drawer_parts WHERE drawer_id = ? AND part_id = ?`).get(params.drawer, params.part);
  if (cur && cur.qty > 0) applyChange(Number(params.drawer), Number(params.part), -cur.qty, 0, query.who, 'Çekmeceden kaldırıldı', { type: 'remove' });
  q(`DELETE FROM drawer_parts WHERE drawer_id = ? AND part_id = ?`).run(params.drawer, params.part);
  return { ok: true };
}));

// Hareketi komple geri al: ters yönde yeni kayıt açar, orijinali 'geri alındı' işaretler
route('POST', '/api/movements/:id/undo', ({ params, body }) => tx(() => {
  const m = q('SELECT * FROM movements WHERE id = ?').get(params.id);
  if (!m) throw new HttpError(404, 'Hareket bulunamadı');
  if (m.undone) throw new HttpError(400, 'Bu hareket zaten geri alınmış');
  if (m.type === 'undo') throw new HttpError(400, 'Geri alma kaydı geri alınamaz');
  if (!m.part_id) throw new HttpError(400, 'Parça katalogdan silinmiş, geri alınamaz');
  if (m.type !== 'stock' && !m.drawer_id) throw new HttpError(400, 'Çekmece silinmiş, geri alınamaz');
  applyChange(m.drawer_id, m.part_id, m.drawer_id ? -m.delta : 0, -m.delta_total, body.who, `#${m.id} geri alındı`, { type: 'undo', service_id: m.service_id, technician: m.technician, undo_of: m.id });
  q('UPDATE movements SET undone = 1 WHERE id = ?').run(m.id);
  return { ok: true };
}));

route('GET', '/api/movements', ({ query }) => q(`SELECT * FROM movements ORDER BY id DESC LIMIT ?`).all(clamp(query.limit || 300, 1, 20000)));

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const send = (res, code, data, headers = {}) => {
  const isBuf = Buffer.isBuffer(data) || typeof data === 'string';
  res.writeHead(code, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isBuf ? data : JSON.stringify(data));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/backup' && req.method === 'GET') {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    const stamp = new Date().toISOString().slice(0, 10);
    return send(res, 200, fs.readFileSync(DB_FILE), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="depo-yedek-${stamp}.db"` });
  }
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          let body = {};
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) body = JSON.parse(raw);
          const out = r.fn({ params: { ...m.groups }, body, query: Object.fromEntries(url.searchParams) });
          return send(res, 200, out);
        }
        send(res, 404, { error: 'Bulunamadı' });
      } catch (e) {
        send(res, e.code || 500, { error: e.message });
      }
    });
    return;
  }
  // statik dosyalar
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Bulunamadı');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => console.log(`TeknikDepo hazır: http://localhost:${PORT}`));
