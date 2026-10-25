/**
 * panel.js — Admin Panel untuk wa-api (Comic 3D Edition)
 * Jalan di port 2579, akses via /panel
 * Auth: session-based + bcrypt
 * By Dhann Anjay Bjir
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
    if (!data.username) data.username = process.env.PANEL_USER || 'admindhann'
    if (!data.password) data.password = await bcrypt.hash(process.env.PANEL_PASS || 'dhann123123*', 12)
    if (!data.apiKeys)  data.apiKeys  = []
    if (!data.maint)    data.maint    = { api: false, web: false, msg: '' }
    if (!data.backups)  data.backups  = []
    if (!data.ui)       data.ui       = { navSide: 'left', fx: true }
    if (!data.users) {
        // migrasi dari akun tunggal lama -> user pertama jadi Owner
        data.users = [{ username: data.username, password: data.password, role: 'owner', ui: { ...UI_DEFAULT, ...(data.ui || {}) }, created: new Date().toISOString() }]
    }
    data.users.forEach(u => { if (u.role === 'viewer') u.role = 'visitor' })
    if (!data.anim || !data.anim.v || data.anim.v < 3) data.anim = { style: 'koran', v: 3 }
    if (!data.shield) data.shield = { on: true }
    if (!data.reg)    data.reg    = { open: true }
    if (!data.visitor) data.visitor = { functions: true, status: true }
    saveData(data)
    return data
}

function loadDb() { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) } catch { return [] } }
function saveDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)) }

const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d }
const UI_DEFAULT = { navSide: 'left', fx: true, intro: true, stagger: 90, speed: 1, theme: 'auto', sfx: true }
const THEMES = ['auto', 'light', 'dark']

// gaya transisi halaman (global, hanya Owner yang bisa mengganti)
const ANIM_STYLES = {
    koran:   ['Koran Gunting',      'Koran terbit dengan berita UI baru, digunting pakai gunting, lalu di-zoom jadi UI barunya. Berlaku juga untuk login dan register.', ['Koran', 'Gunting', 'Zoom']],
    gunshot: ['Tembak Pistol',     'Pistol vektor meluncur dari samping, membidik tombol yang kamu tekan, lalu DOR! Seluruh UI langsung pecah dan diganti UI baru.', ['Pistol', 'Tembakan', 'Kilat', 'Selongsong']],
    burst:   ['Ledakan Berpencar', 'Semua elemen meledak ke segala arah dari titik klik, lalu halaman baru menyusun diri sambil memantul.', ['3D', 'Bintang', 'Boom']],
    slam:    ['Jatuh Berantakan',  'Elemen bergetar lalu rontok satu per satu sambil berputar. Yang baru terjun dari atas dan memantul.', ['Gravitasi', 'Pantul', 'Getar']],
    flip:    ['Balik 3D',          'Tiap elemen terbalik 3D seperti kartu, bergelombang dari atas ke bawah.', ['3D', 'Gelombang']],
    curtain: ['Tirai Miring',      'Elemen tersapu diagonal ke kanan bawah seperti tirai, yang baru masuk dari kiri atas.', ['Diagonal', 'Sapu']],
    zoom:    ['Zoom Kamera',       'Elemen melesat ke arah kamera lalu hilang. Yang baru datang dari kejauhan.', ['Kamera', 'Zoom']],
    swipe:   ['Geser Zigzag',      'Elemen meluncur kiri dan kanan bergantian dengan miring, yang baru masuk dari sisi sebaliknya.', ['Zigzag', 'Miring']],
    pop:     ['Pop Balon',         'Tiap elemen menggembung lalu pecah bersuara pop. Yang baru membal keluar.', ['Balon', 'Pop']],
    none:    ['Tanpa Transisi',    'Pindah halaman langsung tanpa animasi keluar-masuk.', ['Instan']],
}
const getAnim = () => { const a = (loadData().anim || {}).style; return ANIM_STYLES[a] ? a : 'koran' }

// ── Opsional: obfuscate JS sisi-browser (npm i javascript-obfuscator) ─────────
// Kalau modulnya tidak ada, panel tetap jalan normal (JS dikirim apa adanya).
// Matikan manual dengan env OBFUSCATE=0
let JSO = null
if (process.env.OBFUSCATE !== '0') { try { JSO = require('javascript-obfuscator') } catch {} }
const OB = (() => {
    const cache = new Map()
    return src => {
        if (!JSO) return src
        if (cache.has(src)) return cache.get(src)
        let out = src
        try {
            out = JSO.obfuscate(src, {
                compact: true, simplify: true, stringArray: true, stringArrayThreshold: 0.8,
                stringArrayEncoding: ['base64'], rotateStringArray: true, shuffleStringArray: true,
                identifierNamesGenerator: 'hexadecimal', renameGlobals: false,
                controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false,
                debugProtection: false, target: 'browser'
            }).getObfuscatedCode()
        } catch (e) { console.error('[PANEL] obfuscate gagal, pakai kode asli:', e.message) }
        cache.set(src, out)
        return out
    }
})()

// ── Kontak (tombol Contact Us) ────────────────────────────────────────────────
const CONTACT = {
    waNumber:  '6282126803897',
    waShown:   '+62 821-2680-3897',
    waChannel: 'https://whatsapp.com/channel/0029VbCuWBx1iUxReAboHY1f',
    tgLink:    'https://t.me/rp1st',
    tgShown:   't.me/rp1st',
}

// ── Pengaturan keamanan (diatur Owner di Setelan) ─────────────────────────────
const shieldOn = () => (loadData().shield || {}).on !== false
const regOpen  = d => ((d || loadData()).reg || {}).open !== false
const SCRAPER_UA = /curl|wget|httrack|python-requests|python-urllib|aiohttp|httpx|go-http-client|libwww|scrapy|node-fetch|axios|okhttp|postman|insomnia|httpie|webcopier|offline explorer|sitesucker|webzip|teleport|phantomjs/i
const shieldTag = () => {
    const u = curUser()
    return shieldOn() && !(u && u.role === 'owner') ? `<script>${OB(SHIELD_JS)}</script>` : ''
}

// ── Captcha gambar tanpa layanan luar ─────────────────────────────────────────
// Stateless: token = nonce.exp.signature (HMAC). Jawaban diturunkan dari HMAC juga,
// jadi tidak perlu simpan apa pun di session. Setiap token cuma bisa dipakai sekali.
const CAP_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const capHm  = (k, s) => crypto.createHmac('sha256', SESSION_SECRET).update(k + ':' + s).digest()
const capB64 = b => Buffer.from(b).toString('base64url')
const capUsed = new Map()
setInterval(() => { const n = Date.now(); for (const [k, e] of capUsed) if (e < n) capUsed.delete(k) }, 60000).unref()

function capNew() {
    const p = crypto.randomBytes(9).toString('base64url') + '.' + (Date.now() + 5 * 60 * 1000)
    return p + '.' + capB64(capHm('sig', p)).slice(0, 22)
}
function capParse(tok) {
    const m = /^([A-Za-z0-9_-]{12})\.(\d{13})\.([A-Za-z0-9_-]{22})$/.exec(String(tok || ''))
    if (!m) return null
    const p = m[1] + '.' + m[2]
    const a = Buffer.from(m[3]), b = Buffer.from(capB64(capHm('sig', p)).slice(0, 22))
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    if (+m[2] < Date.now()) return null
    return { p, nonce: m[1], exp: +m[2] }
}
function capAnswer(p) {
    const h = capHm('ans', p)
    let s = ''
    for (let i = 0; i < 5; i++) s += CAP_CHARS[h[i] % CAP_CHARS.length]
    return s
}
function capCheck(tok, input) {
    const t = capParse(tok)
    if (!t || capUsed.has(t.nonce)) return false
    capUsed.set(t.nonce, t.exp)                         // hangus, benar atau salah
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === capAnswer(t.p)
}
function capSvg(ans) {
    const W = 190, H = 62, rnd = (a, b) => a + Math.random() * (b - a)
    const pal = ['#16110f', '#d63a31', '#1f5fd1', '#0d8a4b', '#a63fa0']
    let g = ''
    for (let i = 0; i < 40; i++) g += `<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" r="${rnd(.8, 2.2).toFixed(1)}" fill="${pal[i % 5]}" opacity=".35"/>`
    for (let i = 0; i < 4; i++) g += `<path d="M${rnd(0, 20).toFixed(0)} ${rnd(8, H - 8).toFixed(0)} C${rnd(40, 80).toFixed(0)} ${rnd(0, H).toFixed(0)} ${rnd(100, 140).toFixed(0)} ${rnd(0, H).toFixed(0)} ${rnd(170, W).toFixed(0)} ${rnd(8, H - 8).toFixed(0)}" stroke="${pal[(i + 1) % 5]}" stroke-width="${rnd(1.2, 2.4).toFixed(1)}" fill="none" opacity=".6"/>`
    ;[...ans].forEach((c, i) => {
        const x = 24 + i * 35 + rnd(-3, 3), y = 43 + rnd(-5, 5), r = rnd(-24, 24), sz = rnd(32, 40)
        g += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${sz.toFixed(0)}" transform="rotate(${r.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" text-anchor="middle" fill="${pal[(i * 2 + 1) % 5]}" stroke="#16110f" stroke-width="1.6" paint-order="stroke" style="font-family:Impact,'Arial Black',Haettenschweiler,sans-serif;font-weight:900">${c}</text>`
    })
    for (let i = 0; i < 3; i++) g += `<line x1="${rnd(0, 30).toFixed(0)}" y1="${rnd(6, H - 6).toFixed(0)}" x2="${rnd(160, W).toFixed(0)}" y2="${rnd(6, H - 6).toFixed(0)}" stroke="${pal[i * 2 % 5]}" stroke-width="1.4" opacity=".5"/>`
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff6c8"/>${g}</svg>`
}
const capIps = new Map()
function capLimit(req, res, next) {
    const now = Date.now(), r = capIps.get(req.ip) || { n: 0, reset: now + 600000 }
    if (now > r.reset) { r.n = 0; r.reset = now + 600000 }
    capIps.set(req.ip, r)
    if (++r.n > 150) return res.status(429).json({ error: 'terlalu sering' })
    next()
}
setInterval(() => { const n = Date.now(); for (const [k, v] of capIps) if (v.reset < n) capIps.delete(k) }, 600000).unref()

// ── Register ──────────────────────────────────────────────────────────────────
const RESERVED_NAMES = ['admin', 'administrator', 'owner', 'root', 'system', 'support', 'staff', 'moderator', 'dhann']
const regAttempts = new Map()
function regLimit(req, res, next) {
    const now = Date.now(), r = regAttempts.get(req.ip) || { n: 0, reset: now + 600000 }
    if (now > r.reset) { r.n = 0; r.reset = now + 600000 }
    regAttempts.set(req.ip, r)
    if (r.n >= 8) return res.status(429).send(registerPage(`Kebanyakan percobaan! Coba lagi dalam ${Math.ceil((r.reset - now) / 60000)} menit.`))
    req._reg = r
    next()
}
setInterval(() => { const n = Date.now(); for (const [k, v] of regAttempts) if (v.reset < n) regAttempts.delete(k) }, 600000).unref()


// request aktif disimpan per-async-context, supaya page() tahu siapa yang sedang login
const { AsyncLocalStorage } = require('async_hooks')
const als = new AsyncLocalStorage()
const curReq  = () => (als.getStore() || {}).req
const curUser = () => { const r = curReq(); return r && r.user ? r.user : null }

const getUi = () => {
    const u = curUser(), m = { ...UI_DEFAULT, ...((u && u.ui) || {}) }
    m.stagger = clamp(m.stagger, 0, 400, 90)
    m.speed   = clamp(m.speed, 0.5, 2, 1)
    if (!THEMES.includes(m.theme)) m.theme = 'auto'
    return m
}

// ── Role & izin ──────────────────────────────────────────────────────────────
const ROLES = {
    owner:   { label: 'Owner',   desc: 'Akses penuh, termasuk kelola user, role, gaya animasi, dan akses Visitor.', perms: ['*'] },
    admin:   { label: 'Admin',   desc: 'Kelola function, API key, maintenance, dan backup. Tidak bisa kelola user.', perms: ['view.functions', 'view.status', 'self', 'func.write', 'func.delete', 'keys', 'maint', 'backup', 'sysinfo'] },
    editor:  { label: 'Editor',  desc: 'Tambah, edit, dan aktif/nonaktifkan function. Tidak bisa menghapus atau melihat API key.', perms: ['view.functions', 'view.status', 'self', 'func.write'] },
    visitor: { label: 'Visitor', desc: 'Hanya bisa melihat. Tidak bisa mengubah apa pun, termasuk pengaturan akun. Halaman yang boleh dilihat diatur Owner di Setelan.', perms: [] },
}
const VIEW_PERMS = { 'view.functions': 'functions', 'view.status': 'status' }
const visitorCfg = () => ({ functions: true, status: true, ...(loadData().visitor || {}) })
const can = (user, perm) => {
    if (!user || !ROLES[user.role]) return false
    const p = ROLES[user.role].perms
    if (p.includes('*') || p.includes(perm)) return true
    if (user.role === 'visitor' && VIEW_PERMS[perm]) return !!visitorCfg()[VIEW_PERMS[perm]]
    return false
}
const need = perm => (req, res, next) => can(req.user, perm) ? next() : denied(req, res)
function denied(req, res) {
    if (req.method !== 'GET') return res.status(403).send('Akses ditolak')
    const role = (ROLES[req.user && req.user.role] || {}).label || '-'
    res.status(403).send(page('Akses Ditolak', `<div class="card"><div class="empty">Role kamu (${esc(role)}) tidak punya akses ke halaman ini.</div><div class="btn-group" style="justify-content:center"><a class="btn btn-primary" href="/panel/dashboard">Kembali ke Dashboard</a></div></div>`, ''))
}

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
    purgeUser(name) { for (const k of Object.keys(this.map)) if (this.map[k].data && this.map[k].data.user === name) delete this.map[k]; this._write() }
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
// header keamanan + blokir scraper (curl, wget, httrack, dll). Bisa dimatikan Owner di Setelan.
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    if (req.method === 'GET' && SCRAPER_UA.test(req.headers['user-agent'] || '') && shieldOn()) return res.status(403).type('text').send('403')
    next()
})
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))
app.use(session({
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: SESSION_TTL, httpOnly: true, sameSite: 'lax' }
}))
app.use((req, res, next) => als.run({ req }, next))

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.js')) cb(null, true)
        else cb(new Error('Hanya file .js yang diizinkan'))
    }
})

function auth(req, res, next) {
    if (!req.session || !req.session.loggedIn) return res.redirect('/panel/login')
    const users = loadData().users || []
    let u = users.find(x => x.username === req.session.user)
    if (!u && !req.session.user) {            // sesi lama (sebelum ada multi-user) dianggap Owner
        u = users.find(x => x.role === 'owner')
        if (u) req.session.user = u.username
    }
    if (!u) return req.session.destroy(() => res.redirect('/panel/login'))
    req.user = u
    next()
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
    sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:      '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    monitor:   '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    volume:    '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    mute:      '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>',
    chevl:     '<path d="M15 5l-7 7 7 7"/>',
    chevr:     '<path d="M9 5l7 7-7 7"/>',
    users:     '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.3c2.5.6 4 2.6 4 5.7"/>',
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

const DARK_VARS = `--paper:#1d1a2e;--panel:#2a2542;--field:#1a1729;--side:#241f3a;
  --fg:#f2eeff;--ink:#07050d;--on:#16110f;--muted:#b4abd0;
  --dots:rgba(242,238,255,.07);--dash:rgba(242,238,255,.2);--hover:#3a3360;--focus:#352f58;--tog:#4a4468;--inset:rgba(0,0,0,.35);--code:#5fe0a0;color-scheme:dark;`

const CSS = `
:root{
  --ie:0s;--stagger:90ms;--spd:1;
  --yellow:#ffd93d;--red:#ff5148;--blue:#3d8bff;--pink:#ff7ac6;--green:#3ddc84;--orange:#ff9f1c;
  --paper:#fffdf5;--panel:#ffffff;--field:#ffffff;--side:#ffd93d;
  --fg:#16110f;--ink:#16110f;--on:#16110f;--muted:#5c524c;
  --dots:rgba(22,17,15,.13);--dash:rgba(22,17,15,.25);--hover:#fff7c2;--focus:#fffbe0;--tog:#e4e0da;--inset:rgba(22,17,15,.08);--code:#0a7a3d;
  --shadow:6px 6px 0 var(--ink);--shadow-sm:3px 3px 0 var(--ink);--bw:3px;
  --head:'Bangers','Impact','Comic Sans MS',cursive;--body:'Comic Neue','Comic Sans MS','Chalkboard SE',system-ui,sans-serif;
  color-scheme:light;
}
html[data-theme="dark"]{${DARK_VARS}}
@media(prefers-color-scheme:dark){html[data-theme="auto"]{${DARK_VARS}}}

*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%;overflow-x:clip}
body{font-family:var(--body);font-weight:700;font-size:15px;color:var(--fg);min-height:100vh;
  background-color:var(--paper);
  background-image:radial-gradient(var(--dots) 1.3px,transparent 1.5px);background-size:14px 14px}
a{color:var(--blue);font-weight:900}
code{font-family:'Courier New',monospace;font-weight:700}
.fn{color:var(--code)}
:focus-visible{outline:3px dashed var(--blue);outline-offset:2px}
h1,h2,h3{font-family:var(--head);font-weight:400;letter-spacing:1px}
.ic{display:block;flex-shrink:0}
.ti{display:none!important}
html[data-theme="auto"] .ti-auto,html[data-theme="light"] .ti-light,html[data-theme="dark"] .ti-dark{display:block!important}

/* ── Layout ── */
.wrap{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{width:236px;background:var(--side);color:var(--fg);border-right:var(--bw) solid var(--ink);position:fixed;inset:0 auto 0 0;z-index:100;display:flex;flex-direction:column}
.logo{padding:18px 16px;border-bottom:var(--bw) solid var(--ink);background:var(--red);color:#fff;display:flex;align-items:center;gap:10px}
.logo-mark{width:44px;height:44px;flex-shrink:0;filter:drop-shadow(3px 3px 0 var(--ink));animation:bob 3s ease-in-out infinite}
.logo b{font-family:var(--head);font-weight:400;font-size:28px;letter-spacing:1.5px;display:block;line-height:1;text-shadow:3px 3px 0 var(--ink)}
.logo small{font-size:11px;font-weight:900;color:var(--on);background:var(--yellow);border:2px solid var(--ink);padding:0 7px;display:inline-block;margin-top:6px;transform:rotate(-2deg)}
.nav{flex:1;padding:12px;overflow-y:auto;perspective:700px}
.nav-label{font-family:var(--head);font-size:16px;letter-spacing:1px;margin:12px 4px 6px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 11px;margin-bottom:7px;background:var(--panel);color:var(--fg);border:2px solid var(--ink);border-radius:10px;font-weight:900;text-decoration:none;box-shadow:var(--shadow-sm);transform-origin:left center;transition:transform .15s,box-shadow .15s}
.nav-item:hover{transform:rotateY(-14deg) translate(-1px,-1px);box-shadow:5px 5px 0 var(--ink)}
.nav-item:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink)}
.nav-item.active{background:var(--pink);color:var(--on)}
.side-foot{padding:12px;border-top:var(--bw) solid var(--ink)}
.pill{display:flex;align-items:center;gap:8px;background:var(--panel);color:var(--fg);border:2px solid var(--ink);border-radius:20px;padding:6px 12px;font-size:12px;font-weight:900}
.bd{display:inline-block;width:9px;height:9px;border-radius:50%;background:currentColor;border:2px solid var(--ink);flex-shrink:0}
.pill .bd{background:var(--green)}

.main{margin-left:236px;flex:1;min-width:0}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 22px;background:var(--paper);border-bottom:var(--bw) solid var(--ink);position:sticky;top:0;z-index:50}
.topbar h1{font-size:34px;line-height:1;text-shadow:3px 3px 0 var(--yellow)}
.top-right{display:flex;align-items:center;gap:10px}
#clk{font-size:13px;font-weight:900;background:var(--panel);border:2px solid var(--ink);border-radius:8px;padding:3px 9px}
.content{padding:22px;max-width:1040px;perspective:1100px}

/* ── Card & efek 3D ── */
.card{background:var(--panel);border:var(--bw) solid var(--ink);border-radius:14px;box-shadow:var(--shadow);padding:18px;margin-bottom:24px;position:relative}
.card-title{font-family:var(--head);font-size:22px;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.ct-icon{width:38px;height:38px;border:2px solid var(--ink);border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:2px 2px 0 var(--ink);flex-shrink:0;color:var(--on)}
.c-pink{background:var(--pink)}.c-yellow{background:var(--yellow)}.c-blue{background:var(--blue)}.c-green{background:var(--green)}.c-red{background:var(--red)}.c-orange{background:var(--orange)}

.tilt{transform:perspective(900px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg)) rotateZ(var(--rz,0deg));transition:transform .18s ease-out;will-change:transform}
@keyframes flipin{from{opacity:0;transform:perspective(900px) rotateX(-65deg) translateY(26px)}to{opacity:1}}
.content>*{animation:flipin .65s cubic-bezier(.2,.9,.3,1.1) backwards;animation-delay:calc(var(--ie) + var(--i,0)*var(--stagger));transform-origin:50% 0}
@keyframes bob{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-6px) rotate(4deg)}}

