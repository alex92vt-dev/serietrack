'use strict';

/* =========================================================
   SerieTrack — monitoraggio episodi serie TV
   Dati: TVmaze (gratuito, senza chiave) + TMDB opzionale per le trame in italiano
   ========================================================= */

const TVM = 'https://api.tvmaze.com';
const TMDB = 'https://api.themoviedb.org/3';
const KEY = 'serietrack.v1';
const DAY = 86400000;

/* ---------- utility */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parser = new DOMParser();
const strip = h => (h ? parser.parseFromString(h, 'text/html').body.textContent.trim() : '');
const https = u => (u ? u.replace(/^http:/, 'https:') : null);
const pad = n => String(n).padStart(2, '0');
const code = e => `S${pad(e.s)}E${pad(e.n)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = (d, o = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(d).toLocaleDateString('it-IT', o);
const fmtTime = d => new Date(d).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const dayKey = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const STATUS = { 'Running': 'In corso', 'Ended': 'Terminata', 'To Be Determined': 'In attesa di rinnovo', 'In Development': 'In sviluppo' };

function relDay(d) {
  const a = new Date(dayKey(d)), b = new Date(dayKey(Date.now()));
  const diff = Math.round((a - b) / DAY);
  if (diff === 0) return 'Oggi';
  if (diff === 1) return 'Domani';
  if (diff === -1) return 'Ieri';
  return fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- archivio locale */
const DEFAULTS = { shows: {}, watched: {}, settings: { spoiler: true, tmdbKey: '' } };
let db = load();
const temp = {}; // serie aperte ma non seguite

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) return { ...DEFAULTS, ...d, settings: { ...DEFAULTS.settings, ...d.settings } };
  } catch { /* archivio vuoto o corrotto */ }
  return JSON.parse(JSON.stringify(DEFAULTS));
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { toast('Memoria piena: impossibile salvare'); }
}
const getShow = id => db.shows[id] || temp[id];
const isFollowed = id => !!db.shows[id];

/* ---------- logica episodi */
const aired = e => e.air && Date.parse(e.air) <= Date.now();
const isW = e => !!db.watched[e.id];
const epName = e => e.nameIt || e.name || `Episodio ${e.n}`;
const epPlot = e => e.plotIt || e.plot || '';
const showName = s => s.name;
const showPlot = s => s.plotIt || s.plot || '';
const hideSpoiler = e => db.settings.spoiler && !isW(e);

function stats(s) {
  let airedN = 0, watched = 0, airedW = 0, next = null, last = 0;
  for (const e of s.episodes) {
    const w = isW(e);
    if (w) { watched++; last = Math.max(last, db.watched[e.id]); }
    if (aired(e)) {
      airedN++;
      if (w) airedW++;
      else if (!next) next = e;
    }
  }
  return { aired: airedN, watched, left: airedN - airedW, next, last, pct: airedN ? Math.round(airedW / airedN * 100) : 0 };
}

function setWatched(e, val) {
  if (val) db.watched[e.id] = Date.now();
  else delete db.watched[e.id];
}
function markUpTo(s, ep) {
  let n = 0;
  for (const e of s.episodes) {
    if ((e.s < ep.s || (e.s === ep.s && e.n <= ep.n)) && !isW(e)) { setWatched(e, true); n++; }
  }
  save();
  return n;
}

/* ---------- rete */
async function getJSON(url, opts, tries = 3) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, opts);
    if (r.status === 429 && i < tries) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
}

function tmdb(path) {
  const k = db.settings.tmdbKey.trim();
  const bearer = k.length > 50; // token v4 "Read Access Token"
  const url = TMDB + path + (bearer ? '' : (path.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(k));
  return getJSON(url, bearer ? { headers: { Authorization: 'Bearer ' + k } } : undefined);
}

async function fetchShow(id) {
  const [s, imgs] = await Promise.all([
    getJSON(`${TVM}/shows/${id}?embed=episodes`),
    getJSON(`${TVM}/shows/${id}/images`).catch(() => []),
  ]);
  const bg = imgs.find(i => i.type === 'background' && i.main) || imgs.find(i => i.type === 'background');
  const old = getShow(id) || {};
  const show = {
    id: s.id,
    name: s.name,
    poster: https(s.image?.medium),
    backdrop: https(bg?.resolutions?.medium?.url || bg?.resolutions?.original?.url) || https(s.image?.original),
    status: s.status,
    network: (s.network || s.webChannel)?.name || '',
    genres: s.genres || [],
    premiered: s.premiered,
    ended: s.ended,
    plot: strip(s.summary),
    imdb: s.externals?.imdb,
    tvdb: s.externals?.thetvdb,
    rating: s.rating?.average,
    runtime: s.averageRuntime || s.runtime || 0,
    episodes: (s._embedded?.episodes || [])
      .filter(e => e.season > 0 && e.number != null)
      .map(e => ({ id: e.id, s: e.season, n: e.number, name: e.name, air: e.airstamp, rt: e.runtime, img: https(e.image?.medium), plot: strip(e.summary) }))
      .sort((a, b) => a.s - b.s || a.n - b.n),
    tmdbId: old.tmdbId,
    plotIt: old.plotIt,
    providers: old.providers,
    addedAt: old.addedAt,
    fetchedAt: Date.now(),
  };
  if (old.episodes) {
    const m = new Map(old.episodes.map(e => [e.id, e]));
    for (const e of show.episodes) {
      const o = m.get(e.id);
      if (o) { e.nameIt = o.nameIt; e.plotIt = o.plotIt; }
    }
  }
  if (db.settings.tmdbKey.trim()) await enrichItalian(show).catch(err => console.warn('TMDB', err));
  return show;
}

/* Piattaforme italiane (dati JustWatch via TMDB) */
function parseProviders(it) {
  const list = arr => (arr || [])
    .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
    .map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null }));
  const seen = new Set();
  const uniq = arr => arr.filter(p => !seen.has(p.id) && seen.add(p.id));
  return {
    stream: uniq(list(it?.flatrate)),
    free: uniq([...list(it?.free), ...list(it?.ads)]),
    rent: uniq([...list(it?.rent), ...list(it?.buy)]),
    at: Date.now(),
  };
}
const mainPlatform = s => s.providers?.stream?.[0] || s.providers?.free?.[0] || null;
const justWatch = s => `https://www.justwatch.com/it/cerca?q=${encodeURIComponent(s.name)}`;

