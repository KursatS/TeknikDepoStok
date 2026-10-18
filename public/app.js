'use strict';
// ---------- yardımcılar ----------
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const norm = (s) => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/[^a-z0-9çğöşü]/g, '');
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) { toast(j.error || 'Hata', true); throw new Error(j.error); }
  return j;
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const getWho = () => localStorage.getItem('who') || '';

// ---------- durum ----------
let S = { sections: [], drawers: [], parts: [], drawerParts: [], technicians: [], roomItems: [], pnFormat: [2, 2, 4] };
let view = 'depo', editMode = false, query = '', openDrawer = null;
let idx = {};

async function load() {
  S = await api('GET', '/api/state');
  idx = {
    part: new Map(S.parts.map((p) => [p.id, p])),
    drawer: new Map(S.drawers.map((d) => [d.id, d])),
    section: new Map(S.sections.map((s) => [s.id, s])),
    byDrawer: new Map(), byPart: new Map(), alloc: new Map(),
  };
  for (const dp of S.drawerParts) {
    if (!idx.byDrawer.has(dp.drawer_id)) idx.byDrawer.set(dp.drawer_id, []);
    idx.byDrawer.get(dp.drawer_id).push(dp);
    if (!idx.byPart.has(dp.part_id)) idx.byPart.set(dp.part_id, []);
    idx.byPart.get(dp.part_id).push(dp);
    idx.alloc.set(dp.part_id, (idx.alloc.get(dp.part_id) || 0) + dp.qty);
  }
  render();
  if (openDrawer) showDrawer(openDrawer);
}
const total = (pid) => idx.part.get(pid).total_qty; // depodaki toplam stok
const alloc = (pid) => idx.alloc.get(pid) || 0;      // çekmecelere yerleştirilmiş
const pool = (pid) => total(pid) - alloc(pid);       // boşta (henüz çekmeceye konmamış)
const placeName = (d) => `${idx.section.get(d.section_id).name} / ${d.label}`;
const isLow = (p) => p.min_stock > 0 && total(p.id) < p.min_stock;

