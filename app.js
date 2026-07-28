/* ============================================================================
   OLS — Omani Learning System · client application
   Structure: helpers → store/sync → auth → media → RBAC → router → pages → boot
   ========================================================================== */
'use strict';
const APP_VERSION = 'v2.6 · 2026-07-28';
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
let PAGE_CLEANUP = null;   // pages with timers/streams register a teardown
function router(isRefresh) {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  const route = parts[0] || 'dashboard';
  currentRoute = route;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === route));
  if (PAGE_CLEANUP) { try { PAGE_CLEANUP(); } catch (e) {} PAGE_CLEANUP = null; }
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
  params = params || [];
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
    <div class="board-hero">
      <div>
        <h3>🎨 لوحة التدريب والكتابة (A4)</h3>
        <p>ورقة A4 قابلة للكتابة والرسم والتلوين، بقوالب مسطّرة (عربي، إنجليزي، رياضيات…) وأداة
        <b>تتبّع الحروف والكلمات المنقّطة</b> — يكتب المعلّم النص فيتحوّل إلى نموذج منقّط يتتبّعه الطفل.</p>
      </div>
      <a class="btn gold" href="#/board">افتح اللوحة ✍️</a>
    </div>
    <div class="section-title">🧠 تمارين تفاعلية</div>
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

/* ============================ NOTEBOOK ENGINE ============================
   A multi-page A4 notebook used by BOTH the practice board (#/board) and the
   live classroom. Everything is expressed as small serialisable ops so a board
   can be streamed to other people in real time and replayed identically.

   ops:  {k:'s',  pg, sid, p:[x,y,…], c, w, e}   stroke (e=1 → eraser)
         {k:'u',  pg, sid}                        undo / remove one stroke
         {k:'c',  pg}                             clear page
         {k:'t',  pg, v}                          set page template
         {k:'tr', pg, text, size, rep, style}     dotted/outline tracing model
         {k:'ap', tpl}                            append a page
   Page guides are CSS backgrounds (no canvas) so many pages stay cheap; only
   the ink layer — and a trace layer when used — allocate a canvas.
   ========================================================================= */
const PG_W = 720, PG_H = 1018;               // internal page resolution (A4 ratio)
const MAX_PAGES = 12;
const NB_TPLS = [
  {k: 'blank', t: 'فارغ', g: '🗒️'},
  {k: 'arabic', t: 'عربي', g: '📝'},
  {k: 'english', t: 'إنجليزي', g: '🔤'},
  {k: 'math', t: 'رياضيات', g: '➗'},
  {k: 'boxes', t: 'خانات', g: '🔲'},
  {k: 'dots', t: 'نقاط', g: '⋯'},
  {k: 'art', t: 'رسم وتلوين', g: '🎨'},
  {k: 'music', t: 'موسيقى', g: '🎼'},
];
/* the template that suits a subject, used when a class opens its notebook */
const TPL_FOR_SUBJECT = {
  'اللغة العربية': 'arabic', 'التربية الإسلامية': 'arabic', 'الدراسات الاجتماعية': 'arabic',
  'اللغة الإنجليزية': 'english', 'الرياضيات': 'math', 'العلوم': 'math', 'الفيزياء': 'math',
  'الكيمياء': 'math', 'الأحياء': 'math', 'تقنية المعلومات': 'blank',
  'الفنون التشكيلية': 'art', 'المهارات الموسيقية': 'music',
};
const tplForSubject = s => TPL_FOR_SUBJECT[s] || 'blank';
const isArabicText = s => /[؀-ۿ]/.test(s || '');

/* ---- ruled-page templates, drawn precisely on canvas ---- */
const PG_M = 48;                                   // page margin
function hLine(ctx, y, col, w, dash) {
  ctx.save(); ctx.beginPath(); ctx.setLineDash(dash || []);
  ctx.strokeStyle = col; ctx.lineWidth = w || 1;
  ctx.moveTo(PG_M, y + 0.5); ctx.lineTo(PG_W - PG_M, y + 0.5); ctx.stroke(); ctx.restore();
}
function drawTemplate(ctx, tpl) {
  if (tpl === 'arabic') {
    // Arabic ruling: one clear baseline per line, a faint dashed guide at
    // x-height above it, and a red margin on the right (RTL start edge).
    const STEP = 64;
    for (let y = 104; y <= PG_H - 40; y += STEP) {
      hLine(ctx, y, '#b9cbc4', 1.6);
      hLine(ctx, y - 26, '#e6efec', 1, [5, 7]);
    }
    ctx.save(); ctx.beginPath(); ctx.strokeStyle = '#f0b3b3'; ctx.lineWidth = 1.4;
    ctx.moveTo(PG_W - PG_M - 34, 40); ctx.lineTo(PG_W - PG_M - 34, PG_H - 40); ctx.stroke(); ctx.restore();
  } else if (tpl === 'english') {
    // Zaner-Bloser style groups: ascender, dashed midline, solid baseline,
    // descender — then a gap before the next group.
    const GROUP = 108, A = 0, MID = 26, BASE = 52, DESC = 78;
    for (let top = 76; top + DESC <= PG_H - 30; top += GROUP) {
      hLine(ctx, top + A, '#cfe0f5', 1.2);
      hLine(ctx, top + MID, '#8fc0f2', 1.3, [7, 7]);
      hLine(ctx, top + BASE, '#2563eb', 2);
      hLine(ctx, top + DESC, '#cfe0f5', 1.2);
    }
  } else if (tpl === 'math') {
    ctx.save(); ctx.strokeStyle = '#dbe7f3'; ctx.lineWidth = 1;
    for (let x = PG_M; x <= PG_W - PG_M; x += 34) { ctx.beginPath(); ctx.moveTo(x + 0.5, PG_M); ctx.lineTo(x + 0.5, PG_H - PG_M); ctx.stroke(); }
    for (let y = PG_M; y <= PG_H - PG_M; y += 34) { ctx.beginPath(); ctx.moveTo(PG_M, y + 0.5); ctx.lineTo(PG_W - PG_M, y + 0.5); ctx.stroke(); }
    ctx.restore();
  } else if (tpl === 'boxes') {
    ctx.save(); ctx.strokeStyle = '#c7d2cc'; ctx.lineWidth = 1.6;
    const cell = 96, gap = 12;
    for (let y = PG_M; y + cell <= PG_H - PG_M; y += cell + gap)
      for (let x = PG_M; x + cell <= PG_W - PG_M; x += cell + gap) ctx.strokeRect(x, y, cell, cell);
    ctx.restore();
  } else if (tpl === 'dots') {
    ctx.save(); ctx.fillStyle = '#cbd5e1';
    for (let x = PG_M; x <= PG_W - PG_M; x += 34) for (let y = PG_M; y <= PG_H - PG_M; y += 34) { ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 7); ctx.fill(); }
    ctx.restore();
  } else if (tpl === 'art') {
    ctx.save(); ctx.strokeStyle = '#f4b53f'; ctx.lineWidth = 8; ctx.strokeRect(16, 16, PG_W - 32, PG_H - 32); ctx.restore();
  } else if (tpl === 'music') {
    ctx.save(); ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.2;
    for (let top = 90; top + 48 <= PG_H - 40; top += 126)
      for (let k = 0; k < 5; k++) { const y = top + k * 12; ctx.beginPath(); ctx.moveTo(PG_M, y + 0.5); ctx.lineTo(PG_W - PG_M, y + 0.5); ctx.stroke(); }
    ctx.restore();
  }
}
function drawTraceText(ctx, tr) {
  if (!tr || !tr.text) return;
  const ar = isArabicText(tr.text), size = tr.size || 90;
  ctx.save();
  ctx.direction = ar ? 'rtl' : 'ltr'; ctx.textAlign = ar ? 'right' : 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `${size}px Cairo, Arial, sans-serif`;
  const x = ar ? PG_W - PG_M : PG_M;
  let y = PG_M + size;
  for (let r = 0; r < (tr.rep || 1) && y < PG_H - PG_M; r++) {
    // writing rails so the child keeps the letter height
    hLine(ctx, y, '#dfe8ef', 1.5);
    hLine(ctx, y - size * 0.62, '#eef3f7', 1.2, [5, 7]);
    if (tr.style === 'solid') {                       // light model to write over
      ctx.fillStyle = 'rgba(120,140,155,.32)'; ctx.fillText(tr.text, x, y);
    } else {
      ctx.strokeStyle = '#93a3b1'; ctx.lineWidth = Math.max(1.2, size / 48);
      ctx.setLineDash(tr.style === 'outline' ? [] : [2, Math.max(4, size / 11)]);
      ctx.strokeText(tr.text, x, y);
      ctx.setLineDash([]);
    }
    y += size * 1.55 + 14;
  }
  ctx.restore();
}
/* reusable "type text → it appears on the sheet to trace" panel.
   Because it emits a normal op, whatever the teacher types also appears on the
   student's board live in the classroom. */
function tracePanelHtml() {
  return `<div class="board-tools trace-panel" data-trace>
    <button class="btn sm gold trace-toggle" type="button">✍️ صندوق الكتابة والتتبّع</button>
    <div class="trace-fields">
      <input class="tr-text" placeholder="اكتب حرفًا أو كلمة أو جملة… ثم اضغط تطبيق">
      <label class="bt-size">الحجم <input class="tr-size" type="range" min="30" max="220" value="90"><b class="tr-sizeval">٩٠</b></label>
      <label class="bt-size">التكرار <input class="tr-rep" type="number" min="1" max="10" value="3" style="width:52px"></label>
      <div class="bt-group">
        <button class="tool-btn on" data-ts="dotted" title="منقّط للتتبّع">⁙</button>
        <button class="tool-btn" data-ts="outline" title="مفرّغ">▢</button>
        <button class="tool-btn" data-ts="solid" title="نموذج فاتح">▨</button>
      </div>
      <button class="btn sm primary tr-apply">تطبيق</button>
      <button class="btn sm tr-clear">إزالة</button>
    </div>
  </div>`;
}
function wireTracePanel(root, nb) {
  const p = $('[data-trace]', root); if (!p) return;
  let style = 'dotted';
  $('.trace-toggle', p).onclick = () => p.classList.toggle('open');
  $$('[data-ts]', p).forEach(b => b.onclick = () => { style = b.dataset.ts; $$('[data-ts]', p).forEach(x => x.classList.toggle('on', x === b)); });
  const sz = $('.tr-size', p);
  sz.oninput = () => { $('.tr-sizeval', p).textContent = num(sz.value); };
  const apply = () => {
    const text = $('.tr-text', p).value.trim();
    if (!text) return toast('اكتب النص أولًا', 'err');
    nb.setTrace(nb.currentPage(), {text, size: +sz.value, rep: clamp(+$('.tr-rep', p).value || 1, 1, 10), style});
  };
  $('.tr-apply', p).onclick = apply;
  $('.tr-text', p).onkeydown = e => { if (e.key === 'Enter') apply(); };
  $('.tr-clear', p).onclick = () => { $('.tr-text', p).value = ''; nb.setTrace(nb.currentPage(), {text: ''}); };
}

