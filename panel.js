/**
 * panel.js — Admin Panel untuk wa-api (Comic 3D Edition)
 * Jalan di port 2579, akses via /panel
 * Auth: session-based + bcrypt
 */

const express  = require('express')
const session  = require('express-session')
const bcrypt   = require('bcryptjs')
const multer   = require('multer')
const path     = require('path')
const fs       = require('fs')
const crypto   = require('crypto')

const app = express()

// ── Config ────────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PANEL_PORT) || 2579
const WA_API_DIR = process.env.WA_API_DIR           || '/root/wa-api'
const DB_PATH    = path.join(WA_API_DIR, 'database.json')
const FUNC_DIR   = path.join(WA_API_DIR, 'function')
const DATA_FILE  = path.join(__dirname, '.panel-data.json')
const SESSION_TTL  = 30 * 24 * 60 * 60 * 1000
const SESSION_FILE = path.join(__dirname, '.panel-sessions.json')
// secret disimpan permanen supaya cookie lama tetap valid setelah panel di-restart
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
    const d = loadData()
    if (!d.sessionSecret) { d.sessionSecret = crypto.randomBytes(32).toString('hex'); saveData(d) }
    return d.sessionSecret
})()

// ── Helpers ───────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
const jsFile = f => path.basename(String(f).endsWith('.js') ? String(f) : f + '.js')

function loadData() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } catch { return {} } }
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)) }

async function initData() {
    const data = loadData()
    if (!data.username) data.username = 'admindhann'
    if (!data.password) data.password = await bcrypt.hash('dhann123123*', 12)
    if (!data.apiKeys)  data.apiKeys  = []
    if (!data.maint)    data.maint    = { api: false, web: false, msg: '' }
    if (!data.backups)  data.backups  = []
    if (!data.ui)       data.ui       = { navSide: 'left', fx: true }
    saveData(data)
    return data
}

function loadDb() { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) } catch { return [] } }
function saveDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)) }

const getUi = () => ({ navSide: 'left', fx: true, ...(loadData().ui || {}) })

// ── Analisis source function: module.exports, require, dependensi ─────────────
const BUILTIN     = new Set(require('module').builtinModules)
const COMMON_MODS = ['crypto', 'fs', 'path', 'os', 'axios', 'util', 'https', 'http', 'zlib', 'url', 'stream']
const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

function analyzeSource(src) {
    const code = stripComments(String(src || ''))
    const res = { empty: !code.trim(), hasExport: false, exportName: '', fnName: '', issues: [], deps: [] }
    if (res.empty) return res

    const fm = code.match(/(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/)
        || code.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
    res.fnName = fm ? fm[1] : ''

    const em = code.match(/module\s*\.\s*exports\s*=\s*([^;\n]*)/)
    res.hasExport = !!em
    if (em) res.exportName = (em[1].trim().match(/^[A-Za-z_$][\w$]*$/) || [''])[0]

    if (/^\s*(import\s.+\sfrom\s|export\s+default\s)/m.test(code))
        res.issues.push({ level: 'danger', text: 'Terdeteksi sintaks ESM (import / export default). wa-api memakai CommonJS: pakai const x = require(...) dan module.exports = ...' })

    if (!em) {
        res.issues.push({ level: 'warn', addExport: res.fnName,
            text: 'Belum ada module.exports di bagian bawah file.' + (res.fnName ? '' : ' Tulis manual: module.exports = namaFunction') })
    } else if (res.exportName && !new RegExp('(?:function\\s*\\*?\\s*|(?:const|let|var|class)\\s+)' + res.exportName.replace(/\$/g, '\\$') + '\\b').test(code)) {
        res.issues.push({ level: 'warn', text: 'module.exports = ' + res.exportName + ', tapi "' + res.exportName + '" belum didefinisikan di file ini.' })
    }

    const seen = new Set(), re = /require\(\s*(['"`])([^'"`]+)\1\s*\)/g
    let m
    while ((m = re.exec(code))) {
        const name = m[2]
        if (seen.has(name)) continue
        seen.add(name)
        let kind, ok, hint = ''
        if (name.startsWith('.')) {
            kind = 'file lokal'
            const base = path.resolve(FUNC_DIR, name)
            ok = [base, base + '.js', base + '.json', path.join(base, 'index.js')].some(p => { try { return fs.statSync(p).isFile() } catch { return false } })
        } else if (BUILTIN.has(name.replace(/^node:/, ''))) {
            kind = 'bawaan Node'; ok = true
        } else {
            kind = 'package'
            try { require.resolve(name, { paths: [WA_API_DIR] }); ok = true }
            catch { ok = false; hint = `cd ${WA_API_DIR} && npm i ${name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]}` }
        }
        res.deps.push({ name, kind, ok, hint })
    }

    // modul umum dipakai tapi belum di-require
    for (const mod of COMMON_MODS) {
        const used = new RegExp('(^|[^\\w$.])' + mod + '\\.[A-Za-z_$]').test(code)
        const declared = new RegExp('\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b' + mod + '\\b[^}]*\\}|' + mod + ')\\s*=').test(code)
            || new RegExp('\\bfunction\\s+' + mod + '\\b').test(code)
        if (used && !declared) res.issues.push({ level: 'warn', addReq: mod, text: `Kode memakai "${mod}" tapi belum ada: const ${mod} = require('${mod}')` })
    }
    return res
}

function renderAnalysis(a) {
    if (a.empty) return ''
    const icon = { warn: 'alert', danger: 'boom' }
    let h = a.issues.map(i => {
        let act = ''
        if (i.addExport) act = `<div style="margin-top:8px"><button type="button" class="btn btn-blue btn-sm" data-addexp="${esc(i.addExport)}">Tambahkan module.exports = ${esc(i.addExport)}</button></div>`
        if (i.addReq)    act = `<div style="margin-top:8px"><button type="button" class="btn btn-blue btn-sm" data-addreq="${esc(i.addReq)}">Tambahkan const ${esc(i.addReq)} = require</button></div>`
        return `<div class="alert alert-${i.level === 'danger' ? 'danger' : 'warn'}">${ic(icon[i.level] || 'alert', 20)}<div>${esc(i.text)}${act}</div></div>`
    }).join('')
    if (a.hasExport && !a.issues.length)
        h = `<div class="alert alert-success">${ic('check', 20)}<span>module.exports ditemukan${a.exportName ? ': ' + esc(a.exportName) : ''}. Siap dipakai.</span></div>`
    if (a.deps.length) {
        const missing = a.deps.filter(d => !d.ok)
        h += `<div class="deps"><div class="form-label">Bahan yang dibutuhkan (require)</div>
<div class="chips">${a.deps.map(d => `<span class="badge ${d.ok ? 'b-green' : 'b-red'}"><i class="bd"></i><code>${esc(d.name)}</code>${d.ok ? esc(d.kind) : 'belum ada'}</span>`).join('')}</div>
${missing.map(d => `<div class="hint">${d.hint ? 'Pasang dulu: ' + esc(d.hint) : esc(d.name) + ' tidak ketemu (' + esc(d.kind) + ')'}</div>`).join('')}</div>`
    }
    return h
}

const srcWarn = src => {
    const a = analyzeSource(src)
    const p = a.issues.map(i => i.text)
    const miss = a.deps.filter(d => !d.ok).map(d => d.name)
    if (miss.length) p.push('Belum terpasang: ' + miss.join(', '))
    return p.join(' | ')
}

/**
 * Cari file source sebuah function. Dicoba beberapa lokasi karena isi field "file"
 * di database.json bisa berupa nama saja, path relatif, atau tanpa ekstensi.
 */
function resolveFuncFile(f) {
    const raw   = String(f.file || '')
    const names = [...new Set([raw, raw.endsWith('.js') ? raw : raw + '.js'])].filter(Boolean)
    const tried = []
    for (const n of names) {
        tried.push(path.join(FUNC_DIR, path.basename(n)))
        tried.push(path.resolve(WA_API_DIR, n))
        tried.push(path.resolve(FUNC_DIR, n))
        tried.push(path.join(WA_API_DIR, path.basename(n)))
    }
    const root = path.resolve(WA_API_DIR) + path.sep
    const ok = p => p.startsWith(root) && p.endsWith('.js') && fs.existsSync(p) && fs.statSync(p).isFile()
    for (const p of new Set(tried)) if (ok(p)) return { file: p, tried: [...new Set(tried)] }
    // terakhir: cocokkan nama tanpa peduli huruf besar/kecil di folder function
    try {
        const want = jsFile(raw).toLowerCase()
        const hit  = fs.readdirSync(FUNC_DIR).find(x => x.toLowerCase() === want)
        if (hit) return { file: path.join(FUNC_DIR, hit), tried: [...new Set(tried)] }
    } catch {}
    return { file: null, tried: [...new Set(tried)] }
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Session disimpan ke file, jadi restart / update panel.js tidak perlu login ulang
class FileStore extends session.Store {
    constructor(file) {
        super()
        this.file = file
        this.map  = {}
        this._t   = null
        try { this.map = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
        setInterval(() => this._gc(), 60 * 60 * 1000).unref()
        this._gc()
    }
    _exp(sess) { const e = sess && sess.cookie && sess.cookie.expires; return e ? new Date(e).getTime() : Date.now() + SESSION_TTL }
    _write() {
        clearTimeout(this._t)
        try {
            const tmp = this.file + '.tmp'
            fs.writeFileSync(tmp, JSON.stringify(this.map), { mode: 0o600 })
            fs.renameSync(tmp, this.file)
        } catch (e) { console.error('[PANEL] gagal simpan session:', e.message) }
    }
    _later() { clearTimeout(this._t); this._t = setTimeout(() => this._write(), 200) }
    _gc() {
        const now = Date.now(); let ch = false
        for (const k of Object.keys(this.map)) if (this.map[k].exp < now) { delete this.map[k]; ch = true }
        if (ch) this._write()
    }
    flush() { this._write() }
    get(sid, cb) {
        const r = this.map[sid]
        if (!r) return cb(null, null)
        if (r.exp < Date.now()) { delete this.map[sid]; this._later(); return cb(null, null) }
        cb(null, r.data)
    }
    set(sid, sess, cb)   { this.map[sid] = { data: sess, exp: this._exp(sess) }; this._write(); cb && cb() }
    touch(sid, sess, cb) { const r = this.map[sid]; if (r) { r.exp = this._exp(sess); r.data = sess; this._later() } cb && cb() }
    destroy(sid, cb)     { delete this.map[sid]; this._write(); cb && cb() }
}
const store = new FileStore(SESSION_FILE)
;['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { store.flush(); process.exit(0) }))
process.on('exit', () => store.flush())

app.set('trust proxy', 1)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))
app.use(session({
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: SESSION_TTL, httpOnly: true, sameSite: 'lax' }
}))

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.js')) cb(null, true)
        else cb(new Error('Hanya file .js yang diizinkan'))
    }
})

function auth(req, res, next) {
    if (req.session?.loggedIn) return next()
    res.redirect('/panel/login')
}

const loginAttempts = new Map()
function rateLimit(req, res, next) {
    const ip  = req.ip
    const now = Date.now()
    const rec = loginAttempts.get(ip) || { count: 0, reset: now + 300000 }
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 300000 }
    if (rec.count >= 5) {
        return res.status(429).send(loginPage(`Kebanyakan percobaan! Coba lagi dalam ${Math.ceil((rec.reset - now) / 60000)} menit.`))
    }
    loginAttempts.set(ip, rec)
    next()
}