// ---------- arama ----------
function matchParts(qs) {
  const n = norm(qs);
  if (!n) return [];
  return S.parts.filter((p) => norm(p.pn).includes(n) || norm(p.name).includes(n) || norm(p.models).includes(n))
    .sort((a, b) => (norm(a.pn).startsWith(n) ? 0 : 1) - (norm(b.pn).startsWith(n) ? 0 : 1));
}
function hitDrawers() {
  const m = new Map(); // drawer_id -> toplam adet
  for (const p of matchParts(query)) for (const dp of idx.byPart.get(p.id) || []) m.set(dp.drawer_id, (m.get(dp.drawer_id) || 0) + dp.qty);
  return m;
}
function renderResults() {
  const box = $('#results');
  const list = matchParts(query).slice(0, 12);
  if (!query.trim()) { box.hidden = true; return; }
  box.replaceChildren(...(list.length ? list.map((p) => {
    const locs = (idx.byPart.get(p.id) || []).map((dp) => `${placeName(idx.drawer.get(dp.drawer_id))} (${dp.qty})`);
    return h('div', { class: 'item', onmousedown: (e) => { e.preventDefault(); gotoPart(p); } },
      h('span', { class: 'pn' }, p.pn), ' ', p.name,
      h('div', { class: 'where' }, locs.length ? '📍 ' + locs.join(' · ') : 'Hiçbir çekmeceye atanmamış'));
  }) : [h('div', { class: 'item' }, 'Eşleşen parça yok')]));
  box.hidden = false;
}
function gotoPart(p) {
  $('#search').value = p.pn; query = p.pn; $('#results').hidden = true;
  if (view !== 'room') switchView('depo'); refreshSearch(true);
}
function refreshSearch(scroll) {
  document.body.classList.toggle('searching', !!query.trim());
  if (view === 'room') renderRoom(); else if (view === 'depo') applyHighlight(scroll);
}
function applyHighlight(scroll) {
  const hits = hitDrawers();
  document.body.classList.toggle('searching', !!query.trim());
  document.querySelectorAll('.drawer').forEach((el) => {
    const id = Number(el.dataset.id);
    el.classList.toggle('hit', hits.has(id));
    el.querySelector('.qty-hit')?.remove();
    if (hits.has(id)) el.append(h('span', { class: 'qty-hit' }, '×' + hits.get(id)));
  });
  if (scroll) document.querySelector('.drawer.hit')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- görünümler ----------
function switchView(v) {
  view = v;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  for (const n of ['depo', 'room', 'parts', 'moves', 'low']) $('#view-' + n).hidden = n !== v;
  render();
}
function render() {
  const low = S.parts.filter(isLow).length;
  const lb = $('#lowBadge'); lb.hidden = !low; lb.textContent = low;
  ({ depo: renderDepo, room: renderRoom, parts: renderParts, moves: renderMoves, low: renderLow })[view]();
}

// ---------- PN parçalı giriş kutusu (örn. 09 . 01 . 4980) ----------
function pnInput(initial, onChange) {
  const fmt = S.pnFormat || [2, 2, 4];
  const inputs = fmt.map((n) => h('input', { inputmode: 'numeric', maxlength: n, size: n, style: `width:${n * 14 + 8}px`, placeholder: '0'.repeat(n) }));
  const box = h('div', { class: 'pnbox' });
  inputs.forEach((inp, i) => {
    if (i) box.append(h('span', { class: 'dot' }, '.'));
    box.append(inp);
  });
  const fire = () => onChange && onChange();
  const digits = (s) => s.replace(/\D/g, '');
  const fill = (text, from = 0) => { // rakamları gruplara dağıt
    let d = digits(text);
    for (let i = from; i < inputs.length && d; i++) { inputs[i].value = d.slice(0, fmt[i]); d = d.slice(fmt[i]); }
  };
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      const raw = inp.value;
      if (/\D/.test(raw) && /[.,\s-]/.test(raw.slice(-1)) && digits(raw)) { inp.value = digits(raw); inputs[i + 1]?.focus(); return fire(); }
      inp.value = digits(raw);
      if (inp.value.length > fmt[i]) { const rest = inp.value.slice(fmt[i]); inp.value = inp.value.slice(0, fmt[i]); fill(rest, i + 1); }
      if (inp.value.length >= fmt[i]) inputs[i + 1]?.focus();
      fire();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i) { inputs[i - 1].focus(); }
      if ((e.key === '.' || e.key === ',') && i < inputs.length - 1) { e.preventDefault(); inputs[i + 1].focus(); }
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      fill((e.clipboardData || window.clipboardData).getData('text'), 0);
      fire();
    });
    inp.addEventListener('focus', () => inp.select());
  });
  const api2 = {
    el: box,
    value: () => inputs.map((x) => x.value).join('.'),
    complete: () => inputs.every((x, i) => x.value.length === fmt[i]),
    set: (pn) => { inputs.forEach((x) => (x.value = '')); fill(pn || '', 0); fire(); },
    focus: () => inputs[0].focus(),
  };
  if (initial) api2.set(initial);
  return api2;
}
const pnHint = () => (S.pnFormat || [2, 2, 4]).map((n) => '0'.repeat(n)).join('.');

function renderDepo() {
  const root = $('#view-depo');
  const toolbar = h('div', { class: 'toolbar' },
    editMode ? h('button', { class: 'btn', onclick: addSection }, '+ Yeni bölüm / dolap') : null,
    h('span', { class: 'hint' }, editMode ? 'Düzenleme modu: satır/sütun sayısını değiştirebilir, bölüm adını yazabilirsiniz.' : 'Çekmeceye tıklayın veya yukarıdan PN arayın.'));
  const cabs = S.sections.map((s) => {
    const ds = S.drawers.filter((d) => d.section_id === s.id);
    const head = h('div', { class: 'cab-head' });
    if (editMode) {
      const num = (k, min) => h('input', { type: 'number', min, max: 30, value: s[k], onchange: (e) => resizeSection(s, k, e.target.value) });
      head.append(
        h('input', { value: s.name, onchange: (e) => api('PUT', '/api/sections/' + s.id, { name: e.target.value }).then(load) }),
        'Satır', num('rows', 1), 'Sütun', num('cols', 1),
        h('button', { class: 'btn danger small', onclick: () => delSection(s) }, 'Sil'));
    } else head.append(h('h2', {}, s.name));
    const at = new Map(ds.map((d) => [d.r + ',' + d.c, d]));
    const cells = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
      const d = at.get(r + ',' + c);
      if (!d) {
        cells.push(editMode ? h('button', { class: 'slot', title: 'Buraya çekmece ekle', onclick: () => api('POST', '/api/drawers', { section_id: s.id, r, c }).then(load) }, '+') : h('div', { class: 'slot void' }));
        continue;
      }
      const items = idx.byDrawer.get(d.id) || [];
      const lowFlag = items.some((dp) => isLow(idx.part.get(dp.part_id)));
      const shown = items.slice(0, 3).map((dp) => idx.part.get(dp.part_id).pn);
      cells.push(h('div', { class: 'drawer ' + (items.length ? 'has' : 'empty') + (lowFlag ? ' low' : ''), 'data-id': d.id, title: items.map((dp) => `${idx.part.get(dp.part_id).pn} ${idx.part.get(dp.part_id).name} ×${dp.qty}`).join('\n'), onclick: () => showDrawer(d.id) },
        editMode ? h('button', { class: 'rm', title: 'Bu çekmeceyi sil', onclick: (e) => { e.stopPropagation(); delDrawer(d, items.length); } }, '×') : null,
        h('span', { class: 'lbl' }, d.label),
        h('span', { class: 'cnt' }, items.length ? `${items.length} çeşit` : 'boş'),
        items.length ? h('div', { class: 'pns' }, shown.map((p) => h('div', {}, p)), items.length > 3 ? h('div', {}, `+${items.length - 3} daha`) : null) : null));
    }
    const grid = h('div', { class: 'grid', style: `grid-template-columns: repeat(${s.cols}, auto)` }, cells);
    return h('div', { class: 'cabinet', 'data-sec': s.id }, head, h('div', { class: 'cab-body' }, grid));
  });
  root.replaceChildren(toolbar, S.sections.length ? h('div', { class: 'cabinets' }, cabs)
    : h('div', { class: 'empty-note' }, 'Henüz depo yok. "Düzenleme modu"nu açıp ilk bölümü ekleyin.'));
  applyHighlight(false);
}