function createNotebook(host, opts) {
  opts = opts || {};
  const nb = {
    pages: [], readOnly: !!opts.readOnly, onOps: opts.onOps || null,
    color: '#1d4ed8', width: 4, brushWidth: 16, eraserWidth: 24, tool: 'pen', els: [], mySid: [],
  };
  const newPage = tpl => ({tpl: tpl || opts.tpl || 'blank', trace: null, strokes: []});

  /* ---------------- rendering ---------------- */
  function pageEl(idx) { return nb.els[idx]; }
  function ensureDom() {
    while (nb.els.length > nb.pages.length) { const e = nb.els.pop(); e.wrap.remove(); }
    while (nb.els.length < nb.pages.length) {
      const i = nb.els.length;
      const wrap = document.createElement('div');
      wrap.className = 'nb-page';
      wrap.innerHTML = `<div class="nb-num">${num(i + 1)}</div>
        <canvas class="nb-guide" width="${PG_W}" height="${PG_H}"></canvas>
        <canvas class="nb-ink" width="${PG_W}" height="${PG_H}"></canvas>
        <div class="nb-cursor" hidden></div>`;
      host.querySelector('.nb-scroll').appendChild(wrap);
      const ink = wrap.querySelector('.nb-ink');
      const rec = {wrap, ink, ictx: ink.getContext('2d'), guide: wrap.querySelector('.nb-guide'), cur: wrap.querySelector('.nb-cursor')};
      nb.els.push(rec);
      if (!nb.readOnly) wireDraw(rec, i);
    }
    nb.pages.forEach((p, i) => { nb.els[i].wrap.dataset.tpl = p.tpl; nb.els[i].wrap.className = 'nb-page pg-' + p.tpl; });
  }
  function drawStroke(ictx, s) {
    const p = s.p; if (!p || p.length < 2) return;
    ictx.save();
    ictx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
    ictx.strokeStyle = s.c || '#111'; ictx.lineJoin = ictx.lineCap = 'round';
    ictx.lineWidth = s.w || 4;                       // eraser width is already absolute
    if (s.b) { ictx.globalAlpha = 0.75; ictx.lineWidth = (s.w || 4); }   // brush: soft paint
    ictx.beginPath(); ictx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ictx.lineTo(p[i], p[i + 1]);
    if (p.length === 2) ictx.lineTo(p[0] + 0.1, p[1] + 0.1);
    ictx.stroke(); ictx.restore();
  }
  /* the width actually painted, per tool — eraser and brush have their own scales */
  function activeWidth() {
    if (nb.tool === 'eraser') return nb.eraserWidth;
    if (nb.tool === 'brush') return nb.brushWidth;
    return nb.width;
  }
  function repaint(i) {
    const rec = nb.els[i], pg = nb.pages[i]; if (!rec) return;
    rec.ictx.clearRect(0, 0, PG_W, PG_H);
    pg.strokes.forEach(s => drawStroke(rec.ictx, s));
    paintGuide(i);
  }
  /* guide layer = ruled template + (optional) dotted tracing model.
     Drawn on canvas, not CSS gradients, so dashes and 4-line groups are exact. */
  function paintGuide(i) {
    const rec = nb.els[i], pg = nb.pages[i]; if (!rec) return;
    const ctx = rec.guide.getContext('2d');
    ctx.clearRect(0, 0, PG_W, PG_H);
    drawTemplate(ctx, pg.tpl);
    drawTraceText(ctx, pg.trace);
  }

  /* ---------------- ops ---------------- */
  function applyOp(o, local) {
    if (o.k === 'ap') { if (nb.pages.length < MAX_PAGES) { nb.pages.push(newPage(o.tpl)); ensureDom(); repaint(nb.pages.length - 1); } return; }
    const i = Math.max(0, Math.min(nb.pages.length - 1, Number(o.pg) || 0));
    const pg = nb.pages[i]; if (!pg) return;
    if (o.k === 's') { pg.strokes.push(o); if (nb.els[i]) drawStroke(nb.els[i].ictx, o); }
    else if (o.k === 'u') { const n = pg.strokes.length; pg.strokes = pg.strokes.filter(s => s.sid !== o.sid); if (pg.strokes.length !== n) repaint(i); }
    else if (o.k === 'c') { pg.strokes = []; repaint(i); }
    else if (o.k === 't') { pg.tpl = o.v; ensureDom(); paintGuide(i); }
    else if (o.k === 'tr') { pg.trace = {text: o.text, size: o.size, rep: o.rep, style: o.style}; paintGuide(i); }
  }
  function emit(op) { if (nb.onOps) nb.onOps([op]); }

  /* ---------------- input ---------------- */
  function wireDraw(rec, idx) {
    let drawing = false, pts = null;
    const pos = e => { const r = rec.ink.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * (PG_W / r.width)), Math.round((e.clientY - r.top) * (PG_H / r.height))]; };
    rec.ink.addEventListener('pointerdown', e => {
      if (nb.readOnly) return;
      drawing = true; try { rec.ink.setPointerCapture(e.pointerId); } catch (x) {}
      pts = pos(e);
      e.preventDefault();
    });
    // live size cursor: a circle showing exactly what the pen/brush/eraser covers
    const showCursor = e => {
      const r = rec.ink.getBoundingClientRect(), scale = r.width / PG_W;
      const d = Math.max(6, activeWidth() * scale);
      rec.cur.hidden = false;
      rec.cur.style.width = rec.cur.style.height = d + 'px';
      rec.cur.style.left = (e.clientX - r.left) + 'px';
      rec.cur.style.top = (e.clientY - r.top) + 'px';
      rec.cur.dataset.tool = nb.tool;
      rec.cur.style.borderColor = nb.tool === 'eraser' ? '#dc2626' : nb.color;
    };
    rec.ink.addEventListener('pointerenter', showCursor);
    rec.ink.addEventListener('pointerleave', () => { rec.cur.hidden = true; });
    rec.ink.addEventListener('pointermove', e => {
      showCursor(e);
      if (!drawing) return;
      const p = pos(e), n = pts.length;
      // skip micro-moves to keep ops small
      if (Math.abs(p[0] - pts[n - 2]) + Math.abs(p[1] - pts[n - 1]) < 2) return;
      pts.push(p[0], p[1]);
      drawStroke(rec.ictx, {p: [pts[n - 2], pts[n - 1], p[0], p[1]], c: nb.color, w: activeWidth(),
        e: nb.tool === 'eraser' ? 1 : 0, b: nb.tool === 'brush' ? 1 : 0});
    });
    const end = () => {
      if (!drawing) return; drawing = false;
      const op = {k: 's', pg: idx, sid: uid(), p: pts, c: nb.color, w: activeWidth(),
        e: nb.tool === 'eraser' ? 1 : 0, b: nb.tool === 'brush' ? 1 : 0};
      nb.pages[idx].strokes.push(op); nb.mySid.push({pg: idx, sid: op.sid});
      emit(op); pts = null;
    };
    rec.ink.addEventListener('pointerup', end);
    rec.ink.addEventListener('pointercancel', end);
    rec.ink.addEventListener('pointerleave', end);
  }

  /* ---------------- public API ---------------- */
  nb.mount = function (pages) {
    host.innerHTML = `<div class="nb-scroll"></div>`;
    nb.pages = (pages && pages.length ? pages : [newPage()]).map(p => ({tpl: p.tpl || 'blank', trace: p.trace || null, strokes: (p.strokes || []).slice()}));
    nb.els = []; ensureDom(); nb.pages.forEach((p, i) => repaint(i));
  };
  nb.applyRemote = function (ops) { (ops || []).forEach(o => applyOp(o, false)); };
  nb.addPage = function (tpl) {
    if (nb.pages.length >= MAX_PAGES) return toast('الحد الأقصى ' + num(MAX_PAGES) + ' صفحات', 'err');
    const op = {k: 'ap', tpl: tpl || nb.pages[nb.pages.length - 1].tpl};
    applyOp(op, true); emit(op);
    const last = nb.els[nb.els.length - 1]; if (last) last.wrap.scrollIntoView({behavior: 'smooth', block: 'start'});
  };
  nb.setTemplate = function (i, v) { const op = {k: 't', pg: i, v}; applyOp(op, true); emit(op); };
  nb.setTrace = function (i, tr) { const op = Object.assign({k: 'tr', pg: i}, tr); applyOp(op, true); emit(op); };
  nb.clearPage = function (i) { const op = {k: 'c', pg: i}; applyOp(op, true); emit(op); };
  nb.undo = function () {
    const last = nb.mySid.pop(); if (!last) return;
    const op = {k: 'u', pg: last.pg, sid: last.sid}; applyOp(op, true); emit(op);
  };
  nb.currentPage = function () {
    // page whose centre is nearest the viewport centre
    const mid = window.innerHeight / 2; let best = 0, bd = 1e9;
    nb.els.forEach((e, i) => { const r = e.wrap.getBoundingClientRect(); const d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  nb.exportPage = function (i) {
    const c = document.createElement('canvas'); c.width = PG_W; c.height = PG_H;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, PG_W, PG_H);
    const rec = nb.els[i]; if (!rec) return c;
    // paint the CSS guide by rasterising it is not possible — draw a light grid hint instead
    x.drawImage(rec.trace, 0, 0); x.drawImage(rec.ink, 0, 0);
    return c;
  };
  nb.getPages = function () { return nb.pages.map(p => ({tpl: p.tpl, trace: p.trace, strokes: p.strokes})); };
  return nb;
}

/* toolbar shared by the practice board and the live class */
function notebookToolbar(nb, o) {
  o = o || {};
  return `<div class="board-tools">
      <div class="bt-group" id="${o.id}-tpl">${NB_TPLS.map(t => `<button class="tpl-btn" data-tpl="${t.k}">${t.g} ${t.t}</button>`).join('')}</div>
    </div>
    <div class="board-tools">
      <div class="bt-group">${['#111827', '#1d4ed8', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#db2777', '#0891b2'].map((c, i) => `<button class="color-sw ${i === 1 ? 'on' : ''}" style="background:${c}" data-color="${c}"></button>`).join('')}</div>
      <div class="bt-group">
        <button class="tool-btn on" data-tool="pen" title="قلم">✏️</button>
        <button class="tool-btn" data-tool="brush" title="فرشاة تلوين">🖌️</button>
        <button class="tool-btn" data-tool="eraser" title="ممحاة">🧽</button>
      </div>
      <div class="bt-group size-row">
        <span class="bt-size" id="size-label">سُمك القلم</span>
        ${[2, 4, 8, 14, 22].map((s, i) => `<button class="size-dot ${s === 4 ? 'on' : ''}" data-size="${s}" title="${s}"><i style="width:${Math.min(s, 16)}px;height:${Math.min(s, 16)}px"></i></button>`).join('')}
        <input class="pen-size" type="range" min="1" max="60" value="4" title="حجم دقيق">
        <span class="size-val">٤</span>
      </div>
      <div class="bt-group">
        <button class="btn sm" data-act="undo">↶ تراجع</button>
        <button class="btn sm danger" data-act="clear">🗑 مسح الصفحة</button>
        <button class="btn sm" data-act="addpage">➕ صفحة</button>
        ${o.noExport ? '' : `<button class="btn sm" data-act="save">⬇ حفظ</button><button class="btn sm" data-act="print">🖨 طباعة</button>`}
      </div>
    </div>`;
}
function wireNotebookToolbar(root, nb) {
  const LABEL = {pen: 'سُمك القلم', brush: 'حجم الفرشاة', eraser: 'حجم الممحاة'};
  const curSize = () => nb.tool === 'eraser' ? nb.eraserWidth : nb.tool === 'brush' ? nb.brushWidth : nb.width;
  const setSize = v => {
    v = clamp(Math.round(v), 1, 60);
    if (nb.tool === 'eraser') nb.eraserWidth = v; else if (nb.tool === 'brush') nb.brushWidth = v; else nb.width = v;
    syncSize();
  };
  function syncSize() {
    const ps = $('.pen-size', root), lab = $('#size-label', root), val = $('.size-val', root);
    if (ps) ps.value = curSize();
    if (lab) lab.textContent = LABEL[nb.tool] || 'الحجم';
    if (val) val.textContent = num(curSize());
    $$('[data-size]', root).forEach(x => x.classList.toggle('on', +x.dataset.size === curSize()));
  }
  const pickTool = t => { nb.tool = t; $$('[data-tool]', root).forEach(x => x.classList.toggle('on', x.dataset.tool === t)); syncSize(); };
  $$('[data-color]', root).forEach(b => b.onclick = () => {
    nb.color = b.dataset.color;
    if (nb.tool === 'eraser') pickTool('pen');
    $$('[data-color]', root).forEach(x => x.classList.toggle('on', x === b));
  });
  $$('[data-tool]', root).forEach(b => b.onclick = () => pickTool(b.dataset.tool));
  $$('[data-size]', root).forEach(b => b.onclick = () => setSize(+b.dataset.size));
  const ps = $('.pen-size', root); if (ps) ps.oninput = e => setSize(+e.target.value);
  syncSize();
  $$('[data-tpl]', root).forEach(b => b.onclick = () => { const i = nb.currentPage(); nb.setTemplate(i, b.dataset.tpl); $$('[data-tpl]', root).forEach(x => x.classList.toggle('on', x === b)); });
  $$('[data-act]', root).forEach(b => b.onclick = () => {
    const a = b.dataset.act, i = nb.currentPage();
    if (a === 'undo') nb.undo();
    else if (a === 'clear') armed(b, () => nb.clearPage(i));
    else if (a === 'addpage') nb.addPage();
    else if (a === 'save') { const c = nb.exportPage(i); const link = document.createElement('a'); link.download = 'OLS-صفحة-' + (i + 1) + '.png'; link.href = c.toDataURL('image/png'); link.click(); }
    else if (a === 'print') { const url = nb.exportPage(i).toDataURL('image/png'); const w = window.open(''); if (w) { w.document.write('<img src="' + url + '" style="width:100%" onload="print()">'); w.document.close(); } }
  });
}

/* ---- Practice board page (standalone, single user) ---- */
PAGES.board = function () {
  crumb('التمارين · اللوحة', 'كتابة ورسم وتتبّع');
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🎨 لوحة التدريب والكتابة</h2><p>دفتر A4 متعدّد الصفحات — اكتب وارسم ولوّن، وبدّل نوع التسطير لكل صفحة.</p></div>
      <a class="btn" href="#/exercises">◀ التمارين</a></div>
    ${notebookToolbar(null, {id: 'bd'})}
    ${tracePanelHtml()}
    <div id="nb-host" class="nb-host"></div>`;
  const nb = createNotebook($('#nb-host'), {tpl: Store.lget('board-tpl', 'arabic')});
  nb.mount(Store.lget('board-pages', null));
  wireNotebookToolbar($('#view'), nb);
  wireTracePanel($('#view'), nb);
  $$('[data-tpl]').forEach(b => b.classList.toggle('on', b.dataset.tpl === Store.lget('board-tpl', 'arabic')));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => nb.applyRemote([]));
};

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
  params = params || [];
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

/* ======================= ACADEMY: classes · enrolment · fees ==============
   Structure: المستوى (1–12) ← المادة ← المعلّم ← الصف (class section).
   Teachers create classes (admin approves); students request enrolment in a
   class (teacher or admin approves). Every approved enrolment can carry a fee
   invoice, attendance records, graded work, and finally a certificate.
   All records live in the synced KV store so every device sees the same data.
   ========================================================================= */
const SUBJECTS_ALL = ['اللغة العربية', 'اللغة الإنجليزية', 'الرياضيات', 'العلوم', 'التربية الإسلامية',
  'الدراسات الاجتماعية', 'الفيزياء', 'الكيمياء', 'الأحياء', 'تقنية المعلومات',
  'الفنون التشكيلية', 'المهارات الموسيقية', 'الرياضة المدرسية', 'المهارات الحياتية'];

function classes() { return Store.get('classes', []); }
function saveClasses(v) { Store.set('classes', v); }
function enrolments() { return Store.get('enrolments', []); }
function saveEnrolments(v) { Store.set('enrolments', v); }
function attendance() { return Store.get('attendance', []); }
function saveAttendance(v) { Store.set('attendance', v); }
function fees() { return Store.get('fees', []); }
function saveFees(v) { Store.set('fees', v); }
function gradeItems() { return Store.get('gradeItems', []); }
function saveGradeItems(v) { Store.set('gradeItems', v); }
function certificates() { return Store.get('certificates', []); }
function saveCertificates(v) { Store.set('certificates', v); }

const classById = id => classes().find(c => c.id === id);
const myEnrolment = cid => enrolments().find(e => e.classId === cid && e.student === Auth.user.u);
const classRoster = cid => enrolments().filter(e => e.classId === cid && e.status === 'active');
function myClasses() {
  if (Auth.isTeacher) return classes().filter(c => c.teacher === Auth.user.u);
  if (Auth.isAdmin) return classes();
  if (Auth.isParent) { const ch = (meDir().child || ''); const ids = enrolments().filter(e => e.student === ch && e.status === 'active').map(e => e.classId); return classes().filter(c => ids.includes(c.id)); }
  const ids = enrolments().filter(e => e.student === Auth.user.u && e.status === 'active').map(e => e.classId);
  return classes().filter(c => ids.includes(c.id));
}
const canRunClass = c => c && (Auth.isAdmin || (Auth.isTeacher && c.teacher === Auth.user.u));
function canJoinClass(c) {
  if (!c) return false;
  if (canRunClass(c)) return true;
  const e = myEnrolment(c.id);
  return !!(e && e.status === 'active');
}
const OMR = n => num(Number(n || 0).toFixed(3)) + ' ر.ع';
/* weighted result → percentage, letter and pass/fail */
function classResult(cid, studentU) {
  const items = gradeItems().filter(g => g.classId === cid && g.student === studentU);
  if (!items.length) return null;
  let ws = 0, wt = 0;
  items.forEach(g => { const w = Number(g.weight) || 1; ws += (g.score / g.total) * 100 * w; wt += w; });
  const pct = Math.round(ws / wt);
  const letter = pct >= 90 ? 'ممتاز' : pct >= 80 ? 'جيد جدًا' : pct >= 70 ? 'جيد' : pct >= 60 ? 'مقبول' : pct >= 50 ? 'ضعيف' : 'راسب';
  return {pct, letter, pass: pct >= 60, items};
}
function attendanceRate(cid, studentU) {
  const recs = attendance().filter(a => a.classId === cid);
  if (!recs.length) return null;
  const present = recs.filter(a => (a.records || {})[studentU] === 'present' || (a.records || {})[studentU] === 'late').length;
  return {rate: Math.round(present / recs.length * 100), present, total: recs.length};
}

/* ------------------------------- pages ---------------------------------- */
PAGES.classes = function (params) {
  params = params || [];                       // also called internally with no args
  crumb('الصفوف الدراسية', 'المستوى ← المادة ← المعلّم');
  const tab = params[0] || Store.lget('cls-tab', Auth.isStudent ? 'browse' : 'mine');
  Store.lset('cls-tab', tab);
  const tabs = [
    {k: 'mine', t: Auth.isTeacher ? '📗 صفوفي التدريسية' : '🎒 صفوفي'},
    {k: 'browse', t: '🔎 تصفّح الصفوف'},
  ];
  if (Auth.isAdmin) tabs.push({k: 'admin', t: '⚙️ الاعتمادات'});
  if (Auth.isAdmin || Auth.isTeacher) tabs.push({k: 'fees', t: '💳 الرسوم'});
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🏫 الصفوف الدراسية</h2><p>نظام متكامل: تسجيل، حضور، تقييم، وشهادات — مصنّف حسب المستوى والمادة والمعلّم.</p></div>
      ${(Auth.isTeacher || Auth.isAdmin) ? `<button class="btn primary" id="new-class">➕ إنشاء صف</button>` : ''}</div>
    <div class="chip-row">${tabs.map(t => `<button class="tab-chip ${t.k === tab ? 'active' : ''}" data-ctab="${t.k}">${t.t}</button>`).join('')}</div>
    <div id="cls-body"></div>`;
  $$('[data-ctab]').forEach(b => b.onclick = () => { Store.lset('cls-tab', b.dataset.ctab); PAGES.classes([b.dataset.ctab]); });
  const nc = $('#new-class'); if (nc) nc.onclick = () => classModal();
  const body = $('#cls-body');
  if (tab === 'browse') renderBrowse(body);
  else if (tab === 'admin') renderClassAdmin(body);
  else if (tab === 'fees') renderFees(body);
  else renderMyClasses(body);
};
function classCard(c, ctx) {
  const roster = classRoster(c.id).length;
  const en = Auth.isStudent ? myEnrolment(c.id) : null;
  const live = c.live && c.live.active;
  return `<div class="class-card ${live ? 'live' : ''}">
    <div class="cc-head" style="background:linear-gradient(135deg,${['#0e7c66', '#2563eb', '#7c3aed', '#e11d64', '#d97706'][Math.abs(hashStr(c.subject || '')) % 5]},#12a37d)">
      <div class="cc-sub">${subjIcon(c.subject)} ${esc(c.subject)}</div>
      <div class="cc-title">${esc(c.title || c.subject)}</div>
      <div class="cc-meta">${esc(gradeName(c.grade))}</div>
      ${live ? `<span class="live-dot">● مباشر الآن</span>` : ''}
      ${c.status === 'pending' ? `<span class="cc-flag">بانتظار اعتماد المدير</span>` : ''}
    </div>
    <div class="cc-body">
      <div class="cc-row">👨‍🏫 <b>${esc(c.teacherName || c.teacher)}</b></div>
      ${c.schedule ? `<div class="cc-row muted">🗓 ${esc(c.schedule)}</div>` : ''}
      <div class="cc-row muted">👥 ${num(roster)}${c.capacity ? ' / ' + num(c.capacity) : ''} طالب · ${Number(c.fee) > 0 ? '💳 ' + OMR(c.fee) : 'مجاني'}</div>
    </div>
    <div class="cc-actions">
      ${canJoinClass(c) && c.status === 'active' ? `<button class="btn sm primary" data-live="${esc(c.id)}">🔴 الحصة المباشرة</button>` : ''}
      ${(canRunClass(c) || (en && en.status === 'active') || Auth.isParent) ? `<button class="btn sm" data-open="${esc(c.id)}">التفاصيل</button>` : ''}
      ${(Auth.isStudent && c.status === 'active') ? (
        !en ? `<button class="btn sm gold" data-enrol="${esc(c.id)}">📝 طلب تسجيل</button>`
        : en.status === 'pending' ? `<span class="pill gold">طلبك بانتظار الاعتماد</span>`
        : en.status === 'rejected' ? `<span class="pill" style="background:#fdeaea;color:var(--danger)">مرفوض</span>` : '') : ''}
    </div></div>`;
}
function wireClassCards(root) {
  $$('[data-live]', root).forEach(b => b.onclick = () => go('live/' + b.dataset.live));
  $$('[data-open]', root).forEach(b => b.onclick = () => classDetail(b.dataset.open));
  $$('[data-enrol]', root).forEach(b => b.onclick = () => requestEnrolment(b.dataset.enrol));
}
function renderMyClasses(host) {
  const list = myClasses().filter(c => Auth.isAdmin || c.status !== 'rejected');
  host.innerHTML = list.length ? `<div class="class-grid">${list.map(c => classCard(c)).join('')}</div>`
    : `<div class="empty"><div class="big">🏫</div>${Auth.isTeacher ? 'لم تنشئ صفوفًا بعد — اضغط «إنشاء صف».' : 'لست مسجّلًا في أي صف بعد — تصفّح الصفوف واطلب التسجيل.'}</div>`;
  wireClassCards(host);
}
function renderBrowse(host) {
  const all = classes().filter(c => c.status === 'active' && visibleTo({grade: c.grade}));
  if (!all.length) { host.innerHTML = `<div class="empty"><div class="big">🔎</div>لا توجد صفوف معتمدة بعد.</div>`; return; }
  const byGrade = {};
  all.forEach(c => (byGrade[c.grade] = byGrade[c.grade] || []).push(c));
  host.innerHTML = Object.keys(byGrade).sort((a, b) => a - b).map(g => {
    const bySub = {};
    byGrade[g].forEach(c => (bySub[c.subject] = bySub[c.subject] || []).push(c));
    return `<div class="section-title">🎓 ${esc(gradeName(+g))}</div>` +
      Object.keys(bySub).map(sub => `<div class="browse-sub">${subjIcon(sub)} ${esc(sub)}
        <span class="muted" style="font-weight:400;font-size:.8rem">— ${num(bySub[sub].length)} صف · ${num(new Set(bySub[sub].map(c => c.teacher)).size)} معلّم</span></div>
        <div class="class-grid">${bySub[sub].map(c => classCard(c)).join('')}</div>`).join('');
  }).join('');
  wireClassCards(host);
}
function renderClassAdmin(host) {
  const pend = classes().filter(c => c.status === 'pending');
  const pendEn = enrolments().filter(e => e.status === 'pending');
  host.innerHTML = `
    <div class="section-title">🏫 صفوف بانتظار الاعتماد (${num(pend.length)})</div>
    ${pend.length ? `<div class="class-grid">${pend.map(c => classCard(c)).join('')}</div>
      <div class="row" style="margin:10px 0">${pend.map(c => `<button class="btn sm primary" data-appc="${esc(c.id)}">✔ اعتماد: ${esc(c.title || c.subject)}</button>`).join('')}</div>`
      : `<p class="muted">لا توجد صفوف بانتظار الاعتماد.</p>`}
    <div class="section-title">📝 طلبات تسجيل الطلبة (${num(pendEn.length)})</div>
    ${pendEn.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <tr><th>الطالب</th><th>الصف</th><th>المعلّم</th><th>الرسوم</th><th>إجراء</th></tr>
      ${pendEn.map(e => { const c = classById(e.classId) || {}; return `<tr>
        <td><b>${esc(e.studentName)}</b><br><span class="muted" style="font-size:.75rem">@${esc(e.student)}</span></td>
        <td>${esc(c.title || c.subject || '—')}<br><span class="muted" style="font-size:.75rem">${esc(gradeName(c.grade))}</span></td>
        <td>${esc(c.teacherName || '—')}</td><td>${Number(c.fee) > 0 ? OMR(c.fee) : 'مجاني'}</td>
        <td><div class="row" style="gap:5px"><button class="btn sm primary" data-appe="${esc(e.id)}">قبول</button><button class="btn sm danger" data-reje="${esc(e.id)}">رفض</button></div></td></tr>`; }).join('')}</table></div>`
      : `<p class="muted">لا توجد طلبات تسجيل.</p>`}`;
  wireClassCards(host);
  $$('[data-appc]', host).forEach(b => b.onclick = () => { const cs = classes(); const c = cs.find(x => x.id === b.dataset.appc); if (c) { c.status = 'active'; saveClasses(cs); toast('تم اعتماد الصف', 'ok'); PAGES.classes(['admin']); } });
  $$('[data-appe]', host).forEach(b => b.onclick = () => decideEnrolment(b.dataset.appe, 'active'));
  $$('[data-reje]', host).forEach(b => b.onclick = () => decideEnrolment(b.dataset.reje, 'rejected'));
}
function decideEnrolment(id, status) {
  const es = enrolments(); const e = es.find(x => x.id === id); if (!e) return;
  e.status = status; e.decidedBy = Auth.user.u; e.decidedAt = Date.now();
  saveEnrolments(es);
  if (status === 'active') {
    const c = classById(e.classId);
    if (c && Number(c.fee) > 0 && !fees().some(f => f.classId === c.id && f.student === e.student)) {
      const fs = fees();
      fs.push({id: uid(), classId: c.id, student: e.student, studentName: e.studentName, amount: Number(c.fee),
        status: 'unpaid', issued: Date.now(), term: c.term || ''});
      saveFees(fs);
    }
  }
  toast(status === 'active' ? 'تم قبول الطالب' : 'تم رفض الطلب', 'ok');
  PAGES.classes();
}
function requestEnrolment(cid) {
  const c = classById(cid); if (!c) return;
  const roster = classRoster(cid).length;
  const body = `<p>سيتم إرسال طلب تسجيلك في صف <b>${esc(c.title || c.subject)}</b> — ${esc(gradeName(c.grade))} مع المعلّم <b>${esc(c.teacherName)}</b>.</p>
    ${c.schedule ? `<p class="muted">🗓 ${esc(c.schedule)}</p>` : ''}
    <div class="card" style="background:var(--panel-2)">
      <div class="row"><b>الرسوم:</b> <span>${Number(c.fee) > 0 ? OMR(c.fee) : 'مجاني'}</span></div>
      ${Number(c.fee) > 0 ? `<p class="muted" style="font-size:.8rem;margin:.5em 0 0">تُصدَر فاتورة الرسوم عند قبول طلبك، وتُسدَّد لدى إدارة المدرسة ثم يعتمدها المدير في النظام.</p>` : ''}
      ${c.capacity ? `<p class="muted" style="font-size:.8rem;margin:.4em 0 0">المقاعد: ${num(roster)} / ${num(c.capacity)}</p>` : ''}
    </div>`;
  const m = modal('طلب تسجيل في صف', body, `<button class="btn primary" id="en-go">إرسال الطلب</button>`);
  $('#en-go', m.el).onclick = () => {
    if (c.capacity && roster >= c.capacity) { m.close(); return toast('اكتمل العدد في هذا الصف.', 'err'); }
    const es = enrolments();
    es.push({id: uid(), classId: cid, student: Auth.user.u, studentName: Auth.user.name, status: 'pending', requested: Date.now()});
    saveEnrolments(es); m.close(); toast('تم إرسال الطلب — بانتظار الاعتماد', 'ok'); PAGES.classes();
  };
}
function classModal(existing) {
  const c = existing || {};
  const body = `
    <div class="row" style="gap:10px">
      <div class="field" style="flex:1"><label>المستوى</label><select id="c-grade">${DATA.levels.map(l => `<option value="${l.grade}" ${c.grade === l.grade ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>المادة</label><select id="c-sub">${SUBJECTS_ALL.map(s => `<option ${c.subject === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>اسم الصف / الشعبة</label><input id="c-title" value="${esc(c.title || '')}" placeholder="مثال: رياضيات ٥ — شعبة أ"></div>
    ${Auth.isAdmin ? `<div class="field"><label>المعلّم</label><select id="c-teacher">${DIRECTORY.filter(u => u.role === 'معلم').map(t => `<option value="${esc(t.u)}" ${c.teacher === t.u ? 'selected' : ''}>${esc(t.name)}</option>`).join('') || '<option value="">— لا يوجد معلمون معتمدون —</option>'}</select></div>` : ''}
    <div class="row" style="gap:10px">
      <div class="field" style="flex:1"><label>المواعيد</label><input id="c-sched" value="${esc(c.schedule || '')}" placeholder="الأحد والثلاثاء ٥:٠٠م"></div>
      <div class="field" style="width:110px"><label>الرسوم (ر.ع)</label><input id="c-fee" type="number" step="0.5" value="${c.fee || 0}"></div>
      <div class="field" style="width:100px"><label>عدد المقاعد</label><input id="c-cap" type="number" value="${c.capacity || 25}"></div>
    </div>
    <div class="field"><label>وصف موجز</label><textarea id="c-desc" rows="2">${esc(c.desc || '')}</textarea></div>`;
  const m = modal(existing ? 'تعديل الصف' : 'إنشاء صف جديد', body, `<button class="btn primary" id="c-save">${existing ? 'حفظ' : 'إنشاء'}</button>`);
  $('#c-save', m.el).onclick = () => {
    const cs = classes();
    const item = existing ? cs.find(x => x.id === existing.id) : {id: uid(), created: Date.now()};
    item.grade = +$('#c-grade', m.el).value; item.subject = $('#c-sub', m.el).value;
    item.title = $('#c-title', m.el).value.trim() || item.subject;
    item.schedule = $('#c-sched', m.el).value.trim(); item.fee = Number($('#c-fee', m.el).value) || 0;
    item.capacity = Number($('#c-cap', m.el).value) || 0; item.desc = $('#c-desc', m.el).value.trim();
    const tSel = $('#c-teacher', m.el);
    if (tSel && tSel.value) { item.teacher = tSel.value; const t = DIRECTORY.find(x => x.u === tSel.value); item.teacherName = t ? t.name : tSel.value; }
    else if (!existing) { item.teacher = Auth.user.u; item.teacherName = Auth.user.name; }
    if (!existing) { item.status = Auth.isAdmin ? 'active' : 'pending'; cs.push(item); }
    saveClasses(cs); m.close();
    toast(existing ? 'تم الحفظ' : (Auth.isAdmin ? 'تم إنشاء الصف' : 'أُرسل الصف لاعتماد المدير'), 'ok');
    PAGES.classes();
  };
}

/* ---- class detail: roster · attendance · grades · certificate ---- */
function classDetail(cid) {
  const c = classById(cid); if (!c) return;
  const staff = canRunClass(c);
  const roster = classRoster(cid);
  const body = `
    <div class="row" style="gap:8px;margin-bottom:10px">
      <span class="pill teal">${subjIcon(c.subject)} ${esc(c.subject)}</span>
      <span class="pill">${esc(gradeName(c.grade))}</span>
      <span class="pill">👨‍🏫 ${esc(c.teacherName)}</span>
      ${Number(c.fee) > 0 ? `<span class="pill gold">💳 ${OMR(c.fee)}</span>` : '<span class="pill">مجاني</span>'}
    </div>
    ${c.desc ? `<p class="muted">${esc(c.desc)}</p>` : ''}
    <div class="chip-row" id="cd-tabs">
      <button class="tab-chip active" data-cd="roster">👥 الطلبة</button>
      <button class="tab-chip" data-cd="att">🗓 الحضور</button>
      <button class="tab-chip" data-cd="grades">📊 الدرجات</button>
      <button class="tab-chip" data-cd="cert">🏅 الشهادات</button>
    </div>
    <div id="cd-body"></div>`;
  const foot = `${canJoinClass(c) ? `<button class="btn primary" id="cd-live">🔴 دخول الحصة المباشرة</button>` : ''}
    ${staff ? `<button class="btn" id="cd-edit">✏️ تعديل</button>` : ''}
    ${Auth.isAdmin ? `<button class="btn danger" id="cd-del">🗑 حذف الصف</button>` : ''}`;
  const m = modal(c.title || c.subject, body, foot, {wide: true});
  const bodyEl = $('#cd-body', m.el);
  const paint = tab => {
    if (tab === 'att') renderAttendance(bodyEl, c, roster, staff);
    else if (tab === 'grades') renderGrades(bodyEl, c, roster, staff);
    else if (tab === 'cert') renderCerts(bodyEl, c, roster, staff);
    else renderRoster(bodyEl, c, staff);
  };
  $$('[data-cd]', m.el).forEach(b => b.onclick = () => { $$('[data-cd]', m.el).forEach(x => x.classList.toggle('active', x === b)); paint(b.dataset.cd); });
  paint('roster');
  const lv = $('#cd-live', m.el); if (lv) lv.onclick = () => { m.close(); go('live/' + cid); };
  const ed = $('#cd-edit', m.el); if (ed) ed.onclick = () => { m.close(); classModal(c); };
  const dl = $('#cd-del', m.el); if (dl) dl.onclick = () => armed(dl, () => { saveClasses(classes().filter(x => x.id !== cid)); m.close(); toast('تم الحذف', 'ok'); PAGES.classes(); });
}
function renderRoster(host, c, staff) {
  const roster = classRoster(c.id);
  const pend = enrolments().filter(e => e.classId === c.id && e.status === 'pending');
  host.innerHTML = `
    ${staff && pend.length ? `<div class="card" style="border-color:var(--gold);margin-bottom:10px">
      <b>⏳ ${num(pend.length)} طلب تسجيل</b>
      <div class="row" style="margin-top:8px">${pend.map(e => `<span class="row" style="gap:4px"><b>${esc(e.studentName)}</b>
        <button class="btn sm primary" data-appe2="${esc(e.id)}">قبول</button><button class="btn sm danger" data-reje2="${esc(e.id)}">رفض</button></span>`).join('')}</div></div>` : ''}
    ${roster.length ? `<table class="tbl"><tr><th>الطالب</th><th>الحضور</th><th>التقييم</th><th>الرسوم</th></tr>
      ${roster.map(e => {
        const at = attendanceRate(c.id, e.student), r = classResult(c.id, e.student);
        const f = fees().find(x => x.classId === c.id && x.student === e.student);
        return `<tr><td><a class="lnk" href="#/profile/${esc(e.student)}"><b>${esc(e.studentName)}</b> 🪪</a></td>
          <td>${at ? num(at.rate) + '%' : '—'}</td>
          <td>${r ? `<b>${num(r.pct)}%</b> · ${esc(r.letter)}` : '—'}</td>
          <td>${f ? (f.status === 'paid' ? '<span class="pill teal">مسدّدة</span>' : f.status === 'waived' ? '<span class="pill">معفاة</span>' : '<span class="pill gold">غير مسدّدة</span>') : (Number(c.fee) > 0 ? '—' : 'مجاني')}</td></tr>`;
      }).join('')}</table>` : `<div class="empty">لا يوجد طلبة مسجّلون بعد.</div>`}`;
  $$('[data-appe2]', host).forEach(b => b.onclick = () => { decideEnrolment(b.dataset.appe2, 'active'); renderRoster(host, c, staff); });
  $$('[data-reje2]', host).forEach(b => b.onclick = () => { decideEnrolment(b.dataset.reje2, 'rejected'); renderRoster(host, c, staff); });
}
function renderAttendance(host, c, roster, staff) {
  const recs = attendance().filter(a => a.classId === c.id).sort((a, b) => b.date.localeCompare(a.date));
  const today = new Date().toISOString().slice(0, 10);
  host.innerHTML = `
    ${staff ? `<div class="row" style="margin-bottom:10px"><input id="at-date" type="date" value="${today}" style="padding:.5em;border:1px solid var(--line);border-radius:10px">
      <button class="btn sm primary" id="at-take">🗓 كشف حضور اليوم</button></div>` : ''}
    ${recs.length ? `<div style="max-height:300px;overflow:auto"><table class="tbl"><tr><th>التاريخ</th><th>حاضر</th><th>غائب</th><th>متأخر</th></tr>
      ${recs.map(a => { const v = Object.values(a.records || {});
        return `<tr><td>${num(a.date)}</td><td>${num(v.filter(x => x === 'present').length)}</td><td>${num(v.filter(x => x === 'absent').length)}</td><td>${num(v.filter(x => x === 'late').length)}</td></tr>`; }).join('')}</table></div>`
      : `<div class="empty">لا توجد سجلات حضور بعد.</div>`}`;
  const tk = $('#at-take', host);
  if (tk) tk.onclick = () => {
    const date = $('#at-date', host).value || today;
    if (!roster.length) return toast('لا يوجد طلبة مسجّلون', 'err');
    const existing = attendance().find(a => a.classId === c.id && a.date === date);
    const cur = (existing && existing.records) || {};
    const b = `<p class="muted">حدّد حالة كل طالب ليوم ${num(date)}</p>
      ${roster.map(e => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:.45em 0">
        <b>${esc(e.studentName)}</b>
        <span class="seg"><button class="seg-btn ${cur[e.student] === 'present' ? 'on' : ''}" data-at="${esc(e.student)}" data-v="present">حاضر</button>
        <button class="seg-btn ${cur[e.student] === 'late' ? 'on' : ''}" data-at="${esc(e.student)}" data-v="late">متأخر</button>
        <button class="seg-btn ${cur[e.student] === 'absent' ? 'on' : ''}" data-at="${esc(e.student)}" data-v="absent">غائب</button></span></div>`).join('')}`;
    const mm = modal('كشف الحضور — ' + num(date), b, `<button class="btn primary" id="at-save">حفظ الكشف</button>`);
    const picks = Object.assign({}, cur);
    $$('[data-at]', mm.el).forEach(btn => btn.onclick = () => {
      picks[btn.dataset.at] = btn.dataset.v;
      $$(`[data-at="${btn.dataset.at}"]`, mm.el).forEach(x => x.classList.toggle('on', x === btn));
    });
    $('#at-save', mm.el).onclick = () => {
      const all = attendance(); const rec = all.find(a => a.classId === c.id && a.date === date);
      if (rec) rec.records = picks; else all.push({id: uid(), classId: c.id, date, records: picks, by: Auth.user.u});
      saveAttendance(all); mm.close(); toast('تم حفظ الحضور', 'ok'); renderAttendance(host, c, roster, staff);
    };
  };
}
function renderGrades(host, c, roster, staff) {
  const items = gradeItems().filter(g => g.classId === c.id);
  const mine = Auth.isStudent ? items.filter(g => g.student === Auth.user.u) : items;
  host.innerHTML = `
    ${staff ? `<button class="btn sm primary" id="g-add" style="margin-bottom:10px">➕ إضافة تقييم</button>` : ''}
    ${staff ? `<table class="tbl"><tr><th>الطالب</th><th>النتيجة المرجّحة</th><th>التقدير</th></tr>
      ${roster.map(e => { const r = classResult(c.id, e.student);
        return `<tr><td><b>${esc(e.studentName)}</b></td><td>${r ? num(r.pct) + '%' : '—'}</td><td>${r ? esc(r.letter) : '—'}</td></tr>`; }).join('')}</table>
      <div class="section-title">سجل التقييمات</div>` : ''}
    ${mine.length ? `<div style="max-height:260px;overflow:auto"><table class="tbl"><tr>${staff ? '<th>الطالب</th>' : ''}<th>النوع</th><th>العنوان</th><th>الدرجة</th><th>الوزن</th>${staff ? '<th></th>' : ''}</tr>
      ${mine.map(g => `<tr>${staff ? `<td>${esc(g.studentName)}</td>` : ''}<td>${esc(g.kind)}</td><td>${esc(g.title)}</td>
        <td><b>${num(g.score)}/${num(g.total)}</b></td><td>${num(g.weight || 1)}</td>
        ${staff ? `<td><button class="btn sm danger" data-gdel="${esc(g.id)}">🗑</button></td>` : ''}</tr>`).join('')}</table></div>`
      : `<div class="empty">لا توجد تقييمات بعد.</div>`}`;
  $$('[data-gdel]', host).forEach(b => b.onclick = () => { saveGradeItems(gradeItems().filter(x => x.id !== b.dataset.gdel)); renderGrades(host, c, roster, staff); });
  const ga = $('#g-add', host);
  if (ga) ga.onclick = () => {
    const b = `<div class="field"><label>الطالب</label><select id="g-st"><option value="__all">— جميع الطلبة —</option>${roster.map(e => `<option value="${esc(e.student)}">${esc(e.studentName)}</option>`).join('')}</select></div>
      <div class="row" style="gap:10px">
        <div class="field" style="flex:1"><label>النوع</label><select id="g-kind"><option>اختبار قصير</option><option>اختبار</option><option>امتحان نهائي</option><option>مشاركة</option><option>واجب</option></select></div>
        <div class="field" style="flex:1"><label>العنوان</label><input id="g-title" placeholder="الوحدة الأولى"></div>
      </div>
      <div class="row" style="gap:10px">
        <div class="field" style="flex:1"><label>الدرجة</label><input id="g-score" type="number" value="0"></div>
        <div class="field" style="flex:1"><label>من</label><input id="g-total" type="number" value="10"></div>
        <div class="field" style="flex:1"><label>الوزن</label><input id="g-w" type="number" value="1" step="0.5"></div>
      </div>`;
    const mm = modal('إضافة تقييم', b, `<button class="btn primary" id="g-save">حفظ</button>`);
    $('#g-save', mm.el).onclick = () => {
      const stu = $('#g-st', mm.el).value, all = gradeItems();
      const targets = stu === '__all' ? roster : roster.filter(e => e.student === stu);
      if (!targets.length) return toast('لا يوجد طلبة', 'err');
      targets.forEach(e => all.push({id: uid(), classId: c.id, student: e.student, studentName: e.studentName,
        kind: $('#g-kind', mm.el).value, title: $('#g-title', mm.el).value.trim() || $('#g-kind', mm.el).value,
        score: Number($('#g-score', mm.el).value) || 0, total: Number($('#g-total', mm.el).value) || 10,
        weight: Number($('#g-w', mm.el).value) || 1, date: Date.now(), by: Auth.user.u}));
      saveGradeItems(all); mm.close(); toast('تم حفظ التقييم', 'ok'); renderGrades(host, c, roster, staff);
    };
  };
}
function renderCerts(host, c, roster, staff) {
  const targets = staff ? roster : roster.filter(e => e.student === Auth.user.u);
  host.innerHTML = `<div class="row" style="justify-content:space-between;align-items:flex-start">
      <p class="muted" style="flex:1">تُصدر الشهادة بناءً على التقييم المرجّح للمادة${staff ? ' — يعتمدها المعلّم أو المدير.' : '.'}</p>
      <a class="btn sm" href="#/verify">🔎 تحقّق من شهادة</a></div>
    ${targets.length ? `<table class="tbl"><tr><th>الطالب</th><th>النتيجة</th><th>التقدير</th><th>الحضور</th><th></th></tr>
      ${targets.map(e => { const r = classResult(c.id, e.student), at = attendanceRate(c.id, e.student);
        const cert = certificates().find(x => x.classId === c.id && x.student === e.student);
        return `<tr><td><b>${esc(e.studentName)}</b></td>
          <td>${r ? num(r.pct) + '%' : '—'}</td><td>${r ? esc(r.letter) : '—'}</td><td>${at ? num(at.rate) + '%' : '—'}</td>
          <td>${cert ? `<button class="btn sm" data-cview="${esc(cert.id)}">🏅 عرض الشهادة</button>`
            : (staff && r && r.pass) ? `<button class="btn sm primary" data-cissue="${esc(e.student)}">إصدار</button>`
            : (r && !r.pass) ? '<span class="muted" style="font-size:.78rem">لم يجتز</span>' : '<span class="muted" style="font-size:.78rem">—</span>'}</td></tr>`; }).join('')}</table>`
      : `<div class="empty">لا يوجد طلبة.</div>`}`;
  $$('[data-cissue]', host).forEach(b => b.onclick = () => {
    const e = roster.find(x => x.student === b.dataset.cissue); const r = classResult(c.id, e.student);
    const cs = certificates();
    const cert = {id: uid(), serial: 'OLS-' + String(Date.now()).slice(-8), classId: c.id, student: e.student,
      studentName: e.studentName, subject: c.subject, grade: c.grade, className: c.title || '', percent: r.pct, letter: r.letter,
      teacherName: c.teacherName, issued: Date.now(), issuedBy: Auth.user.name};
    cs.push(cert); saveCertificates(cs); toast('تم إصدار الشهادة 🏅', 'ok'); renderCerts(host, c, roster, staff);
  });
  $$('[data-cview]', host).forEach(b => b.onclick = () => showCertificate(b.dataset.cview));
}
/* ---- fees ledger (records only — no card processing) ---- */
function renderFees(host) {
  const scope = Auth.isAdmin ? fees() : fees().filter(f => (classById(f.classId) || {}).teacher === Auth.user.u);
  const unpaid = scope.filter(f => f.status === 'unpaid');
  const total = scope.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount || 0), 0);
  host.innerHTML = `
    <div class="stat-tiles" style="margin-bottom:14px">
      <div class="stat"><div class="k">إجمالي الفواتير</div><div class="v">${num(scope.length)}</div></div>
      <div class="stat g"><div class="k">غير مسدّدة</div><div class="v">${num(unpaid.length)}</div></div>
      <div class="stat b"><div class="k">المحصّل</div><div class="v" style="font-size:1.3rem">${OMR(total)}</div></div>
      <div class="stat p"><div class="k">المستحق</div><div class="v" style="font-size:1.3rem">${OMR(unpaid.reduce((s, f) => s + Number(f.amount || 0), 0))}</div></div>
    </div>
    <p class="muted" style="font-size:.8rem">💡 هذا سجلّ مالي لتوثيق الرسوم والإيصالات. لا تتم معالجة بطاقات داخل التطبيق — يُسدَّد المبلغ لدى الإدارة (أو عبر بوابة دفع تُربط لاحقًا) ثم يُعتمد هنا.</p>
    ${scope.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <tr><th>الطالب</th><th>الصف</th><th>المبلغ</th><th>الحالة</th><th>إجراء</th></tr>
      ${scope.map(f => { const c = classById(f.classId) || {}; return `<tr>
        <td><b>${esc(f.studentName)}</b></td><td>${esc(c.title || c.subject || '—')}</td><td>${OMR(f.amount)}</td>
        <td>${f.status === 'paid' ? `<span class="pill teal">مسدّدة</span>` : f.status === 'waived' ? '<span class="pill">معفاة</span>' : '<span class="pill gold">غير مسدّدة</span>'}</td>
        <td><div class="row" style="gap:5px">
          ${f.status !== 'paid' ? `<button class="btn sm primary" data-fpay="${esc(f.id)}">تسجيل سداد</button>` : `<button class="btn sm" data-frec="${esc(f.id)}">🧾 إيصال</button>`}
          ${Auth.isAdmin && f.status === 'unpaid' ? `<button class="btn sm" data-fwaive="${esc(f.id)}">إعفاء</button>` : ''}
        </div></td></tr>`; }).join('')}</table></div>`
      : `<div class="empty"><div class="big">💳</div>لا توجد فواتير بعد.</div>`}`;
  $$('[data-fpay]', host).forEach(b => b.onclick = () => {
    const f = fees().find(x => x.id === b.dataset.fpay);
    const bd = `<p>تسجيل سداد رسوم <b>${esc(f.studentName)}</b> بمبلغ <b>${OMR(f.amount)}</b>.</p>
      <div class="field"><label>طريقة السداد</label><select id="f-m"><option>نقدًا</option><option>تحويل بنكي</option><option>بطاقة لدى الإدارة</option><option>أخرى</option></select></div>
      <div class="field"><label>رقم المرجع / الإيصال</label><input id="f-r" placeholder="اختياري"></div>`;
    const mm = modal('تسجيل سداد', bd, `<button class="btn primary" id="f-ok">تأكيد السداد</button>`);
    $('#f-ok', mm.el).onclick = () => {
      const all = fees(); const x = all.find(y => y.id === f.id);
      x.status = 'paid'; x.paidAt = Date.now(); x.method = $('#f-m', mm.el).value; x.ref = $('#f-r', mm.el).value.trim(); x.by = Auth.user.name;
      saveFees(all); mm.close(); toast('تم تسجيل السداد', 'ok'); renderFees(host);
    };
  });
  $$('[data-fwaive]', host).forEach(b => b.onclick = () => { const all = fees(); const x = all.find(y => y.id === b.dataset.fwaive); x.status = 'waived'; x.by = Auth.user.name; saveFees(all); renderFees(host); });
  $$('[data-frec]', host).forEach(b => b.onclick = () => {
    const f = fees().find(x => x.id === b.dataset.frec), c = classById(f.classId) || {};
    modal('🧾 إيصال سداد', `<div class="receipt">
      <div class="row" style="justify-content:space-between"><b>نظام التعلّم العُماني — OLS</b><span class="muted">${esc(f.ref || f.id.slice(0, 8))}</span></div>
      <hr><p><b>الطالب:</b> ${esc(f.studentName)}</p><p><b>الصف:</b> ${esc(c.title || c.subject || '—')} — ${esc(gradeName(c.grade))}</p>
      <p><b>المبلغ:</b> ${OMR(f.amount)}</p><p><b>الطريقة:</b> ${esc(f.method || '—')}</p>
      <p><b>التاريخ:</b> ${num(arDate(f.paidAt))}</p><p><b>استلمه:</b> ${esc(f.by || '—')}</p>
      <hr><p class="muted" style="font-size:.78rem">إيصال إلكتروني صادر من نظام OLS.</p></div>`,
      `<button class="btn primary" onclick="window.print()">🖨 طباعة</button>`);
  });
}

/* ========================== LIVE CLASSROOM ===============================
   A real classroom session for one class: presence, a teaching board the
   students can watch (but not edit), a personal notebook for every student
   that the teacher can open and co-edit live, an optional supervision camera,
   and an optional video meeting.

   Sync is a single POST every 2s that both sends my new ops + heartbeat and
   receives everyone else's — shared hosts kill long-lived connections, so
   fast-polling is deliberately chosen over WebSocket/SSE.
   ========================================================================= */
let LIVE = null;
function liveTeardown() {
  if (!LIVE) return;
  try { clearInterval(LIVE.timer); } catch (e) {}
  try { if (LIVE.stream) LIVE.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (LIVE.jitsi) LIVE.jitsi.dispose(); } catch (e) {}
  try { if (LIVE.onResize) { removeEventListener('resize', LIVE.onResize); removeEventListener('orientationchange', LIVE.onResize); } } catch (e) {}
  try { api('/api/room', 'POST', {class: LIVE.cid, leave: true}); } catch (e) {}
  LIVE = null;
  document.body.classList.remove('live-mode');
  setNavCollapsed(Store.lget('nav-collapsed', false), false);   // restore the user's own preference
}
PAGES.live = function (params) {
  params = params || [];
  const cid = params[0], c = classById(cid);
  if (!c) { $('#view').innerHTML = `<div class="empty"><div class="big">🏫</div>الصف غير موجود.<br><a class="btn" href="#/classes" style="margin-top:10px">◀ الصفوف</a></div>`; return; }
  if (!canJoinClass(c)) { $('#view').innerHTML = `<div class="empty"><div class="big">🔒</div>لست مسجّلًا في هذا الصف.<br><a class="btn" href="#/classes" style="margin-top:10px">◀ الصفوف</a></div>`; return; }
  const staff = canRunClass(c);
  crumb('الحصة المباشرة', c.title || c.subject);
  const split = Store.lget('live-split', innerWidth >= innerHeight ? 'side' : 'stack');
  LIVE = {cid, c, staff, since: {}, out: [], focus: '', presence: {}, hand: false, timer: null, stream: null, t0: Date.now()};

  $('#view').innerHTML = `
   <div class="live-wrap" data-split="${split}">
    <div class="live-bar">
      <div class="lb-title"><span class="live-dot">●</span> ${esc(c.title || c.subject)}
        <span class="muted" style="font-weight:500">· ${esc(gradeName(c.grade))} · ${esc(c.teacherName)}</span></div>
      <div class="spacer"></div>
      <span class="pill" id="lv-timer">٠٠:٠٠</span>
      <span class="pill teal" id="lv-count">👥 ٠</span>
      <button class="btn sm" id="lv-split" title="تبديل التخطيط">${split === 'side' ? '⬍ فوق/تحت' : '⬌ جنبًا لجنب'}</button>
      ${!staff ? `<button class="btn sm" id="lv-hand">✋ رفع اليد</button>` : ''}
      <button class="btn sm" id="lv-cam">📹 كاميرا</button>
      <button class="btn sm" id="lv-meet">🎥 اجتماع</button>
      ${staff ? `<button class="btn sm primary" id="lv-att">🗓 تسجيل الحضور</button>` : ''}
      <a class="btn sm danger" href="#/classes">✕ خروج</a>
    </div>

    <div class="live-body">
      <aside class="live-side" id="lv-side" hidden>
        <div id="lv-people" class="ls-people"></div>
        <div id="lv-cam-panel" class="ls-cam" hidden>
          <div class="ls-h">📹 كاميرا الإشراف</div>
          <select id="cam-dev" class="cam-sel"></select>
          <video id="cam-view" playsinline muted></video>
          <div class="row" style="gap:6px">
            <button class="btn sm primary" id="cam-start">تشغيل</button>
            <button class="btn sm" id="cam-stop">إيقاف</button>
          </div>
          <div class="field" style="margin:8px 0 0"><label style="font-size:.75rem">كاميرا شبكية (IP / واي‑فاي)</label>
            <input id="cam-url" placeholder="http://192.168.1.20:8080/video" style="font-size:.8rem">
            <button class="btn sm" id="cam-ip" style="margin-top:6px">عرض البث</button></div>
          <img id="cam-ipview" hidden>
          <p class="muted" style="font-size:.7rem;margin:6px 0 0">تظهر هنا أي كاميرا يتعرّف عليها الجهاز (USB أو لاسلكية)، أو كاميرا شبكية عبر رابط بثّها، أو استخدم هاتفًا ثانيًا بالدخول للحصة منه.</p>
        </div>
      </aside>

      <main class="live-panes" id="lv-panes">
        <section class="live-pane">
          <div class="lp-head"><b>🧑‍🏫 لوحة المعلّم</b>
            <span class="muted" id="tb-note">${staff ? 'أنت تكتب — الطلبة يشاهدون' : 'للمشاهدة فقط'}</span>
            <div class="spacer"></div><button class="btn sm" data-fs="t">⛶</button></div>
          ${staff ? `<div id="tb-tools"></div>` : ''}
          <div class="lp-body" id="tb-host"></div>
        </section>
        <div class="pane-splitter" id="lv-splitter" title="اسحب لتغيير حجم اللوحتين"><span></span></div>
        <section class="live-pane">
          <div class="lp-head"><b id="sb-title">📓 دفتري</b>
            <span class="muted" id="sb-note"></span>
            <div class="spacer"></div><button class="btn sm" data-fs="s">⛶</button></div>
          <div id="sb-tools"></div>
          <div class="lp-body" id="sb-host"></div>
        </section>
      </main>
    </div>

    <div class="people-dock" id="lv-dock" data-open="0">
      <button class="pd-head" id="pd-toggle">👥 المشاركون <span id="lv-n">٠</span><span class="pd-caret">▲</span></button>
      <div class="pd-body" id="pd-body"></div>
    </div>

    <div id="lv-meet-wrap" class="live-meet" hidden>
      <div class="lm-head"><b>🎥 الاجتماع المرئي</b><div class="spacer"></div>
        <button class="btn sm" id="lm-share" title="مشاركة الشاشة">🖥️ مشاركة</button>
        <button class="btn sm" id="lm-expand" title="تكبير">⛶</button>
        <button class="btn sm danger" id="lm-close">✕</button></div>
      <div id="lm-frame"></div>
    </div>
   </div>`;

  // participants + camera live in the bottom dock (frees the full width for the boards)
  $('#pd-body').appendChild($('#lv-people'));
  $('#pd-body').appendChild($('#lv-cam-panel'));
  $('#lv-side').remove();
  $('#pd-toggle').onclick = () => { const d = $('#lv-dock'); d.dataset.open = d.dataset.open === '1' ? '0' : '1'; };
  setNavCollapsed(true, false);        // maximise board width while teaching
  document.body.classList.add('live-mode');   // full-bleed view (no 1180px cap)

  /* ---------------- notebooks ---------------- */
  const tplDefault = tplForSubject(c.subject);
  const queue = (owner, ops) => ops.forEach(o => LIVE.out.push(Object.assign({board: owner}, o)));
  LIVE.nbT = createNotebook($('#tb-host'), {readOnly: !staff, tpl: tplDefault, onOps: ops => queue(c.teacher, ops)});
  LIVE.nbT.mount([{tpl: tplDefault}]);
  LIVE.boardOwner = staff ? '' : Auth.user.u;
  LIVE.nbS = createNotebook($('#sb-host'), {tpl: tplDefault, onOps: ops => LIVE.boardOwner && queue(LIVE.boardOwner, ops)});
  LIVE.nbS.mount([{tpl: tplDefault}]);
  if (staff) { $('#sb-title').textContent = '📓 دفتر الطالب'; $('#sb-note').textContent = 'اختر طالبًا من القائمة لفتح دفتره والكتابة معه'; }

  if (staff) {
    $('#tb-tools').innerHTML = notebookToolbar(null, {id: 'tb', noExport: true}) + tracePanelHtml();
    wireNotebookToolbar($('#tb-tools'), LIVE.nbT); wireTracePanel($('#tb-tools'), LIVE.nbT);
  }
  // the student notebook gets the trace box too — the teacher can type a model
  // straight onto the child's page, and the child sees it instantly
  $('#sb-tools').innerHTML = notebookToolbar(null, {id: 'sb'}) + tracePanelHtml();
  wireNotebookToolbar($('#sb-tools'), LIVE.nbS);
  wireTracePanel($('#sb-tools'), LIVE.nbS);

  /* ---------------- controls ---------------- */
  const setSplit = n => {
    const w = $('.live-wrap'); if (!w) return;
    w.dataset.split = n;
    const b = $('#lv-split'); if (b) b.textContent = n === 'side' ? '⬍ فوق/تحت' : '⬌ جنبًا لجنب';
  };
  $('#lv-split').onclick = () => { const n = $('.live-wrap').dataset.split === 'side' ? 'stack' : 'side'; Store.lset('live-split', n); setSplit(n); };
  /* keep the boards inside one screen: exact height (the bars wrap) and a
     forced stacked layout on narrow screens, so the divider axis always matches */
  const fitPanes = () => {
    const p = $('#lv-panes'); if (!p) return;
    if (innerWidth <= 920) setSplit('stack'); else setSplit(Store.lget('live-split', 'side'));
    const top = p.getBoundingClientRect().top;
    p.style.setProperty('--panes-h', Math.max(300, innerHeight - top - 14) + 'px');
  };
  LIVE.onResize = () => fitPanes();
  addEventListener('resize', LIVE.onResize);
  addEventListener('orientationchange', LIVE.onResize);
  setTimeout(fitPanes, 60);
  $$('[data-fs]').forEach(b => b.onclick = () => {
    const pane = b.closest('.live-pane');
    pane.classList.toggle('solo');
    const solo = pane.classList.contains('solo');
    $$('.live-pane').forEach(p => { if (p !== pane) p.hidden = solo; });
    $('#lv-splitter').hidden = solo;
  });
  /* draggable divider — works as a column resizer side-by-side and a row
     resizer stacked, so both boards can be sized to fit one screen */
  (function wireSplitter() {
    const sp = $('#lv-splitter'), panes = $$('.live-pane'), wrap = $('.live-wrap');
    let drag = false;
    const applyFlex = (a, b) => { panes[0].style.flex = a + ' 1 0'; panes[1].style.flex = b + ' 1 0'; };
    const saved = Store.lget('live-ratio', 50);
    applyFlex(saved, 100 - saved);
    const move = e => {
      if (!drag) return;
      const host = $('#lv-panes').getBoundingClientRect();
      const vert = wrap.dataset.split === 'stack';
      let pct = vert ? (e.clientY - host.top) / host.height * 100
        : (document.dir === 'rtl' ? (host.right - e.clientX) : (e.clientX - host.left)) / host.width * 100;
      pct = clamp(pct, 18, 82);
      applyFlex(pct, 100 - pct); Store.lset('live-ratio', Math.round(pct));
    };
    sp.addEventListener('pointerdown', e => { drag = true; try { sp.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); });
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', () => { drag = false; });
    sp.addEventListener('pointercancel', () => { drag = false; });
    sp.addEventListener('dblclick', () => { applyFlex(50, 50); Store.lset('live-ratio', 50); });
  })();
  const hb = $('#lv-hand'); if (hb) hb.onclick = () => { LIVE.hand = !LIVE.hand; hb.classList.toggle('primary', LIVE.hand); hb.textContent = LIVE.hand ? '✋ يدك مرفوعة' : '✋ رفع اليد'; };
  $('#lv-cam').onclick = () => { const p = $('#lv-cam-panel'); p.hidden = !p.hidden; $('#lv-dock').dataset.open = '1'; if (!p.hidden) listCams(); };
  $('#lv-meet').onclick = () => toggleMeet(c);
  $('#lm-close').onclick = () => toggleMeet(c, true);
  $('#lm-expand').onclick = () => $('#lv-meet-wrap').classList.toggle('expanded');
  $('#lm-share').onclick = () => {
    if (LIVE && LIVE.jitsi && LIVE.jitsi.executeCommand) { LIVE.jitsi.executeCommand('toggleShareScreen'); toast('تبديل مشاركة الشاشة', 'ok'); }
    else toast('استخدم زر مشاركة الشاشة داخل نافذة الاجتماع.', 'err');
  };
  const ab = $('#lv-att');
  if (ab) ab.onclick = () => {
    const date = new Date().toISOString().slice(0, 10);
    const roster = classRoster(cid), rec = {};
    roster.forEach(e => { rec[e.student] = LIVE.presence[e.student] ? 'present' : 'absent'; });
    const all = attendance(); const ex = all.find(a => a.classId === cid && a.date === date);
    if (ex) ex.records = Object.assign({}, ex.records, rec); else all.push({id: uid(), classId: cid, date, records: rec, by: Auth.user.u});
    saveAttendance(all);
    toast('سُجّل حضور ' + num(Object.values(rec).filter(v => v === 'present').length) + ' من ' + num(roster.length), 'ok');
  };

  /* ---------------- camera ---------------- */
  async function listCams() {
    try {
      await navigator.mediaDevices.getUserMedia({video: true}).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      $('#cam-dev').innerHTML = devs.length ? devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'كاميرا ' + num(i + 1))}</option>`).join('')
        : '<option value="">— لا توجد كاميرات —</option>';
    } catch (e) { $('#cam-dev').innerHTML = '<option value="">تعذّر الوصول للكاميرات</option>'; }
  }
  $('#cam-start').onclick = async () => {
    try {
      if (LIVE.stream) LIVE.stream.getTracks().forEach(t => t.stop());
      const id = $('#cam-dev').value;
      LIVE.stream = await navigator.mediaDevices.getUserMedia({video: id ? {deviceId: {exact: id}} : true, audio: false});
      const v = $('#cam-view'); v.srcObject = LIVE.stream; v.muted = true; v.playsInline = true; await v.play().catch(() => {});
      toast('الكاميرا تعمل', 'ok');
    } catch (e) { toast('تعذّر تشغيل الكاميرا — تحقّق من الأذونات', 'err'); }
  };
  $('#cam-stop').onclick = () => { if (LIVE.stream) { LIVE.stream.getTracks().forEach(t => t.stop()); LIVE.stream = null; } $('#cam-view').srcObject = null; };
  $('#cam-ip').onclick = () => {
    const u = $('#cam-url').value.trim(); const img = $('#cam-ipview');
    if (!u) return toast('أدخل رابط بث الكاميرا', 'err');
    img.hidden = false; img.src = u; img.onerror = () => toast('تعذّر عرض بث الكاميرا — تحقّق من الرابط والشبكة', 'err');
  };

  /* ---------------- sync loop ---------------- */
  const routeOps = (owner, ops) => {
    const mine = ops.filter(o => o.by !== Auth.user.u);      // my own strokes are already drawn
    if (!mine.length) return;
    if (owner === c.teacher) LIVE.nbT.applyRemote(mine);
    else if (owner === LIVE.boardOwner) LIVE.nbS.applyRemote(mine);
  };
  async function tick() {
    if (!LIVE) return;
    const payload = {class: cid, since: LIVE.since, presence: {hand: LIVE.hand, cam: !!LIVE.stream}, ops: LIVE.out.splice(0, 200)};
    if (LIVE.staff && LIVE.boardOwner) payload.focus = LIVE.boardOwner;
    try {
      const r = await api('/api/room', 'POST', payload);
      if (!LIVE) return;
      LIVE.presence = r.presence || {};
      for (const owner in (r.boards || {})) {
        LIVE.since[owner] = r.boards[owner].seq;
        routeOps(owner, r.boards[owner].ops || []);
      }
      if (!LIVE.staff && r.focus === Auth.user.u) $('#sb-note').innerHTML = '<span class="watching">👁 المعلّم يتابع دفترك الآن</span>';
      else if (!LIVE.staff) $('#sb-note').textContent = '';
      paintPeople();
    } catch (e) { /* keep the loop alive through transient errors */ }
  }
  function paintPeople() {
    const p = LIVE.presence, keys = Object.keys(p);
    const cEl = $('#lv-count'); if (cEl) cEl.textContent = '👥 ' + num(keys.length);
    const nEl = $('#lv-n'); if (nEl) nEl.textContent = num(keys.length);
    const roster = classRoster(cid);
    const rows = keys.map(u => ({u, ...p[u]})).sort((a, b) => (a.r === 'معلم' ? -1 : 1) - (b.r === 'معلم' ? -1 : 1));
    const absent = roster.filter(e => !p[e.student]);
    $('#lv-people').innerHTML = rows.map(x => `
      <div class="person ${x.u === LIVE.boardOwner ? 'sel' : ''}" ${LIVE.staff && x.r === 'طالب' ? `data-open-board="${esc(x.u)}"` : ''}>
        <span class="um-avatar" style="width:30px;height:30px;font-size:.72rem">${esc(initials(x.n))}</span>
        <div style="flex:1;min-width:0"><div class="p-name">${esc(x.n)}</div>
          <div class="p-role">${roleEmoji(x.r)} ${esc(x.r)}</div></div>
        ${x.hand ? '<span class="p-hand">✋</span>' : ''}${x.cam ? '<span title="كاميرا">📹</span>' : ''}
        <span class="p-on"></span></div>`).join('')
      + (absent.length ? `<div class="ls-h" style="margin-top:8px">غائبون (${num(absent.length)})</div>` +
        absent.map(e => `<div class="person off"><span class="um-avatar" style="width:30px;height:30px;font-size:.72rem;background:#cbd5e1">${esc(initials(e.studentName))}</span>
          <div style="flex:1"><div class="p-name">${esc(e.studentName)}</div><div class="p-role">غير متصل</div></div></div>`).join('') : '');
    $$('[data-open-board]').forEach(el => el.onclick = () => openStudentBoard(el.dataset.openBoard));
  }
  function openStudentBoard(u) {
    LIVE.boardOwner = u; LIVE.since[u] = 0;                  // replay their board from the start
    const p = LIVE.presence[u] || {};
    $('#sb-title').textContent = '📓 دفتر: ' + (p.n || u);
    $('#sb-note').innerHTML = '<span class="watching">✍️ يمكنك الكتابة معه مباشرة</span>';
    LIVE.nbS.mount([{tpl: tplDefault}]);
    paintPeople();
  }

  // session timer
  const t0 = Date.now();
  LIVE.timer = setInterval(() => {
    if (!LIVE) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    const el = $('#lv-timer'); if (el) el.textContent = num(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
    if (s % 2 === 0) tick();
  }, 1000);
  tick();
  PAGE_CLEANUP = liveTeardown;
};
function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some(s => s.src === src)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
function toggleMeet(c, forceClose) {
  const wrap = $('#lv-meet-wrap'), frame = $('#lm-frame');
  if (!wrap) return;
  if (forceClose || !wrap.hidden) {
    wrap.hidden = true; wrap.classList.remove('expanded');
    try { if (LIVE && LIVE.jitsi) { LIVE.jitsi.dispose(); LIVE.jitsi = null; } } catch (e) {}
    frame.innerHTML = ''; return;
  }
  const host = Store.get('meetHost', 'meet.jit.si');
  const room = 'OLS-' + String(c.id).replace(/[^\w]/g, '') + '-' + c.grade;
  wrap.hidden = false; frame.innerHTML = '<p class="muted" style="padding:14px">… يفتح غرفة الاجتماع</p>';
  // The external API gives us in-app control (screen share, mute) — fall back to
  // a plain iframe if the script can't load, so the meeting still works.
  loadScript('https://' + host + '/external_api.js').then(() => {
    frame.innerHTML = '';
    LIVE.jitsi = new window.JitsiMeetExternalAPI(host, {
      roomName: room, parentNode: frame,
      userInfo: {displayName: Auth.user.name},
      configOverwrite: {prejoinPageEnabled: false, startWithVideoMuted: true, startWithAudioMuted: true},
      interfaceConfigOverwrite: {TOOLBAR_BUTTONS: ['microphone', 'camera', 'desktop', 'raisehand', 'tileview', 'chat', 'fullscreen', 'hangup']}
    });
  }).catch(() => {
    const url = `https://${host}/${room}#userInfo.displayName=%22${encodeURIComponent(Auth.user.name)}%22&config.prejoinPageEnabled=false`;
    frame.innerHTML = `<iframe src="${esc(url)}" allow="camera; microphone; fullscreen; display-capture; autoplay" allowfullscreen></iframe>`;
  });
}