// ── Ikon SVG (gambar vektor, bukan emoji) ─────────────────────────────────────
const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    bolt:      '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    plus:      '<path d="M12 5v14M5 12h14"/>',
    key:       '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    wrench:    '<path d="M14.7 6.3a4 4 0 0 0-5.4 5L3 17.6 6.4 21l6.3-6.3a4 4 0 0 0 5-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    save:      '<path d="M4 4h13l3 3v13H4z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>',
    gear:      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    edit:      '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
    trash:     '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    pause:     '<path d="M8 5v14M16 5v14"/>',
    play:      '<path d="M7 4l13 8-13 8z"/>',
    download:  '<path d="M12 3v12M6 10l6 6 6-6M4 20h16"/>',
    upload:    '<path d="M12 17V5M6 10l6-6 6 6M4 20h16"/>',
    globe:     '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    box:       '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    copy:      '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    check:     '<path d="M4 12l5 5L20 6"/>',
    alert:     '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
    boom:      '<path d="M6 6l12 12M18 6L6 18"/>',
    info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    menu:      '<path d="M4 6h16M4 12h16M4 18h16"/>',
    logout:    '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
    signal:    '<path d="M4 10a11 11 0 0 1 16 0M7.5 13.5a6 6 0 0 1 9 0M12 18v.5"/>',
    folder:    '<path d="M3 6h7l2 2h9v11H3z"/>',
    code:      '<path d="M6 3h8l5 5v13H6z"/><path d="M9 14l-2 2 2 2M15 14l2 2-2 2"/>',
    lock:      '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    sparkle:   '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
    clip:      '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM8 12h8M8 16h5"/>',
    burst:     '<path d="M12 2l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z"/>',
}
const ic = (n, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`

// bintang ledakan comic (dipakai di favicon, "POW!", dll)
const burstPts = (n = 12, ro = 47, ri = 33) => {
    const p = []
    for (let i = 0; i < n * 2; i++) {
        const a = Math.PI * i / n, r = i % 2 ? ri : ro
        p.push((50 + r * Math.cos(a)).toFixed(1) + ',' + (50 + r * Math.sin(a)).toFixed(1))
    }
    return p.join(' ')
}
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="${burstPts()}" fill="#ffd93d" stroke="#16110f" stroke-width="6" stroke-linejoin="round"/><path d="M52 24L34 54h14l-3 22 22-34H53z" fill="#ff5148" stroke="#16110f" stroke-width="4" stroke-linejoin="round"/></svg>`)

const pow = (txt, cls = '') => `<svg class="pow ${cls}" viewBox="0 0 100 100" aria-hidden="true"><polygon points="${burstPts(11, 48, 34)}" fill="#ff5148" stroke="#16110f" stroke-width="4" stroke-linejoin="round"/><text x="50" y="58" text-anchor="middle" fill="#fff" stroke="#16110f" stroke-width="3" paint-order="stroke" style="font:30px var(--head)">${txt}</text></svg>`

// kubus 3D berputar (CSS 3D murni)
const cube = (s = 90, drag = false) => `<div class="scene"${drag ? ' data-drag' : ''} style="--s:${s}px"><div class="cube${drag ? '' : ' css'}">${['bolt', 'key', 'wrench', 'save', 'gear', 'globe'].map((n, i) => `<div class="f f${i + 1}">${ic(n, Math.round(s * .5))}</div>`).join('')}</div><div class="cube-shadow"></div></div>`

// ── Tema Comic 3D ─────────────────────────────────────────────────────────────
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@400;700;900&display=swap" rel="stylesheet">`