async function addSection() {
  const name = prompt('Bölüm / dolap adı:', 'Dolap ' + (S.sections.length + 1));
  if (name === null) return;
  const rows = parseInt(prompt('Kaç satır çekmece?', '4'), 10);
  const cols = parseInt(prompt('Kaç sütun çekmece?', '5'), 10);
  if (!rows || !cols) return;
  await api('POST', '/api/sections', { name, rows, cols }); load();
}
async function resizeSection(s, key, val) {
  const v = parseInt(val, 10);
  if (!v || v < 1) return load();
  try { await api('PUT', '/api/sections/' + s.id, { [key]: v }); } catch {}
  load(); // reddedilirse girdiyi eski değere döndürür
}
async function delDrawer(d, n) {
  if (!confirm(`${d.label} çekmecesi silinsin mi?` + (n ? ` İçindeki ${n} çeşit parça kaydı da çekmeceden kalkar.` : ''))) return;
  await api('DELETE', '/api/drawers/' + d.id); load();
}
async function delSection(s) {
  if (!confirm(`"${s.name}" bölümü ve tüm çekmeceleri silinsin mi? (Parça kataloğu silinmez)`)) return;
  await api('DELETE', '/api/sections/' + s.id); load();
}

// ---------- çekmece penceresi ----------
function openModal(content) { $('#panel').replaceChildren(content); $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; openDrawer = null; issuing = null; }

let issuing = null; // "Parça ver" formu açık olan parça id'si