/* ========================= PROFILES & DOCUMENTS ==========================
   One complete record per person: identity + photo, enrolments, finances,
   scanned documents, assessment results, attendance, achievements and
   certificates. Visible to the person themselves, their teacher, their
   guardian, and the administrator.
   ======================================================================== */
function profiles() { return Store.get('profiles', {}); }
function profileOf(u) { return profiles()[u] || {}; }
function saveProfile(u, patch) { const all = profiles(); all[u] = Object.assign({}, all[u] || {}, patch); Store.set('profiles', all); }
function documents() { return Store.get('documents', []); }
function saveDocuments(v) { Store.set('documents', v); }
const docsOf = u => documents().filter(d => d.owner === u);

function dirUser(u) { return DIRECTORY.find(x => x.u === u) || (Auth.user && Auth.user.u === u ? Auth.user : null); }
function canViewProfile(u) {
  if (!Auth.user) return false;
  if (u === Auth.user.u || Auth.isAdmin) return true;
  if (Auth.isTeacher) return classes().some(c => c.teacher === Auth.user.u && classRoster(c.id).some(e => e.student === u));
  if (Auth.isParent) return (meDir().child || '') === u;
  return false;
}
const canEditProfile = u => Auth.user && (u === Auth.user.u || Auth.isAdmin);