const CSS = `
:root{
  --ink:#16110f;--paper:#fffdf5;--panel:#ffffff;
  --yellow:#ffd93d;--red:#ff5148;--blue:#3d8bff;--pink:#ff7ac6;--green:#3ddc84;--orange:#ff9f1c;
  --muted:#5c524c;--shadow:6px 6px 0 var(--ink);--shadow-sm:3px 3px 0 var(--ink);--bw:3px;
  --head:'Bangers','Impact','Comic Sans MS',cursive;--body:'Comic Neue','Comic Sans MS','Chalkboard SE',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--body);font-weight:700;font-size:15px;color:var(--ink);min-height:100vh;
  background-color:var(--paper);
  background-image:radial-gradient(rgba(22,17,15,.13) 1.3px,transparent 1.5px);background-size:14px 14px}
a{color:var(--blue);font-weight:900}
code{font-family:'Courier New',monospace;font-weight:700}
:focus-visible{outline:3px dashed var(--blue);outline-offset:2px}
h1,h2,h3{font-family:var(--head);font-weight:400;letter-spacing:1px}
.ic{display:block;flex-shrink:0}

/* ── Layout ── */
.wrap{display:flex;min-height:100vh}
.sidebar{width:236px;background:var(--yellow);border-right:var(--bw) solid var(--ink);position:fixed;inset:0 auto 0 0;z-index:100;display:flex;flex-direction:column}
.logo{padding:18px 16px;border-bottom:var(--bw) solid var(--ink);background:var(--red);color:#fff;display:flex;align-items:center;gap:10px}
.logo-mark{width:44px;height:44px;flex-shrink:0;filter:drop-shadow(3px 3px 0 var(--ink));animation:bob 3s ease-in-out infinite}
.logo b{font-family:var(--head);font-weight:400;font-size:28px;letter-spacing:1.5px;display:block;line-height:1;text-shadow:3px 3px 0 var(--ink)}
.logo small{font-size:11px;font-weight:900;color:var(--ink);background:var(--yellow);border:2px solid var(--ink);padding:0 7px;display:inline-block;margin-top:6px;transform:rotate(-2deg)}
.nav{flex:1;padding:12px;overflow-y:auto;perspective:700px}
.nav-label{font-family:var(--head);font-size:16px;letter-spacing:1px;margin:12px 4px 6px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 11px;margin-bottom:7px;background:var(--panel);color:var(--ink);border:2px solid var(--ink);border-radius:10px;font-weight:900;text-decoration:none;box-shadow:var(--shadow-sm);transform-origin:left center;transition:transform .15s,box-shadow .15s}
.nav-item:hover{transform:rotateY(-14deg) translate(-1px,-1px);box-shadow:5px 5px 0 var(--ink)}
.nav-item:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink)}
.nav-item.active{background:var(--pink)}
.side-foot{padding:12px;border-top:var(--bw) solid var(--ink)}
.pill{display:flex;align-items:center;gap:8px;background:var(--panel);border:2px solid var(--ink);border-radius:20px;padding:6px 12px;font-size:12px;font-weight:900}
.bd{display:inline-block;width:9px;height:9px;border-radius:50%;background:currentColor;border:2px solid var(--ink);flex-shrink:0}
.pill .bd{background:var(--green)}

.main{margin-left:236px;flex:1;min-width:0}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 22px;background:var(--paper);border-bottom:var(--bw) solid var(--ink);position:sticky;top:0;z-index:50}
.topbar h1{font-size:34px;line-height:1;text-shadow:3px 3px 0 var(--yellow)}
.top-right{display:flex;align-items:center;gap:10px}
#clk{font-size:13px;font-weight:900;background:var(--panel);border:2px solid var(--ink);border-radius:8px;padding:3px 9px}
.hbg{display:none}
.content{padding:22px;max-width:1040px;perspective:1100px}

/* ── Card & efek 3D ── */
.card{background:var(--panel);border:var(--bw) solid var(--ink);border-radius:14px;box-shadow:var(--shadow);padding:18px;margin-bottom:24px;position:relative}
.card-title{font-family:var(--head);font-size:22px;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.ct-icon{width:38px;height:38px;border:2px solid var(--ink);border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:2px 2px 0 var(--ink);flex-shrink:0}
.c-pink{background:var(--pink)}.c-yellow{background:var(--yellow)}.c-blue{background:var(--blue)}.c-green{background:var(--green)}.c-red{background:var(--red)}.c-orange{background:var(--orange)}

.tilt{transform:perspective(900px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg)) rotateZ(var(--rz,0deg));transition:transform .18s ease-out;will-change:transform}
@keyframes flipin{from{opacity:0;transform:perspective(900px) rotateX(-65deg) translateY(26px)}to{opacity:1}}
.content>*{animation:flipin .65s cubic-bezier(.2,.9,.3,1.1) backwards;animation-delay:calc(var(--i,0)*70ms);transform-origin:50% 0}
@keyframes bob{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-6px) rotate(4deg)}}

.hero{display:flex;align-items:center;gap:26px;padding:22px 26px;background:var(--yellow);overflow:visible}
.hero h2{font-size:38px;line-height:1;text-shadow:3px 3px 0 #fff}
.hero p{margin-top:8px;max-width:360px}
.hero .pow{position:absolute;right:-12px;top:-26px;width:104px;transform:rotate(12deg);filter:drop-shadow(4px 4px 0 var(--ink));animation:bob 2.6s ease-in-out infinite}
.pow{display:block}

.scene{width:var(--s);height:var(--s);perspective:600px;flex-shrink:0;position:relative;margin:10px}
.cube{width:100%;height:100%;position:relative;transform-style:preserve-3d;transform:rotateX(-24deg)}
.cube.css{animation:spin 14s linear infinite}
.scene[data-drag]{touch-action:pan-y;cursor:grab}.scene[data-drag]:active{cursor:grabbing}
.cube .f{position:absolute;inset:0;border:3px solid var(--ink);display:flex;align-items:center;justify-content:center;color:var(--ink);backface-visibility:visible}
.f1{background:var(--pink);transform:translateZ(calc(var(--s)/2))}
.f2{background:var(--blue);color:#fff!important;transform:rotateY(90deg) translateZ(calc(var(--s)/2))}
.f3{background:var(--green);transform:rotateY(180deg) translateZ(calc(var(--s)/2))}
.f4{background:var(--orange);transform:rotateY(-90deg) translateZ(calc(var(--s)/2))}
.f5{background:#fff;transform:rotateX(90deg) translateZ(calc(var(--s)/2))}
.f6{background:var(--red);color:#fff!important;transform:rotateX(-90deg) translateZ(calc(var(--s)/2))}
@keyframes spin{from{transform:rotateX(-24deg) rotateY(0)}to{transform:rotateX(-24deg) rotateY(360deg)}}
.cube-shadow{position:absolute;left:12%;right:12%;bottom:calc(var(--s)*-.28);height:14px;border-radius:50%;background:rgba(22,17,15,.28);filter:blur(3px)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:18px;margin-bottom:24px}
.stat{border:var(--bw) solid var(--ink);border-radius:14px;box-shadow:var(--shadow);padding:14px 14px 12px;position:relative;transform-style:preserve-3d}
.stat:nth-child(odd){--rz:-1deg}.stat:nth-child(even){--rz:1deg}
.stat-val{font-family:var(--head);font-size:48px;line-height:1;text-shadow:3px 3px 0 rgba(255,255,255,.75);transform:translateZ(24px)}
.stat-label{font-size:13px;font-weight:900;transform:translateZ(12px)}
.stat .ic{position:absolute;right:12px;top:12px;opacity:.35;transform:translateZ(8px)}

/* ── Form ── */
.form-group{margin-bottom:14px}
.form-label{display:block;font-size:13px;font-weight:900;margin-bottom:5px}
.form-input,.form-select,.form-textarea{width:100%;background:#fff;border:var(--bw) solid var(--ink);border-radius:10px;padding:9px 12px;color:var(--ink);font-family:var(--body);font-size:15px;font-weight:700;outline:none;box-shadow:inset 3px 3px 0 rgba(22,17,15,.08)}
.form-input:focus,.form-select:focus,.form-textarea:focus{background:#fffbe0;box-shadow:3px 3px 0 var(--blue)}
.form-textarea{resize:vertical;min-height:140px;font-family:'Courier New',monospace;font-size:13px;line-height:1.55;tab-size:2;white-space:pre}
.form-row{display:flex;gap:14px}.form-row .form-group{flex:1;min-width:0}
.hint{font-size:12px;color:var(--muted);margin-top:4px;word-break:break-all}

/* ── Button 3D ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 16px;border:var(--bw) solid var(--ink);border-radius:12px;background:var(--yellow);color:var(--ink);font-family:var(--head);font-size:17px;letter-spacing:1px;cursor:pointer;text-decoration:none;box-shadow:0 5px 0 var(--ink),0 7px 0 rgba(22,17,15,.25);transform:translateY(-2px);transition:transform .1s,box-shadow .1s;white-space:nowrap}
.btn:hover{transform:translateY(-4px);box-shadow:0 7px 0 var(--ink),0 10px 0 rgba(22,17,15,.2);text-decoration:none}
.btn:active{transform:translateY(3px);box-shadow:0 0 0 var(--ink)}
.btn-primary{background:var(--pink)}.btn-mint{background:var(--green)}.btn-blue{background:var(--blue);color:#fff}
.btn-danger{background:var(--red);color:#fff}.btn-ghost{background:#fff}
.btn-sm{padding:5px 11px;font-size:15px;border-radius:9px;border-width:2px;box-shadow:0 4px 0 var(--ink)}
.btn-group{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding-bottom:6px}

/* ── Tabel ── */
.table-wrap{overflow-x:auto;border:var(--bw) solid var(--ink);border-radius:12px;padding-bottom:6px;background:#fff}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}
th{text-align:left;padding:10px 12px;font-family:var(--head);font-size:17px;font-weight:400;letter-spacing:1px;background:var(--blue);color:#fff;border-bottom:var(--bw) solid var(--ink);white-space:nowrap}
td{padding:10px 12px;border-bottom:2px dashed rgba(22,17,15,.25);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#fff7c2}

.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border:2px solid var(--ink);border-radius:20px;font-size:12px;font-weight:900;background:#fff}
.b-blue{background:#bcd8ff}.b-green{background:#a9f0c8}.b-red{background:#ffb3ae}.b-pink{background:#ffc5e6}.b-off{background:#e4e0da;color:var(--muted)}
.b-green .bd{background:var(--green)}.b-off .bd{background:#aaa}

.alert{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border:var(--bw) solid var(--ink);border-radius:12px;box-shadow:var(--shadow-sm);font-weight:900;margin-bottom:18px;background:#fff}
.alert .ic{margin-top:1px}
.alert-success{background:#a9f0c8}.alert-danger{background:#ffb3ae}.alert-warn{background:#ffe9a0}.alert-info{background:#cfe3ff}

.toggle{position:relative;width:54px;height:30px;flex-shrink:0;display:inline-block}
.toggle input{opacity:0;width:0;height:0;position:absolute}
.toggle-slider{position:absolute;inset:0;background:#e4e0da;border:var(--bw) solid var(--ink);border-radius:20px;cursor:pointer;transition:background .15s}
.toggle-slider::before{content:'';position:absolute;left:2px;top:2px;width:20px;height:20px;background:#fff;border:2px solid var(--ink);border-radius:50%;transition:transform .15s;box-shadow:2px 2px 0 var(--ink)}
.toggle input:checked+.toggle-slider{background:var(--green)}
.toggle input:checked+.toggle-slider::before{transform:translateX(24px)}
.toggle input:focus-visible+.toggle-slider{outline:3px dashed var(--blue);outline-offset:2px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:2px dashed rgba(22,17,15,.25)}
.toggle-row:last-of-type{border-bottom:none}
.toggle-info h4{font-size:15px;font-weight:900}.toggle-info p{font-size:12px;color:var(--muted)}

.code{background:var(--ink);color:var(--green);border-radius:10px;padding:12px;font-family:'Courier New',monospace;font-size:13px;line-height:1.7;overflow-x:auto;white-space:pre;border:var(--bw) solid var(--ink)}
.key-box{display:flex;align-items:center;gap:10px;background:#fff;border:var(--bw) solid var(--ink);border-radius:12px;padding:10px 12px;margin-bottom:14px;box-shadow:var(--shadow-sm);flex-wrap:wrap}
.key-val{font-family:'Courier New',monospace;font-size:13px;word-break:break-all;background:#fff7c2;border:2px dashed var(--ink);border-radius:6px;padding:3px 7px;margin-top:4px}
.divider{height:0;border-top:3px dashed var(--ink);margin:16px 0;opacity:.35}
.empty{text-align:center;padding:26px 10px;font-family:var(--head);font-size:22px;letter-spacing:1px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px}

/* ── Login ── */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;perspective:1000px}
.login-box{background:#fff;border:4px solid var(--ink);border-radius:18px;box-shadow:10px 10px 0 var(--ink);padding:28px;width:100%;max-width:380px;position:relative}
.login-box .scene{margin:6px auto 22px}
.login-box h1{font-size:44px;text-align:center;line-height:1;text-shadow:4px 4px 0 var(--yellow);margin-bottom:6px}
.login-sub{text-align:center;font-weight:900;margin-bottom:20px;color:var(--muted)}

/* ── Modal ── */
.modal{position:fixed;inset:0;background:rgba(22,17,15,.65);z-index:200;display:none;align-items:center;justify-content:center;padding:20px;perspective:900px}
.modal.open{display:flex}
.modal.open .modal-box{animation:pop .35s cubic-bezier(.2,1.3,.4,1)}
@keyframes pop{from{opacity:0;transform:rotateX(-55deg) scale(.85)}to{opacity:1}}
.modal-box{background:#fff;border:4px solid var(--ink);border-radius:16px;box-shadow:8px 8px 0 var(--ink);padding:22px;width:100%;max-width:420px}
.modal-title{font-family:var(--head);font-size:30px;letter-spacing:1px;margin-bottom:4px;color:var(--red)}
.modal-actions{display:flex;gap:12px;justify-content:flex-end;margin-top:18px}

/* ── Analisis source ── */
#analysis{margin-bottom:6px}
#analysis .alert{margin-bottom:12px}
.deps{margin:4px 0 14px}.deps .chips{margin-bottom:6px}

/* ── Efek latar 3D ── */
.wrap{position:relative;z-index:1}
.bgfx{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;display:none}
.bgfx .scene{position:absolute;margin:0;animation:floaty 7s ease-in-out infinite}
.bgfx .scene:nth-child(1){left:4%;top:34%}
.bgfx .scene:nth-child(2){right:3%;top:62%;animation-delay:-2s}
.bgfx .scene:nth-child(3){left:46%;bottom:5%;animation-delay:-4s}
.bgfx .cube-shadow{display:none}
@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-18px)}}

/* ── Navigasi bawah (HP) ── */
@property --x{syntax:'<length>';inherits:true;initial-value:50px}
.bottomnav{--x:50px;--rn:34px;display:none;position:fixed;left:14px;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));height:66px;z-index:150;transition:--x .6s cubic-bezier(.3,1.35,.5,1)}
.bn-shape{position:absolute;inset:0;filter:drop-shadow(0 5px 0 var(--ink))}
.bn-ink,.bn-bar{position:absolute}
.bn-ink{inset:-3px;border-radius:21px;background:var(--ink);-webkit-mask:radial-gradient(circle at calc(var(--x) + 3px) 7px,transparent calc(var(--rn) - 3px),#000 calc(var(--rn) - 2.5px));mask:radial-gradient(circle at calc(var(--x) + 3px) 7px,transparent calc(var(--rn) - 3px),#000 calc(var(--rn) - 2.5px))}
.bn-bar{inset:0;border-radius:18px;background:#fff;-webkit-mask:radial-gradient(circle at var(--x) 4px,transparent var(--rn),#000 calc(var(--rn) + .5px));mask:radial-gradient(circle at var(--x) 4px,transparent var(--rn),#000 calc(var(--rn) + .5px))}
.bn-bubble{position:absolute;left:var(--x);top:-23px;width:54px;height:54px;margin-left:-27px;border-radius:50%;background:var(--green);border:3px solid var(--ink);box-shadow:0 4px 0 var(--ink);display:flex;align-items:center;justify-content:center;color:var(--ink);pointer-events:none}
.bn-list{position:relative;display:flex;height:100%;padding:0 6px}
.bn-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--ink);text-decoration:none;-webkit-tap-highlight-color:transparent;transition:transform .12s}
.bn-item:active{transform:scale(.86)}
.bn-item span{display:none;font-size:11px;font-weight:900}
.bn-item.active{justify-content:flex-end;padding-bottom:6px}
.bn-item.active .ic{display:none}
.bn-item.active span{display:block}
.bottomnav.none{--rn:0px}.bottomnav.none .bn-bubble{display:none}

/* ── Transisi halaman 3D (Chrome) ── */
@view-transition{navigation:auto}
.topbar{view-transition-name:topbar}
.sidebar{view-transition-name:sidebar}
.bottomnav{view-transition-name:bottomnav}
::view-transition-old(root){animation:vt-out .25s ease-in both}
::view-transition-new(root){animation:vt-in .5s cubic-bezier(.2,.9,.3,1.1) both}
@keyframes vt-out{to{opacity:0;transform:perspective(1000px) rotateY(16deg) translateX(-20px) scale(.97)}}
@keyframes vt-in{from{opacity:0;transform:perspective(1000px) rotateY(-16deg) translateX(20px) scale(.97)}}

/* ── Login & sambutan ── */
.login-box{animation:flipin .8s cubic-bezier(.2,.9,.3,1.1) backwards}
.login-box.shake{animation:shake .45s}
@keyframes shake{20%,60%{margin-left:-10px}40%,80%{margin-left:10px}}
.welcome{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;pointer-events:none;overflow:hidden;
  background-color:var(--yellow);background-image:radial-gradient(rgba(22,17,15,.2) 2px,transparent 2.5px);background-size:16px 16px;
  animation:wipe 1.8s cubic-bezier(.7,0,.3,1) forwards}
@keyframes wipe{0%,60%{clip-path:circle(150% at 50% 50%)}100%{clip-path:circle(0 at 50% 50%)}}
.w-burst{position:absolute;width:min(92vw,540px);filter:drop-shadow(6px 6px 0 var(--ink));animation:burstIn .8s cubic-bezier(.2,1.4,.4,1) both}
.w-text{position:relative;font-family:var(--head);font-size:clamp(44px,13vw,96px);letter-spacing:2px;color:#fff;-webkit-text-stroke:3px var(--ink);paint-order:stroke fill;text-shadow:6px 6px 0 var(--ink);transform:rotate(-6deg);animation:burstIn .7s .15s cubic-bezier(.2,1.4,.4,1) both}
@keyframes burstIn{from{opacity:0;transform:scale(0) rotate(-120deg)}to{opacity:1}}

/* ── Posisi navigasi PC ── */
html.nav-right .sidebar{left:auto;right:0;border-right:none;border-left:var(--bw) solid var(--ink)}
html.nav-right .main{margin-left:0;margin-right:236px}
html.nav-right .nav-item{transform-origin:right center}
html.nav-right .nav-item:hover{transform:rotateY(14deg) translate(1px,-1px)}
@media(min-width:769px){.bgfx{display:block}}

/* ── Mode hemat ── */
html.fx-off *{animation:none!important;transition:none!important}
html.fx-off .bgfx,html.fx-off .welcome{display:none!important}
html.fx-off::view-transition-group(*),html.fx-off::view-transition-old(*),html.fx-off::view-transition-new(*){animation:none!important}

@media(max-width:768px){
  .sidebar{display:none}
  .bottomnav{display:block}
  .main,html.nav-right .main{margin:0}
  .content{padding:14px 14px 130px}
  .topbar{padding:10px 14px}.topbar h1{font-size:26px}
  #clk{display:none}
  .form-row{flex-direction:column;gap:0}
  .stats{grid-template-columns:repeat(2,1fr)}
  .hero{flex-direction:column;text-align:center;padding-top:30px}
  .hero h2{font-size:32px}
  .hero .pow{width:80px;right:-6px;top:-22px}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

const TILT_JS = `
document.querySelectorAll('.tilt').forEach(function(el){
  var max=el.dataset.tilt||10;
  function mv(e){var r=el.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;el.style.setProperty('--ry',(x*max*2)+'deg');el.style.setProperty('--rx',(-y*max*2)+'deg')}
  function rs(){el.style.setProperty('--rx','0deg');el.style.setProperty('--ry','0deg')}
  el.addEventListener('pointermove',mv);el.addEventListener('pointerdown',mv);
  el.addEventListener('pointerleave',rs);el.addEventListener('pointerup',rs);el.addEventListener('pointercancel',rs);
});
`

const NAV = [
    ['Overview',  [['dashboard', 'dashboard', 'Dashboard']]],
    ['Functions', [['functions', 'bolt', 'Manage Functions'], ['add-func', 'plus', 'Add Function']]],
    ['Security',  [['apikeys', 'key', 'API Keys'], ['maintenance', 'wrench', 'Maintenance']]],
    ['System',    [['backup', 'save', 'Backup'], ['settings', 'gear', 'Settings']]],
]

// navigasi bawah di HP (maks 5). Maintenance & Backup menyorot "Setelan" dan ada tombolnya di sana.
const BOTTOM = [
    ['dashboard', 'dashboard', 'Dashboard'],
    ['functions', 'bolt', 'Function'],
    ['add-func', 'plus', 'Tambah'],
    ['apikeys', 'key', 'API Key'],
    ['settings', 'gear', 'Setelan'],
]
const BOTTOM_MAP = { maintenance: 'settings', backup: 'settings' }

const htmlClass = ui => [ui.fx === false ? 'fx-off' : '', ui.navSide === 'right' ? 'nav-right' : ''].filter(Boolean).join(' ')

const WELCOME = `<div class="welcome" id="welcome"><svg class="w-burst" viewBox="0 0 100 100" aria-hidden="true"><polygon points="${burstPts(14, 49, 34)}" fill="#ff5148" stroke="#16110f" stroke-width="3" stroke-linejoin="round"/></svg><div class="w-text">HALO, ADMIN!</div></div>`

// posisi gelembung navigasi bawah (geser dari halaman sebelumnya ke halaman sekarang)
const BNAV_JS = `
(function(){
  var n=document.getElementById('bnav');if(!n)return;
  var items=[].slice.call(n.querySelectorAll('.bn-item')),act=-1;
  items.forEach(function(a,i){if(a.classList.contains('active'))act=i});
  function cx(i){var r=n.getBoundingClientRect(),b=items[i].getBoundingClientRect();return b.left-r.left+b.width/2}
  function set(i){n.style.setProperty('--x',cx(i)+'px')}
  if(act<0){n.classList.add('none');set(2);return}
  var prev=-1;try{prev=parseInt(sessionStorage.getItem('bn'))}catch(e){}
  if(!(prev>=0&&prev<items.length))prev=act;
  n.style.transition='none';set(prev);void n.offsetWidth;n.style.transition='';
  requestAnimationFrame(function(){set(act)});
  try{sessionStorage.setItem('bn',act)}catch(e){}
  addEventListener('resize',function(){n.style.transition='none';set(act)});
})();
`

// efek: hitung naik angka statistik, kubus bisa diputar dengan jari/kursor, sambutan setelah login
const FX_JS = `
(function(){
  var off=document.documentElement.classList.contains('fx-off')||(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  document.querySelectorAll('.stat-val[data-n]').forEach(function(el){
    var n=+el.dataset.n;if(off||!n){el.textContent=n;return}
    var t0=performance.now();(function f(t){var p=Math.min(1,(t-t0)/800);el.textContent=Math.round(n*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(f)})(t0);
  });
  document.querySelectorAll('.scene[data-drag]').forEach(function(sc){
    var c=sc.querySelector('.cube'),rx=-24,ry=0,vy=.6,down=false,lx=0,ly=0;
    function ap(){c.style.transform='rotateX('+rx+'deg) rotateY('+ry+'deg)'}
    ap();if(off)return;
    sc.addEventListener('pointerdown',function(e){down=true;lx=e.clientX;ly=e.clientY;try{sc.setPointerCapture(e.pointerId)}catch(_){}});
    sc.addEventListener('pointermove',function(e){if(!down)return;vy=(e.clientX-lx)*.5;ry+=vy;rx=Math.max(-85,Math.min(85,rx-(e.clientY-ly)*.5));lx=e.clientX;ly=e.clientY});
    ['pointerup','pointercancel','lostpointercapture'].forEach(function(ev){sc.addEventListener(ev,function(){down=false})});
    (function loop(){if(!down){vy+=(.6-vy)*.04;ry+=vy;rx+=(-24-rx)*.03}ap();requestAnimationFrame(loop)})();
  });
  var w=document.getElementById('welcome');
  if(w){setTimeout(function(){w.remove()},off?0:1900);try{history.replaceState(null,'',location.pathname)}catch(_){}}
})();
`

// validasi live di editor: module.exports, require, dan tombol perbaikan cepat
const ANALYZE_JS = `
(function(){
  var ta=document.getElementById('source'),box=document.getElementById('analysis');
  if(!ta||!box)return;
  var t=null;
  function run(){
    fetch('/panel/functions/analyze',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:ta.value})})
      .then(function(r){return r.json()}).then(function(d){box.innerHTML=d.html}).catch(function(){});
  }
  ta.addEventListener('input',function(){clearTimeout(t);t=setTimeout(run,450)});
  ta.addEventListener('keydown',function(e){
    if(e.key==='Tab'){e.preventDefault();var s=this.selectionStart;this.value=this.value.slice(0,s)+'  '+this.value.slice(this.selectionEnd);this.selectionStart=this.selectionEnd=s+2}
  });
  box.addEventListener('click',function(e){
    var b=e.target.closest('[data-addexp],[data-addreq]');if(!b)return;
    if(b.dataset.addexp){ta.value=ta.value.replace(/\\s+$/,'')+'\\n\\nmodule.exports = '+b.dataset.addexp+'\\n'}
    else{var m=b.dataset.addreq,line='const '+m+" = require('"+m+"')\\n";ta.value=/^['"]use strict['"]/.test(ta.value)?ta.value.replace(/^(.*\\n)/,function(x){return x+line}):line+ta.value}
    run();ta.focus();
  });
  if(ta.value.trim())run();
})();
`

function page(title, body, activeNav = '', extra = '') {
    const ui   = getUi()
    const nav  = NAV.map(([label, items]) => `
      <div class="nav-label">${label}</div>
      ${items.map(([id, icon, text]) => `<a class="nav-item${activeNav === id ? ' active' : ''}" href="/panel/${id}">${ic(icon, 20)}${text}</a>`).join('')}`).join('')
    const bAct = BOTTOM_MAP[activeNav] || activeNav
    const cur  = BOTTOM.find(b => b[0] === bAct)
    return `<!DOCTYPE html>
<html lang="id" class="${htmlClass(ui)}"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} — WA-API Panel</title>
<link rel="icon" href="${FAVICON}">
${FONTS}
<style>${CSS}</style>
</head><body>
<div class="bgfx" aria-hidden="true">${cube(56)}${cube(40)}${cube(66)}</div>
<div class="wrap">
  <nav class="sidebar" id="sidebar">
    <div class="logo">
      <svg class="logo-mark" viewBox="0 0 100 100" aria-hidden="true"><polygon points="${burstPts()}" fill="#ffd93d" stroke="#16110f" stroke-width="6" stroke-linejoin="round"/><path d="M52 24L34 54h14l-3 22 22-34H53z" fill="#ff5148" stroke="#16110f" stroke-width="4" stroke-linejoin="round"/></svg>
      <div><b>WA-API!</b><small>MAKLOWHH Admin</small></div>
    </div>
    <div class="nav">${nav}</div>
    <div class="side-foot"><div class="pill"><i class="bd"></i>Panel Online</div></div>
  </nav>
  <div class="main">
    <div class="topbar">
      <h1>${esc(title)}</h1>
      <div class="top-right"><span id="clk"></span><a href="/panel/logout" class="btn btn-ghost btn-sm">${ic('logout', 17)}Keluar</a></div>
    </div>
    <div class="content">${body}</div>
  </div>