function showDrawer(id) {
  const d = idx.drawer.get(id);
  if (!d) return closeModal();
  openDrawer = id;
  const items = (idx.byDrawer.get(id) || []).slice().sort((a, b) => idx.part.get(a.part_id).pn.localeCompare(idx.part.get(b.part_id).pn));
  const who = h('input', { placeholder: 'Depocu (sen)', title: 'İşlemi yapan depocunun adı', value: getWho(), oninput: (e) => localStorage.setItem('who', e.target.value) });
  const reopen = () => showDrawer(id);

  const issueForm = (p, dp) => {
    const qty = h('input', { type: 'number', min: 1, max: dp.qty, value: 1, title: 'Adet' });
    const svc = h('input', { placeholder: 'Servis ID', style: 'width:130px' });
    const tech = h('input', { placeholder: 'Teknisyen (seç/yaz)', list: 'techlist', style: 'width:170px' });
    const dl = h('datalist', { id: 'techlist' }, S.technicians.map((t) => h('option', { value: t })));
    const go = async () => {
      if (!svc.value.trim()) return toast('Servis ID girin', true);
      if (!tech.value.trim()) return toast('Teknisyeni girin/seçin', true);
      await api('POST', '/api/issue', { drawer_id: id, part_id: p.id, qty: qty.value, service_id: svc.value, technician: tech.value, who: who.value });
      toast(`${p.pn} ×${qty.value} → ${tech.value.trim()} (Servis ${svc.value.trim()})`);
      issuing = null; load();
    };
    return h('tr', {}, h('td', { colspan: 3, style: 'background:var(--bg2)' },
      h('div', { class: 'row' }, h('b', {}, 'Parça ver:'), qty, 'adet', svc, tech, dl,
        h('button', { class: 'btn', onclick: go }, 'Ver'), h('button', { class: 'btn ghost', onclick: () => { issuing = null; reopen(); } }, 'Vazgeç'))));
  };

  const rows = items.flatMap((dp) => {
    const p = idx.part.get(dp.part_id);
    const main = h('tr', {},
      h('td', {}, h('b', {}, p.pn), h('div', { class: 'hint' }, p.name)),
      h('td', {}, h('span', { class: 'qty-ctl' }, h('span', { class: 'n' }, dp.qty))),
      h('td', {},
        h('button', { class: 'btn small', onclick: () => { issuing = p.id; reopen(); } }, 'Parça ver'), ' ',
        h('button', { class: 'btn ghost small', title: 'Çekmeceyi sayıp gerçek adedi yaz (stok düzeltme)', onclick: () => {
          const v = prompt(`${p.pn} - çekmecedeki GERÇEK adedi yazın (sistemde ${dp.qty}):`, dp.qty);
          if (v !== null) api('POST', '/api/set-qty', { drawer_id: id, part_id: p.id, qty: v, who: who.value, note: 'Sayım düzeltmesi' }).then(load);
        } }, 'Sayım'), ' ',
        h('button', { class: 'btn ghost small', onclick: () => confirm(p.pn + ' bu çekmeceden kaldırılsın mı?') && api('DELETE', `/api/drawer-parts/${id}/${p.id}?who=${encodeURIComponent(who.value)}`).then(load) }, 'Kaldır')));
    return issuing === p.id ? [main, issueForm(p, dp)] : [main];
  });

  const label = h('input', { value: d.label, style: 'width:110px', title: 'Çekmece adı', onchange: (e) => api('PUT', '/api/drawers/' + id, { label: e.target.value }).then(load) });
  openModal(h('div', {},
    h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, idx.section.get(d.section_id).name + ' /'), label, h('span', { style: 'flex:1' }), who,
      h('button', { class: 'btn ghost small', onclick: closeModal }, 'Kapat')),
    items.length ? h('table', {}, h('tbody', {}, rows)) : h('div', { class: 'empty-note' }, 'Bu çekmece boş.'),
    items.length ? h('div', { class: 'hint', style: 'font-size:13px;margin-top:6px' }, '"Sayım": çekmeceyi elle sayıp adedi gerçeğe eşitler; fark depo toplamına da yansır. "Kaldır": adetleri boştaki stoğa geri döndürür. Teknisyene verirken "Parça ver"i kullanın (toplamdan da düşer).') : null,
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn', title: 'Parçalar listesinden bu çekmeceye parça yerleştir', onclick: () => openPicker(id) }, '+ Parça ekle'))));
}

