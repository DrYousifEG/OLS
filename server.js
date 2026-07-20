/* ============================================================================
   OLS — Omani Learning System · static file server + shared accounts/data API.
   Dependency-free (Node built-ins only). Adapted from the RH ProjectHub server.
     - the first registered account becomes the single global Admin (مدير)
     - other users register (pending) and are approved by the Admin, or join
       via single-use invitation links
     - shared data (KV state), file/media blobs, and an optional AI assistant
       proxy are all served here so every device sees the same content.
   Accounts & data persist in a directory OUTSIDE the repo so redeploys don't
   overwrite them. Set OLS_DATA_DIR to pin an exact path.
   Optional: set OLS_ANTHROPIC_KEY to enable the live AI assistant (/api/assist).
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const https = require('https');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
/* must match APP_VERSION in app.js — check what's live at /api/version */
const APP_VERSION = 'v1.8 · 2026-07-15';
const STARTED = new Date().toISOString();

function pickDataDir() {
  const candidates = [process.env.OLS_DATA_DIR, path.join(os.homedir() || ROOT, 'ols-data'), path.join(ROOT, 'data')].filter(Boolean);
  for (const d of candidates) { try { fs.mkdirSync(d, {recursive: true}); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) {} }
  return path.join(ROOT, 'data');
}
const DATA_DIR = pickDataDir();
const DB_FILE = path.join(DATA_DIR, 'ols.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const BLOBMETA_FILE = path.join(DATA_DIR, 'blobmeta.json');

/* ------------------------------ data store ------------------------------- */
function loadJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function saveJson(f, obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive: true});
    const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f);
  } catch (e) { console.error('save', path.basename(f), 'failed:', e.message); }
}
function loadDB() { return loadJson(DB_FILE, {users: [], invites: [], tokens: {}}); }
function saveDB(db) { saveJson(DB_FILE, db); }
const blobFile = key => path.join(BLOB_DIR, crypto.createHash('sha1').update(String(key)).digest('hex'));

/* ------------------------------ auth helpers ----------------------------- */
const ADMIN_ROLE = 'مدير';
const ASSIGNED_ROLES = ['معلم'];                     // scoped to assigned levels
const ROLES = [ADMIN_ROLE, 'معلم', 'طالب', 'ولي أمر', 'زائر'];
const defScope = role => (ASSIGNED_ROLES.includes(role) ? 'assigned' : 'all');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const publicUser = u => ({u: u.u, name: u.name, role: u.role, status: u.status, scope: u.scope, levels: u.levels || [], child: u.child || '', created: u.created});

function tokenUser(db, token) {
  const uname = token && db.tokens[token];
  return uname ? db.users.find(x => x.u === uname) : null;
}

/* ------------------------------ API routing ------------------------------ */
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 72e6) req.destroy(); });   // ~72MB cap (base64 → ~53MB real file)
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(s);
}

