/* ============================================================================
   OLS — Omani Learning System · client application
   Structure: helpers → store/sync → auth → media → RBAC → router → pages → boot
   ========================================================================== */
'use strict';
const APP_VERSION = 'v1.7 · 2026-07-15';
const PREFIX = 'ols-';                                  // synced app keys
const LOCAL_PREFIX = 'olsx-';                            // per-device, never synced
const SYNC_SKIP = ['ols-token', 'ols-session'];         // never leave the device

/* ------------------------------- helpers -------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const arDate = t => { try { return new Date(t).toLocaleDateString('ar', {year: 'numeric', month: 'long', day: 'numeric'}); } catch (e) { return ''; } };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* Numeral system: 'hindi' (٠١٢٣ Eastern-Arabic) or 'arabic' (0123 Western).
   num() converts digits in any value to the active mode; numDir() gives the
   writing direction the user asked for (Western = LTR, Eastern = RTL). */
const EAST_DIGITS = '٠١٢٣٤٥٦٧٨٩';
let NUM_MODE = 'hindi';
function num(v) {
  v = String(v == null ? '' : v);
  return NUM_MODE === 'arabic'
    ? v.replace(/[٠-٩]/g, d => String(EAST_DIGITS.indexOf(d)))
    : v.replace(/[0-9]/g, d => EAST_DIGITS[+d]);
}
function numDir() { return NUM_MODE === 'arabic' ? 'ltr' : 'rtl'; }
/* wrap a numeric/expression string with the correct direction + digits */
function numSpan(v) { return `<bdi dir="${numDir()}" style="unicode-bidi:isolate">${num(esc(v))}</bdi>`; }
function updateNumToggle() { const b = $('#num-toggle'); if (b) b.textContent = NUM_MODE === 'hindi' ? '١٢٣' : '123'; }
function toggleNum() { NUM_MODE = NUM_MODE === 'hindi' ? 'arabic' : 'hindi'; Store.lset('num-mode', NUM_MODE); updateNumToggle(); router(true); }

/* Never auto-re-render (from the 12s sync poll) while the user is interacting —
   an open modal or a focused field. Prevents lost input / disrupted uploads.
   (hard-won-fix #15) */
function canAutoRerender() {
  if ($('#modal-root .modal-back')) return false;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return false;
  return true;
}

function toast(msg, kind) {
  const root = $('#toast-root');
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, 2600);
}

function modal(title, bodyHtml, footHtml, opts) {
  opts = opts || {};
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${opts.wide ? 'wide' : ''}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" aria-label="إغلاق">×</button></div>
    <div class="modal-body">${bodyHtml}</div>
    ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}</div>`;
  const close = () => back.remove();
  back.querySelector('.modal-x').onclick = close;
  back.addEventListener('click', e => { if (e.target === back && !opts.sticky) close(); });
  $('#modal-root').appendChild(back);
  return {el: back, close};
}

/* ------------------------------ store + sync ---------------------------- */
const Store = {
  server: false, token: '', lastPull: 0, pullTimer: null,
  get(key, def) { try { const v = localStorage.getItem(PREFIX + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  _writeLocal(key, val) { try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) {} },
  set(key, val) { this._writeLocal(key, val); if (this.server && SYNC_SKIP.indexOf(PREFIX + key) < 0) this._push(key, val); },
  lget(key, def) { try { const v = localStorage.getItem(LOCAL_PREFIX + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  lset(key, val) { try { localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(val)); } catch (e) {} },

  async _push(key, val) {
    try { await api('/api/state', 'POST', {key: PREFIX + key, value: val}); } catch (e) {}
  },
  async pull(silent) {
    if (!this.server) return;
    try {
      const r = await api('/api/state?since=' + this.lastPull, 'GET');
      if (r && r.kv) {
        let changed = false;
        for (const k in r.kv) { if (k.indexOf(PREFIX) === 0) { this._writeLocal(k.slice(PREFIX.length), r.kv[k]); changed = true; } }
        this.lastPull = r.now || Date.now();
        if (changed && !silent && typeof router === 'function' && canAutoRerender()) router(true);
      }
    } catch (e) {}
  },
  startPolling() { if (this.pullTimer) clearInterval(this.pullTimer); this.pullTimer = setInterval(() => this.pull(false), 12000); }
};

/* thin fetch wrapper with token header */
async function api(path, method, body) {
  const opts = {method: method || 'GET', headers: {}};
  if (Store.token) opts.headers['x-mis-token'] = Store.token;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = {}; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(data.error || ('HTTP ' + res.status)); err.status = res.status; err.data = data; throw err; }
  return data;
}

/* ------------------------------ media/blobs ----------------------------- */
const MAX_UPLOAD_MB = 50;   // must stay under the server's ~53MB real-file cap
/* returns true if OK to upload; otherwise toasts a clear reason and returns false */
function checkUploadSize(file, isMedia) {
  const mb = file.size / 1048576;
  if (mb <= MAX_UPLOAD_MB) return true;
  toast(`الملف كبير جدًا (${Math.round(mb)}MB). الحد الأقصى ${MAX_UPLOAD_MB}MB.` + (isMedia ? ' استخدم رابط YouTube/Drive للفيديوهات الكبيرة.' : ' يُفضّل ضغط الملف.'), 'err');
  return false;
}
function fileToDataURL(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
}
/* Upload in ~1.5MB chunks — shared hosts (Hostinger LiteSpeed proxy etc.) reject
   large request bodies, which silently killed real video/audio uploads. Small
   sequential parts always get through. onProgress(0–100) drives the UI. */
async function uploadBlob(key, dataUrl, onProgress) {
  if (!Store.server) { Store._writeLocal('blob-' + key, dataUrl); if (onProgress) onProgress(100); return {ok: true, local: true}; }
  const CH = 1500000;
  if (dataUrl.length <= CH) { const r = await api('/api/blob', 'POST', {key, dataUrl}); if (onProgress) onProgress(100); return r; }
  const parts = Math.ceil(dataUrl.length / CH);
  for (let i = 0; i < parts; i++) {
    await api('/api/blob', 'POST', {key, part: dataUrl.slice(i * CH, (i + 1) * CH), seq: i, parts});
    if (onProgress) onProgress(Math.round(((i + 1) / parts) * 100));
  }
  return {ok: true};
}
function fileUrl(key, name, dl) {
  if (Store.server) return '/api/file?key=' + encodeURIComponent(key) + '&token=' + encodeURIComponent(Store.token) + (name ? '&name=' + encodeURIComponent(name) : '') + (dl ? '&dl=1' : '');
  return Store._writeLocal ? (Store.get('blob-' + key) || '') : '';
}
function localBlob(key) { return Store.get('blob-' + key, ''); }

/* ------------------------------ RBAC ------------------------------------ */
const Auth = {
  user: null,
  get role() { return this.user ? this.user.role : ''; },
  get isAdmin() { return this.role === 'مدير'; },
  get isTeacher() { return this.role === 'معلم'; },
  get isStudent() { return this.role === 'طالب'; },
  get isParent() { return this.role === 'ولي أمر'; },
  get canManage() { return this.isAdmin || this.isTeacher; },      // add content
  get canDelete() { return this.isAdmin; },                        // delete/replace content
};

/* ============================== DATA ACCESSORS ========================== */
const DATA = window.APP_DATA;
const gradeName = g => g === 0 ? 'رياض الأطفال' : ('الصف ' + (DATA.gradeNames[g] || g));
/* Merge seed + user content by id: a saved copy with the same id REPLACES the
   seed (fixes "replaced content never displays"); a {_deleted} tombstone hides
   a seed item permanently. */
function mergeById(seed, custom) {
  const map = new Map();
  seed.forEach(x => map.set(x.id, x));
  (custom || []).forEach(x => { if (x && x.id) { if (x._deleted) map.delete(x.id); else map.set(x.id, x); } });
  return Array.from(map.values());
}
function removeContent(storeKey, id, seedList) {
  let c = Store.get(storeKey, []).filter(x => x.id !== id);
  if (seedList.some(x => x.id === id)) c.push({id, _deleted: true});   // tombstone for seed items
  Store.set(storeKey, c);
}
function library() { return mergeById(DATA.library, Store.get('library', [])); }
function lessons() {
  // self-heal records saved by the old buggy "add" flow (missing id) so they
  // reappear and stay individually addressable
  const c = Store.get('lessons', []);
  let fixed = false;
  c.forEach(x => { if (x && !x.id && !x._deleted) { x.id = uid(); fixed = true; } });
  if (fixed) Store.set('lessons', c);
  return mergeById(DATA.lessons, c);
}
function tests() { return mergeById(DATA.tests, Store.get('tests', [])); }
function results() { return Store.get('results', []); }
function addResult(rec) { const r = results(); r.push(rec); Store.set('results', r); }

/* ---- user directory + messaging relationships ---- */
let DIRECTORY = [];
async function loadDirectory() { try { const r = await api('/api/directory'); DIRECTORY = r.users || []; } catch (e) { DIRECTORY = []; } return DIRECTORY; }
const levelsOf = u => (u && u.levels) || [];
const shares = (a, b) => levelsOf(a).some(x => levelsOf(b).includes(x));
function meDir() { return DIRECTORY.find(u => u.u === Auth.user.u) || Auth.user; }
/* who the current user is allowed to message, per role + level assignment */
function myContacts() {
  const meU = Auth.user.u; const me = meDir();
  const dir = DIRECTORY.filter(u => u.u !== meU);
  if (Auth.isAdmin) return dir;
  if (Auth.isTeacher) return dir.filter(u => u.role === 'مدير'
    || (u.role === 'طالب' && (levelsOf(me).length === 0 || shares(me, u)))
    || (u.role === 'ولي أمر'));
  if (Auth.isStudent) return dir.filter(u => u.role === 'مدير'
    || (u.role === 'معلم' && (levelsOf(u).length === 0 || levelsOf(me).length === 0 || shares(me, u))));
  if (Auth.isParent) { const child = DIRECTORY.find(u => u.u === (me.child || '')); return dir.filter(u => u.role === 'مدير' || (u.role === 'معلم' && (!child || shares(child, u)))); }
  return dir.filter(u => u.role === 'مدير');
}
const threadKey = (a, b) => [a, b].sort().join('__');
function messages() { return Store.get('messages', []); }
function threadWith(otherU) { const k = threadKey(Auth.user.u, otherU); return messages().filter(m => threadKey(m.from, m.to) === k).sort((a, b) => a.t - b.t); }
function sendMessage(toU, toName, text) {
  const all = messages();
  all.push({id: uid(), from: Auth.user.u, fromName: Auth.user.name, to: toU, toName, text, t: Date.now()});
  Store.set('messages', all);
}
function roleEmoji(role) { return {'مدير': '👑', 'معلم': '📗', 'طالب': '🎒', 'ولي أمر': '👪', 'زائر': '👁️'}[role] || '👤'; }

/* ---- class (grade) scoping ------------------------------------------------
   Students see only the class(es) they are enrolled in; teachers their assigned
   classes (all if unassigned); parents their child's class; admin everything.
   grade 0 (روضة/عام) content is open to everyone. */
function myLevels() {
  if (!Auth.user) return [];
  if (Auth.isParent) { const ch = DIRECTORY.find(u => u.u === (meDir().child || '')); return ch ? (ch.levels || []) : []; }
  const d = meDir();
  return (d.levels && d.levels.length ? d.levels : Auth.user.levels) || [];
}
function visibleTo(item) {
  if (!Auth.user || Auth.isAdmin) return true;
  const g = Number(item.grade) || 0;
  if (g === 0) return true;
  const lv = myLevels();
  if (Auth.isTeacher) return lv.length ? lv.includes(g) : true;
  if (Auth.isStudent || Auth.isParent) return lv.includes(g);
  return true;   // visitor: read-only browsing
}
function forMe(items) { return (items || []).filter(visibleTo); }
/* one banner for students not yet enrolled in a class */
function noClassBanner() {
  if (!(Auth.isStudent && myLevels().length === 0)) return '';
  return `<div class="card" style="border-color:var(--gold);background:#fff9ec;margin-bottom:14px">
    🎒 <b>لم يُعتمد صفّك الدراسي بعد.</b> يظهر لك حاليًا المحتوى العام فقط — بعد اعتماد المدير لصفّك سترى كل محتوى صفّك تلقائيًا.</div>`;
}
/* grade filter chips (per page, per device). Returns html; wire with wireGradeChips.
   Items may carry the grade as `.grade` (lessons/tests/exercises) or `.g` (books). */
const gradeOf = i => Number(i.grade != null ? i.grade : i.g) || 0;
function gradeFilterRow(pageKey, items) {
  const grades = Array.from(new Set(items.map(gradeOf))).sort((a, b) => a - b);
  if (grades.length < 2) return '';
  const cur = Store.lget(pageKey + '-grade', 'all');
  const chips = [{v: 'all', t: 'الكل'}].concat(grades.map(g => ({v: String(g), t: g === 0 ? 'عام / روضة' : gradeName(g)})));
  return `<div class="chip-row">${chips.map(c => `<button class="tab-chip ${String(cur) === c.v ? 'active' : ''}" data-gf="${c.v}">${esc(c.t)}</button>`).join('')}</div>`;
}
function applyGradeFilter(pageKey, items) {
  const cur = Store.lget(pageKey + '-grade', 'all');
  if (cur === 'all') return items;
  // ignore a stale filter (e.g. left over from another user) whose grade isn't
  // present in the current item set — otherwise the page would look empty
  const avail = new Set(items.map(i => String(gradeOf(i))));
  if (!avail.has(String(cur))) return items;
  return items.filter(i => String(gradeOf(i)) === String(cur));
}
function wireGradeChips(pageKey, rerender) {
  $$('[data-gf]').forEach(c => c.onclick = () => { Store.lset(pageKey + '-grade', c.dataset.gf); rerender(); });
}

/* ---- official curriculum library (from library-data.js) ------------------
   Every book has two forms: an official MoE interactive reader (b.link) and a
   local PDF (b.file, served from a configurable base — default "library/").
   The 18GB of PDFs are NOT bundled; the interactive links work everywhere. */
const OFFICIAL_BOOKS = (window.OLS_LIBRARY && window.OLS_LIBRARY.books) || [];
const SUBJECT_ICON = {
  'اللغة العربية': '📕', 'اللغة الإنجليزية': '📘', 'الرياضيات': '➗', 'العلوم': '🔬',
  'التربية الإسلامية': '🕌', 'الدراسات الاجتماعية': '🗺️', 'الفيزياء': '🧲', 'الكيمياء': '⚗️',
  'الأحياء': '🧬', 'الجيولوجيا وعلوم البيئة': '🌋', 'تقنية المعلومات': '💻', 'الفنون التشكيلية': '🎨',
  'الرياضة المدرسية': '⚽', 'المهارات الموسيقية': '🎵', 'المهارات الحياتية': '🌱',
  'المهارات والمسار المهني': '🧭', 'أدلة أولياء الأمور': '👪', 'مصادر ومراجع': '📚', 'مصادر عامة': '📖'
};
const subjIcon = s => SUBJECT_ICON[s] || '📖';
function pdfBase() { let b = Store.get('libPdfBase', 'library/'); return b && !/\/$/.test(b) ? b + '/' : b; }
function encPath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }
function bookHref(b, mode) {
  const pdf = b.file ? pdfBase() + encPath(b.file) : '';
  if (mode === 'pdf') return pdf || b.link || '';
  return b.link || pdf || '';
}
function bookMode() { return Store.lget('book-mode', 'interactive'); }
function officialFor(grade, sem) {
  return OFFICIAL_BOOKS.filter(b => b.g === grade && (sem == null || b.sem === sem || b.sem === 0));
}
/* open a book inside the app (iframe reader) with PDF⇄interactive toggle */
function openBookReader(b) {
  let mode = bookMode();
  if (mode === 'pdf' && !b.file) mode = 'interactive';
  if (mode === 'interactive' && !b.link) mode = 'pdf';
  const both = !!(b.file && b.link);
  const shell = `
    <div class="reader-bar" style="border-radius:12px 12px 0 0">
      <div class="rt">${subjIcon(b.sub)} ${esc(b.title)}</div><div class="spacer"></div>
      <span class="pill ${mode === 'pdf' ? 'gold' : 'teal'}" id="bk-modepill"></span>
    </div>
    <iframe id="bookframe" style="width:100%;height:66vh;border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;background:#f3f6f5"></iframe>
    <p class="muted" id="bk-note" style="font-size:.76rem;margin:8px 2px 0"></p>`;
  const foot = `
    ${both ? `<button class="btn" id="bk-toggle"></button>` : ''}
    <button class="btn" id="bk-fs">⛶ ملء الشاشة</button>
    <a class="btn primary" id="bk-open" target="_blank" rel="noopener">↗ فتح في نافذة</a>
    ${b.file ? `<a class="btn" id="bk-dl" href="${bookHref(b, 'pdf')}" download>⬇ تنزيل PDF</a>` : ''}`;
  const m = modal(gradeName(b.g) + (b.sem ? ' · الفصل ' + num(b.sem) : ''), shell, foot, {wide: true});
  const apply = () => {
    const url = bookHref(b, mode);
    $('#bookframe', m.el).src = url;
    $('#bk-open', m.el).href = url;
    $('#bk-modepill', m.el).textContent = mode === 'pdf' ? '📄 ملف PDF' : '📖 كتاب تفاعلي';
    $('#bk-modepill', m.el).className = 'pill ' + (mode === 'pdf' ? 'gold' : 'teal');
    const tg = $('#bk-toggle', m.el); if (tg) tg.textContent = mode === 'interactive' ? '📄 عرض PDF' : '📖 عرض تفاعلي';
    $('#bk-note', m.el).innerHTML = mode === 'pdf'
      ? 'ملف PDF محلي — يظهر عند رفع مجلد المكتبة على الخادم. إن لم يظهر استخدم «الكتاب التفاعلي».'
      : 'الكتاب التفاعلي الرسمي من بوابة وزارة التربية والتعليم.';
  };
  apply();
  const tg = $('#bk-toggle', m.el); if (tg) tg.onclick = () => { mode = mode === 'interactive' ? 'pdf' : 'interactive'; Store.lset('book-mode', mode); apply(); };
  $('#bk-fs', m.el).onclick = () => { const f = $('#bookframe', m.el); if (f.requestFullscreen) f.requestFullscreen(); else if (f.webkitRequestFullscreen) f.webkitRequestFullscreen(); };
}

/* ============================== ROUTER ================================== */
const PAGES = {};
let currentRoute = '';
function router(isRefresh) {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  const route = parts[0] || 'dashboard';
  currentRoute = route;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === route));
  const fn = PAGES[route] || PAGES.dashboard;
  const view = $('#view');
  if (!isRefresh) view.scrollTop = 0, window.scrollTo(0, 0);
  try { fn(parts.slice(1), isRefresh); } catch (e) { view.innerHTML = `<div class="empty"><div class="big">⚠️</div>حدث خطأ في عرض الصفحة.<br><small>${esc(e.message)}</small></div>`; console.error(e); }
  closeSidebar();
}
function go(route) { location.hash = '#/' + route; }
function crumb(title, sub) { $('#crumbs').innerHTML = esc(title) + (sub ? ` <span class="crumb-sub">· ${esc(sub)}</span>` : ''); }

/* ============================== PAGES ================================== */

/* ---- Dashboard ---- */
PAGES.dashboard = function () {
  crumb('الرئيسية', 'لوحة المعلومات');
  const res = results();
  const myRes = Auth.isAdmin ? res : res.filter(r => r.user === Auth.user.u);
  const avg = myRes.length ? Math.round(myRes.reduce((s, r) => s + (r.score / r.total) * 100, 0) / myRes.length) : 0;
  const tiles = [
    {k: 'المستويات الدراسية', v: DATA.levels.length, s: 'من الروضة إلى الصف 12', cls: ''},
    {k: 'الكتب المدرسية', v: OFFICIAL_BOOKS.length + library().length, s: 'كتب رسمية ومصادر', cls: 'b'},
    {k: 'الحصص والدروس', v: lessons().length, s: 'فيديو وصوت', cls: 'p'},
    {k: 'متوسط أدائك', v: avg + '%', s: myRes.length + ' اختبار', cls: 'g'},
  ];
  const quick = [
    {r: 'curriculum', e: '📚', t: 'المناهج', d: 'تصفّح الكتب حسب المستوى'},
    {r: 'lessons', e: '🎬', t: 'الحصص', d: 'شاهد الدروس المسجّلة'},
    {r: 'tests', e: '📝', t: 'الاختبارات', d: 'اختبر معلوماتك'},
    {r: 'assistant', e: '🤖', t: 'المساعد الذكي', d: 'اسأل وحلّ المسائل'},
  ];
  const recent = res.slice(-5).reverse();
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>مرحبًا، ${esc(Auth.user.name)} 👋</h2><p>${esc(Auth.role)} · هذا ملخّص نشاطك في OLS</p></div></div>
    <div class="stat-tiles">${tiles.map(t => `<div class="stat ${t.cls}"><div class="k">${t.k}</div><div class="v">${num(t.v)}</div><div class="s">${num(t.s)}</div></div>`).join('')}</div>
    <div class="section-title">🚀 وصول سريع</div>
    <div class="grid g-4">${quick.map(q => `<a class="card" href="#/${q.r}" style="cursor:pointer"><div style="font-size:2rem">${q.e}</div><h3 style="margin:.3em 0 .1em;color:var(--teal-ink)">${q.t}</h3><p class="muted" style="margin:0;font-size:.85rem">${q.d}</p></a>`).join('')}</div>
    <div class="grid g-2" style="margin-top:20px">
      <div class="card"><div class="section-title" style="margin-top:0">🎓 ${Auth.isStudent ? 'صفّي الدراسي' : 'المستويات الدراسية'}</div>
        <div class="row">${DATA.levels.filter(l => visibleTo({grade: l.grade})).map(l => `<a class="pill ${l.kindergarten ? 'gold' : 'teal'}" href="#/${l.kindergarten ? 'kindergarten' : 'curriculum/' + l.id}" style="cursor:pointer">${esc(l.name)}</a>`).join('')}</div></div>
      <div class="card"><div class="section-title" style="margin-top:0">🕘 أحدث النتائج</div>
        ${recent.length ? `<table class="tbl"><tr><th>الطالب</th><th>الاختبار</th><th>النتيجة</th><th>التاريخ</th></tr>
          ${recent.map(r => `<tr><td>${esc(r.userName || r.user)}</td><td>${esc(r.title)}</td><td><b>${num(r.score)}/${num(r.total)}</b></td><td class="muted">${num(arDate(r.date))}</td></tr>`).join('')}</table>`
          : `<div class="empty"><div class="big">📊</div>لا توجد نتائج بعد — ابدأ باختبار!</div>`}
      </div>
    </div>`;
};