// Çekmeceye parça yerleştirme: Parçalar listesindeki parçalardan seç, boştaki stoktan adet ayır
function openPicker(drawerId) {
  const d = idx.drawer.get(drawerId);
  let filterText = '', chosen = null;
  const who = getWho();
  const body = h('div', {});
  const draw = () => {
    const f = norm(filterText);
    const list = S.parts.filter((p) => !f || norm(p.pn + p.name + p.models).includes(f));
    const search = h('input', { class: 'filter', placeholder: 'PN veya ada göre ara…', value: filterText, oninput: (e) => { filterText = e.target.value; chosen = null; draw(); const i = body.querySelector('.filter'); i.focus(); i.setSelectionRange(99, 99); } });
    const rows = list.map((p) => {
      const free = pool(p.id), here = (idx.byDrawer.get(drawerId) || []).find((x) => x.part_id === p.id);
      const sel = chosen === p.id;
      const main = h('tr', { style: (free < 1 ? 'opacity:.45;' : 'cursor:pointer;') + (sel ? 'background:var(--bg2)' : ''), onclick: () => { if (free >= 1) { chosen = sel ? null : p.id; draw(); } } },
        h('td', {}, h('b', {}, p.pn), h('div', { class: 'hint' }, p.name)),
        h('td', {}, `Toplam ${p.total_qty}`, h('div', { class: 'hint' }, here ? `Bu çekmecede ${here.qty}` : '')),
        h('td', { class: free < 1 ? 'neg' : 'pos' }, free < 1 ? 'Boşta yok' : `Boşta ${free}`));
      if (!sel) return [main];
      const qty = h('input', { type: 'number', min: 1, max: free, value: Math.min(1, free), onclick: (e) => e.stopPropagation() });
      const go = async () => {
        await api('POST', '/api/assign', { drawer_id: drawerId, part_id: p.id, qty: qty.value, who });
        toast(`${p.pn} ×${qty.value} → ${placeName(d)}`);
        await load(); showDrawer(drawerId);
      };
      qty.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      return [main, h('tr', {}, h('td', { colspan: 3, style: 'background:var(--bg2)' },
        h('div', { class: 'row' }, 'Bu çekmeceye', qty, `adet koy (en fazla ${free})`, h('button', { class: 'btn', onclick: go }, 'Çekmeceye ekle'))))];
    }).flat();
    body.replaceChildren(
      h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, `${placeName(d)} – parça seç`), h('span', { style: 'flex:1' }),
        h('button', { class: 'btn ghost small', onclick: () => showDrawer(drawerId) }, '← Çekmeceye dön')),
      h('div', { class: 'row' }, search),
      rows.length ? h('table', {}, h('tbody', {}, rows)) : h('div', { class: 'empty-note' }, S.parts.length ? 'Eşleşen parça yok.' : 'Önce "Parçalar" sekmesinden parça ekleyin.'),
      h('div', { class: 'hint', style: 'font-size:13px;margin-top:8px' }, 'Parçalar sekmesindeki toplam adetten boşta olanlar listelenir. Çekmeceye koymak toplamı değiştirmez, sadece boşta kalan miktarı azaltır.'));
  };
  draw();
  openModal(body);
  body.querySelector('.filter').focus();
}

