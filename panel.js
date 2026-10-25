/**
 * panel.js — Admin Panel untuk wa-api
 * ─────────────────────────────────────
 * Jalan di port 2579, akses via /panels
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
const PORT       = parseInt(process.env.PANEL_PORT)  || 2579
const WA_API_DIR = process.env.WA_API_DIR            || '/root/wa-api'
const DB_PATH    = path.join(WA_API_DIR, 'database.json')
const FUNC_DIR   = path.join(WA_API_DIR, 'function')
const DATA_FILE  = path.join(__dirname, '.panel-data.json')
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')

// ── Init data file (menyimpan hash pw, apikeys, maintenance, dll) ─────────────
function loadData() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }
    catch { return {} }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

async function initData() {
    const data = loadData()
    if (!data.username) data.username = 'admindhann'
    if (!data.password) data.password = await bcrypt.hash('dhann123123*', 12)
    if (!data.apiKeys)  data.apiKeys  = []
    if (!data.maint)    data.maint    = { api: false, web: false, msg: '' }
    if (!data.backups)  data.backups  = []
    saveData(data)
    return data
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadDb() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) }
    catch { return [] }
}

function saveDb(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2))
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }
}))

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 }, // max 512KB
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.js')) cb(null, true)
        else cb(new Error('Hanya file .js yang diizinkan'))
    }
})

// Auth middleware
function auth(req, res, next) {
    if (req.session?.loggedIn) return next()
    res.redirect('/panel/login')
}

// Rate limiter sederhana untuk login
const loginAttempts = new Map()
function rateLimit(req, res, next) {
    const ip  = req.ip
    const now = Date.now()
    const rec = loginAttempts.get(ip) || { count: 0, reset: now + 300000 }
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 300000 }
    if (rec.count >= 5) {
        return res.status(429).send(page('Rate Limited',
            `<div class="alert alert-danger">Terlalu banyak percobaan login. Coba lagi dalam ${Math.ceil((rec.reset - now) / 60000)} menit.</div>`
        ))
    }
    loginAttempts.set(ip, rec)
    next()
}

// ── HTML Template ─────────────────────────────────────────────────────────────
function page(title, body, activeNav = '') {
    const nav = activeNav
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} — WA-API Panel</title>
<style>
:root{
  --bg:#0f0f17;--bg2:#16161f;--bg3:#1e1e2e;
  --border:#2a2a3f;--border2:#35355a;
  --pink:#f472b6;--purple:#a78bfa;--mint:#34d399;--yellow:#fbbf24;--blue:#60a5fa;--red:#f87171;
  --text:#e2e8f0;--muted:#64748b;--muted2:#94a3b8;
  --r:10px;--r-sm:6px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;font-size:14px}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 70% 50% at 10% 0%,rgba(167,139,250,.07) 0%,transparent 60%),radial-gradient(ellipse 50% 40% at 90% 100%,rgba(244,114,182,.05) 0%,transparent 60%);pointer-events:none}
a{color:var(--purple);text-decoration:none}a:hover{text-decoration:underline}
/* Layout */
.wrap{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{width:220px;background:rgba(22,22,31,.95);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;bottom:0;left:0;z-index:100;backdrop-filter:blur(12px)}
.sidebar-logo{padding:20px 16px 14px;border-bottom:1px solid var(--border)}
.logo-main{font-size:15px;font-weight:800;background:linear-gradient(90deg,var(--pink),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo-sub{font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.5px;margin-top:2px}
.nav{flex:1;padding:10px 8px;overflow-y:auto}
.nav-label{font-size:10px;font-weight:700;color:var(--muted);letter-spacing:1px;padding:10px 8px 4px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:var(--r-sm);color:var(--muted2);font-size:13px;font-weight:600;margin-bottom:1px;transition:.15s;text-decoration:none;border:none;background:none;width:100%;cursor:pointer;text-align:left}
.nav-item:hover{background:rgba(255,255,255,.05);color:var(--text);text-decoration:none}
.nav-item.active{background:linear-gradient(90deg,rgba(244,114,182,.15),rgba(167,139,250,.1));color:var(--text);border:1px solid rgba(244,114,182,.2)}
.nav-icon{font-size:14px;flex-shrink:0}
.sidebar-footer{padding:14px;border-top:1px solid var(--border)}
.status-pill{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:20px;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted2)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--mint);box-shadow:0 0 7px rgba(52,211,153,.7);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
.main{margin-left:220px;flex:1;display:flex;flex-direction:column;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--border);background:rgba(15,15,23,.7);backdrop-filter:blur(12px);position:sticky;top:0;z-index:50}
.topbar-title{font-size:15px;font-weight:800}
.topbar-title span{background:linear-gradient(90deg,var(--pink),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.topbar-right{display:flex;align-items:center;gap:10px}
.hbg{display:none;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:var(--r-sm);padding:7px 10px;cursor:pointer;color:var(--text);font-size:14px}
.content{flex:1;padding:22px;max-width:1000px;width:100%}
/* Cards */
.card{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:14px}
.card-title{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.ct-icon{width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
.ct-pink{background:rgba(244,114,182,.15)}.ct-purple{background:rgba(167,139,250,.15)}.ct-mint{background:rgba(52,211,153,.15)}.ct-yellow{background:rgba(251,191,36,.15)}.ct-red{background:rgba(248,113,113,.15)}
/* Stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.stat{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:var(--r);padding:14px;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:-25px;right:-25px;width:70px;height:70px;border-radius:50%;opacity:.1}
.s-pink::before{background:var(--pink)}.s-purple::before{background:var(--purple)}.s-mint::before{background:var(--mint)}.s-yellow::before{background:var(--yellow)}
.stat-val{font-size:26px;font-weight:900;line-height:1;margin-bottom:3px}
.s-pink .stat-val{color:var(--pink)}.s-purple .stat-val{color:var(--purple)}.s-mint .stat-val{color:var(--mint)}.s-yellow .stat-val{color:var(--yellow)}
.stat-label{font-size:11px;color:var(--muted);font-weight:700}
/* Form */
.form-group{margin-bottom:12px}
.form-label{display:block;font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px}
.form-input,.form-select,.form-textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--r-sm);padding:9px 12px;color:var(--text);font-family:inherit;font-size:13px;font-weight:600;outline:none;transition:.15s}
.form-input:focus,.form-select:focus,.form-textarea:focus{border-color:var(--purple);box-shadow:0 0 0 3px rgba(167,139,250,.12)}
.form-input::placeholder{color:var(--muted)}.form-select option{background:var(--bg2)}
.form-textarea{resize:vertical;min-height:120px;font-family:'Courier New',monospace;font-size:12px;line-height:1.6}
.form-row{display:flex;gap:10px}.form-row .form-group{flex:1}
/* Buttons */
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:20px;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;border:none;transition:.15s;white-space:nowrap;text-decoration:none}
.btn:hover{transform:translateY(-1px);text-decoration:none}
.btn-primary{background:linear-gradient(135deg,var(--pink),var(--purple));color:#fff;box-shadow:0 3px 12px rgba(244,114,182,.3)}
.btn-mint{background:linear-gradient(135deg,var(--mint),#10b981);color:#0f172a;box-shadow:0 3px 12px rgba(52,211,153,.3)}
.btn-danger{background:linear-gradient(135deg,var(--red),#dc2626);color:#fff;box-shadow:0 3px 12px rgba(248,113,113,.3)}
.btn-ghost{background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text)}
.btn-ghost:hover{background:rgba(255,255,255,.1)}
.btn-sm{padding:6px 12px;font-size:11px;border-radius:10px}
.btn-group{display:flex;gap:8px;flex-wrap:wrap}
/* Table */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid var(--border)}
td{padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.04);font-weight:600;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
/* Badge */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:800}
.badge-pink{background:rgba(244,114,182,.15);color:var(--pink);border:1px solid rgba(244,114,182,.2)}
.badge-mint{background:rgba(52,211,153,.15);color:var(--mint);border:1px solid rgba(52,211,153,.2)}
.badge-purple{background:rgba(167,139,250,.15);color:var(--purple);border:1px solid rgba(167,139,250,.2)}
.badge-red{background:rgba(248,113,113,.15);color:var(--red);border:1px solid rgba(248,113,113,.2)}
.badge-off{background:rgba(255,255,255,.06);color:var(--muted2);border:1px solid var(--border)}
/* Alert */
.alert{display:flex;align-items:flex-start;gap:9px;padding:11px 14px;border-radius:var(--r-sm);font-size:13px;font-weight:700;margin-bottom:12px}
.alert-success{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.2);color:var(--mint)}
.alert-danger{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.2);color:var(--red)}
.alert-warn{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.2);color:var(--yellow)}
.alert-info{background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.2);color:var(--purple)}
/* Toggle */
.toggle{position:relative;width:38px;height:21px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:rgba(255,255,255,.1);border-radius:20px;cursor:pointer;transition:.2s}
.toggle-slider::before{content:'';position:absolute;left:3px;top:3px;width:15px;height:15px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.toggle-slider{background:linear-gradient(90deg,var(--pink),var(--purple))}
.toggle input:checked+.toggle-slider::before{transform:translateX(17px)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.toggle-row:last-child{border-bottom:none}
.toggle-info h4{font-size:13px;font-weight:800;margin-bottom:2px}
.toggle-info p{font-size:11px;color:var(--muted)}
/* Code */
.code{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;font-family:'Courier New',monospace;font-size:12px;color:var(--mint);overflow-x:auto;line-height:1.6;position:relative}
.code-copy{position:absolute;top:7px;right:7px;background:rgba(255,255,255,.08);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;color:var(--muted2);cursor:pointer;font-family:inherit}
.code-copy:hover{color:var(--text)}
/* Key box */
.key-box{display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:var(--r-sm);padding:9px 12px;margin-bottom:8px}
.key-val{flex:1;font-family:'Courier New',monospace;font-size:12px;color:var(--purple);word-break:break-all}
.key-btn{background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);color:var(--purple);border-radius:6px;padding:4px 9px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s}
.key-btn:hover{background:rgba(167,139,250,.22)}
.key-btn.del{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.25);color:var(--red)}
.key-btn.del:hover{background:rgba(248,113,113,.22)}
/* Divider */
.divider{height:1px;background:var(--border);margin:16px 0}
/* Login */
#login-page{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:999}
#login-page::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 70% 60% at 20% 20%,rgba(167,139,250,.18) 0%,transparent 60%),radial-gradient(ellipse 60% 50% at 80% 80%,rgba(244,114,182,.12) 0%,transparent 60%)}
.login-box{background:rgba(30,30,46,.9);border:1px solid var(--border);border-radius:16px;padding:32px 28px;width:100%;max-width:360px;backdrop-filter:blur(20px);box-shadow:0 20px 60px rgba(0,0,0,.4);position:relative;z-index:1}
.login-icon{width:54px;height:54px;background:linear-gradient(135deg,var(--pink),var(--purple));border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 14px;box-shadow:0 6px 20px rgba(244,114,182,.35)}
.login-title{text-align:center;font-size:20px;font-weight:900;margin-bottom:4px}
.login-title span{background:linear-gradient(90deg,var(--pink),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.login-sub{text-align:center;font-size:12px;color:var(--muted);margin-bottom:22px}
/* Modal */
.modal{position:fixed;inset:0;background:rgba(5,5,15,.8);backdrop-filter:blur(8px);z-index:200;display:none;align-items:center;justify-content:center;padding:20px}
.modal.open{display:flex}
.modal-box{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:22px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.modal-title{font-size:15px;font-weight:900;margin-bottom:4px}
.modal-sub{font-size:12px;color:var(--muted);margin-bottom:18px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
/* Responsive */
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);transition:.3s cubic-bezier(.4,0,.2,1)}
  .sidebar.open{transform:translateX(0);box-shadow:4px 0 24px rgba(0,0,0,.4)}
  .main{margin-left:0}
  .hbg{display:flex}
  .content{padding:14px}
  .form-row{flex-direction:column}
  .stats{grid-template-columns:repeat(2,1fr)}
}

</style>
</head>
<body>
<div class="wrap">
  <nav class="sidebar" id="sidebar">
    <div class="sidebar-logo">
      <div class="logo-main">WA-API Panel</div>
      <div class="logo-sub">MAKLOWHH — Admin</div>
    </div>
    <div class="nav">
      <div class="nav-label">Overview</div>
      <a class="nav-item${activeNav==='dashboard'?' active':''}" href="/panel/dashboard"><span class="nav-icon">📊</span> Dashboard</a>
      <div class="nav-label">Functions</div>
      <a class="nav-item${activeNav==='functions'?' active':''}" href="/panel/functions"><span class="nav-icon">⚡</span> Manage Functions</a>
      <a class="nav-item${activeNav==='add-func'?' active':''}" href="/panel/add-func"><span class="nav-icon">➕</span> Add Function</a>
      <div class="nav-label">Security</div>
      <a class="nav-item${activeNav==='apikeys'?' active':''}" href="/panel/apikeys"><span class="nav-icon">🔑</span> API Keys</a>
      <a class="nav-item${activeNav==='maintenance'?' active':''}" href="/panel/maintenance"><span class="nav-icon">🔧</span> Maintenance</a>
      <div class="nav-label">System</div>
      <a class="nav-item${activeNav==='backup'?' active':''}" href="/panel/backup"><span class="nav-icon">💾</span> Backup</a>
      <a class="nav-item${activeNav==='settings'?' active':''}" href="/panel/settings"><span class="nav-icon">⚙️</span> Settings</a>
    </div>
    <div class="sidebar-footer">
      <div class="status-pill"><div class="dot"></div><span>Panel Online</span></div>
    </div>
  </nav>
  <div class="main">
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:10px">
        <button class="hbg" onclick="toggleSidebar()">☰</button>
        <div class="topbar-title"><span>${title}</span></div>
      </div>
      <div class="topbar-right">
        <span style="font-size:12px;color:var(--muted)" id="clk"></span>
        <a href="/panel/logout" class="btn btn-ghost btn-sm">⬅ Logout</a>
      </div>
    </div>
    <div class="content">${body}</div>
  </div>
</div>
<div class="modal" id="modal">
  <div class="modal-box">
    <div class="modal-title" id="modal-title">Konfirmasi</div>
    <div class="modal-sub" id="modal-sub">Apakah kamu yakin?</div>
    <div id="modal-body"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
      <button class="btn btn-danger btn-sm" id="modal-ok">Ya, Lanjutkan</button>
    </div>
  </div>
</div>
<script>
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open')}
function closeSidebar(){document.getElementById('sidebar').classList.remove('open')}
function openModal(title,sub,action){document.getElementById('modal-title').textContent=title;document.getElementById('modal-sub').textContent=sub;document.getElementById('modal').classList.add('open');document.getElementById('modal-ok').onclick=()=>{closeModal();action()}}
function closeModal(){document.getElementById('modal').classList.remove('open')}
function copyText(t){navigator.clipboard.writeText(t).then(()=>{const b=event.target;const o=b.textContent;b.textContent='✅';setTimeout(()=>b.textContent=o,1500)})}
;(function clk(){const el=document.getElementById('clk');if(el)el.textContent=new Date().toLocaleTimeString('id-ID');setTimeout(clk,1000)})();
</script>
</body></html>`
}

function loginPage(err = '') {
    return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — WA-API Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f0f17;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 70% 60% at 20% 20%,rgba(167,139,250,.18) 0%,transparent 60%),radial-gradient(ellipse 60% 50% at 80% 80%,rgba(244,114,182,.12) 0%,transparent 60%);pointer-events:none}
.box{background:rgba(30,30,46,.9);border:1px solid #2a2a3f;border-radius:16px;padding:32px 28px;width:100%;max-width:360px;backdrop-filter:blur(20px);box-shadow:0 20px 60px rgba(0,0,0,.4);position:relative;z-index:1}
.icon{width:54px;height:54px;background:linear-gradient(135deg,#f472b6,#a78bfa);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 14px;box-shadow:0 6px 20px rgba(244,114,182,.35)}
h1{text-align:center;font-size:20px;font-weight:900;background:linear-gradient(90deg,#f472b6,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.sub{text-align:center;font-size:12px;color:#64748b;margin-bottom:22px}
.err{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.25);color:#f87171;border-radius:6px;padding:10px 13px;font-size:12px;font-weight:700;margin-bottom:13px;display:${err?'block':'none'}}
.label{display:block;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px}
input{width:100%;background:rgba(255,255,255,.04);border:1px solid #2a2a3f;border-radius:6px;padding:10px 13px;color:#e2e8f0;font-family:inherit;font-size:13px;font-weight:600;outline:none;margin-bottom:12px;transition:.15s}
input:focus{border-color:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.12)}
button{width:100%;padding:11px;background:linear-gradient(135deg,#f472b6,#a78bfa);color:#fff;border:none;border-radius:20px;font-family:inherit;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 3px 12px rgba(244,114,182,.3)}
</style></head>
<body><div class="box">
<div class="icon">🔐</div>
<h1>WA-API Panel</h1>
<div class="sub">Akses terbatas — Admin only</div>
<div class="err">${err}</div>
<form method="POST" action="/panel/login">
<label class="label">Username</label>
<input name="username" type="text" placeholder="admindhann" autocomplete="off" required>
<label class="label">Password</label>
<input name="password" type="password" placeholder="••••••••" required>
<button type="submit">🔑 Masuk</button>
</form>
</div></body></html>`
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Redirect root /panel ke dashboard
app.get('/panel', auth, (req, res) => res.redirect('/panel/dashboard'))
app.get('/', (req, res) => res.redirect('/panel'))

// Login
app.get('/panel/login', (req, res) => {
    if (req.session?.loggedIn) return res.redirect('/panel/dashboard')
    res.send(loginPage())
})

app.post('/panel/login', rateLimit, async (req, res) => {
    const { username, password } = req.body
    const data = loadData()
    const rec  = loginAttempts.get(req.ip) || { count: 0, reset: Date.now() + 300000 }
    const ok   = username === data.username && await bcrypt.compare(password, data.password)
    if (!ok) {
        rec.count++
        loginAttempts.set(req.ip, rec)
        return res.send(loginPage('Username atau password salah.'))
    }
    loginAttempts.delete(req.ip)
    req.session.loggedIn = true
    res.redirect('/panel/dashboard')
})

app.get('/panel/logout', (req, res) => {
    req.session.destroy()
    res.redirect('/panel/login')
})

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/panel/dashboard', auth, async (req, res) => {
    const db   = loadDb()
    const data = loadData()
    const funcsDir = fs.existsSync(FUNC_DIR) ? fs.readdirSync(FUNC_DIR).filter(f => f.endsWith('.js')) : []
    const activeKeys = (data.apiKeys || []).filter(k => k.active && (!k.exp || new Date(k.exp) > new Date()))

    // Cek status wa-api
    let apiStatus = '❓ Unknown'
    try {
        const axios = require('axios')
        const r = await axios.get('http://localhost:2578/api/status', { timeout: 3000 })
        if (r.data?.success) apiStatus = `✅ Online — uptime ${r.data.uptime_sec}s, mem ${r.data.memory_mb}MB`
    } catch { apiStatus = '❌ Offline atau tidak bisa dihubungi' }

    const body = `
<div class="stats">
  <div class="stat s-pink"><div class="stat-val">${db.length}</div><div class="stat-label">Functions</div></div>
  <div class="stat s-purple"><div class="stat-val">${activeKeys.length}</div><div class="stat-label">API Keys Aktif</div></div>
  <div class="stat s-mint"><div class="stat-val">${funcsDir.length}</div><div class="stat-label">File di /function</div></div>
  <div class="stat s-yellow"><div class="stat-val">${data.backups?.length || 0}</div><div class="stat-label">Backup Tersimpan</div></div>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-mint">📡</div>Status wa-api</div>
  <div class="alert alert-info">${apiStatus}</div>
  <div class="card-title" style="margin-top:12px"><div class="ct-icon ct-purple">⚡</div>Functions Terdaftar</div>
  ${db.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${db.map(f=>`<span class="badge badge-purple">${f.type}</span>`).join('')}</div>` : '<p style="color:var(--muted)">Tidak ada function</p>'}
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-yellow">📂</div>File di /function/</div>
  ${funcsDir.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${funcsDir.map(f=>`<span class="badge badge-mint" style="font-family:monospace">${f}</span>`).join('')}</div>` : '<p style="color:var(--muted)">Folder kosong</p>'}
</div>`

    res.send(page('Dashboard', body, 'dashboard'))
})