/* ---- Curriculum (book reader) ---- */
PAGES.curriculum = function (params) {
  const levelId = params[0];
  if (!levelId) {
    crumb('المناهج', 'اختر المستوى الدراسي');
    const myList = DATA.levels.filter(l => visibleTo({grade: l.grade}));
    $('#view').innerHTML = `
      <div class="page-head"><div><h2>المناهج الدراسية</h2><p>${Auth.isStudent ? 'كتب صفّك الدراسي' : 'المنهج العُماني — من الروضة إلى الصف الثاني عشر'}. اختر مستوى لعرض كتبه.</p></div></div>
      ${noClassBanner()}
      <div class="grid g-4">${myList.map(l => {
        const total = l.kindergarten ? 0 : l.books[1].length + l.books[2].length;
        return `<a class="card" href="#/${l.kindergarten ? 'kindergarten' : 'curriculum/' + l.id}" style="cursor:pointer;position:relative">
          <div style="font-size:1.9rem">${l.kindergarten ? '🧸' : '📖'}</div>
          <h3 style="margin:.3em 0 .1em;color:var(--teal-ink)">${esc(l.name)}</h3>
          <p class="muted" style="margin:0;font-size:.82rem">${esc(l.stage)}</p>
          <div class="pill teal" style="margin-top:8px">${l.kindergarten ? 'أنشطة تفاعلية' : num(total) + ' كتاب'}</div></a>`;
      }).join('')}</div>`;
    return;
  }
  const level = DATA.levels.find(l => l.id === levelId);
  if (!level) { $('#view').innerHTML = `<div class="empty">المستوى غير موجود</div>`; return; }
  if (!visibleTo({grade: level.grade})) { $('#view').innerHTML = `<div class="empty"><div class="big">🔒</div>هذا المستوى ليس ضمن صفّك الدراسي.<br><a class="btn" href="#/curriculum" style="margin-top:10px">◀ مناهج صفّي</a></div>`; return; }
  if (level.kindergarten) { go('kindergarten'); return; }
  crumb('المناهج · ' + level.name, level.stage);
  const books = officialFor(level.grade, null);
  // group by semester → subject
  const spine = ['#0e7c66', '#2563eb', '#7c3aed', '#e11d64', '#d97706', '#0891b2', '#16a34a', '#be123c'];
  const railSection = (sem, label) => {
    const bs = books.filter(b => (sem === 0 ? b.sem === 0 : b.sem === sem));
    if (!bs.length) return '';
    const bySub = {};
    bs.forEach(b => (bySub[b.sub] = bySub[b.sub] || []).push(b));
    return `<div class="sem-label">${label}</div>` + Object.keys(bySub).map(sub => `
      <div class="rail-sub">${subjIcon(sub)} ${esc(sub)}</div>` +
      bySub[sub].map(b => { const gi = OFFICIAL_BOOKS.indexOf(b); const c = spine[Math.abs(hashStr(b.sub)) % spine.length];
        return `<div class="book-chip" data-bi="${gi}">
          <div class="book-spine" style="background:linear-gradient(135deg,${c},${spine[(spine.indexOf(c) + 3) % spine.length]})"></div>
          <div><div class="bt">${esc(b.title.replace(/^[^—]+—\s*/, '') || b.sub)}</div>
            <div class="bs">${b.link ? '📖 تفاعلي' : ''}${b.file ? (b.link ? ' · 📄 PDF' : '📄 PDF') : ''}</div></div></div>`;
      }).join('')).join('');
  };
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>📖 ${esc(level.name)}</h2><p>${esc(level.stage)} · ${num(books.length)} كتاب — اختر كتابًا لعرضه هنا مباشرة</p></div>
      <a class="btn" href="#/curriculum">◀ كل المستويات</a></div>
    <div class="reader">
      <div class="reader-view" id="reader-view">
        <div class="reader-empty"><div style="font-size:3rem">📚</div><h3>اختر كتابًا من الرف</h3>
          <p>يُفتح الكتاب مباشرة داخل الصفحة — تفاعلي أو PDF، مع ملء الشاشة.</p></div>
      </div>
      <div class="book-rail">
        <h4>📗 كتب ${esc(level.name)}</h4>
        ${railSection(1, 'الفصل الدراسي الأول')}
        ${railSection(2, 'الفصل الدراسي الثاني')}
        ${railSection(0, 'على مدار العام')}
      </div>
    </div>`;
  $$('.book-chip').forEach(chip => chip.onclick = () => {
    $$('.book-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    openBookInPane(OFFICIAL_BOOKS[+chip.dataset.bi]);
  });
};
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
/* render the book inside the curriculum reader pane (not a modal) */
function openBookInPane(b) {
  if (!b) return;
  const rv = $('#reader-view'); if (!rv) return;
  let mode = bookMode();
  if (mode === 'pdf' && !b.file) mode = 'interactive';
  if (mode === 'interactive' && !b.link) mode = 'pdf';
  const both = !!(b.file && b.link);
  const draw = () => {
    const url = bookHref(b, mode);
    rv.innerHTML = `
      <div class="reader-bar">
        <div class="rt">${subjIcon(b.sub)} ${esc(b.title)}</div><div class="spacer"></div>
        ${both ? `<button class="btn sm" id="rp-toggle">${mode === 'interactive' ? '📄 PDF' : '📖 تفاعلي'}</button>` : ''}
        <button class="btn sm" id="rp-fs">⛶</button>
        <a class="btn sm primary" href="${esc(url)}" target="_blank" rel="noopener">↗ نافذة</a>
      </div>
      <iframe class="reader-frame" id="rp-frame" src="${esc(url)}" allowfullscreen></iframe>`;
    const tg = $('#rp-toggle', rv); if (tg) tg.onclick = () => { mode = mode === 'interactive' ? 'pdf' : 'interactive'; Store.lset('book-mode', mode); draw(); };
    $('#rp-fs', rv).onclick = () => { const f = $('#rp-frame', rv); if (f.requestFullscreen) f.requestFullscreen(); else if (f.webkitRequestFullscreen) f.webkitRequestFullscreen(); };
  };
  draw();
}

/* ---- Library ---- */
PAGES.library = function () {
  crumb('المكتبة', 'الكتب المدرسية والمصادر');
  // official curriculum books visible to this user, filtered by grade chip
  const official = OFFICIAL_BOOKS.filter(b => visibleTo({grade: b.g}));
  const byGrade = applyGradeFilter('library', official);
  const q = (Store.lget('lib-q', '') || '').trim();
  const activeSub = Store.lget('lib-sub', 'الكل');
  const activeSem = Store.lget('lib-sem', 'all');
  const mode = bookMode();
  let list = byGrade;
  if (activeSem !== 'all') list = list.filter(b => String(b.sem) === activeSem);
  if (activeSub !== 'الكل') list = list.filter(b => b.sub === activeSub);
  if (q) list = list.filter(b => (b.title + ' ' + b.sub + ' ' + b.name + ' ' + gradeName(b.g)).toLowerCase().includes(q.toLowerCase()));
  const subjects = ['الكل'].concat(Array.from(new Set(byGrade.map(b => b.sub))));
  // group results by subject
  const bySub = {}; list.forEach(b => (bySub[b.sub] = bySub[b.sub] || []).push(b));
  const custom = forMe(library());
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🗂️ المكتبة</h2><p>${num(OFFICIAL_BOOKS.length)} كتابًا مدرسيًا رسميًا — مصنّفة حسب الصف والمادة، بصيغة تفاعلية أو PDF.</p></div>
      <div class="row">
        <div class="seg"><button class="seg-btn ${mode === 'interactive' ? 'on' : ''}" data-mode="interactive">📖 تفاعلي</button><button class="seg-btn ${mode === 'pdf' ? 'on' : ''}" data-mode="pdf">📄 PDF</button></div>
        ${Auth.canManage ? `<button class="btn primary" id="add-book">➕ مصدر</button>` : ''}
      </div></div>
    ${noClassBanner()}
    <div class="row" style="gap:10px;margin-bottom:12px">
      <input id="lib-search" placeholder="🔎 ابحث عن كتاب أو مادة…" value="${esc(q)}" style="flex:1;min-width:180px;padding:.6em .9em;border:1px solid var(--line);border-radius:12px">
      ${Auth.isAdmin ? `<button class="btn" id="lib-cfg" title="مسار ملفات PDF على الخادم">⚙️ مسار PDF</button>` : ''}
    </div>
    ${gradeFilterRow('library', official)}
    <div class="chip-row">
      <button class="tab-chip ${activeSem === 'all' ? 'active' : ''}" data-sem="all">كل الفصول</button>
      <button class="tab-chip ${activeSem === '1' ? 'active' : ''}" data-sem="1">الفصل الأول</button>
      <button class="tab-chip ${activeSem === '2' ? 'active' : ''}" data-sem="2">الفصل الثاني</button>
      <button class="tab-chip ${activeSem === '0' ? 'active' : ''}" data-sem="0">على مدار العام</button>
    </div>
    <div class="chip-row">${subjects.map(s => `<button class="tab-chip ${s === activeSub ? 'active' : ''}" data-sub="${esc(s)}">${s === 'الكل' ? 'كل المواد' : subjIcon(s) + ' ' + esc(s)}</button>`).join('')}</div>
    ${Object.keys(bySub).length ? Object.keys(bySub).map(sub => `
      <div class="section-title">${subjIcon(sub)} ${esc(sub)} <span class="muted" style="font-weight:400;font-size:.8rem">(${num(bySub[sub].length)})</span></div>
      <div class="lib-grid">${bySub[sub].map(officialCard).join('')}</div>`).join('')
      : `<div class="empty"><div class="big">🔍</div>لا توجد كتب مطابقة.</div>`}
    ${custom.length ? `<div class="section-title" style="margin-top:26px">📎 مصادر ومرفقات إضافية</div><div class="lib-grid">${custom.map(libCard).join('')}</div>` : ''}`;
  $$('[data-mode]').forEach(b => b.onclick = () => { Store.lset('book-mode', b.dataset.mode); PAGES.library(); });
  wireGradeChips('library', PAGES.library);
  $$('[data-sem]').forEach(c => c.onclick = () => { Store.lset('lib-sem', c.dataset.sem); PAGES.library(); });
  $$('[data-sub]').forEach(c => c.onclick = () => { Store.lset('lib-sub', c.dataset.sub); PAGES.library(); });
  $$('[data-bopen]').forEach(b => b.onclick = () => openBookReader(OFFICIAL_BOOKS[+b.dataset.bopen]));
  $$('[data-libopen]').forEach(b => b.onclick = () => libDetail(b.dataset.libopen));
  const sIn = $('#lib-search');
  let st; sIn.oninput = () => { clearTimeout(st); st = setTimeout(() => { const p = sIn.selectionStart; Store.lset('lib-q', sIn.value); PAGES.library(); const n = $('#lib-search'); if (n) { n.focus(); n.setSelectionRange(p, p); } }, 300); };
  const add = $('#add-book'); if (add) add.onclick = addBookModal;
  const cfg = $('#lib-cfg'); if (cfg) cfg.onclick = pdfBaseModal;
};
function officialCard(b) {
  const gi = OFFICIAL_BOOKS.indexOf(b);
  const c = ['#0e7c66', '#2563eb', '#7c3aed', '#e11d64', '#d97706', '#0891b2', '#16a34a', '#be123c'][Math.abs(hashStr(b.sub)) % 8];
  const badges = (b.link ? '<span class="ext" style="inset-inline-end:8px;inset-inline-start:auto">تفاعلي</span>' : '') + (b.file ? '<span class="ext">PDF</span>' : '');
  return `<div class="book-card" data-bopen="${gi}" style="cursor:pointer">
    <div class="book-cover" style="background:linear-gradient(135deg,${c},${c}bb)">
      <div>${subjIcon(b.sub)}<br>${esc(b.sub)}</div>${badges}</div>
    <div class="bc-body">
      <div class="bc-title">${esc(b.title.replace(/^[^—]+—\s*/, '') || b.sub)}</div>
      <div class="bc-meta">${esc(gradeName(b.g))}${b.sem ? ' · الفصل ' + num(b.sem) : ''}</div>
    </div>
    <div class="bc-actions"><button class="btn sm primary" style="flex:1">📖 قراءة</button></div></div>`;
}
function pdfBaseModal() {
  const body = `<p class="muted">لتشغيل خيار «PDF» يجب رفع مجلد المكتبة إلى الخادم، ثم تحديد مساره هنا (نسبي مثل <code>library/</code> أو رابط كامل لخادم/تخزين خارجي).</p>
    <div class="field"><label>مسار ملفات PDF (Base URL)</label><input id="pb" value="${esc(Store.get('libPdfBase', 'library/'))}" placeholder="library/"></div>
    <p class="muted" style="font-size:.78rem">مثال المسار الكامل لكتاب: <code>&lt;base&gt;/1. الصف الاول/1.1 .../اسم الملف.pdf</code>. الكتب التفاعلية (الروابط) تعمل دائمًا دون هذا الإعداد.</p>`;
  const m = modal('إعداد مسار ملفات PDF', body, `<button class="btn primary" id="pb-save">حفظ</button>`);
  $('#pb-save', m.el).onclick = () => { Store.set('libPdfBase', $('#pb', m.el).value.trim()); m.close(); toast('تم الحفظ', 'ok'); PAGES.library(); };
}
function libCard(i) {
  const isUpload = i.kind === 'file';
  return `<div class="book-card">
    <div class="book-cover" style="background:linear-gradient(135deg,${i.cover || '#0e7c66'},${i.cover2 || '#12a37d'})">
      ${esc(i.title)}${i.ext ? `<span class="ext">${esc(i.ext)}</span>` : ''}</div>
    <div class="bc-body">
      <div class="bc-title">${esc(i.title)}</div>
      <div class="bc-meta">${esc(i.author || '—')} · ${esc(i.subject || 'عام')}</div>
    </div>
    <div class="bc-actions">
      <button class="btn sm primary" data-libopen="${esc(i.id)}" style="flex:1">فتح</button>
      ${isUpload ? `<a class="btn sm" href="${fileUrl(i.blobKey, i.title, true)}" download>⬇</a>` : ''}
    </div></div>`;
}
function libDetail(id) {
  const i = library().find(x => x.id === id); if (!i) return;
  const isUpload = i.kind === 'file';
  const openUrl = isUpload ? fileUrl(i.blobKey, i.title) : i.url;
  const isImg = isUpload && /^(PNG|JPG|JPEG|WEBP|GIF)$/i.test(i.ext || '');
  const isPdf = isUpload && /^PDF$/i.test(i.ext || '');
  // inline preview pane: PDFs via typed /api/file URL in an iframe, images directly
  const preview = isImg ? `<img id="lib-preview" src="${esc(openUrl)}" style="width:100%;max-height:58vh;object-fit:contain;border-radius:12px;background:#f3f6f5">`
    : isPdf ? `<iframe id="lib-preview" src="${esc(openUrl)}" style="width:100%;height:58vh;border:1px solid var(--line);border-radius:12px;background:#f3f6f5" title="معاينة"></iframe>
       <p class="muted" style="font-size:.78rem;margin:6px 0 0">إن لم تظهر المعاينة على هاتفك، استخدم زر «فتح في نافذة جديدة».</p>`
    : '';
  const body = `
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <div class="book-cover" style="width:110px;height:140px;border-radius:12px;background:linear-gradient(135deg,${i.cover || '#0e7c66'},${i.cover2 || '#12a37d'})">${esc(i.title)}</div>
      <div style="flex:1;min-width:200px">
        <p style="margin:.2em 0"><b>المؤلف/المصدر:</b> ${esc(i.author || '—')}</p>
        <p style="margin:.2em 0"><b>المادة:</b> ${esc(i.subject || 'عام')}</p>
        <p style="margin:.2em 0"><b>المرحلة:</b> ${i.grade ? gradeName(i.grade) : 'عام'}</p>
        <p class="muted" style="margin:.2em 0">${esc(i.desc || '')}</p>
      </div>
    </div>
    ${preview ? `<div style="margin-top:14px">${preview}</div>` : ''}`;
  const foot = `
    ${preview ? `<button class="btn" id="lib-fs">⛶ ملء الشاشة</button>` : ''}
    <a class="btn primary" href="${esc(openUrl)}" target="_blank" rel="noopener">↗ فتح في نافذة جديدة</a>
    ${isUpload ? `<a class="btn" href="${fileUrl(i.blobKey, i.title, true)}" download>⬇ تنزيل</a>` : ''}
    ${Auth.canDelete ? `<button class="btn danger" id="lib-del">🗑 حذف</button>` : ''}`;
  const m = modal(i.title, body, foot, {wide: true});
  const lfs = $('#lib-fs', m.el);
  if (lfs) lfs.onclick = () => { const p = $('#lib-preview', m.el); if (p && p.requestFullscreen) p.requestFullscreen(); };
  const del = $('#lib-del', m.el);
  if (del) del.onclick = () => armed(del, () => { removeContent('library', id, DATA.library); m.close(); toast('تم الحذف', 'ok'); PAGES.library(); });
};
function addBookModal() {
  const body = `
    <div class="field"><label>العنوان</label><input id="b-title" placeholder="مثال: قصص القراءة"></div>
    <div class="field"><label>المؤلف / المصدر</label><input id="b-author" placeholder="وزارة التربية والتعليم"></div>
    <div class="row" style="gap:10px">
      <div class="field" style="flex:1"><label>المادة</label><input id="b-subject" placeholder="اللغة العربية"></div>
      <div class="field" style="flex:1"><label>المرحلة</label><select id="b-grade">${DATA.levels.map(l => `<option value="${l.grade}">${esc(l.name)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>الوصف</label><textarea id="b-desc" rows="2"></textarea></div>
    <div class="chip-row"><button class="tab-chip active" data-kind="link">🔗 رابط خارجي</button><button class="tab-chip" data-kind="file">📎 رفع ملف (PDF/صورة)</button></div>
    <div class="field" id="b-link-f"><label>الرابط</label><input id="b-url" placeholder="https://..."></div>
    <div class="field" id="b-file-f" hidden><label>الملف</label><input id="b-file" type="file" accept=".pdf,image/*"></div>`;
  const foot = `<button class="btn primary" id="b-save">حفظ</button>`;
  const m = modal('إضافة مصدر للمكتبة', body, foot);
  let kind = 'link';
  $$('[data-kind]', m.el).forEach(c => c.onclick = () => {
    kind = c.dataset.kind; $$('[data-kind]', m.el).forEach(x => x.classList.toggle('active', x === c));
    $('#b-link-f', m.el).hidden = kind !== 'link'; $('#b-file-f', m.el).hidden = kind !== 'file';
  });
  const bSave = $('#b-save', m.el);
  bSave.onclick = async () => {
    const title = $('#b-title', m.el).value.trim(); if (!title) return toast('أدخل العنوان', 'err');
    const item = {id: uid(), title, author: $('#b-author', m.el).value.trim(), subject: $('#b-subject', m.el).value.trim() || 'عام',
      grade: +$('#b-grade', m.el).value, desc: $('#b-desc', m.el).value.trim(), cover: '#0e7c66'};
    if (kind === 'link') { item.kind = 'link'; item.url = $('#b-url', m.el).value.trim(); if (!item.url) return toast('أدخل الرابط', 'err'); }
    else {
      const f = $('#b-file', m.el).files[0]; if (!f) return toast('اختر ملفًا', 'err');
      if (!checkUploadSize(f, false)) return;
      bSave.disabled = true; bSave.textContent = '… يقرأ الملف';
      let dataUrl; try { dataUrl = await fileToDataURL(f); } catch (e) { bSave.disabled = false; bSave.textContent = 'حفظ'; return toast('تعذّرت قراءة الملف.', 'err'); }
      const key = 'lib-' + item.id;
      try { await uploadBlob(key, dataUrl, p => { bSave.textContent = 'جارٍ الرفع… ' + num(p) + '%'; }); }
      catch (e) { bSave.disabled = false; bSave.textContent = 'حفظ'; return toast('تعذّر الرفع — تأكّد من الاتصال وحجم الملف.', 'err'); }
      item.kind = 'file'; item.blobKey = key; item.ext = (f.name.split('.').pop() || '').toUpperCase();
    }
    const c = Store.get('library', []); c.push(item); Store.set('library', c);
    m.close(); toast('تمت الإضافة', 'ok'); PAGES.library();
    libDetail(item.id);                            // show the uploaded item immediately
  };
}

/* ---- Lessons ---- */
PAGES.lessons = function () {
  crumb('الحصص', 'الدروس والمواد التعليمية');
  const visible = forMe(lessons()).sort((a, b) => (Number(a.grade) || 0) - (Number(b.grade) || 0));
  const items = applyGradeFilter('lessons', visible);
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🎬 الحصص</h2><p>فيديو، صوت، ومستندات (PDF/Word/PowerPoint) — مصنّفة حسب الصف.</p></div>
      ${Auth.canManage ? `<button class="btn primary" id="add-lesson">➕ إضافة حصة</button>` : ''}</div>
    ${noClassBanner()}
    ${gradeFilterRow('lessons', visible)}
    <div class="lesson-grid">${items.map(lessonCard).join('') || `<div class="empty"><div class="big">🎬</div>لا توجد حصص في هذا الصف بعد.</div>`}</div>`;
  wireGradeChips('lessons', PAGES.lessons);
  $$('[data-lesson]').forEach(c => c.onclick = () => openLesson(c.dataset.lesson));
  // NOTE: never pass the click event into addLessonModal — it would be mistaken
  // for an existing lesson and the new lesson would be saved without an id.
  const add = $('#add-lesson'); if (add) add.onclick = () => addLessonModal();
};
const lessonKind = l => l.type === 'audio' ? {icon: '🎧', label: 'صوت', bg: 'linear-gradient(135deg,#7c3aed,#a855f7)'}
  : l.type === 'doc' ? {icon: '📄', label: l.ext || 'مستند', bg: 'linear-gradient(135deg,#0891b2,#2563eb)'}
  : {icon: '▶', label: 'فيديو', bg: ''};
function lessonCard(l) {
  const k = lessonKind(l);
  return `<div class="lesson-card" data-lesson="${esc(l.id)}" style="cursor:pointer">
    <div class="lesson-thumb" ${k.bg ? `style="background:${k.bg}"` : ''}>
      <span class="badge">${esc(k.label)}</span>
      <div class="play">${k.icon}</div>
      ${l.duration ? `<span class="dur">${esc(l.duration)}</span>` : ''}</div>
    <div class="lc-body"><div class="lc-title">${esc(l.title)}</div>
      <div class="lc-meta">${esc(l.subject || 'عام')} · ${l.grade ? gradeName(l.grade) : 'عام'}</div></div></div>`;
}
function openLesson(id) {
  const l = lessons().find(x => x.id === id); if (!l) return;
  if (!visibleTo(l)) { toast('هذه الحصة لصفٍّ آخر.', 'err'); return; }
  let stage = '';
  const src = l.blobKey ? fileUrl(l.blobKey, l.title) : l.embed;
  const isEmbed = !l.blobKey && l.embed && /youtube|vimeo|drive\.google/.test(l.embed);
  const ext = String(l.ext || '').toUpperCase();
  if (!src) stage = `<div class="media-stage audio" style="text-align:center;color:#fff">
      <div style="font-size:3rem">🎬</div><p>لم يُرفع محتوى لهذه الحصة بعد.</p>
      ${Auth.canManage ? `<button class="btn gold" id="les-upload-cta">⬆ رفع المحتوى الآن</button>` : `<p class="muted" style="color:#cfe9e2;font-size:.8rem">سيضيف المعلّم المحتوى قريبًا.</p>`}</div>`;
  else if (l.type === 'audio') stage = `<div class="media-stage audio"><div style="text-align:center;color:#fff;margin-bottom:12px;font-size:2.4rem">🎧</div><audio id="les-media" src="${esc(src)}" controls style="width:100%"></audio></div>`;
  else if (isEmbed) stage = `<div class="media-stage"><iframe id="les-media" src="${esc(embedUrl(l.embed))}" style="height:52vh" allowfullscreen frameborder="0"></iframe></div>`;
  else if (l.type === 'doc') {
    if (/^(PNG|JPG|JPEG|WEBP|GIF)$/.test(ext))
      stage = `<img id="les-media" src="${esc(src)}" style="width:100%;max-height:58vh;object-fit:contain;border-radius:12px;background:#f3f6f5">`;
    else if (ext === 'PDF')
      stage = `<iframe id="les-media" src="${esc(src)}" style="width:100%;height:58vh;border:1px solid var(--line);border-radius:12px;background:#f3f6f5"></iframe>`;
    else if (/^(DOC|DOCX|PPT|PPTX|XLS|XLSX)$/.test(ext)) {
      // Office viewer renders Word/Excel and gives PowerPoint slide navigation;
      // it needs the server to be publicly reachable (works on the live host)
      const abs = location.origin + src;
      stage = `<iframe id="les-media" src="https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(abs)}" style="width:100%;height:58vh;border:1px solid var(--line);border-radius:12px;background:#f3f6f5" allowfullscreen></iframe>
        <p class="muted" style="font-size:.76rem;margin:6px 0 0">${ext.indexOf('PPT') === 0 ? 'عرض الشرائح بأزرار التنقل داخل الإطار. ' : ''}العارض يعمل على الموقع المنشور؛ إن لم يظهر الملف استخدم زر التنزيل.</p>`;
    } else stage = `<div class="media-stage audio" style="text-align:center;color:#fff"><div style="font-size:3rem">📄</div><p>ملف ${esc(ext || 'مستند')} — نزّله لعرضه.</p></div>`;
  }
  else stage = `<div class="media-stage"><video id="les-media" src="${esc(src)}" controls playsinline preload="metadata" style="max-height:58vh"></video></div>`;
  const typePill = l.type === 'audio' ? '🎧 صوت' : l.type === 'doc' ? '📄 ' + (ext || 'مستند') : '🎬 فيديو';
  const body = `${stage}
    <div style="margin-top:14px"><p>${esc(l.desc || '')}</p>
    <div class="row"><span class="pill teal">${esc(l.subject || 'عام')}</span>${l.grade ? `<span class="pill">${gradeName(l.grade)}</span>` : ''}<span class="pill">${typePill}</span></div></div>`;
  const foot = `${(src && l.type !== 'audio') ? `<button class="btn" id="les-fs">⛶ ملء الشاشة</button>` : ''}
    ${l.blobKey ? `<a class="btn" href="${fileUrl(l.blobKey, l.title, true)}" download>⬇ تنزيل</a>` : ''}
    ${Auth.canManage ? `<button class="btn" id="les-replace">🔁 ${src ? 'استبدال المحتوى' : 'رفع المحتوى'}</button>` : ''}
    ${Auth.canDelete ? `<button class="btn danger" id="les-del">🗑 حذف الحصة</button>` : ''}`;
  const m = modal(l.title, body, foot, {wide: true});
  const fs = $('#les-fs', m.el);
  if (fs) fs.onclick = () => { const v = $('#les-media', m.el); if (v && v.requestFullscreen) v.requestFullscreen(); else if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); };
  const cta = $('#les-upload-cta', m.el); if (cta) cta.onclick = () => { m.close(); addLessonModal(l); };
  const rep = $('#les-replace', m.el); if (rep) rep.onclick = () => { m.close(); addLessonModal(l); };
  const del = $('#les-del', m.el);
  if (del) del.onclick = () => armed(del, () => {
    removeContent('lessons', id, DATA.lessons); m.close(); toast('تم الحذف', 'ok'); PAGES.lessons();
  });
}
function embedUrl(u) {
  const yt = u.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/)([\w-]{11})/); if (yt) return 'https://www.youtube.com/embed/' + yt[1];
  const dr = u.match(/drive\.google\.com\/file\/d\/([^/]+)/); if (dr) return 'https://drive.google.com/file/d/' + dr[1] + '/preview';
  return u;
}
function addLessonModal(existing) {
  if (existing && !existing.id) existing = null;   // guard: ignore event objects / junk args
  const e = existing || {};
  const body = `
    <div class="field"><label>عنوان الحصة</label><input id="l-title" value="${esc(e.title || '')}"></div>
    <div class="row" style="gap:10px">
      <div class="field" style="flex:1"><label>المادة</label><input id="l-subject" value="${esc(e.subject || '')}"></div>
      <div class="field" style="flex:1"><label>المرحلة</label><select id="l-grade">${DATA.levels.map(l => `<option value="${l.grade}" ${e.grade === l.grade ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>الوصف</label><textarea id="l-desc" rows="2">${esc(e.desc || '')}</textarea></div>
    <div class="chip-row"><button class="tab-chip ${(e.type || 'video') === 'video' ? 'active' : ''}" data-t="video">🎬 فيديو</button><button class="tab-chip ${e.type === 'audio' ? 'active' : ''}" data-t="audio">🎧 صوت</button><button class="tab-chip ${e.type === 'doc' ? 'active' : ''}" data-t="doc">📄 مستند / عرض</button></div>
    <div class="chip-row" id="l-src-row"><button class="tab-chip active" data-s="file">📎 رفع ملف</button><button class="tab-chip" data-s="embed">🔗 رابط (YouTube/Drive)</button></div>
    <div class="field" id="l-file-f"><label>الملف</label><input id="l-file" type="file" accept="video/*">
      <p class="muted" id="l-accept-hint" style="font-size:.72rem;margin:4px 0 0"></p></div>
    <div class="field" id="l-embed-f" hidden><label>الرابط</label><input id="l-embed" value="${esc(e.embed || '')}" placeholder="https://youtube.com/..."></div>`;
  const foot = `<button class="btn primary" id="l-save">${existing ? 'تحديث' : 'حفظ الحصة'}</button>`;
  const m = modal(existing ? 'استبدال / تعديل الحصة' : 'إضافة حصة', body, foot);
  let type = e.type || 'video', srcKind = 'file';
  const ACCEPT = {video: 'video/*', audio: 'audio/*', doc: '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.webp'};
  const HINT = {video: 'ملفات فيديو (MP4, WebM…) — الكبيرة يفضَّل رفعها كرابط YouTube/Drive', audio: 'ملفات صوت (MP3, WAV, M4A…)', doc: 'PDF · Word · PowerPoint · Excel · صور'};
  const applyType = () => {
    $('#l-file', m.el).setAttribute('accept', ACCEPT[type]);
    $('#l-accept-hint', m.el).textContent = HINT[type];
    const docMode = type === 'doc';
    $('#l-src-row', m.el).hidden = docMode;                     // documents are always file uploads
    if (docMode) { srcKind = 'file'; $('#l-file-f', m.el).hidden = false; $('#l-embed-f', m.el).hidden = true; }
  };
  $$('[data-t]', m.el).forEach(b => b.onclick = () => { type = b.dataset.t; $$('[data-t]', m.el).forEach(x => x.classList.toggle('active', x === b)); applyType(); });
  $$('[data-s]', m.el).forEach(b => b.onclick = () => { srcKind = b.dataset.s; $$('[data-s]', m.el).forEach(x => x.classList.toggle('active', x === b)); $('#l-file-f', m.el).hidden = srcKind !== 'file'; $('#l-embed-f', m.el).hidden = srcKind !== 'embed'; });
  applyType();
  const saveBtn = $('#l-save', m.el);
  saveBtn.onclick = async () => {
    const title = $('#l-title', m.el).value.trim(); if (!title) return toast('أدخل العنوان', 'err');
    const item = existing ? Object.assign({}, existing) : {id: uid()};
    if (!item.id) item.id = uid();
    item.title = title; item.subject = $('#l-subject', m.el).value.trim(); item.grade = +$('#l-grade', m.el).value;
    item.desc = $('#l-desc', m.el).value.trim(); item.type = type;
    if (srcKind === 'embed') { item.embed = $('#l-embed', m.el).value.trim(); item.blobKey = ''; if (!item.embed) return toast('أدخل الرابط', 'err'); }
    else {
      const f = $('#l-file', m.el).files[0];
      if (!f && !existing) return toast('اختر ملفًا', 'err');
      if (f) {
        if (!checkUploadSize(f, true)) return;
        saveBtn.disabled = true;
        const label = t => { saveBtn.textContent = t; };
        label('… يقرأ الملف');
        let dataUrl; try { dataUrl = await fileToDataURL(f); } catch (er) { saveBtn.disabled = false; label(existing ? 'تحديث' : 'حفظ الحصة'); return toast('تعذّرت قراءة الملف.', 'err'); }
        const key = 'les-' + item.id;
        try { await uploadBlob(key, dataUrl, p => label('جارٍ الرفع… ' + num(p) + '%')); }
        catch (er) { saveBtn.disabled = false; label(existing ? 'تحديث' : 'حفظ الحصة'); return toast('تعذّر الرفع — للفيديوهات الكبيرة استخدم رابط YouTube/Drive.', 'err'); }
        item.blobKey = key; item.embed = '';
        item.ext = (f.name.split('.').pop() || '').toUpperCase(); item.mime = f.type || '';
      }
    }
    const c = Store.get('lessons', []);
    const idx = c.findIndex(x => x.id === item.id);
    if (idx >= 0) c[idx] = item; else c.push(item);
    Store.set('lessons', c);
    m.close();                                     // close the entry form…
    toast(existing ? 'تم التحديث' : 'تمت الإضافة', 'ok');
    PAGES.lessons();
    openLesson(item.id);                           // …and show the media immediately
  };
}

/* ---- Exercises ---- */
PAGES.exercises = function () {
  crumb('التمارين', 'رفع المهارات');
  const visible = forMe(DATA.exercises);
  const items = applyGradeFilter('exercises', visible);
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>✏️ التمارين</h2><p>تدرّب على المهارات الأساسية — مصنّفة حسب الصف.</p></div></div>
    ${noClassBanner()}
    ${gradeFilterRow('exercises', visible)}
    <div class="lesson-grid">${items.map(x => `
      <div class="card" style="cursor:pointer" data-ex="${esc(x.id)}">
        <div style="font-size:2rem">${x.kind.indexOf('math') === 0 ? '➗' : '🔤'}</div>
        <h3 style="margin:.3em 0 .1em;color:var(--teal-ink)">${esc(x.title)}</h3>
        <p class="muted" style="margin:0;font-size:.85rem">${esc(x.desc)}</p>
        <div class="row" style="margin-top:8px"><span class="pill teal">${esc(x.subject)}</span><span class="pill">${gradeName(x.grade)}</span><span class="pill gold">${esc(x.skill)}</span></div>
      </div>`).join('') || `<div class="empty"><div class="big">✏️</div>لا توجد تمارين في هذا الصف بعد.</div>`}</div>`;
  wireGradeChips('exercises', PAGES.exercises);
  $$('[data-ex]').forEach(c => c.onclick = () => startDrill(c.dataset.ex));
};
function startDrill(id) {
  const ex = DATA.exercises.find(x => x.id === id); if (!ex) return;
  if (ex.kind === 'order') return orderDrill(ex);
  mathDrill(ex);
}
function mathDrill(ex) {
  let streak = 0, done = 0, correct = 0; const total = 10;
  const gen = () => { const a = 1 + Math.floor(Math.random() * (ex.grade > 1 ? 20 : 9)); const b = 1 + Math.floor(Math.random() * (ex.grade > 1 ? 20 : 9));
    if (ex.kind === 'math-sub') { const x = Math.max(a, b), y = Math.min(a, b); return {a: x, b: y, op: '−', ans: x - y}; } return {a, b, op: '+', ans: a + b}; };
  let cur = gen();
  const render = () => {
    const body = `<div class="drill">
      <div class="row" style="justify-content:center;gap:16px"><span class="streak">🔥 ${num(streak)}</span><span class="muted">${num(done)}/${num(total)}</span></div>
      <div class="drill-q" dir="${numDir()}">${num(cur.a)} ${cur.op} ${num(cur.b)} = ?</div>
      <input class="drill-input" id="d-ans" type="number" inputmode="numeric" dir="${numDir()}" autofocus>
      <div style="margin-top:16px"><button class="btn primary" id="d-check">تحقّق</button></div>
      <p id="d-fb" style="height:26px;margin-top:10px;font-weight:700"></p></div>`;
    const m = modal(ex.title, body, '', {sticky: false});
    const input = $('#d-ans', m.el); input.focus();
    const check = () => {
      const v = Number(input.value); if (input.value === '') return;
      done++;
      const fb = $('#d-fb', m.el);
      if (v === cur.ans) { correct++; streak++; fb.textContent = '✅ أحسنت!'; fb.style.color = 'var(--green)'; }
      else { streak = 0; fb.textContent = '❌ الصواب: ' + num(cur.ans); fb.style.color = 'var(--danger)'; }
      setTimeout(() => {
        if (done >= total) { m.close(); drillDone(ex, correct, total); return; }
        cur = gen(); m.close(); render();
      }, 700);
    };
    $('#d-check', m.el).onclick = check;
    input.onkeydown = e => { if (e.key === 'Enter') check(); };
  };
  render();
}
function orderDrill(ex) {
  let idx = 0, correct = 0;
  const render = () => {
    const it = ex.items[idx];
    const pool = it.scrambled.slice();
    const body = `<div class="drill">
      <p class="muted">${num(idx + 1)}/${num(ex.items.length)}</p>
      <h3>رتّب الحروف لتكوين كلمة صحيحة</h3>
      <div class="scramble" id="d-built" style="min-height:60px;border-bottom:2px dashed var(--line)"></div>
      <div class="scramble" id="d-pool">${pool.map((c, i) => `<button class="tile" data-i="${i}">${esc(c)}</button>`).join('')}</div>
      <div style="margin-top:14px"><button class="btn" id="d-clear">مسح</button> <button class="btn primary" id="d-check">تحقّق</button></div>
      <p id="d-fb" style="height:26px;margin-top:8px;font-weight:700"></p></div>`;
    const m = modal(ex.title, body, '');
    let built = [];
    const refresh = () => { $('#d-built', m.el).innerHTML = built.map(c => `<span class="tile" style="background:linear-gradient(135deg,var(--teal),var(--teal-2));color:#fff">${esc(c)}</span>`).join(''); };
    $$('#d-pool .tile', m.el).forEach(t => t.onclick = () => { built.push(t.textContent); t.disabled = true; t.style.opacity = '.3'; refresh(); });
    $('#d-clear', m.el).onclick = () => { built = []; refresh(); $$('#d-pool .tile', m.el).forEach(t => { t.disabled = false; t.style.opacity = '1'; }); };
    $('#d-check', m.el).onclick = () => {
      const fb = $('#d-fb', m.el);
      if (built.join('') === it.answer) { correct++; fb.textContent = '✅ ممتاز!'; fb.style.color = 'var(--green)'; }
      else { fb.textContent = '❌ الصواب: ' + it.answer; fb.style.color = 'var(--danger)'; }
      setTimeout(() => { idx++; m.close(); if (idx >= ex.items.length) drillDone(ex, correct, ex.items.length); else render(); }, 900);
    };
  };
  render();
}
function drillDone(ex, correct, total) {
  const pct = Math.round(correct / total * 100);
  addResult({user: Auth.user.u, userName: Auth.user.name, title: 'تمرين: ' + ex.title, score: correct, total, date: Date.now(), kind: 'exercise'});
  modal('انتهى التمرين', `<div style="text-align:center">
    <div style="font-size:3.4rem">${pct >= 80 ? '🏆' : pct >= 50 ? '👍' : '💪'}</div>
    <h2 style="color:var(--teal-ink)">${num(correct)} / ${num(total)}</h2>
    <p class="muted">نسبة النجاح ${num(pct)}%</p></div>`, `<button class="btn primary" onclick="this.closest('.modal-back').remove()">تم</button>`);
}

/* ---- Tests ---- */
PAGES.tests = function () {
  crumb('الاختبارات', 'اختبارات تفاعلية');
  const visible = forMe(tests());
  const items = applyGradeFilter('tests', visible);
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>📝 الاختبارات</h2><p>اختبارات تفاعلية مصنّفة حسب الصف — تُجاب وتُصحّح فورًا مع تقرير مفصّل.</p></div>
      ${Auth.canManage ? `<button class="btn primary" id="add-test">➕ إنشاء اختبار</button>` : ''}</div>
    ${noClassBanner()}
    ${gradeFilterRow('tests', visible)}
    <div class="grid g-3">${items.map(t => `
      <div class="card" style="cursor:pointer" data-test="${esc(t.id)}">
        <div style="font-size:2rem">🧠</div>
        <h3 style="margin:.3em 0 .1em;color:var(--teal-ink)">${esc(t.title)}</h3>
        <div class="row" style="margin:8px 0"><span class="pill teal">${esc(t.subject)}</span><span class="pill">${gradeName(t.grade)}</span></div>
        <p class="muted" style="margin:0;font-size:.85rem">${num(t.questions.length)} سؤال · ${num(t.minutes || 10)} دقائق</p>
      </div>`).join('') || `<div class="empty"><div class="big">📝</div>لا توجد اختبارات في هذا الصف بعد.</div>`}</div>`;
  wireGradeChips('tests', PAGES.tests);
  $$('[data-test]').forEach(c => c.onclick = () => runTest(c.dataset.test));
  const add = $('#add-test'); if (add) add.onclick = addTestModal;
};
function runTest(id) {
  const t = tests().find(x => x.id === id); if (!t) return;
  const answers = new Array(t.questions.length).fill(-1);
  let remaining = (t.minutes || 10) * 60; let timer;
  const render = () => {
    $('#view').innerHTML = `
      <div class="page-head"><div><h2>📝 ${esc(t.title)}</h2><p>${esc(t.subject)} · ${gradeName(t.grade)}</p></div>
        <div class="card" style="padding:.5em 1em"><span class="quiz-timer" id="qt"></span></div></div>
      <div class="quiz">
        ${t.questions.map((q, qi) => `<div class="q-card"><div class="q-num">السؤال ${num(qi + 1)} من ${num(t.questions.length)}</div>
          <div class="q-text">${esc(q.q)}</div>
          ${q.choices.map((c, ci) => `<div class="choice" data-q="${qi}" data-c="${ci}"><div class="mk">${'أبجد'[ci] || (ci + 1)}</div><div>${esc(c)}</div></div>`).join('')}</div>`).join('')}
        <div class="row" style="justify-content:center;margin:10px 0 30px">
          <button class="btn" id="q-cancel">إلغاء</button>
          <button class="btn primary" id="q-submit">إنهاء وتصحيح ✓</button></div>
      </div>`;
    $$('.choice').forEach(ch => ch.onclick = () => {
      const qi = +ch.dataset.q, ci = +ch.dataset.c; answers[qi] = ci;
      $$(`.choice[data-q="${qi}"]`).forEach(x => x.classList.remove('sel')); ch.classList.add('sel');
    });
    $('#q-submit').onclick = () => { clearInterval(timer); grade(); };
    $('#q-cancel').onclick = () => { clearInterval(timer); go('tests'); };
  };
  const tick = () => {
    remaining--; const mm = String(Math.floor(remaining / 60)).padStart(2, '0'), ss = String(remaining % 60).padStart(2, '0');
    const qt = $('#qt'); if (qt) { qt.textContent = '⏱ ' + num(mm + ':' + ss); qt.style.color = remaining < 30 ? 'var(--danger)' : ''; }
    if (remaining <= 0) { clearInterval(timer); grade(); }
  };
  const grade = () => {
    let score = 0; t.questions.forEach((q, i) => { if (answers[i] === q.answer) score++; });
    addResult({user: Auth.user.u, userName: Auth.user.name, testId: t.id, title: t.title, subject: t.subject, grade: t.grade, score, total: t.questions.length, date: Date.now(), kind: 'test', answers});
    const pct = Math.round(score / t.questions.length * 100);
    $('#view').innerHTML = `
      <div class="page-head"><div><h2>📋 تقرير الأداء</h2><p>${esc(t.title)}</p></div><a class="btn" href="#/tests">◀ الاختبارات</a></div>
      <div class="grid g-2">
        <div class="card" style="text-align:center">
          ${ringSvg(pct)}
          <h2 style="color:var(--teal-ink);margin-top:8px">${num(score)} / ${num(t.questions.length)}</h2>
          <p class="pill ${pct >= 50 ? 'teal' : ''}" style="${pct >= 50 ? '' : 'background:#fdeaea;color:var(--danger)'}">${pct >= 80 ? 'ممتاز 🏆' : pct >= 50 ? 'جيد 👍' : 'يحتاج مراجعة 💪'}</p>
          <div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" onclick="location.hash='#/tests'">اختبار آخر</button><button class="btn" onclick="location.hash='#/results'">كل النتائج</button></div>
        </div>
        <div class="card"><div class="section-title" style="margin-top:0">مراجعة الإجابات</div>
          ${t.questions.map((q, i) => { const ok = answers[i] === q.answer; return `<div class="review-item ${ok ? 'ok' : 'no'}">
            <div style="font-weight:700">${esc(q.q)}</div>
            <div style="font-size:.85rem">إجابتك: ${answers[i] >= 0 ? esc(q.choices[answers[i]]) : '—'} ${ok ? '✅' : '❌'}</div>
            ${ok ? '' : `<div style="font-size:.85rem;color:var(--green)">الصواب: ${esc(q.choices[q.answer])}</div>`}</div>`; }).join('')}
        </div>
      </div>`;
  };
  render(); timer = setInterval(tick, 1000); tick();
}
function ringSvg(pct) {
  const r = 60, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  const col = pct >= 80 ? '#16a34a' : pct >= 50 ? '#0e7c66' : '#dc2626';
  return `<svg class="result-ring" viewBox="0 0 150 150">
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="#e6efec" stroke-width="14"/>
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 75 75)"/>
    <text x="75" y="82" text-anchor="middle" font-size="30" font-weight="800" fill="${col}">${num(pct)}%</text></svg>`;
}
function addTestModal() {
  const state = {questions: [{q: '', choices: ['', '', '', ''], answer: 0}]};
  const render = () => {
    const body = `
      <div class="field"><label>عنوان الاختبار</label><input id="t-title"></div>
      <div class="row" style="gap:10px">
        <div class="field" style="flex:1"><label>المادة</label><input id="t-subject"></div>
        <div class="field" style="flex:1"><label>المرحلة</label><select id="t-grade">${DATA.levels.map(l => `<option value="${l.grade}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="field" style="width:90px"><label>الدقائق</label><input id="t-min" type="number" value="10"></div>
      </div>
      <div class="section-title" style="margin-top:6px">الأسئلة</div>
      <div id="q-list"></div>
      <button class="btn" id="add-q">➕ سؤال</button>`;
    const foot = `<button class="btn primary" id="t-save">حفظ الاختبار</button>`;
    const m = modal('إنشاء اختبار', body, foot, {wide: true});
    const paint = () => {
      $('#q-list', m.el).innerHTML = state.questions.map((q, qi) => `
        <div class="card" style="margin-bottom:10px;padding:12px">
          <div class="row"><b>سؤال ${qi + 1}</b><div class="spacer"></div>${state.questions.length > 1 ? `<button class="btn sm danger" data-delq="${qi}">حذف</button>` : ''}</div>
          <div class="field"><input data-q="${qi}" value="${esc(q.q)}" placeholder="نص السؤال"></div>
          ${q.choices.map((c, ci) => `<div class="row" style="margin-bottom:6px"><input type="radio" name="ans${qi}" ${q.answer === ci ? 'checked' : ''} data-ans="${qi}" data-ci="${ci}" style="width:auto">
            <input data-c="${qi}" data-ci="${ci}" value="${esc(c)}" placeholder="خيار ${ci + 1}" style="flex:1"></div>`).join('')}
        </div>`).join('');
      $$('[data-q]', m.el).forEach(i => { if (i.tagName === 'INPUT' && i.dataset.c === undefined && i.dataset.ans === undefined) i.oninput = () => state.questions[+i.dataset.q].q = i.value; });
      $$('[data-c]', m.el).forEach(i => i.oninput = () => state.questions[+i.dataset.c].choices[+i.dataset.ci] = i.value);
      $$('[data-ans]', m.el).forEach(i => i.onchange = () => state.questions[+i.dataset.ans].answer = +i.dataset.ci);
      $$('[data-delq]', m.el).forEach(b => b.onclick = () => { state.questions.splice(+b.dataset.delq, 1); paint(); });
    };
    paint();
    $('#add-q', m.el).onclick = () => { state.questions.push({q: '', choices: ['', '', '', ''], answer: 0}); paint(); };
    $('#t-save', m.el).onclick = () => {
      const title = $('#t-title', m.el).value.trim(); if (!title) return toast('أدخل العنوان', 'err');
      const qs = state.questions.filter(q => q.q.trim() && q.choices.filter(c => c.trim()).length >= 2);
      if (!qs.length) return toast('أضف سؤالًا واحدًا صالحًا على الأقل', 'err');
      const item = {id: uid(), title, subject: $('#t-subject', m.el).value.trim() || 'عام', grade: +$('#t-grade', m.el).value, minutes: +$('#t-min', m.el).value || 10, questions: qs};
      const c = Store.get('tests', []); c.push(item); Store.set('tests', c); m.close(); toast('تم إنشاء الاختبار', 'ok'); PAGES.tests();
    };
  };
  render();
}

/* ---- Results ---- */
PAGES.results = function () {
  crumb('النتائج', 'تقارير الأداء');
  const all = results();
  const mine = Auth.isAdmin || Auth.isTeacher ? all : all.filter(r => r.user === Auth.user.u);
  if (!mine.length) { $('#view').innerHTML = `<div class="page-head"><div><h2>📊 النتائج</h2></div></div><div class="empty"><div class="big">📊</div>لا توجد نتائج بعد. ابدأ باختبار أو تمرين!</div>`; return; }
  const bySubject = {};
  mine.forEach(r => { const s = r.subject || 'أخرى'; (bySubject[s] = bySubject[s] || []).push(r.score / r.total * 100); });
  const subjAvg = Object.keys(bySubject).map(s => ({s, v: Math.round(bySubject[s].reduce((a, b) => a + b, 0) / bySubject[s].length)}));
  const overall = Math.round(mine.reduce((a, r) => a + r.score / r.total * 100, 0) / mine.length);
  const maxBar = Math.max(100, ...subjAvg.map(x => x.v));
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>📊 النتائج والإحصاءات</h2><p>${Auth.isAdmin || Auth.isTeacher ? 'أداء جميع الطلبة' : 'أداؤك عبر الاختبارات والتمارين'}</p></div></div>
    <div class="stat-tiles">
      <div class="stat"><div class="k">إجمالي المحاولات</div><div class="v">${num(mine.length)}</div></div>
      <div class="stat g"><div class="k">المتوسط العام</div><div class="v">${num(overall)}%</div></div>
      <div class="stat b"><div class="k">أعلى نتيجة</div><div class="v">${num(Math.max(...mine.map(r => Math.round(r.score / r.total * 100))))}%</div></div>
      <div class="stat p"><div class="k">المواد</div><div class="v">${num(subjAvg.length)}</div></div>
    </div>
    <div class="grid g-2" style="margin-top:18px">
      <div class="card"><div class="section-title" style="margin-top:0">المتوسط حسب المادة</div>
        <div class="bar-chart">${subjAvg.map(x => `<div class="bar" style="height:${x.v / maxBar * 100}%"><span class="val">${num(x.v)}%</span><span class="lbl">${esc(x.s)}</span></div>`).join('')}</div>
        <div style="height:26px"></div></div>
      <div class="card"><div class="section-title" style="margin-top:0">سجلّ المحاولات</div>
        <div style="max-height:300px;overflow:auto"><table class="tbl"><tr>${Auth.isAdmin || Auth.isTeacher ? '<th>الطالب</th>' : ''}<th>النشاط</th><th>النتيجة</th><th>التاريخ</th></tr>
          ${mine.slice().reverse().map(r => `<tr>${Auth.isAdmin || Auth.isTeacher ? `<td>${esc(r.userName || r.user)}</td>` : ''}<td>${esc(r.title)}</td><td><b>${num(r.score)}/${num(r.total)}</b> (${num(Math.round(r.score / r.total * 100))}%)</td><td class="muted">${num(arDate(r.date))}</td></tr>`).join('')}</table></div></div>
    </div>`;
};

/* ---- Assistant ---- */
PAGES.assistant = function () {
  crumb('المساعد', 'البحث وحل المسائل');
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🤖 المساعد الذكي</h2><p>ابحث في المصادر واحصل على إجابات مع ذكر المصدر، أو حلّ مسائل الرياضيات.</p></div></div>
    <div class="chip-row"><button class="tab-chip active" data-panel="search">🔎 البحث والمساعدة</button><button class="tab-chip" data-panel="math">➗ حل المسائل</button></div>
    <div id="assist-panel"></div>`;
  $$('[data-panel]').forEach(b => b.onclick = () => { $$('[data-panel]').forEach(x => x.classList.toggle('active', x === b)); b.dataset.panel === 'math' ? mathPanel() : searchPanel(); });
  searchPanel();
};
function localSearch(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const hits = [];
  DATA.levels.forEach(l => { [1, 2].forEach(sem => l.books[sem].forEach(b => { if ((b.subject + ' ' + l.name).toLowerCase().includes(q)) hits.push({t: b.subject + ' — ' + l.name, m: 'كتاب رسمي · الفصل ' + sem, url: b.source, src: 'المناهج'}); })); });
  library().forEach(i => { if ((i.title + ' ' + (i.subject || '') + ' ' + (i.desc || '')).toLowerCase().includes(q)) hits.push({t: i.title, m: (i.author || '') + ' · ' + (i.subject || ''), url: i.kind === 'file' ? fileUrl(i.blobKey, i.title) : i.url, src: 'المكتبة'}); });
  lessons().forEach(l => { if ((l.title + ' ' + (l.subject || '')).toLowerCase().includes(q)) hits.push({t: l.title, m: (l.subject || '') + ' · حصة', url: '#/lessons', src: 'الحصص'}); });
  DATA.official.forEach(o => { if ((o.name + ' ' + o.note).toLowerCase().includes(q)) hits.push({t: o.name, m: o.note, url: o.url, src: 'مصدر رسمي'}); });
  return hits.slice(0, 30);
}
function searchPanel() {
  const p = $('#assist-panel');
  p.innerHTML = `
    <div class="assist-wrap">
      <div class="card">
        <div class="section-title" style="margin-top:0">🔎 بحث في مصادر OLS</div>
        <div class="row"><input id="s-q" placeholder="اكتب موضوعًا: العلوم، الحروف، الكسور…" style="flex:1;padding:.6em .8em;border:1px solid var(--line);border-radius:12px"><button class="btn primary" id="s-go">بحث</button></div>
        <div id="s-res" style="margin-top:12px"></div>
      </div>
      <div class="card chat">
        <div class="section-title" style="margin-top:0">💬 اسأل المساعد</div>
        <div class="chat-log" id="chat-log"><div class="msg ai">مرحبًا! اسألني عن أي موضوع في المنهج وسأجيبك مع ذكر المصدر عند توفره. ✏️</div></div>
        <div class="chat-input"><textarea id="chat-in" placeholder="اكتب سؤالك…"></textarea><button class="btn primary" id="chat-send">إرسال</button></div>
        <p class="muted" id="ai-note" style="font-size:.75rem;margin:6px 0 0"></p>
      </div>
    </div>`;
  const runSearch = () => {
    const q = $('#s-q').value; const hits = localSearch(q);
    $('#s-res').innerHTML = hits.length ? hits.map(h => `<a class="sr-item" href="${esc(h.url)}" ${h.url.indexOf('#') === 0 ? '' : 'target="_blank" rel="noopener"'} style="display:block;border-bottom:1px solid var(--line)">
      <div class="t">${esc(h.t)}</div><div class="m">${esc(h.m)} · <b style="color:var(--teal)">${esc(h.src)}</b></div></a>`).join('')
      : `<div class="empty" style="padding:20px"><div class="big">🔍</div>لا نتائج. جرّب كلمة أخرى.</div>`;
  };
  $('#s-go').onclick = runSearch; $('#s-q').onkeydown = e => { if (e.key === 'Enter') runSearch(); };
  wireChat();
}
async function wireChat() {
  const note = $('#ai-note');
  let aiOn = false;
  try { const cfg = await api('/api/config'); aiOn = cfg.ai; } catch (e) {}
  note.textContent = aiOn ? 'المساعد الذكي مُفعّل — مدعوم بالذكاء الاصطناعي.' : 'المساعد الذكي غير مُفعّل على الخادم — يعمل البحث المحلي فقط. (اضبط OLS_ANTHROPIC_KEY لتفعيله)';
  const log = $('#chat-log'); const history = [];
  const add = (who, text) => { const d = document.createElement('div'); d.className = 'msg ' + who; d.innerHTML = esc(text).replace(/\n/g, '<br>'); log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  const send = async () => {
    const inp = $('#chat-in'); const q = inp.value.trim(); if (!q) return; inp.value = '';
    add('me', q); history.push({role: 'user', content: q});
    const hits = localSearch(q);
    if (!aiOn) {
      let r = 'إليك ما وجدته في مصادر OLS:\n';
      if (hits.length) hits.slice(0, 5).forEach(h => r += '• ' + h.t + ' (' + h.src + ')\n'); else r += 'لم أجد نتائج مباشرة. جرّب صياغة أخرى، أو تصفّح المناهج.';
      add('ai', r); return;
    }
    const thinking = add('ai', '… يفكّر');
    try {
      const ctx = hits.slice(0, 6).map(h => '- ' + h.t + ' (' + h.src + '): ' + h.url).join('\n');
      const sys = 'أنت مساعد تعليمي عُماني للمنهج الدراسي (روضة–صف 12). أجب بالعربية الفصحى المبسّطة والمناسبة لعمر الطالب. اعتمد على المصادر التالية عند توفرها واذكرها في نهاية إجابتك:\n' + (ctx || '(لا مصادر محلية مطابقة)');
      const r = await api('/api/assist', 'POST', {messages: history, system: sys});
      thinking.remove();
      if (r.ok) { add('ai', r.text); history.push({role: 'assistant', content: r.text}); }
      else add('ai', r.error || 'تعذّر الحصول على إجابة.');
    } catch (e) { thinking.remove(); add('ai', 'حدث خطأ في الاتصال بالمساعد.'); }
  };
  $('#chat-send').onclick = send;
  $('#chat-in').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
}
function mathPanel() {
  const p = $('#assist-panel');
  p.innerHTML = `
    <div class="assist-wrap">
      <div class="card">
        <div class="section-title" style="margin-top:0">➗ حل مسألة رياضية</div>
        <div class="field"><label>اكتب المسألة أو المعادلة</label><textarea id="m-q" rows="3" placeholder="مثال: 12 × 8 =  أو  حل: 2س + 3 = 11"></textarea></div>
        <div class="drop" id="m-drop">📷 أو أفلت صورة المسألة هنا / اضغط للاختيار<input id="m-img" type="file" accept="image/*" hidden></div>
        <img id="m-prev" style="max-height:160px;margin-top:10px;border-radius:10px;display:none">
        <div style="margin-top:12px"><button class="btn primary" id="m-solve">حل المسألة</button></div>
        <div id="m-out" style="margin-top:14px"></div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0">🧮 آلة حاسبة سريعة</div>
        <input id="calc-in" placeholder="اكتب عملية: (7+3)*4" style="width:100%;padding:.7em;border:1px solid var(--line);border-radius:12px;font-size:1.1rem">
        <div id="calc-out" style="font-size:2rem;font-weight:800;color:var(--teal-ink);margin-top:12px;min-height:44px"></div>
        <p class="muted" style="font-size:.8rem">تدعم + − × ÷ ( ) — للعمليات المتقدمة استخدم المساعد الذكي.</p>
      </div>
    </div>`;
  let imgData = '';
  const drop = $('#m-drop'), img = $('#m-img'), prev = $('#m-prev');
  drop.onclick = () => img.click();
  img.onchange = async () => { if (img.files[0]) { imgData = await fileToDataURL(img.files[0]); prev.src = imgData; prev.style.display = 'block'; } };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) { imgData = await fileToDataURL(f); prev.src = imgData; prev.style.display = 'block'; } };
  $('#m-solve').onclick = () => solveMath($('#m-q').value.trim(), imgData);
  const calc = $('#calc-in'), cout = $('#calc-out');
  calc.oninput = () => {
    const expr = calc.value.replace(/×/g, '*').replace(/÷/g, '/').replace(/[^-()\d/*+.\s]/g, '');
    if (!expr.trim()) { cout.textContent = ''; return; }
    try { const v = Function('"use strict";return (' + expr + ')')(); cout.textContent = (v === undefined || Number.isNaN(v)) ? '—' : '= ' + v; } catch (e) { cout.textContent = '…'; }
  };
}
async function solveMath(q, imgData) {
  const out = $('#m-out');
  if (!q && !imgData) return toast('اكتب المسألة أو أرفق صورة', 'err');
  let aiOn = false; try { const cfg = await api('/api/config'); aiOn = cfg.ai; } catch (e) {}
  if (!aiOn) {
    if (q) {
      const expr = q.replace(/×/g, '*').replace(/÷/g, '/').match(/[-()\d/*+.\s]+/);
      if (expr) { try { const v = Function('"use strict";return (' + expr[0] + ')')(); out.innerHTML = `<div class="card" style="background:var(--panel-2)"><b>الناتج:</b> <span style="font-size:1.4rem;color:var(--teal-ink);font-weight:800">${v}</span><p class="muted" style="margin:6px 0 0;font-size:.8rem">حساب مباشر. لخطوات الحل التفصيلية وحل المعادلات، فعّل المساعد الذكي (OLS_ANTHROPIC_KEY).</p></div>`; return; } catch (e) {} }
    }
    out.innerHTML = `<div class="card" style="background:var(--panel-2)"><p>الحل التفصيلي (والتعرّف على صور المسائل) يتطلب تفعيل المساعد الذكي على الخادم.</p><p class="muted" style="font-size:.8rem">اضبط المتغيّر OLS_ANTHROPIC_KEY في إعدادات الخادم لتفعيله.</p></div>`;
    return;
  }
  out.innerHTML = `<div class="card" style="background:var(--panel-2)">… يحل المسألة</div>`;
  const content = [];
  if (imgData) { const m = /^data:([^;]+);base64,(.*)$/.exec(imgData); if (m) content.push({type: 'image', source: {type: 'base64', media_type: m[1], data: m[2]}}); }
  content.push({type: 'text', text: (q || 'اقرأ المسألة في الصورة') + '\n\nحلّ هذه المسألة خطوة بخطوة بالعربية، واذكر القاعدة المستخدمة والمصدر في المنهج إن أمكن.'});
  try {
    const sys = 'أنت معلّم رياضيات عُماني. اقرأ المسألة (نصًا أو من الصورة) وحلّها خطوة بخطوة بالعربية المبسّطة، مع إبراز الناتج النهائي بوضوح.';
    const r = await api('/api/assist', 'POST', {messages: [{role: 'user', content}], system: sys});
    out.innerHTML = r.ok ? `<div class="card" style="background:var(--panel-2)">${esc(r.text).replace(/\n/g, '<br>')}</div>` : `<div class="card">${esc(r.error || 'تعذّر الحل')}</div>`;
  } catch (e) { out.innerHTML = `<div class="card">تعذّر الاتصال بالمساعد.</div>`; }
}

/* ---- Messages / chat ---- */
PAGES.messages = function (params) {
  crumb('المحادثات', 'تواصل مباشر');
  $('#view').innerHTML = `<div class="page-head"><div><h2>💬 المحادثات</h2><p>تواصل بين المعلمين والطلبة والإدارة${Auth.isTeacher ? ' — طلابك في مستوياتك المخصّصة' : ''}.</p></div>
    <a class="btn" href="#/">◀ الرئيسية</a></div>
    <div id="msg-wrap"><div class="empty"><div class="big">💬</div>… جارٍ تحميل جهات الاتصال</div></div>`;
  loadDirectory().then(() => renderMessages(params[0]));
};
function unreadFrom(otherU) {
  const last = Store.lget('msg-read-' + otherU, 0);
  return threadWith(otherU).filter(m => m.from === otherU && m.t > last).length;
}
function markRead(otherU) { Store.lset('msg-read-' + otherU, Date.now()); }
function renderMessages(activeU) {
  const contacts = myContacts();
  const wrap = $('#msg-wrap');
  if (!contacts.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">💬</div>لا توجد جهات اتصال متاحة بعد.<br>
      <small>${Auth.isStudent ? 'سيظهر معلّموك بعد أن يخصّص المدير مستواك الدراسي من صفحة المستخدمين.' : Auth.isTeacher ? 'سيظهر طلابك بعد تخصيص المستويات لك ولهم من صفحة المستخدمين.' : 'لا يوجد مستخدمون نشطون آخرون بعد.'}</small></div>`;
    return;
  }
  activeU = activeU || Store.lget('msg-active', '');
  if (!contacts.find(c => c.u === activeU)) activeU = contacts[0].u;
  Store.lset('msg-active', activeU); markRead(activeU);
  const other = contacts.find(c => c.u === activeU);
  const thread = threadWith(activeU);
  wrap.innerHTML = `<div class="msg-layout">
    <div class="contact-list">
      ${contacts.map(c => { const un = unreadFrom(c.u); return `<div class="contact-item ${c.u === activeU ? 'active' : ''}" data-c="${esc(c.u)}">
        <span class="um-avatar" style="width:38px;height:38px">${esc(initials(c.name))}</span>
        <div class="ci-info"><div class="ci-name">${esc(c.name)}</div><div class="ci-role">${roleEmoji(c.role)} ${esc(c.role)}${(c.levels && c.levels.length) ? ' · ' + c.levels.map(g => g === 0 ? 'روضة' : num(g)).join('،') : ''}</div></div>
        ${un ? `<span class="unread">${num(un)}</span>` : ''}</div>`; }).join('')}
    </div>
    <div class="card chat" style="height:64vh">
      <div class="section-title" style="margin-top:0;display:flex;align-items:center;gap:8px">
        <span class="um-avatar" style="width:34px;height:34px">${esc(initials(other.name))}</span>
        <div><div style="font-weight:800">${esc(other.name)}</div><div class="muted" style="font-size:.75rem;font-weight:500">${roleEmoji(other.role)} ${esc(other.role)}</div></div>
      </div>
      <div class="chat-log" id="msg-log">
        ${thread.length ? thread.map(m => `<div class="msg ${m.from === Auth.user.u ? 'me' : 'ai'}">${esc(m.text)}<span class="src muted" style="opacity:.7">${arDate(m.t)} · ${num(new Date(m.t).toLocaleTimeString('ar', {hour: '2-digit', minute: '2-digit'}))}</span></div>`).join('') : `<div class="empty" style="margin:auto"><div class="big">✉️</div>ابدأ المحادثة مع ${esc(other.name)}</div>`}
      </div>
      <div class="chat-input"><textarea id="msg-in" placeholder="اكتب رسالتك…"></textarea><button class="btn primary" id="msg-send">إرسال</button></div>
    </div>
  </div>`;
  const log = $('#msg-log'); if (log) log.scrollTop = log.scrollHeight;
  $$('.contact-item').forEach(ci => ci.onclick = () => renderMessages(ci.dataset.c));
  const send = () => {
    const inp = $('#msg-in'); const t = inp.value.trim(); if (!t) return;
    sendMessage(activeU, other.name, t); inp.value = ''; renderMessages(activeU);
  };
  $('#msg-send').onclick = send;
  $('#msg-in').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
};

/* ---- Kindergarten ---- */
/* speak Arabic text aloud (tap-to-hear). Uses the browser voices; degrades
   silently if no Arabic voice is installed. */
let _voicesReady = false;
function primeVoices() { try { if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => { _voicesReady = true; }; } } catch (e) {} }
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'ar-SA'; u.rate = 0.82; u.pitch = 1.05;
    const ar = speechSynthesis.getVoices().find(v => /^ar/i.test(v.lang));
    if (ar) u.voice = ar;
    speechSynthesis.speak(u);
  } catch (e) {}
}

/* ---- Kindergarten learning decks (all self-contained & interactive) ---- */
const KG_DECKS = {
  letters: {title: 'الحروف العربية', icon: '🔤', color: '#38b2ac', items: [
    ['أ', 'أَسَد', '🦁'], ['ب', 'بَطَّة', '🦆'], ['ت', 'تُفّاحة', '🍎'], ['ث', 'ثَعلَب', '🦊'], ['ج', 'جَمَل', '🐫'],
    ['ح', 'حِصان', '🐴'], ['خ', 'خَروف', '🐑'], ['د', 'دَجاجة', '🐔'], ['ذ', 'ذُرة', '🌽'], ['ر', 'رِيشة', '🪶'],
    ['ز', 'زَرافة', '🦒'], ['س', 'سَمَكة', '🐟'], ['ش', 'شَمس', '☀️'], ['ص', 'صَقر', '🦅'], ['ض', 'ضِفدَع', '🐸'],
    ['ط', 'طائِرة', '✈️'], ['ظ', 'ظَرف', '✉️'], ['ع', 'عِنَب', '🍇'], ['غ', 'غَزال', '🦌'], ['ف', 'فيل', '🐘'],
    ['ق', 'قِطّة', '🐱'], ['ك', 'كِتاب', '📖'], ['ل', 'لَيمون', '🍋'], ['م', 'مَوز', '🍌'], ['ن', 'نَحلة', '🐝'],
    ['ه', 'هُدهُد', '🐦'], ['و', 'وَردة', '🌹'], ['ي', 'يَد', '✋']]},
  numbers: {title: 'الأرقام ١–١٠', icon: '🔢', color: '#ff6f91', items: [
    ['١', 'واحِد', '🍎'], ['٢', 'اِثنان', '🍎🍎'], ['٣', 'ثَلاثة', '⭐⭐⭐'], ['٤', 'أَربَعة', '🎈🎈🎈🎈'],
    ['٥', 'خَمسة', '🐤🐤🐤🐤🐤'], ['٦', 'سِتّة', '🌸🌸🌸🌸🌸🌸'], ['٧', 'سَبعة', '🐟×٧'], ['٨', 'ثَمانية', '🍇×٨'],
    ['٩', 'تِسعة', '🌟×٩'], ['١٠', 'عَشَرة', '🖐️🖐️']]},
  colors: {title: 'الألوان', icon: '🎨', color: '#f9a826', items: [
    ['', 'أَحمَر', '', '#e11d48'], ['', 'أَزرَق', '', '#2563eb'], ['', 'أَخضَر', '', '#16a34a'], ['', 'أَصفَر', '', '#f59e0b'],
    ['', 'بُرتُقالي', '', '#f97316'], ['', 'بَنَفسَجي', '', '#7c3aed'], ['', 'وَردي', '', '#ec4899'], ['', 'بُنّي', '', '#92400e'],
    ['', 'أَبيَض', '', '#f4f4f5'], ['', 'أَسوَد', '', '#18181b']]},
  shapes: {title: 'الأشكال', icon: '🔷', color: '#7b8cff', items: [
    ['●', 'دائِرة', ''], ['■', 'مُرَبَّع', ''], ['▲', 'مُثَلَّث', ''], ['★', 'نَجمة', ''], ['❤', 'قَلب', ''], ['▬', 'مُستَطيل', '']]},
  fruits: {title: 'فواكه وخضار', icon: '🍎', color: '#ef476f', items: [
    ['', 'تُفّاحة', '🍎'], ['', 'مَوز', '🍌'], ['', 'بُرتُقال', '🍊'], ['', 'عِنَب', '🍇'], ['', 'فَراولة', '🍓'],
    ['', 'بَطّيخ', '🍉'], ['', 'تَمر', '🌴'], ['', 'جَزَر', '🥕'], ['', 'طَماطِم', '🍅'], ['', 'لَيمون', '🍋']]},
  animals: {title: 'الحيوانات', icon: '🐘', color: '#06d6a0', items: [
    ['', 'أَسَد', '🦁'], ['', 'فيل', '🐘'], ['', 'جَمَل', '🐫'], ['', 'قِطّة', '🐱'], ['', 'كَلب', '🐶'], ['', 'حِصان', '🐴'],
    ['', 'خَروف', '🐑'], ['', 'دَجاجة', '🐔'], ['', 'سَمَكة', '🐟'], ['', 'عُصفور', '🐦'], ['', 'نَحلة', '🐝'], ['', 'أَرنَب', '🐰']]},
  oman: {title: 'عُمان بَلَدي', icon: '🇴🇲', color: '#c1121f', items: [
    ['', 'عَلَم عُمان', '🇴🇲'], ['', 'الجَمَل', '🐫'], ['', 'النَّخلة والتَّمر', '🌴'], ['', 'الخَنجَر العُماني', '🗡️'],
    ['', 'القَلعة', '🏰'], ['', 'المَسجِد', '🕌'], ['', 'البَحر', '🌊'], ['', 'الجَبَل', '⛰️'], ['', 'القَهوة العُمانية', '☕'], ['', 'الماعِز', '🐐']]},
  adab: {title: 'آداب وكَلِمات', icon: '🌟', color: '#118ab2', items: [
    ['', 'السَّلامُ عَلَيكُم', '👋'], ['', 'بِسمِ الله', '🤲'], ['', 'الحَمدُ لله', '💚'], ['', 'شُكراً', '🙏'],
    ['', 'مِن فَضلِك', '😊'], ['', 'آسِف', '🤝'], ['', 'أُحِبُّ أُمّي', '💗'], ['', 'أُحِبُّ عُمان', '❤️']]},
};

PAGES.kindergarten = function () {
  crumb('الروضة', 'تعلّم والعب');
  const deckTile = (k) => { const d = KG_DECKS[k]; return `<button class="kg-tile" style="background:linear-gradient(135deg,${d.color},${d.color}cc)" data-deck="${k}"><span class="emo">${d.icon}</span>${esc(d.title)}</button>`; };
  const gameTile = (k, icon, label, col) => `<button class="kg-tile" style="background:linear-gradient(135deg,${col})" data-kg="${k}"><span class="emo">${icon}</span>${label}</button>`;
  $('#view').innerHTML = `<div class="kg">
    <div class="page-head"><div><h2>🧸 ركن الروضة</h2><p>تعلّم الحروف والأرقام والألوان — اضغط على أي بطاقة لتسمع الكلمة! 🔊</p></div>
      <a class="btn" href="#/">◀ الرئيسية</a></div>
    <div class="section-title">📚 تعلّم — بطاقات ناطقة</div>
    <div class="kg-grid">
      ${deckTile('letters')}${deckTile('numbers')}${deckTile('colors')}${deckTile('shapes')}
      ${deckTile('fruits')}${deckTile('animals')}${deckTile('oman')}${deckTile('adab')}
    </div>
    <div class="section-title">🎮 العب — أسئلة ممتعة</div>
    <div class="kg-grid">
      ${gameTile('count', '🔢', 'عدّ الأشياء', '#ff6f91,#ff9671')}
      ${gameTile('letters', '🔤', 'اعرف الحرف', '#5ad2c9,#38b2ac')}
      ${gameTile('colors', '🎨', 'اعرف اللون', '#ffc75f,#f9a826')}
      ${gameTile('shapes', '🔷', 'اعرف الشكل', '#7b8cff,#9b5de5')}
      ${gameTile('animals', '🐘', 'اعرف الحيوان', '#43cea2,#5ad2c9')}
      ${gameTile('fruits', '🍎', 'اعرف الفاكهة', '#ff6f91,#ffa8a8')}
    </div></div>`;
  $$('[data-deck]').forEach(b => b.onclick = () => kgDeck(b.dataset.deck));
  $$('[data-kg]').forEach(b => b.onclick = () => kgGame(b.dataset.kg));
};
/* flashcard viewer: big visual + Arabic word + tap-to-hear + prev/next */
function kgDeck(key) {
  const deck = KG_DECKS[key]; let i = 0;
  const m = modal(deck.icon + ' ' + deck.title, `<div id="kg-deck"></div>`, '', {wide: true});
  const render = (autoSpeak) => {
    const it = deck.items[i]; const [big, word, emo, bg] = it;
    const visual = bg ? `<div style="width:150px;height:150px;border-radius:32px;background:${bg};margin:6px auto;box-shadow:var(--shadow);border:${bg === '#f4f4f5' ? '2px solid var(--line)' : '0'}"></div>`
      : big ? `<div class="kg-big" style="margin:4px 0">${big}</div>${emo ? `<div style="font-size:2.4rem">${emo}</div>` : ''}`
      : `<div style="font-size:6rem;line-height:1.1">${emo}</div>`;
    $('#kg-deck', m.el).innerHTML = `<div class="kg-play" style="user-select:none">
      <div class="muted">${num(i + 1)} / ${num(deck.items.length)}</div>
      ${visual}
      <h1 class="kg-word" style="font-size:2.6rem;color:#d6336c;margin:.2em 0">${esc(word)}</h1>
      <button class="btn gold" id="kg-say" style="font-size:1.1rem">🔊 استمع</button>
      <div class="kg-choices" style="margin-top:16px">
        <button class="kg-choice" id="kg-prev" style="background:#94a3b8">◀</button>
        <button class="kg-choice" id="kg-next" style="background:linear-gradient(135deg,${deck.color},${deck.color}cc)">▶</button>
      </div></div>`;
    const say = () => speak(big && key === 'letters' ? (big + ' . ' + word) : word);
    $('#kg-say', m.el).onclick = say;
    $('#kg-prev', m.el).onclick = () => { i = (i - 1 + deck.items.length) % deck.items.length; render(true); };
    $('#kg-next', m.el).onclick = () => { i = (i + 1) % deck.items.length; render(true); };
    if (autoSpeak) say();
  };
  render(false);
}
function kgGame(kind) {
  const games = {
    count: () => { const n = 1 + Math.floor(Math.random() * 5); const emo = ['🍎', '⭐', '🎈', '🐤', '🌸'][Math.floor(Math.random() * 5)];
      return {prompt: 'كم عدد ' + emo + ' ؟', display: emo.repeat(n), answer: String(n), choices: shuffle(uniqNums(n, 1, 5)).map(String), color: '#ff6f91'}; },
    letters: () => { const L = ['أ', 'ب', 'ت', 'ث', 'ج', 'ح', 'د', 'ر', 'س', 'ش']; const i = Math.floor(Math.random() * L.length); const c = L[i];
      const opts = shuffle([c].concat(shuffle(L.filter(x => x !== c)).slice(0, 2)));
      return {prompt: 'أين الحرف: ' + c + ' ؟', display: c, answer: c, choices: opts, color: '#38b2ac'}; },
    colors: () => { const cols = [['أحمر', '#e11d48'], ['أزرق', '#2563eb'], ['أخضر', '#16a34a'], ['أصفر', '#f59e0b'], ['برتقالي', '#f97316']];
      const pick = cols[Math.floor(Math.random() * cols.length)]; const opts = shuffle([pick].concat(shuffle(cols.filter(c => c !== pick)).slice(0, 2)));
      return {prompt: 'ما اسم هذا اللون؟', display: `<span style="display:inline-block;width:110px;height:110px;border-radius:24px;background:${pick[1]}"></span>`, answer: pick[0], choices: opts.map(c => c[0]), color: pick[1]}; },
    shapes: () => { const sh = [['دائرة', '●'], ['مربع', '■'], ['مثلث', '▲'], ['نجمة', '★'], ['قلب', '❤']];
      const pick = sh[Math.floor(Math.random() * sh.length)]; const opts = shuffle([pick].concat(shuffle(sh.filter(s => s !== pick)).slice(0, 2)));
      return {prompt: 'ما اسم هذا الشكل؟', display: `<span style="font-size:6rem;color:#7b8cff">${pick[1]}</span>`, answer: pick[0], choices: opts.map(s => s[0]), color: '#7b8cff'}; },
    animals: () => { const an = [['فيل', '🐘'], ['قطة', '🐱'], ['أسد', '🦁'], ['أرنب', '🐰'], ['بطة', '🦆'], ['سمكة', '🐟'], ['جمل', '🐫']];
      const pick = an[Math.floor(Math.random() * an.length)]; const opts = shuffle([pick].concat(shuffle(an.filter(a => a !== pick)).slice(0, 2)));
      return {prompt: 'ما اسم هذا الحيوان؟', display: `<span style="font-size:6rem">${pick[1]}</span>`, answer: pick[0], choices: opts.map(a => a[0]), color: '#43cea2'}; },
    fruits: () => { const fr = [['تفاحة', '🍎'], ['موز', '🍌'], ['برتقال', '🍊'], ['عنب', '🍇'], ['فراولة', '🍓'], ['بطيخ', '🍉'], ['تمر', '🌴']];
      const pick = fr[Math.floor(Math.random() * fr.length)]; const opts = shuffle([pick].concat(shuffle(fr.filter(a => a !== pick)).slice(0, 2)));
      return {prompt: 'ما اسم هذه الفاكهة؟', display: `<span style="font-size:6rem">${pick[1]}</span>`, answer: pick[0], choices: opts.map(a => a[0]), color: '#ff6f91'}; },
  };
  let score = 0, round = 0; const rounds = 6;
  const palette = ['#ff6f91', '#5ad2c9', '#ffc75f', '#7b8cff', '#43cea2', '#f97316'];
  const play = () => {
    const g = games[kind]();
    const body = `<div class="kg-play">
      <div class="row" style="justify-content:center;gap:14px"><span class="kg-star">⭐ ${num(score)}</span><span class="muted">${num(round + 1)}/${num(rounds)}</span></div>
      <h2 style="color:#d6336c;margin-top:10px">${g.prompt}</h2>
      <div class="kg-big">${g.display}</div>
      <div class="kg-choices">${g.choices.map((c, i) => `<button class="kg-choice" style="background:${palette[i % palette.length]}" data-c="${esc(c)}">${num(esc(c))}</button>`).join('')}</div>
      <p id="kg-fb" style="height:30px;font-weight:800;font-size:1.3rem;margin-top:12px"></p></div>`;
    const m = modal('🧸 لعبة', body, '');
    $$('.kg-choice', m.el).forEach(btn => btn.onclick = () => {
      const ok = btn.dataset.c === g.answer;
      if (ok) score++;
      speak(ok ? 'أحسنت! ' + g.answer : g.answer);
      $$('.kg-choice', m.el).forEach(b => b.disabled = true);
      // full-screen result inside the modal — always visible on phones before advancing
      const box = $('.kg-play', m.el);
      if (box) box.innerHTML = `<div style="padding:26px 10px;text-align:center">
        <div style="font-size:4.4rem;line-height:1">${ok ? '🎉' : '💛'}</div>
        <h2 style="color:${ok ? 'var(--green)' : '#d6336c'};margin:.4em 0">${ok ? 'أحسنت!' : 'الإجابة الصحيحة:'}</h2>
        ${ok ? '' : `<div style="font-size:2.6rem;font-weight:900;color:var(--teal-ink)">${num(esc(g.answer))}</div>`}
        <div class="kg-star" style="margin-top:10px">⭐ ${num(score)} <span class="muted" style="font-size:.9rem">· ${num(round + 1)}/${num(rounds)}</span></div></div>`;
      setTimeout(() => { round++; m.close(); if (round >= rounds) kgDone(score, rounds); else play(); }, 1600);
    });
  };
  play();
}
function kgDone(score, total) {
  const stars = '⭐'.repeat(Math.max(1, Math.round(score / total * 3)));
  modal('🏆 أحسنت!', `<div style="text-align:center"><div style="font-size:3.6rem">${stars}</div>
    <h2 style="color:#d6336c">${num(score)} / ${num(total)}</h2><p class="muted">لقد قمت بعمل رائع! 🎈</p></div>`,
    `<button class="btn gold" onclick="this.closest('.modal-back').remove()">العب مرة أخرى</button>`);
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
function uniqNums(must, lo, hi) { const s = new Set([must]); while (s.size < 3) s.add(lo + Math.floor(Math.random() * (hi - lo + 1))); return Array.from(s); }

/* ---- Users ---- */
PAGES.users = function () {
  crumb('المستخدمون', 'الأدوار والصلاحيات');
  if (!Auth.isAdmin) { $('#view').innerHTML = `<div class="empty"><div class="big">🔒</div>هذه الصفحة متاحة للمدير فقط.</div>`; return; }
  $('#view').innerHTML = `<div class="page-head"><div><h2>👥 المستخدمون</h2><p>إدارة الحسابات والأدوار والموافقات.</p></div>
    <div class="row"><button class="btn" id="u-invite">🔗 رابط دعوة</button><button class="btn" id="u-refresh">↻ تحديث</button></div></div>
    <div id="u-list"><div class="empty">… جارٍ التحميل</div></div>
    ${roleMatrixCard()}`;
  const load = async () => {
    try { const r = await api('/api/users'); renderUsers(r.users); } catch (e) { $('#u-list').innerHTML = `<div class="empty">تعذّر التحميل: ${esc(e.message)}</div>`; }
  };
  $('#u-refresh').onclick = load;
  $('#u-invite').onclick = inviteModal;
  load();
};
let USERS_CACHE = [];
function assignText(u) {
  if (u.role === 'معلم' || u.role === 'طالب') { const lv = u.levels || []; return lv.length ? lv.map(g => `<span class="pill teal">${g === 0 ? 'روضة' : gradeName(g)}</span>`).join(' ') : '<span class="muted">غير مخصّص</span>'; }
  if (u.role === 'ولي أمر') return u.child ? `<span class="pill">👦 @${esc(u.child)}</span>` : '<span class="muted">لم يُربط بطالب</span>';
  if (u.role === 'مدير') return '<span class="pill gold">كل المستويات</span>';
  return '<span class="muted">—</span>';
}
function renderUsers(users) {
  USERS_CACHE = users;
  const roles = ['مدير', 'معلم', 'طالب', 'ولي أمر', 'زائر'];
  const pending = users.filter(u => u.status === 'pending');
  const rows = users.map(u => `<tr>
    <td><b>${esc(u.name)}</b><br><span class="muted" style="font-size:.78rem">@${esc(u.u)}</span></td>
    <td>${u.role === 'مدير' ? '<span class="pill gold">👑 مدير</span>' : `<select data-role="${esc(u.u)}">${roles.filter(r => r !== 'مدير').map(r => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>`}</td>
    <td>${assignText(u)}</td>
    <td><span class="badge-status st-${u.status}">${u.status === 'active' ? 'نشط' : u.status === 'pending' ? 'بانتظار' : 'مرفوض'}</span></td>
    <td class="muted" style="font-size:.78rem">${num(arDate(u.created))}</td>
    <td><div class="row" style="gap:5px">
      ${u.status === 'pending' ? `<button class="btn sm primary" data-approve="${esc(u.u)}">قبول</button><button class="btn sm danger" data-reject="${esc(u.u)}">رفض</button>` : ''}
      ${(u.role === 'معلم' || u.role === 'طالب' || u.role === 'ولي أمر') ? `<button class="btn sm" data-assign="${esc(u.u)}" title="التخصيص">📌</button>` : ''}
      ${u.role !== 'مدير' ? `<button class="btn sm" data-pw="${esc(u.u)}" title="كلمة المرور">🔑</button><button class="btn sm danger" data-del="${esc(u.u)}" title="حذف">🗑</button>` : ''}
    </div></td></tr>`).join('');
  $('#u-list').innerHTML = `
    ${pending.length ? `<div class="card" style="border-color:var(--gold);margin-bottom:14px"><b>⏳ ${num(pending.length)} طلب بانتظار الموافقة</b></div>` : ''}
    <div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <tr><th>المستخدم</th><th>الدور</th><th>التخصيص / النطاق</th><th>الحالة</th><th>الإنشاء</th><th>إجراءات</th></tr>${rows}</table></div>`;
  const act = async (u, action, patch) => { try { const r = await api('/api/users', 'POST', {u, action, patch}); renderUsers(r.users); loadDirectory(); updatePendingBadge(); toast('تم', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $$('[data-approve]').forEach(b => b.onclick = () => act(b.dataset.approve, 'approve'));
  $$('[data-reject]').forEach(b => b.onclick = () => act(b.dataset.reject, 'reject'));
  $$('[data-del]').forEach(b => b.onclick = () => armed(b, () => act(b.dataset.del, 'remove')));
  $$('[data-role]').forEach(s => s.onchange = () => act(s.dataset.role, 'update', {role: s.value}));
  $$('[data-assign]').forEach(b => b.onclick = () => assignModal(users.find(u => u.u === b.dataset.assign), act));
  $$('[data-pw]').forEach(b => b.onclick = () => {
    const body = `<div class="field"><label>كلمة مرور جديدة للمستخدم @${esc(b.dataset.pw)}</label><input id="np" type="text" placeholder="4 أحرف على الأقل"></div>`;
    const m = modal('إعادة تعيين كلمة المرور', body, `<button class="btn primary" id="np-go">تعيين</button>`);
    $('#np-go', m.el).onclick = async () => { const np = $('#np', m.el).value; if (np.length < 4) return toast('4 أحرف على الأقل', 'err'); try { await api('/api/users', 'POST', {u: b.dataset.pw, action: 'setpw', patch: {password: np}}); m.close(); toast('تم تعيين كلمة المرور', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  });
}
function assignModal(u, act) {
  if (!u) return;
  if (u.role === 'ولي أمر') {
    const students = USERS_CACHE.filter(x => x.role === 'طالب');
    const body = `<p class="muted">اربط ولي الأمر <b>${esc(u.name)}</b> بالطالب المسؤول عنه.</p>
      <div class="field"><label>الطالب</label><select id="as-child"><option value="">— بدون —</option>${students.map(s => `<option value="${esc(s.u)}" ${u.child === s.u ? 'selected' : ''}>${esc(s.name)} (@${esc(s.u)})</option>`).join('')}</select></div>`;
    const m = modal('تخصيص ولي الأمر', body, `<button class="btn primary" id="as-save">حفظ</button>`);
    $('#as-save', m.el).onclick = () => { act(u.u, 'update', {child: $('#as-child', m.el).value}); m.close(); };
    return;
  }
  // teacher / student → assign levels
  const cur = u.levels || [];
  const body = `<p class="muted">حدّد ${u.role === 'معلم' ? 'المستويات التي يُدرّسها المعلّم' : 'مستوى الطالب الدراسي'} <b>${esc(u.name)}</b>.
    ${u.role === 'معلم' ? 'سيتواصل المعلّم مع طلبة هذه المستويات فقط.' : 'سيتواصل الطالب مع معلّمي مستواه.'}</p>
    <div class="row" style="gap:8px">${DATA.levels.map(l => `<label class="pill" style="cursor:pointer;display:inline-flex;gap:6px;align-items:center">
      <input type="checkbox" value="${l.grade}" ${cur.includes(l.grade) ? 'checked' : ''} style="width:auto"> ${esc(l.name)}</label>`).join('')}</div>`;
  const m = modal('تخصيص المستويات', body, `<button class="btn primary" id="as-save">حفظ</button>`);
  $('#as-save', m.el).onclick = () => {
    const levels = $$('input[type=checkbox]', m.el).filter(c => c.checked).map(c => +c.value);
    act(u.u, 'update', {levels}); m.close();
  };
}
function roleMatrixCard() {
  const caps = [
    ['تصفّح المناهج والمكتبة', 1, 'صفوفه', 'صفّه', 'صف ابنه', 1],
    ['حضور الحصص وأداء التمارين', 1, 'صفوفه', 'صفّه', 'صف ابنه', 0],
    ['أداء الاختبارات التفاعلية', 1, 'صفوفه', 'صفّه', 0, 0],
    ['عرض النتائج', 'الكل', 'طلابه', 'نتائجه', 'ابنه', 0],
    ['رفع / إضافة محتوى (مكتبة، حصص)', 1, 1, 0, 0, 0],
    ['إنشاء اختبارات', 1, 1, 0, 0, 0],
    ['حذف / استبدال المحتوى', 1, 0, 0, 0, 0],
    ['المحادثات', 'الكل', 'طلابه', 'معلميه', 'معلمي ابنه', 0],
    ['المساعد الذكي', 1, 1, 1, 1, 0],
    ['إدارة المستخدمين والموافقات', 1, 0, 0, 0, 0],
    ['تخصيص الأدوار والمستويات', 1, 0, 0, 0, 0],
  ];
  const cell = v => v === 1 ? '<td class="c-yes">✓</td>' : v === 0 ? '<td class="c-no">✕</td>' : `<td class="c-scope">${v}</td>`;
  const heads = ['👑<br>مدير', '📗<br>معلم', '🎒<br>طالب', '👪<br>ولي أمر', '👁️<br>زائر'];
  return `<div class="card" style="margin-top:16px">
    <div class="section-title" style="margin-top:0">🧩 مصفوفة صلاحيات الأدوار</div>
    <div class="matrix-wrap"><table class="matrix">
      <thead><tr><th>القدرة</th>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${caps.map(r => `<tr><td>${r[0]}</td>${r.slice(1).map(cell).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="row" style="margin-top:10px;font-size:.78rem;gap:14px">
      <span><span class="yes" style="color:var(--green);font-weight:800">✓</span> مسموح</span>
      <span><span style="color:#c7d2cc;font-weight:800">✕</span> غير مسموح</span>
      <span class="muted">النص = نطاق محدود</span></div></div>`;
}
async function inviteModal() {
  const roles = ['معلم', 'طالب', 'ولي أمر', 'زائر'];
  const body = `<div class="field"><label>الدور</label><select id="inv-role">${roles.map(r => `<option>${r}</option>`).join('')}</select></div>
    <div class="field"><label>صلاحية الرابط (أيام)</label><input id="inv-days" type="number" value="14"></div>
    <div id="inv-out"></div>`;
  const m = modal('رابط دعوة جديد', body, `<button class="btn primary" id="inv-go">إنشاء الرابط</button>`);
  $('#inv-go', m.el).onclick = async () => {
    try { const r = await api('/api/invite', 'POST', {role: $('#inv-role', m.el).value, days: +$('#inv-days', m.el).value || 14});
      const url = location.origin + location.pathname + '#/join/' + r.token;
      $('#inv-out', m.el).innerHTML = `<div class="card" style="background:var(--panel-2)"><p style="word-break:break-all">${esc(url)}</p><button class="btn sm" id="inv-copy">📋 نسخ الرابط</button></div>`;
      $('#inv-copy', m.el).onclick = () => { navigator.clipboard.writeText(url).then(() => toast('تم النسخ', 'ok')); };
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* account page (self password change) */
PAGES.account = function () {
  crumb('حسابي', esc(Auth.user.name));
  $('#view').innerHTML = `<div class="page-head"><div><h2>👤 حسابي</h2></div></div>
    <div class="grid g-2"><div class="card">
      <p><b>الاسم:</b> ${esc(Auth.user.name)}</p><p><b>المستخدم:</b> @${esc(Auth.user.u)}</p><p><b>الدور:</b> <span class="pill teal">${esc(Auth.role)}</span></p>
      <button class="btn danger" id="logout2" style="margin-top:8px">تسجيل الخروج</button>
    </div>
    <div class="card"><div class="section-title" style="margin-top:0">تغيير كلمة المرور</div>
      <div class="field"><label>الحالية</label><input id="pw-cur" type="password"></div>
      <div class="field"><label>الجديدة</label><input id="pw-new" type="password"></div>
      <button class="btn primary" id="pw-go">تحديث</button></div></div>`;
  $('#logout2').onclick = logout;
  $('#pw-go').onclick = async () => {
    try { await api('/api/password', 'POST', {cur: $('#pw-cur').value, new: $('#pw-new').value}); toast('تم تحديث كلمة المرور', 'ok'); $('#pw-cur').value = $('#pw-new').value = ''; }
    catch (e) { toast(e.message, 'err'); }
  };
};
PAGES.join = function (params) {
  // invitation link → open register prefilled
  const token = params[0];
  showAuth('register', token);
};

/* ------------------------------ armed delete ---------------------------- */
function armed(btn, fn) {
  if (btn.dataset.armed) { fn(); return; }
  const orig = btn.innerHTML; btn.dataset.armed = '1'; btn.innerHTML = 'تأكيد؟'; btn.classList.add('danger');
  const reset = () => { if (btn.isConnected) { btn.innerHTML = orig; delete btn.dataset.armed; } };
  setTimeout(reset, 3000);
}

/* ------------------------------ sidebar/mobile -------------------------- */
function closeSidebar() { $('#sidebar').classList.remove('open'); const s = $('.scrim'); if (s) s.classList.remove('show'); }
function toggleSidebar() {
  const sb = $('#sidebar'); sb.classList.toggle('open');
  let scrim = $('.scrim'); if (!scrim) { scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.onclick = closeSidebar; document.body.appendChild(scrim); }
  scrim.classList.toggle('show', sb.classList.contains('open'));
}

/* ------------------------------ global search --------------------------- */
function wireGlobalSearch() {
  const inp = $('#global-search'), box = $('#search-results');
  if (!inp) return;
  inp.oninput = () => {
    const hits = localSearch(inp.value);
    if (!inp.value.trim()) { box.classList.remove('show'); return; }
    box.innerHTML = hits.length ? hits.slice(0, 12).map(h => `<a class="sr-item" href="${esc(h.url)}" ${h.url.indexOf('#') === 0 ? '' : 'target="_blank" rel="noopener"'}><span class="t">${esc(h.t)}</span><span class="m">${esc(h.m)} · ${esc(h.src)}</span></a>`).join('') : `<div class="sr-item muted">لا نتائج</div>`;
    box.classList.add('show');
  };
  inp.onblur = () => setTimeout(() => box.classList.remove('show'), 200);
  inp.onfocus = () => { if (inp.value.trim()) box.classList.add('show'); };
}

/* ------------------------------ auth flow ------------------------------- */
function showAuth(tab, inviteToken, flags) {
  flags = flags || {};
  const firstRun = !!flags.firstRun && !inviteToken;   // no admin exists yet → create it
  const noServer = !!flags.noServer;
  $('#app-shell').hidden = true;
  const scr = $('#auth-screen'); scr.classList.add('show');
  const head = firstRun
    ? `<h1>مرحبًا بك في OLS</h1><p>لنبدأ بإنشاء حساب <b>مدير النظام</b></p>`
    : `<h1>نظام التعلّم العُماني</h1><p>OLS — تعلّم تفاعلي ممتع للجميع</p>`;
  scr.innerHTML = `<div class="auth-card">
    <div class="auth-head"><img class="logo" src="assets/logo.svg" alt="OLS">${head}</div>
    <div class="auth-body">
      ${noServer ? `<div class="auth-msg err" style="margin-bottom:10px">⚠️ لا يمكن الوصول إلى خادم OLS. شغّل الخادم أولًا:<br><code style="background:#f6faf8;padding:2px 6px;border-radius:6px">node server.js</code></div>` : ''}
      ${firstRun ? `<div style="background:#dff3ee;border:1px solid #bce4da;border-radius:12px;padding:10px 12px;font-size:.85rem;color:var(--teal-ink);margin-bottom:14px">👑 هذا أول حساب في النظام، وسيصبح <b>المدير</b> صاحب كامل الصلاحيات. المستخدمون الآخرون يسجّلون لاحقًا وتوافق أنت عليهم.</div>` : ''}
      ${firstRun ? '' : `<div class="auth-tabs"><button data-tab="login" class="${tab !== 'register' ? 'active' : ''}">دخول</button><button data-tab="register" class="${tab === 'register' ? 'active' : ''}">حساب جديد</button></div>`}
      <form id="auth-form"></form>
      <div class="auth-msg" id="auth-msg"></div>
    </div>
    <div class="auth-foot">${esc(APP_VERSION)}</div></div>`;
  let mode = firstRun ? 'register' : (tab === 'register' ? 'register' : 'login');
  const paint = () => {
    const f = $('#auth-form');
    if (mode === 'login') {
      f.innerHTML = `<div class="field"><label>اسم المستخدم</label><input id="a-u" autocomplete="username"></div>
        <div class="field"><label>كلمة المرور</label><input id="a-pw" type="password" autocomplete="current-password"></div>
        <button class="btn primary block" type="submit">تسجيل الدخول</button>
        <button class="btn ghost block" type="button" id="forgot-pw" style="margin-top:6px;font-size:.85rem">🔑 نسيت كلمة المرور؟</button>`;
      const fp = $('#forgot-pw', f);
      if (fp) fp.onclick = () => modal('استعادة كلمة المرور', `
        <p>كلمات المرور محفوظة <b>مشفّرة</b> ولا يمكن لأحد قراءتها — تُستعاد بتعيين كلمة جديدة:</p>
        <div class="card" style="background:var(--panel-2);margin:10px 0"><b>🎒 للطلبة والمعلمين وأولياء الأمور:</b>
          <p style="margin:.4em 0 0">تواصل مع <b>مدير النظام</b> ليعيّن لك كلمة مرور جديدة من صفحة «المستخدمون» (زر 🔑 أمام اسمك)، ثم سجّل الدخول بها وغيّرها من صفحة «حسابي».</p></div>
        <div class="card" style="background:var(--panel-2)"><b>👑 للمدير نفسه:</b>
          <p style="margin:.4em 0 0">غيّر كلمتك من صفحة «حسابي» وأنت مسجّل الدخول. إن فقدتها كليًا، يلزم الوصول إلى ملفات الخادم (ols-data) — تواصل مع مسؤول الاستضافة.</p></div>`,
        `<button class="btn primary" onclick="this.closest('.modal-back').remove()">فهمت</button>`);
    } else {
      f.innerHTML = `<div class="field"><label>الاسم الكامل</label><input id="a-name" placeholder="${firstRun ? 'اسم المدير' : ''}"></div>
        <div class="field"><label>اسم المستخدم</label><input id="a-u" autocomplete="username"></div>
        <div class="field"><label>كلمة المرور</label><input id="a-pw" type="password" autocomplete="new-password"></div>
        ${(inviteToken || firstRun) ? '' : `<div class="field"><label>الدور</label><select id="a-role"><option>طالب</option><option>معلم</option><option>ولي أمر</option></select></div>
        <div class="field" id="a-class-f"><label>الصف الدراسي المطلوب</label><select id="a-class">${DATA.levels.map(l => `<option value="${l.grade}">${esc(l.name)}</option>`).join('')}</select>
          <p class="muted" style="font-size:.74rem;margin:4px 0 0">يعتمد المدير تسجيلك في هذا الصف قبل تفعيل حسابك.</p></div>`}
        <button class="btn primary block" type="submit">${firstRun ? '👑 إنشاء حساب المدير' : 'إنشاء الحساب'}</button>
        <p class="muted" style="font-size:.78rem;text-align:center;margin-top:8px">${inviteToken ? 'انضمام عبر رابط دعوة' : firstRun ? '' : 'يُفعَّل الحساب بعد موافقة مدير النظام.'}</p>`;
      const roleSel = $('#a-role', f);
      if (roleSel) { const tog = () => { $('#a-class-f', f).hidden = roleSel.value !== 'طالب'; }; roleSel.onchange = tog; tog(); }
    }
  };
  paint();
  $$('.auth-tabs button', scr).forEach(b => b.onclick = () => { mode = b.dataset.tab; $$('.auth-tabs button', scr).forEach(x => x.classList.toggle('active', x === b)); paint(); });
  $('#auth-form', scr).onsubmit = async e => {
    e.preventDefault(); const msg = $('#auth-msg'); msg.className = 'auth-msg'; msg.textContent = '… جارٍ المعالجة';
    try {
      if (mode === 'login') {
        const r = await api('/api/login', 'POST', {u: $('#a-u').value, pw: $('#a-pw').value});
        onLoggedIn(r.token, r.user);
      } else {
        const payload = {u: $('#a-u').value, name: $('#a-name').value, pw: $('#a-pw').value};
        if (inviteToken) payload.invite = inviteToken;
        else if (!firstRun) {
          payload.role = $('#a-role').value;
          const cls = $('#a-class');
          if (payload.role === 'طالب' && cls) payload.levels = [+cls.value];
        }
        const r = await api('/api/register', 'POST', payload);
        if (r.status === 'pending') { msg.className = 'auth-msg ok'; msg.innerHTML = '✅ تم إنشاء الحساب وإرسال طلب التسجيل.<br>حسابك الآن <b>بانتظار اعتماد المدير</b>' + (payload.levels ? ' لصفّك الدراسي' : '') + ' — بعد الموافقة يمكنك تسجيل الدخول.'; }
        else onLoggedIn(r.token, r.user);
      }
    } catch (e) {
      msg.className = 'auth-msg err';
      msg.textContent = (e.status === 0 || /fetch|network/i.test(e.message)) ? 'تعذّر الاتصال بالخادم — تأكّد أنه يعمل.' : (e.message || 'حدث خطأ');
    }
  };
}
function initials(name) { const p = String(name || '').trim().split(/\s+/); return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '؟'; }
/* red badge on the Users nav item with the number of pending sign-ups */
async function updatePendingBadge() {
  if (!Auth.isAdmin) return;
  try {
    const r = await api('/api/users');
    const n = r.users.filter(u => u.status === 'pending').length;
    let b = $('#nav-users .nav-badge');
    if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; $('#nav-users').appendChild(b); }
    b.textContent = num(n); b.style.display = n ? '' : 'none';
  } catch (e) {}
}
function renderUserMenu() {
  const el = $('#user-menu'); if (!el || !Auth.user) return;
  el.innerHTML = `<button class="um-btn" id="um-btn" aria-label="حسابي">
    <span class="um-avatar">${esc(initials(Auth.user.name))}</span>
    <span class="um-info"><span class="um-name">${esc(Auth.user.name)}</span><span class="um-role">${roleEmoji(Auth.role)} ${esc(Auth.role)}</span></span>
    <svg class="um-caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg></button>
    <div class="um-drop" id="um-drop">
      <a href="#/account">👤 حسابي</a>
      <a href="#/messages">💬 المحادثات</a>
      ${Auth.isAdmin ? '<a href="#/users">👥 المستخدمون</a>' : ''}
      <hr><button class="danger" id="um-logout">🚪 تسجيل الخروج</button>
    </div>`;
  const drop = $('#um-drop', el);
  $('#um-btn', el).onclick = e => { e.stopPropagation(); drop.classList.toggle('show'); };
  $('#um-logout', el).onclick = logout;
  $$('#um-drop a', el).forEach(a => a.onclick = () => drop.classList.remove('show'));
  if (!renderUserMenu._wired) { document.addEventListener('click', () => { const d = $('#um-drop'); if (d) d.classList.remove('show'); }); renderUserMenu._wired = true; }
}
/* per-device UI filters must not leak between users on a shared device */
function resetFilters() {
  ['lib-q', 'lib-sub', 'lib-sem', 'library-grade', 'lessons-grade', 'tests-grade', 'exercises-grade', 'msg-active']
    .forEach(k => { try { localStorage.removeItem(LOCAL_PREFIX + k); } catch (e) {} });
}
function onLoggedIn(token, user) {
  resetFilters();
  Store.token = token; Store.set('token', token); Auth.user = user;
  $('#auth-screen').classList.remove('show'); $('#app-shell').hidden = false;
  $('#nav-users').style.display = Auth.isAdmin ? '' : 'none';
  $('#foot-user').textContent = user.name; $('#foot-meta').textContent = Auth.role + ' · ' + APP_VERSION;
  renderUserMenu();
  loadDirectory();
  updatePendingBadge();
  if (!location.hash || location.hash.indexOf('#/join') === 0) location.hash = '#/';
  Store.lastPull = 0; Store.pull(true).then(() => router()); Store.startPolling();
  router();
}
async function logout() {
  try { await api('/api/logout', 'POST', {}); } catch (e) {}
  Store.token = ''; localStorage.removeItem(PREFIX + 'token'); Auth.user = null;
  if (Store.pullTimer) clearInterval(Store.pullTimer);
  showAuth('login');
}

/* ------------------------------ boot ------------------------------------ */
async function boot() {
  primeVoices();
  NUM_MODE = Store.lget('num-mode', 'hindi');
  updateNumToggle();
  const nt = $('#num-toggle'); if (nt) nt.onclick = toggleNum;
  $('#today-chip').textContent = new Date().toLocaleDateString('ar', {weekday: 'long', day: 'numeric', month: 'long'});
  $('#menu-btn').onclick = toggleSidebar;
  wireGlobalSearch();
  window.addEventListener('hashchange', () => router());
  // install PWA
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; const b = $('#install-app'); if (b) { b.hidden = false; b.onclick = () => { deferredPrompt.prompt(); deferredPrompt = null; b.hidden = true; }; } });
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch (e) {} }

  // server mode?
  let cfg = null;
  try { cfg = await api('/api/config'); Store.server = cfg.mode === 'server'; } catch (e) { Store.server = false; }
  if (!Store.server) { showAuth('login', null, {noServer: true}); return; }

  const token = Store.get('token', '');
  if (token) {
    Store.token = token;
    try { const s = await api('/api/session'); Auth.user = s.user; onLoggedIn(token, s.user); return; } catch (e) { localStorage.removeItem(PREFIX + 'token'); }
  }
  // invite link before login?
  if (location.hash.indexOf('#/join/') === 0) { showAuth('register', location.hash.split('/')[2]); return; }
  // no admin yet → guide the very first user to create the administrator account
  showAuth('login', null, {firstRun: !cfg.hasAdmin});
}
document.addEventListener('DOMContentLoaded', boot);