async function handleApi(req, res, urlPath, query) {
  const db = loadDB();
  const method = req.method;
  const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};
  const token = req.headers['x-mis-token'] || query.token || '';
  const me = tokenUser(db, token);
  const isAdmin = me && me.role === ADMIN_ROLE;

  if (urlPath === '/api/config') {
    return json(res, 200, {mode: 'server', hasAdmin: db.users.some(u => u.role === ADMIN_ROLE), ai: !!process.env.OLS_ANTHROPIC_KEY});
  }

  if (urlPath === '/api/version') {
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    return res.end(JSON.stringify({app: 'OLS — Omani Learning System', version: APP_VERSION, serverStarted: STARTED, node: process.version, ai: !!process.env.OLS_ANTHROPIC_KEY}));
  }

  // POST /api/register {u,name,pw,role,invite}
  if (urlPath === '/api/register' && method === 'POST') {
    const u = String(body.u || '').trim().toLowerCase();
    const name = String(body.name || '').trim() || u;
    const pw = String(body.pw || '');
    if (!u || !pw) return json(res, 400, {error: 'اسم المستخدم وكلمة المرور مطلوبان.'});
    if (pw.length < 4) return json(res, 400, {error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل.'});
    if (db.users.some(x => x.u === u)) return json(res, 409, {error: 'اسم المستخدم موجود بالفعل.'});
    const first = db.users.length === 0;
    let role = ROLES.includes(body.role) ? body.role : 'طالب';
    // requested class enrollment (e.g. student picks their grade) — recorded on
    // the pending account so the admin sees and approves it
    let levels = Array.isArray(body.levels) ? body.levels.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 12).slice(0, 13) : [];
    let scope = defScope(role), status = 'pending';
    if (first) { role = ADMIN_ROLE; scope = 'all'; status = 'active'; levels = []; }
    else if (body.invite) {
      const inv = db.invites.find(i => i.token === body.invite && !i.used && (!i.expires || i.expires > Date.now()));
      if (!inv) return json(res, 400, {error: 'رابط الدعوة غير صالح أو منتهي الصلاحية.'});
      role = inv.role; scope = inv.scope || defScope(role); levels = inv.levels || []; status = 'active';
      inv.used = true; inv.usedBy = u; inv.usedAt = Date.now();
    }
    if (role === ADMIN_ROLE && !first) return json(res, 403, {error: 'يُسمح بمدير واحد فقط.'});
    const salt = crypto.randomBytes(8).toString('hex');
    db.users.push({u, name, role, status, scope, levels, child: String(body.child || ''), salt, hash: hashPw(pw, salt), created: Date.now()});
    saveDB(db);
    if (status === 'active') {
      const t = newToken(); db.tokens[t] = u; saveDB(db);
      const acc = db.users.find(x => x.u === u);
      return json(res, 200, {ok: true, status, token: t, user: publicUser(acc)});
    }
    return json(res, 200, {ok: true, status: 'pending'});
  }

  // POST /api/login {u,pw}
  if (urlPath === '/api/login' && method === 'POST') {
    const u = String(body.u || '').trim().toLowerCase();
    const acc = db.users.find(x => x.u === u);
    if (!acc || acc.hash !== hashPw(String(body.pw || ''), acc.salt)) return json(res, 401, {error: 'اسم المستخدم أو كلمة المرور غير صحيحة.'});
    if (acc.status === 'pending') return json(res, 403, {error: 'حسابك بانتظار موافقة المدير.'});
    if (acc.status === 'rejected') return json(res, 403, {error: 'تم رفض طلب الوصول — تواصل مع المدير.'});
    const t = newToken(); db.tokens[t] = u; saveDB(db);
    return json(res, 200, {ok: true, token: t, user: publicUser(acc)});
  }

  if (urlPath === '/api/session') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    return json(res, 200, {ok: true, user: publicUser(me)});
  }

  if (urlPath === '/api/logout' && method === 'POST') {
    if (token) { delete db.tokens[token]; saveDB(db); }
    return json(res, 200, {ok: true});
  }

  // POST /api/password {cur,new}
  if (urlPath === '/api/password' && method === 'POST') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    if (me.hash !== hashPw(String(body.cur || ''), me.salt)) return json(res, 403, {error: 'كلمة المرور الحالية غير صحيحة.'});
    if (String(body.new || '').length < 4) return json(res, 400, {error: 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل.'});
    me.salt = crypto.randomBytes(8).toString('hex');
    me.hash = hashPw(String(body.new), me.salt);
    saveDB(db);
    return json(res, 200, {ok: true});
  }

  // GET /api/users — admin only
  if (urlPath === '/api/users' && method === 'GET') {
    if (!isAdmin) return json(res, 403, {error: 'للمدير فقط.'});
    return json(res, 200, {ok: true, users: db.users.map(publicUser)});
  }

  // GET /api/directory — any signed-in user: minimal contact list (name/role/levels)
  // for messaging. Excludes pending/rejected accounts and all sensitive fields.
  if (urlPath === '/api/directory' && method === 'GET') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    const dir = db.users.filter(u => u.status === 'active')
      .map(u => ({u: u.u, name: u.name, role: u.role, levels: u.levels || [], child: u.child || ''}));
    return json(res, 200, {ok: true, users: dir});
  }

  // POST /api/users {action,u,patch} — admin only
  if (urlPath === '/api/users' && method === 'POST') {
    if (!isAdmin) return json(res, 403, {error: 'للمدير فقط.'});
    const target = db.users.find(x => x.u === String(body.u || '').toLowerCase());
    if (!target) return json(res, 404, {error: 'المستخدم غير موجود.'});
    const act = body.action;
    if (act === 'approve') { target.status = 'active'; if (body.role && ROLES.includes(body.role) && body.role !== ADMIN_ROLE) target.role = body.role; }
    else if (act === 'reject') target.status = 'rejected';
    else if (act === 'remove') { db.users = db.users.filter(x => x.u !== target.u); Object.keys(db.tokens).forEach(t => { if (db.tokens[t] === target.u) delete db.tokens[t]; }); }
    else if (act === 'update') {
      const p = body.patch || {};
      if (p.role && ROLES.includes(p.role) && p.role !== ADMIN_ROLE && target.role !== ADMIN_ROLE) target.role = p.role;
      if (p.scope) target.scope = p.scope;
      if (Array.isArray(p.levels)) target.levels = p.levels;
      if (typeof p.child === 'string') target.child = p.child;
      if (p.status) target.status = p.status;
    }
    else if (act === 'setpw') {
      const np = String((body.patch && body.patch.password) || '');
      if (np.length < 4) return json(res, 400, {error: 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل.'});
      target.salt = crypto.randomBytes(8).toString('hex');
      target.hash = hashPw(np, target.salt);
      Object.keys(db.tokens).forEach(t => { if (db.tokens[t] === target.u) delete db.tokens[t]; });
      saveDB(db);
      return json(res, 200, {ok: true, users: db.users.map(publicUser)});
    }
    saveDB(db);
    return json(res, 200, {ok: true, users: db.users.map(publicUser)});
  }

  // POST /api/invite {role,scope,levels,days} — admin only
  if (urlPath === '/api/invite' && method === 'POST') {
    if (!isAdmin) return json(res, 403, {error: 'للمدير فقط.'});
    let role = ROLES.includes(body.role) && body.role !== ADMIN_ROLE ? body.role : 'طالب';
    const days = Number(body.days) || 14;
    const inv = {token: newToken(), role, scope: body.scope || defScope(role), levels: Array.isArray(body.levels) ? body.levels : [],
      by: me.u, created: Date.now(), expires: Date.now() + days * 86400000, used: false};
    db.invites.push(inv);
    saveDB(db);
    return json(res, 200, {ok: true, token: inv.token, role: inv.role, expires: inv.expires});
  }

  if (urlPath === '/api/invite' && method === 'GET') {
    const inv = db.invites.find(i => i.token === query.token);
    if (!inv || inv.used || (inv.expires && inv.expires < Date.now())) return json(res, 404, {error: 'الدعوة غير صالحة أو منتهية.'});
    return json(res, 200, {ok: true, role: inv.role, scope: inv.scope, levels: inv.levels});
  }

  // ---- shared application data (KV state) ----
  if (urlPath === '/api/state' && method === 'GET') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    const since = Number(query.since) || 0;
    const st = loadJson(STATE_FILE, {kv: {}});
    const out = {};
    for (const k in st.kv) if ((st.kv[k].t || 0) > since) out[k] = st.kv[k].v;
    return json(res, 200, {ok: true, now: Date.now(), kv: out});
  }
  if (urlPath === '/api/state' && method === 'POST') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    const st = loadJson(STATE_FILE, {kv: {}});
    const now = Date.now();
    const set = (k, v) => { st.kv[k] = {v: v, t: now, by: me.u}; };
    if (Array.isArray(body.sets)) body.sets.forEach(s => { if (s && s.key) set(s.key, s.value); });
    else if (body.key) set(body.key, body.value);
    saveJson(STATE_FILE, st);
    return json(res, 200, {ok: true, now});
  }

  // ---- shared media / document blobs ----
  if (urlPath === '/api/blob' && method === 'GET') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    try { return json(res, 200, {ok: true, dataUrl: fs.readFileSync(blobFile(query.key), 'utf8')}); }
    catch (e) { return json(res, 404, {error: 'غير موجود.'}); }
  }
  if (urlPath === '/api/blob' && method === 'POST') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    // chunked upload: {key, part, seq, parts} — small requests survive shared-host
    // proxy body limits; parts are appended and finalized on the last one.
    if (typeof body.part === 'string' && body.key) {
      try {
        if (!fs.existsSync(BLOB_DIR)) fs.mkdirSync(BLOB_DIR, {recursive: true});
        const tmp = blobFile(body.key) + '.part';
        if (Number(body.seq) === 0) fs.writeFileSync(tmp, body.part); else fs.appendFileSync(tmp, body.part);
        if (Number(body.seq) >= Number(body.parts) - 1) {
          fs.renameSync(tmp, blobFile(body.key));
          const meta = loadJson(BLOBMETA_FILE, {}); meta[body.key] = Date.now(); saveJson(BLOBMETA_FILE, meta);
          return json(res, 200, {ok: true, done: true, t: meta[body.key]});
        }
        return json(res, 200, {ok: true, seq: Number(body.seq)});
      } catch (e) { return json(res, 500, {error: 'تعذّر تخزين جزء الملف.'}); }
    }
    if (!body.key || !body.dataUrl) return json(res, 400, {error: 'key و dataUrl مطلوبان.'});
    try { if (!fs.existsSync(BLOB_DIR)) fs.mkdirSync(BLOB_DIR, {recursive: true}); fs.writeFileSync(blobFile(body.key), body.dataUrl); }
    catch (e) { return json(res, 500, {error: 'تعذّر تخزين الملف.'}); }
    const meta = loadJson(BLOBMETA_FILE, {}); meta[body.key] = Date.now(); saveJson(BLOBMETA_FILE, meta);
    return json(res, 200, {ok: true, t: meta[body.key]});
  }
  if (urlPath === '/api/blob' && method === 'DELETE') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    try { fs.unlinkSync(blobFile(query.key)); } catch (e) {}
    const meta = loadJson(BLOBMETA_FILE, {}); meta[query.key] = -Date.now(); saveJson(BLOBMETA_FILE, meta);
    return json(res, 200, {ok: true});
  }
  // GET /api/file — serve a stored blob as a real, typed file (mobile PDF/video/audio)
  if (urlPath === '/api/file' && method === 'GET') {
    if (!me) { res.writeHead(401, {'Content-Type': 'text/plain'}); return res.end('Not signed in.'); }
    let dataUrl;
    try { dataUrl = fs.readFileSync(blobFile(query.key), 'utf8'); }
    catch (e) { res.writeHead(404, {'Content-Type': 'text/plain'}); return res.end('Not found.'); }
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m) { res.writeHead(415, {'Content-Type': 'text/plain'}); return res.end('Unsupported.'); }
    const mime = m[1] || 'application/octet-stream';
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    const safeName = String(query.name || 'document').replace(/[^\w.\- ]/g, '_');
    const baseHeaders = {
      'Content-Type': mime,
      'Content-Disposition': (query.dl ? 'attachment' : 'inline') + '; filename="' + safeName + '"',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    // HTTP Range support — video/audio elements (especially on phones) need 206
    // partial responses to start playback and to seek.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : 0;
      let end = range[2] ? Math.min(parseInt(range[2], 10), buf.length - 1) : buf.length - 1;
      if (!range[1] && range[2]) { start = Math.max(0, buf.length - parseInt(range[2], 10)); end = buf.length - 1; }
      if (start > end || start >= buf.length) {
        res.writeHead(416, {'Content-Range': 'bytes */' + buf.length}); return res.end();
      }
      res.writeHead(206, Object.assign({}, baseHeaders, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.length,
        'Content-Length': end - start + 1
      }));
      return res.end(buf.slice(start, end + 1));
    }
    res.writeHead(200, Object.assign({}, baseHeaders, {'Content-Length': buf.length}));
    return res.end(buf);
  }
  if (urlPath === '/api/blobmeta' && method === 'GET') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    const since = Number(query.since) || 0;
    const meta = loadJson(BLOBMETA_FILE, {});
    const out = {};
    for (const k in meta) if (Math.abs(meta[k]) > since) out[k] = meta[k];
    return json(res, 200, {ok: true, now: Date.now(), keys: out});
  }

  // ---- AI assistant proxy (optional) ----
  // POST /api/assist {messages:[{role,content}], system} → proxies to Claude API.
  // The API key stays server-side (OLS_ANTHROPIC_KEY). Without it, returns needsKey.
  if (urlPath === '/api/assist' && method === 'POST') {
    if (!me) return json(res, 401, {error: 'غير مسجّل الدخول.'});
    const key = process.env.OLS_ANTHROPIC_KEY;
    if (!key) return json(res, 200, {ok: false, needsKey: true, error: 'المساعد الذكي غير مُفعّل على الخادم (لم يُضبط مفتاح API).'});
    const payload = JSON.stringify({
      model: body.model || 'claude-opus-4-8',
      max_tokens: Math.min(Number(body.max_tokens) || 1600, 4096),
      system: String(body.system || 'أنت مساعد تعليمي عُماني للمنهج الدراسي. أجب بالعربية الفصحى المبسّطة، واذكر المصدر عند توفره.'),
      messages: Array.isArray(body.messages) ? body.messages.slice(-12) : []
    });
    const opts = {method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(payload)}};
    try {
      const upstream = await new Promise((resolve, reject) => {
        const r = https.request(opts, resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({status: resp.statusCode, body: d})); });
        r.on('error', reject); r.write(payload); r.end();
      });
      let parsed = {}; try { parsed = JSON.parse(upstream.body); } catch (e) {}
      if (upstream.status >= 400) return json(res, 200, {ok: false, error: (parsed.error && parsed.error.message) || 'تعذّر الاتصال بالمساعد الذكي.'});
      const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return json(res, 200, {ok: true, text});
    } catch (e) {
      return json(res, 200, {ok: false, error: 'تعذّر الاتصال بخدمة المساعد الذكي.'});
    }
  }

  return json(res, 404, {error: 'نقطة API غير معروفة.'});
}