// ---------- parçalar ----------
let partFilter = '';
function renderParts() {
  const root = $('#view-parts');
  const f = norm(partFilter);
  const list = S.parts.filter((p) => !f || norm(p.pn + p.name + p.models).includes(f));
  const filter = h('input', { class: 'filter', placeholder: 'Listede filtrele…', value: partFilter, oninput: (e) => { partFilter = e.target.value; renderParts(); const i = $('#view-parts .filter'); i.focus(); i.setSelectionRange(99, 99); } });
  const file = h('input', { type: 'file', accept: '.csv,.txt', hidden: true, onchange: importCsv });
  root.replaceChildren(
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => editPart() }, '+ Yeni parça'), filter,
      h('button', { class: 'btn ghost', onclick: () => file.click() }, 'CSV içe aktar'), file,
      h('button', { class: 'btn ghost', onclick: exportCsv }, 'CSV dışa aktar')),
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, ['PN', 'Ad', 'Uyumlu modeller', 'Toplam', 'Çekmecede', 'Boşta', 'Min', 'Konum', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((p) => h('tr', {},
        h('td', {}, h('b', {}, p.pn)), h('td', {}, p.name), h('td', {}, p.models),
        h('td', { class: isLow(p) ? 'neg' : '' }, total(p.id)), h('td', {}, alloc(p.id)), h('td', {}, pool(p.id)), h('td', {}, p.min_stock || ''),
        h('td', {}, (idx.byPart.get(p.id) || []).map((dp) => h('span', { class: 'pill', onclick: () => showDrawer(dp.drawer_id) }, `${placeName(idx.drawer.get(dp.drawer_id))} ×${dp.qty}`))),
        h('td', {}, h('button', { class: 'btn ghost small', onclick: () => editPart(p) }, 'Düzenle'),
          ' ', h('button', { class: 'btn ghost small', onclick: () => gotoPart(p) }, 'Bul')))))) : h('div', { class: 'empty-note' }, 'Parça yok.'));
}
function editPart(p) {
  const f = {
    pn: pnInput(p?.pn || ''), name: h('input', { value: p?.name || '', style: 'width:100%' }),
    models: h('input', { value: p?.models || '', style: 'width:100%', placeholder: 'örn. S7, Q Revo' }),
    min: h('input', { type: 'number', min: 1, value: p?.min_stock || '', placeholder: 'zorunlu' }),
    total: h('input', { type: 'number', min: p ? alloc(p.id) : 0, value: p ? p.total_qty : '', placeholder: 'zorunlu' }), note: h('textarea', { rows: 2, style: 'width:100%' }, p?.note || ''),
  };
  const lab = (t, el) => h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:3px' }, h('span', { class: 'hint' }, t), el);
  const save = async () => {
    if (!f.pn.complete()) return toast(`PN ${pnHint()} biçiminde eksiksiz girilmeli`, true);
    if (!(parseInt(f.min.value, 10) >= 1)) return toast('Minimum stok girilmeli (en az 1)', true);
    if (!(parseInt(f.total.value, 10) >= 0)) return toast('Toplam adet girilmeli', true);
    const body = { pn: f.pn.value(), name: f.name.value, models: f.models.value, min_stock: f.min.value, total_qty: f.total.value, note: f.note.value, who: getWho() };
    await (p ? api('PUT', '/api/parts/' + p.id, body) : api('POST', '/api/parts', body));
    closeModal(); load();
  };
  openModal(h('div', {}, h('h3', {}, p ? 'Parçayı düzenle' : 'Yeni parça'),
    lab(`PN (${pnHint()})`, f.pn.el), lab('Parça adı', f.name), lab('Uyumlu modeller', f.models), lab('Toplam adet (depodaki tüm stok)' + (p ? `  – çekmecelerde ${alloc(p.id)}, boşta ${pool(p.id)}` : ''), f.total), lab('Minimum stok (toplam bunun altına inince uyarı)', f.min), lab('Not', f.note),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: save }, 'Kaydet'),
      p ? h('button', { class: 'btn danger', onclick: async () => { if (confirm(`${p.pn} tüm çekmecelerden ve katalogdan silinsin mi?`)) { await api('DELETE', '/api/parts/' + p.id); closeModal(); load(); } } }, 'Sil') : null,
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Vazgeç'))));
}
function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
async function importCsv(e) {
  const file = e.target.files[0]; if (!file) return;
  const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
  const head = rows.shift().map(norm);
  const col = (...names) => head.findIndex((x) => names.includes(x));
  const c = { pn: col('pn', 'partno', 'parcano'), name: col('ad', 'adi', 'name', 'parcaadi', 'isim'), models: col('model', 'modeller', 'models', 'uyumlumodeller'), min: col('min', 'minimum', 'minstok', 'minimumstok'), total: col('toplam', 'adet', 'stok', 'totalqty'), note: col('not', 'note', 'aciklama') };
  if (c.pn < 0) return toast('CSV\'de "PN" başlıklı sütun bulunamadı', true);
  const get = (r, i) => (i >= 0 ? r[i] || '' : '');
  const out = await api('POST', '/api/parts/import', { rows: rows.map((r) => ({ pn: get(r, c.pn), name: get(r, c.name), models: get(r, c.models), min_stock: get(r, c.min), total_qty: get(r, c.total), note: get(r, c.note) })) });
  toast(`${out.added} eklendi, ${out.updated} güncellendi` + (out.skipped ? `, ${out.skipped} satır atlandı (PN biçimi veya minimum stok hatalı)` : ''), !!out.skipped); load();
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })), download: name }); a.click();
}
function exportCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['PN', 'Ad', 'Modeller', 'Min', 'Toplam', 'Not'].join(';')].concat(S.parts.map((p) => [p.pn, p.name, p.models, p.min_stock, total(p.id), p.note].map(esc).join(';')));
  download('parcalar.csv', lines.join('\r\n'));
}

// ---------- hareketler / azalanlar ----------
let moveFilter = '';
const TYPES = { issue: 'Verildi', add: 'Eklendi', count: 'Sayım', remove: 'Kaldırıldı', adjust: 'Düzeltme', stock: 'Toplam stok', undo: 'Geri alma' };
async function renderMoves() {
  const root = $('#view-moves');
  const all = await api('GET', '/api/movements?limit=5000');
  const f = norm(moveFilter);
  const list = all.filter((m) => !f || norm([m.pn, m.part_name, m.service_id, m.technician, m.who, m.place, TYPES[m.type]].join(' ')).includes(f));
  const filter = h('input', { class: 'filter', placeholder: 'Servis ID, teknisyen, PN… ile filtrele', value: moveFilter, oninput: (e) => { moveFilter = e.target.value; renderMoves().then(() => { const i = $('#view-moves .filter'); i.focus(); i.setSelectionRange(99, 99); }); } });
  root.replaceChildren(h('div', { class: 'toolbar' }, filter),
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Zaman', 'Tür', 'PN', 'Parça', 'Adet', 'Servis ID', 'Teknisyen', 'Çekmece', 'Depocu', 'Not', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((m) => h('tr', { style: m.undone ? 'opacity:.45;text-decoration:line-through' : '' }, h('td', {}, m.ts), h('td', {}, TYPES[m.type] || m.type), h('td', {}, h('b', {}, m.pn)), h('td', {}, m.part_name),
        h('td', { class: m.delta < 0 ? 'neg' : 'pos' }, (m.delta > 0 ? '+' : '') + m.delta),
        h('td', {}, m.service_id), h('td', {}, m.technician), h('td', {}, m.place), h('td', {}, m.who), h('td', {}, m.note),
        h('td', {}, m.undone ? h('span', { class: 'hint' }, 'geri alındı') : m.type === 'undo' ? null : h('button', { class: 'btn ghost small', onclick: () => undoMove(m) }, 'Geri al')))))) : h('div', { class: 'empty-note' }, 'Kayıt yok.'));
}

