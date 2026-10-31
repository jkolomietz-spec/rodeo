'use strict';
/* Rodeo – historia de animales. Funciona sin internet: todo se guarda en el teléfono (IndexedDB).
   Respaldo: archivo JSON (compartir a Drive) o subida directa a Google Drive. */

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmt = (iso) => { if (!iso) return '–'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const fmtDT = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
// Peso: acepta coma o punto; vacío = null, inválido = NaN
const parseKg = (s) => { s = String(s ?? '').trim().replace(',', '.'); if (!s) return null; const n = Number(s); return isFinite(n) && n > 0 && n < 3000 ? Math.round(n * 10) / 10 : NaN; };
const fmtKg = (n) => n == null ? '' : String(n).replace('.', ',') + ' kg';
const kgInput = (id, val) => `<input id="${id}" inputmode="decimal" autocomplete="off" placeholder="Ej: 450" value="${val == null ? '' : String(val).replace('.', ',')}">`;
const SEX = { M: 'Macho', H: 'Hembra' };
const CATS = { M: ['Ternero', 'Novillo', 'Toro'], H: ['Ternera', 'Vaquillona', 'Vaca'] };
const REASONS = { vendido: 'Vendido', muerto: 'Muerto', otro: 'Otro' };

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// Confirmación propia (el confirm() del navegador puede estar bloqueado en la app instalada)
function askConfirm(msg, { ok = 'Aceptar', danger = false, cancel = 'Cancelar' } = {}) {
  return new Promise(res => {
    const box = $('#confirmBox');
    box.innerHTML = `<p>${esc(msg)}</p><div class="row">
      ${cancel ? `<button class="btn ghost" data-r="0">${esc(cancel)}</button>` : ''}
      <button class="btn ${danger ? 'danger' : ''}" data-r="1">${esc(ok)}</button></div>`;
    $('#confirm').classList.remove('hidden');
    $$('[data-r]', box).forEach(b => b.onclick = () => { $('#confirm').classList.add('hidden'); res(b.dataset.r === '1'); });
  });
}
const showMsg = (msg) => askConfirm(msg, { ok: 'Entendido', cancel: '' });

// ---------- almacenamiento ----------
const emptyDB = () => ({
  version: 1,
  places: [],     // {id, name, since}
  animals: [],    // {id, idv, rfid, sex, cat, motherId, periods:[{from,to,reason,detail}], places:[{placeId,date}], createdAt}
  sessions: [],   // {id, date, obs, placeId, open, createdAt, closedAt}
  records: [],    // {id, sessionId, animalId, text, ts}
  terneros: [],   // packs de terneros contados sin identificar: {id, placeId, date, m, h, s, obs, hist:[{date,text}]}
  cuadros: [],    // {id, placeId, name}
  pastoreos: [],  // {id, cuadroId, ingreso, salida, cantidad, obs}
  settings: { driveClientId: '', autoDrive: true, lastBackup: null, lastBackupHow: '', driveFolderId: null, driveDaily: null },
});
let DB = emptyDB();

const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('rodeo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async set(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
};

async function load() {
  try {
    const d = await idb.get('db');
    if (d) DB = Object.assign(emptyDB(), d, { settings: Object.assign(emptyDB().settings, d.settings || {}) });
  } catch (e) {
    const ls = localStorage.getItem('rodeo-db');
    if (ls) DB = JSON.parse(ls);
  }
}
async function save() {
  try { await idb.set('db', DB); }
  catch (e) { localStorage.setItem('rodeo-db', JSON.stringify(DB)); }
  renderHeader();
}

// ---------- modelo ----------
const place = (id) => DB.places.find(p => p.id === id);
const placeName = (id) => place(id)?.name || '—';
const animal = (id) => DB.animals.find(a => a.id === id);
const openSession = () => DB.sessions.find(s => s.open);
const session = (id) => DB.sessions.find(s => s.id === id);

const lastPeriod = (a) => a.periods[a.periods.length - 1];
const isActiveFlag = (a) => !!lastPeriod(a) && !lastPeriod(a).to;
// Identificación: N° de 4 dígitos, número largo (hasta 14) o texto (hasta 25). Alcanza con una.
const ALIAS_MAX = 25;
const normAlias = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, ALIAS_MAX);
const isComplete = (a) => /^\d{4}$/.test(a.idv || '') || /^\d{1,14}$/.test(a.rfid || '') || !!normAlias(a.alias);
const isActive = (a) => isActiveFlag(a) && isComplete(a);           // activo = alguna identificación + etiqueta activo
const nom = (a) => a?.idv || a?.alias || a?.rfid || '?';            // cómo se muestra el animal
const byAnimal = (a, b) => nom(a).localeCompare(nom(b), 'es', { numeric: true, sensitivity: 'base' });
const currentPlace = (a) => a.places.length ? a.places[a.places.length - 1].placeId : null;
const placeAt = (a, d) => { let p = null; for (const e of a.places) if (e.date <= d) p = e.placeId; return p ?? (a.places[0]?.placeId || null); };
const activeAt = (a, d) => isComplete(a) && a.periods.some(p => p.from <= d && (!p.to || p.to >= d)); // el día de la baja todavía cuenta

function activeAnimals(placeId) {
  return DB.animals.filter(a => isActive(a) && (!placeId || currentPlace(a) === placeId));
}
function sessionRecords(sid) { return DB.records.filter(r => r.sessionId === sid); }
// relevados = con algún registro dentro de la sesión; sacados = solo registros "fuera de sesión" (r.out)
function sessionAnimalIds(sid) { return [...new Set(sessionRecords(sid).filter(r => !r.out).map(r => r.animalId))]; }
function sessionOutIds(sid) {
  const inn = sessionAnimalIds(sid);
  return [...new Set(sessionRecords(sid).filter(r => r.out && !inn.includes(r.animalId)).map(r => r.animalId))];
}

// Busca por N° de 4 dígitos, número largo o texto (exacto; si no hay, por parte del texto)
function findAnimals(q) {
  q = normAlias(q);
  if (!q) return [];
  const t = q.toLowerCase();
  const byAlias = DB.animals.filter(a => normAlias(a.alias).toLowerCase() === t);
  if (!/^\d+$/.test(q)) return byAlias.length ? byAlias : DB.animals.filter(a => normAlias(a.alias).toLowerCase().includes(t));
  const byNum = q.length <= 4 ? DB.animals.filter(a => a.idv === q.padStart(4, '0'))
    : DB.animals.filter(a => a.rfid === q || (q.length <= 14 && a.rfid === q.padStart(14, '0')));
  return [...new Set([...byNum, ...byAlias])];
}
function idvTakenByActive(idv, exceptId) {
  return idv && DB.animals.find(a => a.id !== exceptId && a.idv === idv && isActiveFlag(a));
}
function aliasTaken(alias, exceptId) {
  const t = normAlias(alias).toLowerCase();
  return t && DB.animals.find(a => a.id !== exceptId && normAlias(a.alias).toLowerCase() === t && isActiveFlag(a));
}

// ---------- lugar de trabajo ----------
// '' = todos los lugares. Con una sesión abierta manda el lugar de la sesión.
const workPlace = () => { const id = DB.settings.workPlace || ''; return place(id) ? id : ''; };
const curPlace = () => { const s = openSession(); return s ? (s.placeId || '') : workPlace(); };
async function setPlace(id) {
  DB.settings.workPlace = id || '';
  const s = openSession(); if (s) s.placeId = id || null;
  await save();
}
const inPlace = (a, pl) => !pl || currentPlace(a) === pl;
function rfidTaken(rfid, exceptId) {
  return rfid && DB.animals.find(a => a.id !== exceptId && a.rfid === rfid && isActiveFlag(a));
}

// Historia de un animal: altas, traslados, observaciones de sesiones y bajas (más reciente primero)
const recDate = (r) => r.date || session(r.sessionId)?.date || r.ts.slice(0, 10);
function animalTimeline(a) {
  const ev = [];
  a.periods.forEach((p, i) => {
    ev.push({ date: p.from, ord: 0, cls: 'ev-on', title: i === 0 ? 'ALTA / ACTIVO' : 'REACTIVADO', text: '', key: 'from:' + i });
    if (p.to) ev.push({ date: p.to, ord: 3, cls: 'ev-off', title: 'BAJA – ' + (REASONS[p.reason] || p.reason).toUpperCase(), text: p.detail || '', key: 'to:' + i });
  });
  a.places.forEach((e, i) => ev.push({ date: e.date, ord: 1, cls: 'ev-place', title: i === 0 ? 'INGRESA A ' + placeName(e.placeId).toUpperCase() : 'TRASLADO A ' + placeName(e.placeId).toUpperCase(), text: e.obs || '', kg: e.kg, key: 'place:' + i, i }));
  DB.records.filter(r => r.animalId === a.id).forEach(r => {
    const s = session(r.sessionId);
    ev.push({ date: recDate(r), ord: 2, cls: r.out ? 'ev-out' : '', title: (s?.obs || 'Sesión') + (r.out ? ' – FUERA DE SESIÓN' : ''), text: r.text, kg: r.kg, rec: r, ts: r.ts, key: 'rec:' + r.id });
  });
  ev.sort((x, y) => (y.date.localeCompare(x.date)) || (y.ord - x.ord) || ((y.ts || '').localeCompare(x.ts || '')) || ((y.i ?? 0) - (x.i ?? 0)));
  return ev;
}
function timelineHTML(a, currentSid) {
  const ev = animalTimeline(a);
  if (!ev.length) return '<p class="muted">Sin historia.</p>';
  return `<ul class="timeline" data-aid="${a.id}">${ev.map(e => `
    <li class="${e.cls} ${e.rec && e.rec.sessionId === currentSid ? 'current' : ''}">
      <div class="row"><span class="date">${fmt(e.date)}</span><span class="sess">${esc(e.title)}</span>
      <button class="btn ghost sm right" data-ev="${e.key}" aria-label="Editar">✎</button></div>
      ${e.kg != null ? `<div class="kg">⚖️ ${fmtKg(e.kg)}</div>` : ''}
      ${e.rec ? `<div class="txt">${e.text ? esc(e.text) : (e.kg != null ? '' : '<span class="muted">(relevado, sin observación)</span>')}</div>` : (e.text ? `<div class="txt">${esc(e.text)}</div>` : '')}
    </li>`).join('')}</ul>`;
}
function lastWeight(a) {
  const w = animalTimeline(a).find(e => e.kg != null);
  return w ? { kg: w.kg, date: w.date } : null;
}
function bindTimeline(container, after) {
  const ul = $('.timeline', container); if (!ul) return;
  const a = animal(ul.dataset.aid);
  $$('[data-ev]', ul).forEach(b => b.onclick = () => {
    const [kind, k] = b.dataset.ev.split(':');
    if (kind === 'rec') editRecord(k, after);
    else if (kind === 'place') editPlaceEntry(a, +k, after);
    else if (kind === 'from') editPeriodFrom(a, +k, after);
    else editPeriodTo(a, +k, after);
  });
}

function animalTags(a) {
  const t = [];
  if (isActive(a)) t.push('<span class="tag">ACTIVO</span>');
  else if (isActiveFlag(a)) t.push('<span class="tag warn">INCOMPLETO</span>');
  else { const p = lastPeriod(a); t.push(`<span class="tag off">${esc((REASONS[p?.reason] || 'INACTIVO').toUpperCase())}</span>`); }
  return t.join(' ');
}
function animalLine(a) {
  const extra = [a.rfid && nom(a) !== a.rfid ? esc(a.rfid) : '', a.alias && nom(a) !== a.alias ? '“' + esc(a.alias) + '”' : ''].filter(Boolean);
  return `<div class="row"><span class="num">${esc(nom(a))}</span>
    <span class="tag grey">${a.sex ? SEX[a.sex] + (a.cat ? ' · ' + esc(a.cat) : '') : '¿sexo?'}</span>${animalTags(a)}
    <span class="right small muted">${esc(placeName(currentPlace(a)))}</span></div>
    <div class="rfid">${extra.length ? extra.join(' · ') : '<i>sin otra identificación</i>'}</div>`;
}

// ---------- header ----------
function renderHeader() {
  const s = openSession(), pl = curPlace();
  const act = activeAnimals(pl);
  $('#statActivos').textContent = act.length;
  $('#statActivos').nextElementSibling.textContent = pl ? 'Activos ' + placeName(pl) : 'Activos';
  const wp = $('#workPlace');
  wp.innerHTML = placeOptions(pl, 'Todos los lugares');
  wp.title = s ? 'Lugar de la sesión abierta' : 'Lugar para sesión, animales y reportes';
  const cnt = (f) => act.filter(f).length;
  const catsHTML = ['Toro', 'Novillo', 'Ternero', 'Vaca', 'Vaquillona', 'Ternera'].map(c => `<span>${c} <b>${cnt(a => a.cat === c)}</b></span>`).join('');
  const sinCat = cnt(a => !a.cat);
  $('#statDesglose').innerHTML = `<span><b>${act.length}</b> animales</span><span>♀ Hembras <b>${cnt(a => a.sex === 'H')}</b></span><span>♂ Machos <b>${cnt(a => a.sex === 'M')}</b></span><i class="gap"></i>${catsHTML}${sinCat ? `<span>Sin clasificar <b>${sinCat}</b></span>` : ''}`;
  $('#statRelevados').textContent = s ? sessionAnimalIds(s.id).length : '–';
  $('#statSesion').innerHTML = s
    ? `<span>${esc(s.obs)}</span><small>${fmt(s.date)}${s.placeId ? ' · ' + esc(placeName(s.placeId)) : ''}</small>`
    : `<span>Sin sesión abierta</span><small>Total animales: ${DB.animals.length}</small>`;
}