</div>
<nav class="bottomnav" id="bnav" aria-label="Navigasi utama">
  <div class="bn-shape"><div class="bn-ink"></div><div class="bn-bar"></div></div>
  <div class="bn-bubble">${ic(cur ? cur[1] : 'dashboard', 26)}</div>
  <div class="bn-list">${BOTTOM.map(([id, icon, text]) => `<a class="bn-item${bAct === id ? ' active' : ''}" href="/panel/${id}" aria-label="${text}">${ic(icon, 24)}<span>${text}</span></a>`).join('')}</div>
</nav>
<script>${BNAV_JS}</script>
<div class="modal" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal-box">
    <div class="modal-title" id="modal-title">Yakin?</div>
    <div id="modal-sub"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
      <button class="btn btn-danger btn-sm" id="modal-ok">Ya, lanjut</button>
    </div>
  </div>
</div>
${extra}
<script>
function openModal(t,s,fn){document.getElementById('modal-title').textContent=t;document.getElementById('modal-sub').textContent=s;document.getElementById('modal').classList.add('open');document.getElementById('modal-ok').onclick=function(){closeModal();fn()}}
function closeModal(){document.getElementById('modal').classList.remove('open')}
function copyText(t,btn){navigator.clipboard.writeText(t).then(function(){var o=btn.innerHTML;btn.textContent='Tersalin!';setTimeout(function(){btn.innerHTML=o},1500)})}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal()});
document.querySelectorAll('.content>*').forEach(function(el,i){el.style.setProperty('--i',i)});
(function clk(){var el=document.getElementById('clk');if(el)el.textContent=new Date().toLocaleTimeString('id-ID');setTimeout(clk,1000)})();
${TILT_JS}${FX_JS}
</script>
</body></html>`
}

function loginPage(err = '') {
    return `<!DOCTYPE html>