async function undoMove(m) {
  const what = m.type === 'issue' ? `${m.pn} ×${-m.delta} parçayı (Servis ${m.service_id}, ${m.technician}) çekmeceye geri koyar` : `${m.pn} için ${m.delta > 0 ? '+' : ''}${m.delta} değişimini tersine çevirir`;
  if (!confirm(`Bu işlem geri alınsın mı?

${what}`)) return;
  await api('POST', `/api/movements/${m.id}/undo`, { who: getWho() });
  toast('Geri alındı'); await load();
}

// ---------- kuş bakışı oda ----------
let selRoom = null; // {kind:'sec'|'item', id}
const CAB_W = 40, CAB_D = 56; // dolap: sütun başına 40px genişlik, 56px derinlik
const cabSize = (s) => ({ w: Math.max(60, s.cols * CAB_W), h: CAB_D });
const snap = (v) => Math.round(v / 10) * 10;
const DECOR = { door: ['Kapı', 70, 14], window: ['Pencere', 100, 10], table: ['Masa', 120, 60], box: ['Alan', 100, 60], text: ['Yazı', 100, 24] };

function renderRoom() {
  const root = $('#view-room');
  const hits = hitDrawers();
  const secHits = new Map(); // section_id -> [etiketler]
  for (const did of hits.keys()) { const d = idx.drawer.get(did); if (!secHits.has(d.section_id)) secHits.set(d.section_id, []); secHits.get(d.section_id).push(d.label); }

  const room = h('div', { class: 'room' + (editMode ? ' editing' : '') });
  const place = (el, x, y, w, hgt, rot) => { el.style.cssText += `;left:${x}px;top:${y}px;width:${w}px;height:${hgt}px;transform:rotate(${rot}deg)`; };
  const drag = (el, getPos, setPos, save) => {
    el.addEventListener('pointerdown', (e) => {
      if (!editMode) return;
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const p0 = getPos(), sx = e.clientX, sy = e.clientY; let moved = false;
      const move = (ev) => { moved = true; setPos(Math.max(0, snap(p0.x + ev.clientX - sx)), Math.max(0, snap(p0.y + ev.clientY - sy))); };
      const up = async () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (moved) await save(); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
  };

  S.sections.forEach((s) => {
    const sz = cabSize(s), hit = secHits.has(s.id);
    const el = h('div', { class: 'rbox cab' + (hit ? ' hit' : '') + (selRoom?.kind === 'sec' && selRoom.id === s.id ? ' sel' : ''), title: 'Çekmecelere git',
      onclick: () => { if (editMode) { selRoom = { kind: 'sec', id: s.id }; renderRoom(); } else gotoSection(s.id); } },
      h('div', { class: 'inner', style: s.rrot === 180 ? 'transform:rotate(180deg)' : '' }, s.name, hit ? h('div', { class: 'hits' }, secHits.get(s.id).join(', ')) : null), h('div', { class: 'front' }));
    place(el, s.rx, s.ry, sz.w, sz.h, s.rrot);
    drag(el, () => ({ x: s.rx, y: s.ry }), (x, y) => { s.rx = x; s.ry = y; place(el, x, y, sz.w, sz.h, s.rrot); },
      () => api('PUT', `/api/sections/${s.id}/room`, { rx: s.rx, ry: s.ry, rrot: s.rrot }));
    room.append(el);
  });
  S.roomItems.forEach((it) => {
    const el = h('div', { class: 'rbox deco ' + it.kind + (selRoom?.kind === 'item' && selRoom.id === it.id ? ' sel' : ''), onclick: () => { if (editMode) { selRoom = { kind: 'item', id: it.id }; renderRoom(); } } }, it.label);
    place(el, it.x, it.y, it.w, it.h, it.rot);
    drag(el, () => ({ x: it.x, y: it.y }), (x, y) => { it.x = x; it.y = y; place(el, x, y, it.w, it.h, it.rot); }, () => api('PUT', '/api/room-items/' + it.id, it));
    room.append(el);
  });

  const bar = h('div', { class: 'roombar' });
  if (editMode) {
    bar.append(h('span', { class: 'hint' }, 'Sürükleyerek yerleştirin. Sarı-kahverengi şerit dolabın ÖN (çekmece) tarafıdır.'),
      ...Object.entries(DECOR).map(([k, [lbl, w, hh]]) => h('button', { class: 'btn ghost small', onclick: () => api('POST', '/api/room-items', { kind: k, label: lbl, x: 40, y: 40, w, h: hh }).then(load) }, '+ ' + lbl)));
    if (selRoom) {
      const s = selRoom.kind === 'sec' ? idx.section.get(selRoom.id) : S.roomItems.find((i) => i.id === selRoom.id);
      if (s) {
        const rot = () => selRoom.kind === 'sec'
          ? api('PUT', `/api/sections/${s.id}/room`, { rx: s.rx, ry: s.ry, rrot: s.rrot + 90 }).then(load)
          : api('PUT', '/api/room-items/' + s.id, { ...s, rot: s.rot + 90 }).then(load);
        bar.append(h('span', { class: 'hint' }, '|  Seçili: '), h('button', { class: 'btn small', onclick: rot }, '⟳ 90° döndür'));
        if (selRoom.kind === 'item') {
          const num = (k) => h('input', { type: 'number', min: 10, step: 10, value: s[k], onchange: (e) => api('PUT', '/api/room-items/' + s.id, { ...s, [k]: e.target.value }).then(load) });
          bar.append('G', num('w'), 'Y', num('h'),
            h('input', { value: s.label, placeholder: 'Etiket', onchange: (e) => api('PUT', '/api/room-items/' + s.id, { ...s, label: e.target.value }).then(load) }),
            h('button', { class: 'btn danger small', onclick: () => api('DELETE', '/api/room-items/' + s.id).then(() => { selRoom = null; load(); }) }, 'Sil'));
        }
      }
    }
  } else bar.append(h('span', { class: 'hint' }, 'Dolaba tıklayınca çekmeceleri açılır. Yukarıdan PN aratırsanız içinde parçanın olduğu dolap parlar ve çekmece adları yazılır. Yerleşimi değiştirmek için "Düzenleme modu"nu açın.'));
  root.replaceChildren(bar, h('div', { class: 'room-wrap' }, room));
}
function gotoSection(id) {
  switchView('depo');
  const el = document.querySelector(`.cabinet[data-sec="${id}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 2600);
}
function renderLow() {
  const list = S.parts.filter(isLow);
  $('#view-low').replaceChildren(list.length ? h('table', {}, h('thead', {}, h('tr', {}, ['PN', 'Ad', 'Mevcut', 'Min', 'Eksik', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, list.map((p) => h('tr', {}, h('td', {}, h('b', {}, p.pn)), h('td', {}, p.name), h('td', { class: 'neg' }, total(p.id)), h('td', {}, p.min_stock),
      h('td', {}, p.min_stock - total(p.id)), h('td', {}, h('button', { class: 'btn ghost small', onclick: () => gotoPart(p) }, 'Bul')))))) : h('div', { class: 'empty-note' }, '✓ Minimum stok altında parça yok.'));
}

// ---------- olaylar ----------
$('#tabs').addEventListener('click', (e) => e.target.dataset.view && switchView(e.target.dataset.view));
$('#editMode').addEventListener('change', (e) => { editMode = e.target.checked; render(); });
$('#search').addEventListener('input', (e) => { query = e.target.value; renderResults(); if (view !== 'depo' && view !== 'room') switchView('depo'); else refreshSearch(false); });
$('#search').addEventListener('focus', renderResults);
$('#search').addEventListener('blur', () => setTimeout(() => ($('#results').hidden = true), 150));
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { $('#results').hidden = true; refreshSearch(true); }
  if (e.key === 'Escape') { e.target.value = ''; query = ''; $('#results').hidden = true; refreshSearch(false); }
});
$('#modal').addEventListener('mousedown', (e) => e.target.id === 'modal' && closeModal());
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#modal').hidden && closeModal());

load();