/* ------------------------------ static files ----------------------------- */
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'};
function sendFile(res, filePath, status) {
  const ext = path.extname(filePath).toLowerCase();
  const cache = ['.html', '.js', '.mjs', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(status || 200, {'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache});
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let urlPath = decodeURIComponent(u.pathname);

    if (urlPath.startsWith('/api/')) {
      const query = Object.fromEntries(u.searchParams.entries());
      handleApi(req, res, urlPath, query).catch(e => { json(res, 500, {error: 'خطأ في الخادم'}); });
      return;
    }

    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const filePath = path.join(ROOT, path.normalize(urlPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.stat(filePath, (err, st) => {
      if (!err && st.isFile()) { sendFile(res, filePath); return; }
      if (!path.extname(urlPath)) {
        const idx = path.join(ROOT, 'index.html');
        fs.access(idx, fs.constants.R_OK, e => { if (e) { res.writeHead(404); res.end('Not found'); return; } sendFile(res, idx); });
        return;
      }
      res.writeHead(404); res.end('Not found');
    });
  } catch (e) { res.writeHead(500); res.end('Server error'); }
});

server.listen(PORT, HOST, () => {
  console.log('OLS server (static + accounts + shared data + AI) on http://' + HOST + ':' + PORT);
  console.log('Data directory: ' + DATA_DIR);
  console.log('AI assistant: ' + (process.env.OLS_ANTHROPIC_KEY ? 'enabled' : 'disabled (set OLS_ANTHROPIC_KEY)'));
});