<html lang="id" class="${htmlClass(getUi())}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — WA-API Panel</title>
<link rel="icon" href="${FAVICON}">
${FONTS}
<style>${CSS}</style></head>
<body><div class="login-wrap"><div class="login-box tilt${err ? ' shake' : ''}" data-tilt="6">
${cube(80, true)}
<h1>WA-API!</h1>
<div class="login-sub">Khusus admin. Orang lain dilarang masuk!</div>
${err ? `<div class="alert alert-danger">${ic('boom', 20)}<span>${esc(err)}</span></div>` : ''}
<form method="POST" action="/panel/login">
  <div class="form-group"><label class="form-label" for="u">Username</label>
  <input class="form-input" id="u" name="username" type="text" autocomplete="username" required></div>
  <div class="form-group"><label class="form-label" for="p">Password</label>
  <input class="form-input" id="p" name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary" style="width:100%;font-size:21px" type="submit">${ic('lock', 20)}Masuk!</button>
</form>
</div></div>
<script>${TILT_JS}${FX_JS}</script></body></html>`
}

const flash = (msg, err, warn) =>
    (msg ? `<div class="alert alert-success">${ic('check', 20)}<span>${esc(msg)}</span></div>` : '') +
    (err ? `<div class="alert alert-danger">${ic('boom', 20)}<span>${esc(err)}</span></div>` : '') +
    (warn ? `<div class="alert alert-warn">${ic('alert', 20)}<span>${esc(warn)}</span></div>` : '')

const cardTitle = (icon, color, text) =>
    `<div class="card-title"><div class="ct-icon c-${color}">${ic(icon, 19)}</div>${text}</div>`

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/panel', auth, (req, res) => res.redirect('/panel/dashboard'))
app.get('/', (req, res) => res.redirect('/panel'))

app.get('/panel/login', (req, res) => {
    if (req.session?.loggedIn) return res.redirect('/panel/dashboard')
    res.send(loginPage())
})

app.post('/panel/login', rateLimit, async (req, res) => {
    const { username, password } = req.body
    const data = loadData()
    const rec  = loginAttempts.get(req.ip) || { count: 0, reset: Date.now() + 300000 }
    const ok   = username === data.username && await bcrypt.compare(password || '', data.password)
    if (!ok) {
        rec.count++
        loginAttempts.set(req.ip, rec)
        return res.send(loginPage('Username atau password salah.'))
    }
    loginAttempts.delete(req.ip)
    req.session.loggedIn = true
    res.redirect('/panel/dashboard?welcome=1')
})

app.get('/panel/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/panel/login'))
})

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/panel/dashboard', auth, async (req, res) => {
    const db   = loadDb()
    const data = loadData()
    const files = fs.existsSync(FUNC_DIR) ? fs.readdirSync(FUNC_DIR).filter(f => f.endsWith('.js')) : []
    const activeKeys = (data.apiKeys || []).filter(k => k.active && (!k.exp || new Date(k.exp) > new Date()))

    let apiStatus = 'Belum diketahui', cls = 'alert-warn', icon = 'alert'
    try {
        const axios = require('axios')
        const r = await axios.get('http://localhost:2578/api/status', { timeout: 3000, headers: { 'x-api-key': (activeKeys[0] && activeKeys[0].key) || '' } })
        if (r.data?.success) { apiStatus = `Online — uptime ${r.data.uptime_sec}s, mem ${r.data.memory_mb}MB`; cls = 'alert-success'; icon = 'check' }
    } catch (e) { apiStatus = e.response ? `wa-api membalas HTTP ${e.response.status}. Cek API key aktif dan rute /api/status` : 'Offline atau tidak bisa dihubungi'; cls = 'alert-danger'; icon = 'boom' }

    const stat = (v, l, c, i) => `<div class="stat tilt c-${c}">${ic(i, 28)}<div class="stat-val" data-n="${v}">${v}</div><div class="stat-label">${l}</div></div>`
    const body = `