/* Trame e titoli in italiano da TMDB (se c'è la chiave) */
async function enrichItalian(show) {
  if (!show.tmdbId) {
    let f = null;
    if (show.imdb) f = await tmdb(`/find/${show.imdb}?external_source=imdb_id`);
    if (!f?.tv_results?.length && show.tvdb) f = await tmdb(`/find/${show.tvdb}?external_source=tvdb_id`);
    show.tmdbId = f?.tv_results?.[0]?.id;
    if (!show.tmdbId) return;
  }
  const t = await tmdb(`/tv/${show.tmdbId}?language=it-IT&append_to_response=watch/providers`);
  if (t.overview) show.plotIt = t.overview;
  show.providers = parseProviders(t['watch/providers']?.results?.IT);
  const seasons = [...new Set(show.episodes.filter(e => !e.plotIt).map(e => e.s))];
  for (const sn of seasons) {
    try {
      const sd = await tmdb(`/tv/${show.tmdbId}/season/${sn}?language=it-IT`);
      for (const te of sd.episodes || []) {
        const ep = show.episodes.find(e => e.s === sn && e.n === te.episode_number);
        if (!ep) continue;
        if (te.overview) ep.plotIt = te.overview;
        if (te.name && !/^Episodio \d+$/i.test(te.name)) ep.nameIt = te.name;
      }
    } catch { /* stagione non presente su TMDB */ }
  }
}

let syncing = false;
async function refreshAll(force = false) {
  if (syncing) return;
  const ids = Object.keys(db.shows).filter(id => {
    const s = db.shows[id];
    const maxAge = s.status === 'Ended' ? 7 * DAY : DAY / 2;
    return force || Date.now() - (s.fetchedAt || 0) > maxAge;
  });
  if (!ids.length) return;
  syncing = true;
  $('#sync').hidden = false;
  let errors = 0;
  for (const id of ids) {
    try {
      const fresh = await fetchShow(id);
      if (db.shows[id]) { fresh.addedAt = db.shows[id].addedAt; db.shows[id] = fresh; save(); }
    } catch (e) { errors++; console.warn(e); }
  }
  syncing = false;
  $('#sync').hidden = true;
  if (errors) toast(`Aggiornamento non riuscito per ${plural(errors, 'serie', 'serie')}`);
  else if (force) toast('Serie aggiornate');
  if (!$('#modal').classList.contains('open')) render(true);
}

async function follow(id) {
  let s = getShow(id);
  if (!s || !s.episodes) s = await fetchShow(id);
  s.addedAt = Date.now();
  db.shows[id] = s;
  delete temp[id];
  save();
  toast(`${s.name} aggiunta`);
}
function unfollow(id) {
  const s = db.shows[id];
  if (!s) return;
  if (!confirm(`Rimuovere "${s.name}"? Gli episodi segnati come visti verranno cancellati.`)) return;
  for (const e of s.episodes) delete db.watched[e.id];
  temp[id] = s;
  delete db.shows[id];
  save();
  toast(`${s.name} rimossa`);
}