// ── Functions ─────────────────────────────────────────────────────────────────
app.get('/panel/functions', auth, (req, res) => {
    const db = loadDb()
    const rows = db.map((f, i) => `
      <tr>
        <td><span class="badge badge-purple">${f.type}</span></td>
        <td><code style="font-size:12px;color:var(--mint)">${f.file}</code></td>
        <td style="color:var(--muted)">${f.description || '—'}</td>
        <td>${f.active !== false ? '<span class="badge badge-mint">● Aktif</span>' : '<span class="badge badge-off">● Nonaktif</span>'}</td>
        <td>
          <div class="btn-group">
            <form method="POST" action="/panel/functions/toggle" style="display:inline">
              <input type="hidden" name="index" value="${i}">
              <button class="btn btn-ghost btn-sm" type="submit">${f.active !== false ? '⏸' : '▶'}</button>
            </form>
            <button class="btn btn-danger btn-sm" onclick="confirmDelete(${i},'${f.type}')">🗑</button>
          </div>
        </td>
      </tr>`).join('')

    const body = `
<div class="card">
  <div class="card-title"><div class="ct-icon ct-pink">⚡</div>Registered Functions</div>
  ${db.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:20px">Tidak ada function terdaftar</p>' : `
  <div class="table-wrap">
    <table>
      <thead><tr><th>Type</th><th>File</th><th>Description</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`}
  <div style="margin-top:12px"><a href="/panel/add-func" class="btn btn-primary btn-sm">➕ Tambah Function</a></div>
</div>
<form id="del-form" method="POST" action="/panel/functions/delete" style="display:none">
  <input type="hidden" name="index" id="del-idx">
</form>
<script>
function confirmDelete(i, type) {
  openModal('Hapus Function', 'Hapus "' + type + '"? File .js di server TIDAK ikut dihapus.', () => {
    document.getElementById('del-idx').value = i;
    document.getElementById('del-form').submit();
  });
}
</script>`
    res.send(page('Manage Functions', body, 'functions'))
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
    res.redirect('/panel/functions')
})