// ---------- modal ----------
function openModal(html, bind) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
  bind && bind($('#modalBox'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
$('#workPlace').onchange = async e => {
  await setPlace(e.target.value);
  const s = openSession();
  toast(s ? `Sesión "${s.obs}": ${e.target.value ? placeName(e.target.value) : 'todos los lugares'}` : `Trabajando en ${e.target.value ? placeName(e.target.value) : 'todos los lugares'}`);
  render();
};

// ---------- navegación ----------
let tab = 'sesion';
$$('#tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
function go(t) {
  tab = t;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  render();
  window.scrollTo(0, 0);
}
function render() {
  renderHeader();
  ({ sesion: renderSesion, animales: renderAnimales, lugares: renderLugares, reportes: renderReportes, cuadros: renderCuadros, backup: renderBackup })[tab]();
}

// ---------- selector de lugar ----------
function placeOptions(sel, withAll) {
  return (withAll ? `<option value="">${esc(withAll)}</option>` : '') +
    DB.places.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

// ================= SESIÓN =================
let lookup = { q: '', animalId: null };

function renderSesion() {
  const v = $('#view');
  if (!DB.places.length) return renderSetup(v);
  const s = openSession();
  if (!s) return renderNewSession(v);

  const relevados = sessionAnimalIds(s.id);
  const recent = sessionRecords(s.id).slice().sort((a, b) => b.ts.localeCompare(a.ts));
  const seen = new Set(); const recentAnimals = [];
  for (const r of recent) if (!seen.has(r.animalId)) { seen.add(r.animalId); recentAnimals.push(r); }
  const sacados = sessionOutIds(s.id);
  const faltan = activeAnimals(s.placeId).filter(a => !relevados.includes(a.id) && !sacados.includes(a.id));

  v.innerHTML = `
    ${backupNotice()}
    <div class="card">
      <label for="q" style="margin-top:0">N° de animal (4 dígitos), número largo (14) o texto (hasta ${ALIAS_MAX})</label>
      <div class="row">
        <input id="q" class="big grow" inputmode="${lookup.kb || 'numeric'}" autocomplete="off" maxlength="${ALIAS_MAX}" value="${esc(lookup.q)}" placeholder="0000" style="min-width:0">
        <button class="btn ghost sm" id="btnKb" title="Cambiar teclado">${lookup.kb === 'text' ? '123' : 'ABC'}</button>
        <button class="btn" id="btnBuscar" style="padding:16px">Buscar</button>
      </div>
    </div>
    <div id="lookupResult"></div>
    <div class="card">
      <div class="row"><h3 style="margin:0">Relevados en esta sesión (${relevados.length})</h3>
        <button class="btn ghost sm right" id="btnFaltan">Faltan ${faltan.length}</button></div>
      <div class="kpis" style="margin-top:8px">
        <div class="kpi"><b>${faltan.length}</b><small>Faltan</small></div>
        <div class="kpi"><b>${relevados.length}</b><small>Relevados</small></div>
        <div class="kpi"><b>${sacados.length}</b><small>Sacados</small></div>
      </div>
      ${recentAnimals.length ? `<ul class="list">${recentAnimals.slice(0, 30).map(r => { const a = animal(r.animalId); return a ? `
        <li class="click" data-open="${a.id}"><div class="row"><span class="num">${esc(nom(a))}</span>${r.out ? '<span class="tag warn">FUERA</span>' : ''}
        <span class="small muted grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.text || '(sin observación)')}</span>
        <span class="small muted">${fmtDT(r.ts).slice(11)}</span></div></li>` : ''; }).join('')}</ul>` : '<p class="muted small">Todavía no se relevó ningún animal.</p>'}
    </div>
    <div class="row">
      <button class="btn ghost grow" id="btnEditSes">Editar sesión</button>
      <button class="btn danger grow" id="btnCerrar">Cerrar sesión</button>
    </div>`;

  const q = $('#q');
  const doSearch = () => { lookup.q = normAlias(q.value); lookup.animalId = null; showLookup(); };
  $('#btnBuscar').onclick = doSearch;
  $('#btnKb').onclick = () => {
    lookup.kb = lookup.kb === 'text' ? 'numeric' : 'text';
    q.inputMode = lookup.kb; $('#btnKb').textContent = lookup.kb === 'text' ? '123' : 'ABC';
    q.blur(); setTimeout(() => q.focus(), 30);
  };
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  $$('[data-open]', v).forEach(li => li.onclick = () => { lookup = { ...lookup, q: nom(animal(li.dataset.open)), animalId: li.dataset.open }; q.value = lookup.q; showLookup(); window.scrollTo(0, 0); });
  $('#btnFaltan').onclick = () => showFaltan(s, faltan);
  $('#btnCerrar').onclick = () => closeSession(s);
  $('#btnEditSes').onclick = () => editSession(s);
  showLookup();
  if (!lookup.animalId) q.focus();
}

function renderSetup(v) {
  v.innerHTML = `
    <div class="card">
      <h2>Bienvenido 👋</h2>
      <p>Primero configurá el lugar donde están los animales (por ejemplo <b>Chacra</b>, <b>Media chacra</b>…). Después podés agregar más lugares y trasladar animales.</p>
      <label>Nombre del lugar</label><input id="pName" placeholder="Chacra">
      <label>Fecha de ingreso</label><input id="pDate" type="date" value="${today()}">
      <button class="btn block" id="pSave">Guardar lugar</button>
    </div>
    <div class="card"><p class="small muted">¿Ya tenés un respaldo? Andá a <b>Backup</b> para restaurarlo.</p></div>`;
  $('#pSave').onclick = async () => {
    const name = $('#pName').value.trim();
    if (!name) return toast('Poné un nombre');
    DB.places.push({ id: uid(), name, since: $('#pDate').value || today() });
    await save(); render();
  };
}

function renderNewSession(v) {
  const past = DB.sessions.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  v.innerHTML = `
    ${backupNotice()}
    <div class="card">
      <h2>Nueva sesión</h2>
      <label>Fecha</label><input id="sDate" type="date" value="${today()}">
      <label>Observación de la sesión</label>
      <input id="sObs" placeholder="Ej: RETIRO DIU" autocapitalize="characters" list="obsList">
      <datalist id="obsList">${[...new Set(DB.sessions.map(s => s.obs))].map(o => `<option value="${esc(o)}">`).join('')}</datalist>
      <label>Lugar</label><select id="sPlace">${placeOptions(workPlace(), 'Todos los lugares')}</select>
      <p class="small muted" style="margin:4px 0 0">Con un lugar elegido solo se trabaja sobre los animales de ese lugar; con "Todos" sobre cualquiera.</p>
      <button class="btn block" id="sStart">Iniciar sesión</button>
    </div>
    ${past.length ? `<div class="card"><h3 style="margin-top:0">Sesiones anteriores</h3><ul class="list">${past.map(s => `
      <li><div class="row"><div class="grow"><b>${fmt(s.date)}</b> · ${esc(s.obs)}<div class="small muted">${s.placeId ? esc(placeName(s.placeId)) + ' · ' : ''}${sessionAnimalIds(s.id).length} relevados</div></div>
      <button class="btn ghost sm" data-reopen="${s.id}">Reabrir</button>
      <button class="btn danger ghost sm" data-delses="${s.id}" aria-label="Eliminar sesión">🗑</button></div></li>`).join('')}</ul></div>` : ''}`;
  $$('[data-delses]', v).forEach(b => b.onclick = () => deleteSession(session(b.dataset.delses), render));
  $('#sStart').onclick = async () => {
    const obs = $('#sObs').value.trim().toUpperCase();
    if (!obs) return toast('Escribí la observación de la sesión');
    DB.sessions.push({ id: uid(), date: $('#sDate').value || today(), obs, placeId: $('#sPlace').value || null, open: true, createdAt: new Date().toISOString(), closedAt: null });
    DB.settings.workPlace = $('#sPlace').value;
    lookup = { q: '', animalId: null };
    await save(); render();
  };
  $$('[data-reopen]', v).forEach(b => b.onclick = async () => {
    const s = session(b.dataset.reopen);
    s.open = true; DB.settings.workPlace = s.placeId || ''; lookup = { q: '', animalId: null };
    await save(); render();
  });
}

// Elimina una sesión cerrada con todo lo que dejó en los animales: sus registros (peso/observación)
// y los traslados que se hicieron al "seleccionar y pasar" durante la sesión. Pide confirmar dos veces.
const sessionMoves = (s) => DB.animals.flatMap(a => a.places.map((e, i) => ({ a, e, i }))
  .filter(x => x.i > 0 && (x.e.obs || '').startsWith('Desde ') && x.e.obs.endsWith(`(sesión ${s.obs})`)));
async function deleteSession(s, after) {
  if (s.open) return toast('Cerrá la sesión antes de eliminarla');
  const recs = sessionRecords(s.id).length, ids = sessionAnimalIds(s.id).length + sessionOutIds(s.id).length, moves = sessionMoves(s);
  const head = `Sesión "${s.obs}" del ${fmt(s.date)}\n${recs} registro${recs === 1 ? '' : 's'} en ${ids} animal${ids === 1 ? '' : 'es'}${moves.length ? ` y ${moves.length} traslado${moves.length === 1 ? '' : 's'}` : ''}.`;
  if (!(await askConfirm(`¿Querés eliminar esta sesión?\n\n${head}`, { ok: 'Sí, continuar', danger: true }))) return;
  if (!(await askConfirm(`¿Seguro? Se borra la sesión y todos sus datos en los animales (pesos, observaciones${moves.length ? ', traslados' : ''}).\n\n${head}\n\nNo se puede deshacer.`, { ok: 'Sí, eliminar todo', danger: true }))) return;
  moves.sort((x, y) => y.i - x.i).forEach(x => x.a.places.splice(x.i, 1));
  DB.records = DB.records.filter(r => r.sessionId !== s.id);
  DB.sessions = DB.sessions.filter(x => x.id !== s.id);
  await save();
  toast('Sesión eliminada');
  after && after();
}

function editSession(s) {
  openModal(`
    <h2>Editar sesión</h2>
    <label>Fecha</label><input id="eDate" type="date" value="${s.date}">
    <label>Observación</label><input id="eObs" value="${esc(s.obs)}" autocapitalize="characters">
    <label>Lugar</label><select id="ePlace">${placeOptions(s.placeId, 'Todos los lugares')}</select>
    <button class="btn block" id="eSave">Guardar</button>
    ${sessionRecords(s.id).length ? '' : '<button class="btn danger ghost block" id="eDel">Eliminar sesión vacía</button>'}
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    $('#eSave', m).onclick = async () => {
      s.date = $('#eDate', m).value || s.date; s.obs = $('#eObs', m).value.trim().toUpperCase() || s.obs; s.placeId = $('#ePlace', m).value || null;
      if (s.open) DB.settings.workPlace = s.placeId || '';
      await save(); closeModal(); render();
    };
    const del = $('#eDel', m);
    if (del) del.onclick = async () => { DB.sessions = DB.sessions.filter(x => x.id !== s.id); await save(); closeModal(); render(); };
  });
}

async function closeSession(s) {
  const n = sessionAnimalIds(s.id).length, nOut = sessionOutIds(s.id).length;
  if (!(await askConfirm(`¿Cerrar la sesión "${s.obs}" del ${fmt(s.date)}?\nRelevados: ${n}${nOut ? ` · Sacados de la sesión: ${nOut}` : ''}`, { ok: 'Cerrar sesión' }))) return;
  s.open = false; s.closedAt = new Date().toISOString();
  s.snapshot = { activos: DB.animals.filter(a => activeAt(a, s.date) && (!s.placeId || placeAt(a, s.date) === s.placeId)).length, relevados: n };
  lookup = { q: '', animalId: null };
  await save();
  render();
  if (navigator.onLine && DB.settings.driveClientId && DB.settings.autoDrive) {
    try { await driveUpload(); toast('Sesión cerrada y respaldada en Drive ✓'); }
    catch (e) { toast('Sesión cerrada. Backup a Drive falló: ' + e.message, 4000); }
  } else toast('Sesión cerrada ✓');
}

// Lista de activos sin relevar: se pueden tildar varios y guardar la misma observación para todos.
function showFaltan(s, faltan) {
  faltan.sort(byAnimal);
  openModal(`<div class="row"><h2 class="grow" style="margin:0">Faltan relevar (${faltan.length})</h2><button class="btn ghost sm" onclick="closeModal()">✕</button></div>
    <p class="small muted">Activos${s.placeId ? ' en ' + esc(placeName(s.placeId)) : ''} que no tienen registro en esta sesión. Tildá uno o varios para cargarles la misma observación; tocá › para abrir uno.</p>
    ${faltan.length ? `
    <label class="row sel-all"><input type="checkbox" id="fAll"> <span class="grow">Seleccionar todos</span> <b id="fCount">0 seleccionados</b></label>
    <ul class="list">${faltan.map(a => `
      <li class="row sel-row"><label class="row grow" style="margin:0;color:var(--ink)"><input type="checkbox" class="fChk" value="${a.id}">
        <span class="num">${esc(nom(a))}</span><span class="tag grey">${a.sex ? SEX[a.sex] : '¿sexo?'}</span><span class="small muted grow" style="text-align:right">${esc(placeName(currentPlace(a)))}</span></label>
        <button class="btn ghost sm" data-go="${a.id}" aria-label="Abrir">›</button></li>`).join('')}</ul>
    <div class="sel-bar">
      <label style="margin-top:0">Observación para los seleccionados (${esc(s.obs)})</label>
      <textarea id="fObs" placeholder="Ej: no se presentó, en otro lote… (vacío = solo marcar como relevados)"></textarea>
      <button class="btn block" id="fSave" disabled>Guardar para 0 seleccionados</button>
    </div>` : '<p class="muted">¡Están todos!</p>'}`, m => {
    $$('[data-go]', m).forEach(b => b.onclick = () => { closeModal(); lookup = { ...lookup, q: nom(animal(b.dataset.go)), animalId: b.dataset.go }; render(); });
    if (!faltan.length) return;
    const chks = $$('.fChk', m);
    const sel = () => chks.filter(c => c.checked).map(c => c.value);
    const update = () => {
      const n = sel().length;
      $('#fCount', m).textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
      $('#fSave', m).textContent = `Guardar para ${n} seleccionado${n === 1 ? '' : 's'}`;
      $('#fSave', m).disabled = !n;
      $('#fAll', m).checked = n === chks.length;
    };
    chks.forEach(c => c.onchange = update);
    $('#fAll', m).onchange = e => { chks.forEach(c => c.checked = e.target.checked); update(); };
    $('#fSave', m).onclick = async () => {
      const ids = sel(), text = $('#fObs', m).value.trim();
      if (!ids.length) return;
      if (!(await askConfirm(`¿Guardar ${text ? `"${text}"` : 'como relevados (sin observación)'} para ${ids.length} animal${ids.length === 1 ? '' : 'es'}?\n\n${ids.map(id => nom(animal(id))).join(', ')}`, { ok: 'Guardar' }))) return;
      const ts = new Date().toISOString();
      ids.forEach(id => DB.records.push({ id: uid(), sessionId: s.id, animalId: id, kg: null, text, ts }));
      await save();
      toast(`✓ Guardado para ${ids.length}`);
      renderSesion();
      const rel = sessionAnimalIds(s.id), out = sessionOutIds(s.id);
      const rest = activeAnimals(s.placeId).filter(a => !rel.includes(a.id) && !out.includes(a.id));
      rest.length ? showFaltan(s, rest) : closeModal();
    };
  });
}

function showLookup() {
  const box = $('#lookupResult'); if (!box) return;
  const s = openSession();
  if (!lookup.q && !lookup.animalId) { box.innerHTML = ''; return; }
  let a = lookup.animalId ? animal(lookup.animalId) : null;
  if (!a) {
    const found = findAnimals(lookup.q);
    const act = found.filter(isActiveFlag);
    const actHere = s.placeId ? act.filter(x => inPlace(x, s.placeId)) : act;
    if (act.length === 1) a = act[0];
    else if (actHere.length === 1) a = actHere[0];
    else if (found.length) {
      box.innerHTML = `<div class="card"><h3 style="margin-top:0">${act.length ? 'Coincidencias' : 'Solo hay animales inactivos con ese número'}</h3>
        <ul class="list">${found.map(x => `<li class="click ${inPlace(x, s.placeId) ? '' : 'otro-lugar'}" data-pick="${x.id}">${animalLine(x)}</li>`).join('')}</ul>
        <button class="btn ghost block" id="btnNew">Dar de alta uno nuevo con este número</button></div>`;
      $$('[data-pick]', box).forEach(li => li.onclick = () => { lookup.animalId = li.dataset.pick; showLookup(); });
      $('#btnNew', box).onclick = () => registerAnimal(lookup.q);
      return;
    } else {
      box.innerHTML = `<div class="card center"><p><b>${esc(lookup.q)}</b> no está registrado.</p>
        <button class="btn block" id="btnNew">Dar de alta este animal</button></div>`;
      $('#btnNew', box).onclick = () => registerAnimal(lookup.q);
      return;
    }
  }
  lookup.animalId = a.id;
  const recsHere = DB.records.filter(r => r.animalId === a.id && r.sessionId === s.id);
  // sesión de un lugar: un animal de otro lugar se marca en amarillo; al seleccionarlo se lo trae
  // al lugar de la sesión (queda el traslado en su historia) y recién ahí se le cargan datos
  if (!inPlace(a, s.placeId)) {
    const from = placeName(currentPlace(a)), to = placeName(s.placeId);
    box.innerHTML = `
      <div class="card otro-lugar">
        ${animalLine(a)}
        <div class="otro-aviso">⚠️ Figura en <b>${esc(from)}</b>, no en <b>${esc(to)}</b>.</div>
        <button class="btn block" id="btnTraer">Seleccionar y pasar a ${esc(to)}</button>
        <div class="row" style="margin-top:8px">
          <button class="btn ghost grow" id="btnFicha">Ficha</button>
          <button class="btn ghost grow" id="btnOtro">Buscar otro</button>
        </div>
      </div>
      <div class="card"><h3 style="margin-top:0">Historia</h3>${timelineHTML(a, s.id)}</div>`;
    $('#btnFicha').onclick = () => animalDetail(a.id, () => renderSesion());
    $('#btnOtro').onclick = () => { lookup = { ...lookup, q: '', animalId: null }; renderSesion(); };
    $('#btnTraer').onclick = async () => {
      // fecha de la sesión, salvo que el último movimiento sea posterior
      const last = a.places[a.places.length - 1]?.date || '';
      a.places.push({ placeId: s.placeId, date: last > s.date ? last : s.date, kg: null, obs: `Desde ${from} (sesión ${s.obs})` });
      await save();
      toast(`${nom(a)}: de ${from} a ${to} ✓`);
      showLookup();
    };
    bindTimeline(box, () => renderSesion());
    return;
  }
  box.innerHTML = `
    <div class="card">
      ${animalLine(a)}
      ${recsHere.length ? '<div class="notice" style="margin:10px 0 0">Ya relevado en esta sesión. Podés agregar otra observación.</div>' : ''}
      ${!isActiveFlag(a) ? '<div class="notice" style="margin:10px 0 0">Este animal está dado de baja.</div>' : ''}
      ${isActiveFlag(a) && !isComplete(a) ? '<div class="notice" style="margin:10px 0 0">Falta la identificación: no cuenta como activo. Tocá <b>Ficha</b> para completarla.</div>' : ''}
      ${!a.sex ? '<div class="notice" style="margin:10px 0 0">Falta indicar si es macho o hembra.</div>' : ''}
      <label>Peso (kg)</label>${kgInput('obsKg')}
      <label>Observación de hoy (${esc(s.obs)})</label>
      <textarea id="obsTxt" placeholder="Escribí la observación… (puede quedar vacío si solo se relevó)"></textarea>
      <div class="actions4">
        <button class="btn ghost" id="btnFicha">Ficha</button>
        <button class="btn" id="btnGuardarObs">Guardar ✓</button>
        <button class="btn btn-out" id="btnGuardarFuera">Guardar fuera de sesión</button>
        <button class="btn btn-cancel" id="btnAnular">Anular</button>
      </div>
    </div>
    <div class="card"><h3 style="margin-top:0">Historia</h3>${timelineHTML(a, s.id)}</div>`;
  const guardar = (out) => async () => {
    const kg = parseKg($('#obsKg').value);
    if (Number.isNaN(kg)) return toast('Peso inválido');
    DB.records.push({ id: uid(), sessionId: s.id, animalId: a.id, kg, text: $('#obsTxt').value.trim(), ts: new Date().toISOString(), ...(out ? { out: true } : {}) });
    await save();
    toast(out ? `✓ ${nom(a)} guardado fuera de sesión` : `✓ ${nom(a)} guardado`);
    lookup = { ...lookup, q: '', animalId: null };
    renderSesion();
  };
  $('#btnGuardarObs').onclick = guardar(false);
  $('#btnGuardarFuera').onclick = guardar(true);
  $('#btnAnular').onclick = () => { lookup = { ...lookup, q: '', animalId: null }; renderSesion(); };
  $('#btnFicha').onclick = () => animalDetail(a.id, () => renderSesion());
  bindTimeline(box, () => renderSesion());
}

// ---------- edición de eventos de la historia ----------
// Cada editor vuelve a la pantalla anterior (after) al guardar, eliminar o cancelar.
function eventModal(html, after, bind) {
  const back = () => { closeModal(); after && after(); };
  openModal(html + '<button class="btn ghost block" id="xCancel">Cancelar</button>', m => { $('#xCancel', m).onclick = back; bind(m, back); });
}
const delBtn = (label) => `<button class="btn danger ghost block" id="xDel">🗑 ${label}</button>`;

function editRecord(rid, after) {
  const r = DB.records.find(x => x.id === rid); if (!r) return;
  const s = session(r.sessionId), a = animal(r.animalId);
  eventModal(`<h2>Editar observación</h2><p class="small muted">Animal ${esc(nom(a))} · Sesión ${esc(s?.obs)} (${fmt(s?.date)})</p>
    <label>Fecha</label><input id="rDate" type="date" value="${recDate(r)}">
    <label>Peso (kg)</label>${kgInput('rKg', r.kg)}
    <label>Observación</label><textarea id="rTxt">${esc(r.text)}</textarea>
    <button class="btn block" id="rSave">Guardar</button>${delBtn('Eliminar este registro')}`, after, (m, back) => {
    $('#rSave', m).onclick = async () => {
      const kg = parseKg($('#rKg', m).value);
      if (Number.isNaN(kg)) return toast('Peso inválido');
      const d = $('#rDate', m).value || recDate(r);
      r.date = d === s?.date ? undefined : d;
      r.kg = kg;
      r.text = $('#rTxt', m).value.trim();
      await save(); toast('Registro actualizado'); back();
    };
    $('#xDel', m).onclick = async () => {
      if (!(await askConfirm(`¿Seguro que querés eliminar este registro del animal ${nom(a)}?\n\n${fmt(recDate(r))} · ${s?.obs || ''}\n${r.text || '(sin observación)'}\n\nNo se puede deshacer.`, { ok: 'Sí, eliminar', danger: true }))) return;
      DB.records = DB.records.filter(x => x.id !== rid);
      await save(); toast('Registro eliminado'); back();
    };
  });
}

function editPlaceEntry(a, i, after) {
  const e = a.places[i];
  eventModal(`<h2>${i === 0 ? 'Ingreso' : 'Traslado'} – ${esc(nom(a))}</h2>
    <label>Lugar</label><select id="peP">${placeOptions(e.placeId)}</select>
    <label>Fecha</label><input id="peD" type="date" value="${e.date}">
    <label>Peso (kg)</label>${kgInput('peKg', e.kg)}
    <label>Observación</label><textarea id="peObs">${esc(e.obs || '')}</textarea>
    <button class="btn block" id="peSave">Guardar</button>
    ${a.places.length > 1 ? delBtn('Eliminar este traslado') : '<p class="small muted">Es el único lugar del animal: se puede cambiar pero no eliminar.</p>'}`, after, (m, back) => {
    $('#peSave', m).onclick = async () => {
      const kg = parseKg($('#peKg', m).value);
      if (Number.isNaN(kg)) return toast('Peso inválido');
      e.placeId = $('#peP', m).value; e.date = $('#peD', m).value || e.date;
      e.kg = kg; e.obs = $('#peObs', m).value.trim();
      a.places.sort((x, y) => x.date.localeCompare(y.date));
      await save(); toast('Guardado'); back();
    };
    const del = $('#xDel', m);
    if (del) del.onclick = async () => {
      if (!(await askConfirm(`¿Seguro que querés eliminar el ${i === 0 ? 'ingreso' : 'traslado'} a ${placeName(e.placeId)} del ${fmt(e.date)}?`, { ok: 'Sí, eliminar', danger: true }))) return;
      a.places.splice(i, 1);
      await save(); toast('Traslado eliminado'); back();
    };
  });
}

function editPeriodFrom(a, i, after) {
  const p = a.periods[i], prev = a.periods[i - 1];
  eventModal(`<h2>${i === 0 ? 'Fecha de activación' : 'Reactivación'} – ${esc(nom(a))}</h2>
    <label>Fecha</label><input id="pfD" type="date" value="${p.from}">
    <button class="btn block" id="pfSave">Guardar</button>
    ${i > 0 ? delBtn('Eliminar esta reactivación') : '<p class="small muted">Para borrar el animal por completo usá <b>Eliminar animal</b> en su ficha.</p>'}`, after, (m, back) => {
    $('#pfSave', m).onclick = async () => {
      const d = $('#pfD', m).value || p.from;
      if (p.to && d > p.to) return toast('La activación no puede ser posterior a la baja');
      if (prev && d < prev.to) return toast('No puede ser anterior a la baja previa (' + fmt(prev.to) + ')');
      p.from = d; await save(); toast('Guardado'); back();
    };
    const del = $('#xDel', m);
    if (del) del.onclick = async () => {
      if (!(await askConfirm(`¿Seguro que querés eliminar la reactivación del ${fmt(p.from)}?${p.to ? ' También se borra la baja posterior.' : ''}\nEl animal vuelve a quedar dado de baja.`, { ok: 'Sí, eliminar', danger: true }))) return;
      a.periods.splice(i, 1);
      await save(); toast('Reactivación eliminada'); back();
    };
  });
}

function editPeriodTo(a, i, after) {
  const p = a.periods[i], isLast = i === a.periods.length - 1;
  eventModal(`<h2>Baja – ${esc(nom(a))}</h2>
    <label>Motivo</label>
    <div class="seg" id="ptR">${Object.entries(REASONS).map(([k, v]) => `<button data-v="${k}" class="${p.reason === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    <label>Aclaración</label><input id="ptDet" value="${esc(p.detail || '')}">
    <label>Fecha</label><input id="ptD" type="date" value="${p.to}">
    <button class="btn block" id="ptSave">Guardar</button>
    ${isLast ? delBtn('Anular baja (vuelve a estar activo)') : '<p class="small muted">Hay una reactivación posterior: para anular esta baja primero eliminá la reactivación.</p>'}`, after, (m, back) => {
    let reason = p.reason;
    $$('#ptR button', m).forEach(b => b.onclick = () => { reason = b.dataset.v; $$('#ptR button', m).forEach(x => x.classList.toggle('on', x === b)); });
    $('#ptSave', m).onclick = async () => {
      const d = $('#ptD', m).value || p.to, detail = $('#ptDet', m).value.trim();
      if (d < p.from) return toast('La baja no puede ser anterior a la activación (' + fmt(p.from) + ')');
      const next = a.periods[i + 1];
      if (next && d > next.from) return toast('No puede ser posterior a la reactivación (' + fmt(next.from) + ')');
      if (reason === 'otro' && !detail) return toast('Aclará el motivo');
      Object.assign(p, { to: d, reason, detail });
      await save(); toast('Guardado'); back();
    };
    const del = $('#xDel', m);
    if (del) del.onclick = async () => {
      if (idvTakenByActive(a.idv, a.id)) return toast(`Ya hay otro animal activo con el N° ${nom(a)}`);
      if (aliasTaken(a.alias, a.id)) return toast(`Ya hay otro animal activo identificado como "${a.alias}"`);
      if (!(await askConfirm(`¿Seguro que querés anular la baja (${REASONS[p.reason]}, ${fmt(p.to)})?\nEl animal ${nom(a)} vuelve a estar activo.`, { ok: 'Sí, anular', danger: true }))) return;
      p.to = null; delete p.reason; delete p.detail;
      await save(); toast('Baja anulada'); back();
    };
  });
}

function deleteAnimal(a, after) {
  const n = DB.records.filter(r => r.animalId === a.id).length;
  askConfirm(`¿Seguro que querés ELIMINAR el animal ${nom(a)}?\nSe borra toda su historia (${n} registros). No se puede deshacer.\n\n${a.fromLot && lot(a.fromLot.id) ? '\nSe devuelve 1 ternero al pack del que se descontó.\n' : ''}\nSi fue vendido o murió, usá "Dar de baja".`, { ok: 'Sí, eliminar', danger: true }).then(async ok => {
    if (!ok) return;
    const l = a.fromLot && lot(a.fromLot.id);
    if (l) { l[a.fromLot.cat] = (l[a.fromLot.cat] || 0) + 1; (l.hist ||= []).push({ date: today(), text: `Se eliminó el animal ${nom(a)}: se suma 1 de vuelta (${LOT_CATS[a.fromLot.cat].toLowerCase()})` }); }
    DB.animals = DB.animals.filter(x => x.id !== a.id);
    DB.records = DB.records.filter(r => r.animalId !== a.id);
    if (lookup.animalId === a.id) lookup = { q: '', animalId: null };
    await save(); closeModal(); toast(`Animal ${nom(a)} eliminado` + (l ? ' · devuelto al pack' : '')); after && after();
  });
}

// ---------- terneros contados sin identificar (packs) ----------
const LOT_CATS = { m: 'Macho', h: 'Hembra', s: 'Sin identificar' };
const lot = (id) => DB.terneros.find(l => l.id === id);
const lotTotal = (l) => (l.m || 0) + (l.h || 0) + (l.s || 0);
const lotCounts = (l) => `♂ ${l.m || 0} · ♀ ${l.h || 0} · ? ${l.s || 0}`;
const lotLabel = (l) => `${placeName(l.placeId)} · ${lotTotal(l)} (${lotCounts(l)}) · ${fmt(l.date)}`;
const lotsIn = (pl) => DB.terneros.filter(l => l.placeId === pl).reduce((n, l) => n + lotTotal(l), 0);
function lotsCardHTML(pl) {
  const list = DB.terneros.filter(l => !pl || l.placeId === pl);
  const total = list.reduce((n, l) => n + lotTotal(l), 0);
  return `<div class="card">
    <div class="row"><h3 class="grow" style="margin:0">Terneros contados sin identificar${list.length ? ` (${total})` : ''}</h3><button class="btn sm" id="lotNew">+ Pack</button></div>
    <ul class="list">${list.map(l => `<li><div class="row"><div class="grow"><b>${lotTotal(l)}</b> · ${lotCounts(l)}
      <div class="small muted">${esc(placeName(l.placeId))} · contados ${fmt(l.date)}${l.obs ? ' · ' + esc(l.obs) : ''}</div></div>
      <button class="btn ghost sm" data-lotmove="${l.id}">📍</button><button class="btn ghost sm" data-lotedit="${l.id}">✎</button></div></li>`).join('') || '<li class="muted">Sin packs. Con “+ Pack” cargás una cantidad de terneros contados.</li>'}</ul>
  </div>`;
}
function bindLots(v, after) {
  $('#lotNew', v).onclick = () => { if (!DB.places.length) return toast('Primero creá un lugar'); lotForm(null, after); };
  $$('[data-lotedit]', v).forEach(b => b.onclick = () => lotForm(lot(b.dataset.lotedit), after));
  $$('[data-lotmove]', v).forEach(b => b.onclick = () => lotMove(lot(b.dataset.lotmove), after));
}
function lotForm(l, after) {
  openModal(`<h2>${l ? 'Editar pack de terneros' : 'Terneros contados'}</h2>
    <p class="small muted" style="margin:0">Cantidad contada sin número. Cuando se da de alta cada animal se puede descontar de acá.</p>
    <div class="row" style="gap:8px">
      <div class="grow"><label>♂ Machos</label><input id="lM" inputmode="numeric" value="${l ? l.m || 0 : 0}"></div>
      <div class="grow"><label>♀ Hembras</label><input id="lH" inputmode="numeric" value="${l ? l.h || 0 : 0}"></div>
      <div class="grow"><label>? Sin identificar</label><input id="lS" inputmode="numeric" value="${l ? l.s || 0 : 0}"></div>
    </div>
    <label>Lugar</label><select id="lPlace">${placeOptions(l ? l.placeId : curPlace() || DB.places[0]?.id)}</select>
    <label>Fecha del conteo</label><input id="lDate" type="date" value="${l ? l.date : (openSession()?.date || today())}">
    <label>Observación</label><input id="lObs" value="${esc(l?.obs || '')}" placeholder="Opcional">
    ${l && l.hist?.length ? `<h3>Historia</h3><ul class="list small">${[...l.hist].reverse().map(h => `<li>${fmt(h.date)} · ${esc(h.text)}</li>`).join('')}</ul>` : ''}
    <button class="btn block" id="lSave">Guardar</button>
    ${l ? '<button class="btn danger ghost block" id="lDel">🗑 Eliminar pack</button>' : ''}
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    const n = (id) => Math.floor(Number(onlyDigits($(id, m).value)) || 0);
    ['#lM', '#lH', '#lS'].forEach(s => $(s, m).addEventListener('input', e => e.target.value = onlyDigits(e.target.value)));
    $('#lSave', m).onclick = async () => {
      const vals = { m: n('#lM'), h: n('#lH'), s: n('#lS'), placeId: $('#lPlace', m).value, date: $('#lDate', m).value || today(), obs: $('#lObs', m).value.trim() };
      if (!vals.m && !vals.h && !vals.s) return toast('Cargá al menos un ternero');
      if (l) { if (vals.placeId !== l.placeId) (l.hist ||= []).push({ date: vals.date, text: 'Corregido a ' + placeName(vals.placeId) }); Object.assign(l, vals); }
      else DB.terneros.push({ id: uid(), ...vals, hist: [{ date: vals.date, text: `Conteo en ${placeName(vals.placeId)}: ${lotCounts(vals)}` }] });
      await save(); closeModal(); after && after();
    };
    const del = $('#lDel', m);
    if (del) del.onclick = () => askConfirm(`¿Eliminar este pack de ${lotTotal(l)} terneros?`, { ok: 'Sí, eliminar', danger: true }).then(async ok => {
      if (!ok) return; DB.terneros = DB.terneros.filter(x => x.id !== l.id); await save(); closeModal(); after && after();
    });
  });
}
function lotMove(l, after) {
  openModal(`<h2>Trasladar ${lotTotal(l)} terneros</h2>
    <p class="small muted" style="margin:0">Ahora en ${esc(placeName(l.placeId))}</p>
    <label>Destino</label><select id="lmTo">${placeOptions(l.placeId)}</select>
    <label>Fecha del traslado</label><input id="lmDate" type="date" value="${openSession()?.date || today()}">
    <button class="btn block" id="lmSave">Trasladar</button>
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    $('#lmSave', m).onclick = async () => {
      const to = $('#lmTo', m).value;
      if (to === l.placeId) return toast('Ya están en ' + placeName(to));
      (l.hist ||= []).push({ date: $('#lmDate', m).value || today(), text: 'Traslado a ' + placeName(to) });
      l.placeId = to;
      await save(); closeModal(); toast('Pack trasladado a ' + placeName(to)); after && after();
    };
  });
}
// madre y crías en la ficha del animal
function familyHTML(a) {
  const mom = a.motherId && animal(a.motherId), kids = DB.animals.filter(x => x.motherId === a.id).sort(byAnimal);
  if (!mom && !kids.length) return '';
  return `<p class="small" style="margin:0 0 8px">${mom ? `<b>Madre:</b> ${esc(nom(mom))}` : ''}${mom && kids.length ? ' · ' : ''}${kids.length ? `<b>Crías:</b> ${kids.map(k => esc(nom(k))).join(', ')}` : ''}</p>`;
}

// ---------- alta / edición de animal ----------
function registerAnimal(q, after) {
  q = normAlias(q);
  const s = openSession();
  const digits = /^\d+$/.test(q);
  const pre4 = digits && q.length <= 4 ? q.padStart(4, '0') : '';
  const pre14 = digits && q.length > 4 ? q : '';
  const preTxt = q && !digits ? q : '';
  animalForm({ title: 'Alta de animal', idv: pre4, rfid: pre14, alias: preTxt, sex: '', placeId: s?.placeId || curPlace() || DB.places[0]?.id, date: s?.date || today(), isNew: true }, async (f) => {
    const a = { id: uid(), idv: f.idv, rfid: f.rfid, alias: f.alias, sex: f.sex, cat: f.cat || '', motherId: f.motherId || null, periods: [{ from: f.date, to: null }], places: [{ placeId: f.placeId, date: f.date, kg: f.kg, obs: f.obs }], createdAt: new Date().toISOString() };
    DB.animals.push(a);
    const l = f.lot && lot(f.lot.id);
    const desc = !!(l && l[f.lot.cat] > 0);
    if (desc) { a.fromLot = { id: l.id, cat: f.lot.cat }; l[f.lot.cat]--; (l.hist ||= []).push({ date: f.date, text: `Alta del animal ${nom(a)}: descuenta 1 (${LOT_CATS[f.lot.cat].toLowerCase()})` }); }
    await save();
    toast(`Animal ${nom(a)} dado de alta` + (desc ? ' · descontado del pack' : ''));
    if (after) return after(a);
    lookup = { ...lookup, q: nom(a), animalId: a.id };
    render();
  });
}

function animalForm(d, onSave) {
  openModal(`
    <h2>${esc(d.title)}</h2>
    <p class="small muted" style="margin:0">Cargá al menos una identificación; podés cargar las tres.</p>
    <label>Número identificatorio (4 dígitos)</label>
    <input id="fIdv" class="big" inputmode="numeric" maxlength="4" value="${esc(d.idv)}">
    <label>Número largo (hasta 14 dígitos)</label>
    <input id="fRfid" inputmode="numeric" maxlength="14" value="${esc(d.rfid)}" placeholder="Ej: 00032123456789" style="font-size:20px;letter-spacing:1px">
    <label>Identificación en texto (hasta ${ALIAS_MAX} caracteres)</label>
    <input id="fAlias" maxlength="${ALIAS_MAX}" value="${esc(d.alias)}" placeholder="Ej: Overa cara blanca">
    <label>Sexo</label>
    <div class="seg" id="fSex"><button data-v="M" class="${d.sex === 'M' ? 'on' : ''}">♂ Macho</button><button data-v="H" class="${d.sex === 'H' ? 'on' : ''}">♀ Hembra</button></div>
    <div class="seg" id="fCat" style="margin-top:6px"></div>
    <label>Madre (N° de un animal del campo)</label>
    <input id="fMother" maxlength="${ALIAS_MAX}" value="${esc(d.motherId && animal(d.motherId) ? nom(animal(d.motherId)) : '')}" placeholder="Opcional – elegí de la lista" list="fMotherList" autocomplete="off">
    <datalist id="fMotherList">${DB.animals.filter(x => x.id !== d.id && isActiveFlag(x) && x.sex !== 'M').sort(byAnimal).map(x => `<option value="${esc(nom(x))}">${esc(placeName(currentPlace(x)))}</option>`).join('')}</datalist>
    ${d.isNew && DB.terneros.some(l => lotTotal(l) > 0) ? `
      <label>Descontar de un pack de terneros contados</label>
      <select id="fLot"><option value="">— No descontar —</option>${DB.terneros.filter(l => lotTotal(l) > 0).map(l => `<option value="${l.id}">${esc(lotLabel(l))}</option>`).join('')}</select>
      <select id="fLotCat" class="hidden" style="margin-top:6px"></select>` : ''}
    ${d.isNew ? `
      <label>Lugar</label><select id="fPlace">${placeOptions(d.placeId)}</select>
      <label>Fecha de activación</label><input id="fDate" type="date" value="${d.date}">
      <label>Peso de ingreso (kg)</label>${kgInput('fKg')}
      <label>Observación de ingreso</label><input id="fObs" placeholder="Opcional">` : `
      <label>Fecha de activación</label><input id="fDate" type="date" value="${d.date}">`}
    <button class="btn block" id="fSave">Guardar</button>
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    let sex = d.sex, cat = d.cat || '';
    const drawCats = () => {
      if (!CATS[sex]?.includes(cat)) cat = '';
      $('#fCat', m).innerHTML = (CATS[sex] || []).map(c => `<button data-v="${c}" class="${c === cat ? 'on' : ''}">${c}</button>`).join('');
      $$('#fCat button', m).forEach(b => b.onclick = () => { cat = cat === b.dataset.v ? '' : b.dataset.v; drawCats(); });
    };
    drawCats();
    $$('#fSex button', m).forEach(b => b.onclick = () => { sex = b.dataset.v; $$('#fSex button', m).forEach(x => x.classList.toggle('on', x === b)); drawCats(); });
    const lotSel = $('#fLot', m), catSel = $('#fLotCat', m);
    const fillCats = () => {
      const l = lot(lotSel.value); catSel.classList.toggle('hidden', !l); if (!l) return;
      catSel.innerHTML = Object.keys(LOT_CATS).map(c => `<option value="${c}" ${l[c] ? '' : 'disabled'}>${LOT_CATS[c]} (${l[c] || 0})</option>`).join('');
      const want = sex === 'M' ? 'm' : sex === 'H' ? 'h' : 's';
      catSel.value = l[want] ? want : Object.keys(LOT_CATS).find(c => l[c]);
    };
    if (lotSel) { lotSel.onchange = fillCats; $$('#fSex button', m).forEach(b => b.addEventListener('click', () => { if (lotSel.value) fillCats(); })); }
    ['#fIdv', '#fRfid'].forEach(s => $(s, m).addEventListener('input', e => e.target.value = onlyDigits(e.target.value)));
    $('#fSave', m).onclick = async () => {
      const idv = onlyDigits($('#fIdv', m).value);
      const rfid = onlyDigits($('#fRfid', m).value);
      const alias = normAlias($('#fAlias', m).value);
      if (!idv && !rfid && !alias) return toast('Cargá el N° de 4 dígitos, el número largo o un texto');
      if (idv && !/^\d{4}$/.test(idv)) return toast('El número identificatorio debe tener 4 dígitos');
      if (rfid.length > 14) return toast('El número largo tiene hasta 14 dígitos');
      if (!sex) return toast('Indicá si es macho o hembra');
      if (idvTakenByActive(idv, d.id)) return toast(`Ya hay un animal activo con el N° ${idv}`);
      if (rfidTaken(rfid, d.id)) return toast('Ese número largo ya lo tiene otro animal activo');
      if (aliasTaken(alias, d.id)) return toast(`Ya hay un animal activo identificado como "${alias}"`);
      let motherId = null;
      const mq = normAlias($('#fMother', m).value);
      if (mq) {
        const ms = findAnimals(mq).filter(x => x.id !== d.id && isActiveFlag(x) && x.sex !== 'M');
        if (!ms.length) return toast(`La madre tiene que ser un animal que ya está en el campo: "${mq}" no figura`);
        if (ms.length > 1) return toast(`Hay más de un animal con "${mq}": usá otro número`);
        motherId = ms[0].id;
      }
      const lotId = lotSel?.value;
      const lotCat = lotId ? catSel.value : '';
      if (lotId && !(lot(lotId)?.[lotCat] > 0)) return toast('Ese pack no tiene terneros en esa categoría');
      const kg = $('#fKg', m) ? parseKg($('#fKg', m).value) : null;
      if (Number.isNaN(kg)) return toast('Peso inválido');
      const vals = { idv, rfid, alias, sex, placeId: $('#fPlace', m)?.value, date: $('#fDate', m).value || today(), kg, obs: $('#fObs', m)?.value.trim() || '', motherId, cat, lot: lotId ? { id: lotId, cat: lotCat } : null };
      closeModal();
      await onSave(vals);
    };
    setTimeout(() => (d.idv || d.rfid || d.alias ? null : $('#fIdv', m))?.focus(), 50);
  });
}

function animalDetail(id, after) {
  const a = animal(id); if (!a) return;
  const refresh = () => { after && after(); animalDetail(id, after); };
  const p = lastPeriod(a), lw = lastWeight(a);
  openModal(`
    <div class="row"><h2 class="grow" style="margin:0">Animal ${esc(nom(a))}</h2><button class="btn ghost sm" onclick="closeModal()">✕</button></div>
    <div style="margin:8px 0">${animalLine(a)}</div>
    ${familyHTML(a)}
    <div class="kpis" style="grid-template-columns:1fr 1fr">
      <div class="kpi"><b class="d">${fmt(p?.from)}</b><small>Activado</small></div>
      <div class="kpi"><b class="d">${p?.to ? fmt(p.to) : '—'}</b><small>${p?.to ? 'Baja: ' + esc(REASONS[p.reason]) : 'Sin baja'}</small></div>
      <div class="kpi"><b>${DB.records.filter(r => r.animalId === a.id).length}</b><small>Registros</small></div>
      <div class="kpi"><b class="d">${lw ? fmtKg(lw.kg) : '—'}</b><small>${lw ? 'Peso al ' + fmt(lw.date) : 'Sin peso'}</small></div>
    </div>
    ${p?.to && p.detail ? `<p class="small"><b>Detalle de baja:</b> ${esc(p.detail)}</p>` : ''}
    <div class="row wrap" style="margin:12px 0">
      <button class="btn ghost sm" id="dEdit">✎ Editar</button>
      <button class="btn ghost sm" id="dMove">📍 Trasladar</button>
      ${isActiveFlag(a) ? '<button class="btn danger ghost sm" id="dOff">Dar de baja</button>' : '<button class="btn ghost sm" id="dOn">Reactivar</button>'}
      <button class="btn ghost sm" id="dCsv">⬇ CSV</button>
    </div>
    <h3>Historia</h3>
    ${timelineHTML(a, openSession()?.id)}
    <p class="small muted">Tocá ✎ en cualquier fila para corregir la fecha o eliminarla.</p>
    <button class="btn danger ghost block" id="dDelete">🗑 Eliminar animal (carga errónea)</button>`, m => {
    $('#dDelete', m).onclick = () => deleteAnimal(a, after);
    $('#dEdit', m).onclick = () => animalForm({ title: 'Editar animal', id: a.id, idv: a.idv, rfid: a.rfid, alias: a.alias || '', sex: a.sex, cat: a.cat, motherId: a.motherId, date: p.from }, async f => {
      Object.assign(a, { idv: f.idv, rfid: f.rfid, alias: f.alias, sex: f.sex, cat: f.cat, motherId: f.motherId }); p.from = f.date;
      await save(); refresh();
    });
    $('#dMove', m).onclick = () => moveAnimals([a.id], refresh);
    const off = $('#dOff', m); if (off) off.onclick = () => deactivate(a, refresh);
    const on = $('#dOn', m); if (on) on.onclick = () => reactivate(a, refresh);
    $('#dCsv', m).onclick = () => exportAnimalCSV(a);
    bindTimeline(m, refresh);
  });
}

function deactivate(a, after) {
  openModal(`<h2>Dar de baja – ${esc(nom(a))}</h2>
    <label>Motivo</label>
    <div class="seg" id="bR"><button data-v="vendido">Vendido</button><button data-v="muerto">Muerto</button><button data-v="otro">Otro</button></div>
    <label>Aclaración <span id="bReq"></span></label><input id="bDet" placeholder="Ej: comprador, causa, etc.">
    <label>Fecha</label><input id="bDate" type="date" value="${openSession()?.date || today()}">
    <button class="btn danger block" id="bSave">Confirmar baja</button>
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    let reason = '';
    $$('#bR button', m).forEach(b => b.onclick = () => { reason = b.dataset.v; $$('#bR button', m).forEach(x => x.classList.toggle('on', x === b)); $('#bReq', m).textContent = reason === 'otro' ? '(obligatoria)' : ''; });
    $('#bSave', m).onclick = async () => {
      if (!reason) return toast('Elegí el motivo');
      const detail = $('#bDet', m).value.trim();
      if (reason === 'otro' && !detail) return toast('Aclará el motivo');
      const date = $('#bDate', m).value || today();
      const p = lastPeriod(a);
      if (date < p.from) return toast('La fecha de baja es anterior a la activación');
      Object.assign(p, { to: date, reason, detail });
      await save(); closeModal(); toast(`${nom(a)} dado de baja`); after && after();
    };
  });
}

function reactivate(a, after) {
  openModal(`<h2>Reactivar – ${esc(nom(a))}</h2>
    <label>Fecha de activación</label><input id="rDate" type="date" value="${today()}">
    <label>Lugar</label><select id="rPlace">${placeOptions(currentPlace(a))}</select>
    <button class="btn block" id="rSave">Reactivar</button>
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    $('#rSave', m).onclick = async () => {
      if (idvTakenByActive(a.idv, a.id)) return toast(`Ya hay otro animal activo con el N° ${nom(a)}`);
      if (aliasTaken(a.alias, a.id)) return toast(`Ya hay otro animal activo identificado como "${a.alias}"`);
      const date = $('#rDate', m).value || today();
      a.periods.push({ from: date, to: null });
      const pl = $('#rPlace', m).value;
      if (pl !== currentPlace(a)) a.places.push({ placeId: pl, date });
      await save(); closeModal(); after && after();
    };
  });
}

// kgs: pesos por animal {id: kg} cuando se traslada en grupo desde Lugares
function moveAnimals(ids, after, kgs = {}, dest) {
  const first = animal(ids[0]), single = ids.length === 1;
  openModal(`<h2>Trasladar ${single ? 'animal ' + esc(nom(first)) : ids.length + ' animales'}</h2>
    <label>Destino</label><select id="mTo">${placeOptions(dest || (single ? currentPlace(first) : ''))}</select>
    <label>Fecha del traslado</label><input id="mDate" type="date" value="${openSession()?.date || today()}">
    ${single ? `<label>Peso (kg)</label>${kgInput('mKg', kgs[first.id])}` : `<p class="small muted">Pesos cargados: ${Object.keys(kgs).length} de ${ids.length}</p>`}
    <label>Observación${single ? '' : ' (para todos)'}</label><textarea id="mObs" placeholder="Ej: motivo del traslado, estado…"></textarea>
    <button class="btn block" id="mSave">Trasladar</button>
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    $('#mSave', m).onclick = async () => {
      const to = $('#mTo', m).value, date = $('#mDate', m).value || today(), obs = $('#mObs', m).value.trim();
      if (single) { const kg = parseKg($('#mKg', m).value); if (Number.isNaN(kg)) return toast('Peso inválido'); kgs = { [first.id]: kg }; }
      let n = 0;
      for (const id of ids) { const a = animal(id); if (currentPlace(a) !== to) { a.places.push({ placeId: to, date, kg: kgs[id] ?? null, obs }); a.places.sort((x, y) => x.date.localeCompare(y.date)); n++; } }
      if (!n) return toast('Ya están en ' + placeName(to));
      await save(); closeModal(); toast(`${n} trasladado(s) a ${placeName(to)}`); after && after();
    };
  });
}

// ================= ANIMALES =================
let animFilter = { st: 'activos', q: '' };
function renderAnimales() {
  const v = $('#view');
  const f = animFilter, pl = curPlace();
  let list = DB.animals.filter(a =>
    (f.st === 'todos') || (f.st === 'activos' && isActive(a)) || (f.st === 'inactivos' && !isActiveFlag(a)) || (f.st === 'incompletos' && isActiveFlag(a) && (!isComplete(a) || !a.sex)));
  if (pl) list = list.filter(a => currentPlace(a) === pl);
  const t = normAlias(f.q).toLowerCase();
  if (t) list = list.filter(a => (a.idv || '').includes(t) || (a.rfid || '').includes(t) || (a.alias || '').toLowerCase().includes(t));
  list.sort(byAnimal);
  const machos = list.filter(a => a.sex === 'M').length, hembras = list.filter(a => a.sex === 'H').length;
  v.innerHTML = `
    <div class="row"><h2 class="grow">Animales</h2><button class="btn sm" id="aNew">+ Alta</button></div>
    <div class="chips">${['activos', 'inactivos', 'incompletos', 'todos'].map(s => `<button data-st="${s}" class="${f.st === s ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:10px">
      <input id="aQ" class="grow" maxlength="${ALIAS_MAX}" placeholder="Buscar número o texto…" value="${esc(f.q)}">
      <select id="aPlace" style="width:45%">${placeOptions(pl, 'Todos los lugares')}</select>
    </div>
    ${lotsCardHTML(pl)}
    <div class="card">
      <p class="small muted" style="margin:0 0 6px">${list.length} animales · ♂ ${machos} · ♀ ${hembras}</p>
      <ul class="list">${list.slice(0, 300).map(a => `<li class="click" data-id="${a.id}">${animalLine(a)}</li>`).join('') || '<li class="muted">Sin resultados</li>'}</ul>
      ${list.length > 300 ? '<p class="small muted">Mostrando 300. Usá el buscador.</p>' : ''}
    </div>`;
  $$('[data-st]', v).forEach(b => b.onclick = () => { f.st = b.dataset.st; renderAnimales(); });
  $('#aPlace').onchange = async e => { await setPlace(e.target.value); renderAnimales(); };
  $('#aQ').addEventListener('input', e => { f.q = e.target.value.slice(0, ALIAS_MAX); clearTimeout(renderAnimales._t); renderAnimales._t = setTimeout(() => { renderAnimales(); const i = $('#aQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); });
  $$('[data-id]', v).forEach(li => li.onclick = () => animalDetail(li.dataset.id, renderAnimales));
  bindLots(v, renderAnimales);
  $('#aNew').onclick = () => { if (!DB.places.length) return toast('Primero creá un lugar'); registerAnimal('', () => renderAnimales()); };
}

// ================= LUGARES =================
function renderLugares() {
  const v = $('#view');
  v.innerHTML = `
    <h2>Lugares</h2>
    <div class="card"><ul class="list">${DB.places.map(p => {
      const n = activeAnimals(p.id).length;
      return `<li><div class="row"><div class="grow"><b>${esc(p.name)}</b><div class="small muted">Desde ${fmt(p.since)} · ${n} activos${lotsIn(p.id) ? ' · ' + lotsIn(p.id) + ' terneros sin identificar' : ''}</div></div>
        <button class="btn ghost sm" data-ren="${p.id}">✎</button></div></li>`;
    }).join('') || '<li class="muted">No hay lugares</li>'}</ul>
    <button class="btn block" id="lNew">+ Agregar lugar</button></div>
    <div class="card">
      <h3 style="margin-top:0">Trasladar animales</h3>
      <label>Desde</label><select id="tFrom">${placeOptions('', '— elegir —')}</select>
      <div id="tList"></div>
    </div>`;
  $('#lNew').onclick = () => placeForm(null);
  $$('[data-ren]', v).forEach(b => b.onclick = () => placeForm(place(b.dataset.ren)));
  $('#tFrom').onchange = e => {
    const from = e.target.value, box = $('#tList');
    if (!from) { box.innerHTML = ''; return; }
    const list = activeAnimals(from).concat(DB.animals.filter(a => isActiveFlag(a) && !isComplete(a) && currentPlace(a) === from)).sort(byAnimal);
    box.innerHTML = list.length ? `
      <div class="row" style="margin:10px 0"><label style="margin:0" class="grow"><input type="checkbox" id="tAll" checked style="width:auto"> Todos (${list.length})</label></div>
      <ul class="list" style="max-height:300px;overflow:auto">${list.map(a => `<li><label style="margin:0;color:var(--ink)" class="row"><input type="checkbox" class="tChk" value="${a.id}" checked style="width:auto"> <span class="num">${esc(nom(a))}</span> <span class="small muted grow">${a.sex ? SEX[a.sex] : ''}</span>
        <input class="tKg" data-id="${a.id}" inputmode="decimal" placeholder="kg" style="width:90px;padding:6px 8px;font-size:16px"></label></li>`).join('')}</ul>
      <button class="btn block" id="tGo">Trasladar seleccionados</button>` : '<p class="muted">No hay animales activos en este lugar.</p>';
    const all = $('#tAll'); if (!all) return;
    all.onchange = () => $$('.tChk').forEach(c => c.checked = all.checked);
    $('#tGo').onclick = () => {
      const ids = $$('.tChk').filter(c => c.checked).map(c => c.value); if (!ids.length) return toast('Elegí al menos uno');
      const kgs = {};
      for (const inp of $$('.tKg')) {
        if (!ids.includes(inp.dataset.id)) continue;
        const kg = parseKg(inp.value);
        if (Number.isNaN(kg)) return toast(`Peso inválido en ${nom(animal(inp.dataset.id))}`);
        if (kg != null) kgs[inp.dataset.id] = kg;
      }
      moveAnimals(ids, renderLugares, kgs);
    };
  };
}
function placeForm(p) {
  openModal(`<h2>${p ? 'Editar lugar' : 'Nuevo lugar'}</h2>
    <label>Nombre</label><input id="plName" value="${esc(p?.name || '')}" placeholder="Ej: Media chacra">
    <label>Fecha de ingreso / habilitación</label><input id="plDate" type="date" value="${p?.since || today()}">
    <button class="btn block" id="plSave">Guardar</button>
    ${p && !DB.animals.some(a => a.places.some(e => e.placeId === p.id)) && !DB.sessions.some(s => s.placeId === p.id) ? '<button class="btn danger ghost block" id="plDel">Eliminar lugar</button>' : ''}
    <button class="btn ghost block" onclick="closeModal()">Cancelar</button>`, m => {
    $('#plSave', m).onclick = async () => {
      const name = $('#plName', m).value.trim(); if (!name) return toast('Poné un nombre');
      if (p) { p.name = name; p.since = $('#plDate', m).value || p.since; }
      else DB.places.push({ id: uid(), name, since: $('#plDate', m).value || today() });
      await save(); closeModal(); render();
    };
    const del = $('#plDel', m);
    if (del) del.onclick = async () => { DB.places = DB.places.filter(x => x.id !== p.id); await save(); closeModal(); render(); };
  });
}

// ================= REPORTES =================
// pl: lugar elegido en Reportes. Una sesión de "todos los lugares" se mira solo para ese lugar.
const statsPlace = (s, pl) => s.placeId || pl || null;
function sessionStats(s, pl) {
  const sp = statsPlace(s, pl);
  const activos = DB.animals.filter(a => activeAt(a, s.date) && (!sp || placeAt(a, s.date) === sp));
  const ids = sessionAnimalIds(s.id).filter(id => s.placeId || !sp || placeAt(animal(id) || { places: [] }, s.date) === sp);
  const recs = sessionRecords(s.id).filter(r => !r.out && ids.includes(r.animalId));
  const outIds = sessionOutIds(s.id).filter(id => s.placeId || !sp || placeAt(animal(id) || { places: [] }, s.date) === sp);
  const outRecs = sessionRecords(s.id).filter(r => r.out && outIds.includes(r.animalId));
  // peso promedio: el último peso cargado de cada animal en la sesión
  const kgBy = {};
  recs.slice().sort((x, y) => x.ts.localeCompare(y.ts)).forEach(r => { if (r.kg != null) kgBy[r.animalId] = r.kg; });
  const kgs = Object.values(kgBy);
  const kgAvg = kgs.length ? Math.round(kgs.reduce((t, k) => t + k, 0) / kgs.length * 10) / 10 : null;
  return { activos, ids, recs, outIds, outRecs, place: sp, faltan: activos.filter(a => !ids.includes(a.id) && !outIds.includes(a.id)), kgAvg, kgN: kgs.length };
}
function renderReportes() {
  const v = $('#view'), pl = curPlace();
  const ses = DB.sessions.filter(s => !pl || !s.placeId || s.placeId === pl).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const act = activeAnimals(pl);
  const bajas = DB.animals.filter(a => !isActiveFlag(a) && inPlace(a, pl));
  const byReason = r => bajas.filter(a => lastPeriod(a).reason === r).length;
  v.innerHTML = `
    <div class="row"><h2 class="grow">Reportes</h2><select id="rPlace" style="width:50%">${placeOptions(pl, 'Todos los lugares')}</select></div>
    <div class="card">
      <h3 style="margin-top:0">Resumen actual${pl ? ' – ' + esc(placeName(pl)) : ''}</h3>
      <div class="kpis">
        <div class="kpi"><b>${act.length}</b><small>Activos</small></div>
        <div class="kpi"><b>${act.filter(a => a.sex === 'H').length}</b><small>Hembras</small></div>
        <div class="kpi"><b>${act.filter(a => a.sex === 'M').length}</b><small>Machos</small></div>
        <div class="kpi"><b>${byReason('vendido')}</b><small>Vendidos</small></div>
        <div class="kpi"><b>${byReason('muerto')}</b><small>Muertos</small></div>
        <div class="kpi"><b>${byReason('otro')}</b><small>Otras bajas</small></div>
      </div>
      <table class="rep" style="margin-top:10px"><tr><th>Lugar</th><th>Activos</th><th>♀</th><th>♂</th></tr>
        ${DB.places.filter(p => !pl || p.id === pl).map(p => { const l = activeAnimals(p.id); return `<tr><td>${esc(p.name)}</td><td>${l.length}</td><td>${l.filter(a => a.sex === 'H').length}</td><td>${l.filter(a => a.sex === 'M').length}</td></tr>`; }).join('')}
      </table>
      <div class="row wrap" style="margin-top:10px">
        <button class="btn ghost sm" id="rAnimals">⬇ Planilla de animales</button>
        <button class="btn ghost sm" id="rAll">⬇ Historia completa</button>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Por sesión</h3>
      ${pl ? `<p class="small muted" style="margin-top:0">Las sesiones de "Todos los lugares" muestran solo los animales que estaban en ${esc(placeName(pl))}.</p>` : ''}
      <ul class="list">${ses.map(s => { const st = sessionStats(s, pl); return `
        <li class="click" data-s="${s.id}"><div class="row"><div class="grow"><b>${fmt(s.date)}</b> · ${esc(s.obs)} ${s.open ? '<span class="tag warn">ABIERTA</span>' : ''}
        <div class="small muted">${s.placeId ? esc(placeName(s.placeId)) : 'Todos los lugares' + (pl ? ' (solo ' + esc(placeName(pl)) + ')' : '')}</div></div>
        <div class="center"><b>${st.ids.length}</b>/<span class="muted">${st.activos.length}</span><div class="small muted">relev./activos</div></div></div></li>`; }).join('') || '<li class="muted">Todavía no hay sesiones</li>'}</ul>
    </div>`;
  $$('[data-s]', v).forEach(li => li.onclick = () => sessionReport(session(li.dataset.s), pl));
  $('#rPlace').onchange = async e => { await setPlace(e.target.value); renderReportes(); };
  $('#rAnimals').onclick = () => exportAnimalsCSV(pl);
  $('#rAll').onclick = () => exportAllCSV(pl);
}

const placeLabel = (s, st) => s.placeId ? placeName(s.placeId) : st.place ? `Todos los lugares (solo ${placeName(st.place)})` : 'Todos los lugares';
function sessionReport(s, pl) {
  const st = sessionStats(s, pl);
  const recs = st.recs.slice().sort((a, b) => byAnimal(animal(a.animalId), animal(b.animalId)) || a.ts.localeCompare(b.ts));
  openModal(`
    <div class="row"><h2 class="grow" style="margin:0">${esc(s.obs)}</h2><button class="btn ghost sm" onclick="closeModal()">✕</button></div>
    <p class="muted small">${fmt(s.date)} · ${esc(placeLabel(s, st))}</p>
    <div class="kpis">
      <div class="kpi"><b>${st.activos.length}</b><small>Activos a la fecha</small></div>
      <div class="kpi"><b>${st.ids.length}</b><small>Analizados</small></div>
      ${st.kgAvg != null ? `<div class="kpi"><b class="d">${fmtKg(st.kgAvg)}</b><small>Peso promedio (${st.kgN})</small></div>` : ''}
      <div class="kpi"><b>${st.outIds.length}</b><small>Sacados</small></div>
      <div class="kpi"><b>${st.faltan.length}</b><small>Sin relevar</small></div>
    </div>
    <h3>Animales analizados</h3>
    <table class="rep"><tr><th>N°</th><th>Sexo</th><th>Kg</th><th>Observación</th></tr>
      ${recs.map(r => { const a = animal(r.animalId); return `<tr><td class="click" data-a="${a?.id}"><b>${esc(nom(a))}</b><div class="rfid">${esc(a?.rfid !== nom(a) ? a?.rfid : '')}</div></td><td>${a?.sex || ''}</td><td style="white-space:nowrap">${r.kg != null ? String(r.kg).replace('.', ',') : ''}</td><td>${esc(r.text) || '<span class="muted">—</span>'}</td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">Sin registros</td></tr>'}
    </table>
    ${st.outRecs.length ? `<h3>Sacados de la sesión (${st.outIds.length})</h3>
    <table class="rep"><tr><th>N°</th><th>Sexo</th><th>Kg</th><th>Observación</th></tr>
      ${st.outRecs.slice().sort((a, b) => byAnimal(animal(a.animalId), animal(b.animalId)) || a.ts.localeCompare(b.ts)).map(r => { const a = animal(r.animalId); return `<tr><td class="click" data-a="${a?.id}"><b>${esc(nom(a))}</b></td><td>${a?.sex || ''}</td><td style="white-space:nowrap">${r.kg != null ? String(r.kg).replace('.', ',') : ''}</td><td>${esc(r.text) || '<span class="muted">—</span>'}</td></tr>`; }).join('')}
    </table>` : ''}
    ${st.faltan.length ? `<h3>Sin relevar (${st.faltan.length})</h3><p class="small">${st.faltan.slice().sort(byAnimal).map(a => esc(nom(a))).join(', ')}</p>` : ''}
    <button class="btn block" id="srCsv">⬇ Exportar CSV</button>
    <button class="btn ghost block" id="srHist">⬇ Historia de estos animales</button>`, m => {
    $('#srCsv', m).onclick = () => exportSessionCSV(s, pl);
    $('#srHist', m).onclick = () => exportHistoryCSV(st.ids.map(animal), `historia-${s.date}-${slug(s.obs)}`);
    $$('[data-a]', m).forEach(td => td.onclick = () => animalDetail(td.dataset.a, () => sessionReport(s, pl)));
  });
}

// ---------- CSV ----------
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const csvCell = (v) => { v = String(v ?? ''); return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
// el número largo va como ="..." para que Excel no lo convierta en notación científica
const csvNum = (v) => v ? `="${v}"` : '';
function downloadCSV(name, rows) {
  const txt = '﻿' + rows.map(r => r.map((c, i) => (typeof c === 'object' && c?.raw) ? c.raw : csvCell(c)).join(';')).join('\r\n');
  shareOrDownload(new Blob([txt], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}
const raw = (v) => ({ raw: v });
const csvKg = (n) => n == null ? '' : String(n).replace('.', ','); // coma decimal para Excel en español

// columnas de identificación de un animal en los CSV
const csvIds = (a) => [raw(csvNum(a.idv)), raw(csvNum(a.rfid)), a.alias || ''];
const CSV_IDS = ['N°', 'Número largo', 'Identificación texto'];
function exportSessionCSV(s, pl) {
  const st = sessionStats(s, pl);
  const rows = [['Sesión', s.obs], ['Fecha', fmt(s.date)], ['Lugar', placeLabel(s, st)], ['Activos', st.activos.length], ['Analizados', st.ids.length], ['Sacados de la sesión', st.outIds.length], ['Sin relevar', st.faltan.length], ['Peso promedio (kg)', csvKg(st.kgAvg)], [],
    [...CSV_IDS, 'Sexo', 'Lugar', 'Peso (kg)', 'Observación', 'Hora']];
  st.recs.forEach(r => { const a = animal(r.animalId); rows.push([...csvIds(a), SEX[a.sex] || '', placeName(placeAt(a, s.date)), csvKg(r.kg), r.text, fmtDT(r.ts)]); });
  if (st.outRecs.length) { rows.push([], ['SACADOS DE LA SESIÓN']); st.outRecs.forEach(r => { const a = animal(r.animalId); rows.push([...csvIds(a), SEX[a.sex] || '', placeName(placeAt(a, s.date)), csvKg(r.kg), r.text, fmtDT(r.ts)]); }); }
  if (st.faltan.length) { rows.push([], ['SIN RELEVAR']); st.faltan.forEach(a => rows.push([...csvIds(a), SEX[a.sex] || ''])); }
  downloadCSV(`sesion-${s.date}-${slug(s.obs)}${st.place && !s.placeId ? '-' + slug(placeName(st.place)) : ''}`, rows);
}
function exportAnimalsCSV(pl) {
  const rows = [[...CSV_IDS, 'Sexo', 'Categoría', 'Estado', 'Lugar actual', 'Fecha activación', 'Fecha baja', 'Motivo baja', 'Aclaración', 'Registros', 'Último peso (kg)', 'Fecha último peso', 'Madre']];
  DB.animals.filter(a => inPlace(a, pl)).sort(byAnimal).forEach(a => {
    const p = lastPeriod(a);
    rows.push([...csvIds(a), SEX[a.sex] || '', a.cat || '', isActive(a) ? 'Activo' : isActiveFlag(a) ? 'Incompleto' : 'Baja', placeName(currentPlace(a)), fmt(p?.from), p?.to ? fmt(p.to) : '', p?.to ? REASONS[p.reason] : '', p?.detail || '', DB.records.filter(r => r.animalId === a.id).length, csvKg(lastWeight(a)?.kg), lastWeight(a) ? fmt(lastWeight(a).date) : '', a.motherId && animal(a.motherId) ? nom(animal(a.motherId)) : '']);
  });
  downloadCSV(`animales-${pl ? slug(placeName(pl)) + '-' : ''}${today()}`, rows);
}
function exportHistoryCSV(animals, name) {
  const rows = [[...CSV_IDS, 'Sexo', 'Fecha', 'Evento / Sesión', 'Peso (kg)', 'Observación']];
  animals.filter(Boolean).sort(byAnimal).forEach(a => {
    animalTimeline(a).reverse().forEach(e => rows.push([...csvIds(a), SEX[a.sex] || '', fmt(e.date), e.title, csvKg(e.kg), e.text]));
  });
  downloadCSV(name, rows);
}
function exportAnimalCSV(a) { exportHistoryCSV([a], `historia-${slug(nom(a))}`); }
function exportAllCSV(pl) { exportHistoryCSV(DB.animals.filter(a => inPlace(a, pl)), `historia-completa-${pl ? slug(placeName(pl)) + '-' : ''}${today()}`); }

// ================= CUADROS =================
// Cuadros predefinidos: se crean solos la primera vez para los lugares "Chacra" y "Media chacra".
const CUADROS_DEF = [
  { match: /^chacra$/i, names: ['A', 'B', 'C', 'D'].flatMap(l => [1, 2, 3, 4, 5, 6, 7, 8].map(n => l + n)) },
  { match: /^media chacra$/i, names: ['MA', 'MB'].flatMap(l => [1, 2, 3, 4, 5, 6, 7, 8].map(n => l + n)) },
];
function ensureCuadros() {
  DB.cuadros = DB.cuadros || []; DB.pastoreos = DB.pastoreos || [];
  let added = false;
  for (const def of CUADROS_DEF) {
    const p = DB.places.find(x => def.match.test(x.name.trim()));
    if (!p || DB.cuadros.some(c => c.placeId === p.id)) continue;
    def.names.forEach(name => DB.cuadros.push({ id: uid(), placeId: p.id, name }));
    added = true;
  }
  return added;
}
const cuadro = (id) => DB.cuadros.find(c => c.id === id);
const byName = (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true });
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
function cuadroState(c) {
  const ps = DB.pastoreos.filter(p => p.cuadroId === c.id);
  const open = ps.filter(p => !p.salida).sort((a, b) => b.ingreso.localeCompare(a.ingreso))[0] || null;
  const lastOut = ps.filter(p => p.salida).sort((a, b) => b.salida.localeCompare(a.salida))[0] || null;
  return { ps, open, lastOut };
}

let cuadrosPlace = '', cuadrosView = 'grid';
function renderCuadros() {
  if (ensureCuadros()) save();
  const v = $('#view');
  const places = DB.places.filter(p => DB.cuadros.some(c => c.placeId === p.id));
  if (!places.length) {
    v.innerHTML = `<h2>Cuadros</h2><div class="card"><p>Todavía no hay cuadros. Se crean solos cuando existen los lugares <b>Chacra</b> y <b>Media chacra</b>.</p></div>`;
    return;
  }
  if (!places.some(p => p.id === cuadrosPlace)) cuadrosPlace = (places.find(p => p.id === curPlace()) || places[0]).id;
  const list = DB.cuadros.filter(c => c.placeId === cuadrosPlace).sort(byName);
  const hoy = today();
  const ocupados = list.filter(c => cuadroState(c).open).length;
  // los 4 cuadros libres con la salida más antigua (más descanso): rest4 = el más viejo (verde más oscuro)
  const rest = {};
  list.map(c => ({ c, st: cuadroState(c) })).filter(x => !x.st.open && x.st.lastOut)
    .sort((a, b) => a.st.lastOut.salida.localeCompare(b.st.lastOut.salida) || byName(a.c, b.c))
    .slice(0, 4).forEach((x, i) => rest[x.c.id] = 4 - i);
  v.innerHTML = `
    <div class="row"><h2 class="grow">Cuadros</h2><button class="btn sm" id="cNew">+ Registrar</button></div>
    <div class="chips">${places.map(p => `<button data-pl="${p.id}" class="${p.id === cuadrosPlace ? 'on' : ''}">${esc(p.name)}</button>`).join('')}</div>
    <p class="small muted" style="margin-top:0">${list.length} cuadros · ${ocupados} ocupados. Se muestra la <b>última salida</b> de animales de cada cuadro; tocá uno para ver su historia o registrar ingreso/salida.</p>
    <div class="chips"><button data-vw="grid" class="${cuadrosView === 'grid' ? 'on' : ''}">▦ Cuadros</button><button data-vw="list" class="${cuadrosView === 'list' ? 'on' : ''}">☰ Listado</button></div>
    ${cuadrosView === 'list' ? `<table class="rep"><tr><th>Cuadro</th><th>Fecha de salida</th><th>Días desde la salida</th></tr>${
      list.map(c => ({ c, st: cuadroState(c) }))
        .map(x => ({ ...x, days: x.st.open || !x.st.lastOut ? null : daysBetween(x.st.lastOut.salida, hoy) }))
        .sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || byName(a.c, b.c))
        .map(x => `<tr class="click ${x.st.open ? 'occ-row' : ''} ${rest[x.c.id] ? 'rest' + rest[x.c.id] : ''}" data-c="${x.c.id}"><td><b>${esc(x.c.name)}</b></td>
          <td>${x.st.lastOut ? fmt(x.st.lastOut.salida) : '—'}</td>
          <td>${x.st.open ? '<span class="tag warn">OCUPADO</span>' : x.days != null ? '<b>' + x.days + '</b> días' : '—'}</td></tr>`).join('')}</table>` : `
    <div class="cgrid">${list.map(c => {
      const st = cuadroState(c);
      return `<button class="ccard ${st.open ? 'occ' : ''} ${rest[c.id] ? 'rest' + rest[c.id] : ''}" data-c="${c.id}">
        <b>${esc(c.name)}</b>
        ${st.open ? `<span class="tag warn">OCUPADO</span><small>desde ${fmt(st.open.ingreso)}${st.open.cantidad ? '<br>' + st.open.cantidad + ' animales' : ''}</small>` : ''}
        <small class="muted">Última salida</small>
        <span class="d">${st.lastOut ? fmt(st.lastOut.salida) : '—'}</span>
        ${st.lastOut && !st.open ? `<small>${daysBetween(st.lastOut.salida, hoy)} días</small>` : ''}
      </button>`;
    }).join('')}</div>`}
    ${Object.keys(rest).length ? `<div class="rest-legend small"><span>Más descanso:</span>
      <i class="rest1"></i><i class="rest2"></i><i class="rest3"></i><i class="rest4"></i><span>menos → más días</span></div>` : ''}
    <button class="btn ghost block" id="cCsv">⬇ Exportar informe CSV</button>
    <button class="btn ghost block" id="cAdd">+ Agregar cuadro</button>`;
  $$('[data-pl]', v).forEach(b => b.onclick = () => { cuadrosPlace = b.dataset.pl; renderCuadros(); });
  $$('[data-vw]', v).forEach(b => b.onclick = () => { cuadrosView = b.dataset.vw; renderCuadros(); });
  $$('[data-c]', v).forEach(b => b.onclick = () => cuadroDetail(b.dataset.c));
  $('#cNew').onclick = () => pastoreoForm(null, null, renderCuadros);
  $('#cCsv').onclick = () => exportCuadrosCSV(cuadrosPlace);
  $('#cAdd').onclick = () => cuadroForm(cuadrosPlace);
}

function cuadroDetail(cid) {
  const c = cuadro(cid); if (!c) return;
  const st = cuadroState(c);
  const refresh = () => { renderCuadros(); cuadroDetail(cid); };
  const hist = st.ps.slice().sort((a, b) => b.ingreso.localeCompare(a.ingreso));
  openModal(`
    <div class="row"><h2 class="grow" style="margin:0">Cuadro ${esc(c.name)}</h2><button class="btn ghost sm" onclick="closeModal()">✕</button></div>
    <p class="small muted">${esc(placeName(c.placeId))}</p>
    <div class="kpis" style="grid-template-columns:1fr 1fr">
      <div class="kpi"><b class="d">${st.open ? 'Ocupado' : 'Libre'}</b><small>${st.open ? 'desde ' + fmt(st.open.ingreso) + (st.open.cantidad ? ' · ' + st.open.cantidad + ' an.' : '') : 'sin animales'}</small></div>
      <div class="kpi"><b class="d">${st.lastOut ? fmt(st.lastOut.salida) : '—'}</b><small>Última salida${st.lastOut && !st.open ? ' · ' + daysBetween(st.lastOut.salida, today()) + ' días' : ''}</small></div>
    </div>
    <div class="row" style="margin:12px 0">
      ${st.open ? '<button class="btn grow" id="cdOut">Registrar salida</button>' : '<button class="btn grow" id="cdIn">Registrar ingreso</button>'}
    </div>
    <h3>Historia</h3>
    ${hist.length ? `<ul class="list">${hist.map(p => `
      <li><div class="row"><div class="grow">
        <b>${fmt(p.ingreso)}</b> → <b>${p.salida ? fmt(p.salida) : 'sigue'}</b>
        <span class="small muted">${p.salida ? ' · ' + daysBetween(p.ingreso, p.salida) + ' días' : ''}${p.cantidad ? ' · ' + p.cantidad + ' animales' : ''}</span>
        ${p.obs ? `<div class="small" style="white-space:pre-wrap">${esc(p.obs)}</div>` : ''}
      </div><button class="btn ghost sm" data-pe="${p.id}" aria-label="Editar">✎</button></div></li>`).join('')}</ul>` : '<p class="muted">Sin movimientos registrados.</p>'}
    ${!st.ps.length ? '<button class="btn danger ghost block" id="cdDel">🗑 Eliminar cuadro</button>' : ''}`, m => {
    const inB = $('#cdIn', m); if (inB) inB.onclick = () => pastoreoForm(null, cid, refresh);
    const outB = $('#cdOut', m); if (outB) outB.onclick = () => pastoreoForm(st.open, cid, refresh, true);
    $$('[data-pe]', m).forEach(b => b.onclick = () => pastoreoForm(DB.pastoreos.find(p => p.id === b.dataset.pe), cid, refresh));
    const del = $('#cdDel', m);
    if (del) del.onclick = async () => {
      if (!(await askConfirm(`¿Seguro que querés eliminar el cuadro ${c.name}?`, { ok: 'Sí, eliminar', danger: true }))) return;
      DB.cuadros = DB.cuadros.filter(x => x.id !== cid);
      await save(); closeModal(); renderCuadros();
    };
  });
}

// p: movimiento a editar (null = nuevo); salidaNow: abre el form para cerrar el ingreso con fecha de hoy.
// Al registrar uno nuevo se pueden tildar varios cuadros: se crea un movimiento igual para cada uno.
function pastoreoForm(p, cid, after, salidaNow) {
  const isNew = !p;
  const pre = cid || p?.cuadroId;
  const placesWith = DB.places.filter(pl => DB.cuadros.some(c => c.placeId === pl.id));
  const picker = isNew
    ? `<label>Cuadros <span class="muted">(tildá uno o varios)</span></label>
       ${placesWith.map(pl => `<div class="small muted" style="margin:6px 0 4px">${esc(pl.name)}</div>
         <div class="cpick">${DB.cuadros.filter(c => c.placeId === pl.id).sort(byName).map(c =>
           `<label class="${cuadroState(c).open ? 'occ' : ''}"><input type="checkbox" class="pgChk" value="${c.id}" ${c.id === pre ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('')}</div>`).join('')}
       <p class="small muted" id="pgSel" style="margin:6px 0 0"></p>`
    : `<label>Cuadro</label><select id="pgC">${placesWith.map(pl =>
         `<optgroup label="${esc(pl.name)}">${DB.cuadros.filter(c => c.placeId === pl.id).sort(byName).map(c =>
           `<option value="${c.id}" ${c.id === pre ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  eventModal(`<h2>${isNew ? 'Ingreso de animales a cuadro' : salidaNow ? 'Salida de animales' : 'Editar movimiento'}</h2>
    ${picker}
    <label>Fecha de ingreso</label><input id="pgIn" type="date" value="${p?.ingreso || today()}">
    <label>Fecha de salida <span class="muted">(vacía si siguen en el cuadro)</span></label><input id="pgOut" type="date" value="${p?.salida || (salidaNow ? today() : '')}">
    <label>Cantidad de animales</label><input id="pgN" inputmode="numeric" value="${p?.cantidad ?? ''}" placeholder="Ej: 40">
    <label>Observaciones</label><textarea id="pgObs" placeholder="Ej: estado de la pastura, lote, motivo…">${esc(p?.obs || '')}</textarea>
    <button class="btn block" id="pgSave">Guardar</button>
    ${isNew ? '' : delBtn('Eliminar este movimiento')}`, after, (m, back) => {
    $('#pgN', m).addEventListener('input', e => e.target.value = onlyDigits(e.target.value));
    if (salidaNow) setTimeout(() => $('#pgOut', m).focus(), 50);
    const selected = () => isNew ? $$('.pgChk', m).filter(c => c.checked).map(c => c.value) : [$('#pgC', m).value].filter(Boolean);
    const showSel = () => { const s = selected(); $('#pgSel', m).textContent = s.length ? `Seleccionados: ${s.map(id => cuadro(id).name).join(', ')}` : 'Ningún cuadro seleccionado'; };
    if (isNew) { $$('.pgChk', m).forEach(c => c.onchange = showSel); showSel(); }
    $('#pgSave', m).onclick = async () => {
      const ids = selected(), ingreso = $('#pgIn', m).value, salida = $('#pgOut', m).value || null;
      const n = $('#pgN', m).value ? parseInt($('#pgN', m).value, 10) : null;
      if (!ids.length) return toast('Elegí al menos un cuadro');
      if (!ingreso) return toast('Poné la fecha de ingreso');
      if (salida && salida < ingreso) return toast('La salida no puede ser anterior al ingreso');
      const busy = salida ? [] : ids.map(id => DB.pastoreos.find(x => x.cuadroId === id && x.id !== p?.id && !x.salida)).filter(Boolean);
      if (busy.length && !(await askConfirm(`${busy.length === 1 ? 'El cuadro' : 'Los cuadros'} ${busy.map(o => `${cuadro(o.cuadroId).name} (desde ${fmt(o.ingreso)})`).join(', ')} ya ${busy.length === 1 ? 'tiene' : 'tienen'} animales sin salida registrada. ¿Registrar igual?`, { ok: 'Registrar igual' }))) return;
      const data = { ingreso, salida, cantidad: n, obs: $('#pgObs', m).value.trim() };
      if (isNew) ids.forEach(cuadroId => DB.pastoreos.push({ id: uid(), cuadroId, ...data }));
      else Object.assign(p, data, { cuadroId: ids[0] });
      const names = ids.map(id => cuadro(id).name).join(', ');
      await save(); toast(salida ? `Salida registrada en ${names}` : `Ingreso registrado en ${names}`); back();
    };
    const del = $('#xDel', m);
    if (del) del.onclick = async () => {
      if (!(await askConfirm(`¿Seguro que querés eliminar el movimiento del cuadro ${cuadro(p.cuadroId)?.name} (${fmt(p.ingreso)} → ${p.salida ? fmt(p.salida) : 'sigue'})?`, { ok: 'Sí, eliminar', danger: true }))) return;
      DB.pastoreos = DB.pastoreos.filter(x => x.id !== p.id);
      await save(); toast('Movimiento eliminado'); back();
    };
  });
}

function cuadroForm(placeId) {
  eventModal(`<h2>Agregar cuadro – ${esc(placeName(placeId))}</h2>
    <label>Nombre</label><input id="cfN" placeholder="Ej: A9" autocapitalize="characters">
    <button class="btn block" id="cfSave">Guardar</button>`, renderCuadros, (m, back) => {
    $('#cfSave', m).onclick = async () => {
      const name = $('#cfN', m).value.trim().toUpperCase();
      if (!name) return toast('Poné un nombre');
      if (DB.cuadros.some(c => c.placeId === placeId && c.name === name)) return toast('Ya existe ' + name);
      DB.cuadros.push({ id: uid(), placeId, name });
      await save(); back();
    };
  });
}

function exportCuadrosCSV(placeId) {
  const hoy = today();
  const list = DB.cuadros.filter(c => c.placeId === placeId).sort(byName);
  const rows = [['Informe de cuadros', placeName(placeId)], ['Fecha', fmt(hoy)], [],
    ['Cuadro', 'Estado', 'Ingreso actual', 'Animales', 'Última salida', 'Días desde la salida']];
  list.forEach(c => { const st = cuadroState(c); rows.push([c.name, st.open ? 'Ocupado' : 'Libre', st.open ? fmt(st.open.ingreso) : '', st.open?.cantidad ?? '', st.lastOut ? fmt(st.lastOut.salida) : '', st.lastOut && !st.open ? daysBetween(st.lastOut.salida, hoy) : '']); });
  rows.push([], ['MOVIMIENTOS'], ['Cuadro', 'Ingreso', 'Salida', 'Días', 'Animales', 'Observaciones']);
  list.forEach(c => cuadroState(c).ps.sort((a, b) => a.ingreso.localeCompare(b.ingreso)).forEach(p =>
    rows.push([c.name, fmt(p.ingreso), p.salida ? fmt(p.salida) : '', p.salida ? daysBetween(p.ingreso, p.salida) : '', p.cantidad ?? '', p.obs])));
  downloadCSV(`cuadros-${slug(placeName(placeId))}-${hoy}`, rows);
}

// ================= BACKUP =================
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a'); aEl.href = url; aEl.download = name; document.body.appendChild(aEl); aEl.click();
  setTimeout(() => { URL.revokeObjectURL(url); aEl.remove(); }, 1000);
  return true;
}
function backupBlob() { return new Blob([JSON.stringify(DB)], { type: 'application/json' }); }
function daysSinceBackup() { return DB.settings.lastBackup ? Math.floor((Date.now() - new Date(DB.settings.lastBackup)) / 864e5) : null; }
function backupNotice() {
  if (!DB.animals.length) return '';
  const d = daysSinceBackup();
  if (d === null) return '<div class="notice">⚠️ Todavía no hiciste ningún respaldo. Andá a <b>Backup</b> cuando tengas señal.</div>';
  if (d >= 7) return `<div class="notice">⚠️ Último respaldo hace ${d} días.</div>`;
  return '';
}
async function markBackup(how) { DB.settings.lastBackup = new Date().toISOString(); DB.settings.lastBackupHow = how; await save(); }

function validDB(d) { return d && Array.isArray(d.animals) && Array.isArray(d.sessions) && Array.isArray(d.records) && Array.isArray(d.places); }
async function restoreFrom(d, origin) {
  if (!validDB(d)) throw new Error('El archivo no es un respaldo válido');
  if (!(await askConfirm(`¿Restaurar desde ${origin}?\n\nAnimales: ${d.animals.length} · Sesiones: ${d.sessions.length} · Registros: ${d.records.length}\n\nSe REEMPLAZAN los datos actuales del teléfono (${DB.animals.length} animales).`, { ok: "Restaurar", danger: true }))) return false;
  const keep = { driveClientId: DB.settings.driveClientId, autoDrive: DB.settings.autoDrive };
  DB = Object.assign(emptyDB(), d, { settings: Object.assign(emptyDB().settings, d.settings || {}, keep) });
  await save();
  return true;
}

function renderBackup() {
  const v = $('#view');
  const st = DB.settings;
  const d = daysSinceBackup();
  v.innerHTML = `
    <h2>Respaldo</h2>
    <div class="card">
      <p style="margin-top:0">Los datos se guardan <b>en este teléfono</b> y funcionan sin internet. Cuando tengas señal, hacé un respaldo.</p>
      <p class="small">Último respaldo: <b>${st.lastBackup ? fmtDT(st.lastBackup) + ' (' + esc(st.lastBackupHow) + ')' : 'nunca'}</b>${d !== null && d >= 7 ? ' ⚠️' : ''}</p>
      <p class="small muted">${DB.animals.length} animales · ${DB.sessions.length} sesiones · ${DB.records.length} registros · <span id="persist"></span></p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">☁️ Google Drive (automático)</h3>
      ${st.driveClientId ? `
        <p class="small">Estado: <b id="drvState">${navigator.onLine ? 'con internet' : 'sin internet'}</b></p>
        <button class="btn block" id="drvUp">Subir respaldo a Drive ahora</button>
        <button class="btn ghost block" id="drvList">Restaurar desde Drive…</button>
        <label class="row" style="color:var(--ink)"><input type="checkbox" id="drvAuto" style="width:auto" ${st.autoDrive ? 'checked' : ''}> Subir a Drive al cerrar cada sesión (si hay señal)</label>
        <div id="drvFiles"></div>` : `
        <p class="small muted">Requiere configurar una vez un "ID de cliente" de Google (ver instrucciones en el archivo LEEME). Mientras tanto usá la opción de abajo, que también funciona con Drive.</p>`}
      <details style="margin-top:8px"><summary class="small muted">Configuración</summary>
        <label>ID de cliente OAuth de Google</label>
        <input id="drvId" value="${esc(st.driveClientId)}" placeholder="xxxx.apps.googleusercontent.com" style="font-size:14px">
        <button class="btn ghost block" id="drvSaveId">Guardar</button>
      </details>
    </div>

    <div class="card">
      <h3 style="margin-top:0">📤 Copia en archivo</h3>
      <p class="small muted">Genera un archivo con todos los datos. En el celular podés elegir <b>Drive</b>, WhatsApp, mail, etc. para guardarlo.</p>
      <button class="btn block" id="bkShare">Guardar / compartir respaldo</button>
      <label class="btn ghost block" style="display:flex;margin-top:10px;color:var(--green)">Restaurar desde archivo…
        <input type="file" id="bkFile" accept=".json,application/json" class="hidden"></label>
    </div>`;

  if (navigator.storage?.persisted) navigator.storage.persisted().then(p => { const e = $('#persist'); if (e) e.textContent = p ? 'almacenamiento protegido ✓' : 'almacenamiento no protegido'; });
  $('#bkShare').onclick = async () => {
    if (await shareOrDownload(backupBlob(), `rodeo-backup-${today()}.json`)) { await markBackup('archivo'); renderBackup(); }
  };
  $('#bkFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { if (await restoreFrom(JSON.parse(await f.text()), f.name)) { toast('Datos restaurados ✓'); render(); } }
    catch (err) { showMsg('No se pudo restaurar: ' + err.message); }
  };
  $('#drvSaveId').onclick = async () => { st.driveClientId = $('#drvId').value.trim(); st.driveFolderId = null; st.driveDaily = null; await save(); preloadGis(); renderBackup(); };
  if (st.driveClientId) {
    $('#drvAuto').onchange = async e => { st.autoDrive = e.target.checked; await save(); };
    $('#drvUp').onclick = async () => {
      const b = $('#drvUp'); b.disabled = true; b.textContent = 'Subiendo…';
      try { await driveUpload(); toast('Respaldo subido a Drive ✓'); renderBackup(); }
      catch (err) { showMsg('No se pudo subir: ' + err.message); b.disabled = false; b.textContent = 'Subir respaldo a Drive ahora'; }
    };
    $('#drvList').onclick = async () => {
      const box = $('#drvFiles'); box.innerHTML = '<p class="small muted">Buscando…</p>';
      try {
        const files = await driveList();
        box.innerHTML = files.length ? `<ul class="list">${files.map(f => `<li class="click" data-f="${f.id}" data-n="${esc(f.name)}"><b>${esc(f.name)}</b><div class="small muted">${fmtDT(f.modifiedTime)} · ${Math.round((f.size || 0) / 1024)} KB</div></li>`).join('')}</ul>` : '<p class="small muted">No hay respaldos en Drive.</p>';
        $$('[data-f]', box).forEach(li => li.onclick = async () => {
          try { if (await restoreFrom(await driveDownload(li.dataset.f), li.dataset.n)) { toast('Datos restaurados ✓'); render(); } }
          catch (err) { showMsg('No se pudo restaurar: ' + err.message); }
        });
      } catch (err) { box.innerHTML = `<p class="small" style="color:var(--red)">${esc(err.message)}</p>`; }
    };
  }
}

// ---------- Google Drive (Google Identity Services + Drive API v3, permiso drive.file) ----------
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER = 'Rodeo - respaldos';
let gisPromise = null, driveToken = null, driveTokenExp = 0;
function preloadGis() {
  if (!DB.settings.driveClientId || !navigator.onLine || window.google?.accounts?.oauth2) return gisPromise;
  gisPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = res; s.onerror = () => { gisPromise = null; rej(new Error('No se pudo conectar con Google')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}
async function driveToken_() {
  if (driveToken && Date.now() < driveTokenExp - 60000) return driveToken;
  if (!navigator.onLine) throw new Error('Sin internet');
  if (!window.google?.accounts?.oauth2) { await preloadGis(); if (!window.google?.accounts?.oauth2) throw new Error('Google no cargó, probá de nuevo'); }
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: DB.settings.driveClientId, scope: DRIVE_SCOPE,
      callback: r => { if (r.error) return rej(new Error(r.error_description || r.error)); driveToken = r.access_token; driveTokenExp = Date.now() + r.expires_in * 1000; res(driveToken); },
      error_callback: e => rej(new Error(e.type === 'popup_closed' ? 'Se cerró la ventana de Google' : (e.message || e.type))),
    });
    tc.requestAccessToken({ prompt: '' });
  });
}
async function gfetch(url, opts = {}) {
  const token = await driveToken_();
  const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) }));
  if (r.status === 401) { driveToken = null; throw new Error('Sesión de Google vencida, probá de nuevo'); }
  return r;
}
async function driveFolder() {
  const st = DB.settings;
  if (st.driveFolderId) {
    const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${st.driveFolderId}?fields=id,trashed`);
    if (r.ok && !(await r.json()).trashed) return st.driveFolderId;
  }
  const q = encodeURIComponent(`name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const l = await (await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`)).json();
  if (l.files?.length) st.driveFolderId = l.files[0].id;
  else {
    const c = await gfetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
    if (!c.ok) throw new Error('No se pudo crear la carpeta en Drive');
    st.driveFolderId = (await c.json()).id;
  }
  return st.driveFolderId;
}
// Un archivo por día (rodeo-backup-AAAA-MM-DD.json): si ya existe el de hoy se actualiza.
async function driveUpload() {
  const st = DB.settings;
  const folder = await driveFolder();
  const name = `rodeo-backup-${today()}.json`;
  let fileId = st.driveDaily?.date === today() ? st.driveDaily.id : null;
  const send = async (id) => {
    const boundary = 'rodeo' + Date.now();
    const meta = id ? {} : { name, mimeType: 'application/json', parents: [folder] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(DB)}\r\n--${boundary}--`;
    return gfetch(id ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart&fields=id` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  };
  let r = await send(fileId);
  if (!r.ok && fileId) r = await send(null);
  if (!r.ok) throw new Error('Drive respondió ' + r.status);
  st.driveDaily = { date: today(), id: (await r.json()).id };
  await markBackup('Google Drive');
}
async function driveList() {
  const q = encodeURIComponent(`name contains 'rodeo-backup' and trashed=false`);
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=20&fields=files(id,name,modifiedTime,size)`);
  if (!r.ok) throw new Error('Drive respondió ' + r.status);
  return (await r.json()).files || [];
}
async function driveDownload(id) {
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  if (!r.ok) throw new Error('Drive respondió ' + r.status);
  return r.json();
}

// ================= inicio =================
window.addEventListener('online', () => { preloadGis(); if (tab === 'backup') renderBackup(); });
window.addEventListener('offline', () => { if (tab === 'backup') renderBackup(); });

// Confirmar antes de salir: el botón/gesto "atrás" y Esc preguntan; cerrar la pestaña usa el aviso del navegador.
let leaving = false, askingExit = false;
history.pushState({ rodeo: 1 }, '');
async function askExit() {
  if (askingExit) return;
  if (!$('#modal').classList.contains('hidden')) { closeModal(); return; }
  if (!$('#confirm').classList.contains('hidden')) return;
  askingExit = true;
  const ok = await askConfirm('¿Querés salir de la app?', { ok: 'Salir', cancel: 'Quedarme', danger: true });
  askingExit = false;
  if (ok) { leaving = true; history.back(); }
}
window.addEventListener('popstate', () => {
  if (leaving) return;
  history.pushState({ rodeo: 1 }, '');
  askExit();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') askExit(); });
window.addEventListener('beforeunload', e => { if (!leaving) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  await load();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  preloadGis()?.catch(() => {});
  render();
})();