/* ---------- componenti */
const img = (src, cls = '', alt = '') => src ? `<img src="${esc(src)}" class="${cls}" alt="${esc(alt)}" loading="lazy">` : `<div class="noimg">${esc(alt)}</div>`;
const progress = pct => `<div class="progress"><i style="width:${pct}%"></i></div>`;
const checkBtn = (s, e) => `<button class="check ${isW(e) ? 'on' : ''} ${aired(e) ? '' : 'future'}" data-act="toggle" data-show="${s.id}" data-ep="${e.id}" aria-label="Segna come visto"></button>`;
const emptyState = (title, text, href, cta) => `<div class="empty"><h2>${title}</h2><p>${text}</p>${href ? `<a class="btn" href="${href}">${cta}</a>` : ''}</div>`;

const platLogo = p => p.logo ? `<img src="${esc(p.logo)}" alt="" loading="lazy">` : '';
function platformsBlock(s) {
  const pr = s.providers;
  const group = (label, arr) => arr?.length
    ? `<div class="plat-group"><small>${label}</small><div class="plats">${arr.map(p => `<span class="plat">${platLogo(p)}${esc(p.name)}</span>`).join('')}</div></div>` : '';
  let body;
  if (!pr) {
    body = `<p class="muted-p">${db.settings.tmdbKey ? 'Informazioni sulle piattaforme non ancora caricate.' : 'Per vedere su quali piattaforme italiane è disponibile, aggiungi la chiave TMDB nelle <a href="#/settings" class="link">Impostazioni</a>.'}${s.network ? ` Rete originale: ${esc(s.network)}.` : ''}</p>`;
  } else if (!pr.stream.length && !pr.free.length && !pr.rent.length) {
    body = `<p class="muted-p">Al momento non risulta disponibile in streaming in Italia.${s.network ? ` Rete originale: ${esc(s.network)}.` : ''}</p>`;
  } else {
    body = group('In abbonamento', pr.stream) + group('Gratis', pr.free) + group('Noleggio o acquisto', pr.rent);
  }
  return `<div class="pad platforms">
    <div class="row"><h2>Dove vederlo in Italia</h2><a class="link" href="${justWatch(s)}" target="_blank" rel="noopener">JustWatch ›</a></div>
    ${body}
  </div>`;
}

function setView(html) { $('#view').innerHTML = html; }
function epAirLabel(e) {
  if (!e.air) return 'Data da annunciare';
  return aired(e) ? fmtDate(e.air) : `${relDay(e.air)} · ${fmtTime(e.air)}`;
}

function epItem(s, e, showTime = true) {
  return `<div class="ep-item">
    <a href="#/show/${s.id}">${img(s.poster, 'poster-s', s.name)}</a>
    <button class="txt" data-act="ep" data-show="${s.id}" data-ep="${e.id}">
      <div class="t1">${esc(showName(s))}</div>
      <div class="t2">${code(e)} · ${esc(epName(e))}</div>
      ${showTime && e.air ? `<div class="t3">${fmtTime(e.air)}${(mainPlatform(s)?.name || s.network) ? ' · ' + esc(mainPlatform(s)?.name || s.network) : ''}</div>` : ''}
    </button>
    ${checkBtn(s, e)}
  </div>`;
}