// ── Add Function ──────────────────────────────────────────────────────────────
app.get('/panel/add-func', auth, (req, res) => {
    const msg = req.query.msg || ''
    const err = req.query.err || ''
    const body = `
${msg ? `<div class="alert alert-success">✅ ${msg}</div>` : ''}
${err ? `<div class="alert alert-danger">❌ ${err}</div>` : ''}
<div class="card">
  <div class="card-title"><div class="ct-icon ct-mint">📝</div>Paste Source Code</div>
  <form method="POST" action="/panel/add-func/paste">
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Type Name</label>
        <input class="form-input" name="type" placeholder="contoh: richtext" required>
      </div>
      <div class="form-group">
        <label class="form-label">File Name (.js)</label>
        <input class="form-input" name="file" placeholder="contoh: slof.js" required>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" name="description" placeholder="Deskripsi singkat">
    </div>
    <div class="form-group">
      <label class="form-label">Source Code JS</label>
      <textarea class="form-textarea" name="source" placeholder="async function nama(sock, jid) {
  // kode kamu
}
module.exports = nama;" style="min-height:200px" required></textarea>
    </div>
    <button class="btn btn-primary" type="submit">💾 Simpan</button>
  </form>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-yellow">⬆️</div>Upload File .js</div>
  <form method="POST" action="/panel/add-func/upload" enctype="multipart/form-data">
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Type Name</label>
        <input class="form-input" name="type" placeholder="myfunc" required>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-input" name="description" placeholder="Deskripsi">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">File .js</label>
      <input class="form-input" name="jsfile" type="file" accept=".js" required style="padding:7px">
    </div>
    <button class="btn btn-mint" type="submit">📦 Upload & Register</button>
  </form>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-purple">🌐</div>Fetch dari URL (wget)</div>
  <form method="POST" action="/panel/add-func/url">
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Type Name</label>
        <input class="form-input" name="type" placeholder="myfunc" required>
      </div>
      <div class="form-group">
        <label class="form-label">File Name (.js)</label>
        <input class="form-input" name="file" placeholder="myfunc.js" required>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">URL Raw File .js</label>
      <input class="form-input" name="url" type="url" placeholder="https://raw.githubusercontent.com/..." required>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" name="description" placeholder="Deskripsi">
    </div>
    <button class="btn btn-ghost" type="submit">⬇️ Fetch & Simpan</button>
  </form>
</div>`
    res.send(page('Add Function', body, 'add-func'))
})