<div class="card hero">
  ${pow('POW!')}
  ${cube(92, true)}
  <div><h2>Markas WA-API</h2><p>${db.length} function terdaftar, ${activeKeys.length} API key aktif. Semua siap dikendalikan dari sini.</p></div>
</div>
<div class="stats">
  ${stat(db.length, 'Functions', 'pink', 'bolt')}
  ${stat(activeKeys.length, 'API Keys Aktif', 'blue', 'key')}
  ${stat(files.length, 'File di /function', 'green', 'folder')}
  ${stat(data.backups?.length || 0, 'Backup', 'yellow', 'save')}
</div>
<div class="card">
  ${cardTitle('signal', 'green', 'Status wa-api')}
  <div class="alert ${cls}" style="margin-bottom:0">${ic(icon, 20)}<span>${esc(apiStatus)}</span></div>
</div>
<div class="card">
  ${cardTitle('bolt', 'pink', 'Functions Terdaftar')}
  ${db.length ? `<div class="chips">${db.map(f => `<span class="badge ${f.active !== false ? 'b-blue' : 'b-off'}">${esc(f.type)}</span>`).join('')}</div>` : '<div class="empty">Belum ada function</div>'}
</div>
<div class="card">
  ${cardTitle('folder', 'yellow', 'File di /function')}
  ${files.length ? `<div class="chips">${files.map(f => `<span class="badge b-green"><code>${esc(f)}</code></span>`).join('')}</div>` : '<div class="empty">Folder kosong</div>'}
</div>`
    const shortcuts = `<div class="card">${cardTitle('sparkle', 'orange', 'Pintasan')}<div class="btn-group"><a class="btn btn-blue" href="/panel/maintenance">${ic('wrench', 19)}Maintenance</a><a class="btn btn-mint" href="/panel/backup">${ic('save', 19)}Backup</a></div></div>`
    res.send(page('Dashboard', body + shortcuts, 'dashboard', req.query.welcome ? WELCOME : ''))
})

// ── Functions: list ───────────────────────────────────────────────────────────
app.get('/panel/functions', auth, (req, res) => {
    const db = loadDb()
    const rows = db.map((f, i) => `
      <tr>
        <td><span class="badge b-blue">${esc(f.type)}</span></td>
        <td><code style="color:#0a7a3d">${esc(f.file)}</code></td>
        <td style="color:var(--muted)">${esc(f.description) || '—'}</td>
        <td>${f.active !== false ? '<span class="badge b-green"><i class="bd"></i>Aktif</span>' : '<span class="badge b-off"><i class="bd"></i>Nonaktif</span>'}</td>
        <td>
          <div class="btn-group" style="padding-bottom:4px">
            <a class="btn btn-blue btn-sm" href="/panel/functions/edit/${i}">${ic('edit', 16)}Edit</a>
            <form method="POST" action="/panel/functions/toggle" style="display:inline">
              <input type="hidden" name="index" value="${i}">
              <button class="btn btn-ghost btn-sm" type="submit" title="Aktif/nonaktifkan" aria-label="Aktif/nonaktifkan">${ic(f.active !== false ? 'pause' : 'play', 16)}</button>
            </form>
            <button class="btn btn-danger btn-sm" type="button" data-del="${i}" data-type="${esc(f.type)}" aria-label="Hapus">${ic('trash', 16)}</button>
          </div>
        </td>
      </tr>`).join('')

    const body = `
${flash(req.query.msg, req.query.err)}
<div class="card">
  ${cardTitle('bolt', 'pink', 'Registered Functions')}
  ${db.length === 0 ? '<div class="empty">Kosong melompong! Tambah function dulu.</div>' : `
  <div class="table-wrap"><table>
    <thead><tr><th>Type</th><th>File</th><th>Deskripsi</th><th>Status</th><th>Aksi</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`}
  <div style="margin-top:18px"><a href="/panel/add-func" class="btn btn-primary">${ic('plus', 19)}Tambah Function</a></div>
</div>
<form id="del-form" method="POST" action="/panel/functions/delete" style="display:none"><input type="hidden" name="index" id="del-idx"></form>
<script>
document.querySelectorAll('[data-del]').forEach(function(b){
  b.addEventListener('click',function(){
    openModal('Hapus function?','Hapus "'+b.dataset.type+'" dari daftar. File .js di server TIDAK ikut dihapus.',function(){
      document.getElementById('del-idx').value=b.dataset.del;document.getElementById('del-form').submit()
    })
  })
})
</script>`
    res.send(page('Manage Functions', body, 'functions'))
})

app.post('/panel/functions/analyze', auth, (req, res) => {
    res.json({ html: renderAnalysis(analyzeSource(req.body && req.body.source)) })
})

// ── Functions: edit ───────────────────────────────────────────────────────────
app.get('/panel/functions/edit/:idx', auth, (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.params.idx)
    const f   = db[idx]
    if (!f) return res.redirect('/panel/functions?err=' + encodeURIComponent('Function tidak ditemukan'))

    const found = resolveFuncFile(f)
    let source = '', readErr = ''
    if (found.file) {
        try { source = fs.readFileSync(found.file, 'utf8') } catch (e) { readErr = e.message }
    }

    let notice = ''
    if (!found.file) {
        notice = `<div class="alert alert-warn">${ic('alert', 20)}<div>File source tidak ketemu di server. Lokasi yang dicoba:<div class="hint">${found.tried.map(esc).join('<br>')}</div><div class="hint">Menyimpan dari halaman ini akan membuat file baru di folder function.</div></div></div>`
    } else if (readErr) {
        notice = `<div class="alert alert-danger">${ic('boom', 20)}<span>Gagal membaca file: ${esc(readErr)}</span></div>`
    } else if (!source.length) {
        notice = `<div class="alert alert-warn">${ic('alert', 20)}<span>File ditemukan tapi isinya kosong (0 byte).</span></div>`
    }

    const body = `
${flash(req.query.msg, req.query.err)}
${notice}
<div class="card">
  ${cardTitle('edit', 'blue', `Edit: ${esc(f.type)}`)}
  <form method="POST" action="/panel/functions/edit/${idx}">
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="type">Type Name</label>
        <input class="form-input" id="type" name="type" value="${esc(f.type)}" required>
      </div>
      <div class="form-group">
        <label class="form-label" for="file">File</label>
        <input class="form-input" id="file" name="file" value="${esc(f.file)}" required>
        <div class="hint">Ganti nama untuk rename file (file lama dihapus).</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="description">Deskripsi</label>
      <input class="form-input" id="description" name="description" value="${esc(f.description)}">
    </div>
    <div id="analysis">${renderAnalysis(analyzeSource(source))}</div>
    <div class="form-group">
      <label class="form-label" for="source">Source Code JS</label>
      <textarea class="form-textarea" id="source" name="source" spellcheck="false" style="min-height:380px" required>