/* ---- financial summary for a student ---- */
function financeOf(u) {
  const list = fees().filter(f => f.student === u);
  const billed = list.reduce((s, f) => s + Number(f.amount || 0), 0);
  const paid = list.filter(f => f.status === 'paid').reduce((s, f) => s + Number(f.amount || 0), 0);
  const waived = list.filter(f => f.status === 'waived').reduce((s, f) => s + Number(f.amount || 0), 0);
  return {list, billed, paid, waived, balance: billed - paid - waived};
}
/* ---- everything assessed for a student, from tests and from class work ---- */
function assessmentsOf(u) {
  const fromTests = results().filter(r => r.user === u).map(r => ({
    when: r.date, title: r.title, kind: r.kind === 'exercise' ? 'تمرين' : 'اختبار تفاعلي',
    subject: r.subject || '—', score: r.score, total: r.total, pct: Math.round(r.score / r.total * 100)}));
  const fromClass = gradeItems().filter(g => g.student === u).map(g => {
    const c = classById(g.classId) || {};
    return {when: g.date, title: g.title, kind: g.kind, subject: c.subject || '—',
      score: g.score, total: g.total, pct: Math.round(g.score / g.total * 100)};
  });
  return fromTests.concat(fromClass).sort((a, b) => b.when - a.when);
}
function overallOf(u) {
  const a = assessmentsOf(u);
  const avg = a.length ? Math.round(a.reduce((s, x) => s + x.pct, 0) / a.length) : null;
  const enrol = enrolments().filter(e => e.student === u && e.status === 'active');
  let pres = 0, tot = 0;
  enrol.forEach(e => { const at = attendanceRate(e.classId, u); if (at) { pres += at.present; tot += at.total; } });
  const att = tot ? Math.round(pres / tot * 100) : null;
  return {avg, att, classes: enrol.length, tests: a.length, certs: certificates().filter(c => c.student === u).length};
}
function achievementsOf(u) {
  const o = overallOf(u), out = [];
  if (o.avg != null && o.avg >= 90) out.push({e: '🏅', t: 'متفوّق', d: 'متوسط ٩٠٪ فأعلى'});
  else if (o.avg != null && o.avg >= 80) out.push({e: '🎖️', t: 'متميّز', d: 'متوسط ٨٠٪ فأعلى'});
  if (o.att === 100) out.push({e: '⭐', t: 'حضور مثالي', d: 'لم يتغيّب أبدًا'});
  else if (o.att != null && o.att >= 90) out.push({e: '📚', t: 'مواظب', d: 'حضور ٩٠٪ فأعلى'});
  if (o.tests >= 10) out.push({e: '🎯', t: 'مثابر', d: num(o.tests) + ' نشاطًا مقيّمًا'});
  else if (o.tests >= 5) out.push({e: '✏️', t: 'نشِط', d: num(o.tests) + ' أنشطة'});
  if (o.certs) out.push({e: '🏆', t: 'حاصل على شهادات', d: num(o.certs) + ' شهادة'});
  if (o.classes >= 3) out.push({e: '🎓', t: 'متعدّد المواد', d: num(o.classes) + ' صفوف'});
  return out;
}