app.post('/panel/add-func/paste', auth, (req, res) => {
    const { type, file, description, source } = req.body
    if (!type || !file || !source) return res.redirect('/panel/add-func?err=Isi semua field yang wajib')
    const db = loadDb()
    if (db.find(f => f.type === type)) return res.redirect('/panel/add-func?err=Type sudah ada')
    if (!fs.existsSync(FUNC_DIR)) fs.mkdirSync(FUNC_DIR, { recursive: true })
    const safeName = path.basename(file.endsWith('.js') ? file : file + '.js')
    fs.writeFileSync(path.join(FUNC_DIR, safeName), source)
    db.push({ type, file: safeName, description: description || '', active: true })
    saveDb(db)
    res.redirect('/panel/add-func?msg=Function "' + type + '" berhasil ditambah')
})

app.post('/panel/add-func/upload', auth, upload.single('jsfile'), (req, res) => {
    if (!req.file) return res.redirect('/panel/add-func?err=Tidak ada file yang diupload')
    const { type, description } = req.body
    const safeName = path.basename(req.file.originalname)
    if (!type) return res.redirect('/panel/add-func?err=Type tidak boleh kosong')
    const db = loadDb()
    if (db.find(f => f.type === type)) return res.redirect('/panel/add-func?err=Type sudah ada')
    if (!fs.existsSync(FUNC_DIR)) fs.mkdirSync(FUNC_DIR, { recursive: true })
    fs.writeFileSync(path.join(FUNC_DIR, safeName), req.file.buffer)
    db.push({ type, file: safeName, description: description || '', active: true })
    saveDb(db)
    res.redirect('/panel/add-func?msg=File "' + safeName + '" berhasil diupload dan diregister sebagai type "' + type + '"')
})