${esc(source)}</textarea>
      ${found.file ? `<div class="hint">Dibaca dari ${esc(found.file)} (${Buffer.byteLength(source)} byte)</div>` : ''}
    </div>
    <div class="toggle-row" style="border:none;padding-top:0">
      <div class="toggle-info"><h4>Function aktif</h4><p>Matikan untuk menonaktifkan tanpa menghapus</p></div>
      <label class="toggle"><input type="checkbox" name="active" ${f.active !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="btn-group">
      <button class="btn btn-mint" type="submit">${ic('save', 19)}Simpan Perubahan</button>
      <a class="btn btn-ghost" href="/panel/functions">Batal</a>
    </div>
  </form>
</div>
<script>${ANALYZE_JS}</script>`
    res.send(page('Edit Function', body, 'functions'))
})

app.post('/panel/functions/edit/:idx', auth, (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.params.idx)
    const f   = db[idx]
    if (!f) return res.redirect('/panel/functions?err=' + encodeURIComponent('Function tidak ditemukan'))

    const { type, file, description, source } = req.body
    const back = m => `/panel/functions/edit/${idx}?err=${encodeURIComponent(m)}`
    if (!type || !file || !source) return res.redirect(back('Type, file, dan source wajib diisi'))
    if (db.some((x, i) => i !== idx && x.type === type)) return res.redirect(back('Type sudah dipakai function lain'))

    const newFile = jsFile(file)
    const cur     = resolveFuncFile(f).file
    const oldBase = cur ? path.basename(cur) : jsFile(f.file)
    const renamed = newFile !== oldBase
    if (renamed && db.some((x, i) => i !== idx && jsFile(x.file) === newFile)) return res.redirect(back('Nama file sudah dipakai function lain'))

    try {
        const target = (!renamed && cur) ? cur : path.join(FUNC_DIR, newFile)
        if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, source)
        if (renamed && cur) { try { fs.unlinkSync(cur) } catch {} }
    } catch (e) { return res.redirect(back('Gagal menulis file: ' + e.message)) }

    db[idx] = { ...f, type, file: renamed ? newFile : f.file, description: description || '', active: !!req.body.active }
    saveDb(db)
    res.redirect(`/panel/functions/edit/${idx}?msg=${encodeURIComponent('Function "' + type + '" berhasil diperbarui')}`)
})

app.post('/panel/functions/toggle', auth, (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.body.index)
    if (db[idx]) db[idx].active = !(db[idx].active !== false)
    saveDb(db)
    res.redirect('/panel/functions')
})

app.post('/panel/functions/delete', auth, (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.body.index)
    if (idx >= 0 && idx < db.length) db.splice(idx, 1)
    saveDb(db)
    res.redirect('/panel/functions?msg=' + encodeURIComponent('Function dihapus dari daftar'))
})

// ── Add Function ──────────────────────────────────────────────────────────────
app.get('/panel/add-func', auth, (req, res) => {
    const body = `
${flash(req.query.msg, req.query.err, req.query.warn)}
<div class="card">
  ${cardTitle('code', 'green', 'Paste Source Code')}
  <form method="POST" action="/panel/add-func/paste">
    <div class="form-row">
      <div class="form-group"><label class="form-label">Type Name</label><input class="form-input" name="type" placeholder="contoh: richtext" required></div>
      <div class="form-group"><label class="form-label">File Name (.js)</label><input class="form-input" name="file" placeholder="contoh: slof.js" required></div>
    </div>
    <div class="form-group"><label class="form-label">Deskripsi</label><input class="form-input" name="description" placeholder="Deskripsi singkat"></div>
    <div id="analysis"></div>
    <div class="form-group"><label class="form-label">Source Code JS</label>
      <textarea class="form-textarea" id="source" name="source" spellcheck="false" style="min-height:220px" placeholder="async function nama(sock, jid) {&#10;  // kode kamu&#10;}&#10;module.exports = nama;" required></textarea></div>
    <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan</button>
  </form>
</div>
<div class="card">
  ${cardTitle('upload', 'yellow', 'Upload File .js')}
  <form method="POST" action="/panel/add-func/upload" enctype="multipart/form-data">
    <div class="form-row">
      <div class="form-group"><label class="form-label">Type Name</label><input class="form-input" name="type" placeholder="myfunc" required></div>
      <div class="form-group"><label class="form-label">Deskripsi</label><input class="form-input" name="description" placeholder="Deskripsi"></div>
    </div>
    <div class="form-group"><label class="form-label">File .js (maks 512KB)</label><input class="form-input" name="jsfile" type="file" accept=".js" required></div>
    <button class="btn btn-mint" type="submit">${ic('box', 19)}Upload & Daftarkan</button>
  </form>
</div>
<div class="card">
  ${cardTitle('globe', 'blue', 'Ambil dari URL')}
  <form method="POST" action="/panel/add-func/url">
    <div class="form-row">
      <div class="form-group"><label class="form-label">Type Name</label><input class="form-input" name="type" placeholder="myfunc" required></div>
      <div class="form-group"><label class="form-label">File Name (.js)</label><input class="form-input" name="file" placeholder="myfunc.js" required></div>
    </div>
    <div class="form-group"><label class="form-label">URL Raw File .js</label><input class="form-input" name="url" type="url" placeholder="https://raw.githubusercontent.com/..." required></div>
    <div class="form-group"><label class="form-label">Deskripsi</label><input class="form-input" name="description" placeholder="Deskripsi"></div>
    <button class="btn btn-blue" type="submit">${ic('download', 19)}Ambil & Simpan</button>
  </form>
</div>
<script>${ANALYZE_JS}</script>`
    res.send(page('Add Function', body, 'add-func'))
})

const addErr = m => '/panel/add-func?err=' + encodeURIComponent(m)
const addOk  = (m, w) => '/panel/add-func?msg=' + encodeURIComponent(m) + (w ? '&warn=' + encodeURIComponent(w) : '')

app.post('/panel/add-func/paste', auth, (req, res) => {
    const { type, file, description, source } = req.body
    if (!type || !file || !source) return res.redirect(addErr('Isi semua field yang wajib'))
    const db = loadDb()
    if (db.find(f => f.type === type)) return res.redirect(addErr('Type sudah ada'))
    if (!fs.existsSync(FUNC_DIR)) fs.mkdirSync(FUNC_DIR, { recursive: true })
    const safeName = jsFile(file)
    fs.writeFileSync(path.join(FUNC_DIR, safeName), source)
    db.push({ type, file: safeName, description: description || '', active: true })
    saveDb(db)
    res.redirect(addOk(`Function "${type}" berhasil ditambah`, srcWarn(source)))
})

app.post('/panel/add-func/upload', (req, res, next) => {
    auth(req, res, () => upload.single('jsfile')(req, res, err => err ? res.redirect(addErr(err.message)) : next()))
}, (req, res) => {
    if (!req.file) return res.redirect(addErr('Tidak ada file yang diupload'))
    const { type, description } = req.body
    if (!type) return res.redirect(addErr('Type tidak boleh kosong'))
    const safeName = path.basename(req.file.originalname)
    const db = loadDb()
    if (db.find(f => f.type === type)) return res.redirect(addErr('Type sudah ada'))
    if (!fs.existsSync(FUNC_DIR)) fs.mkdirSync(FUNC_DIR, { recursive: true })
    fs.writeFileSync(path.join(FUNC_DIR, safeName), req.file.buffer)
    db.push({ type, file: safeName, description: description || '', active: true })
    saveDb(db)
    res.redirect(addOk(`File "${safeName}" didaftarkan sebagai type "${type}"`, srcWarn(req.file.buffer.toString('utf8'))))
})

app.post('/panel/add-func/url', auth, async (req, res) => {
    const { type, file, url, description } = req.body
    if (!type || !file || !url) return res.redirect(addErr('Isi semua field'))
    try {
        const axios = require('axios')
        const r = await axios.get(url, { responseType: 'text', timeout: 15000 })
        const safeName = jsFile(file)
        const db = loadDb()
        if (db.find(f => f.type === type)) return res.redirect(addErr('Type sudah ada'))
        if (!fs.existsSync(FUNC_DIR)) fs.mkdirSync(FUNC_DIR, { recursive: true })
        fs.writeFileSync(path.join(FUNC_DIR, safeName), r.data)
        db.push({ type, file: safeName, description: description || '', active: true })
        saveDb(db)
        res.redirect(addOk(`Function "${type}" berhasil diambil dari URL`, srcWarn(String(r.data))))
    } catch (e) {
        res.redirect(addErr('Gagal fetch: ' + e.message))
    }
})

// ── API Keys ──────────────────────────────────────────────────────────────────
app.get('/panel/apikeys', auth, (req, res) => {
    const keys = loadData().apiKeys || []
    const keyRows = keys.map((k, i) => {
        const expired = k.exp && new Date(k.exp) < new Date()
        return `
        <div class="key-box tilt" data-tilt="3">
          <span class="badge ${expired ? 'b-red' : k.active ? 'b-green' : 'b-off'}">${expired ? 'Expired' : k.active ? 'Aktif' : 'Nonaktif'}</span>
          <div style="flex:1;min-width:200px">
            <div style="font-weight:900">${esc(k.label)}</div>
            <div class="key-val">${esc(k.key)}</div>
            ${k.exp ? `<div class="hint">Exp: ${esc(new Date(k.exp).toLocaleDateString('id-ID'))}</div>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(k.key)}">${ic('copy', 16)}Copy</button>
          <form method="POST" action="/panel/apikeys/delete" style="display:inline">
            <input type="hidden" name="index" value="${i}">
            <button class="btn btn-danger btn-sm" type="submit" aria-label="Hapus key">${ic('trash', 16)}</button>
          </form>
        </div>`
    }).join('')

    const body = `
${flash(req.query.msg)}
<div class="card">
  ${cardTitle('sparkle', 'yellow', 'Bikin API Key Baru')}
  <form method="POST" action="/panel/apikeys/generate">
    <div class="form-row">
      <div class="form-group"><label class="form-label">Label</label><input class="form-input" name="label" placeholder="dhann-bot-prod" required></div>
      <div class="form-group"><label class="form-label">Kedaluwarsa (hari)</label><input class="form-input" name="exp" type="number" min="1" placeholder="Kosong = tanpa batas"></div>
    </div>
    <button class="btn btn-primary" type="submit">${ic('key', 19)}Generate Key</button>
  </form>
</div>
<div class="card">
  ${cardTitle('clip', 'pink', `Daftar API Key (${keys.length})`)}
  ${keys.length ? keyRows : '<div class="empty">Belum ada API key</div>'}
</div>
<script>document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){copyText(b.dataset.copy,b)})})</script>`
    res.send(page('API Keys', body, 'apikeys'))
})

app.post('/panel/apikeys/generate', auth, (req, res) => {
    const { label, exp } = req.body
    const key     = 'mk_' + crypto.randomBytes(20).toString('hex')
    const expDate = exp ? new Date(Date.now() + parseInt(exp) * 86400000).toISOString() : null
    const data    = loadData()
    data.apiKeys  = data.apiKeys || []
    data.apiKeys.push({ label: label || 'key-' + Date.now(), key, exp: expDate, active: true, created: new Date().toISOString() })
    saveData(data)
    updateWaApiKey(data.apiKeys)
    res.redirect('/panel/apikeys?msg=' + encodeURIComponent('API Key berhasil dibuat'))
})

app.post('/panel/apikeys/delete', auth, (req, res) => {
    const data = loadData()
    const idx  = parseInt(req.body.index)
    if (idx >= 0 && idx < data.apiKeys.length) data.apiKeys.splice(idx, 1)
    saveData(data)
    updateWaApiKey(data.apiKeys)
    res.redirect('/panel/apikeys?msg=' + encodeURIComponent('API Key dihapus'))
})

function updateWaApiKey(keys) {
    try {
        const cfgPath = path.join(WA_API_DIR, 'config.js')
        if (!fs.existsSync(cfgPath)) return
        const activeKey = keys.find(k => k.active && (!k.exp || new Date(k.exp) > new Date()))
        let cfg = fs.readFileSync(cfgPath, 'utf8')
        const newKey = activeKey ? activeKey.key : ''
        cfg = cfg.replace(/API_KEY:\s*process\.env\.API_KEY\s*\|\|\s*"[^"]*"/, `API_KEY: process.env.API_KEY || "${newKey}"`)
        fs.writeFileSync(cfgPath, cfg)
    } catch (e) { console.error('updateWaApiKey error:', e.message) }
}