PAGES.profile = function (params) {
  params = params || [];
  const u = params[0] || Auth.user.u;
  if (!canViewProfile(u)) { $('#view').innerHTML = `<div class="empty"><div class="big">🔒</div>لا تملك صلاحية عرض هذا الملف.</div>`; return; }
  const d = dirUser(u) || {u, name: u, role: '—', levels: []};
  const p = profileOf(u), o = overallOf(u), fin = financeOf(u);
  const isStudent = d.role === 'طالب';
  crumb('الملف الشخصي', d.name);
  const tab = Store.lget('prof-tab', 'overview');
  const tabs = [{k: 'overview', t: '📋 نظرة عامة'}, {k: 'personal', t: '🪪 البيانات'},
    {k: 'classes', t: '🏫 الصفوف'}, {k: 'results', t: '📊 النتائج'},
    {k: 'docs', t: '📎 المستندات'}, {k: 'certs', t: '🏅 الشهادات'}];
  if (isStudent) tabs.splice(3, 0, {k: 'finance', t: '💳 المالية'});
  $('#view').innerHTML = `
    <div class="profile-head">
      <div class="ph-photo">
        ${p.photo ? `<img src="${fileUrl(p.photo, 'photo')}" alt="">` : `<span>${esc(initials(d.name))}</span>`}
        ${canEditProfile(u) ? `<button class="ph-cam" id="pf-photo" title="تغيير الصورة">📷</button><input type="file" id="pf-photo-file" accept="image/*" hidden>` : ''}
      </div>
      <div class="ph-info">
        <h2>${esc(d.name)}</h2>
        <div class="ph-sub">${roleEmoji(d.role)} ${esc(d.role)} · @${esc(u)}
          ${(d.levels && d.levels.length) ? ' · ' + d.levels.map(g => g === 0 ? 'روضة' : gradeName(g)).join('، ') : ''}</div>
        <div class="ph-stats">
          <div class="phs"><b>${o.avg == null ? '—' : num(o.avg) + '%'}</b><span>الأداء العام</span></div>
          <div class="phs"><b>${o.att == null ? '—' : num(o.att) + '%'}</b><span>الحضور</span></div>
          <div class="phs"><b>${num(o.classes)}</b><span>الصفوف</span></div>
          <div class="phs"><b>${num(o.certs)}</b><span>الشهادات</span></div>
          ${isStudent ? `<div class="phs ${fin.balance > 0 ? 'due' : ''}"><b>${OMR(fin.balance)}</b><span>الرصيد المستحق</span></div>` : ''}
        </div>
      </div>
    </div>
    <div class="chip-row">${tabs.map(t => `<button class="tab-chip ${t.k === tab ? 'active' : ''}" data-ptab="${t.k}">${t.t}</button>`).join('')}</div>
    <div id="pf-body"></div>`;
  $$('[data-ptab]').forEach(b => b.onclick = () => { Store.lset('prof-tab', b.dataset.ptab); PAGES.profile([u]); });
  const ph = $('#pf-photo');
  if (ph) {
    ph.onclick = () => $('#pf-photo-file').click();
    $('#pf-photo-file').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      if (!checkUploadSize(f, false)) return;
      toast('… جارٍ رفع الصورة');
      const dataUrl = await fileToDataURL(f); const key = 'photo-' + u;
      try { await uploadBlob(key, dataUrl); } catch (er) { return toast('تعذّر الرفع', 'err'); }
      saveProfile(u, {photo: key}); toast('تم تحديث الصورة', 'ok'); PAGES.profile([u]);
    };
  }
  const body = $('#pf-body');
  ({overview: pfOverview, personal: pfPersonal, classes: pfClasses, finance: pfFinance,
    results: pfResults, docs: pfDocs, certs: pfCerts}[tab] || pfOverview)(body, u, d);
};
function pfOverview(host, u, d) {
  const o = overallOf(u), ach = achievementsOf(u), a = assessmentsOf(u).slice(0, 6);
  const bySub = {};
  assessmentsOf(u).forEach(x => (bySub[x.subject] = bySub[x.subject] || []).push(x.pct));
  const subs = Object.keys(bySub).map(s => ({s, v: Math.round(bySub[s].reduce((x, y) => x + y, 0) / bySub[s].length)}));
  host.innerHTML = `
    <div class="grid g-2">
      <div class="card"><div class="section-title" style="margin-top:0">🏆 الإنجازات والأوسمة</div>
        ${ach.length ? `<div class="badge-row">${ach.map(b => `<div class="ach"><span>${b.e}</span><b>${esc(b.t)}</b><i>${esc(b.d)}</i></div>`).join('')}</div>`
          : `<p class="muted">لا توجد أوسمة بعد — تظهر تلقائيًا مع التقدّم.</p>`}
      </div>
      <div class="card"><div class="section-title" style="margin-top:0">📈 الأداء حسب المادة</div>
        ${subs.length ? `<div class="bar-chart">${subs.map(x => `<div class="bar" style="height:${x.v}%"><span class="val">${num(x.v)}%</span><span class="lbl">${esc(x.s)}</span></div>`).join('')}</div><div style="height:26px"></div>`
          : `<p class="muted">لا توجد نتائج بعد.</p>`}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="section-title" style="margin-top:0">🕘 آخر الأنشطة المقيّمة</div>
      ${a.length ? `<table class="tbl"><tr><th>النشاط</th><th>المادة</th><th>النوع</th><th>النتيجة</th><th>التاريخ</th></tr>
        ${a.map(x => `<tr><td>${esc(x.title)}</td><td>${esc(x.subject)}</td><td>${esc(x.kind)}</td>
          <td><b>${num(x.score)}/${num(x.total)}</b> (${num(x.pct)}%)</td><td class="muted">${num(arDate(x.when))}</td></tr>`).join('')}</table>`
        : `<p class="muted">لا توجد أنشطة بعد.</p>`}</div>`;
}
const PF_FIELDS = [
  ['fullName', 'الاسم الرباعي', 'text'], ['dob', 'تاريخ الميلاد', 'date'],
  ['gender', 'الجنس', 'select', ['ذكر', 'أنثى']], ['nationality', 'الجنسية', 'text'],
  ['civilId', 'الرقم المدني', 'text'], ['phone', 'الهاتف', 'tel'],
  ['email', 'البريد الإلكتروني', 'email'], ['address', 'العنوان / الولاية', 'text'],
  ['school', 'المدرسة', 'text'], ['guardianName', 'ولي الأمر', 'text'],
  ['guardianPhone', 'هاتف ولي الأمر', 'tel'], ['emergency', 'هاتف الطوارئ', 'tel'],
];
function pfPersonal(host, u, d) {
  const p = profileOf(u), can = canEditProfile(u);
  host.innerHTML = `<div class="card">
    <div class="section-title" style="margin-top:0">🪪 البيانات الشخصية ${can ? '' : '<span class="muted" style="font-size:.78rem;font-weight:400">(للعرض فقط)</span>'}</div>
    <div class="form-grid">
      ${PF_FIELDS.map(([k, label, type, opts]) => `<div class="field"><label>${label}</label>
        ${type === 'select'
          ? `<select data-pf="${k}" ${can ? '' : 'disabled'}><option value=""></option>${opts.map(o => `<option ${p[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
          : `<input data-pf="${k}" type="${type}" value="${esc(p[k] || '')}" ${can ? '' : 'disabled'}>`}</div>`).join('')}
      <div class="field wide"><label>ملاحظات</label><textarea data-pf="notes" rows="2" ${can ? '' : 'disabled'}>${esc(p.notes || '')}</textarea></div>
    </div>
    ${can ? `<button class="btn primary" id="pf-save">💾 حفظ البيانات</button>` : ''}
  </div>`;
  const s = $('#pf-save', host);
  if (s) s.onclick = () => {
    const patch = {};
    $$('[data-pf]', host).forEach(el => patch[el.dataset.pf] = el.value.trim());
    saveProfile(u, patch); toast('تم حفظ البيانات', 'ok');
  };
}
function pfClasses(host, u, d) {
  const isTeacher = d.role === 'معلم';
  const list = isTeacher ? classes().filter(c => c.teacher === u)
    : enrolments().filter(e => e.student === u).map(e => Object.assign({_en: e}, classById(e.classId) || {})).filter(c => c.id);
  host.innerHTML = list.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <tr><th>الصف</th><th>المادة</th><th>المستوى</th>${isTeacher ? '<th>الطلبة</th>' : '<th>المعلّم</th><th>الحالة</th><th>الحضور</th><th>النتيجة</th>'}</tr>
      ${list.map(c => { const at = isTeacher ? null : attendanceRate(c.id, u), r = isTeacher ? null : classResult(c.id, u);
        return `<tr><td><b>${esc(c.title || c.subject)}</b></td><td>${subjIcon(c.subject)} ${esc(c.subject)}</td><td>${esc(gradeName(c.grade))}</td>
        ${isTeacher ? `<td>${num(classRoster(c.id).length)}</td>`
          : `<td>${esc(c.teacherName || '—')}</td>
             <td>${c._en.status === 'active' ? '<span class="pill teal">مسجّل</span>' : c._en.status === 'pending' ? '<span class="pill gold">بانتظار</span>' : '<span class="pill">مرفوض</span>'}</td>
             <td>${at ? num(at.rate) + '%' : '—'}</td><td>${r ? num(r.pct) + '%' : '—'}</td>`}</tr>`; }).join('')}</table></div>`
    : `<div class="empty"><div class="big">🏫</div>لا توجد صفوف.</div>`;
}
function pfFinance(host, u) {
  const f = financeOf(u);
  host.innerHTML = `
    <div class="stat-tiles">
      <div class="stat"><div class="k">إجمالي المستحق</div><div class="v" style="font-size:1.25rem">${OMR(f.billed)}</div></div>
      <div class="stat g"><div class="k">المسدّد</div><div class="v" style="font-size:1.25rem">${OMR(f.paid)}</div></div>
      <div class="stat b"><div class="k">الإعفاءات</div><div class="v" style="font-size:1.25rem">${OMR(f.waived)}</div></div>
      <div class="stat p"><div class="k">الرصيد المتبقّي</div><div class="v" style="font-size:1.25rem;color:${f.balance > 0 ? 'var(--danger)' : 'var(--green)'}">${OMR(f.balance)}</div></div>
    </div>
    <div class="card" style="margin-top:16px;padding:0;overflow:auto">
      ${f.list.length ? `<table class="tbl"><tr><th>الصف</th><th>المبلغ</th><th>الحالة</th><th>الطريقة</th><th>التاريخ</th><th></th></tr>
        ${f.list.map(x => { const c = classById(x.classId) || {}; return `<tr>
          <td>${esc(c.title || c.subject || '—')}</td><td>${OMR(x.amount)}</td>
          <td>${x.status === 'paid' ? '<span class="pill teal">مسدّدة</span>' : x.status === 'waived' ? '<span class="pill">معفاة</span>' : '<span class="pill gold">غير مسدّدة</span>'}</td>
          <td>${esc(x.method || '—')}</td><td class="muted">${x.paidAt ? num(arDate(x.paidAt)) : num(arDate(x.issued))}</td>
          <td>${x.status === 'paid' ? `<button class="btn sm" data-rec="${esc(x.id)}">🧾</button>` : ''}</td></tr>`; }).join('')}</table>`
        : `<div class="empty">لا توجد فواتير.</div>`}</div>`;
  $$('[data-rec]', host).forEach(b => b.onclick = () => {
    const x = fees().find(y => y.id === b.dataset.rec), c = classById(x.classId) || {};
    modal('🧾 إيصال سداد', `<div class="receipt">
      <div class="row" style="justify-content:space-between"><b>نظام التعلّم العُماني — OLS</b><span class="muted">${esc(x.ref || x.id.slice(0, 8))}</span></div><hr>
      <p><b>الطالب:</b> ${esc(x.studentName)}</p><p><b>الصف:</b> ${esc(c.title || c.subject || '—')}</p>
      <p><b>المبلغ:</b> ${OMR(x.amount)}</p><p><b>الطريقة:</b> ${esc(x.method || '—')}</p>
      <p><b>التاريخ:</b> ${num(arDate(x.paidAt))}</p></div>`, `<button class="btn primary" onclick="window.print()">🖨 طباعة</button>`);
  });
}
function pfResults(host, u) {
  const a = assessmentsOf(u);
  host.innerHTML = a.length ? `<div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <tr><th>النشاط</th><th>المادة</th><th>النوع</th><th>الدرجة</th><th>النسبة</th><th>التاريخ</th></tr>
      ${a.map(x => `<tr><td>${esc(x.title)}</td><td>${esc(x.subject)}</td><td>${esc(x.kind)}</td>
        <td><b>${num(x.score)}/${num(x.total)}</b></td>
        <td><span class="pill ${x.pct >= 80 ? 'teal' : x.pct >= 60 ? 'gold' : ''}" ${x.pct < 60 ? 'style="background:#fdeaea;color:var(--danger)"' : ''}>${num(x.pct)}%</span></td>
        <td class="muted">${num(arDate(x.when))}</td></tr>`).join('')}</table></div>`
    : `<div class="empty"><div class="big">📊</div>لا توجد نتائج بعد.</div>`;
}
function pfDocs(host, u) {
  const list = docsOf(u), can = canEditProfile(u) || Auth.isTeacher;
  host.innerHTML = `
    ${can ? `<button class="btn primary" id="doc-add" style="margin-bottom:12px">⬆ رفع مستند</button>` : ''}
    ${list.length ? `<div class="lib-grid">${list.map(d => `<div class="book-card">
        <div class="book-cover" style="background:linear-gradient(135deg,#0891b2,#2563eb)">📄<span class="ext">${esc(d.ext || '')}</span></div>
        <div class="bc-body"><div class="bc-title">${esc(d.title)}</div>
          <div class="bc-meta">${esc(d.kind || 'مستند')} · ${num(arDate(d.uploaded))}</div></div>
        <div class="bc-actions">
          <a class="btn sm primary" style="flex:1" href="${fileUrl(d.blobKey, d.title)}" target="_blank" rel="noopener">فتح</a>
          <a class="btn sm" href="${fileUrl(d.blobKey, d.title, true)}" download>⬇</a>
          ${canEditProfile(u) ? `<button class="btn sm danger" data-ddel="${esc(d.id)}">🗑</button>` : ''}
        </div></div>`).join('')}</div>`
      : `<div class="empty"><div class="big">📎</div>لا توجد مستندات مرفوعة.</div>`}`;
  $$('[data-ddel]', host).forEach(b => b.onclick = () => armed(b, () => { saveDocuments(documents().filter(x => x.id !== b.dataset.ddel)); pfDocs(host, u); }));
  const add = $('#doc-add', host);
  if (add) add.onclick = () => {
    const b = `<div class="field"><label>عنوان المستند</label><input id="d-title" placeholder="البطاقة الشخصية"></div>
      <div class="field"><label>النوع</label><select id="d-kind">
        <option>بطاقة شخصية</option><option>شهادة ميلاد</option><option>جواز سفر</option><option>شهادة دراسية</option>
        <option>تقرير طبي</option><option>إيصال</option><option>أخرى</option></select></div>
      <div class="field"><label>الملف</label><input id="d-file" type="file" accept=".pdf,image/*,.doc,.docx"></div>`;
    const m = modal('رفع مستند', b, `<button class="btn primary" id="d-save">رفع</button>`);
    $('#d-save', m.el).onclick = async () => {
      const f = $('#d-file', m.el).files[0]; if (!f) return toast('اختر ملفًا', 'err');
      if (!checkUploadSize(f, false)) return;
      const btn = $('#d-save', m.el); btn.disabled = true; btn.textContent = '… يقرأ';
      const dataUrl = await fileToDataURL(f); const id = uid(), key = 'doc-' + id;
      try { await uploadBlob(key, dataUrl, p => { btn.textContent = 'جارٍ الرفع… ' + num(p) + '%'; }); }
      catch (e) { btn.disabled = false; btn.textContent = 'رفع'; return toast('تعذّر الرفع', 'err'); }
      const all = documents();
      all.push({id, owner: u, title: $('#d-title', m.el).value.trim() || f.name, kind: $('#d-kind', m.el).value,
        blobKey: key, ext: (f.name.split('.').pop() || '').toUpperCase(), uploaded: Date.now(), by: Auth.user.u});
      saveDocuments(all); m.close(); toast('تم رفع المستند', 'ok'); pfDocs(host, u);
    };
  };
}
function pfCerts(host, u) {
  const list = certificates().filter(c => c.student === u);
  host.innerHTML = list.length ? `<div class="cert-grid">${list.map(c => `<div class="cert-mini" data-cert="${esc(c.id)}">
      <div class="cm-medal">🏅</div>
      <div><b>${esc(c.subject)}</b><div class="muted" style="font-size:.8rem">${esc(gradeName(c.grade))} · ${esc(c.letter)} (${num(c.percent)}%)</div>
      <div class="muted" style="font-size:.72rem">${esc(c.serial)} · ${num(arDate(c.issued))}</div></div>
      <button class="btn sm primary">عرض</button></div>`).join('')}</div>`
    : `<div class="empty"><div class="big">🏅</div>لا توجد شهادات بعد.</div>`;
  $$('[data-cert]', host).forEach(el => el.onclick = () => showCertificate(el.dataset.cert));
}

/* ======================== CERTIFICATION SYSTEM ===========================
   Print-ready A4 landscape certificates in three designs, issued from the
   student's weighted class result, carrying a unique serial that anyone can
   check on the verification page (#/verify).
   ======================================================================== */
const CERT_TPLS = {
  classic: {name: 'كلاسيكي', ink: '#0e3b34', accent: '#0e7c66', gold: '#b8912f'},
  royal: {name: 'ملكي', ink: '#2a1a48', accent: '#5b3f9e', gold: '#c9a227'},
  kids: {name: 'للأطفال', ink: '#7a2f5f', accent: '#e0498f', gold: '#f4b53f'},
};
const certHonour = pct => pct >= 95 ? 'مع مرتبة الشرف الأولى' : pct >= 90 ? 'مع مرتبة الشرف' : '';
/* verification link encoded on the certificate — scanning it opens the check page */
function certVerifyUrl(ct) {
  return location.origin + location.pathname.replace(/[^/]*$/, '') + '#/verify/' + ct.serial;
}
function certQrSvg(ct) {
  try { return (window.QR && QR.svg(certVerifyUrl(ct), {quiet: 2, dark: '#123', light: '#fff'})) || ''; }
  catch (e) { return ''; }
}
const certOf = id => certificates().find(c => c.id === id);
const certBySerial = s => certificates().find(c => String(c.serial).toUpperCase() === String(s).trim().toUpperCase());

function certificateHtml(ct, tplKey) {
  const t = CERT_TPLS[tplKey] || CERT_TPLS.classic;
  const honour = certHonour(ct.percent);
  const bg = Store.get('certBg', '');            // optional artwork behind (e.g. a Canva export)
  const gradeEn = ct.grade === 0 ? 'Kindergarten' : 'Grade ' + ct.grade;
  return `<div class="cert-sheet cert-${tplKey}" style="--ci:${t.ink};--ca:${t.accent};--cg:${t.gold}">
    ${bg ? `<img class="cert-bgimg" src="${esc(bg)}" alt="">` : ''}
    <div class="cert-guilloche"></div>
    <div class="cert-frame">
      <div class="cert-inner">
        ${['tl', 'tr', 'bl', 'br'].map(k => `<svg class="cert-orn ${k}" viewBox="0 0 120 120" aria-hidden="true">
          <path d="M4 116V44C4 22 22 4 44 4h72" fill="none" stroke="var(--cg)" stroke-width="2.5"/>
          <path d="M14 116V48C14 30 30 14 48 14h68" fill="none" stroke="var(--cg)" stroke-width="1" opacity=".7"/>
          <path d="M24 60c0-20 16-36 36-36 12 0 20 6 20 14s-8 12-14 8" fill="none" stroke="var(--cg)" stroke-width="1.6" opacity=".85"/>
          <circle cx="30" cy="96" r="3.2" fill="var(--cg)"/><circle cx="96" cy="30" r="3.2" fill="var(--cg)"/>
        </svg>`).join('')}
        <svg class="cert-wm" viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="100" cy="100" r="86" fill="none" stroke="var(--ca)" stroke-width="1.2"/>
          <circle cx="100" cy="100" r="72" fill="none" stroke="var(--cg)" stroke-width=".8" stroke-dasharray="3 5"/>
          <text x="100" y="118" text-anchor="middle" font-size="54" font-weight="700"
                font-family="Cormorant Garamond,serif" fill="var(--ca)">OLS</text>
        </svg>

        <header class="cert-head">
          <img class="cert-logo" src="assets/logo.svg" alt="OLS">
          <div class="cert-org">
            <b>نظام التعلّم العُماني</b>
            <span>OMANI LEARNING SYSTEM</span>
          </div>
        </header>

        <div class="cert-titlewrap">
          <h1 class="cert-title">شهادة إتمام</h1>
          <div class="cert-title-en">Certificate of Completion</div>
          <div class="cert-rule"><i></i><span>❖</span><i></i></div>
        </div>

        <p class="cert-lead">تشهد إدارة النظام بأنّ <span class="en">· This is to certify that ·</span></p>
        <div class="cert-name">${esc(ct.studentName)}</div>
        <p class="cert-lead">قد أتمّ/أتمّت بنجاح متطلبات مادة <span class="en">· has successfully completed the requirements of ·</span></p>

        <div class="cert-subject">${esc(ct.subject)}</div>
        <div class="cert-meta">${esc(gradeName(ct.grade))}${ct.className ? ' — ' + esc(ct.className) : ''} <span class="en">(${esc(gradeEn)})</span></div>
        ${honour ? `<div class="cert-honour">${honour}</div>` : ''}

        <div class="cert-result">
          <div class="cr"><b>${num(ct.percent)}%</b><span>النتيجة · Final Score</span></div>
          <div class="cr-sep"></div>
          <div class="cr"><b>${esc(ct.letter)}</b><span>التقدير · Grade</span></div>
        </div>

        <footer class="cert-foot">
          <div class="sig">
            <div class="sig-name">${esc(ct.teacherName || '—')}</div>
            <div class="sig-line"></div>
            <div class="sig-role">معلّم المادة · Subject Teacher</div>
          </div>

          <div class="cert-sealwrap">
            <div class="cert-seal">
              <svg viewBox="0 0 140 140" aria-hidden="true">
                <defs><radialGradient id="sg-${tplKey}" cx=".35" cy=".3">
                  <stop offset="0" stop-color="#fff3c9"/><stop offset=".55" stop-color="var(--cg)"/><stop offset="1" stop-color="#8a6a1c"/>
                </radialGradient></defs>
                <circle cx="70" cy="70" r="46" fill="url(#sg-${tplKey})"/>
                <circle cx="70" cy="70" r="46" fill="none" stroke="#7a5d17" stroke-width="1.2"/>
                <circle cx="70" cy="70" r="38" fill="none" stroke="#fff8e1" stroke-width="1" opacity=".75"/>
                <circle cx="70" cy="70" r="33" fill="none" stroke="#7a5d17" stroke-width=".8" stroke-dasharray="2 3"/>
                ${Array.from({length: 36}, (_, i) => {
                  const a = i * 10 * Math.PI / 180, r1 = 46, r2 = 51;
                  return `<line x1="${70 + Math.cos(a) * r1}" y1="${70 + Math.sin(a) * r1}" x2="${70 + Math.cos(a) * r2}" y2="${70 + Math.sin(a) * r2}" stroke="var(--cg)" stroke-width="2.4" stroke-linecap="round"/>`;
                }).join('')}
                <text x="70" y="64" text-anchor="middle" font-size="17" font-weight="800" fill="#4a3708" font-family="Cormorant Garamond,serif">OLS</text>
                <text x="70" y="80" text-anchor="middle" font-size="8.5" font-weight="700" fill="#4a3708">شهادة معتمدة</text>
                <text x="70" y="92" text-anchor="middle" font-size="6" fill="#5c4610" letter-spacing="1">VERIFIED</text>
              </svg>
              <div class="seal-ribbons"><i></i><i></i></div>
            </div>
          </div>

          <div class="sig">
            <div class="sig-name">${esc(ct.issuedBy || '—')}</div>
            <div class="sig-line"></div>
            <div class="sig-role">مدير النظام · Director</div>
          </div>
        </footer>

        <div class="cert-credential">
          <div class="cc-qr">${certQrSvg(ct)}</div>
          <div class="cc-txt">
            <div><b>Credential ID:</b> ${esc(ct.serial)}</div>
            <div><b>تاريخ الإصدار · Issued:</b> ${num(arDate(ct.issued))}</div>
            <div class="cc-verify">امسح الرمز للتحقّق · Scan to verify authenticity</div>
          </div>
        </div>
        <div class="cert-micro">${'OMANI LEARNING SYSTEM · OLS · AUTHENTIC CREDENTIAL · '.repeat(14)}</div>
      </div>
    </div></div>`;
}

function showCertificate(id) {
  const ct = certOf(id); if (!ct) return;
  let tpl = Store.lget('cert-tpl', 'classic');
  const m = modal('🏅 الشهادة', `
    <div class="chip-row" id="ct-tpls">${Object.keys(CERT_TPLS).map(k => `<button class="tab-chip ${k === tpl ? 'active' : ''}" data-ct="${k}">${CERT_TPLS[k].name}</button>`).join('')}</div>
    <div class="cert-stage" id="ct-stage"></div>`,
    `<button class="btn primary" id="ct-print">🖨 طباعة / حفظ PDF</button>
     ${Auth.isAdmin ? `<button class="btn" id="ct-bg">🖼️ خلفية مخصّصة</button>` : ''}`, {wide: true});
  const draw = () => { $('#ct-stage', m.el).innerHTML = certificateHtml(ct, tpl); };
  draw();
  $$('[data-ct]', m.el).forEach(b => b.onclick = () => { tpl = b.dataset.ct; Store.lset('cert-tpl', tpl); $$('[data-ct]', m.el).forEach(x => x.classList.toggle('active', x === b)); draw(); });
  $('#ct-print', m.el).onclick = () => printCertificate(ct, tpl);
  const bgb = $('#ct-bg', m.el);
  if (bgb) bgb.onclick = () => {
    const b = `<p class="muted">يمكنك استخدام تصميم خلفية خاص بمؤسستك (مثلًا تصميم من Canva بمقاس A4 أفقي)
        ويضع النظام بيانات الطالب والختم ورمز التحقّق فوقه.</p>
      <div class="field"><label>رابط صورة الخلفية</label><input id="cb-url" value="${esc(Store.get('certBg', ''))}" placeholder="https://…/certificate.png"></div>
      <div class="field"><label>أو ارفع صورة (A4 أفقي)</label><input id="cb-file" type="file" accept="image/*"></div>`;
    const mm = modal('خلفية الشهادة', b, `<button class="btn primary" id="cb-save">حفظ</button><button class="btn" id="cb-clear">إزالة الخلفية</button>`);
    $('#cb-save', mm.el).onclick = async () => {
      const f = $('#cb-file', mm.el).files[0];
      if (f) {
        if (!checkUploadSize(f, false)) return;
        const dataUrl = await fileToDataURL(f), key = 'certbg';
        try { await uploadBlob(key, dataUrl); } catch (e) { return toast('تعذّر الرفع', 'err'); }
        Store.set('certBg', fileUrl(key, 'certbg'));
      } else Store.set('certBg', $('#cb-url', mm.el).value.trim());
      mm.close(); toast('تم حفظ الخلفية', 'ok'); draw();
    };
    $('#cb-clear', mm.el).onclick = () => { Store.set('certBg', ''); mm.close(); toast('أُزيلت الخلفية', 'ok'); draw(); };
  };
}
function printCertificate(ct, tpl) {
  const w = window.open('', '_blank');
  if (!w) return toast('اسمح بالنوافذ المنبثقة للطباعة', 'err');
  const cssHref = location.origin + location.pathname.replace(/[^/]*$/, '') + 'styles.css';
  w.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
    <title>شهادة — ${esc(ct.studentName)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&family=Amiri:wght@400;700&family=Cormorant+Garamond:wght@400;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${esc(cssHref)}">
    <style>
      /* print the decorative fills too — browsers drop CSS backgrounds by
         default, which is what flattened the frame, badge, seal and guilloche */
      *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
      @page{size:A4 landscape;margin:0}
      html,body{margin:0;padding:0;font-family:Cairo,sans-serif;background:#fff}
      .cert-stage{padding:0;margin:0;background:#fff;display:block;overflow:visible}
      /* fill the sheet exactly; cqw units inside then scale to the real page */
      .cert-sheet{width:297mm;height:210mm;max-width:none;aspect-ratio:auto;
        box-shadow:none;border-radius:0;margin:0}
      .no-print{display:none}
      @media print{.cert-sheet{page-break-after:avoid;break-inside:avoid}}
      @media screen{body{background:#dfe6ea;padding:16px}
        .cert-sheet{box-shadow:0 18px 50px rgba(0,0,0,.25)}}
    </style></head>
    <body>
      <div class="no-print" style="font-family:Cairo,sans-serif;background:#fff8e1;border:1px solid #f4d99a;
        border-radius:10px;padding:10px 14px;margin:0 auto 14px;max-width:297mm;font-size:.85rem;color:#5a3d00">
        🖨️ <b>قبل الطباعة:</b> اختر <b>حجم الورق A4</b> واتجاه <b>أفقي (Landscape)</b>،
        وأزل علامة <b>«الرؤوس والتذييلات / Headers and footers»</b> حتى لا يُطبع التاريخ والرابط على الشهادة،
        وفعّل <b>«رسومات الخلفية / Background graphics»</b> إن وُجدت.
      </div>
      <div class="cert-stage">${certificateHtml(ct, tpl)}</div>
    <script>
      (async () => {
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
        await new Promise(r => setTimeout(r, 450));      // let the QR + logo paint
        window.print();
      })();
    <\/script></body></html>`);
  w.document.close();
}

/* ---- certificates hub: browse · issue · verify ---- */
PAGES.certificates = function (params) {
  params = params || [];
  crumb('الشهادات', 'إصدار وعرض والتحقّق');
  const staff = Auth.isAdmin || Auth.isTeacher;
  const all = certificates();
  const mine = staff ? all : all.filter(c => c.student === (Auth.isParent ? (meDir().child || '') : Auth.user.u));
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🏅 الشهادات</h2>
      <p>${staff ? 'أصدر شهادات إتمام لطلبتك بعد إدخال التقييمات، أو تحقّق من شهادة برقمها.' : 'شهاداتك الصادرة من النظام — يمكنك عرضها وطباعتها.'}</p></div>
      <div class="row">
        ${staff ? `<button class="btn primary" id="cert-issue">➕ إصدار شهادة</button>` : ''}
        <a class="btn" href="#/verify">🔎 تحقّق من شهادة</a>
      </div></div>
    ${mine.length ? `<div class="cert-grid">${mine.map(c => `<div class="cert-mini" data-cert="${esc(c.id)}">
        <div class="cm-medal">🏅</div>
        <div><b>${esc(c.subject)}</b>
          <div class="muted" style="font-size:.8rem">${staff ? esc(c.studentName) + ' · ' : ''}${esc(gradeName(c.grade))} · ${esc(c.letter)} (${num(c.percent)}%)</div>
          <div class="muted" style="font-size:.72rem">${esc(c.serial)} · ${num(arDate(c.issued))}</div></div>
        <button class="btn sm primary">عرض</button></div>`).join('')}</div>`
      : `<div class="empty"><div class="big">🏅</div>
          ${staff ? `لم تُصدر أي شهادة بعد.
            <div class="muted" style="margin-top:8px;font-size:.85rem;max-width:520px;margin-inline:auto">
              الشهادة تُصدر من نتيجة الطالب المرجّحة، لذلك تحتاج أولًا: <b>صف معتمد</b> ← <b>طالب مسجّل فيه</b> ←
              <b>تقييم واحد على الأقل</b> (من تبويب «الدرجات» داخل الصف). ثم اضغط «إصدار شهادة».
            </div>
            <div style="margin-top:12px"><button class="btn primary" id="cert-issue2">➕ إصدار شهادة</button>
            <a class="btn" href="#/classes">🏫 الذهاب للصفوف</a></div>`
            : 'لم تُصدر لك شهادات بعد — تظهر هنا فور اعتماد معلّمك لها.'}</div>`}`;
  $$('[data-cert]').forEach(el => el.onclick = () => showCertificate(el.dataset.cert));
  [$('#cert-issue'), $('#cert-issue2')].forEach(b => { if (b) b.onclick = issueCertificateModal; });
};
/* pick a class → see every student's standing → issue in one click */
function issueCertificateModal() {
  const mycls = classes().filter(c => canRunClass(c));
  if (!mycls.length) return modal('إصدار شهادة', `<div class="empty"><div class="big">🏫</div>لا توجد صفوف لديك بعد.
    <p class="muted">أنشئ صفًا أولًا من صفحة «الصفوف المباشرة».</p></div>`,
    `<a class="btn primary" href="#/classes" onclick="this.closest('.modal-back').remove()">الذهاب للصفوف</a>`);
  const body = `<div class="field"><label>الصف</label><select id="ic-class">${mycls.map(c =>
      `<option value="${esc(c.id)}">${esc(c.title || c.subject)} — ${esc(gradeName(c.grade))}</option>`).join('')}</select></div>
    <div id="ic-list"></div>`;
  const m = modal('🏅 إصدار شهادة', body, '', {wide: true});
  const paint = () => {
    const cid = $('#ic-class', m.el).value, c = classById(cid), roster = classRoster(cid);
    $('#ic-list', m.el).innerHTML = roster.length ? `<table class="tbl">
        <tr><th>الطالب</th><th>النتيجة المرجّحة</th><th>التقدير</th><th></th></tr>
        ${roster.map(e => { const r = classResult(cid, e.student);
          const has = certificates().find(x => x.classId === cid && x.student === e.student);
          return `<tr><td><b>${esc(e.studentName)}</b></td>
            <td>${r ? num(r.pct) + '%' : '<span class="muted">لا توجد تقييمات</span>'}</td>
            <td>${r ? esc(r.letter) : '—'}</td>
            <td>${has ? `<button class="btn sm" data-icview="${esc(has.id)}">عرض الشهادة</button>`
              : r && r.pass ? `<button class="btn sm primary" data-icissue="${esc(e.student)}">إصدار</button>`
              : r ? '<span class="muted" style="font-size:.78rem">لم يجتز</span>'
              : `<button class="btn sm" data-icgrade="${esc(cid)}">إضافة تقييم</button>`}</td></tr>`; }).join('')}</table>`
      : `<div class="empty">لا يوجد طلبة مسجّلون في هذا الصف.</div>`;
    $$('[data-icissue]', m.el).forEach(b => b.onclick = () => {
      const e = roster.find(x => x.student === b.dataset.icissue), r = classResult(cid, e.student);
      const cs = certificates();
      cs.push({id: uid(), serial: 'OLS-' + String(Date.now()).slice(-8), classId: cid, student: e.student,
        studentName: e.studentName, subject: c.subject, grade: c.grade, className: c.title || '',
        percent: r.pct, letter: r.letter, teacherName: c.teacherName, issued: Date.now(), issuedBy: Auth.user.name});
      saveCertificates(cs); toast('تم إصدار الشهادة 🏅', 'ok'); paint(); PAGES.certificates();
    });
    $$('[data-icview]', m.el).forEach(b => b.onclick = () => { m.close(); showCertificate(b.dataset.icview); });
    $$('[data-icgrade]', m.el).forEach(b => b.onclick = () => { m.close(); classDetail(b.dataset.icgrade); });
  };
  $('#ic-class', m.el).onchange = paint;
  paint();
}

/* ---- public verification ---- */
PAGES.verify = function (params) {
  params = params || [];
  crumb('التحقّق من الشهادات', 'أدخل رقم الشهادة');
  const q = params[0] || '';
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>🔎 التحقّق من صحّة شهادة</h2><p>أدخل رقم الشهادة الظاهر أسفلها للتأكّد من صدورها من النظام.</p></div>
      <a class="btn" href="#/classes">◀ الصفوف</a></div>
    <div class="card" style="max-width:560px">
      <div class="row"><input id="vf-serial" value="${esc(q)}" placeholder="OLS-XXXXXXXX" style="flex:1;padding:.7em .9em;border:1px solid var(--line);border-radius:12px;font-weight:700">
        <button class="btn primary" id="vf-go">تحقّق</button></div>
      <div id="vf-out" style="margin-top:14px"></div>
    </div>`;
  const run = () => {
    const s = $('#vf-serial').value.trim(); if (!s) return;
    const ct = certBySerial(s);
    $('#vf-out').innerHTML = ct ? `<div class="verify-ok">
        <div style="font-size:2.4rem">✅</div><b>شهادة صحيحة وصادرة من النظام</b>
        <table class="tbl" style="margin-top:10px">
          <tr><th>الطالب</th><td>${esc(ct.studentName)}</td></tr>
          <tr><th>المادة</th><td>${esc(ct.subject)} — ${esc(gradeName(ct.grade))}</td></tr>
          <tr><th>النتيجة</th><td><b>${num(ct.percent)}%</b> · ${esc(ct.letter)}</td></tr>
          <tr><th>المعلّم</th><td>${esc(ct.teacherName || '—')}</td></tr>
          <tr><th>تاريخ الإصدار</th><td>${num(arDate(ct.issued))}</td></tr>
        </table>
        <button class="btn primary" id="vf-view" style="margin-top:10px">عرض الشهادة</button></div>`
      : `<div class="verify-no"><div style="font-size:2.4rem">⚠️</div><b>لا توجد شهادة بهذا الرقم</b>
         <p class="muted">تأكّد من الرقم كما هو مطبوع أسفل الشهادة.</p></div>`;
    const v = $('#vf-view'); if (v) v.onclick = () => showCertificate(ct.id);
  };
  $('#vf-go').onclick = run;
  $('#vf-serial').onkeydown = e => { if (e.key === 'Enter') run(); };
  if (q) run();
};


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
      <button class="btn sm" data-prof="${esc(u.u)}" title="الملف الشخصي">🪪</button>
      ${u.status === 'pending' ? `<button class="btn sm primary" data-approve="${esc(u.u)}">قبول</button><button class="btn sm danger" data-reject="${esc(u.u)}">رفض</button>` : ''}
      ${(u.role === 'معلم' || u.role === 'طالب' || u.role === 'ولي أمر') ? `<button class="btn sm" data-assign="${esc(u.u)}" title="التخصيص">📌</button>` : ''}
      ${u.role !== 'مدير' ? `<button class="btn sm" data-pw="${esc(u.u)}" title="كلمة المرور">🔑</button><button class="btn sm danger" data-del="${esc(u.u)}" title="حذف">🗑</button>` : ''}
    </div></td></tr>`).join('');
  $('#u-list').innerHTML = `
    ${pending.length ? `<div class="card" style="border-color:var(--gold);margin-bottom:14px"><b>⏳ ${num(pending.length)} طلب بانتظار الموافقة</b></div>` : ''}
    <div class="card" style="padding:0;overflow:auto"><table class="tbl">
      <tr><th>المستخدم</th><th>الدور</th><th>التخصيص / النطاق</th><th>الحالة</th><th>الإنشاء</th><th>إجراءات</th></tr>${rows}</table></div>`;
  const act = async (u, action, patch) => { try { const r = await api('/api/users', 'POST', {u, action, patch}); renderUsers(r.users); loadDirectory(); updatePendingBadge(); toast('تم', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $$('[data-prof]').forEach(b => b.onclick = () => go('profile/' + b.dataset.prof));
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
  params = params || [];
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
      <a href="#/profile">🪪 ملفي الشخصي</a>
      <a href="#/account">👤 إعدادات الحساب</a>
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
/* collapse the main nav into an overlay drawer to free page width */
function setNavCollapsed(on, remember) {
  document.body.classList.toggle('nav-collapsed', !!on);
  if (!on) closeSidebar();
  const b = $('#nav-toggle'); if (b) { b.textContent = on ? '⇤' : '⇥'; b.title = on ? 'إظهار القائمة الجانبية' : 'إخفاء القائمة الجانبية'; }
  if (remember !== false) Store.lset('nav-collapsed', !!on);
}
async function boot() {
  primeVoices();
  setNavCollapsed(Store.lget('nav-collapsed', false), false);
  const ntg = $('#nav-toggle'); if (ntg) ntg.onclick = () => setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
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