app.post('/panel/add-func/url', auth, async (req, res) => {
    const { type, file, url, description } = req.body
    if (!type || !file || !url) return res.redirect('/panel/add-func?err=Isi semua field')
    try {
        const axios  = require('axios')
        const r      = await axios.get(url, { responseType: 'text', timeout: 15000 })
        const safeName = path.basename(file.endsWith('.js') ? file : file + '.js')
        const db = loadDb()
        if (db.find(f => f.type === type)) return res.redirect('/panel/add-func?err=Type sudah ada')
        if (!fs.existsSync(FUNC_DIR)) fs.mkdirSync(FUNC_DIR, { recursive: true })
        fs.writeFileSync(path.join(FUNC_DIR, safeName), r.data)
        db.push({ type, file: safeName, description: description || '', active: true })
        saveDb(db)
        res.redirect('/panel/add-func?msg=Function "' + type + '" berhasil difetch dari URL')
    } catch (e) {
        res.redirect('/panel/add-func?err=Gagal fetch: ' + encodeURIComponent(e.message))
    }
})

// ── API Keys ──────────────────────────────────────────────────────────────────
app.get('/panel/apikeys', auth, (req, res) => {
    const data = loadData()
    const keys = data.apiKeys || []
    const msg  = req.query.msg || ''
    const keyRows = keys.map((k, i) => {
        const expired = k.exp && new Date(k.exp) < new Date()
        return `
        <div class="key-box">
          <span class="badge ${expired ? 'badge-red' : k.active ? 'badge-mint' : 'badge-off'}" style="margin-right:8px">${expired ? 'Expired' : k.active ? 'Aktif' : 'Nonaktif'}</span>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:800;margin-bottom:3px">${k.label}</div>
            <div class="key-val">${k.key}</div>
            ${k.exp ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">Exp: ${new Date(k.exp).toLocaleDateString('id-ID')}</div>` : ''}
          </div>
          <button class="key-btn" onclick="copyText('${k.key}')">Copy</button>
          <form method="POST" action="/panel/apikeys/delete" style="display:inline;margin-left:4px">
            <input type="hidden" name="index" value="${i}">
            <button class="key-btn del" type="submit">🗑</button>
          </form>
        </div>`
    }).join('')

    const body = `
${msg ? `<div class="alert alert-success">✅ ${msg}</div>` : ''}
<div class="card">
  <div class="card-title"><div class="ct-icon ct-purple">✨</div>Generate API Key Baru</div>
  <form method="POST" action="/panel/apikeys/generate">
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Label</label>
        <input class="form-input" name="label" placeholder="dhann-bot-prod" required>
      </div>
      <div class="form-group">
        <label class="form-label">Expiry (hari, kosong = no exp)</label>
        <input class="form-input" name="exp" type="number" placeholder="30">
      </div>
    </div>
    <button class="btn btn-primary" type="submit">🔑 Generate Key</button>
  </form>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-pink">📋</div>API Keys Aktif (${keys.length})</div>
  ${keys.length ? keyRows : '<p style="color:var(--muted)">Belum ada API key. Generate dulu.</p>'}
</div>`
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
    // Update juga config wa-api
    updateWaApiKey(data.apiKeys)
    res.redirect('/panel/apikeys?msg=API Key berhasil dibuat')
})

app.post('/panel/apikeys/delete', auth, (req, res) => {
    const data = loadData()
    const idx  = parseInt(req.body.index)
    if (idx >= 0 && idx < data.apiKeys.length) data.apiKeys.splice(idx, 1)
    saveData(data)
    updateWaApiKey(data.apiKeys)
    res.redirect('/panel/apikeys?msg=API Key dihapus')
})

// Sync API key pertama yang aktif ke config wa-api
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
    const data  = loadData()
    const db    = loadDb()
    const maint = data.maint || { api: false, web: false, msg: '' }
    const msg   = req.query.msg || ''

    const funcToggles = db.map((f, i) => `
      <div class="toggle-row">
        <div class="toggle-info">
          <h4><span class="badge badge-purple" style="margin-right:6px">${f.type}</span>${f.file}</h4>
          <p>${f.description || '—'}</p>
        </div>
        <form method="POST" action="/panel/maintenance/func" style="display:inline">
          <input type="hidden" name="index" value="${i}">
          <label class="toggle"><input type="checkbox" ${f.active !== false ? 'checked' : ''} onchange="this.form.submit()"><span class="toggle-slider"></span></label>
        </form>
      </div>`).join('')

    const body = `
${msg ? `<div class="alert alert-success">✅ ${msg}</div>` : ''}
<div class="card">
  <div class="card-title"><div class="ct-icon ct-yellow">🔧</div>Mode Maintenance Global</div>
  <form method="POST" action="/panel/maintenance/save">
    <div class="toggle-row">
      <div class="toggle-info"><h4>Maintenance API (/api/source)</h4><p>Semua request ke /api/source return 503</p></div>
      <label class="toggle"><input type="checkbox" name="api" ${maint.api ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info"><h4>Maintenance Web/Panel</h4><p>Tampilkan banner maintenance di halaman publik</p></div>
      <label class="toggle"><input type="checkbox" name="web" ${maint.web ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    <div class="divider"></div>
    <div class="form-group">
      <label class="form-label">Pesan Maintenance</label>
      <input class="form-input" name="msg" value="${maint.msg || ''}" placeholder="Server sedang dalam pemeliharaan...">
    </div>
    <button class="btn btn-primary" type="submit">💾 Simpan</button>
  </form>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-pink">⚡</div>Maintenance per Function</div>
  ${db.length ? funcToggles : '<p style="color:var(--muted)">Tidak ada function terdaftar</p>'}
</div>`
    res.send(page('Maintenance', body, 'maintenance'))
})

app.post('/panel/maintenance/save', auth, (req, res) => {
    const data  = loadData()
    data.maint  = { api: !!req.body.api, web: !!req.body.web, msg: req.body.msg || '' }
    saveData(data)
    // Update wa-api server juga kalau perlu (via file flag)
    fs.writeFileSync(path.join(WA_API_DIR, '.maintenance.json'), JSON.stringify(data.maint))
    res.redirect('/panel/maintenance?msg=Maintenance mode disimpan')
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
    const data = loadData()
    const msg  = req.query.msg || ''
    const backups = (data.backups || []).map((b, i) => `
      <tr>
        <td style="font-family:monospace;font-size:12px">${b.ts}</td>
        <td>${b.funcCount} functions</td>
        <td>${b.keyCount} keys</td>
        <td><a href="/panel/backup/download/${i}" class="btn btn-ghost btn-sm">⬇️ Download</a></td>
      </tr>`).join('')

    const body = `
${msg ? `<div class="alert alert-success">✅ ${msg}</div>` : ''}
<div class="card">
  <div class="card-title"><div class="ct-icon ct-mint">💾</div>Backup Sekarang</div>
  <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Backup berisi database.json, daftar API key, dan pengaturan maintenance.</p>
  <form method="POST" action="/panel/backup/create">
    <button class="btn btn-mint" type="submit">📦 Buat Backup</button>
  </form>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-purple">📋</div>Riwayat Backup (${(data.backups||[]).length})</div>
  ${(data.backups||[]).length ? `
  <div class="table-wrap"><table>
    <thead><tr><th>Waktu</th><th>Functions</th><th>Keys</th><th>Aksi</th></tr></thead>
    <tbody>${backups}</tbody>
  </table></div>` : '<p style="color:var(--muted)">Belum ada backup</p>'}
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
        apiKeys: (data.apiKeys || []).map(k => ({ ...k, key: k.key.slice(0,8) + '...' })), // mask key
        maint: data.maint,
    }
    data.backups = data.backups || []
    data.backups.unshift(backup)
    if (data.backups.length > 10) data.backups = data.backups.slice(0, 10) // max 10 backup
    saveData(data)
    res.redirect('/panel/backup?msg=Backup berhasil dibuat')
})

app.get('/panel/backup/download/:idx', auth, (req, res) => {
    const data   = loadData()
    const backup = (data.backups || [])[parseInt(req.params.idx)]
    if (!backup) return res.status(404).send('Backup tidak ditemukan')
    res.setHeader('Content-Disposition', `attachment; filename="wa-api-backup-${backup.ts.replace(/[:.]/g,'-')}.json"`)
    res.json(backup)
})

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/panel/settings', auth, (req, res) => {
    const msg = req.query.msg || ''
    const err = req.query.err || ''
    const body = `
${msg ? `<div class="alert alert-success">✅ ${msg}</div>` : ''}
${err ? `<div class="alert alert-danger">❌ ${err}</div>` : ''}
<div class="card">
  <div class="card-title"><div class="ct-icon ct-purple">⚙️</div>Ubah Kredensial Admin</div>
  <div class="alert alert-warn">⚠️ Pastikan kamu ingat username/password baru sebelum menyimpan.</div>
  <form method="POST" action="/panel/settings/save">
    <div class="form-group">
      <label class="form-label">Username Baru</label>
      <input class="form-input" name="username" placeholder="Kosongkan jika tidak ingin ganti">
    </div>
    <div class="form-group">
      <label class="form-label">Password Baru</label>
      <input class="form-input" name="password" type="password" placeholder="Kosongkan jika tidak ingin ganti">
    </div>
    <div class="form-group">
      <label class="form-label">Konfirmasi Password</label>
      <input class="form-input" name="password2" type="password" placeholder="Ulangi password baru">
    </div>
    <button class="btn btn-primary" type="submit">💾 Simpan</button>
  </form>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-yellow">📡</div>Info Server</div>
  <div class="code">
wa-api dir   : ${WA_API_DIR}
database.json: ${DB_PATH}
function dir : ${FUNC_DIR}
panel port   : ${PORT}
node version : ${process.version}
uptime       : ${Math.floor(process.uptime())}s
  </div>
</div>
<div class="card">
  <div class="card-title"><div class="ct-icon ct-red">⚠️</div>Danger Zone</div>
  <div class="alert alert-danger" style="margin-bottom:12px">Tindakan ini tidak dapat dibatalkan.</div>
  <div class="btn-group">
    <form method="POST" action="/panel/settings/clear-keys" onsubmit="return confirm('Hapus SEMUA API key?')">
      <button class="btn btn-danger btn-sm" type="submit">🗑 Hapus Semua API Keys</button>
    </form>
  </div>
</div>`
    res.send(page('Settings', body, 'settings'))
})

app.post('/panel/settings/save', auth, async (req, res) => {
    const { username, password, password2 } = req.body
    const data = loadData()
    if (password && password !== password2) return res.redirect('/panel/settings?err=Password tidak sama')
    if (username) data.username = username
    if (password) data.password = await bcrypt.hash(password, 12)
    saveData(data)
    req.session.destroy()
    res.redirect('/panel/login')
})

app.post('/panel/settings/clear-keys', auth, (req, res) => {
    const data = loadData()
    data.apiKeys = []
    saveData(data)
    updateWaApiKey([])
    res.redirect('/panel/settings?msg=Semua API key dihapus')
})

// ── Start ─────────────────────────────────────────────────────────────────────
initData().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[PANEL] ✅ Jalan di port ${PORT}`)
        console.log(`[PANEL] 📁 WA-API dir: ${WA_API_DIR}`)
        console.log(`[PANEL] 🔐 Login: admindhann / dhann123123*`)
    })
})