function upcoming(days) {
  const from = Date.now(), to = from + days * DAY, out = [];
  for (const s of Object.values(db.shows)) {
    for (const e of s.episodes) {
      const t = e.air && Date.parse(e.air);
      if (t && t > from && t <= to) out.push({ s, e, t });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function groupByDay(list) {
  let html = '', cur = '';
  for (const { s, e } of list) {
    const k = dayKey(e.air);
    if (k !== cur) { cur = k; html += `<div class="day-head">${relDay(e.air)}</div>`; }
    html += epItem(s, e);
  }
  return html;
}

/* ---------- viste */
function viewWatch() {
  const shows = Object.values(db.shows);
  if (!shows.length) {
    return setView(emptyState('Nessuna serie ancora', 'Cerca le serie che segui e aggiungile: qui troverai sempre il prossimo episodio da guardare.', '#/search', 'Cerca una serie'));
  }
  const rows = shows.map(s => ({ s, st: stats(s) })).filter(r => r.st.next);
  const going = rows.filter(r => r.st.watched > 0).sort((a, b) => b.st.last - a.st.last);
  const fresh = rows.filter(r => r.st.watched === 0).sort((a, b) => (b.s.addedAt || 0) - (a.s.addedAt || 0));
  const soon = upcoming(7);

  const card = ({ s, st }) => {
    const e = st.next;
    const pic = hideSpoiler(e) ? (s.backdrop || s.poster) : (e.img || s.backdrop || s.poster);
    return `<article class="next-card">
      <button class="thumb" data-act="ep" data-show="${s.id}" data-ep="${e.id}">${img(pic, '', s.name)}</button>
      <div class="info">
        <a class="show-name" href="#/show/${s.id}">${esc(showName(s))}</a>
        <button class="ep-line" data-act="ep" data-show="${s.id}" data-ep="${e.id}" style="text-align:left;max-width:100%">${code(e)} · ${esc(epName(e))}</button>
        <div class="meta">${st.left > 1 ? `${st.left} episodi da vedere` : 'Ultimo episodio uscito'}${mainPlatform(s) ? ` · ${esc(mainPlatform(s).name)}` : ''}</div>
        ${progress(st.pct)}
      </div>
      ${checkBtn(s, e)}
    </article>`;
  };

  let html = '';
  if (going.length) html += `<div class="section-title"><h2>Continua a guardare</h2><small>${going.length}</small></div>${going.map(card).join('')}`;
  if (fresh.length) html += `<div class="section-title"><h2>Da iniziare</h2><small>${fresh.length}</small></div>${fresh.map(card).join('')}`;
  if (!going.length && !fresh.length) html += emptyState('Sei in pari! 🎉', 'Hai visto tutti gli episodi usciti. Controlla il calendario per le prossime uscite.');
  if (soon.length) html += `<div class="section-title"><h2>In uscita questa settimana</h2><a href="#/calendar"><small>Calendario ›</small></a></div>${groupByDay(soon)}`;
  setView(html);
}

let showsFilter = 'all', platFilter = null;
function viewShows() {
  const all = Object.values(db.shows).map(s => ({ s, st: stats(s) }));
  if (!all.length) return setView(emptyState('Nessuna serie', 'Le serie che aggiungi appariranno qui.', '#/search', 'Cerca una serie'));
  const filters = {
    all: ['Tutte', () => true],
    todo: ['Da vedere', r => r.st.left > 0],
    uptodate: ['In pari', r => r.st.left === 0 && r.s.status !== 'Ended'],
    done: ['Completate', r => r.st.left === 0 && r.s.status === 'Ended'],
  };
  // piattaforme presenti tra le serie seguite
  const platsOf = s => [...(s.providers?.stream || []), ...(s.providers?.free || [])];
  const plats = new Map();
  for (const { s } of all) for (const p of platsOf(s)) {
    const cur = plats.get(p.id) || { ...p, n: 0 };
    cur.n++;
    plats.set(p.id, cur);
  }
  if (platFilter && !plats.has(platFilter)) platFilter = null;
  const onPlat = r => !platFilter || platsOf(r.s).some(p => p.id === platFilter);
  const list = all.filter(filters[showsFilter][1]).filter(onPlat).sort((a, b) => a.s.name.localeCompare(b.s.name));
  setView(`
    <div style="height:12px"></div>
    <div class="chips">${Object.entries(filters).map(([k, [label, fn]]) =>
      `<button class="chip ${k === showsFilter ? 'on' : ''}" data-act="filter" data-f="${k}">${label} · ${all.filter(fn).filter(onPlat).length}</button>`).join('')}</div>
    ${plats.size ? `<div class="chips plat-chips">${[...plats.values()].sort((a, b) => b.n - a.n).map(p =>
      `<button class="chip ${p.id === platFilter ? 'on' : ''}" data-act="plat" data-p="${p.id}">${platLogo(p)}${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${list.length ? `<div class="grid">${list.map(({ s, st }) => `
      <a class="poster-card" href="#/show/${s.id}">
        <div class="p">${img(s.poster, '', s.name)}</div>
        ${mainPlatform(s)?.logo ? `<img class="plat-badge" src="${esc(mainPlatform(s).logo)}" alt="${esc(mainPlatform(s).name)}" loading="lazy">` : ''}
        ${st.left ? `<span class="badge">${st.left}</span>` : st.aired ? '<span class="badge done">✓</span>' : ''}
        ${progress(st.pct)}
        <div class="name">${esc(showName(s))}</div>
      </a>`).join('')}</div>` : emptyState('Nessuna serie qui', '')}
  `);
}

const cal = { y: new Date().getFullYear(), m: new Date().getMonth(), sel: dayKey(Date.now()) };
function viewCalendar() {
  const first = new Date(cal.y, cal.m, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // lunedì
  const map = {};
  for (const s of Object.values(db.shows)) {
    for (const e of s.episodes) {
      if (!e.air) continue;
      (map[dayKey(e.air)] ||= []).push({ s, e });
    }
  }
  const today = dayKey(Date.now());
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== cal.m) break;
    const k = dayKey(d), items = map[k] || [];
    const uniq = [...new Map(items.map(x => [x.s.id, x.s])).values()];
    cells += `<button class="cal-day ${d.getMonth() !== cal.m ? 'out' : ''} ${k === today ? 'today' : ''} ${k === cal.sel ? 'sel' : ''}" data-act="cal-day" data-k="${k}">
      <span>${d.getDate()}</span>
      <span class="pics">${uniq.slice(0, 2).map(s => s.poster ? `<img src="${esc(s.poster)}" alt="" loading="lazy">` : '').join('')}</span>
      ${uniq.length > 2 ? `<span class="more">+${uniq.length - 2}</span>` : ''}
    </button>`;
  }
  const dayItems = (map[cal.sel] || []).sort((a, b) => Date.parse(a.e.air) - Date.parse(b.e.air));
  const soon = upcoming(30).slice(0, 25);
  const monthName = first.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  setView(`
    <div class="cal-head">
      <button class="icon-btn" data-act="cal-move" data-d="-1" aria-label="Mese precedente"><svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg></button>
      <button data-act="cal-today"><h2>${monthName}</h2></button>
      <button class="icon-btn" data-act="cal-move" data-d="1" aria-label="Mese successivo"><svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg></button>
    </div>
    <div class="cal-grid">
      ${['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(d => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="day-head" style="font-size:15px">${relDay(cal.sel + 'T12:00')}</div>
    ${dayItems.length ? dayItems.map(({ s, e }) => epItem(s, e)).join('') : '<div class="ep-item" style="color:var(--muted)">Nessun episodio in questo giorno</div>'}
    ${soon.length ? `<div class="section-title"><h2>Prossime uscite</h2><small>30 giorni</small></div>${groupByDay(soon)}` : ''}
  `);
}

let searchQ = '', searchT, searchSeq = 0;
function viewSearch() {
  setView(`
    <div class="search-box"><input id="q" type="search" placeholder="Cerca una serie TV…" autocomplete="off" value="${esc(searchQ)}"></div>
    <div id="results"></div>`);
  const q = $('#q');
  q.addEventListener('input', () => {
    searchQ = q.value;
    clearTimeout(searchT);
    searchT = setTimeout(runSearch, 350);
  });
  if (searchQ) runSearch(); else { $('#results').innerHTML = emptyState('Trova le tue serie', 'Scrivi il titolo (anche in originale) e tocca + per aggiungerla.'); q.focus(); }
}
async function runSearch() {
  const box = $('#results');
  if (!box) return;
  const q = searchQ.trim();
  if (!q) { box.innerHTML = ''; return; }
  const seq = ++searchSeq;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const res = await getJSON(`${TVM}/search/shows?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq || !$('#results')) return;
    box.innerHTML = res.length ? res.map(({ show: s }) => {
      const on = isFollowed(s.id);
      const meta = [s.premiered?.slice(0, 4), (s.network || s.webChannel)?.name, (s.genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · ');
      return `<div class="result">
        <a class="poster-m" href="#/show/${s.id}">${img(https(s.image?.medium), '', s.name)}</a>
        <a class="txt" href="#/show/${s.id}">
          <div class="t1">${esc(s.name)}</div>
          <div class="t3">${esc(meta)}</div>
          ${s.rating?.average ? `<div class="t3">★ ${s.rating.average}</div>` : ''}
        </a>
        <button class="add-btn ${on ? 'on' : ''}" data-act="${on ? 'goto' : 'follow'}" data-show="${s.id}" aria-label="${on ? 'Già aggiunta' : 'Aggiungi'}">${on ? '✓' : '+'}</button>
      </div>`;
    }).join('') : emptyState('Nessun risultato', 'Prova con il titolo originale in inglese.');
  } catch {
    if (seq === searchSeq) box.innerHTML = emptyState('Errore di rete', 'Controlla la connessione e riprova.');
  }
}

const seasonSel = {};
async function viewShow(id) {
  let s = getShow(id);
  if (!s || !s.episodes) {
    setView('<div class="spinner"></div>');
    try { s = temp[id] = await fetchShow(id); }
    catch { return setView(emptyState('Impossibile caricare la serie', 'Controlla la connessione e riprova.')); }
    if (parseHash().arg !== String(id)) return; // l'utente ha cambiato pagina
  }
  const st = stats(s);
  const followed = isFollowed(id);
  const seasons = [...new Set(s.episodes.map(e => e.s))];
  if (!seasons.includes(seasonSel[id])) seasonSel[id] = st.next ? st.next.s : (seasons.find(n => s.episodes.some(e => e.s === n && !isW(e))) ?? seasons[seasons.length - 1]);
  const sn = seasonSel[id];
  const eps = s.episodes.filter(e => e.s === sn);
  const seasonAllW = eps.length && eps.filter(aired).every(isW) && eps.some(aired);
  const meta = [s.premiered?.slice(0, 4), s.network, STATUS[s.status] || s.status].filter(Boolean).join(' · ');

  setView(`
    <section class="hero" style="--bg-img:url('${esc(s.backdrop || s.poster || '')}')">
      <button class="back" data-act="back" aria-label="Indietro"><svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg></button>
      <div class="poster-l">${img(s.poster, '', s.name)}</div>
      <div>
        <h2>${esc(showName(s))}</h2>
        <div class="meta">${esc(meta)}</div>
        <div class="meta">${plural(seasons.length, 'stagione', 'stagioni')} · ${plural(s.episodes.length, 'episodio', 'episodi')}${s.rating ? ` · ★ ${s.rating}` : ''}</div>
        <div class="tags">${s.genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>
      </div>
    </section>
    <div class="show-actions">
      ${followed
        ? `<div class="prog">${st.watched}/${st.aired} episodi visti${progress(st.pct)}</div>
           <button class="btn small ghost" data-act="unfollow" data-show="${id}">Rimuovi</button>`
        : `<button class="btn" data-act="follow" data-show="${id}" style="flex:1">+ Aggiungi alle mie serie</button>`}
    </div>
    ${showPlot(s) ? `<div class="pad"><p class="plot clamp" data-act="expand">${esc(showPlot(s))}</p></div>` : ''}
    ${platformsBlock(s)}
    ${seasons.length ? `
      <div class="chips">${seasons.map(n => `<button class="chip ${n === sn ? 'on' : ''}" data-act="season" data-show="${id}" data-s="${n}">Stagione ${n}</button>`).join('')}</div>
      <div class="season-head">
        <small>${eps.filter(isW).length}/${eps.length} visti</small>
        ${followed && eps.some(aired) ? `<button class="btn small ghost" data-act="season-all" data-show="${id}" data-s="${sn}" data-v="${seasonAllW ? 0 : 1}">${seasonAllW ? 'Segna come non vista' : 'Segna stagione vista'}</button>` : ''}
      </div>
      ${eps.map(e => `
        <div class="ep-row ${isW(e) ? 'w' : ''}">
          <button class="ep-thumb" data-act="ep" data-show="${id}" data-ep="${e.id}">${img(e.img || s.backdrop, hideSpoiler(e) && e.img ? 'blur' : '', '')}</button>
          <button class="ep-info" data-act="ep" data-show="${id}" data-ep="${e.id}">
            <div class="t">${e.n}. ${esc(epName(e))}</div>
            <div class="d">${epAirLabel(e)}${e.rt ? ` · ${e.rt} min` : ''}</div>
          </button>
          ${followed ? checkBtn(s, e) : ''}
        </div>`).join('')}
    ` : emptyState('Nessun episodio', 'Gli episodi non sono ancora stati annunciati.')}
    <div style="height:20px"></div>
  `);
}

function viewSettings() {
  const shows = Object.values(db.shows);
  const watchedEps = shows.flatMap(s => s.episodes.filter(isW));
  const minutes = watchedEps.reduce((t, e) => t + (e.rt || 0), 0);
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  setView(`
    <div class="section-title"><h2>Statistiche</h2></div>
    <div class="card"><div class="stats">
      <div><b>${shows.length}</b><span>serie</span></div>
      <div><b>${watchedEps.length}</b><span>episodi visti</span></div>
      <div><b>${days ? days + 'g ' : ''}${hours}h</b><span>davanti alla TV</span></div>
    </div></div>

    <div class="section-title"><h2>Impostazioni</h2></div>
    <div class="card">
      <div class="row">
        <div><h3>Protezione spoiler</h3><p style="margin:0">Sfoca immagini e trame degli episodi non ancora visti. Tocca per mostrarle.</p></div>
        <button class="switch ${db.settings.spoiler ? 'on' : ''}" data-act="spoiler" aria-label="Protezione spoiler"></button>
      </div>
    </div>
    <div class="card">
      <h3>Trame in italiano (facoltativo)</h3>
      <p>I dati base arrivano da TVmaze, in inglese. Con una chiave gratuita di TMDB (themoviedb.org → Impostazioni → API) titoli e trame vengono presi in italiano quando disponibili.</p>
      <input id="tmdb" class="field" placeholder="Chiave API o Read Access Token TMDB" value="${esc(db.settings.tmdbKey)}" autocomplete="off">
      <button class="btn small" data-act="save-tmdb">Salva e aggiorna le serie</button>
    </div>
    <div class="card">
      <h3>Aggiorna dati</h3>
      <p>Le serie si aggiornano da sole all'avvio. Puoi forzare l'aggiornamento di nuovi episodi e date.</p>
      <button class="btn small ghost" data-act="refresh">Aggiorna ora</button>
    </div>
    <div class="card">
      <h3>Backup</h3>
      <p>Copia il testo del backup e conservalo. Per ripristinare, incollalo qui e tocca "Importa".</p>
      <textarea id="backup" class="field" placeholder="Incolla qui un backup…"></textarea>
      <div class="row" style="justify-content:flex-start;gap:8px">
        <button class="btn small ghost" data-act="export">Crea backup</button>
        <button class="btn small ghost" data-act="import">Importa</button>
      </div>
    </div>
    <p style="text-align:center;color:var(--muted);font-size:12px;padding:0 16px 20px">Dati serie: TVmaze.com (CC BY-SA)${db.settings.tmdbKey ? ' · TMDB' : ''}</p>
  `);
}

/* ---------- modale episodio */
const modal = $('#modal');
const modalOpen = () => modal.classList.contains('open');
let modalCtx = null;

function openEp(showId, epId) {
  modalCtx = { showId, epId };
  renderEp();
  if (!modalOpen()) {
    modal.classList.add('open');
    history.pushState({ modal: true }, '');
  }
}
function renderEp() {
  const s = getShow(modalCtx.showId);
  const e = s?.episodes.find(x => x.id === modalCtx.epId);
  if (!e) return closeModal();
  const hide = hideSpoiler(e);
  const plot = epPlot(e);
  const followed = isFollowed(s.id);
  $('#sheet').innerHTML = `
    <div class="still" ${hide && e.img ? 'data-act="reveal-img"' : ''}>
      <button class="close" data-act="close" aria-label="Chiudi">×</button>
      ${img(e.img || s.backdrop || s.poster, hide && e.img ? 'blur' : '', '')}
      ${hide && e.img ? '<div class="reveal-hint">Tocca per vedere l\'immagine</div>' : ''}
    </div>
    <div class="pad">
      <button class="show-link" data-act="goto" data-show="${s.id}">${esc(showName(s))} ›</button>
      <h2>${code(e)} · ${esc(epName(e))}</h2>
      <div class="meta">${e.air ? `${fmtDate(e.air, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${fmtTime(e.air)}` : 'Data da annunciare'}${e.rt ? ` · ${e.rt} min` : ''}</div>
      ${plot
        ? `<div class="${hide ? 'spoiler' : ''}" ${hide ? 'data-act="reveal"' : ''}><p class="plot">${esc(plot)}</p></div>`
        : `<p class="plot" style="color:var(--muted)">Trama non ancora disponibile.</p>`}
      ${followed ? `<div class="actions">
        <button class="btn ${isW(e) ? 'ghost' : ''}" data-act="toggle" data-show="${s.id}" data-ep="${e.id}">${isW(e) ? '✓ Visto · annulla' : 'Segna come visto'}</button>
        ${!isW(e) && s.episodes.some(x => (x.s < e.s || (x.s === e.s && x.n < e.n)) && !isW(x)) ? `<button class="btn ghost" data-act="upto" data-show="${s.id}" data-ep="${e.id}">Visti fino a qui</button>` : ''}
      </div>` : `<div class="actions"><button class="btn" data-act="follow" data-show="${s.id}">+ Aggiungi la serie</button></div>`}
    </div>`;
}
function closeModal(fromPop = false) {
  if (!modalOpen()) return;
  modal.classList.remove('open');
  modalCtx = null;
  if (!fromPop && history.state?.modal) history.back();
}
function navFromModal(hash) {
  modal.classList.remove('open');
  modalCtx = null;
  if (history.state?.modal) history.replaceState(null, '', hash); else location.hash = hash;
  render();
  scrollTo(0, 0);
}
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
addEventListener('popstate', () => { if (modalOpen()) closeModal(true); });

/* ---------- azioni */
const actions = {
  async toggle(el) {
    const s = getShow(el.dataset.show), e = s.episodes.find(x => x.id === +el.dataset.ep);
    const val = !isW(e);
    setWatched(e, val);
    save();
    if (val && navigator.vibrate) navigator.vibrate(15);
    refreshUI();
  },
  upto(el) {
    const s = getShow(el.dataset.show), e = s.episodes.find(x => x.id === +el.dataset.ep);
    const n = markUpTo(s, e);
    toast(`${plural(n, 'episodio segnato', 'episodi segnati')} come visti`);
    refreshUI();
  },
  ep(el) { openEp(+el.dataset.show, +el.dataset.ep); },
  async follow(el) {
    el.disabled = true;
    try { await follow(+el.dataset.show); } catch { toast('Errore di rete, riprova'); }
    refreshUI();
  },
  unfollow(el) { unfollow(+el.dataset.show); render(true); },
  goto(el) {
    const hash = `#/show/${el.dataset.show}`;
    if (modalOpen()) navFromModal(hash); else location.hash = hash;
  },
  back() { if (history.length > 1) history.back(); else location.hash = '#/shows'; },
  close() { closeModal(); },
  reveal(el) { el.classList.remove('spoiler'); el.removeAttribute('data-act'); },
  'reveal-img'(el) {
    el.querySelector('img')?.classList.remove('blur');
    el.querySelector('.reveal-hint')?.remove();
    el.removeAttribute('data-act');
  },
  expand(el) { el.classList.toggle('clamp'); },
  season(el) { seasonSel[el.dataset.show] = +el.dataset.s; render(true); },
  'season-all'(el) {
    const s = getShow(el.dataset.show), sn = +el.dataset.s, val = el.dataset.v === '1';
    for (const e of s.episodes) if (e.s === sn && (aired(e) || !val)) setWatched(e, val);
    save();
    render(true);
  },
  filter(el) { showsFilter = el.dataset.f; render(); },
  plat(el) { const id = +el.dataset.p; platFilter = platFilter === id ? null : id; render(true); },
  'cal-day'(el) {
    cal.sel = el.dataset.k;
    const d = new Date(cal.sel + 'T12:00');
    cal.y = d.getFullYear(); cal.m = d.getMonth();
    render(true);
  },
  'cal-move'(el) {
    const d = new Date(cal.y, cal.m + +el.dataset.d, 1);
    cal.y = d.getFullYear(); cal.m = d.getMonth();
    cal.sel = dayKey(d);
    render(true);
  },
  'cal-today'() {
    const d = new Date();
    cal.y = d.getFullYear(); cal.m = d.getMonth(); cal.sel = dayKey(d);
    render(true);
  },
  spoiler() { db.settings.spoiler = !db.settings.spoiler; save(); render(true); },
  async 'save-tmdb'() {
    db.settings.tmdbKey = $('#tmdb').value.trim();
    save();
    if (db.settings.tmdbKey) {
      try { await tmdb('/configuration'); } catch { return toast('Chiave TMDB non valida'); }
      toast('Chiave salvata, aggiorno le serie…');
    }
    refreshAll(true);
  },
  refresh() { refreshAll(true); },
  async export() {
    const data = JSON.stringify({ app: 'serietrack', v: 1, date: new Date().toISOString(), watched: db.watched, shows: Object.keys(db.shows).map(Number), settings: { spoiler: db.settings.spoiler } });
    $('#backup').value = data;
    try { await navigator.clipboard.writeText(data); toast('Backup copiato negli appunti'); }
    catch { $('#backup').select(); toast('Backup pronto: copialo dal riquadro'); }
  },
  async import() {
    let d;
    try { d = JSON.parse($('#backup').value); } catch { return toast('Backup non valido'); }
    if (d.app !== 'serietrack' || !Array.isArray(d.shows)) return toast('Backup non valido');
    if (!confirm(`Importare ${d.shows.length} serie? I dati attuali verranno uniti al backup.`)) return;
    Object.assign(db.watched, d.watched || {});
    if (d.settings) Object.assign(db.settings, d.settings);
    save();
    toast('Importazione in corso…');
    let n = 0;
    for (const id of d.shows) {
      if (db.shows[id]) continue;
      try { const s = await fetchShow(id); s.addedAt = Date.now(); db.shows[id] = s; save(); n++; } catch { /* salta */ }
    }
    toast(`Importate ${plural(n, 'serie', 'serie')}`);
    render();
  },
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  ev.preventDefault();
  ev.stopPropagation();
  actions[el.dataset.act]?.(el, ev);
});

function refreshUI() {
  if (modalOpen()) renderEp();
  render(true);
}

/* ---------- router */
const routes = { watch: viewWatch, shows: viewShows, calendar: viewCalendar, search: viewSearch, show: viewShow, settings: viewSettings };
const TITLES = { watch: 'Da guardare', shows: 'Le mie serie', calendar: 'Calendario', search: 'Cerca', settings: 'Impostazioni', show: 'SerieTrack' };
function parseHash() {
  const [, name = 'watch', arg] = location.hash.split('/');
  return { name: routes[name] ? name : 'watch', arg };
}
async function render(keepScroll = false) {
  const { name, arg } = parseHash();
  const y = scrollY;
  $('#title').textContent = TITLES[name];
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
  // la ricerca mantiene il focus: non ridisegnarla durante gli aggiornamenti
  if (keepScroll && name === 'search' && $('#results')) {
    document.querySelectorAll('.add-btn').forEach(b => {
      const on = isFollowed(b.dataset.show);
      b.classList.toggle('on', on); b.textContent = on ? '✓' : '+'; b.dataset.act = on ? 'goto' : 'follow'; b.disabled = false;
    });
    return;
  }
  await routes[name](arg ? +arg : undefined);
  if (keepScroll) scrollTo(0, y);
}
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });

/* ---------- integrazione Android (Capacitor) */
const Cap = window.Capacitor?.Plugins;
if (Cap?.App) {
  Cap.App.addListener('backButton', ({ canGoBack }) => {
    if (modalOpen()) closeModal();
    else if (canGoBack && parseHash().name !== 'watch') history.back();
    else if (parseHash().name !== 'watch') location.hash = '#/watch';
    else Cap.App.exitApp();
  });
  Cap.App.addListener('resume', () => { refreshAll(); render(true); });
}

/* ---------- avvio */
if (!location.hash) history.replaceState(null, '', '#/watch');
render();
refreshAll();