// ── Maintenance ───────────────────────────────────────────────────────────────
app.get('/panel/maintenance', auth, (req, res) => {
    const maint = loadData().maint || { api: false, web: false, msg: '' }
    const db    = loadDb()

    const funcToggles = db.map((f, i) => `
      <div class="toggle-row">
        <div class="toggle-info">
          <h4><span class="badge b-blue" style="margin-right:6px">${esc(f.type)}</span>${esc(f.file)}</h4>
          <p>${esc(f.description) || '—'}</p>
        </div>
        <form method="POST" action="/panel/maintenance/func">
          <input type="hidden" name="index" value="${i}">
          <label class="toggle"><input type="checkbox" ${f.active !== false ? 'checked' : ''} onchange="this.form.submit()" aria-label="Aktif ${esc(f.type)}"><span class="toggle-slider"></span></label>
        </form>
      </div>`).join('')

    const body = `
${flash(req.query.msg)}
<div class="card">
  ${cardTitle('wrench', 'yellow', 'Mode Maintenance Global')}
  <form method="POST" action="/panel/maintenance/save">
    <div class="toggle-row">
      <div class="toggle-info"><h4>Maintenance API (/api/source)</h4><p>Semua request ke /api/source dibalas 503</p></div>
      <label class="toggle"><input type="checkbox" name="api" ${maint.api ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Maintenance Web</h4><p>Tampilkan banner maintenance di halaman publik</p></div>
      <label class="toggle"><input type="checkbox" name="web" ${maint.web ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="divider"></div>
    <div class="form-group"><label class="form-label">Pesan Maintenance</label>
      <input class="form-input" name="msg" value="${esc(maint.msg)}" placeholder="Server sedang dalam pemeliharaan..."></div>
    <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan</button>
  </form>
</div>
<div class="card">
  ${cardTitle('bolt', 'pink', 'Maintenance per Function')}
  ${db.length ? funcToggles : '<div class="empty">Belum ada function</div>'}
</div>`
    res.send(page('Maintenance', body, 'maintenance'))
})

app.post('/panel/maintenance/save', auth, (req, res) => {
    const data = loadData()
    data.maint = { api: !!req.body.api, web: !!req.body.web, msg: req.body.msg || '' }
    saveData(data)
    try { fs.writeFileSync(path.join(WA_API_DIR, '.maintenance.json'), JSON.stringify(data.maint)) } catch (e) { console.error(e.message) }
    res.redirect('/panel/maintenance?msg=' + encodeURIComponent('Mode maintenance disimpan'))
})

app.post('/panel/maintenance/func', auth, (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.body.index)
    if (db[idx]) db[idx].active = !(db[idx].active !== false)
    saveDb(db)
    res.redirect('/panel/maintenance')
})

// ── Backup ────────────────────────────────────────────────────────────────────
app.get('/panel/backup', auth, (req, res) => {
    const list = loadData().backups || []
    const rows = list.map((b, i) => `
      <tr>
        <td><code>${esc(b.ts)}</code></td>
        <td>${b.funcCount} functions</td>
        <td>${b.keyCount} keys</td>
        <td><a href="/panel/backup/download/${i}" class="btn btn-blue btn-sm">${ic('download', 16)}Unduh</a></td>
      </tr>`).join('')

    const body = `
${flash(req.query.msg)}
<div class="card">
  ${cardTitle('save', 'green', 'Backup Sekarang')}
  <p style="margin-bottom:14px">Isinya: database.json, daftar API key (disamarkan), dan pengaturan maintenance. Maksimal 10 backup terakhir disimpan.</p>
  <form method="POST" action="/panel/backup/create"><button class="btn btn-mint" type="submit">${ic('box', 19)}Buat Backup</button></form>
</div>
<div class="card">
  ${cardTitle('clip', 'blue', `Riwayat Backup (${list.length})`)}
  ${list.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Waktu</th><th>Functions</th><th>Keys</th><th>Aksi</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : '<div class="empty">Belum ada backup</div>'}
</div>`
    res.send(page('Backup', body, 'backup'))
})

app.post('/panel/backup/create', auth, (req, res) => {
    const db   = loadDb()
    const data = loadData()
    const backup = {
        ts: new Date().toISOString(),
        funcCount: db.length,
        keyCount: (data.apiKeys || []).length,
        database: db,
        apiKeys: (data.apiKeys || []).map(k => ({ ...k, key: k.key.slice(0, 8) + '...' })),
        maint: data.maint,
    }
    data.backups = data.backups || []
    data.backups.unshift(backup)
    if (data.backups.length > 10) data.backups = data.backups.slice(0, 10)
    saveData(data)
    res.redirect('/panel/backup?msg=' + encodeURIComponent('Backup berhasil dibuat'))
})

app.get('/panel/backup/download/:idx', auth, (req, res) => {
    const backup = (loadData().backups || [])[parseInt(req.params.idx)]
    if (!backup) return res.status(404).send('Backup tidak ditemukan')
    res.setHeader('Content-Disposition', `attachment; filename="wa-api-backup-${backup.ts.replace(/[:.]/g, '-')}.json"`)
    res.json(backup)
})

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/panel/settings', auth, (req, res) => {
    const ui = getUi()
    const body = `
${flash(req.query.msg, req.query.err)}
<div class="card">
  ${cardTitle('sparkle', 'pink', 'Tampilan')}
  <form method="POST" action="/panel/settings/ui">
    <div class="form-group">
      <label class="form-label" for="navSide">Posisi navigasi di PC</label>
      <select class="form-select" id="navSide" name="navSide">
        <option value="left" ${ui.navSide !== 'right' ? 'selected' : ''}>Kiri</option>
        <option value="right" ${ui.navSide === 'right' ? 'selected' : ''}>Kanan</option>
      </select>
      <div class="hint">Di HP, navigasi selalu berada di bawah.</div>
    </div>
    <div class="toggle-row" style="border:none;padding-top:0">
      <div class="toggle-info"><h4>Efek 3D & animasi</h4><p>Matikan kalau perangkat terasa berat</p></div>
      <label class="toggle"><input type="checkbox" name="fx" ${ui.fx !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan Tampilan</button>
  </form>
</div>
<div class="card">
  ${cardTitle('wrench', 'yellow', 'Menu Lain')}
  <div class="btn-group">
    <a class="btn btn-blue" href="/panel/maintenance">${ic('wrench', 19)}Maintenance</a>
    <a class="btn btn-mint" href="/panel/backup">${ic('save', 19)}Backup</a>
  </div>
</div>
<div class="card">
  ${cardTitle('gear', 'blue', 'Ubah Kredensial Admin')}
  <div class="alert alert-warn">${ic('alert', 20)}<span>Ingat username/password barumu sebelum menyimpan. Kamu akan otomatis keluar.</span></div>
  <form method="POST" action="/panel/settings/save">
    <div class="form-group"><label class="form-label">Username Baru</label><input class="form-input" name="username" placeholder="Kosongkan jika tidak diganti" autocomplete="off"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Password Baru</label><input class="form-input" name="password" type="password" placeholder="Kosongkan jika tidak diganti" autocomplete="new-password"></div>
      <div class="form-group"><label class="form-label">Konfirmasi Password</label><input class="form-input" name="password2" type="password" placeholder="Ulangi password baru" autocomplete="new-password"></div>
    </div>
    <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan</button>
  </form>
</div>
<div class="card">
  ${cardTitle('signal', 'yellow', 'Info Server')}
  <div class="code">wa-api dir    : ${esc(WA_API_DIR)}
database.json: ${esc(DB_PATH)}
function dir  : ${esc(FUNC_DIR)}
panel port    : ${PORT}
node version  : ${esc(process.version)}
uptime        : ${Math.floor(process.uptime())}s</div>
</div>
<div class="card" style="border-color:var(--red)">
  ${cardTitle('burst', 'red', 'Danger Zone')}
  <div class="alert alert-danger">${ic('alert', 20)}<span>Tindakan ini tidak bisa dibatalkan!</span></div>
  <form id="clear-form" method="POST" action="/panel/settings/clear-keys">
    <button class="btn btn-danger" type="button" onclick="openModal('Hapus SEMUA API key?','Semua key akan hilang permanen.',function(){document.getElementById('clear-form').submit()})">${ic('trash', 19)}Hapus Semua API Keys</button>
  </form>
</div>`
    res.send(page('Settings', body, 'settings'))
})

app.post('/panel/settings/save', auth, async (req, res) => {
    const { username, password, password2 } = req.body
    const data = loadData()
    if (password && password !== password2) return res.redirect('/panel/settings?err=' + encodeURIComponent('Password tidak sama'))
    if (username) data.username = username
    if (password) data.password = await bcrypt.hash(password, 12)
    saveData(data)
    req.session.destroy(() => res.redirect('/panel/login'))
})

app.post('/panel/settings/ui', auth, (req, res) => {
    const data = loadData()
    data.ui = { navSide: req.body.navSide === 'right' ? 'right' : 'left', fx: !!req.body.fx }
    saveData(data)
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Tampilan disimpan'))
})

app.post('/panel/settings/clear-keys', auth, (req, res) => {
    const data = loadData()
    data.apiKeys = []
    saveData(data)
    updateWaApiKey([])
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Semua API key dihapus'))
})

// ── Start ─────────────────────────────────────────────────────────────────────
initData().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[PANEL] Jalan di port ${PORT}`)
        console.log(`[PANEL] WA-API dir: ${WA_API_DIR}`)
    })
})