.hero{display:flex;align-items:center;gap:26px;padding:22px 26px;background:var(--yellow);color:var(--on);overflow:visible}
.hero h2{font-size:38px;line-height:1;text-shadow:3px 3px 0 #fff}
.hero p{margin-top:8px;max-width:360px}
.hero .pow{position:absolute;right:-12px;top:-26px;width:104px;transform:rotate(12deg);filter:drop-shadow(4px 4px 0 var(--ink));animation:bob 2.6s ease-in-out infinite}
.pow{display:block}

.scene{width:var(--s);height:var(--s);perspective:600px;flex-shrink:0;position:relative;margin:10px}
.cube{width:100%;height:100%;position:relative;transform-style:preserve-3d;transform:rotateX(-24deg)}
.cube.css{animation:spin 14s linear infinite}
.scene[data-drag]{touch-action:pan-y;cursor:grab}.scene[data-drag]:active{cursor:grabbing}
.cube .f{position:absolute;inset:0;border:3px solid var(--ink);display:flex;align-items:center;justify-content:center;color:var(--on);backface-visibility:visible}
.f1{background:var(--pink);transform:translateZ(calc(var(--s)/2))}
.f2{background:var(--blue);color:#fff!important;transform:rotateY(90deg) translateZ(calc(var(--s)/2))}
.f3{background:var(--green);transform:rotateY(180deg) translateZ(calc(var(--s)/2))}
.f4{background:var(--orange);transform:rotateY(-90deg) translateZ(calc(var(--s)/2))}
.f5{background:#fff;transform:rotateX(90deg) translateZ(calc(var(--s)/2))}
.f6{background:var(--red);color:#fff!important;transform:rotateX(-90deg) translateZ(calc(var(--s)/2))}
@keyframes spin{from{transform:rotateX(-24deg) rotateY(0)}to{transform:rotateX(-24deg) rotateY(360deg)}}
.cube-shadow{position:absolute;left:12%;right:12%;bottom:calc(var(--s)*-.28);height:14px;border-radius:50%;background:rgba(0,0,0,.28);filter:blur(3px)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:18px;margin-bottom:24px}
.stat{border:var(--bw) solid var(--ink);border-radius:14px;box-shadow:var(--shadow);padding:14px 14px 12px;position:relative;transform-style:preserve-3d;color:var(--on)}
.stat:nth-child(odd){--rz:-1deg}.stat:nth-child(even){--rz:1deg}
.stat-val{font-family:var(--head);font-size:48px;line-height:1;text-shadow:3px 3px 0 rgba(255,255,255,.75);transform:translateZ(24px)}
.stat-label{font-size:13px;font-weight:900;transform:translateZ(12px)}
.stat .ic{position:absolute;right:12px;top:12px;opacity:.35;transform:translateZ(8px)}

/* ── Form ── */
.form-group{margin-bottom:14px}
.form-label{display:block;font-size:13px;font-weight:900;margin-bottom:5px}
.form-input,.form-select,.form-textarea{width:100%;background:var(--field);border:var(--bw) solid var(--ink);border-radius:10px;padding:9px 12px;color:var(--fg);font-family:var(--body);font-size:15px;font-weight:700;outline:none;box-shadow:inset 3px 3px 0 var(--inset)}
.form-input:focus,.form-select:focus,.form-textarea:focus{background:var(--focus);box-shadow:3px 3px 0 var(--blue)}
.form-textarea{resize:vertical;min-height:140px;font-family:'Courier New',monospace;font-size:13px;line-height:1.55;tab-size:2;white-space:pre}
.form-row{display:flex;gap:14px}.form-row .form-group{flex:1;min-width:0}
.form-range{width:100%;accent-color:var(--pink);height:30px}
.hint{font-size:12px;color:var(--muted);margin-top:4px;word-break:break-all}

/* ── Button 3D ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 16px;border:var(--bw) solid var(--ink);border-radius:12px;background:var(--yellow);color:var(--on);font-family:var(--head);font-size:17px;letter-spacing:1px;cursor:pointer;text-decoration:none;box-shadow:0 5px 0 var(--ink),0 7px 0 rgba(0,0,0,.25);transform:translateY(-2px);transition:transform .1s,box-shadow .1s;white-space:nowrap}
.btn:hover{transform:translateY(-4px);box-shadow:0 7px 0 var(--ink),0 10px 0 rgba(0,0,0,.2);text-decoration:none}
.btn:active{transform:translateY(3px);box-shadow:0 0 0 var(--ink)}
.btn-primary{background:var(--pink)}.btn-mint{background:var(--green)}.btn-blue{background:var(--blue);color:#fff}
.btn-danger{background:var(--red);color:#fff}.btn-ghost{background:var(--panel);color:var(--fg)}
.btn-sm{padding:5px 11px;font-size:15px;border-radius:9px;border-width:2px;box-shadow:0 4px 0 var(--ink)}
.btn-group{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding-bottom:6px}

/* ── Tabel ── */
.table-wrap{overflow-x:auto;border:var(--bw) solid var(--ink);border-radius:12px;padding-bottom:6px;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:14px;background:var(--panel)}
th{text-align:left;padding:10px 12px;font-family:var(--head);font-size:17px;font-weight:400;letter-spacing:1px;background:var(--blue);color:#fff;border-bottom:var(--bw) solid var(--ink);white-space:nowrap}
td{padding:10px 12px;border-bottom:2px dashed var(--dash);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--hover)}

.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border:2px solid var(--ink);border-radius:20px;font-size:12px;font-weight:900;background:var(--panel);color:var(--fg)}
.b-blue,.b-green,.b-red,.b-pink,.b-off{color:var(--on)}
.b-blue{background:#bcd8ff}.b-green{background:#a9f0c8}.b-red{background:#ffb3ae}.b-pink{background:#ffc5e6}.b-off{background:#e4e0da;color:#5c524c}
.b-green .bd{background:var(--green)}.b-off .bd{background:#aaa}

.alert{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border:var(--bw) solid var(--ink);border-radius:12px;box-shadow:var(--shadow-sm);font-weight:900;margin-bottom:18px;background:var(--panel);color:var(--fg)}
.alert .ic{margin-top:1px}
.alert-success,.alert-danger,.alert-warn,.alert-info{color:var(--on)}
.alert-success{background:#a9f0c8}.alert-danger{background:#ffb3ae}.alert-warn{background:#ffe9a0}.alert-info{background:#cfe3ff}

.toggle{position:relative;width:54px;height:30px;flex-shrink:0;display:inline-block}
.toggle input{opacity:0;width:0;height:0;position:absolute}
.toggle-slider{position:absolute;inset:0;background:var(--tog);border:var(--bw) solid var(--ink);border-radius:20px;cursor:pointer;transition:background .15s}
.toggle-slider::before{content:'';position:absolute;left:2px;top:2px;width:20px;height:20px;background:#fff;border:2px solid var(--ink);border-radius:50%;transition:transform .15s;box-shadow:2px 2px 0 var(--ink)}
.toggle input:checked+.toggle-slider{background:var(--green)}
.toggle input:checked+.toggle-slider::before{transform:translateX(24px)}
.toggle input:focus-visible+.toggle-slider{outline:3px dashed var(--blue);outline-offset:2px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:2px dashed var(--dash)}
.toggle-row:last-of-type{border-bottom:none}
.toggle-info h4{font-size:15px;font-weight:900}.toggle-info p{font-size:12px;color:var(--muted)}

.code{background:var(--ink);color:var(--green);border-radius:10px;padding:12px;font-family:'Courier New',monospace;font-size:13px;line-height:1.7;overflow-x:auto;white-space:pre;border:var(--bw) solid var(--ink)}
.key-box{display:flex;align-items:center;gap:10px;background:var(--panel);border:var(--bw) solid var(--ink);border-radius:12px;padding:10px 12px;margin-bottom:14px;box-shadow:var(--shadow-sm);flex-wrap:wrap}
.key-val{font-family:'Courier New',monospace;font-size:13px;word-break:break-all;background:var(--hover);color:var(--fg);border:2px dashed var(--ink);border-radius:6px;padding:3px 7px;margin-top:4px}
.divider{height:0;border-top:3px dashed var(--dash);margin:16px 0}
.empty{text-align:center;padding:26px 10px;font-family:var(--head);font-size:22px;letter-spacing:1px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px}

/* pilihan gaya (radio kartu) */
.opt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.opt{display:block;position:relative;cursor:pointer}
.opt input{position:absolute;opacity:0}
.opt-box{display:block;height:100%;border:var(--bw) solid var(--ink);border-radius:12px;padding:10px 12px;background:var(--panel);color:var(--fg);box-shadow:var(--shadow-sm);transition:transform .12s,background .12s}
.opt:hover .opt-box{transform:translateY(-2px)}
.opt input:checked+.opt-box{background:var(--yellow);color:var(--on)}
.opt input:focus-visible+.opt-box{outline:3px dashed var(--blue);outline-offset:2px}
.opt b{display:block;font-family:var(--head);font-size:19px;font-weight:400;letter-spacing:1px}
.opt small{display:block;font-size:12px;opacity:.85;margin-top:2px}

/* ── Login ── */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;perspective:1000px}
.login-box{background:var(--panel);border:4px solid var(--ink);border-radius:18px;box-shadow:10px 10px 0 var(--ink);padding:28px;width:100%;max-width:380px;position:relative;animation:flipin .8s cubic-bezier(.2,.9,.3,1.1) backwards}
.login-box .scene{margin:6px auto 22px}
.login-box h1{font-size:44px;text-align:center;line-height:1;text-shadow:4px 4px 0 var(--yellow);margin-bottom:6px}
.login-sub{text-align:center;font-weight:900;margin-bottom:20px;color:var(--muted)}
.login-box.shake{animation:shake .45s}
@keyframes shake{20%,60%{margin-left:-10px}40%,80%{margin-left:10px}}

/* ── Modal ── */
.modal{position:fixed;inset:0;background:rgba(10,8,16,.7);z-index:200;display:none;align-items:center;justify-content:center;padding:20px;perspective:900px}
.modal.open{display:flex}
.modal.open .modal-box{animation:pop .35s cubic-bezier(.2,1.3,.4,1)}
@keyframes pop{from{opacity:0;transform:rotateX(-55deg) scale(.85)}to{opacity:1}}
.modal-box{background:var(--panel);border:4px solid var(--ink);border-radius:16px;box-shadow:8px 8px 0 var(--ink);padding:22px;width:100%;max-width:420px}
.modal-title{font-family:var(--head);font-size:30px;letter-spacing:1px;margin-bottom:4px;color:var(--red)}
.modal-actions{display:flex;gap:12px;justify-content:flex-end;margin-top:18px}

/* ── Analisis source ── */
#analysis{margin-bottom:6px}
#analysis .alert{margin-bottom:12px}
.deps{margin:4px 0 14px}.deps .chips{margin-bottom:6px}

/* ── Efek latar 3D ── */
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
.bn-bar{inset:0;border-radius:18px;background:var(--panel);-webkit-mask:radial-gradient(circle at var(--x) 4px,transparent var(--rn),#000 calc(var(--rn) + .5px));mask:radial-gradient(circle at var(--x) 4px,transparent var(--rn),#000 calc(var(--rn) + .5px))}
.bn-bubble{position:absolute;left:var(--x);top:-23px;width:54px;height:54px;margin-left:-27px;border-radius:50%;background:var(--green);border:3px solid var(--ink);box-shadow:0 4px 0 var(--ink);display:flex;align-items:center;justify-content:center;color:var(--on);pointer-events:none}
.bn-list{position:relative;display:flex;height:100%;padding:0 6px}
.bn-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--fg);text-decoration:none;-webkit-tap-highlight-color:transparent;transition:transform .12s}
.bn-item:active{transform:scale(.86)}
.bn-item span{display:none;font-size:11px;font-weight:900}
.bn-item.active{justify-content:flex-end;padding-bottom:6px}
.bn-item.active .ic{display:none}
.bn-item.active span{display:block}
.bottomnav.none{--rn:0px}.bottomnav.none .bn-bubble{display:none}

/* ── Transisi halaman: UI lama keluar, UI baru masuk ── */
.main{transform-origin:50% 30%}
.waitburst{position:fixed;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;z-index:900;opacity:0;pointer-events:none;filter:drop-shadow(3px 3px 0 var(--ink))}
html.leaving .waitburst{opacity:1;transition:opacity .2s .5s;animation:waitSpin 1.1s linear infinite}
@keyframes waitSpin{to{transform:rotate(360deg)}}

/* ── Serpihan: tiap elemen terbang sendiri-sendiri (diatur lewat JS) ── */
html:not([data-anim="none"]) .content>*{animation:none}
html:not([data-anim="none"]) [style*="--j"]{animation:none}
html.pfx .wrap,html.pfx .login-wrap{overflow:clip}
html.pfx .nav{overflow:visible}
html.pfx .content{position:relative;z-index:60}
html.leaving body{pointer-events:none}
.si{display:none!important}
html[data-sfx="on"] .si-on,html[data-sfx="off"] .si-off{display:block!important}
.fxlayer{position:fixed;inset:0;pointer-events:none;z-index:950;overflow:hidden}
.fxstar{position:absolute;pointer-events:none}
.fxstar svg{width:100%;height:100%;display:block;filter:drop-shadow(2px 2px 0 #16110f)}
.fxring{position:absolute;width:40px;height:40px;border-radius:50%;border:5px solid #ffd93d;box-shadow:0 0 0 3px #16110f,inset 0 0 0 3px #16110f}
.fxword{position:absolute;white-space:nowrap;font-family:var(--head);font-size:clamp(40px,10vw,92px);letter-spacing:2px;color:#ff5148;-webkit-text-stroke:3px #16110f;paint-order:stroke fill;text-shadow:5px 5px 0 #16110f}

/* ── Pistol, kilat, lubang peluru ── */
.gun{position:absolute;filter:drop-shadow(7px 9px 0 rgba(0,0,0,.35));will-change:transform}
.gun svg{width:100%;height:auto;display:block}
.fxdim,.fxflash{position:absolute;inset:0}
.fxret{position:absolute;width:96px;height:96px}
.fxret svg,.fxhole svg{width:100%;height:100%;display:block}
.fxhole{position:absolute;width:64px;height:64px;margin:-32px 0 0 -32px}
.fxcase{position:absolute;width:16px;height:8px;background:#ffd93d;border:2px solid #16110f;border-radius:2px}
.fxsmoke{position:absolute;border-radius:50%;background:#efefef;border:3px solid #16110f}
.fxtracer{position:absolute;height:6px;border-radius:3px;background:linear-gradient(90deg,#fff,#ffd93d);box-shadow:0 0 12px #ffd93d,0 0 0 2px #16110f}

/* ── Muncul saat digulir + hemat render ── */
.rv-hide{opacity:0}
.cv{content-visibility:auto}
html.pfx .cv{content-visibility:visible!important}

/* ── Info dashboard ── */
.kv{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:2px dashed var(--dash)}
.kv:last-child{border-bottom:none}
.kv span{color:var(--muted);flex:0 0 auto}
.kv b{text-align:right;font-weight:900;word-break:break-word}
.bar{height:18px;border:3px solid var(--ink);border-radius:10px;background:var(--tog);overflow:hidden;margin-bottom:6px}
.bar i{display:block;height:100%;border-right:3px solid var(--ink)}

/* ── Pilihan gaya: geser kiri-kanan ── */
.sty-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:-4px 0 6px}
.sty-scroll{position:relative;display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding:8px 6px 20px;scrollbar-width:thin;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
.sty-card{flex:0 0 min(290px,82%);scroll-snap-align:center;display:block;cursor:pointer;position:relative}
.sty-card input{position:absolute;opacity:0;pointer-events:none}
.sty-box{display:flex;flex-direction:column;gap:9px;height:100%;border:var(--bw) solid var(--ink);border-radius:14px;background:var(--panel);color:var(--fg);box-shadow:var(--shadow-sm);padding:12px;transition:transform .15s,background .15s}
.sty-card.on .sty-box{transform:translateY(-4px)}
.sty-card input:checked+.sty-box{background:var(--yellow);color:var(--on)}
.sty-card input:focus-visible+.sty-box{outline:3px dashed var(--blue);outline-offset:2px}
.sty-box b{font-family:var(--head);font-weight:400;font-size:22px;letter-spacing:1px}
.sty-box small{font-size:12px;line-height:1.5;opacity:.92;flex:1}
.sty-box .chips{gap:6px}
.mini{position:relative;display:block;height:104px;border:3px solid var(--ink);border-radius:12px;overflow:hidden;background-color:var(--paper);background-image:radial-gradient(var(--dots) 1.3px,transparent 1.5px);background-size:12px 12px}
.mini i{position:absolute;width:26%;height:32%;border:3px solid var(--ink);border-radius:7px;box-shadow:2px 2px 0 var(--ink);background:var(--c);--tx:0px;--ty:0px;--rot:0deg;--sc:1;--rx:0deg}
.mini i:nth-of-type(1){left:6%;top:10%;--c:var(--pink)}
.mini i:nth-of-type(2){left:37%;top:10%;--c:var(--yellow);animation-delay:.07s}
.mini i:nth-of-type(3){left:68%;top:10%;--c:var(--blue);animation-delay:.14s}
.mini i:nth-of-type(4){left:6%;top:56%;--c:var(--green);animation-delay:.21s}
.mini i:nth-of-type(5){left:37%;top:56%;--c:var(--orange);animation-delay:.28s}
.mini i:nth-of-type(6){left:68%;top:56%;--c:var(--red);animation-delay:.35s}
@keyframes mAway{0%,14%{opacity:1;transform:none}46%{opacity:0;transform:perspective(300px) translate(var(--tx),var(--ty)) rotateX(var(--rx)) rotate(var(--rot)) scale(var(--sc))}54%{opacity:0;transform:perspective(300px) translate(calc(var(--tx)*-.6),calc(var(--ty)*-.6)) rotateX(var(--rx)) rotate(calc(var(--rot)*-1)) scale(var(--sc))}86%,100%{opacity:1;transform:none}}
@keyframes mBlast{0%,38%{opacity:1;transform:none}46%{opacity:0;transform:translate(var(--tx),var(--ty)) rotate(var(--rot)) scale(1.3)}70%{opacity:0;transform:scale(1.15)}82%,100%{opacity:1;transform:none}}
@keyframes mGun{0%,100%{transform:translateX(130%) rotate(0)}12%,30%{transform:translateX(0) rotate(0)}33%{transform:translateX(10%) rotate(9deg)}40%,66%{transform:translateX(0) rotate(0)}80%{transform:translateX(130%) rotate(0)}}
.sty-card.on .mini i,.sty-card:hover .mini i{animation:mAway 2.6s infinite}
.mini[data-s="gunshot"] i{--tx:0px;--ty:0px;--rot:25deg}
.sty-card.on .mini[data-s="gunshot"] i,.sty-card:hover .mini[data-s="gunshot"] i{animation-name:mBlast}
.mini-gun{position:absolute;right:-4%;top:26%;width:66%;transform:translateX(130%);z-index:2}
.mini-gun svg{width:100%;height:auto;display:block}
.sty-card.on .mini-gun,.sty-card:hover .mini-gun{animation:mGun 2.6s infinite}
.mini[data-s="burst"] i:nth-of-type(1){--tx:-90px;--ty:-60px;--rot:-200deg;--sc:.4}
.mini[data-s="burst"] i:nth-of-type(2){--tx:0px;--ty:-80px;--rot:120deg;--sc:.4}
.mini[data-s="burst"] i:nth-of-type(3){--tx:90px;--ty:-60px;--rot:200deg;--sc:.4}
.mini[data-s="burst"] i:nth-of-type(4){--tx:-90px;--ty:60px;--rot:160deg;--sc:.4}
.mini[data-s="burst"] i:nth-of-type(5){--tx:0px;--ty:80px;--rot:-120deg;--sc:.4}
.mini[data-s="burst"] i:nth-of-type(6){--tx:90px;--ty:60px;--rot:-200deg;--sc:.4}
.mini[data-s="gunshot"] i:nth-of-type(1){--tx:-70px;--ty:-40px}
.mini[data-s="gunshot"] i:nth-of-type(2){--tx:0px;--ty:-60px}
.mini[data-s="gunshot"] i:nth-of-type(3){--tx:70px;--ty:-40px}
.mini[data-s="gunshot"] i:nth-of-type(4){--tx:-70px;--ty:40px}
.mini[data-s="gunshot"] i:nth-of-type(5){--tx:0px;--ty:60px}
.mini[data-s="gunshot"] i:nth-of-type(6){--tx:70px;--ty:40px}
.mini[data-s="gunshot"] i{animation-delay:0s!important}
.mini[data-s="slam"] i{--ty:150px;--rot:40deg}
.mini[data-s="slam"] i:nth-of-type(even){--rot:-50deg}
.mini[data-s="flip"] i{--rx:100deg;--sc:.8}
.mini[data-s="curtain"] i{--tx:150px;--ty:60px;--rot:14deg}
.mini[data-s="zoom"] i{--sc:3.4}
.mini[data-s="swipe"] i{--tx:-170px}
.mini[data-s="swipe"] i:nth-of-type(even){--tx:170px}
.mini[data-s="pop"] i{--sc:0;--rot:90deg}
.mini[data-s="none"] i{animation:none!important}

/* ── Intro sinematik (login & sambutan) ── */
.intro{position:fixed;inset:0;z-index:1000;overflow:hidden;perspective:1100px;animation:introEnd .01s calc(var(--ie) + .8s) forwards}
@keyframes introEnd{to{visibility:hidden;pointer-events:none}}
html:not(.has-intro) .intro{display:none}
.in-half{position:absolute;inset:0}
.in-half.a{filter:drop-shadow(6px 0 0 #16110f);transform-origin:0 50%;animation:splitA .75s var(--ie) cubic-bezier(.7,0,.2,1) forwards}
.in-half.b{filter:drop-shadow(-6px 0 0 #16110f);transform-origin:100% 50%;animation:splitB .75s var(--ie) cubic-bezier(.7,0,.2,1) forwards}
.in-fill{position:absolute;inset:0;background-color:var(--yellow);background-image:radial-gradient(rgba(22,17,15,.22) 2px,transparent 2.5px);background-size:16px 16px}
.in-half.a .in-fill{clip-path:polygon(0 0,62% 0,38% 100%,0 100%)}
.in-half.b .in-fill{clip-path:polygon(62% 0,100% 0,100% 100%,38% 100%)}
@keyframes splitA{to{transform:translateX(-118%) rotateY(-35deg)}}
@keyframes splitB{to{transform:translateX(118%) rotateY(35deg)}}
.in-stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;animation:stageOut .4s calc(var(--ie) - .35s) cubic-bezier(.6,0,.9,.4) forwards}
@keyframes stageOut{to{opacity:0;transform:scale(2.6)}}
.in-rays{position:absolute;left:50%;top:50%;width:200vmax;height:200vmax;margin:-100vmax 0 0 -100vmax;background:repeating-conic-gradient(rgba(255,255,255,.75) 0 5deg,transparent 5deg 10deg);-webkit-mask:radial-gradient(circle,#000 0,transparent 52%);mask:radial-gradient(circle,#000 0,transparent 52%);animation:raysGo 2.6s .05s cubic-bezier(.2,.8,.3,1) both}
@keyframes raysGo{from{opacity:0;transform:scale(0) rotate(-30deg)}12%{opacity:1}to{opacity:1;transform:scale(1) rotate(55deg)}}
.in-burst{position:absolute;width:min(96vw,580px);filter:drop-shadow(6px 6px 0 #16110f);animation:burstSlam .75s .12s cubic-bezier(.2,1.5,.4,1) both,burstPulse .7s .9s ease-in-out infinite alternate}
@keyframes burstSlam{from{opacity:0;transform:scale(0) rotate(-140deg)}60%{opacity:1;transform:scale(1.18) rotate(8deg)}to{opacity:1;transform:scale(1) rotate(0)}}
@keyframes burstPulse{from{transform:scale(1) rotate(0)}to{transform:scale(1.07) rotate(3deg)}}
.in-title{position:relative;display:flex;font-family:var(--head);font-size:clamp(38px,11vw,96px);letter-spacing:2px;color:#fff;-webkit-text-stroke:3px #16110f;paint-order:stroke fill;text-shadow:6px 6px 0 #16110f;animation:jolt .35s .8s}
.in-title span{display:inline-block;animation:slam .55s calc(.45s + var(--i)*.07s) cubic-bezier(.2,1.6,.4,1) both}
@keyframes slam{from{opacity:0;transform:translateY(-110vh) rotate(-40deg) scale(2.2)}to{opacity:1;transform:translateY(0) rotate(var(--r,0deg)) scale(1)}}
@keyframes jolt{20%{transform:translate(-9px,6px) rotate(-1deg)}40%{transform:translate(8px,-6px)}60%{transform:translate(-5px,-4px)}80%{transform:translate(4px,3px)}}
.in-sub{position:relative;margin-top:16px;font-family:var(--head);font-size:clamp(16px,4.6vw,28px);letter-spacing:3px;background:#16110f;color:var(--yellow);padding:2px 14px;transform:rotate(-2deg);animation:subIn .4s var(--sd,1.4s) cubic-bezier(.2,1.5,.4,1) both}
@keyframes subIn{from{opacity:0;transform:rotate(-2deg) scale(.4) translateY(30px)}}
.in-sfx{position:absolute;font-family:var(--head);font-size:clamp(26px,8vw,54px);color:var(--red);-webkit-text-stroke:2px #16110f;paint-order:stroke fill;text-shadow:4px 4px 0 #16110f;animation:sfx 1s var(--sx,.5s) both}
@keyframes sfx{from{opacity:0;transform:translateX(-60vw) rotate(var(--sr)) scale(.4)}35%{opacity:1;transform:translateX(0) rotate(var(--sr)) scale(1.15)}70%{opacity:1;transform:translateX(0) rotate(var(--sr)) scale(1)}to{opacity:0;transform:translateX(30vw) rotate(var(--sr)) scale(.8)}}

html.has-intro .main{animation:none!important}
html.has-intro .topbar{animation:dropIn .6s var(--ie) cubic-bezier(.2,1.3,.4,1) backwards}
html.has-intro .sidebar{animation:slideSide .7s var(--ie) cubic-bezier(.2,1,.3,1) backwards}
html.has-intro.nav-right .sidebar{animation-name:slideSideR}
html.has-intro .bottomnav{animation:riseUp .7s var(--ie) cubic-bezier(.2,1.3,.4,1) backwards}
html.has-intro .login-box{animation:cardFly 1.1s var(--ie) cubic-bezier(.2,1.2,.3,1) backwards}
@keyframes dropIn{from{opacity:0;transform:translateY(-100%)}}
@keyframes slideSide{from{opacity:0;transform:translateX(-100%)}}
@keyframes slideSideR{from{opacity:0;transform:translateX(100%)}}
@keyframes riseUp{from{opacity:0;transform:translateY(160%)}}
@keyframes cardFly{from{opacity:0;transform:perspective(900px) translateZ(-700px) rotateX(40deg) rotateY(-30deg)}}

/* munculnya item satu per satu (jeda diatur di Setelan) */
@keyframes popin{from{opacity:0;transform:scale(.6) rotate(-6deg) translateY(14px)}}
@keyframes rowin{from{opacity:0;transform:translateX(-22px)}}
[style*="--j"]{animation:popin .55s cubic-bezier(.2,1.5,.4,1) backwards;animation-delay:calc(var(--ie) + var(--base,0ms) + var(--j,0)*var(--stagger)*.7)}
tr[style*="--j"],.nav-item[style*="--j"]{animation-name:rowin;animation-timing-function:ease-out}

/* ── Posisi navigasi PC ── */
html.nav-right .sidebar{left:auto;right:0;border-right:none;border-left:var(--bw) solid var(--ink)}
html.nav-right .main{margin-left:0;margin-right:236px}
html.nav-right .nav-item{transform-origin:right center}
html.nav-right .nav-item:hover{transform:rotateY(14deg) translate(1px,-1px)}
@media(min-width:769px){.bgfx{display:block}}

/* ── Mode hemat ── */
html.fx-off *{animation:none!important;transition:none!important}
html.fx-off .bgfx,html.fx-off .intro,html.fx-off .waitburst{display:none!important}

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
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.intro,.waitburst{display:none!important}}
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
    ['Functions', [['functions', 'bolt', 'Manage Functions', 'view.functions'], ['add-func', 'plus', 'Add Function', 'func.write']]],
    ['Security',  [['apikeys', 'key', 'API Keys', 'keys'], ['maintenance', 'wrench', 'Maintenance', 'maint']]],
    ['System',    [['backup', 'save', 'Backup', 'backup'], ['users', 'users', 'Users', 'users'], ['settings', 'gear', 'Settings', 'self']]],
]

// navigasi bawah di HP (maks 5, disaring sesuai role)
const BOTTOM = [
    ['dashboard', 'dashboard', 'Dashboard'],
    ['functions', 'bolt', 'Function', 'view.functions'],
    ['add-func', 'plus', 'Tambah', 'func.write'],
    ['apikeys', 'key', 'API Key', 'keys'],
    ['settings', 'gear', 'Setelan', 'self'],
]
const BOTTOM_MAP = { maintenance: 'settings', backup: 'settings', users: 'settings' }

const htmlClass = ui => [ui.fx === false ? 'fx-off' : '', ui.navSide === 'right' ? 'nav-right' : ''].filter(Boolean).join(' ')

// tiga ikon tema; yang tampil ditentukan CSS dari data-theme
const themeIcons = () => ['monitor:auto', 'sun:light', 'moon:dark'].map(x => { const [n, c] = x.split(':'); return ic(n, 17).replace('class="ic"', `class="ic ti ti-${c}"`) }).join('')

const sfxIcons = () => ['volume:on', 'mute:off'].map(x => { const [n, c] = x.split(':'); return ic(n, 17).replace('class="ic"', `class="ic si si-${c}"`) }).join('')

const themeMeta = theme => theme === 'dark' ? '<meta name="theme-color" content="#1d1a2e">'
    : theme === 'light' ? '<meta name="theme-color" content="#fffdf5">'
    : '<meta name="theme-color" content="#fffdf5" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#1d1a2e" media="(prefers-color-scheme: dark)">'

// Intro sinematik: sinar, ledakan, huruf menghantam layar, lalu panel komik terbelah
function introHTML(title, sub) {
    if (getAnim() === 'koran') return ''
    const chars = [...title]
    const ie = (0.45 + chars.length * 0.07 + 1.1).toFixed(2)
    const sd = (0.45 + chars.length * 0.07 + 0.3).toFixed(2)
    const letters = chars.map((ch, i) => `<span style="--i:${i};--r:${i % 2 ? 3 : -4}deg">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('')
    return `<div class="intro" id="intro" data-ie="${ie}" aria-hidden="true">
  <div class="in-half a"><div class="in-fill"></div></div>
  <div class="in-half b"><div class="in-fill"></div></div>
  <div class="in-stage">
    <div class="in-rays"></div>
    <svg class="in-burst" viewBox="0 0 100 100"><polygon points="${burstPts(14, 49, 33)}" fill="#ff5148" stroke="#16110f" stroke-width="3" stroke-linejoin="round"/></svg>
    <div class="in-title">${letters}</div>
    <div class="in-sub" style="--sd:${sd}s">${esc(sub)}</div>
    <div class="in-sfx" style="left:6%;top:16%;--sx:.5s;--sr:-12deg">ZAP!</div>
    <div class="in-sfx" style="right:6%;top:72%;--sx:.9s;--sr:10deg">BOOM!</div>
    <div class="in-sfx" style="left:10%;bottom:10%;--sx:1.2s;--sr:-6deg">WHAM!</div>
  </div>
</div>`
}

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

// efek: stagger, kecepatan, hitung naik angka, kubus bisa diputar, kontrol intro
const FX_JS = `
(function(){
  var root=document.documentElement;
  var off=root.classList.contains('fx-off')||(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  var cs=getComputedStyle(root);
  var st=parseFloat(cs.getPropertyValue('--stagger'))||0, spd=parseFloat(cs.getPropertyValue('--spd'))||1;
  document.querySelectorAll('.content>*').forEach(function(el,i){
    el.style.setProperty('--i',i);
    var base=i*st+250;
    el.querySelectorAll('.stat,.chips>*,tbody>tr,.key-box,.toggle-row').forEach(function(c,j){c.style.setProperty('--base',base+'ms');c.style.setProperty('--j',j)});
  });
  document.querySelectorAll('.sidebar .nav-item').forEach(function(c,j){c.style.setProperty('--base','200ms');c.style.setProperty('--j',j)});
  document.querySelectorAll('.stat-val[data-n]').forEach(function(el){
    var n=+el.dataset.n;if(off||!n)return;
    var host=el.closest('.stat');if(!host)return;
    host.addEventListener('animationstart',function(){
      var t0=performance.now();(function f(t){var p=Math.min(1,(t-t0)/(800/spd));el.textContent=Math.round(n*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(f)})(t0);
    },{once:true});
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
  if(spd!==1&&document.getAnimations){document.getAnimations().forEach(function(a){try{a.updatePlaybackRate(spd)}catch(_){}})}
  var it=document.getElementById('intro');
  if(it){
    if(off){it.remove()}else{
      var ie=parseFloat(cs.getPropertyValue('--ie'))||2;
      var tm=setTimeout(function(){it.remove()},(ie+1)*1000/spd);
      it.addEventListener('click',function(){clearTimeout(tm);root.style.setProperty('--ie','0s');it.style.transition='opacity .25s';it.style.opacity='0';setTimeout(function(){it.remove()},260)});
    }
    try{history.replaceState(null,'',location.pathname)}catch(_){}
  }
})();
`

// transisi halaman: UI lama diputar keluar dulu, baru pindah halaman; UI baru masuk lewat keyframe CSS
const GUN_SVG = '<svg viewBox="0 0 420 260" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block"><g stroke="#16110f" stroke-linejoin="round" stroke-linecap="round">' +
    '<path d="M236 150L318 146Q326 146 328 154L352 232Q356 246 340 248L296 252Q282 252 280 240Z" fill="#8a4a28" stroke-width="7"/>' +
    '<path d="M262 176L330 172M272 204L340 200" stroke="#5a2c14" stroke-width="5" fill="none"/>' +
    '<circle cx="304" cy="198" r="6" fill="#ffd93d" stroke-width="3"/>' +
    '<path d="M64 118H306V152H64Z" fill="#6f7a8e" stroke-width="7"/>' +
    '<path d="M150 148V166Q150 196 186 196Q222 196 222 166V148" fill="none" stroke-width="18"/>' +
    '<path d="M150 148V166Q150 196 186 196Q222 196 222 166V148" fill="none" stroke="#6f7a8e" stroke-width="7"/>' +
    '<path d="M184 152Q174 164 188 178L198 174Q192 164 200 152Z" fill="#3a4152" stroke-width="4"/>' +
    '<path d="M40 76Q40 62 56 62H322Q340 62 340 80V118H40Z" fill="#9aa5b8" stroke-width="7"/>' +
    '<path d="M58 74H316" stroke="#e8edf6" stroke-width="5" fill="none"/>' +
    '<path d="M296 74V110M308 74V110M320 74V110" stroke="#5d6779" stroke-width="4" fill="none"/>' +
    '<rect x="150" y="80" width="82" height="22" rx="4" fill="#2b2f3a" stroke-width="4"/>' +
    '<path d="M20 86H42V110H20Z" fill="#5d6779" stroke-width="6"/>' +
    '<path d="M54 62V48H70L74 62Z" fill="#5d6779" stroke-width="5"/>' +
    '<path d="M304 62V46H326V62Z" fill="#5d6779" stroke-width="5"/>' +
    '<path d="M338 64L362 54L368 74L346 84Z" fill="#3a4152" stroke-width="5"/>' +
    '</g></svg>'
const STAR_PTS = burstPts(5, 48, 21)

const ROUTER_JS = `
(function(){
  var root=document.documentElement;
  if(!document.querySelector('.main,.login-wrap'))return;
  var STYLE=root.dataset.anim||'none';
  var cs=getComputedStyle(root);
  var SPD=parseFloat(cs.getPropertyValue('--spd'))||1;
  var STG=parseFloat(cs.getPropertyValue('--stagger'));if(!isFinite(STG))STG=90;STG=STG/90;
  var FXOFF=root.classList.contains('fx-off')||(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  var OFF=STYLE==='none'||FXOFF;
  var PAL=['#ffd93d','#ff5148','#3d8bff','#ff7ac6','#3ddc84','#ff9f1c'];
  var WORDS={gunshot:['BANG!','BLAM!','DOR!'],burst:['BOOM!','KAPOW!','POW!'],slam:['WHAM!','SLAM!','THUD!'],flip:['FLIP!','FLOP!','WHIRR!'],curtain:['ZIP!','SWISH!','ZOOM!'],zoom:['VROOOM!','WHOOSH!','ZOOM!'],swipe:['SWOOSH!','ZING!','ZIP!'],pop:['POP!','POOF!','BLOP!']};
  var GUN='${GUN_SVG}';
  var R=Math.random,live=[],busy=false,G=null;
  var NP=root.classList.contains('news-pending'),NI='';
  try{NI=sessionStorage.getItem('newsIn')||'';sessionStorage.removeItem('newsIn')}catch(e){}
  function rr(a,b){return a+R()*(b-a)}
  function sgn(){return R()<.5?-1:1}
  function VW(){return window.innerWidth}
  function VH(){return window.innerHeight}
  function later(ms,fn){return setTimeout(fn,ms/SPD)}
  function clampv(v,a,b){return Math.max(a,Math.min(b,v))}
  function restore(){live.forEach(function(a){try{a.cancel()}catch(e){}});live=[];busy=false;root.classList.remove('leaving','pfx','news-pending');var nw=document.querySelectorAll('.news');for(var i=0;i<nw.length;i++)nw[i].remove()}

  /* ── SFX: suara disintesis langsung (tanpa file) ── */
  var AC=null,MG=null,NB=null;
  function ac(){
    if(root.dataset.sfx==='off')return null;
    if(!AC){
      try{var C=window.AudioContext||window.webkitAudioContext;if(!C)return null;
        AC=new C();MG=AC.createGain();MG.gain.value=.26;MG.connect(AC.destination)}catch(e){return null}
    }
    if(AC.state==='suspended'){try{AC.resume()}catch(e){}}
    return AC;
  }
  ['pointerdown','keydown','touchstart'].forEach(function(ev){addEventListener(ev,function(){ac()},{passive:true,capture:true})});
  function noise(c){
    if(!NB){NB=c.createBuffer(1,c.sampleRate,c.sampleRate);var d=NB.getChannelData(0);for(var i=0;i<d.length;i++)d[i]=R()*2-1}
    var s=c.createBufferSource();s.buffer=NB;return s;
  }
  function env(g,t,a,pk,dec){
    g.gain.setValueAtTime(.0001,t);
    g.gain.exponentialRampToValueAtTime(pk,t+a);
    g.gain.exponentialRampToValueAtTime(.0001,t+a+dec);
  }
  function whoosh(up,dur,vol){
    var c=ac();if(!c)return;dur=dur/SPD;
    var t=c.currentTime,s=noise(c),f=c.createBiquadFilter(),g=c.createGain();
    f.type='bandpass';f.Q.value=1.3;
    f.frequency.setValueAtTime(up?260:3400,t);
    f.frequency.exponentialRampToValueAtTime(up?3600:240,t+dur);
    env(g,t,dur*.4,vol||.9,dur*.6);
    s.connect(f);f.connect(g);g.connect(MG);s.start(t);s.stop(t+dur+.1);
  }
  function burstN(type,freq,dur,vol){
    var c=ac();if(!c)return;
    var t=c.currentTime,s=noise(c),f=c.createBiquadFilter(),g=c.createGain();
    f.type=type;f.frequency.value=freq;env(g,t,.002,vol,dur/SPD);
    s.connect(f);f.connect(g);g.connect(MG);s.start(t);s.stop(t+dur/SPD+.1);
  }
  function tone(type,f0,f1,dur,vol,delay){
    var c=ac();if(!c)return;dur=dur/SPD;
    var t=c.currentTime+(delay||0)/1000/SPD,o=c.createOscillator(),g=c.createGain();
    o.type=type;o.frequency.setValueAtTime(f0,t);o.frequency.exponentialRampToValueAtTime(Math.max(20,f1),t+dur);
    env(g,t,.008,vol,dur);
    o.connect(g);g.connect(MG);o.start(t);o.stop(t+dur+.05);
  }
  function thump(vol,f0){
    tone('sine',f0||150,38,.38,vol||1);
    burstN('lowpass',900,.14,(vol||1)*.5);
  }
  function pop(vol,f0,delay){tone('sine',f0||560,170,.13,vol||.8,delay)}
  function zap(vol,delay){tone('sawtooth',1500,120,.2,vol||.4,delay)}
  function ding(vol,delay){tone('triangle',880,880,.28,vol||.5,delay);tone('triangle',1320,1320,.3,(vol||.5)*.7,(delay||0)+70)}
  function sfxCock(){tone('square',1700,1100,.04,.25);later(90,function(){tone('square',1200,800,.05,.3)})}
  function sfxGun(){
    burstN('highpass',1200,.16,1);
    thump(1.25,200);
    tone('sawtooth',900,60,.22,.5);
    later(170,function(){burstN('lowpass',1400,.4,.35)});
    later(380,function(){tone('triangle',3300,2900,.07,.35)});
    later(470,function(){tone('triangle',3000,2600,.06,.25)});
  }
  function sfxOut(){
    var s=STYLE;
    if(s==='burst'){thump(1,160);whoosh(true,.5,.8);zap(.25,120)}
    else if(s==='slam'){thump(1.1,120);whoosh(false,.45,.7);later(180,function(){thump(.7,90)})}
    else if(s==='flip'){whoosh(true,.35,.7);pop(.6,700,120);pop(.5,500,220)}
    else if(s==='curtain'){whoosh(false,.4,.8);zap(.3,50)}
    else if(s==='zoom'){whoosh(true,.6,.9);tone('sine',200,900,.5,.25)}
    else if(s==='swipe'){whoosh(false,.38,.85)}
    else if(s==='pop'){pop(.9,640);pop(.8,520,90);pop(.8,760,170);zap(.2,200)}
  }
  function sfxIn(){
    if(STYLE==='gunshot'){later(120,function(){ding(.3)});return}
    whoosh(false,.55,.7);
    if(STYLE==='burst'||STYLE==='slam'){later(520,function(){thump(.8,120);ding(.35)})}
    else if(STYLE==='pop'){later(300,function(){pop(.8,600);pop(.7,800,80)});later(560,function(){ding(.4)})}
    else{later(480,function(){pop(.7,520);ding(.4)})}
  }

  /* ── Efek visual: kata komik, bintang, gelombang kejut ── */
  var layer=null;
  function lay(){if(!layer||!layer.isConnected){layer=document.createElement('div');layer.className='fxlayer';layer.setAttribute('aria-hidden','true');document.body.appendChild(layer)}return layer}
  function mk(cls,css,html){var d=document.createElement('div');d.className=cls;if(css)d.style.cssText=css;if(html)d.innerHTML=html;lay().appendChild(d);return d}
  function gone(a,el){a.onfinish=function(){el.remove()}}
  function word(text,x,y,rot){
    var w=mk('fxword','left:'+x+'px;top:'+y+'px');w.textContent=text;
    var b='translate(-50%,-50%) rotate('+rot+'deg) scale(';
    gone(w.animate([{transform:b+'.2)',opacity:0,offset:0},{transform:b+'1.25)',opacity:1,offset:.22},{transform:b+'1)',opacity:1,offset:.7},{transform:'translate(-50%,-80%) rotate('+rot+'deg) scale(1.1)',opacity:0,offset:1}],{duration:900/SPD,easing:'ease-out'}),w);
  }
  function ring(x,y){
    var d=mk('fxring','left:'+x+'px;top:'+y+'px');
    gone(d.animate([{transform:'translate(-50%,-50%) scale(.2)',opacity:1},{transform:'translate(-50%,-50%) scale(16)',opacity:0}],{duration:650/SPD,easing:'cubic-bezier(.1,.7,.3,1)'}),d);
  }
  var STAR='<svg viewBox="0 0 100 100"><polygon points="${STAR_PTS}" fill="currentColor" stroke="#16110f" stroke-width="7" stroke-linejoin="round"/></svg>';
  function stars(x,y,n){
    for(var i=0;i<n;i++){
      var sz=14+R()*26,s=mk('fxstar','left:'+x+'px;top:'+y+'px;width:'+sz+'px;height:'+sz+'px;color:'+PAL[i%6],STAR);
      var ang=R()*6.283,d=120+R()*Math.min(VW(),700)*.6,dx=Math.cos(ang)*d,dy=Math.sin(ang)*d;
      gone(s.animate([
        {transform:'translate(-50%,-50%) scale(.2) rotate(0deg)',opacity:1,offset:0},
        {transform:'translate(calc(-50% + '+dx*.7+'px),calc(-50% + '+dy*.7+'px)) scale(1.1) rotate('+rr(0,360)+'deg)',opacity:1,offset:.45},
        {transform:'translate(calc(-50% + '+dx+'px),calc(-50% + '+(dy+160)+'px)) scale(.4) rotate('+rr(-360,360)+'deg)',opacity:0,offset:1}
      ],{duration:(700+R()*400)/SPD,delay:R()*80/SPD,easing:'cubic-bezier(.2,.8,.3,1)',fill:'backwards'}),s);
    }
  }
  function shake(k){
    var c=document.querySelector('.content,.login-box');if(!c)return;k=k||1;
    c.animate([{transform:'translate(0,0)'},{transform:'translate('+(-9*k)+'px,'+(5*k)+'px)'},{transform:'translate('+(8*k)+'px,'+(-6*k)+'px)'},{transform:'translate('+(-5*k)+'px,'+(-3*k)+'px)'},{transform:'translate('+(4*k)+'px,'+(3*k)+'px)'},{transform:'translate(0,0)'}],{duration:340/SPD});
  }
  function fxOut(ox,oy){
    sfxOut();
    var W=WORDS[STYLE]||WORDS.burst;
    word(W[(R()*W.length)|0],clampv(ox,VW()*.25,VW()*.75),clampv(oy-30,VH()*.2,VH()*.7),rr(-14,14));
    if(STYLE!=='flip'&&STYLE!=='swipe'&&STYLE!=='curtain')ring(ox,oy);
    stars(ox,oy,STYLE==='pop'?18:12);
    if(STYLE==='burst'||STYLE==='slam')shake();
  }
  function fxIn(){
    sfxIn();
    if(STYLE==='gunshot')return;
    later(420,function(){
      var W=WORDS[STYLE]||WORDS.burst,x=VW()*rr(.35,.65),y=VH()*rr(.3,.45);
      word(W[(R()*W.length)|0],x,y,rr(-12,12));
      ring(VW()/2,VH()*.4);stars(VW()/2,VH()*.4,10);
    });
  }

  /* ── Pistol: meluncur dari samping, membidik, menembak ── */
  var HOLE='<svg viewBox="-32 -32 64 64"><g stroke="#16110f" stroke-linecap="round" fill="none"><path d="M0 0L26 -6M0 0L-24 -14M0 0L-8 28M0 0L10 -27M0 0L-28 10M0 0L22 18M0 0L-14 -28" stroke-width="3"/></g><circle r="15" fill="none" stroke="#fff" stroke-width="3" opacity=".85"/><circle r="11" fill="#16110f"/></svg>';
  var RET='<svg viewBox="-50 -50 100 100" fill="none" stroke-linecap="round"><g stroke="#16110f" stroke-width="11"><circle r="30"/><path d="M0 -46V-18M0 46V18M-46 0H-18M46 0H18"/></g><g stroke="#ff5148" stroke-width="5"><circle r="30"/><path d="M0 -46V-18M0 46V18M-46 0H-18M46 0H18"/></g><circle r="4" fill="#ff5148"/></svg>';
  var FLASH='<svg viewBox="0 0 100 100"><polygon points="${STAR_PTS}" fill="#ff9f1c" stroke="#16110f" stroke-width="5" stroke-linejoin="round"/><polygon points="${STAR_PTS}" fill="#fff6c8" transform="translate(50 50) scale(.55) translate(-50 -50)"/></svg>';
  function gunMetrics(ox,oy){
    var gw=Math.min(VW()*.72,440),sc=gw/420,side=ox<VW()*.5?'right':'left',mx,L;
    if(side==='right'){mx=Math.min(ox+110,VW()-40);L=mx-20*sc}else{mx=Math.max(ox-110,40);L=mx-(gw-20*sc)}
    var T=Math.max(4,Math.min(VH()-252*sc-4,oy-98*sc));
    return {side:side,L:L,T:T,gw:gw,sc:sc,mx:mx,my:T+98*sc,ox:ox,oy:oy,dx0:side==='right'?VW()-L+30:-(L+gw+30),vw:VW(),vh:VH(),t:Date.now()};
  }
  function gunEl(g){
    var d=mk('gun','left:'+g.L+'px;top:'+g.T+'px;width:'+g.gw+'px;transform-origin:'+(g.side==='right'?'75% 70%':'25% 70%'),'<div style="transform:'+(g.side==='right'?'none':'scaleX(-1)')+'">'+GUN+'</div>');
    return d;
  }
  function smoke(g,n){
    for(var i=0;i<n;i++){
      var sz=(24+R()*26)*Math.max(.7,g.sc),s=mk('fxsmoke','left:'+(g.mx-sz/2)+'px;top:'+(g.my-sz/2)+'px;width:'+sz+'px;height:'+sz+'px');
      var dx=(g.side==='right'?1:-1)*rr(10,70),dy=-rr(70,170);
      gone(s.animate([{transform:'translate(0,0) scale(.4)',opacity:.95},{transform:'translate('+dx+'px,'+dy+'px) scale('+rr(1.8,2.8)+')',opacity:0}],{duration:rr(700,1100)/SPD,delay:i*60/SPD,easing:'ease-out',fill:'backwards'}),s);
    }
  }
  function hole(g,fade){
    var h=mk('fxhole','left:'+g.ox+'px;top:'+g.oy+'px',HOLE);
    if(fade){gone(h.animate([{opacity:1,offset:0},{opacity:1,offset:.6},{opacity:0,offset:1}],{duration:1300/SPD}),h)}
    else h.animate([{transform:'scale(2.2)',opacity:0},{transform:'scale(1)',opacity:1}],{duration:120/SPD,easing:'ease-out',fill:'backwards'});
    return h;
  }
  function bangFx(g){
    var W=WORDS.gunshot,sc=g.sc;
    sfxGun();
    var fl=mk('fxflash','background:radial-gradient(circle at '+g.ox+'px '+g.oy+'px,#fff 0,rgba(255,235,150,.85) 22%,rgba(255,255,255,0) 70%)');
    gone(fl.animate([{opacity:1},{opacity:0}],{duration:240/SPD,easing:'ease-out'}),fl);
    var mf=mk('fxstar','left:'+g.mx+'px;top:'+g.my+'px;width:'+(170*sc)+'px;height:'+(170*sc)+'px',FLASH);
    gone(mf.animate([{transform:'translate(-50%,-50%) scale(.2) rotate(0deg)',opacity:1},{transform:'translate(-50%,-50%) scale(1.25) rotate(40deg)',opacity:1,offset:.4},{transform:'translate(-50%,-50%) scale(.1) rotate(80deg)',opacity:0}],{duration:170/SPD}),mf);
    var dx=g.ox-g.mx,dy=g.oy-g.my,len=Math.sqrt(dx*dx+dy*dy),ang=Math.atan2(dy,dx)*180/Math.PI;
    var tr=mk('fxtracer','left:'+g.mx+'px;top:'+(g.my-3)+'px;width:'+len+'px;transform-origin:0 50%');
    gone(tr.animate([{transform:'rotate('+ang+'deg) scaleX(0)',opacity:1},{transform:'rotate('+ang+'deg) scaleX(1)',opacity:1,offset:.5},{transform:'rotate('+ang+'deg) scaleX(1)',opacity:0}],{duration:170/SPD,easing:'ease-out'}),tr);
    var ex=g.side==='right'?g.L+190*sc:g.L+g.gw-190*sc,ey=g.T+84*sc,cd=(g.side==='right'?1:-1)*rr(90,150);
    var cs2=mk('fxcase','left:'+ex+'px;top:'+ey+'px');
    gone(cs2.animate([{transform:'translate(0,0) rotate(0deg)',opacity:1},{transform:'translate('+cd*.55+'px,-110px) rotate(260deg)',opacity:1,offset:.4},{transform:'translate('+cd+'px,170px) rotate(640deg)',opacity:0}],{duration:900/SPD,easing:'cubic-bezier(.3,.6,.5,1)'}),cs2);
    smoke(g,6);hole(g,false);ring(g.ox,g.oy);stars(g.ox,g.oy,14);
    word(W[(R()*W.length)|0],clampv(g.ox,VW()*.28,VW()*.72),clampv(g.oy-50,VH()*.2,VH()*.7),rr(-12,12));
    shake(1.6);
    try{sessionStorage.setItem('wa-gun',JSON.stringify(g))}catch(e){}
  }
  function gunLeave(ox,oy,onBang,onAfter){
    var g=gunMetrics(ox,oy),el=gunEl(g),right=g.side==='right',rx=right?46:-46,rot=right?10:-10,D=1000/SPD;
    G={el:el,g:g};
    var dim=mk('fxdim','background:radial-gradient(circle at '+ox+'px '+oy+'px,rgba(0,0,0,0) 0,rgba(0,0,0,.5) 75%)');
    dim.animate([{opacity:0,offset:0},{opacity:1,offset:.47},{opacity:1,offset:.7},{opacity:0,offset:1}],{duration:760/SPD,fill:'forwards'});
    var ret=mk('fxret','left:'+(ox-48)+'px;top:'+(oy-48)+'px',RET);
    ret.animate([{transform:'scale(2.4) rotate(120deg)',opacity:0,offset:0},{transform:'scale(1) rotate(0deg)',opacity:1,offset:.6},{transform:'scale(.9) rotate(0deg)',opacity:1,offset:1}],{duration:540/SPD,easing:'ease-out',fill:'forwards'});
    var b='translate(0,0) rotate(0deg)';
    el.animate([
      {transform:'translate('+g.dx0+'px,0) rotate(0deg)',offset:0,easing:'cubic-bezier(.15,.9,.3,1.08)'},
      {transform:b,offset:.36},
      {transform:'translate(2px,-3px) rotate(.8deg)',offset:.42},
      {transform:'translate(-2px,2px) rotate(-.6deg)',offset:.47},
      {transform:'translate(1px,-1px) rotate(.3deg)',offset:.52},
      {transform:'translate('+rx+'px,2px) rotate('+rot+'deg)',offset:.56,easing:'ease-out'},
      {transform:b,offset:.7,easing:'ease-in-out'},
      {transform:b,offset:1}
    ],{duration:D,fill:'forwards'});
    whoosh(true,.35,.6);later(360,sfxCock);
    setTimeout(function(){
      ret.remove();bangFx(g);
      if(onBang)onBang();
      if(onAfter)onAfter();
    },.54*D);
  }
  function gunClear(){
    var g=G;G=null;if(!g)return;
    var right=g.g.side==='right';
    var a=g.el.animate([{transform:'translate(0,0) rotate(0deg)'},{transform:'translate('+(right?1:-1)*(VW()*.9)+'px,0) rotate('+(right?-6:6)+'deg)'}],{duration:380/SPD,easing:'ease-in',fill:'forwards'});
    whoosh(false,.3,.5);
    a.onfinish=function(){g.el.remove();var hs=layer&&layer.querySelectorAll('.fxhole');if(hs)[].forEach.call(hs,function(h){h.remove()})};
  }
  function gunEnter(){
    var raw=null;try{raw=sessionStorage.getItem('wa-gun');sessionStorage.removeItem('wa-gun')}catch(e){}
    if(!raw)return null;
    var g;try{g=JSON.parse(raw)}catch(e){return null}
    if(!g||Date.now()-g.t>9000||Math.abs(g.vw-VW())>40)return null;
    return g;
  }
  function gunArrive(g){
    var fl=mk('fxflash','background:#fff');
    gone(fl.animate([{opacity:.95},{opacity:0}],{duration:240/SPD,easing:'ease-out'}),fl);
    hole(g,true);smoke(g,4);
    var el=gunEl(g),right=g.side==='right';
    var a=el.animate([{transform:'translate(0,0) rotate(0deg)',offset:0},{transform:'translate(0,0) rotate(0deg)',offset:.4},{transform:'translate('+(right?1:-1)*(VW()*.9)+'px,0) rotate('+(right?-6:6)+'deg)',offset:1}],{duration:780/SPD,easing:'ease-in'});
    gone(a,el);
    later(300,function(){whoosh(false,.3,.5)});
  }

  /* ── Elemen yang jadi serpihan ── */
  var CHROME=[['.sidebar .logo','item'],['.sidebar .nav-label','item'],['.sidebar .nav-item','item'],['.sidebar .pill','item'],
    ['.topbar h1','item'],['.topbar .top-right>*','item']];
  var BODY=[['.login-box .scene','item'],['.login-box h1','item'],['.login-box .login-sub','item'],['.login-box .alert','item'],['.login-box .form-group','item'],['.login-box .btn','item'],
    ['.content .hero .pow','item'],['.content .hero .scene','item'],['.content .hero h2','item'],['.content .hero p','item'],
    ['.content .stat','item'],['.content .key-box','item'],['.content .toggle-row','item'],['.content .alert','item'],
    ['.content .card-title','item'],['.content .kv','item'],['.content .bar','item'],['.content .form-group','item'],['.content .chips>*','item'],['.content .opt','item'],
    ['.content .code','item'],['.content .deps','item'],['.content .empty','item'],['.content .divider','item'],
    ['.content .btn','item'],['.content tbody tr','row',14],
    ['.content>.card','shell'],['.content .table-wrap','shell'],['.login-box','shell']];
  function collect(withChrome){
    var out=[];
    function add(sel,kind,cap){
      var els=document.querySelectorAll(sel),n=0;
      for(var i=0;i<els.length;i++){
        if(out.length>=150)return;
        var el=els[i];
        if(out.some(function(p){return p.el===el}))continue;
        var r=el.getBoundingClientRect();
        if(r.width<2||r.height<2)continue;
        if(r.bottom<-40||r.top>VH()+40||r.right<-40||r.left>VW()+40)continue;
        if(kind==='item'){
          if(el.closest('.table-wrap,.sty-scroll'))continue;
          if(out.some(function(p){return p.kind==='item'&&p.el.contains(el)}))continue;
        }
        if(cap&&n>=cap)break;
        n++;out.push({el:el,kind:kind,r:r});
      }
    }
    (withChrome?CHROME:[]).concat(BODY).forEach(function(l){add(l[0],l[1],l[2])});
    return out;
  }
  function keyOf(o,ctx){
    var r=o.r,cx=r.left+r.width/2,cy=r.top+r.height/2,vw=VW(),vh=VH();
    function c01(v){return Math.max(0,Math.min(1,v))}
    if(STYLE==='slam'||STYLE==='flip'||STYLE==='swipe')return c01(cy/vh);
    if(STYLE==='curtain')return c01((cx/vw+cy/vh)/2);
    if(STYLE==='pop')return R();
    var dx=cx-ctx.x,dy=cy-ctx.y;
    return c01(Math.sqrt(dx*dx+dy*dy)/Math.sqrt(vw*vw+vh*vh)*1.4);
  }

  /* ── Transform 3D ── */
  function TF(dx,dy,dz,rx,ry,rz,sx,sy,sk){
    return 'perspective(900px) translate3d('+dx.toFixed(1)+'px,'+dy.toFixed(1)+'px,'+dz.toFixed(1)+'px) rotateX('+rx.toFixed(1)+'deg) rotateY('+ry.toFixed(1)+'deg) rotateZ('+rz.toFixed(1)+'deg) scale('+sx.toFixed(3)+','+sy.toFixed(3)+') skewX('+sk.toFixed(1)+'deg)';
  }
  function mkP(dx,dy,dz,rx,ry,rz,s,sk){return {dx:dx,dy:dy,dz:dz,rx:rx,ry:ry,rz:rz,s:s,sk:sk||0}}
  function fmt(P,k){var s=1+(P.s-1)*k;return TF(P.dx*k,P.dy*k,P.dz*k,P.rx*k,P.ry*k,P.rz*k,s,s,P.sk*k)}
  function away(o,ctx,mode){
    var r=o.r,cx=r.left+r.width/2,cy=r.top+r.height/2,f=o.kind==='shell'?.5:1;
    var far=(VW()+VH())*rr(.55,1)*f,vx=cx-ctx.x,vy=cy-ctx.y,len=Math.sqrt(vx*vx+vy*vy),inn=mode==='in'?-1:1,i=o.i;
    if(len<30){var a=R()*6.283;vx=Math.cos(a);vy=Math.sin(a);len=1}
    var ux=vx/len,uy=vy/len,dir=i%2?1:-1;
    switch(STYLE){
      case 'slam':    return mkP((R()-.5)*260,inn*VH()*rr(.9,1.5)*f,0,inn>0?rr(10,60):rr(-40,40),0,sgn()*rr(25,100),1);
      case 'flip':    return i%2?mkP(0,sgn()*rr(10,50),rr(-160,0),sgn()*rr(95,170),0,sgn()*rr(0,10),.85)
                              :mkP(0,sgn()*rr(10,40),rr(-160,0),0,sgn()*rr(95,170),sgn()*rr(0,10),.85);
      case 'curtain': return mkP(inn*VW()*rr(.8,1.3)*f,inn*rr(60,300)*f,0,0,0,inn*rr(4,18),1,-20*inn);
      case 'zoom':    return inn>0?mkP(ux*140,uy*140,rr(0,200),0,0,sgn()*rr(0,25),rr(2.4,4.5))
                                  :mkP(-ux*60,-uy*60,0,0,0,sgn()*rr(0,30),rr(.05,.3));
      case 'swipe':   return mkP(inn*dir*VW()*rr(.9,1.2),0,0,0,0,0,1,-18*dir*inn);
      default:        return mkP(ux*far,uy*far,rr(-300,300),rr(-220,220),rr(-220,220),rr(-360,360),rr(.35,1.1));
    }
  }

  function play(o,ctx,mode,base){
    var out=mode==='out',kf,ease,dur,P;
    var d=base+o.key*(out?260:380)*STG+R()*40;
    if(out&&o.kind==='shell')d+=110;
    if(!out&&o.kind!=='shell')d+=150;
    if(o.kind==='row'){
      var dir=o.i%2?1:-1,w=o.r.width*.9;
      var ex='translateX('+(out?dir*w:-dir*w)+'px) skewX('+(out?-dir*20:dir*20)+'deg)';
      kf=out?[{transform:'none',opacity:1,offset:0},{transform:ex,opacity:0,offset:1}]
            :[{transform:ex,opacity:0,offset:0},{transform:'none',opacity:1,offset:1}];
      ease=out?'cubic-bezier(.6,0,1,.6)':'cubic-bezier(.2,1.2,.4,1)';dur=out?420:560;
    }else if(STYLE==='gunshot'){
      P=away(o,ctx,mode);
      if(out){
        kf=[{transform:'none',opacity:1,offset:0},{transform:fmt(P,.5),opacity:1,offset:.3},{transform:fmt(P,1),opacity:0,offset:1}];
        ease='cubic-bezier(.1,.85,.3,1)';dur=520;d=o.key*90*STG+R()*20+(o.kind==='shell'?60:0);
      }else{
        kf=[{transform:'scale(1.14)',opacity:0,offset:0},{transform:'scale(.985)',opacity:1,offset:.6},{transform:'none',opacity:1,offset:1}];
        ease='cubic-bezier(.2,.9,.3,1)';dur=340;d=base+o.key*150*STG+R()*20;
      }
    }else if(STYLE==='pop'){
      var rz=sgn()*rr(60,150);
      kf=out?[{transform:'none',opacity:1,offset:0},{transform:'scale(1.22) rotate('+rr(-6,6)+'deg)',opacity:1,offset:.38},{transform:'scale(0) rotate('+rz+'deg)',opacity:0,offset:1}]
            :[{transform:'scale(0) rotate('+rz+'deg)',opacity:0,offset:0},{transform:'scale(1.15) rotate('+rr(-5,5)+'deg)',opacity:1,offset:.6},{transform:'scale(.95)',opacity:1,offset:.8},{transform:'none',opacity:1,offset:1}];
      ease=out?'ease-in':'cubic-bezier(.2,.9,.3,1)';dur=out?520:640;
    }else{
      P=away(o,ctx,mode);
      if(out){
        kf=[{transform:'none',opacity:1,offset:0}];
        if(STYLE==='burst')kf.push({transform:fmt(mkP(0,0,0,0,0,0,.9),1),opacity:1,offset:.15});
        else if(STYLE==='slam')kf.push({transform:TF(rr(-6,6),rr(-5,5),0,0,0,rr(-2,2),1,1,0),opacity:1,offset:.14});
        kf.push({transform:fmt(P,.6),opacity:1,offset:.62});
        kf.push({transform:fmt(P,1),opacity:0,offset:1});
        ease='cubic-bezier(.5,0,.9,.5)';dur=600;
      }else if(STYLE==='slam'){
        kf=[{transform:fmt(P,1),opacity:0,offset:0,easing:'cubic-bezier(.55,0,1,.5)'},
            {transform:TF(0,0,0,0,0,0,1.07,.9,0),opacity:1,offset:.55,easing:'ease-out'},
            {transform:TF(0,-14,0,0,0,0,.98,1.03,0),opacity:1,offset:.74,easing:'ease-in'},
            {transform:TF(0,0,0,0,0,0,1.02,.98,0),opacity:1,offset:.88,easing:'ease-out'},
            {transform:'none',opacity:1,offset:1}];
        ease='linear';dur=900;
      }else{
        kf=[{transform:fmt(P,1),opacity:0,offset:0},{transform:fmt(P,.4),opacity:1,offset:.35},{transform:'none',opacity:1,offset:1}];
        ease='cubic-bezier(.2,1.35,.4,1)';dur=760;
      }
    }
    o.delay=d/SPD;
    return o.el.animate(kf,{duration:dur/SPD,delay:d/SPD,easing:ease,fill:out?'forwards':'backwards'});
  }

  /* ── Transisi Koran: koran terbit, digunting, di-zoom jadi UI baru ── */
  var NT={login:'MASUK',register:'DAFTAR',dashboard:'DASHBOARD',functions:'FUNCTION','add-func':'TAMBAH FUNC',apikeys:'API KEYS',maintenance:'MAINTENANCE',backup:'BACKUP',users:'USER & ROLE',settings:'SETELAN',logout:'SAMPAI JUMPA!',_welcome:'SELAMAT DATANG!',_registered:'AKUN JADI!'};
  var HL=['EXTRA! EXTRA!<br>UI BARU TERBIT!','BREAKING NEWS!<br>TAMPILAN BARU!','HOT NEWS!<br>HALAMAN BARU!'];
  var BL='<g transform="translate(26 22)"><path d="M0 -2.5L38 1L0 4Z" fill="#e4eaf0" stroke="#16110f" stroke-width="2.4" stroke-linejoin="round"/><path d="M0 0L-9 -4" stroke="#16110f" stroke-width="4.5" stroke-linecap="round"/><circle cx="-15" cy="-6" r="6.5" fill="#ff5148" stroke="#16110f" stroke-width="3"/></g>';
  function nesc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
  function newsTitle(dest){var p=String(dest||location.pathname).split('?')[0].split('/').filter(Boolean);return NT[p[1]||'']||'UPDATE!'}
  function newsHTML(t){
    var ds='';try{ds=new Date().toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'short',year:'numeric'})}catch(e){}
    var n=t.length,fs=n<=8?60:n<=11?50:n<=14?40:32;
    return '<div class="news-dim"></div><div class="news-paper"><div class="np-mast">THE WA-API TIMES</div>'
      +'<div class="np-date"><span>'+nesc(ds)+'</span><span>EDISI SPESIAL</span><span>HARGA: GRATIS</span></div>'
      +'<div class="np-hl">'+HL[(R()*HL.length)|0]+'</div><div class="np-hole"></div>'
      +'<div class="np-clip" style="--tf:'+fs+'px"><span class="npc-tag">BERITA UTAMA</span><b class="npc-t">'+nesc(t)+'</b><span class="npc-sub">UI BARU TERBIT!</span><span class="npc-ui"><i></i><i></i><i></i></span></div>'
      +'<div class="np-cols"><i></i><i></i><i></i></div>'
      +'<svg class="np-cut" viewBox="0 0 520 600"><rect class="np-cutrect" pathLength="100"/></svg>'
      +'<div class="np-sc"><svg class="sa" viewBox="0 0 64 44">'+BL+'</svg><svg class="sb" viewBox="0 0 64 44">'+BL+'</svg></div></div>';
  }
  function sfxSnip(){burstN('highpass',3500,.05,.45);tone('triangle',2600,1700,.05,.22)}
  function sfxZoomUp(){whoosh(true,.65,.95);tone('sine',180,900,.55,.28)}
  function nA(el,kf,o){var a=el.animate(kf,o);live.push(a);return a}

  function newsOut(dest,done){
    var title=newsTitle(dest),k=Math.min(VW()*.94/528,VH()*.86/608,1.25),rp=-3+R()*2-1;
    var N=document.createElement('div');N.className='news';N.setAttribute('aria-hidden','true');N.innerHTML=newsHTML(title);document.body.appendChild(N);
    var dim=N.querySelector('.news-dim'),paper=N.querySelector('.news-paper'),clip=N.querySelector('.np-clip'),
        rect=N.querySelector('.np-cutrect'),sc=N.querySelector('.np-sc');
    var base='scale('+k+') rotate('+rp+'deg)';
    paper.style.transform=base;sc.style.opacity='0';
    nA(dim,[{opacity:0},{opacity:1}],{duration:260/SPD});
    whoosh(true,.55,.8);later(300,function(){tone('triangle',520,300,.2,.3)});
    var a1=nA(paper,[{transform:'scale(0) rotate(-720deg)',opacity:0},{transform:base,opacity:1}],{duration:700/SPD,easing:'cubic-bezier(.2,.9,.3,1.1)'});
    a1.onfinish=function(){thump(.7,130);later(280,cut)};

    function cut(){
      var cl=clip.offsetLeft,ct=clip.offsetTop,cw=clip.offsetWidth,ch=clip.offsetHeight;
      rect.setAttribute('x',cl);rect.setAttribute('y',ct);rect.setAttribute('width',cw);rect.setAttribute('height',ch);
      var per=2*(cw+ch),f1=cw/per,f2=(cw+ch)/per,f3=(2*cw+ch)/per,e=.025,x0=cl,y0=ct,x1=cl+cw,y1=ct+ch;
      function pt(x,y,r,o){return {transform:'translate('+(x-26)+'px,'+(y-22)+'px) rotate('+r+'deg)',offset:o}}
      sc.style.opacity='1';
      var T=1000;
      var sa=nA(sc,[pt(x0,y0,0,0),pt(x1,y0,0,f1),pt(x1,y0,90,f1+e),pt(x1,y1,90,f2),pt(x1,y1,180,f2+e),pt(x0,y1,180,f3),pt(x0,y1,270,f3+e),pt(x0,y0,270,1)],{duration:T/SPD,easing:'linear',fill:'forwards'});
      nA(rect,[{strokeDashoffset:100},{strokeDashoffset:0}],{duration:T/SPD,easing:'linear',fill:'forwards'});
      var iv=setInterval(sfxSnip,130/SPD);
      sa.onfinish=function(){clearInterval(iv);sfxSnip();drop()};
    }
    function drop(){
      nA(sc,[{opacity:1},{opacity:0}],{duration:200/SPD,fill:'forwards'});
      zap(.35);
      var cw=clip.offsetWidth,ch=clip.offsetHeight,br=clip.getBoundingClientRect(),cx=br.left+br.width/2,cy=br.top+br.height/2;
      var f=clip.cloneNode(true);f.className='np-clip np-fly';f.style.cssText='width:'+cw+'px;height:'+ch+'px;--tf:'+clip.style.getPropertyValue('--tf');
      N.appendChild(f);clip.style.visibility='hidden';
      var tx=cx-cw/2,ty=cy-ch/2,S=Math.max(VW()/cw,VH()/ch)*1.08;
      var s0='translate('+tx+'px,'+ty+'px) scale('+k+') rotate('+rp+'deg)';
      var s1='translate('+tx+'px,'+(ty-18)+'px) scale('+(k*1.07)+') rotate('+(rp-4)+'deg)';
      var s2='translate('+(VW()/2-cw/2)+'px,'+(VH()/2-ch/2)+'px) scale('+S+') rotate(0deg)';
      f.style.transform=s2;
      var l=nA(f,[{transform:s0},{transform:s1}],{duration:300/SPD,easing:'ease-out',fill:'forwards'});
      thump(.5,170);
      l.onfinish=function(){
        sfxZoomUp();
        nA(paper,[{opacity:1,transform:base},{opacity:0,transform:'scale('+(k*2.4)+') rotate('+(rp*2)+'deg)'}],{duration:620/SPD,easing:'ease-in',fill:'forwards'});
        [].forEach.call(f.querySelectorAll('.npc-tag,.npc-ui,.npc-sub'),function(el){nA(el,[{opacity:1},{opacity:0}],{duration:420/SPD,fill:'forwards'})});
        var z=nA(f,[{transform:s1},{transform:s2}],{duration:720/SPD,easing:'cubic-bezier(.7,0,.25,1)',fill:'forwards'});
        z.onfinish=function(){done()};
      };
    }
  }

  /* halaman baru: yang tadi di-zoom pecah, UI baru muncul */
  function newsReveal(title,cb){
    var N=document.createElement('div');N.className='news news-in';N.setAttribute('aria-hidden','true');
    N.innerHTML='<div class="ni-bg"><div class="ni-rays"></div><b class="ni-t">'+nesc(title||'WA-API!')+'</b></div>';
    document.body.appendChild(N);
    var old=document.querySelectorAll('.news:not(.news-in)');for(var i=0;i<old.length;i++)old[i].remove();
    root.classList.remove('news-pending');
    var bg=N.firstChild,tt=bg.querySelector('.ni-t'),pg=document.querySelector('.wrap,.login-wrap'),ended=false;
    if(pg)nA(pg,[{transform:'scale(.88)',opacity:.3},{transform:'none',opacity:1}],{duration:800/SPD,delay:140/SPD,easing:'cubic-bezier(.2,.9,.3,1)',fill:'backwards'});
    nA(tt,[{transform:'rotate(-2deg) scale(1)'},{transform:'rotate(-2deg) scale(1.12)',offset:.3},{transform:'rotate(2deg) scale(3)'}],{duration:760/SPD,delay:120/SPD,easing:'ease-in',fill:'forwards'});
    var a=nA(bg,[{opacity:1,transform:'scale(1)'},{opacity:1,offset:.3},{opacity:0,transform:'scale(1.8)'}],{duration:760/SPD,delay:120/SPD,easing:'ease-in',fill:'forwards'});
    whoosh(false,.55,.7);later(420,function(){ding(.4)});
    function fin(){if(ended)return;ended=true;N.remove();if(cb)cb()}
    a.onfinish=fin;setTimeout(fin,1800/SPD);
  }

  /* ── Keluar: semua elemen berpencar (atau ditembak) ── */
  function runOut(items,ctx,ox,oy,done){
    var ps=[];
    function after(){try{Promise.all(ps).then(function(){done(items)},function(){done(items)})}catch(e){done(items)}}
    function outAll(){items.forEach(function(o){var a=play(o,ctx,'out',0);live.push(a);ps.push(a.finished)})}
    if(STYLE==='gunshot'){gunLeave(ox,oy,outAll,after)}
    else{outAll();fxOut(ox,oy);after()}
  }
  function leave(ox,oy,done){
    var items=collect(true),ctx={x:ox,y:oy};
    if(!items.length){done([]);return}
    root.classList.add('pfx');
    items.forEach(function(o,i){o.i=i;o.key=keyOf(o,ctx)});
    runOut(items,ctx,ox,oy,done);
  }
  function go(ox,oy,fn,dest){
    if(busy)return;busy=true;
    var fired=false;
    function fin(){if(fired)return;fired=true;fn()}
    if(STYLE==='koran'){
      try{newsOut(dest,function(){try{sessionStorage.setItem('newsIn',newsTitle(dest))}catch(e){}fin()})}catch(e){fin()}
      setTimeout(fin,4200/SPD);
      setTimeout(function(){if(document.querySelector('.news'))restore()},9000);
      return;
    }
    try{root.classList.add('leaving');leave(ox,oy,fin)}catch(e){fin()}
    setTimeout(fin,(1100+260*STG)/SPD+500);
    setTimeout(function(){if(root.classList.contains('leaving'))restore()},9000);
  }

  /* ── Coba gaya langsung di halaman ini (tanpa pindah halaman) ── */
  function preview(style,ox,oy){
    if(busy||root.classList.contains('fx-off'))return;
    if(style==='koran'){
      var pk=STYLE;STYLE='koran';busy=true;
      try{newsOut('/panel/settings',function(){newsReveal('SETELAN',function(){busy=false;STYLE=pk})})}catch(e){busy=false;STYLE=pk;restore()}
      return;
    }
    var prev=STYLE;STYLE=style;busy=true;
    var items=collect(true),ctx={x:ox,y:oy};
    function fin(){root.classList.remove('pfx');busy=false;STYLE=prev}
    if(!items.length){fin();return}
    root.classList.add('pfx');
    items.forEach(function(o,i){o.i=i;o.key=keyOf(o,ctx)});
    runOut(items,ctx,ox,oy,function(){
      live.forEach(function(a){try{a.cancel()}catch(e){}});live=[];
      var c2=style==='gunshot'?ctx:{x:VW()/2,y:VH()/2},ps=[];
      items.forEach(function(o){o.key=keyOf(o,c2)});
      items.forEach(function(o){ps.push(play(o,c2,'in',0).finished)});
      fxIn();gunClear();
      try{Promise.all(ps).then(fin,fin)}catch(e){fin()}
      setTimeout(fin,(1800+380*STG)/SPD);
    });
  }
  window.__waPreview=preview;

  /* ── Masuk: elemen baru menyusun diri ── */
  function countUp(items){
    items.forEach(function(o){
      if(!o.el.classList.contains('stat'))return;
      var v=o.el.querySelector('.stat-val[data-n]');if(!v)return;
      var n=+v.dataset.n;if(!n)return;
      v.textContent='0';
      setTimeout(function(){
        var t0=performance.now();
        (function f(t){var p=Math.min(1,(t-t0)/(800/SPD));v.textContent=Math.round(n*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(f)})(t0);
      },o.delay+150/SPD);
    });
  }
  function enter(){
    if(STYLE==='koran')return;
    if(document.querySelector('.login-wrap'))return;
    var hi=root.classList.contains('has-intro');
    var base=hi?(parseFloat(cs.getPropertyValue('--ie'))||0)*1000/SPD:0;
    var gs=STYLE==='gunshot'?gunEnter():null;
    if(hi)gs=null;
    var ctx=gs?{x:gs.ox,y:gs.oy}:{x:VW()/2,y:VH()/2},items=collect(!hi),ps=[];
    if(!items.length&&!gs)return;
    root.classList.add('pfx');
    items.forEach(function(o,i){o.i=i;o.key=keyOf(o,ctx)});
    items.forEach(function(o){ps.push(play(o,ctx,'in',base*SPD).finished)});
    countUp(items);
    if(gs)gunArrive(gs);
    var ended=false;
    function end(){if(ended)return;ended=true;root.classList.remove('pfx')}
    try{Promise.all(ps).then(end,end)}catch(e){end()}
    setTimeout(end,base+(1100+380*STG)/SPD+400);
    setTimeout(fxIn,base);
  }

  /* ── Muncul saat digulir: yang di bawah disembunyikan dulu, dan tidak dirender kalau di luar layar ── */
  function revealBlock(b){
    var kids=[].slice.call(b.querySelectorAll('.card-title,.stat,.kv,.toggle-row,.key-box,.chips>*,.alert,.form-group,.bar,.btn-group>*,tbody tr')).slice(0,40);
    function an(el,i,big){
      try{el.animate([{opacity:0,transform:'perspective(700px) rotateX('+(big?-16:-38)+'deg) translateY('+(big?46:30)+'px) scale(.94)'},{opacity:1,transform:'none'}],{duration:560/SPD,delay:Math.min(i*55*STG,520)/SPD,easing:'cubic-bezier(.2,1.25,.4,1)',fill:'backwards'})}catch(e){}
    }
    an(b,0,true);kids.forEach(function(k,i){an(k,i+1,false)});
  }
  function setupReveal(anim){
    var blocks=[].slice.call(document.querySelectorAll('.content>.card:not(.hero),.content>.stats,.content>.btn-group'));
    if(!blocks.length)return;
    var vh=VH(),cvOK=window.CSS&&CSS.supports&&CSS.supports('content-visibility','auto');
    blocks.forEach(function(b){
      var r=b.getBoundingClientRect(),below=r.top>vh*.92;
      if(cvOK&&below){b.style.containIntrinsicSize='auto '+Math.round(r.height)+'px';b.classList.add('cv')}
      b._rv=1;
      if(anim&&below){b.classList.add('rv-hide');b._rv=0}
    });
    if(!anim||!('IntersectionObserver' in window))return;
    var io=new IntersectionObserver(function(es){
      es.forEach(function(en){
        var b=en.target;
        if(en.isIntersecting){if(!b._rv){b._rv=1;b.classList.remove('rv-hide');revealBlock(b)}}
        else if(b._rv&&!root.classList.contains('pfx')){b._rv=0;b.classList.add('rv-hide')}
      });
    },{rootMargin:'0px 0px -8% 0px',threshold:0});
    blocks.forEach(function(b){io.observe(b)});
  }

  /* ── Tombol SFX ── */
  var sb=document.getElementById('sfxBtn');
  if(sb)sb.addEventListener('click',function(){
    var nx=root.dataset.sfx==='off'?'on':'off';root.dataset.sfx=nx;
    try{
      if(root.hasAttribute('data-visitor'))localStorage.setItem('wa-sfx',nx);
      else fetch('/panel/settings/sfx',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({sfx:nx==='on'})});
    }catch(e){}
    if(nx==='on')ding(.5);
  });

  addEventListener('pageshow',function(e){if(e.persisted)restore()});
  try{setupReveal(!OFF)}catch(e){}
  if(OFF){root.classList.remove('news-pending');return}

  /* ── Login: UI login berpencar dulu, baru intro di dashboard ── */
  var lf=document.getElementById('loginForm')||document.getElementById('registerForm');
  if(lf)lf.addEventListener('submit',function(e){
    e.preventDefault();e.stopPropagation();
    if(busy)return;
    var btn=lf.querySelector('button[type=submit]'),b=btn.getBoundingClientRect(),ox=b.left+b.width/2,oy=b.top+b.height/2;
    function showErr(msg){
      var box=lf.closest('.login-box'),al=box.querySelector('.alert-danger');
      if(!al){al=document.createElement('div');al.className='alert alert-danger';al.innerHTML='<span></span>';lf.parentNode.insertBefore(al,lf)}
      al.querySelector('span').textContent=msg;
      box.classList.remove('shake');void box.offsetWidth;box.classList.add('shake');zap(.4);
    }
    fetch(lf.action,{method:'POST',body:new URLSearchParams(new FormData(lf)),credentials:'same-origin',redirect:'manual'}).then(function(r){
      if(r.type==='opaqueredirect'||r.redirected){go(ox,oy,function(){location.href='/panel/dashboard?welcome=1'},lf.id==='registerForm'?'/panel/_registered':'/panel/_welcome');return}
      return r.text().then(function(h){
        var d=new DOMParser().parseFromString(h,'text/html'),al=d.querySelector('.alert-danger span');
        var nc=d.querySelector('.captcha-box'),oc=lf.querySelector('.captcha-box');if(nc&&oc)oc.innerHTML=nc.innerHTML;
        showErr(al?al.textContent:'Gagal masuk, coba lagi.');
      });
    }).catch(function(){HTMLFormElement.prototype.submit.call(lf)});
  });

  document.addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    var a=e.target.closest&&e.target.closest('a[href]');
    if(!a||a.target||a.hasAttribute('download'))return;
    var u;try{u=new URL(a.href,location.href)}catch(_){return}
    if(u.origin!==location.origin||u.pathname.indexOf('/panel')!==0)return;
    if(u.pathname.indexOf('/panel/backup/download')===0)return;
    if(u.pathname===location.pathname&&u.search===location.search)return;
    var ox=e.clientX,oy=e.clientY;
    if(!ox&&!oy){var b=a.getBoundingClientRect();ox=b.left+b.width/2;oy=b.top+b.height/2}
    e.preventDefault();go(ox,oy,function(){location.href=u.href},u.pathname);
  });
  document.addEventListener('submit',function(e){
    if(e.defaultPrevented)return;
    var f=e.target;if(!(f instanceof HTMLFormElement)||f.target)return;
    var sbm=e.submitter||f,b=sbm.getBoundingClientRect();
    e.preventDefault();go(b.left+b.width/2,b.top+b.height/2,function(){HTMLFormElement.prototype.submit.call(f)},location.pathname);
  });
  if(NP){try{newsReveal(NI||'WA-API!',null)}catch(e){root.classList.remove('news-pending')}}
  try{enter()}catch(e){root.classList.remove('pfx')}
})();
`

// tombol ganti tema (auto -> terang -> gelap). Visitor hanya menyimpan di perangkatnya.
const THEME_JS = `
(function(){
  var b=document.getElementById('themeBtn');if(!b)return;
  var h=document.documentElement,order=['auto','light','dark'];
  function meta(m){
    var dark=m==='dark'||(m==='auto'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach(function(x,i){if(i){x.remove()}else{x.removeAttribute('media');x.content=dark?'#1d1a2e':'#fffdf5'}});
  }
  b.addEventListener('click',function(){
    var nx=order[(order.indexOf(h.dataset.theme||'auto')+1)%3];
    h.dataset.theme=nx;meta(nx);
    try{
      if(h.hasAttribute('data-visitor'))localStorage.setItem('wa-theme',nx);
      else fetch('/panel/settings/theme',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:nx})});
    }catch(e){}
  });
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
    const user = curUser()
    const anim = getAnim()
    const nav  = NAV.map(([label, items]) => [label, items.filter(it => !it[3] || can(user, it[3]))]).filter(([, items]) => items.length)
        .map(([label, items]) => `
      <div class="nav-label">${label}</div>
      ${items.map(([id, icon, text]) => `<a class="nav-item${activeNav === id ? ' active' : ''}" href="/panel/${id}">${ic(icon, 20)}${text}</a>`).join('')}`).join('')
    const bItems = BOTTOM.filter(b => !b[3] || can(user, b[3]))
    const bAct   = BOTTOM_MAP[activeNav] || activeNav
    const cur    = bItems.find(b => b[0] === bAct)
    const ieM    = /data-ie="([\d.]+)"/.exec(extra)
    const hc     = [htmlClass(ui), ieM ? 'has-intro' : ''].filter(Boolean).join(' ')
    const hs     = `--stagger:${ui.stagger}ms;--spd:${ui.speed}` + (ieM ? `;--ie:${ieM[1]}s` : '')
    const who    = user ? `${esc(user.username)} · ${esc((ROLES[user.role] || {}).label || user.role)}` : 'Panel Online'
    const visitor = user && user.role === 'visitor'
    return `<!DOCTYPE html>
<html lang="id" class="${hc}" style="${hs}" data-theme="${ui.theme}" data-anim="${anim}" data-sfx="${ui.sfx === false ? 'off' : 'on'}"${visitor ? ' data-visitor' : ''}><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
${themeMeta(ui.theme)}
<title>${esc(title)} — WA-API Panel</title>
<link rel="icon" href="${FAVICON}">
<script>try{var h=document.documentElement;if(h.hasAttribute('data-visitor')){var t=localStorage.getItem('wa-theme');if(t==='auto'||t==='light'||t==='dark')h.dataset.theme=t;var q=localStorage.getItem('wa-sfx');if(q==='on'||q==='off')h.dataset.sfx=q}}catch(e){}</script>
${NEWS_HEAD}
${FONTS}
<style>${CSS}${CSS_EXTRA}</style>
</head><body>
<div class="bgfx" aria-hidden="true">${cube(56)}${cube(40)}${cube(66)}</div>
<div class="wrap">
  <nav class="sidebar" id="sidebar">
    <div class="logo">
      <svg class="logo-mark" viewBox="0 0 100 100" aria-hidden="true"><polygon points="${burstPts()}" fill="#ffd93d" stroke="#16110f" stroke-width="6" stroke-linejoin="round"/><path d="M52 24L34 54h14l-3 22 22-34H53z" fill="#ff5148" stroke="#16110f" stroke-width="4" stroke-linejoin="round"/></svg>
      <div><b>WA-API!</b><small>MAKLOWHH Admin</small></div>
    </div>
    <div class="nav">${nav}</div>
    <div class="side-foot"><button class="btn btn-ghost btn-sm cm-side" type="button" data-cm-open>${ic('chat', 17)}Contact Us</button><div class="pill"><i class="bd"></i><span>${who}</span></div></div>
  </nav>
  <div class="main">
    <div class="topbar">
      <h1>${esc(title)}</h1>
      <div class="top-right">
        <span id="clk"></span>
        <button class="btn btn-ghost btn-sm cm-top" type="button" data-cm-open title="Contact Us" aria-label="Contact Us">${ic('chat', 17)}</button>
        <button class="btn btn-ghost btn-sm" id="themeBtn" type="button" title="Tema: ikuti perangkat, terang, atau gelap (klik untuk ganti)" aria-label="Ganti tema">${themeIcons()}</button>
        <button class="btn btn-ghost btn-sm" id="sfxBtn" type="button" title="Suara efek: nyala atau mati" aria-label="Suara efek">${sfxIcons()}</button>
        <a href="/panel/logout" class="btn btn-ghost btn-sm">${ic('logout', 17)}Keluar</a>
      </div>
    </div>
    <div class="content">${body}</div>
  </div>
</div>
<nav class="bottomnav" id="bnav" aria-label="Navigasi utama">
  <div class="bn-shape"><div class="bn-ink"></div><div class="bn-bar"></div></div>
  <div class="bn-bubble">${ic(cur ? cur[1] : 'dashboard', 26)}</div>
  <div class="bn-list">${bItems.map(([id, icon, text]) => `<a class="bn-item${bAct === id ? ' active' : ''}" href="/panel/${id}" aria-label="${text}">${ic(icon, 24)}<span>${text}</span></a>`).join('')}</div>
</nav>
<svg class="waitburst" viewBox="0 0 100 100" aria-hidden="true"><polygon points="${burstPts(10, 47, 30)}" fill="#ffd93d" stroke="#16110f" stroke-width="6" stroke-linejoin="round"/></svg>
<script>${OB(BNAV_JS)}</script>
${contactModal()}
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
(function clk(){var el=document.getElementById('clk');if(el)el.textContent=new Date().toLocaleTimeString('id-ID');setTimeout(clk,1000)})();
${OB(TILT_JS)}${OB(FX_JS)}${OB(ROUTER_JS)}${OB(THEME_JS)}
</script>
<script>${OB(CONTACT_JS)}</script>
${shieldTag()}
</body></html>`
}

// ── Ikon tambahan ─────────────────────────────────────────────────────────────
Object.assign(ICONS, {
    chat:    '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    eye:     '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff:  '<path d="M3 3l18 18M10.6 6.2A9.7 9.7 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.1 7.6A16 16 0 0 0 2 12s4 6 10 6a9.6 9.6 0 0 0 3.4-.6"/>',
    send:    '<path d="M21 3L2 11l7 3 3 7z"/><path d="M9 14L21 3"/>',
    ext:     '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
    phone:   '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    mega:    '<path d="M3 10v4l11 5V5z"/><path d="M14 8a4 4 0 0 1 0 8M6 14l1 5h3"/>',
})

const CSS_EXTRA = `
/* ── Judul halaman: stiker komik 3D ── */
.topbar h1{position:relative;display:inline-block;isolation:isolate;margin-left:14px;padding:6px 4px 3px;font-size:34px;line-height:1.02;letter-spacing:2.5px;text-transform:uppercase;color:#fff;-webkit-text-stroke:3px var(--ink);paint-order:stroke fill;text-shadow:3px 3px 0 var(--ink),4px 5px 0 var(--ink);transform:rotate(-1.5deg)}
.topbar h1::before{content:'';position:absolute;z-index:-1;inset:-4px -16px -6px -16px;background-color:var(--yellow);background-image:radial-gradient(rgba(22,17,15,.24) 1.4px,transparent 1.8px);background-size:9px 9px;border:3px solid var(--ink);border-radius:8px;transform:skewX(-9deg);box-shadow:4px 4px 0 var(--ink)}
.cm-side{width:100%;margin-bottom:10px}
.cm-top{display:none}

/* ── Transisi koran ── */
html.news-pending{background:#ffd93d}
html.news-pending body{visibility:hidden}
.news{position:fixed;inset:0;z-index:2000;overflow:hidden;visibility:visible;cursor:progress}
.news-dim{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%,rgba(22,17,15,.5),rgba(8,6,14,.93))}
.news-paper{position:absolute;left:50%;top:50%;translate:-50% -50%;width:528px;height:608px;background-color:#f3ead0;background-image:radial-gradient(rgba(22,17,15,.09) 1px,transparent 1.5px),linear-gradient(115deg,rgba(255,255,255,.4),rgba(120,90,30,.14));background-size:5px 5px,100% 100%;border:4px solid #16110f;box-shadow:12px 14px 0 #16110f;color:#16110f;overflow:hidden;font-family:var(--body)}
.np-mast{position:absolute;left:18px;right:18px;top:12px;height:70px;text-align:center;border-bottom:5px double #16110f;font-family:var(--head);font-size:46px;letter-spacing:4px;line-height:62px;white-space:nowrap}
.np-date{position:absolute;left:18px;right:18px;top:88px;height:22px;display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;border-bottom:2px solid #16110f}
.np-hl{position:absolute;left:18px;right:18px;top:118px;height:104px;display:flex;align-items:center;justify-content:center;text-align:center;font-family:var(--head);font-size:44px;line-height:1.02;letter-spacing:2px;color:#d63a31;-webkit-text-stroke:1.5px #16110f;paint-order:stroke fill;text-shadow:3px 3px 0 #16110f}
.np-hole,.np-clip{position:absolute;left:26px;right:26px;top:236px;height:196px}
.np-hole{background:#c9bd96;box-shadow:inset 5px 6px 0 rgba(22,17,15,.35)}
.np-clip{background-color:#ffd93d;background-image:radial-gradient(rgba(22,17,15,.2) 1.6px,transparent 2px);background-size:12px 12px;border:3px dashed #16110f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;overflow:hidden}
.npc-tag{position:absolute;left:10px;top:8px;background:#16110f;color:#ffd93d;font-family:var(--head);font-size:14px;letter-spacing:2px;padding:1px 8px;transform:rotate(-3deg)}
.npc-t{font-family:var(--head);font-weight:400;font-size:var(--tf,56px);line-height:1;letter-spacing:2px;color:#fff;-webkit-text-stroke:3px #16110f;paint-order:stroke fill;text-shadow:4px 4px 0 #16110f;text-align:center;padding:0 10px}
.npc-sub{font-family:var(--head);font-size:18px;letter-spacing:3px;background:#16110f;color:#ffd93d;padding:0 12px;transform:rotate(-1.5deg)}
.npc-ui{position:absolute;right:10px;bottom:8px;display:flex;gap:5px}
.npc-ui i{width:22px;height:16px;border:2px solid #16110f;background:#ff7ac6;border-radius:3px}
.npc-ui i:nth-child(2){background:#3d8bff}.npc-ui i:nth-child(3){background:#3ddc84}
.np-cols{position:absolute;left:18px;right:18px;top:450px;bottom:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.np-cols i{background:repeating-linear-gradient(#16110f 0 2px,transparent 2px 7px);opacity:.5}
.np-cut{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.np-cutrect{fill:none;stroke:#ff5148;stroke-width:4;stroke-dasharray:100;stroke-dashoffset:100}
.np-sc{position:absolute;left:0;top:0;width:64px;height:44px;transform-origin:26px 22px;pointer-events:none;filter:drop-shadow(2px 3px 0 rgba(22,17,15,.45))}
.np-sc svg{position:absolute;left:0;top:0;width:64px;height:44px;transform-origin:26px 22px;overflow:visible}
.np-sc .sa{animation:snipA .16s ease-in-out infinite alternate}
.np-sc .sb{animation:snipB .16s ease-in-out infinite alternate}
@keyframes snipA{from{transform:rotate(-11deg)}to{transform:rotate(3deg)}}
@keyframes snipB{from{transform:rotate(11deg)}to{transform:rotate(-3deg)}}
.np-fly{right:auto;top:0;left:0;margin:0;border-style:solid;box-shadow:6px 8px 0 #16110f;z-index:3;transform-origin:50% 50%}
.news-in .ni-bg{position:absolute;inset:0;background-color:#ffd93d;background-image:radial-gradient(rgba(22,17,15,.22) 2px,transparent 2.5px);background-size:16px 16px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.ni-rays{position:absolute;left:50%;top:50%;width:200vmax;height:200vmax;margin:-100vmax 0 0 -100vmax;background:repeating-conic-gradient(rgba(255,255,255,.5) 0 5deg,transparent 5deg 10deg);animation:apSpin 6s linear infinite}
.ni-t{position:relative;font-family:var(--head);font-weight:400;font-size:clamp(46px,13vw,110px);letter-spacing:3px;color:#fff;-webkit-text-stroke:4px #16110f;paint-order:stroke fill;text-shadow:7px 7px 0 #16110f;text-align:center;line-height:1;padding:0 16px;transform:rotate(-2deg)}
.mini[data-s="koran"] i{display:none}
.mini[data-s="koran"]::before{content:'EXTRA!';position:absolute;left:8%;top:12%;width:50%;height:76%;background:#f3ead0;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);display:flex;justify-content:center;padding-top:4px;font-family:var(--head);font-size:20px;letter-spacing:1px;color:var(--red);transform:rotate(-5deg)}
.mini[data-s="koran"]::after{content:'';position:absolute;right:9%;top:30%;width:32%;height:44%;background:var(--yellow);border:3px dashed var(--ink)}
.sty-card.on .mini[data-s="koran"]::after,.sty-card:hover .mini[data-s="koran"]::after{animation:mKoran 2.6s infinite}
@keyframes mKoran{0%,30%{transform:none;opacity:1}65%{transform:scale(1.25) rotate(5deg);opacity:1}100%{transform:scale(3);opacity:0}}

/* ── Login & register ── */
.login-wrap.ap{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);padding:0;align-items:stretch;perspective:none}
.ap-poster{position:relative;overflow:hidden;background-color:var(--yellow);background-image:radial-gradient(rgba(22,17,15,.2) 2px,transparent 2.5px);background-size:16px 16px;border-right:5px solid var(--ink);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:44px 28px;color:var(--on)}
.ap-poster>*{position:relative}
.ap-poster>.ap-rays{position:absolute;left:50%;top:46%;width:240vmax;height:240vmax;margin:-120vmax 0 0 -120vmax;background:repeating-conic-gradient(rgba(255,255,255,.42) 0 6deg,transparent 6deg 12deg);animation:apSpin 50s linear infinite;pointer-events:none}
@keyframes apSpin{to{transform:rotate(360deg)}}
.ap-hero{display:flex;align-items:center;justify-content:center}
.ap-hero .scene{margin:0}
.ap-pow{position:absolute;right:-84px;top:-34px;width:100px;transform:rotate(12deg);filter:drop-shadow(4px 4px 0 var(--ink));animation:bob 2.6s ease-in-out infinite}
.ap-title{font-family:var(--head);font-weight:400;font-size:clamp(54px,8vw,104px);line-height:.95;letter-spacing:3px;color:#fff;-webkit-text-stroke:4px var(--ink);paint-order:stroke fill;text-shadow:6px 6px 0 var(--ink);transform:rotate(-3deg);text-align:center}
.ap-tag{max-width:380px;text-align:center;font-weight:900;font-size:16px;background:#fff;color:var(--on);border:3px solid var(--ink);border-radius:12px;padding:10px 14px;box-shadow:5px 5px 0 var(--ink);transform:rotate(1.5deg)}
.ap-stick{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.ap-stick b{font-family:var(--head);font-weight:400;font-size:20px;letter-spacing:1.5px;padding:2px 14px;border:3px solid var(--ink);border-radius:30px;box-shadow:3px 3px 0 var(--ink);color:var(--on)}
.ap-stick b:nth-child(1){background:var(--pink);transform:rotate(-4deg)}
.ap-stick b:nth-child(2){background:var(--green);transform:rotate(3deg)}
.ap-stick b:nth-child(3){background:var(--blue);color:#fff;transform:rotate(-2deg)}
.ap-poster>.ap-tape{position:absolute;left:-8%;width:116%;background:var(--ink);color:var(--yellow);font-family:var(--head);font-size:20px;letter-spacing:4px;padding:3px 0;overflow:hidden;white-space:nowrap}
.ap-tape.t1{top:7%;transform:rotate(-5deg)}
.ap-tape.t2{bottom:8%;transform:rotate(4deg);background:var(--red)!important;color:#fff!important}
.ap-tape span{display:inline-block;animation:apTape 22s linear infinite}
.ap-tape.t2 span{animation-direction:reverse}
@keyframes apTape{to{transform:translateX(-50%)}}
.ap-side{display:flex;align-items:center;justify-content:center;padding:28px 22px;perspective:1000px}
.ap-card{max-width:430px;padding:22px 24px 24px}
.ap-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 18px;padding:5px;background:var(--hover);border:3px solid var(--ink);border-radius:14px}
.ap-tab{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 8px;border:2px solid transparent;border-radius:9px;font-family:var(--head);font-size:21px;letter-spacing:1.5px;font-weight:400;color:var(--fg);text-decoration:none}
.ap-tab.on{background:var(--pink);color:var(--on);border-color:var(--ink);box-shadow:0 3px 0 var(--ink)}
.ap-card h1{font-size:38px;text-align:center;line-height:1;margin-bottom:6px;color:#fff;-webkit-text-stroke:3px var(--ink);paint-order:stroke fill;text-shadow:3px 4px 0 var(--ink)}
.pw-wrap{position:relative}
.pw-wrap .form-input{padding-right:48px}
.pw-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:2px solid var(--ink);border-radius:8px;background:var(--yellow);color:var(--on);cursor:pointer}
.pw-eye .eo{display:none}.pw-eye.on .ei{display:none}.pw-eye.on .eo{display:block}
.cap-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.cap-img{display:block;height:56px;width:auto;max-width:calc(100% - 54px);border:3px solid var(--ink);border-radius:10px;background:#fff6c8;box-shadow:3px 3px 0 var(--ink);user-select:none;-webkit-user-drag:none}
.cap-refresh{width:44px;height:44px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:3px solid var(--ink);border-radius:12px;background:var(--blue);color:#fff;cursor:pointer;box-shadow:0 4px 0 var(--ink)}
.cap-refresh:active{transform:translateY(3px);box-shadow:none}
.cap-refresh.spin .ic{animation:apSpin .5s linear}
.cap-in{text-transform:uppercase;letter-spacing:4px;font-family:'Courier New',monospace;font-size:18px;text-align:center}
.ap-btns{display:flex;gap:10px;margin-top:16px}
.ap-btns .btn{flex:1}
.ap-alt{text-align:center;margin-top:14px;font-size:13px;color:var(--muted)}
@media(max-width:860px){
  .login-wrap.ap{grid-template-columns:1fr}
  .ap-poster{padding:30px 18px 52px;border-right:none;border-bottom:5px solid var(--ink);gap:6px}
  .ap-tag,.ap-stick,.ap-tape.t2{display:none}
  .ap-title{font-size:56px}
  .ap-hero{transform:scale(.7);margin:-14px 0}
  .ap-pow{width:70px;right:-56px;top:-22px}
  .ap-side{padding:0 14px 28px;margin-top:-30px}
}

/* ── Contact Us ── */
.cmodal{position:fixed;inset:0;z-index:260;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(10,8,16,.72);perspective:900px}
.cmodal.open{display:flex}
.cmodal.open .cm-box{animation:pop .35s cubic-bezier(.2,1.3,.4,1)}
.cm-box{position:relative;width:100%;max-width:460px;max-height:92vh;overflow:auto;background:var(--panel);color:var(--fg);border:4px solid var(--ink);border-radius:16px;box-shadow:8px 8px 0 var(--ink);padding:20px}
.cm-title{font-family:var(--head);font-size:34px;letter-spacing:2px;line-height:1;margin-bottom:14px;color:var(--red);text-shadow:2px 2px 0 var(--ink)}
.cm-x{position:absolute;right:12px;top:12px;width:36px;height:36px;border:3px solid var(--ink);border-radius:10px;background:var(--red);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 3px 0 var(--ink)}
.cm-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:5px;margin-bottom:14px;background:var(--hover);border:3px solid var(--ink);border-radius:14px}
.cm-tab{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px;border:2px solid transparent;border-radius:9px;background:transparent;color:var(--fg);font-family:var(--head);font-size:20px;letter-spacing:1.5px;cursor:pointer}
.cm-tab.on{background:var(--yellow);color:var(--on);border-color:var(--ink);box-shadow:0 3px 0 var(--ink)}
.cm-pane{display:none}
.cm-pane.on{display:block;animation:flipin .35s cubic-bezier(.2,.9,.3,1.1) backwards}
.cm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px;margin-bottom:12px;border:3px solid var(--ink);border-radius:12px;background:var(--field);box-shadow:var(--shadow-sm)}
.cm-info{flex:1 1 150px;min-width:0}
.cm-info b{display:block;font-family:var(--head);font-weight:400;font-size:19px;letter-spacing:1px}
.cm-val{display:block;font-family:'Courier New',monospace;font-size:13px;word-break:break-all;color:var(--muted)}
.cm-act{display:flex;gap:8px;margin-left:auto}

/* ── Anti-colong (hanya penghalang tampilan) ── */
html.shield body{-webkit-user-select:none;user-select:none}
html.shield input,html.shield textarea,html.shield select,html.shield .allow-copy{-webkit-user-select:text;user-select:text}
html.shield img{-webkit-user-drag:none}

@media(max-width:768px){
  .topbar h1{font-size:23px;letter-spacing:1.5px;margin-left:12px;-webkit-text-stroke:2.5px var(--ink);text-shadow:2px 2px 0 var(--ink),3px 3px 0 var(--ink);max-width:62vw}
  .cm-top{display:inline-flex}
}
`

const AUTH_JS = `
(function(){
  document.addEventListener('click',function(e){
    var t=e.target;if(!t||!t.closest)return;
    var eye=t.closest('.pw-eye');
    if(eye){var inp=eye.parentNode.querySelector('input');if(inp){var s=inp.type==='password';inp.type=s?'text':'password';eye.classList.toggle('on',s)}return}
    var rf=t.closest('.cap-refresh');
    if(rf){
      var box=rf.closest('.captcha-box');if(!box)return;
      rf.classList.remove('spin');void rf.offsetWidth;rf.classList.add('spin');
      fetch('/panel/captcha-new',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
        if(!j||!j.t)return;
        box.querySelector('input[name=ct]').value=j.t;
        box.querySelector('.cap-img').src='/panel/captcha/'+j.t+'.svg';
        var i=box.querySelector('.cap-in');if(i){i.value='';i.focus()}
      }).catch(function(){});
    }
  });
})();
`
const CONTACT_JS = `
(function(){
  var m=document.getElementById('cmodal');if(!m)return;
  var last=null;
  function open(){last=document.activeElement;m.classList.add('open');var c=m.querySelector('.cm-x');if(c)c.focus()}
  function close(){m.classList.remove('open');if(last&&last.focus){try{last.focus()}catch(e){}}}
  function tab(n){
    [].forEach.call(m.querySelectorAll('.cm-tab'),function(b){var on=b.dataset.tab===n;b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false')});
    [].forEach.call(m.querySelectorAll('.cm-pane'),function(p){p.classList.toggle('on',p.dataset.pane===n)});
  }
  function copy(txt,btn){
    function ok(){var o=btn.innerHTML;btn.textContent='Tersalin!';btn.classList.add('btn-mint');setTimeout(function(){btn.innerHTML=o;btn.classList.remove('btn-mint')},1400)}
    function fb(){var ta=document.createElement('textarea');ta.value=txt;ta.setAttribute('readonly','');ta.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');ok()}catch(e){}ta.remove()}
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(txt).then(ok,fb)}else{fb()}
  }
  document.addEventListener('click',function(e){
    var t=e.target;if(!t||!t.closest)return;
    if(t.closest('[data-cm-open]')){e.preventDefault();open();return}
    if(!m.classList.contains('open'))return;
    if(t===m||t.closest('.cm-x')){close();return}
    var tb=t.closest('.cm-tab');if(tb){tab(tb.dataset.tab);return}
    var cp=t.closest('[data-cc]');if(cp){copy(cp.dataset.cc,cp)}
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&m.classList.contains('open'))close()});
})();
`
const SHIELD_JS = `
(function(){
  var h=document.documentElement;h.classList.add('shield');
  function ok(t){return !!(t&&t.closest&&t.closest('input,textarea,select,[contenteditable],.allow-copy'))}
  document.addEventListener('contextmenu',function(e){if(!ok(e.target))e.preventDefault()});
  ['copy','cut'].forEach(function(n){document.addEventListener(n,function(e){if(!ok(document.activeElement)&&!ok(e.target))e.preventDefault()})});
  document.addEventListener('dragstart',function(e){e.preventDefault()});
  document.addEventListener('selectstart',function(e){if(!ok(e.target))e.preventDefault()});
  document.addEventListener('keydown',function(e){
    var k=String(e.key||'').toLowerCase(),c=e.ctrlKey||e.metaKey;
    if(e.key==='F12'||(c&&e.shiftKey&&(k==='i'||k==='j'||k==='c'||k==='k'))||(c&&(k==='u'||k==='s'))||(e.metaKey&&e.altKey&&(k==='i'||k==='u'||k==='j'))){e.preventDefault();e.stopPropagation()}
  },true);
  try{console.log('%cSTOP!','font:900 42px Impact;color:#ff5148;text-shadow:3px 3px #16110f');console.log('Source panel ini dilindungi.')}catch(e){}
})();
`

// dipasang di <head>: kalau halaman ini tujuan transisi koran, sembunyikan dulu sampai overlay siap
const NEWS_HEAD = `<script>try{var d=document.documentElement;if(d.dataset.anim==='koran'&&!d.classList.contains('fx-off')&&!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)){var n=sessionStorage.getItem('newsIn');if(!n&&d.hasAttribute('data-first')&&!sessionStorage.getItem('npFirst')){n='WA-API!';sessionStorage.setItem('npFirst','1');sessionStorage.setItem('newsIn',n)}if(n){d.classList.add('news-pending');setTimeout(function(){d.classList.remove('news-pending')},3000)}}}catch(e){}</script>`

// ── Contact Us (tab WhatsApp & Telegram) ──────────────────────────────────────
const contactRow = (icon, color, label, shown, copyVal, href) =>
    `<div class="cm-row"><span class="ct-icon c-${color}">${ic(icon, 19)}</span><div class="cm-info"><b>${label}</b><span class="cm-val">${esc(shown)}</span></div><div class="cm-act"><button class="btn btn-sm btn-ghost" type="button" data-cc="${esc(copyVal)}">${ic('copy', 16)}Salin</button><a class="btn btn-sm btn-mint" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${ic('ext', 16)}Buka</a></div></div>`

const contactModal = () => `<div class="cmodal" id="cmodal" role="dialog" aria-modal="true" aria-labelledby="cm-title">
  <div class="cm-box">
    <button class="cm-x" type="button" aria-label="Tutup">${ic('boom', 18)}</button>
    <div class="cm-title" id="cm-title">CONTACT US</div>
    <div class="cm-tabs" role="tablist">
      <button class="cm-tab on" type="button" role="tab" data-tab="wa" aria-selected="true">${ic('phone', 17)}WhatsApp</button>
      <button class="cm-tab" type="button" role="tab" data-tab="tg" aria-selected="false">${ic('send', 17)}Telegram</button>
    </div>
    <div class="cm-pane on" data-pane="wa">
      ${contactRow('phone', 'green', 'Nomor WhatsApp', CONTACT.waShown, CONTACT.waNumber, 'https://wa.me/' + CONTACT.waNumber)}
      ${contactRow('mega', 'pink', 'Saluran WhatsApp', CONTACT.waChannel.replace('https://', ''), CONTACT.waChannel, CONTACT.waChannel)}
    </div>
    <div class="cm-pane" data-pane="tg">
      ${contactRow('send', 'blue', 'Telegram', CONTACT.tgShown, CONTACT.tgLink, CONTACT.tgLink)}
    </div>
  </div>
</div>`

const contactBtn = (cls = '') => `<button class="btn btn-ghost ${cls}" type="button" data-cm-open>${ic('chat', 18)}Contact Us</button>`

// ── Captcha ───────────────────────────────────────────────────────────────────
function captchaBox() {
    const t = capNew()
    return `<div class="form-group captcha-box">
  <label class="form-label" for="cv">Captcha</label>
  <div class="cap-row"><img class="cap-img" src="/panel/captcha/${t}.svg" width="190" height="62" alt="Kode captcha" draggable="false"><button class="cap-refresh" type="button" aria-label="Ganti kode captcha" title="Ganti kode">${ic('refresh', 20)}</button></div>
  <input type="hidden" name="ct" value="${t}">
  <input class="form-input cap-in" id="cv" name="cv" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="KETIK KODE" required>
</div>`
}

const pwField = (id, name, label, ac) => `<div class="form-group"><label class="form-label" for="${id}">${label}</label>
  <div class="pw-wrap"><input class="form-input" id="${id}" name="${name}" type="password" autocomplete="${ac}" required><button class="pw-eye" type="button" aria-label="Lihat atau sembunyikan password">${ic('eye', 18).replace('class="ic"', 'class="ic ei"')}${ic('eyeoff', 18).replace('class="ic"', 'class="ic eo"')}</button></div></div>`

// ── Halaman Login & Register ──────────────────────────────────────────────────
function authPage(mode, err = '') {
    const ui     = getUi()
    const reg    = mode === 'register'
    const closed = reg && !regOpen()
    const intro  = (!reg && !err) ? introHTML('WA-API!', 'ADMIN PANEL') : ''
    const ieM    = /data-ie="([\d.]+)"/.exec(intro)
    const hc     = [htmlClass(ui), ieM ? 'has-intro' : ''].filter(Boolean).join(' ')
    const hs     = `--stagger:${ui.stagger}ms;--spd:${ui.speed}` + (ieM ? `;--ie:${ieM[1]}s` : '')
    const tape   = 'WA-API PANEL // ADMIN ONLY // COMIC 3D // '.repeat(12)
    const tabs   = `<div class="ap-tabs"><a class="ap-tab${reg ? '' : ' on'}" href="/panel/login">${ic('lock', 18)}MASUK</a><a class="ap-tab${reg ? ' on' : ''}" href="/panel/register">${ic('sparkle', 18)}DAFTAR</a></div>`
    const alert  = err ? `<div class="alert alert-danger">${ic('boom', 20)}<span>${esc(err)}</span></div>` : ''
    const form = closed
        ? `<div class="alert alert-warn">${ic('alert', 20)}<span>Pendaftaran sedang ditutup oleh Owner. Hubungi kami lewat Contact Us.</span></div>`
        : reg
        ? `<form id="registerForm" method="POST" action="/panel/register" autocomplete="off">
  <div class="form-group"><label class="form-label" for="u">Username</label>
  <input class="form-input" id="u" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" minlength="3" maxlength="20" required>
  <div class="hint">3-20 karakter: huruf, angka, atau underscore.</div></div>
  ${pwField('p', 'password', 'Password', 'new-password')}
  ${pwField('p2', 'password2', 'Ulangi Password', 'new-password')}
  ${captchaBox()}
  <button class="btn btn-primary" style="width:100%;font-size:21px" type="submit">${ic('sparkle', 20)}Daftar Sekarang!</button>
</form>`
        : `<form id="loginForm" method="POST" action="/panel/login">
  <div class="form-group"><label class="form-label" for="u">Username</label>
  <input class="form-input" id="u" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
  ${pwField('p', 'password', 'Password', 'current-password')}
  ${captchaBox()}
  <button class="btn btn-primary" style="width:100%;font-size:21px" type="submit">${ic('lock', 20)}Masuk!</button>
</form>`
    return `<!DOCTYPE html>
<html lang="id" class="${hc}" style="${hs}" data-theme="auto" data-anim="${getAnim()}" data-sfx="on" data-first><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
${themeMeta('auto')}
<title>${reg ? 'Daftar' : 'Login'} — WA-API Panel</title>
<link rel="icon" href="${FAVICON}">
<script>try{if(sessionStorage.getItem('intro')){document.documentElement.classList.remove('has-intro')}else{sessionStorage.setItem('intro','1')}}catch(e){}</script>
${NEWS_HEAD}
${FONTS}
<style>${CSS}${CSS_EXTRA}</style></head>
<body><div class="login-wrap ap">
  <aside class="ap-poster" aria-hidden="true">
    <div class="ap-rays"></div>
    <div class="ap-tape t1"><span>${tape}</span></div>
    <div class="ap-hero">${cube(110, true)}${pow('NEW!', 'ap-pow')}</div>
    <div class="ap-title">WA-API!</div>
    <div class="ap-tag">Panel kontrol function, API key &amp; server. Versi komik 3D.</div>
    <div class="ap-stick"><b>CEPAT</b><b>AMAN</b><b>3D!</b></div>
    <div class="ap-tape t2"><span>${tape}</span></div>
  </aside>
  <main class="ap-side"><div class="login-box ap-card tilt${err ? ' shake' : ''}" data-tilt="4">
    ${tabs}
    <h1>${reg ? 'BIKIN AKUN!' : 'SELAMAT DATANG!'}</h1>
    <div class="login-sub">${reg ? 'Daftar gratis. Akun baru berstatus Visitor (hanya lihat).' : 'Masuk dulu, baru bisa utak-atik panel!'}</div>
    ${alert}
    ${form}
    <div class="ap-btns">${contactBtn()}</div>
    <div class="ap-alt">${reg ? 'Sudah punya akun? <a href="/panel/login">Masuk</a>' : 'Belum punya akun? <a href="/panel/register">Daftar</a>'}</div>
  </div></main>
</div>
${contactModal()}
${intro}
<script>${OB(TILT_JS)}${OB(FX_JS)}${OB(ROUTER_JS)}</script>
<script>${OB(AUTH_JS)}</script>
<script>${OB(CONTACT_JS)}</script>
${shieldTag()}
</body></html>`
}
const loginPage    = (err = '') => authPage('login', err)
const registerPage = (err = '') => authPage('register', err)


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
    if (!capCheck(req.body.ct, req.body.cv)) return res.send(loginPage('Captcha salah atau kedaluwarsa. Coba lagi.'))
    const data = loadData()
    const rec  = loginAttempts.get(req.ip) || { count: 0, reset: Date.now() + 300000 }
    const u    = (data.users || []).find(x => x.username.toLowerCase() === String(username || '').toLowerCase())
    const ok   = !!u && await bcrypt.compare(password || '', u.password)
    if (!ok) {
        rec.count++
        loginAttempts.set(req.ip, rec)
        return res.send(loginPage('Username atau password salah.'))
    }
    loginAttempts.delete(req.ip)
    req.session.loggedIn = true
    req.session.user = u.username
    res.redirect('/panel/dashboard?welcome=1')
})

// ── Captcha & Register ────────────────────────────────────────────────────────
app.get('/panel/captcha-new', capLimit, (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ t: capNew() })
})
app.get(/^\/panel\/captcha\/([A-Za-z0-9_.-]+)\.svg$/, capLimit, (req, res) => {
    const t = capParse(req.params[0])
    if (!t) return res.status(404).end()
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).send(capSvg(capAnswer(t.p)))
})

app.get('/panel/register', (req, res) => {
    if (req.session?.loggedIn) return res.redirect('/panel/dashboard')
    res.send(registerPage())
})

app.post('/panel/register', regLimit, async (req, res) => {
    if (!regOpen()) return res.send(registerPage())
    const rec = req._reg
    const { username, password, password2, ct, cv } = req.body
    if (!capCheck(ct, cv)) return res.send(registerPage('Captcha salah atau kedaluwarsa. Coba lagi.'))
    rec.n++
    const un = String(username || '').trim(), pw = String(password || '')
    if (!/^[A-Za-z0-9_]{3,20}$/.test(un))       return res.send(registerPage('Username 3-20 karakter: huruf, angka, atau underscore.'))
    if (RESERVED_NAMES.includes(un.toLowerCase())) return res.send(registerPage('Username itu tidak boleh dipakai.'))
    if (pw.length < 8)                          return res.send(registerPage('Password minimal 8 karakter.'))
    if (Buffer.byteLength(pw) > 72)             return res.send(registerPage('Password maksimal 72 karakter.'))
    if (pw !== String(password2 || ''))         return res.send(registerPage('Password dan ulangi password tidak sama.'))
    const hash = await bcrypt.hash(pw, 12)
    const data = loadData()
    if ((data.users || []).some(x => x.username.toLowerCase() === un.toLowerCase())) return res.send(registerPage('Username sudah dipakai.'))
    data.users.push({ username: un, password: hash, role: 'visitor', ui: { ...UI_DEFAULT }, created: new Date().toISOString(), selfReg: true })
    saveData(data)
    req.session.loggedIn = true
    req.session.user = un
    res.redirect('/panel/dashboard?welcome=1')
})

app.get('/panel/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/panel/login'))
})

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/panel/dashboard', auth, async (req, res) => {
    const u    = req.user
    const db   = loadDb()
    const data = loadData()
    const showStatus = can(u, 'view.status')
    const showFuncs  = can(u, 'view.functions')
    const files = showStatus && fs.existsSync(FUNC_DIR) ? fs.readdirSync(FUNC_DIR).filter(f => f.endsWith('.js')) : []
    const activeKeys = (data.apiKeys || []).filter(k => k.active && (!k.exp || new Date(k.exp) > new Date()))

    let apiCard = ''
    if (showStatus) {
        let apiStatus = 'Belum diketahui', cls = 'alert-warn', icon = 'alert'
        try {
            const axios = require('axios')
            const r = await axios.get('http://localhost:2578/api/status', { timeout: 3000, headers: { 'x-api-key': (activeKeys[0] && activeKeys[0].key) || '' } })
            if (r.data?.success) { apiStatus = `Online — uptime ${r.data.uptime_sec}s, mem ${r.data.memory_mb}MB`; cls = 'alert-success'; icon = 'check' }
        } catch (e) { apiStatus = e.response ? `wa-api membalas HTTP ${e.response.status}. Cek API key aktif dan rute /api/status` : 'Offline atau tidak bisa dihubungi'; cls = 'alert-danger'; icon = 'boom' }
        apiCard = `<div class="card">
  ${cardTitle('signal', 'green', 'Status wa-api')}
  <div class="alert ${cls}" style="margin-bottom:0">${ic(icon, 20)}<span>${esc(apiStatus)}</span></div>
</div>`
    }

    const stat = (v, l, c, i) => `<div class="stat tilt c-${c}">${ic(i, 28)}<div class="stat-val" data-n="${v}">${v}</div><div class="stat-label">${l}</div></div>`
    const stats = [
        stat(db.length, 'Functions', 'pink', 'bolt'),
        can(u, 'keys') && stat(activeKeys.length, 'API Keys Aktif', 'blue', 'key'),
        showStatus && stat(files.length, 'File di /function', 'green', 'folder'),
        can(u, 'backup') && stat(data.backups?.length || 0, 'Backup', 'yellow', 'save'),
    ].filter(Boolean).join('')
    const heroText = can(u, 'func.write')
        ? `${db.length} function terdaftar${can(u, 'keys') ? `, ${activeKeys.length} API key aktif` : ''}. Semua siap dikendalikan dari sini.`
        : `${db.length} function terdaftar. Kamu masuk sebagai ${(ROLES[u.role] || {}).label}, jadi halaman ini hanya untuk dilihat.`

    const body = `
${flash(req.query.msg, req.query.err)}
<div class="card hero">
  ${pow('POW!')}
  ${cube(92, true)}
  <div><h2>Markas WA-API</h2><p>${esc(heroText)}</p></div>
</div>
<div class="stats">${stats}</div>
${apiCard}
${showFuncs ? `<div class="card">
  ${cardTitle('bolt', 'pink', 'Functions Terdaftar')}
  ${db.length ? `<div class="chips">${db.map(f => `<span class="badge ${f.active !== false ? 'b-blue' : 'b-off'}">${esc(f.type)}</span>`).join('')}</div>` : '<div class="empty">Belum ada function</div>'}
</div>` : ''}
${showStatus ? `<div class="card">
  ${cardTitle('folder', 'yellow', 'File di /function')}
  ${files.length ? `<div class="chips">${files.map(f => `<span class="badge b-green"><code>${esc(f)}</code></span>`).join('')}</div>` : '<div class="empty">Folder kosong</div>'}
</div>` : ''}`
    const links = [
        can(u, 'maint') && ['maintenance', 'wrench', 'Maintenance', 'btn-blue'],
        can(u, 'backup') && ['backup', 'save', 'Backup', 'btn-mint'],
    ].filter(Boolean).map(([id, icon, t, c]) => `<a class="btn ${c}" href="/panel/${id}">${ic(icon, 19)}${t}</a>`).join('')
    const shortcuts = links ? `<div class="card">${cardTitle('sparkle', 'orange', 'Pintasan')}<div class="btn-group">${links}</div></div>` : ''
    const act = db.filter(f => f.active !== false).length, offN = db.length - act
    const pct = db.length ? Math.round(act / db.length * 100) : 0
    const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`
    const bar = (p, c) => `<div class="bar" aria-hidden="true"><i class="c-${c}" style="width:${p}%"></i></div>`
    const upS = Math.floor(process.uptime()), upTxt = `${Math.floor(upS / 3600)}j ${Math.floor(upS % 3600 / 60)}m ${upS % 60}d`
    const mem = process.memoryUsage(), nowD = new Date()
    const keysAll = data.apiKeys || []
    const keyExp = keysAll.filter(k => k.exp && new Date(k.exp) <= nowD).length
    const keyOff = keysAll.filter(k => !k.active).length
    const soon = keysAll.filter(k => k.active && k.exp && new Date(k.exp) > nowD).sort((a, b) => new Date(a.exp) - new Date(b.exp))[0]
    const unreg = showStatus ? files.filter(f => !db.some(d => jsFile(d.file) === f)).length : 0
    const menus = NAV.flatMap(([, its]) => its).filter(it => !it[3] || can(u, it[3])).map(it => it[2])
    const infoCards = [
        showFuncs && `<div class="card">${cardTitle('bolt', 'pink', 'Ringkasan Function')}
  ${bar(pct, 'green')}
  ${kv('Aktif', act + ' dari ' + db.length + ' (' + pct + '%)')}${kv('Nonaktif', offN)}${showStatus ? kv('File belum didaftarkan', unreg) : ''}
</div>`,
        can(u, 'keys') && `<div class="card">${cardTitle('key', 'blue', 'Ringkasan API Key')}
  ${kv('Total key', keysAll.length)}${kv('Aktif', activeKeys.length)}${kv('Nonaktif', keyOff)}${kv('Kedaluwarsa', keyExp)}${kv('Segera kedaluwarsa', soon ? soon.label + ' · ' + new Date(soon.exp).toLocaleDateString('id-ID') : 'Tidak ada')}
</div>`,
        can(u, 'sysinfo') && `<div class="card">${cardTitle('signal', 'yellow', 'Info Server')}
  ${kv('Node.js', process.version)}${kv('Platform', process.platform + ' ' + process.arch)}${kv('Uptime panel', upTxt)}${kv('Memori (RSS)', Math.round(mem.rss / 1048576) + ' MB')}${kv('Heap terpakai', Math.round(mem.heapUsed / 1048576) + ' MB')}${kv('Port panel', PORT)}
</div>`,
        `<div class="card">${cardTitle('lock', 'orange', 'Hak Akses Kamu')}
  ${kv('Role', (ROLES[u.role] || {}).label || u.role)}
  <p style="margin:10px 0;color:var(--muted)">${esc((ROLES[u.role] || {}).desc || '')}</p>
  <div class="chips">${menus.map(m => `<span class="badge b-pink">${esc(m)}</span>`).join('')}</div>
</div>`,
        `<div class="card">${cardTitle('sparkle', 'green', 'Tips Cepat')}
  ${kv('Ganti tema', 'Tombol monitor/matahari/bulan di pojok atas')}${kv('Suara efek', 'Tombol speaker di pojok atas')}${kv('Gaya animasi', 'Setelan, lalu Gaya Transisi Halaman (Owner)')}${kv('Scroll', 'Kartu di bawah muncul saat digulir')}
</div>`,
    ].filter(Boolean).join('')
    const ui = getUi()
    const intro = req.query.welcome && ui.intro !== false ? introHTML('HALO, ' + u.username.toUpperCase().slice(0, 8) + '!', 'SELAMAT DATANG, ' + ((ROLES[u.role] || {}).label || '').toUpperCase()) : ''
    res.send(page('Dashboard', body + shortcuts + infoCards, 'dashboard', intro))
})

// ── Functions: list ───────────────────────────────────────────────────────────
app.get('/panel/functions', auth, need('view.functions'), (req, res) => {
    const db = loadDb()
    const canW = can(req.user, 'func.write'), canD = can(req.user, 'func.delete')
    const rows = db.map((f, i) => `
      <tr>
        <td><span class="badge b-blue">${esc(f.type)}</span></td>
        <td><code class="fn">${esc(f.file)}</code></td>
        <td style="color:var(--muted)">${esc(f.description) || '—'}</td>
        <td>${f.active !== false ? '<span class="badge b-green"><i class="bd"></i>Aktif</span>' : '<span class="badge b-off"><i class="bd"></i>Nonaktif</span>'}</td>
        ${canW || canD ? `<td>
          <div class="btn-group" style="padding-bottom:4px">
            ${canW ? `<a class="btn btn-blue btn-sm" href="/panel/functions/edit/${i}">${ic('edit', 16)}Edit</a>
            <form method="POST" action="/panel/functions/toggle" style="display:inline">
              <input type="hidden" name="index" value="${i}">
              <button class="btn btn-ghost btn-sm" type="submit" title="Aktif/nonaktifkan" aria-label="Aktif/nonaktifkan">${ic(f.active !== false ? 'pause' : 'play', 16)}</button>
            </form>` : ''}
            ${canD ? `<button class="btn btn-danger btn-sm" type="button" data-del="${i}" data-type="${esc(f.type)}" aria-label="Hapus">${ic('trash', 16)}</button>` : ''}
          </div>
        </td>` : ''}
      </tr>`).join('')

    const body = `
${flash(req.query.msg, req.query.err)}
<div class="card">
  ${cardTitle('bolt', 'pink', 'Registered Functions')}
  ${db.length === 0 ? '<div class="empty">Kosong melompong! Tambah function dulu.</div>' : `
  <div class="table-wrap"><table>
    <thead><tr><th>Type</th><th>File</th><th>Deskripsi</th><th>Status</th>${canW || canD ? '<th>Aksi</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`}
  ${canW ? `<div style="margin-top:18px"><a href="/panel/add-func" class="btn btn-primary">${ic('plus', 19)}Tambah Function</a></div>` : ''}
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

app.post('/panel/functions/analyze', auth, need('func.write'), (req, res) => {
    res.json({ html: renderAnalysis(analyzeSource(req.body && req.body.source)) })
})

// ── Functions: edit ───────────────────────────────────────────────────────────
app.get('/panel/functions/edit/:idx', auth, need('func.write'), (req, res) => {
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

app.post('/panel/functions/edit/:idx', auth, need('func.write'), (req, res) => {
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

app.post('/panel/functions/toggle', auth, need('func.write'), (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.body.index)
    if (db[idx]) db[idx].active = !(db[idx].active !== false)
    saveDb(db)
    res.redirect('/panel/functions')
})

app.post('/panel/functions/delete', auth, need('func.delete'), (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.body.index)
    if (idx >= 0 && idx < db.length) db.splice(idx, 1)
    saveDb(db)
    res.redirect('/panel/functions?msg=' + encodeURIComponent('Function dihapus dari daftar'))
})

// ── Add Function ──────────────────────────────────────────────────────────────
app.get('/panel/add-func', auth, need('func.write'), (req, res) => {
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

app.post('/panel/add-func/paste', auth, need('func.write'), (req, res) => {
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
    auth(req, res, () => need('func.write')(req, res, () => upload.single('jsfile')(req, res, err => err ? res.redirect(addErr(err.message)) : next())))
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

app.post('/panel/add-func/url', auth, need('func.write'), async (req, res) => {
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
app.get('/panel/apikeys', auth, need('keys'), (req, res) => {
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

app.post('/panel/apikeys/generate', auth, need('keys'), (req, res) => {
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

app.post('/panel/apikeys/delete', auth, need('keys'), (req, res) => {
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
app.get('/panel/maintenance', auth, need('maint'), (req, res) => {
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

app.post('/panel/maintenance/save', auth, need('maint'), (req, res) => {
    const data = loadData()
    data.maint = { api: !!req.body.api, web: !!req.body.web, msg: req.body.msg || '' }
    saveData(data)
    try { fs.writeFileSync(path.join(WA_API_DIR, '.maintenance.json'), JSON.stringify(data.maint)) } catch (e) { console.error(e.message) }
    res.redirect('/panel/maintenance?msg=' + encodeURIComponent('Mode maintenance disimpan'))
})

app.post('/panel/maintenance/func', auth, need('maint'), (req, res) => {
    const db  = loadDb()
    const idx = parseInt(req.body.index)
    if (db[idx]) db[idx].active = !(db[idx].active !== false)
    saveDb(db)
    res.redirect('/panel/maintenance')
})

// ── Backup ────────────────────────────────────────────────────────────────────
app.get('/panel/backup', auth, need('backup'), (req, res) => {
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

app.post('/panel/backup/create', auth, need('backup'), (req, res) => {
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

app.get('/panel/backup/download/:idx', auth, need('backup'), (req, res) => {
    const backup = (loadData().backups || [])[parseInt(req.params.idx)]
    if (!backup) return res.status(404).send('Backup tidak ditemukan')
    res.setHeader('Content-Disposition', `attachment; filename="wa-api-backup-${backup.ts.replace(/[:.]/g, '-')}.json"`)
    res.json(backup)
})

// ── Users & Role ──────────────────────────────────────────────────────────────
const ROLE_BADGE  = { owner: 'b-pink', admin: 'b-blue', editor: 'b-green', visitor: 'b-off' }
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/
const roleOpts = sel => Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(r.label)}</option>`).join('')
const usersBack = (res, k, m) => res.redirect('/panel/users?' + k + '=' + encodeURIComponent(m))

app.get('/panel/users', auth, need('users'), (req, res) => {
    const users = loadData().users || []
    const rows = users.map(u => `
      <tr>
        <td><b>${esc(u.username)}</b>${u.username === req.user.username ? ' <span class="badge b-green">kamu</span>' : ''}</td>
        <td><span class="badge ${ROLE_BADGE[u.role] || 'b-off'}">${esc((ROLES[u.role] || {}).label || u.role)}</span></td>
        <td style="color:var(--muted)">${esc(new Date(u.created).toLocaleDateString('id-ID'))}</td>
        <td><div class="btn-group" style="padding-bottom:4px;flex-wrap:nowrap">
          <form method="POST" action="/panel/users/role" style="display:flex;gap:8px;align-items:center">
            <input type="hidden" name="username" value="${esc(u.username)}">
            <select class="form-select" name="role" style="width:auto;padding:5px 8px" aria-label="Role ${esc(u.username)}">${roleOpts(u.role)}</select>
            <button class="btn btn-ghost btn-sm" type="submit" aria-label="Simpan role">${ic('check', 16)}</button>
          </form>
          ${u.username !== req.user.username ? `<button class="btn btn-danger btn-sm" type="button" data-deluser="${esc(u.username)}" aria-label="Hapus user">${ic('trash', 16)}</button>` : ''}
        </div></td>
      </tr>`).join('')
    const roleInfo = Object.entries(ROLES).map(([k, r]) => `<div class="toggle-row"><div class="toggle-info"><h4><span class="badge ${ROLE_BADGE[k]}">${esc(r.label)}</span></h4><p>${esc(r.desc)}</p></div></div>`).join('')
    const body = `
${flash(req.query.msg, req.query.err)}
<div class="card">
  ${cardTitle('plus', 'green', 'Tambah User Baru')}
  <form method="POST" action="/panel/users/add">
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="nu">Username</label><input class="form-input" id="nu" name="username" autocomplete="off" placeholder="mis. budi" required></div>
      <div class="form-group"><label class="form-label" for="np">Password</label><input class="form-input" id="np" name="password" type="password" minlength="6" autocomplete="new-password" required></div>
      <div class="form-group"><label class="form-label" for="nr">Role</label><select class="form-select" id="nr" name="role">${roleOpts('editor')}</select></div>
    </div>
    <button class="btn btn-mint" type="submit">${ic('plus', 19)}Tambah User</button>
  </form>
</div>
<div class="card">
  ${cardTitle('users', 'blue', `Daftar User (${users.length})`)}
  <div class="table-wrap"><table>
    <thead><tr><th>Username</th><th>Role</th><th>Dibuat</th><th>Aksi</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>
<div class="card">
  ${cardTitle('key', 'yellow', 'Reset Password User')}
  <form method="POST" action="/panel/users/password">
    <div class="form-row">
      <div class="form-group"><label class="form-label" for="rp-u">User</label><select class="form-select" id="rp-u" name="username">${users.map(u => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="rp-p">Password Baru</label><input class="form-input" id="rp-p" name="password" type="password" minlength="6" autocomplete="new-password" required></div>
    </div>
    <div class="hint" style="margin-bottom:12px">Semua sesi login user itu akan diputus.</div>
    <button class="btn btn-primary" type="submit">${ic('save', 19)}Reset Password</button>
  </form>
</div>
<div class="card">
  ${cardTitle('lock', 'pink', 'Penjelasan Role')}
  ${roleInfo}
</div>
<form id="du-form" method="POST" action="/panel/users/delete" style="display:none"><input type="hidden" name="username" id="du-name"></form>
<script>
document.querySelectorAll('[data-deluser]').forEach(function(b){
  b.addEventListener('click',function(){
    openModal('Hapus user?','User "'+b.dataset.deluser+'" akan dihapus dan sesinya diputus.',function(){
      document.getElementById('du-name').value=b.dataset.deluser;document.getElementById('du-form').submit()
    })
  })
})
</script>`
    res.send(page('Users', body, 'users'))
})

app.post('/panel/users/add', auth, need('users'), async (req, res) => {
    const { username, password, role } = req.body
    if (!USERNAME_RE.test(username || '')) return usersBack(res, 'err', 'Username 3-24 karakter: huruf, angka, titik, minus, atau underscore')
    if (!password || password.length < 6) return usersBack(res, 'err', 'Password minimal 6 karakter')
    if (!ROLES[role]) return usersBack(res, 'err', 'Role tidak valid')
    const data = loadData()
    if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return usersBack(res, 'err', 'Username sudah dipakai')
    data.users.push({ username, password: await bcrypt.hash(password, 12), role, ui: { ...UI_DEFAULT }, created: new Date().toISOString() })
    saveData(data)
    usersBack(res, 'msg', `User "${username}" ditambahkan sebagai ${ROLES[role].label}`)
})

app.post('/panel/users/role', auth, need('users'), (req, res) => {
    const { username, role } = req.body
    const data = loadData()
    const u = data.users.find(x => x.username === username)
    if (!u || !ROLES[role]) return usersBack(res, 'err', 'User atau role tidak valid')
    if (u.role === 'owner' && role !== 'owner' && data.users.filter(x => x.role === 'owner').length < 2) return usersBack(res, 'err', 'Harus ada minimal satu Owner')
    u.role = role
    saveData(data)
    usersBack(res, 'msg', `Role "${username}" diubah menjadi ${ROLES[role].label}`)
})

app.post('/panel/users/password', auth, need('users'), async (req, res) => {
    const { username, password } = req.body
    const data = loadData()
    const u = data.users.find(x => x.username === username)
    if (!u) return usersBack(res, 'err', 'User tidak ditemukan')
    if (!password || password.length < 6) return usersBack(res, 'err', 'Password minimal 6 karakter')
    u.password = await bcrypt.hash(password, 12)
    saveData(data)
    store.purgeUser(username)
    if (username === req.user.username) return req.session.destroy(() => res.redirect('/panel/login'))
    usersBack(res, 'msg', `Password "${username}" direset`)
})

app.post('/panel/users/delete', auth, need('users'), (req, res) => {
    const { username } = req.body
    const data = loadData()
    const u = data.users.find(x => x.username === username)
    if (!u) return usersBack(res, 'err', 'User tidak ditemukan')
    if (username === req.user.username) return usersBack(res, 'err', 'Tidak bisa menghapus akunmu sendiri')
    if (u.role === 'owner' && data.users.filter(x => x.role === 'owner').length < 2) return usersBack(res, 'err', 'Harus ada minimal satu Owner')
    data.users = data.users.filter(x => x.username !== username)
    saveData(data)
    store.purgeUser(username)
    usersBack(res, 'msg', `User "${username}" dihapus`)
})

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/panel/settings', auth, need('self'), (req, res) => {
    const ui = getUi(), u = req.user
    const owner = can(u, 'users'), anim = getAnim(), vis = visitorCfg()
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2].map(v => `<option value="${v}" ${Number(ui.speed) === v ? 'selected' : ''}>${v}x</option>`).join('')
    const themeOpts = [['auto', 'Ikuti perangkat (otomatis)'], ['light', 'Terang'], ['dark', 'Gelap']].map(([v, t]) => `<option value="${v}" ${ui.theme === v ? 'selected' : ''}>${t}</option>`).join('')
    const links = [
        can(u, 'maint') && ['maintenance', 'wrench', 'Maintenance', 'btn-blue'],
        can(u, 'backup') && ['backup', 'save', 'Backup', 'btn-mint'],
        can(u, 'users') && ['users', 'users', 'Kelola User', 'btn-primary'],
    ].filter(Boolean).map(([id, icon, t, c]) => `<a class="btn ${c}" href="/panel/${id}">${ic(icon, 19)}${t}</a>`).join('')
    const body = `
${flash(req.query.msg, req.query.err)}
<div class="card">
  ${cardTitle('sparkle', 'pink', 'Tampilan & Animasi')}
  <form method="POST" action="/panel/settings/ui">
    <div class="form-group">
      <label class="form-label" for="theme">Tema</label>
      <select class="form-select" id="theme" name="theme">${themeOpts}</select>
      <div class="hint">Otomatis berarti mengikuti perangkat: perangkat gelap, panel ikut gelap. Tombol di pojok atas juga bisa ganti cepat.</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="navSide">Posisi navigasi di PC</label>
      <select class="form-select" id="navSide" name="navSide">
        <option value="left" ${ui.navSide !== 'right' ? 'selected' : ''}>Kiri</option>
        <option value="right" ${ui.navSide === 'right' ? 'selected' : ''}>Kanan</option>
      </select>
      <div class="hint">Di HP, navigasi selalu berada di bawah.</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="stagger">Jeda antar elemen: <b id="stv">${ui.stagger} ms</b></label>
      <input class="form-range" type="range" id="stagger" name="stagger" min="0" max="300" step="10" value="${ui.stagger}" oninput="document.getElementById('stv').textContent=this.value+' ms'">
      <div class="hint">Makin besar, kartu, baris, dan tombol muncul satu per satu makin pelan. 0 = muncul bersamaan.</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="speed">Kecepatan animasi</label>
      <select class="form-select" id="speed" name="speed">${speeds}</select>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Intro sambutan setelah login</h4><p>Animasi sinematik sebelum masuk dashboard. Bisa dilewati dengan sekali tap.</p></div>
      <label class="toggle"><input type="checkbox" name="intro" ${ui.intro !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Efek 3D & animasi</h4><p>Matikan kalau perangkat terasa berat. Ini juga mematikan intro dan transisi halaman.</p></div>
      <label class="toggle"><input type="checkbox" name="fx" ${ui.fx !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Suara efek (SFX)</h4><p>Suara whoosh, boom, dan pop saat pindah halaman. Bisa juga diganti cepat lewat tombol speaker di pojok atas.</p></div>
      <label class="toggle"><input type="checkbox" name="sfx" ${ui.sfx !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="btn-group" style="margin-top:12px">
      <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan Tampilan</button>
      <a class="btn btn-mint" href="/panel/dashboard?welcome=1">${ic('play', 19)}Putar Intro</a>
    </div>
  </form>
</div>
${owner ? `<div class="card">
  ${cardTitle('bolt', 'yellow', 'Gaya Transisi Halaman')}
  <div class="hint" style="margin:-6px 0 14px">Berlaku untuk semua user. Saat pindah halaman, UI lama keluar dulu, lalu UI baru masuk dengan keyframe gaya ini. Hanya Owner yang bisa mengganti.</div>
  <form method="POST" action="/panel/settings/anim">
    <div class="sty-nav">
      <span class="hint" style="margin:0">Geser kiri-kanan untuk melihat semua gaya. Tekan Coba untuk melihat langsung di halaman ini.</span>
      <span class="btn-group" style="padding:0;flex-wrap:nowrap"><button class="btn btn-ghost btn-sm" type="button" data-dir="-1" aria-label="Sebelumnya">${ic('chevl', 16)}</button><button class="btn btn-ghost btn-sm" type="button" data-dir="1" aria-label="Berikutnya">${ic('chevr', 16)}</button></span>
    </div>
    <div class="sty-scroll" id="stySc">${Object.entries(ANIM_STYLES).map(([k, [n, d, tags]]) => `<label class="sty-card${anim === k ? ' sel' : ''}">
      <input type="radio" name="style" value="${k}" ${anim === k ? 'checked' : ''}>
      <span class="sty-box">
        <span class="mini" data-s="${k}">${k === 'gunshot' ? `<span class="mini-gun">${GUN_SVG}</span>` : ''}<i></i><i></i><i></i><i></i><i></i><i></i></span>
        <b>${esc(n)}</b>
        <small>${esc(d)}</small>
        <span class="chips">${(tags || []).map(t => `<span class="badge b-blue">${esc(t)}</span>`).join('')}</span>
        <button class="btn btn-sm btn-mint" type="button" data-try="${k}">${ic('play', 16)}Coba di halaman ini</button>
      </span></label>`).join('')}</div>
    <script>
    (function(){
      var sc=document.getElementById('stySc');if(!sc)return;
      var cards=[].slice.call(sc.querySelectorAll('.sty-card'));
      function sel(){var r=sc.getBoundingClientRect(),mid=r.left+r.width/2,best=null,bd=1e9;cards.forEach(function(c){var b=c.getBoundingClientRect(),d=Math.abs(b.left+b.width/2-mid);if(d<bd){bd=d;best=c}});cards.forEach(function(c){c.classList.toggle('on',c===best)})}
      sc.addEventListener('scroll',function(){clearTimeout(sc._t);sc._t=setTimeout(sel,60)},{passive:true});
      document.querySelectorAll('[data-dir]').forEach(function(b){b.addEventListener('click',function(){sc.scrollBy({left:(+b.dataset.dir)*Math.min(300,sc.clientWidth*.8),behavior:'smooth'})})});
      cards.forEach(function(c){c.querySelector('input').addEventListener('change',function(){cards.forEach(function(x){x.classList.toggle('sel',x===c)})})});
      sc.addEventListener('click',function(e){var b=e.target.closest('[data-try]');if(!b)return;e.preventDefault();var r=b.getBoundingClientRect();if(window.__waPreview)window.__waPreview(b.dataset.try,r.left+r.width/2,r.top+r.height/2)});
      var cur=sc.querySelector('.sty-card.sel');if(cur)sc.scrollLeft=cur.offsetLeft-(sc.clientWidth-cur.offsetWidth)/2;
      sel();
    })();
    </script>
    <div class="btn-group" style="margin-top:16px">
      <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan Gaya</button>
    </div>
  </form>
</div>
<div class="card">
  ${cardTitle('lock', 'blue', 'Akses Visitor')}
  <div class="hint" style="margin:-6px 0 8px">Visitor hanya bisa melihat dan tidak bisa mengubah apa pun. Di sini kamu atur halaman apa saja yang boleh mereka lihat. Hanya Owner yang bisa mengatur dan menghapus akun Visitor.</div>
  <form method="POST" action="/panel/settings/visitor">
    <div class="toggle-row">
      <div class="toggle-info"><h4>Daftar function</h4><p>Boleh membuka halaman Manage Functions (tanpa tombol aksi)</p></div>
      <label class="toggle"><input type="checkbox" name="functions" ${vis.functions ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Status server</h4><p>Boleh melihat status wa-api dan daftar file di /function pada dashboard</p></div>
      <label class="toggle"><input type="checkbox" name="status" ${vis.status ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <button class="btn btn-primary" type="submit" style="margin-top:12px">${ic('save', 19)}Simpan Akses</button>
  </form>
</div>` : ''}
${owner ? `<div class="card">
  ${cardTitle('lock', 'red', 'Keamanan & Pendaftaran')}
  <form method="POST" action="/panel/settings/security">
    <div class="toggle-row">
      <div class="toggle-info"><h4>Pendaftaran akun</h4><p>Pengunjung bisa membuat akun lewat halaman Register. Akun baru otomatis role Visitor (hanya lihat). Naikkan role manual di Kelola User.</p></div>
      <label class="toggle"><input type="checkbox" name="reg" ${regOpen() ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Anti-colong tampilan</h4><p>Blokir klik kanan, copy, F12, Ctrl+U, Ctrl+S, dan scraper (curl, wget, dll) untuk semua selain Owner. Ini cuma penghalang, bukan pengaman sejati.</p></div>
      <label class="toggle"><input type="checkbox" name="shield" ${shieldOn() ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <button class="btn btn-primary" type="submit" style="margin-top:12px">${ic('save', 19)}Simpan</button>
  </form>
</div>` : ''}
${links ? `<div class="card">
  ${cardTitle('wrench', 'yellow', 'Menu Lain')}
  <div class="btn-group">${links}</div>
</div>` : ''}
<div class="card">
  ${cardTitle('lock', 'blue', 'Akun Saya')}
  <div style="margin-bottom:14px">Login sebagai <b>${esc(u.username)}</b> <span class="badge ${ROLE_BADGE[u.role] || 'b-off'}">${esc((ROLES[u.role] || {}).label || u.role)}</span></div>
  <div class="alert alert-warn">${ic('alert', 20)}<span>Setelah menyimpan, kamu akan otomatis keluar dan perlu login ulang.</span></div>
  <form method="POST" action="/panel/settings/save">
    <div class="form-group"><label class="form-label" for="cur">Password Saat Ini</label><input class="form-input" id="cur" name="current" type="password" autocomplete="current-password" required></div>
    <div class="form-group"><label class="form-label">Username Baru</label><input class="form-input" name="username" placeholder="Kosongkan jika tidak diganti" autocomplete="off"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Password Baru</label><input class="form-input" name="password" type="password" placeholder="Kosongkan jika tidak diganti" autocomplete="new-password"></div>
      <div class="form-group"><label class="form-label">Konfirmasi Password</label><input class="form-input" name="password2" type="password" placeholder="Ulangi password baru" autocomplete="new-password"></div>
    </div>
    <button class="btn btn-primary" type="submit">${ic('save', 19)}Simpan Akun</button>
  </form>
</div>
${can(u, 'sysinfo') ? `<div class="card">
  ${cardTitle('signal', 'yellow', 'Info Server')}
  <div class="code">wa-api dir    : ${esc(WA_API_DIR)}
database.json: ${esc(DB_PATH)}
function dir  : ${esc(FUNC_DIR)}
panel port    : ${PORT}
node version  : ${esc(process.version)}
uptime        : ${Math.floor(process.uptime())}s</div>
</div>` : ''}
${can(u, 'keys') ? `<div class="card" style="border-color:var(--red)">
  ${cardTitle('burst', 'red', 'Danger Zone')}
  <div class="alert alert-danger">${ic('alert', 20)}<span>Tindakan ini tidak bisa dibatalkan!</span></div>
  <form id="clear-form" method="POST" action="/panel/settings/clear-keys">
    <button class="btn btn-danger" type="button" onclick="openModal('Hapus SEMUA API key?','Semua key akan hilang permanen.',function(){document.getElementById('clear-form').submit()})">${ic('trash', 19)}Hapus Semua API Keys</button>
  </form>
</div>` : ''}`
    res.send(page('Settings', body, 'settings'))
})

app.post('/panel/settings/ui', auth, need('self'), (req, res) => {
    const data = loadData()
    const me = data.users.find(x => x.username === req.user.username)
    me.ui = {
        navSide: req.body.navSide === 'right' ? 'right' : 'left',
        fx: !!req.body.fx,
        sfx: !!req.body.sfx,
        intro: !!req.body.intro,
        stagger: Math.round(clamp(req.body.stagger, 0, 400, 90) / 10) * 10,
        speed: clamp(req.body.speed, 0.5, 2, 1),
        theme: THEMES.includes(req.body.theme) ? req.body.theme : 'auto',
    }
    saveData(data)
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Tampilan disimpan'))
})

// ganti tema cepat dari tombol di topbar (JSON)
app.post('/panel/settings/theme', auth, need('self'), (req, res) => {
    const theme = req.body && req.body.theme
    if (!THEMES.includes(theme)) return res.status(400).json({ ok: false })
    const data = loadData()
    const me = data.users.find(x => x.username === req.user.username)
    me.ui = { ...UI_DEFAULT, ...(me.ui || {}), theme }
    saveData(data)
    res.json({ ok: true })
})

// ganti SFX cepat dari tombol di topbar (JSON)
app.post('/panel/settings/sfx', auth, need('self'), (req, res) => {
    const data = loadData()
    const me = data.users.find(x => x.username === req.user.username)
    me.ui = { ...UI_DEFAULT, ...(me.ui || {}), sfx: !!(req.body && req.body.sfx) }
    saveData(data)
    res.json({ ok: true })
})

// hanya Owner: gaya transisi halaman dan akses Visitor
app.post('/panel/settings/anim', auth, need('users'), (req, res) => {
    const style = req.body.style
    if (!ANIM_STYLES[style]) return res.redirect('/panel/settings?err=' + encodeURIComponent('Gaya tidak valid'))
    const data = loadData()
    data.anim = { style, v: 3 }
    saveData(data)
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Gaya transisi: ' + ANIM_STYLES[style][0]))
})

app.post('/panel/settings/security', auth, need('users'), (req, res) => {
    const data = loadData()
    data.reg    = { open: !!req.body.reg }
    data.shield = { on: !!req.body.shield }
    saveData(data)
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Keamanan & pendaftaran disimpan'))
})

app.post('/panel/settings/visitor', auth, need('users'), (req, res) => {
    const data = loadData()
    data.visitor = { functions: !!req.body.functions, status: !!req.body.status }
    saveData(data)
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Akses Visitor disimpan'))
})

app.post('/panel/settings/save', auth, need('self'), async (req, res) => {
    const { current, username, password, password2 } = req.body
    const data = loadData()
    const me = data.users.find(x => x.username === req.user.username)
    const back = m => res.redirect('/panel/settings?err=' + encodeURIComponent(m))
    if (!(await bcrypt.compare(current || '', me.password))) return back('Password saat ini salah')
    if (password && password !== password2) return back('Password baru tidak sama')
    if (password && password.length < 6) return back('Password baru minimal 6 karakter')
    if (username && username !== me.username) {
        if (!USERNAME_RE.test(username)) return back('Username 3-24 karakter: huruf, angka, titik, minus, atau underscore')
        if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return back('Username sudah dipakai')
        me.username = username
    }
    if (password) me.password = await bcrypt.hash(password, 12)
    saveData(data)
    store.purgeUser(req.user.username)
    req.session.destroy(() => res.redirect('/panel/login'))
})

app.post('/panel/settings/clear-keys', auth, need('keys'), (req, res) => {
    const data = loadData()
    data.apiKeys = []
    saveData(data)
    updateWaApiKey([])
    res.redirect('/panel/settings?msg=' + encodeURIComponent('Semua API key dihapus'))
})

// ── Start ─────────────────────────────────────────────────────────────────────
initData().then(() => {
    if (JSO) { try { [TILT_JS, FX_JS, ROUTER_JS, THEME_JS, BNAV_JS, AUTH_JS, CONTACT_JS, SHIELD_JS].forEach(OB); console.log('[PANEL] JS browser di-obfuscate') } catch {} } else console.log('[PANEL] javascript-obfuscator belum terpasang, JS browser dikirim apa adanya')
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[PANEL] Jalan di port ${PORT}`)
        console.log(`[PANEL] WA-API dir: ${WA_API_DIR}`)
    })
})