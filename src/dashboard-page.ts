/**
 * The dashboard page shell.
 *
 * Served by the embedded gateway at `/`. It is deliberately dependency-free:
 * one HTML document with inline CSS/JS, every read/write going through the
 * authenticated `/_api` channel.
 */

/** Escape arbitrary text for HTML/attribute insertion. */
export function escapeHTML(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/**
 * Render the dashboard shell. The process token is embedded so the same-origin
 * page can call `/_api`; it never leaves the loopback interface.
 */
export function dashboardHTML(token: string, _options: { dashboardUrl?: string } = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cline Pass · opencode</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0b0e14; --panel:#111722; --panel-2:#161e2b; --panel-3:#1b2433;
    --line:#263144; --line-soft:#1d2737; --text:#e8edf6; --muted:#8b98ad;
    --brand:#5b9dff; --brand-2:#8bbcff; --ok:#42c66b; --warn:#e0a92e; --bad:#ff6464;
    --radius:14px; --radius-sm:10px;
    --shadow:0 12px 32px rgba(0,0,0,.28);
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html { scroll-behavior:smooth; }
  body {
    margin:0; background:
      radial-gradient(1100px 500px at 15% -10%, rgba(91,157,255,.10), transparent 60%),
      radial-gradient(900px 420px at 95% 0%, rgba(120,90,255,.08), transparent 60%),
      var(--bg);
    color:var(--text); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  a { color:var(--brand-2); text-decoration:none; }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .topbar {
    position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:16px;
    padding:12px 22px; background:rgba(11,14,20,.82); backdrop-filter:blur(14px);
    border-bottom:1px solid var(--line-soft);
  }
  .brand { display:flex; align-items:center; gap:10px; min-width:0; }
  .logo {
    width:34px; height:34px; border-radius:10px; display:grid; place-items:center;
    background:linear-gradient(145deg,#2f6dde,#7a5cff); color:#fff; font-weight:700; font-size:13px;
    box-shadow:0 4px 14px rgba(70,110,220,.35);
  }
  .brand h1 { margin:0; font-size:16px; letter-spacing:.2px; }
  .brand-sub { display:flex; align-items:center; gap:8px; margin-top:2px; min-width:0; }
  .brand-sub .mono { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:46vw; }
  .nav { display:flex; align-items:center; gap:2px; flex:1; min-width:0; overflow:auto; }
  .nav a { color:var(--muted); padding:6px 9px; border-radius:8px; font-size:13px; white-space:nowrap; }
  .nav a:hover { color:var(--text); background:var(--panel-2); }
  .top-actions { display:flex; align-items:center; gap:8px; }
  main { max-width:1240px; margin:0 auto; padding:20px 22px 70px; display:flex; flex-direction:column; gap:16px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .stat {
    border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:linear-gradient(180deg,var(--panel-2),var(--panel));
    padding:11px 14px; display:flex; flex-direction:column; gap:2px;
  }
  .stat strong { font-size:20px; line-height:1.15; font-weight:650; }
  .stat strong.small { font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .stat span { color:var(--muted); font-size:12px; }
  .section {
    border:1px solid var(--line-soft); border-radius:var(--radius); background:linear-gradient(180deg,rgba(22,30,43,.9),rgba(17,23,34,.9));
    box-shadow:var(--shadow); scroll-margin-top:76px;
  }
  .section-head { display:flex; align-items:flex-start; gap:14px; padding:15px 18px; border-bottom:1px solid var(--line-soft); flex-wrap:wrap; }
  .section-head h2 { margin:0; font-size:15px; font-weight:650; letter-spacing:.2px; }
  .section-head .sub { margin:3px 0 0; color:var(--muted); font-size:12px; }
  .section-head .actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .section-body { padding:16px 18px; display:flex; flex-direction:column; gap:14px; }
  .row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .spacer { flex:1; }
  .muted { color:var(--muted); }
  .err { color:var(--bad); }
  .ok { color:var(--ok); }
  .warn { color:var(--warn); }
  .pill {
    border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px;
    color:var(--muted); background:var(--panel-2); white-space:nowrap;
  }
  .pill.ok { color:var(--ok); border-color:rgba(66,198,107,.35); background:rgba(66,198,107,.08); }
  .pill.bad { color:var(--bad); border-color:rgba(255,100,100,.35); background:rgba(255,100,100,.08); }
  .tag {
    display:inline-flex; align-items:center; gap:4px; border:1px solid var(--line); border-radius:999px;
    padding:1px 8px; font-size:11px; color:var(--muted); background:rgba(255,255,255,.02); white-space:nowrap;
  }
  .tag.ok { color:var(--ok); border-color:rgba(66,198,107,.35); background:rgba(66,198,107,.08); }
  .tag.warn { color:var(--warn); border-color:rgba(224,169,46,.35); background:rgba(224,169,46,.08); }
  .tag.bad { color:var(--bad); border-color:rgba(255,100,100,.35); background:rgba(255,100,100,.08); }
  .tag.brand { color:var(--brand-2); border-color:rgba(91,157,255,.4); background:rgba(91,157,255,.10); }
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    background:var(--panel-3); color:var(--text); border:1px solid var(--line);
    border-radius:9px; padding:6px 11px; cursor:pointer; font-size:13px; line-height:1.3;
    transition:border-color .12s, background .12s, transform .06s;
  }
  .btn:hover { border-color:var(--brand); background:#202b3d; }
  .btn:active { transform:translateY(1px); }
  .btn.primary { background:linear-gradient(180deg,#2a5aa8,#224a8c); border-color:#3b6fc4; }
  .btn.primary:hover { background:linear-gradient(180deg,#3166bd,#27539d); }
  .btn.danger { color:var(--bad); border-color:rgba(255,100,100,.28); }
  .btn.ghost { background:transparent; border-color:transparent; color:var(--muted); }
  .btn.ghost:hover { color:var(--text); border-color:var(--line); background:var(--panel-3); }
  .btn.mini { padding:3px 8px; font-size:11px; border-radius:7px; }
  .btn:disabled { opacity:.55; cursor:not-allowed; }
  .btn.busy { opacity:.85; }
  input[type=text], input[type=password], select, textarea {
    background:var(--panel-2); color:var(--text); border:1px solid var(--line);
    border-radius:8px; padding:6px 9px; min-width:0; font:inherit; font-size:13px;
  }
  input:focus, select:focus, textarea:focus { outline:2px solid rgba(91,157,255,.35); outline-offset:1px; }
  input::placeholder { color:#647086; }
  .search { min-width:200px; flex:1; max-width:360px; }
  .field { display:inline-flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
  .field select { color:var(--text); }
  .check { display:inline-flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; cursor:pointer; user-select:none; }
  input[type=checkbox] { accent-color:var(--brand); }
  .toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; align-items:center; }
  .form-actions { display:flex; gap:8px; }
  .table-wrap { overflow:auto; border:1px solid var(--line-soft); border-radius:var(--radius-sm); }
  .table { width:100%; border-collapse:collapse; min-width:620px; }
  .table th, .table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line-soft); vertical-align:middle; }
  .table th { color:var(--muted); font-size:11px; font-weight:600; letter-spacing:.3px; text-transform:uppercase; background:rgba(255,255,255,.015); position:sticky; top:0; z-index:1; }
  .table tr:last-child td { border-bottom:0; }
  .table tbody tr:hover td { background:rgba(91,157,255,.035); }
  .table td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .model-list { display:flex; flex-direction:column; gap:10px; }
  .model-card {
    border:1px solid var(--line-soft); border-radius:12px; background:var(--panel-2); overflow:hidden;
  }
  .model-card[open] { border-color:#33445e; }
  .model-card > summary {
    list-style:none; cursor:pointer; display:grid; grid-template-columns:auto 1fr auto;
    gap:10px; align-items:center; padding:11px 13px; user-select:none;
  }
  .model-card > summary::-webkit-details-marker { display:none; }
  .model-card > summary:hover { background:rgba(91,157,255,.05); }
  .pin-dot { width:9px; height:9px; border-radius:50%; background:#46546b; box-shadow:0 0 0 3px rgba(70,84,107,.15); }
  .pin-dot.on { background:var(--brand); box-shadow:0 0 0 3px rgba(91,157,255,.16); }
  .model-title { min-width:0; display:flex; flex-direction:column; gap:3px; }
  .model-title-row { display:flex; align-items:center; gap:7px; flex-wrap:wrap; min-width:0; }
  .model-id { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
  .model-sub { font-size:11.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chevron { color:var(--muted); transition:transform .15s; font-size:18px; line-height:1; }
  .model-card[open] .chevron { transform:rotate(90deg); }
  .model-body { border-top:1px solid var(--line-soft); padding:13px; display:flex; flex-direction:column; gap:14px; }
  .model-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .model-toolbar .times { margin-left:auto; color:var(--muted); font-size:11.5px; }
  .block { border:1px solid var(--line-soft); border-radius:10px; padding:11px; background:rgba(11,14,20,.35); display:flex; flex-direction:column; gap:9px; }
  .block-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .block-head b { font-size:12.5px; }
  .pin-chain { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-height:26px; }
  .pin-node {
    display:inline-flex; align-items:center; gap:3px; border:1px solid rgba(91,157,255,.45);
    background:rgba(91,157,255,.11); border-radius:999px; padding:2px 3px 2px 9px; font-size:11.5px;
  }
  .pin-node .idx { color:var(--brand-2); font-weight:700; margin-right:2px; }
  .pin-node .pname { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pin-node button, .exclude-node button {
    border:0; background:transparent; color:var(--muted); cursor:pointer; padding:0 3px; font-size:12px;
  }
  .pin-node button:hover, .exclude-node button:hover { color:var(--text); }
  .exclude-node { display:inline-flex; align-items:center; gap:3px; border:1px dashed rgba(224,169,46,.45); background:rgba(224,169,46,.07); border-radius:999px; padding:2px 4px 2px 9px; font-size:11.5px; color:var(--warn); }
  .channel-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(235px,1fr)); gap:7px; }
  .channel {
    border:1px solid var(--line-soft); border-radius:9px; padding:7px 8px; background:var(--panel);
    display:flex; flex-direction:column; gap:6px; min-width:0;
  }
  .channel.pinned { border-color:rgba(91,157,255,.55); background:rgba(91,157,255,.08); }
  .channel.excluded { opacity:.6; border-style:dashed; }
  .channel-head { display:flex; align-items:center; gap:6px; min-width:0; }
  .channel-name { font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .dot { width:7px; height:7px; border-radius:50%; background:#4a576d; flex:none; }
  .dot.ok { background:var(--ok); box-shadow:0 0 0 2px rgba(66,198,107,.12); }
  .dot.warn { background:var(--warn); }
  .dot.bad { background:var(--bad); }
  .dot.muted { background:#4a576d; }
  .channel-actions { display:flex; gap:4px; }
  .channel-actions .btn { flex:1; }
  .channel-note { font-size:10.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .subdetails { border:1px solid var(--line-soft); border-radius:9px; background:transparent; padding:0; }
  .subdetails > summary { cursor:pointer; padding:7px 10px; color:var(--muted); font-size:12px; }
  .subdetails > summary:hover { color:var(--text); }
  .subdetails-body { padding:0 10px 10px; }
  .test-result { border:1px solid var(--line-soft); border-radius:10px; padding:10px 11px; background:rgba(11,14,20,.35); display:flex; flex-direction:column; gap:7px; }
  .test-result.ok { border-color:rgba(66,198,107,.35); }
  .test-result.warn { border-color:rgba(224,169,46,.35); }
  .test-result.bad { border-color:rgba(255,100,100,.35); }
  .test-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-weight:600; font-size:12.5px; }
  .test-metrics { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--muted); font-size:11.5px; }
  .trace-list { display:flex; flex-direction:column; gap:3px; }
  .trace { display:flex; gap:8px; flex-wrap:wrap; font-size:11.5px; }
  .trace .mono { min-width:80px; }
  .empty { border:1px dashed var(--line); border-radius:10px; padding:18px; text-align:center; color:var(--muted); font-size:12.5px; }
  .empty.small { padding:10px; }
  .loading { display:flex; align-items:center; gap:8px; color:var(--muted); padding:14px; }
  .spinner { width:13px; height:13px; border:2px solid rgba(255,255,255,.18); border-top-color:var(--brand); border-radius:50%; display:inline-block; animation:spin .8s linear infinite; vertical-align:-2px; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .tabs { display:inline-flex; border:1px solid var(--line); border-radius:9px; overflow:hidden; background:var(--panel-2); }
  .tab { border:0; background:transparent; color:var(--muted); padding:6px 12px; cursor:pointer; font-size:12.5px; }
  .tab.active { background:rgba(91,157,255,.16); color:var(--brand-2); }
  .usage-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px; }
  .usage-card { border:1px solid var(--line-soft); border-radius:10px; padding:11px; background:var(--panel-2); display:flex; flex-direction:column; gap:9px; }
  .usage-head { display:flex; align-items:center; gap:8px; }
  .quota-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; }
  .quota { border:1px solid var(--line-soft); border-radius:9px; padding:8px 9px; background:var(--panel); }
  .quota-head { display:flex; align-items:baseline; justify-content:space-between; gap:6px; font-size:11.5px; color:var(--muted); }
  .quota-head b { color:var(--text); font-size:12px; }
  .bar { height:6px; border-radius:999px; background:var(--line); overflow:hidden; margin:7px 0 4px; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#3f7fe6,#6fb0ff); border-radius:999px; }
  .bar > i.warn { background:linear-gradient(90deg,#b8861f,#e0a92e); }
  .bar > i.bad { background:linear-gradient(90deg,#c23c3c,#ff6464); }
  .quota-foot { font-size:10.5px; color:var(--muted); }
  .visibility-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(245px,1fr)); gap:3px 12px; max-height:260px; overflow:auto; padding:2px; }
  .vis-item { display:flex; align-items:center; gap:7px; padding:4px 6px; border-radius:7px; font-size:11.5px; min-width:0; }
  .vis-item:hover { background:rgba(91,157,255,.05); }
  .vis-item .mono { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .subpanel { border:1px solid var(--line-soft); border-radius:10px; background:rgba(11,14,20,.3); }
  .subpanel > summary { cursor:pointer; padding:9px 11px; display:flex; align-items:center; gap:8px; }
  .subpanel > summary::-webkit-details-marker { display:none; }
  .subpanel > summary:hover { background:rgba(91,157,255,.05); }
  .subpanel-body { border-top:1px solid var(--line-soft); padding:10px 11px; display:flex; flex-direction:column; gap:9px; }
  .history-wrap { max-height:430px; overflow:auto; }
  .history-table { min-width:860px; }
  .history-error { color:var(--bad); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:320px; }
  .settings-row { display:flex; align-items:center; gap:14px; padding:9px 0; border-bottom:1px solid var(--line-soft); }
  .settings-row:last-child { border-bottom:0; }
  .settings-row .label { width:150px; color:var(--muted); font-size:12px; flex:none; }
  .settings-row code { background:var(--panel-2); border:1px solid var(--line-soft); border-radius:6px; padding:2px 7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .settings-row .value { min-width:0; flex:1; display:flex; align-items:center; gap:8px; }
  .settings-row .value code { max-width:100%; }
  #toast {
    position:fixed; right:20px; bottom:20px; z-index:50; max-width:min(560px,calc(100vw - 40px));
    background:#1b2433; border:1px solid var(--line); border-radius:11px; padding:11px 14px;
    box-shadow:var(--shadow); color:var(--text); font-size:13px; white-space:pre-wrap;
    opacity:0; transform:translateY(8px); pointer-events:none; transition:opacity .16s, transform .16s;
  }
  #toast.show { opacity:1; transform:translateY(0); }
  #toast.ok { border-color:rgba(66,198,107,.5); }
  #toast.warn { border-color:rgba(224,169,46,.5); }
  #toast.error { border-color:rgba(255,100,100,.55); }
  .nowrap { white-space:nowrap; }
  .fade-in { animation:fade .18s ease-out; }
  @keyframes fade { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }
  @media (max-width:820px) {
    .topbar { flex-wrap:wrap; padding:10px 14px; }
    .nav { order:3; flex-basis:100%; }
    main { padding:14px 14px 60px; }
    .section-head, .section-body { padding-left:13px; padding-right:13px; }
    .settings-row { flex-wrap:wrap; }
    .settings-row .label { width:100%; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="logo">CP</div>
    <div>
      <h1>Cline Pass</h1>
      <div class="brand-sub"><span id="status" class="pill">加载中</span><span id="provider" class="mono muted"></span></div>
    </div>
  </div>
  <nav class="nav">
    <a href="#accounts">账号</a><a href="#usage">额度</a><a href="#models">模型</a><a href="#history">历史</a><a href="#settings">设置</a>
  </nav>
  <div class="top-actions">
    <span id="build" class="muted mono nowrap"></span>
    <button class="btn ghost" id="copy-dashboard">复制地址</button>
    <button class="btn primary" id="refresh-all">刷新</button>
  </div>
</header>

<main>
  <div class="stats">
    <div class="stat"><strong id="stat-accounts">–</strong><span>账号</span></div>
    <div class="stat"><strong id="stat-visible">–</strong><span>可见模型</span></div>
    <div class="stat"><strong id="stat-pinned">–</strong><span>已钉住</span></div>
    <div class="stat"><strong id="stat-history">–</strong><span>请求历史</span></div>
    <div class="stat"><strong id="stat-effective" class="small">–</strong><span>当前账号</span></div>
  </div>

  <section class="section" id="accounts">
    <div class="section-head">
      <div><h2>账号池</h2><p class="sub" id="account-hint">加载中…</p></div>
      <div class="actions"><button class="btn" id="account-add-toggle">+ 添加账号</button></div>
    </div>
    <div class="section-body">
      <div class="toolbar">
        <label class="field">模式<select id="account-mode"><option value="single">single · 固定账号</option><option value="roundrobin">roundrobin · 轮询</option></select></label>
        <label class="field">当前账号<select id="active-account"></select></label>
        <button class="btn primary" id="account-mode-save">保存模式</button>
        <span class="muted" id="account-mode-note"></span>
      </div>
      <form class="form-grid" id="account-add-form" hidden>
        <input id="new-account-name" type="text" placeholder="账号名，如 main" required>
        <input id="new-account-key" type="password" placeholder="sk_…（只写入凭据库）">
        <input id="new-account-display" type="text" placeholder="显示名（可选）">
        <input id="new-account-base" type="text" placeholder="独立 baseURL（可选）">
        <div class="form-actions"><button class="btn primary" type="submit">添加</button><button class="btn" type="button" id="account-add-cancel">取消</button></div>
      </form>
      <div class="table-wrap"><table class="table" id="account-table"></table></div>
    </div>
  </section>

  <section class="section" id="usage">
    <div class="section-head">
      <div><h2>额度与用量</h2><p class="sub" id="usage-hint">官方额度窗口与每日模型用量</p></div>
      <div class="actions">
        <div class="tabs" id="usage-tabs"><button class="tab active" data-usage-tab="quota">额度</button><button class="tab" data-usage-tab="daily">每日用量</button></div>
        <button class="btn" id="usage-refresh">刷新</button>
      </div>
    </div>
    <div class="section-body" id="usage-body"></div>
  </section>

  <section class="section" id="models">
    <div class="section-head">
      <div><h2>模型与路由</h2><p class="sub" id="model-hint">选择要在 opencode 中显示的模型，并管理上游 pin</p></div>
      <div class="actions"><button class="btn" id="refresh-catalog">刷新官方目录</button></div>
    </div>
    <div class="section-body">
      <div class="toolbar">
        <input class="search" id="model-search" type="text" placeholder="搜索模型 / 渠道…">
        <select id="model-view"><option value="all">全部（可见）</option><option value="pinned">已钉住</option><option value="unpinned">未钉住</option><option value="unvalidated">未校验</option><option value="hidden">已隐藏</option></select>
        <select id="model-sort"><option value="default">默认排序</option><option value="pinned">已 pin 优先</option><option value="recent">最近探测优先</option></select>
        <button class="btn mini" data-action="expand-all">展开全部</button>
        <button class="btn mini" data-action="collapse-all">收起全部</button>
        <span id="model-count" class="muted"></span>
      </div>
      <details class="subpanel" id="visibility-box">
        <summary><b>在 opencode 中显示哪些模型</b><span class="muted" id="visibility-summary"></span></summary>
        <div class="subpanel-body">
          <div class="toolbar">
            <input class="search" id="visibility-search" type="text" placeholder="搜索模型…">
            <button class="btn mini" data-visibility-mode="all">全部显示</button>
            <button class="btn mini" data-visibility-mode="none">全部隐藏</button>
            <button class="btn mini" data-visibility-mode="invert">反选</button>
            <span class="muted">只影响 opencode 的模型选择器；v2 会即时刷新，v1 需重启。</span>
          </div>
          <div class="visibility-grid" id="visibility-list"></div>
        </div>
      </details>
      <div class="model-list" id="model-list"></div>
    </div>
  </section>

  <section class="section" id="history">
    <div class="section-head">
      <div><h2>请求历史</h2><p class="sub" id="history-hint">本进程内的最近请求；重启后清空</p></div>
      <div class="actions"><button class="btn" id="history-refresh">刷新</button></div>
    </div>
    <div class="section-body">
      <div class="toolbar">
        <input class="search" id="history-search" type="text" placeholder="按模型过滤…">
        <label class="check"><input type="checkbox" id="history-errors"> 只看错误</label>
        <label class="check"><input type="checkbox" id="history-auto" checked> 自动刷新</label>
        <span class="muted" id="history-summary"></span>
      </div>
      <div class="table-wrap history-wrap" id="history-wrap"><table class="table history-table" id="history-table"></table></div>
    </div>
  </section>

  <section class="section" id="settings">
    <div class="section-head"><div><h2>设置</h2><p class="sub">运行时信息与工具开关</p></div></div>
    <div class="section-body">
      <div class="settings-row">
        <span class="label">工具注入</span>
        <div class="value"><label class="check"><input type="checkbox" id="expose-tools"> 注册 8 个 cline_pass_* 工具</label><span class="muted" id="expose-note"></span></div>
      </div>
      <div class="settings-row"><span class="label">仪表盘</span><div class="value"><code id="setting-url"></code><button class="btn mini" data-copy="url">复制</button></div></div>
      <div class="settings-row"><span class="label">快捷命令</span><div class="value"><code>/cline-pass</code><span class="muted">在 opencode TUI 输入即可打开本页</span></div></div>
      <div class="settings-row"><span class="label">配置文件</span><div class="value"><code id="setting-config"></code><button class="btn mini" data-copy="config">复制</button></div></div>
      <div class="settings-row"><span class="label">构建</span><div class="value"><code id="setting-build"></code><span class="muted" id="setting-config-error"></span></div></div>
    </div>
  </section>
</main>

<div id="toast"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const DASHBOARD_URL = location.origin + '/';
const UI_KEY = 'cline-pass-ui-v2';
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (isNaN(date)) return '—';
  return date.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
};
const fmtDuration = (ms) => { const n = Number(ms || 0); return n >= 1000 ? (n / 1000).toFixed(2) + 's' : n + 'ms'; };
const formatUSD = (value) => { const n = Number(value || 0); return '$' + (Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4)); };
const fmtContext = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 'ctx?';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M ctx';
  return Math.round(n / 1000) + 'k ctx';
};
const fmtTokens = (value) => { const n = Number(value || 0); if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n); };
const fmtCountdown = (iso) => {
  if (!iso) return '';
  const left = Date.parse(iso) - Date.now();
  if (!Number.isFinite(left)) return '';
  if (left <= 0) return '即将重置';
  const hours = Math.floor(left / 3600000), minutes = Math.floor((left % 3600000) / 60000);
  return hours > 0 ? hours + ' 小时 ' + minutes + ' 分后重置' : minutes + ' 分钟后重置';
};

let ui = {
  open: [], modelQuery: '', modelView: 'all', modelSort: 'default',
  channelQuery: {}, usageTab: 'quota', historyQuery: '', historyErrors: false,
  historyAuto: true, visibilityQuery: '', tests: {}
};
try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
  if (saved && typeof saved === 'object') ui = Object.assign(ui, saved);
} catch (error) { /* ignore malformed preferences */ }
if (!Array.isArray(ui.open)) ui.open = [];
if (!ui.tests || typeof ui.tests !== 'object') ui.tests = {};
if (!ui.channelQuery || typeof ui.channelQuery !== 'object') ui.channelQuery = {};
const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (error) { /* storage may be disabled */ } };

let state = null;
let daily = null;
let usageLoading = false;
let historyLoading = false;
let historyEntries = [];
let historyTotal = 0;
let usageUpdated = 0;
let modelFilterTimer = 0;

const toast = (message, type) => {
  const el = $('toast');
  el.textContent = message;
  el.className = 'show ' + (type || '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = (type || ''); }, type === 'error' ? 9000 : 4200);
};
const spinner = '<span class="spinner"></span>';
const busy = (button, label) => {
  const original = button.innerHTML;
  const started = Date.now();
  button.disabled = true;
  button.classList.add('busy');
  const paint = () => { button.innerHTML = spinner + ' ' + esc(label) + ' ' + Math.round((Date.now() - started) / 1000) + 's'; };
  paint();
  const timer = setInterval(paint, 1000);
  return () => {
    clearInterval(timer);
    button.disabled = false;
    button.classList.remove('busy');
    button.innerHTML = original;
  };
};
const copyText = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(label + '已复制', 'ok');
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast(label + '已复制', 'ok'); }
    catch (inner) { toast('复制失败，请手动选择：' + text, 'error'); }
    finally { area.remove(); }
  }
};
async function api(action, payload) {
  const response = await fetch('/_api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cline-pass-token': TOKEN },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error && result.error.message ? result.error.message : 'request failed');
  return result.value;
}

const STATUS_LABEL = { ok:'available', limited:'rate-limited', bad:'not-pinnable', auth:'auth-failed', 'not-adopted':'未采纳', unknown:'无法确认' };
const statusTag = (status, hasVerdict) => {
  if (hasVerdict === false) return '<span class="tag">未校验</span>';
  const cls = status === 'ok' ? 'ok' : status === 'unknown' ? '' : status === 'limited' ? 'warn' : 'bad';
  return '<span class="tag ' + cls + '">' + esc(STATUS_LABEL[status] || status) + '</span>';
};
const statusDot = (status, hasVerdict) => {
  const cls = hasVerdict === false ? 'muted' : status === 'ok' ? 'ok' : status === 'limited' ? 'warn' : status === 'unknown' ? 'muted' : 'bad';
  return '<span class="dot ' + cls + '"></span>';
};
const adherenceTag = (value) => {
  if (!value) return '<span class="tag">—</span>';
  const cls = value === 'adopted' ? 'ok' : value === 'fallback' ? 'warn' : value === 'unresolved' ? '' : 'bad';
  return '<span class="tag ' + cls + '">' + esc(value) + '</span>';
};
const splitList = (value) => String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
const dedupe = (list) => { const seen = new Set(); const out = []; for (const item of list) { if (!seen.has(item)) { seen.add(item); out.push(item); } } return out; };

function renderHeader() {
  $('status').textContent = state.ready ? 'ready' : 'not configured';
  $('status').className = 'pill ' + (state.ready ? 'ok' : 'bad');
  $('provider').textContent = state.provider + ' · ' + state.baseURL;
  $('build').textContent = 'build ' + state.build;
  $('stat-accounts').textContent = state.accounts.length;
  $('stat-visible').textContent = state.models.length - state.hiddenModels;
  $('stat-pinned').textContent = state.pinnedModels;
  $('stat-history').textContent = state.historySize;
  $('stat-effective').textContent = state.effectiveAccount || '—';
  $('setting-url').textContent = DASHBOARD_URL;
  $('setting-config').textContent = state.configPath;
  $('setting-build').textContent = state.build;
  $('setting-config-error').textContent = state.configError ? '配置读取失败：' + state.configError : '';
  $('expose-tools').checked = state.exposeTools !== false;
  $('expose-note').textContent = state.exposeTools !== false ? '已注册；修改需重启生效' : '未注册；勾选并重启生效';
}

function renderAccounts() {
  const modes = { single: 'single · 固定账号', roundrobin: 'roundrobin · 轮询' };
  $('account-mode').value = state.accountMode === 'roundrobin' ? 'roundrobin' : 'single';
  $('active-account').innerHTML = '<option value="">(第一个可用账号)</option>' + state.accounts.map((account) =>
    '<option value="' + esc(account.key) + '"' + (account.key === state.activeAccount ? ' selected' : '') + '>' + esc(account.displayName || account.key) + '</option>'
  ).join('');
  $('account-hint').textContent = state.accounts.length + ' 个账号 · 模式 ' + (modes[state.accountMode] || state.accountMode) + ' · 下一次 ' + (state.effectiveAccount || '无可用账号');
  $('account-mode-note').textContent = state.accountMode === 'roundrobin' ? '按请求轮询可用账号' : '固定使用当前账号，失败时再切换';
  $('account-table').innerHTML = '<thead><tr><th style="width:44px">启用</th><th>账号</th><th>凭据</th><th>密钥</th></tr></thead><tbody>' + state.accounts.map((account) => {
    const ref = esc(account.apiKeyEnv);
    return '<tr>' +
      '<td><input type="checkbox" data-account-enable="' + esc(account.key) + '"' + (account.enabled ? ' checked' : '') + '></td>' +
      '<td><b>' + esc(account.key) + '</b><div class="muted mono">' + esc(account.displayName) + '</div></td>' +
      '<td class="mono">' + (account.keyConfigured ? esc(account.keyHint) : '<span class="err">NOT SET</span>') + '<div class="muted">' + ref + '</div></td>' +
      '<td><div class="row"><input type="password" size="15" placeholder="新密钥" data-key-input="' + esc(account.key) + '"><button class="btn mini" data-action="account-save-key" data-name="' + esc(account.key) + '" data-ref="' + ref + '">保存</button><button class="btn mini" data-action="account-test-key" data-ref="' + ref + '" data-name="' + esc(account.key) + '">测试</button>' + (account.declared ? '<button class="btn mini danger" data-action="account-remove" data-name="' + esc(account.key) + '">删除</button>' : '') + '</div></td>' +
      '</tr>';
  }).join('') + '</tbody>';
}

function renderUsage() {
  if (!usageUpdated && state.usage && state.usage.fetchedAt) usageUpdated = state.usage.fetchedAt;
  document.querySelectorAll('[data-usage-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.usageTab === ui.usageTab);
  });
  const body = $('usage-body');
  if (usageLoading) {
    body.innerHTML = '<div class="loading">' + spinner + ' 正在读取' + (ui.usageTab === 'quota' ? '官方额度' : '每日用量') + '…</div>';
    $('usage-hint').textContent = '请求中…';
    return;
  }
  const updated = usageUpdated ? ' · 更新于 ' + fmtTime(usageUpdated) : '';
  $('usage-hint').textContent = (ui.usageTab === 'quota' ? '每个账号的官方额度窗口' : '按天/模型的用量，费用已从微美元换算为 USD') + updated;
  if (ui.usageTab === 'daily') {
    if (!daily) {
      body.innerHTML = '<div class="empty">还没有读取每日用量。<br><button class="btn primary" data-action="usage-refresh">读取每日用量</button></div>';
      return;
    }
    const blocks = (daily.accounts || []).map((account) => {
      if (!account.ok) {
        return '<div class="usage-card"><div class="usage-head"><b>' + esc(account.displayName || account.account) + '</b><span class="tag bad">failed</span></div><div class="err">' + esc(account.error) + '</div></div>';
      }
      const grouped = new Map();
      for (const row of account.rows || []) {
        const key = row.model || '(unknown)';
        const current = grouped.get(key) || { tokens: 0, cost: 0, days: new Set() };
        current.tokens += Number(row.tokens || 0);
        current.cost += Number(row.costUsd || 0);
        if (row.date) current.days.add(row.date);
        grouped.set(key, current);
      }
      const rows = [...grouped.entries()].sort((a, b) => b[1].cost - a[1].cost);
      const totalTokens = rows.reduce((sum, entry) => sum + entry[1].tokens, 0);
      const totalCost = rows.reduce((sum, entry) => sum + entry[1].cost, 0);
      const table = rows.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>模型</th><th class="num">tokens</th><th class="num">费用</th></tr></thead><tbody>' + rows.map(([model, value]) =>
            '<tr><td class="mono">' + esc(model) + '</td><td class="num mono">' + fmtTokens(value.tokens) + '</td><td class="num mono">' + formatUSD(value.cost) + '</td></tr>'
          ).join('') + '</tbody></table></div>'
        : '<div class="empty small">该账号在区间内没有用量</div>';
      return '<div class="usage-card"><div class="usage-head"><b>' + esc(account.displayName || account.account) + '</b><span class="tag ok">ok</span><span class="spacer"></span><span class="muted mono">' + esc(daily.startDate + ' → ' + daily.endDate) + '</span></div>' +
        '<div class="row"><span class="muted">合计</span><b class="mono">' + fmtTokens(totalTokens) + ' tok</b><span class="muted">·</span><b class="mono">' + formatUSD(totalCost) + '</b></div>' + table + '</div>';
    });
    body.innerHTML = blocks.length ? '<div class="usage-grid">' + blocks.join('') + '</div>' : '<div class="empty">没有可用账号</div>';
    return;
  }
  const readings = state.usage && Array.isArray(state.usage.accounts) ? state.usage.accounts : [];
  if (!readings.length) {
    body.innerHTML = '<div class="empty">还没有读取额度。<br><button class="btn primary" data-action="usage-refresh">读取官方额度</button></div>';
    return;
  }
  const windows = [['five_hour','5 小时'],['weekly','本周'],['monthly','本月']];
  const blocks = readings.map((account) => {
    const known = new Map((account.limits || []).map((limit) => [String(limit.type), limit]));
    const cards = windows.map(([type, label]) => {
      const limit = known.get(type);
      if (!limit) return '<div class="quota"><div class="quota-head"><b>' + label + '</b><span>—</span></div><div class="quota-foot muted">网关未返回此窗口</div></div>';
      const percent = Math.max(0, Math.min(100, Number(limit.percentUsed || 0)));
      const cls = percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : '';
      return '<div class="quota"><div class="quota-head"><b>' + label + '</b><span class="mono">' + percent.toFixed(1) + '%</span></div><div class="bar"><i class="' + cls + '" style="width:' + percent + '%"></i></div><div class="quota-foot">' + esc(fmtCountdown(limit.resetsAt)) + '</div></div>';
    }).join('');
    const extras = (account.limits || []).filter((limit) => !windows.some(([type]) => type === String(limit.type)));
    const extraCards = extras.map((limit) => {
      const percent = Math.max(0, Math.min(100, Number(limit.percentUsed || 0)));
      return '<div class="quota"><div class="quota-head"><b>' + esc(limit.type) + '</b><span class="mono">' + percent.toFixed(1) + '%</span></div><div class="bar"><i class="' + (percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : '') + '" style="width:' + percent + '%"></i></div><div class="quota-foot">' + esc(fmtCountdown(limit.resetsAt)) + '</div></div>';
    }).join('');
    return '<div class="usage-card"><div class="usage-head"><b>' + esc(account.displayName || account.account) + '</b>' + (account.ok ? '<span class="tag ok">ok</span>' : '<span class="tag bad">failed</span>') + '</div>' +
      (account.error ? '<div class="err">' + esc(account.error) + '</div>' : '') +
      '<div class="quota-grid">' + cards + extraCards + '</div></div>';
  });
  body.innerHTML = '<div class="usage-grid">' + blocks.join('') + '</div>';
}

function renderVisibility() {
  const visible = state.models.filter((model) => !model.hidden).length;
  $('visibility-summary').textContent = ' ' + visible + ' / ' + state.models.length + ' 可见';
  if (document.activeElement !== $('visibility-search')) $('visibility-search').value = ui.visibilityQuery;
  const needle = ui.visibilityQuery.trim().toLowerCase();
  const models = state.models.filter((model) => !needle || model.id.toLowerCase().includes(needle) || String(model.displayName || '').toLowerCase().includes(needle));
  $('visibility-list').innerHTML = models.length ? models.map((model) =>
    '<label class="vis-item"><input type="checkbox" data-visibility-model="' + esc(model.id) + '"' + (model.hidden ? '' : ' checked') + '><span class="mono">' + esc(model.id) + '</span>' + (model.pinned.length ? '<span class="tag brand">pinned</span>' : '') + '</label>'
  ).join('') : '<div class="muted">没有匹配的模型</div>';
}

function channelNamesFor(model) {
  return model.upstreams.length > 0 ? model.upstreams.slice() : dedupe(model.pinned.concat(model.excluded));
}

function channelCard(name, verdict, pinned, excluded) {
  const isPinned = pinned.includes(name);
  const isExcluded = excluded.includes(name);
  const note = verdict && verdict.note ? verdict.note : '';
  return '<div class="channel' + (isPinned ? ' pinned' : '') + (isExcluded ? ' excluded' : '') + '" data-channel="' + esc(name) + '">' +
    '<div class="channel-head">' + statusDot(verdict && verdict.status, Boolean(verdict)) + '<span class="channel-name mono" title="' + esc(name) + '">' + esc(name) + '</span>' + statusTag(verdict && verdict.status, Boolean(verdict)) + '</div>' +
    '<div class="row"><button class="btn mini' + (isPinned ? ' primary' : '') + '" data-channel-action="pin" data-channel="' + esc(name) + '">' + (isPinned ? '已钉 ✓' : '钉住') + '</button><button class="btn mini' + (isExcluded ? ' danger' : '') + '" data-channel-action="exclude" data-channel="' + esc(name) + '">' + (isExcluded ? '已排除 ×' : '排除') + '</button></div>' +
    (note ? '<div class="channel-note" title="' + esc(note) + '">' + esc(note) + '</div>' : '') +
    '</div>';
}

function pinChainHTML(pinned, excluded) {
  const nodes = pinned.length ? pinned.map((name, index) =>
    '<span class="pin-node"><span class="idx">' + (index + 1) + '</span><span class="pname mono" title="' + esc(name) + '">' + esc(name) + '</span>' +
    '<button data-pin-move="up" data-channel="' + esc(name) + '" title="上移">↑</button>' +
    '<button data-pin-move="down" data-channel="' + esc(name) + '" title="下移">↓</button>' +
    '<button data-pin-remove="' + esc(name) + '" title="移出 pin">×</button></span>'
  ).join('') : '<span class="muted">自动路由（未钉住）</span>';
  const excludedNodes = excluded.map((name) =>
    '<span class="exclude-node"><span class="mono">' + esc(name) + '</span><button data-exclude-remove="' + esc(name) + '" title="移出排除">×</button></span>'
  ).join('');
  return '<span class="muted">当前 pin：</span>' + nodes + (excludedNodes ? '<span class="muted">排除：</span>' + excludedNodes : '') +
    '<span class="spacer"></span>' +
    (pinned.length ? '<button class="btn mini ghost" data-channel-action="clear-pin">清空 pin</button>' : '') +
    (excluded.length ? '<button class="btn mini ghost" data-channel-action="clear-exclude">清空排除</button>' : '');
}

function testResultHTML(model) {
  const result = ui.tests[model.id];
  if (!result) return '<div class="empty small">还没有测试。点上方「测试」验证 pin 是否被采纳。</div>';
  const adherence = result.adherence || (result.adopted ? 'adopted' : '');
  const cls = !result.ok ? 'bad' : adherence === 'adopted' ? 'ok' : adherence === 'fallback' || adherence === 'unresolved' ? 'warn' : 'bad';
  const title = !result.ok ? '测试失败' : adherence === 'adopted' ? 'Pin 已采纳' : adherence === 'fallback' ? '请求成功，但回退到其他渠道' : adherence === 'unresolved' ? '请求成功，但无法确认 pin' : 'Pin 未被采纳';
  const trace = (result.trace || []).map((entry) =>
    '<div class="trace"><span class="mono">' + esc(entry.upstream) + '</span><span>HTTP ' + entry.status + '</span><span>' + fmtDuration(entry.ms) + '</span><span class="muted">' + esc(entry.note) + '</span></div>'
  ).join('');
  const warnings = (result.warnings || []).map((warning) => '<div class="trace"><span class="warn">⚠</span><span>' + esc(warning) + '</span></div>').join('');
  return '<div class="test-result ' + cls + '">' +
    '<div class="test-title"><span>' + (cls === 'ok' ? '✓' : cls === 'warn' ? '⚠' : '✗') + '</span><span>' + title + '</span><span class="spacer"></span><span class="muted">' + fmtTime(result.ts) + '</span></div>' +
    '<div class="test-metrics"><span>actual <b class="mono">' + esc(result.actual || '—') + '</b></span><span>adherence ' + adherenceTag(adherence) + '</span><span>' + fmtDuration(result.ms) + '</span>' + (result.targets && result.targets.length ? '<span>targets <span class="mono">' + esc(result.targets.join(' > ')) + '</span></span>' : '') + '</div>' +
    (trace ? '<div class="trace-list">' + trace + '</div>' : '') +
    (warnings ? '<div class="trace-list">' + warnings + '</div>' : '') +
    (result.content ? '<div class="muted">reply: <span class="mono">' + esc(result.content) + '</span></div>' : '') +
    (result.plan ? '<details class="subdetails"><summary class="muted">router plan</summary><div class="muted" style="font-size:11.5px;padding:0 10px 8px">' + esc(result.plan) + '</div></details>' : '') +
    (result.error ? '<div class="err">' + esc(result.error) + '</div>' : '') +
    '</div>';
}

function verdictBlockHTML(model) {
  const verdicts = model.upstreamStatus || [];
  if (!verdicts.length) {
    return '<div class="muted">尚未校验：' + (model.upstreams.length ? '点「校验」为每个渠道发一次真实请求；未校验不等于不可用。' : '先点「探测」获取渠道。') + '</div>';
  }
  const counts = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
  for (const verdict of verdicts) counts[verdict.status === 'not-adopted' ? 'bad' : verdict.status] = (counts[verdict.status === 'not-adopted' ? 'bad' : verdict.status] || 0) + 1;
  const tags = [['ok','可用'],['limited','限流'],['bad','不可钉'],['auth','认证失败'],['unknown','无法确认']].filter(([key]) => counts[key] > 0).map(([key, label]) => statusTag(key === 'unknown' ? 'unknown' : key) + ' <span class="muted">×' + counts[key] + '</span>').join(' ');
  const rows = verdicts.map((verdict) =>
    '<tr><td class="mono">' + esc(verdict.upstream) + '</td><td>' + statusTag(verdict.status) + '</td><td class="mono">' + verdict.ms + 'ms</td><td class="muted">' + esc(verdict.note || '') + '</td></tr>'
  ).join('');
  return '<div class="row"><b>渠道判定</b>' + tags + '<span class="spacer"></span><span class="muted">已校验 ' + verdicts.length + ' 个</span></div>' +
    '<details class="subdetails"><summary>查看判定明细</summary><div class="subdetails-body"><div class="table-wrap"><table class="table"><thead><tr><th>渠道</th><th>判定</th><th>耗时</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table></div></div></details>';
}

function modelCard(model) {
  const pinned = model.pinned.slice();
  const excluded = model.excluded.slice();
  const verdicts = new Map((model.upstreamStatus || []).map((verdict) => [verdict.upstream, verdict]));
  const names = channelNamesFor(model);
  const query = String(ui.channelQuery[model.id] || '').trim().toLowerCase();
  const ordered = pinned.filter((name) => names.includes(name)).concat(names.filter((name) => !pinned.includes(name) && !excluded.includes(name))).concat(excluded.filter((name) => !pinned.includes(name)));
  const channels = ordered.filter((name) => !query || name.toLowerCase().includes(query));
  const available = (model.upstreamStatus || []).filter((verdict) => verdict.status === 'ok').length;
  const open = ui.open.indexOf(model.id) >= 0 ? ' open' : '';
  const hiddenTag = model.hidden ? '<span class="tag warn">已隐藏</span>' : '';
  const pinLabel = model.pinned.length ? 'pin: ' + esc(model.pinned.join(' > ')) : 'auto';
  const excludeLabel = model.excluded.length ? 'exclude: ' + esc(model.excluded.join(',')) : '';
  const channelSummary = model.upstreams.length ? model.upstreams.length + ' 渠道' + (available ? ' · ' + available + ' 可用' : '') : '未探测渠道';
  const body = '<div class="model-body">' +
    '<div class="model-toolbar">' +
      '<button class="btn mini" data-action="probe">探测</button>' +
      '<button class="btn mini" data-action="validate">校验</button>' +
      '<button class="btn mini primary" data-action="test">测试</button>' +
      '<button class="btn mini ghost" data-action="reset">重置</button>' +
      '<label class="check"><input type="checkbox" data-field="visible"' + (model.hidden ? '' : ' checked') + '> 在选择器可见</label>' +
      '<span class="times">探测 ' + (model.probedAt ? esc(fmtTime(model.probedAt)) : '从未') + ' · 校验 ' + (model.validatedAt ? esc(fmtTime(model.validatedAt)) : '从未') + '</span>' +
    '</div>' +
    '<div class="block">' +
      '<div class="block-head"><b>Pin 路由</b><span class="muted">点击渠道即保存</span><span class="spacer"></span>' +
        '<label class="field">模式<select data-field="pinMode"><option value="strict"' + (model.pinMode === 'strict' ? ' selected' : '') + '>strict</option><option value="preferred"' + (model.pinMode === 'preferred' ? ' selected' : '') + '>preferred</option></select></label>' +
        '<label class="field">排序<select data-field="sort">' + ['','cost','ttft','tps'].map((value) => '<option value="' + value + '"' + ((['cost','ttft','tps'].includes(model.sort) ? model.sort : '') === value ? ' selected' : '') + '>' + (value || 'none') + '</option>').join('') + '</select></label>' +
      '</div>' +
      '<div class="pin-chain" data-role="pin-summary">' + pinChainHTML(pinned, excluded) + '</div>' +
      '<div class="toolbar"><input class="search" data-channel-filter="' + esc(model.id) + '" type="text" placeholder="过滤渠道…" value="' + esc(ui.channelQuery[model.id] || '') + '"><span class="muted">' + channelSummary + '</span></div>' +
      (channels.length ? '<div class="channel-grid">' + channels.map((name) => channelCard(name, verdicts.get(name), pinned, excluded)).join('') + '</div>' : '<div class="empty small">' + (names.length ? '没有匹配的渠道' : '尚未探测到渠道；点上方「探测」') + '</div>') +
      '<div class="muted" style="font-size:11.5px">' + (model.upstreams.length === 0 && names.length ? '探测数据在重启后为空，当前显示已保存的 pin；点「探测」恢复完整列表。' : '未校验不代表不可用；「测试」只发一次请求验证当前 pin。') + '</div>' +
      '<details class="subdetails"><summary>高级：手动编辑 pin 顺序 / 排除</summary><div class="subdetails-body"><div class="row"><input type="text" size="44" data-field="pinned" value="' + esc(model.pinned.join(',')) + '" placeholder="alibaba,baseten"><input type="text" size="26" data-field="excluded" value="' + esc(model.excluded.join(',')) + '" placeholder="deepseek"><button class="btn mini primary" data-action="pin-save">保存手动编辑</button><span class="muted" data-role="pin-dirty"></span></div></div></details>' +
    '</div>' +
    '<div class="block"><div class="block-head"><b>最近测试</b><span class="muted">验证 pin 是否确实被上游采纳</span></div><div data-role="test-result">' + testResultHTML(model) + '</div></div>' +
    '<div class="block">' + verdictBlockHTML(model) + '</div>' +
    '</div>';
  return '<details class="model-card"' + open + ' data-model="' + esc(model.id) + '">' +
    '<summary>' +
      '<span class="pin-dot' + (model.pinned.length ? ' on' : '') + '"></span>' +
      '<span class="model-title">' +
        '<span class="model-title-row"><span class="mono model-id">' + esc(model.id) + '</span><span class="tag">' + esc(model.pipeline || '未探测') + '</span><span class="tag' + (model.pinned.length ? ' brand' : '') + '" data-role="pin-tag">' + pinLabel + '</span><span class="tag' + (model.excluded.length ? ' warn' : '') + '" data-role="exclude-tag"' + (model.excluded.length ? '' : ' style="display:none"') + '>' + excludeLabel + '</span>' + hiddenTag + '</span>' +
        '<span class="model-sub">' + channelSummary + (model.pinned.length ? ' · ' + esc(model.pinned[0]) + (model.pinMode === 'preferred' ? ' (preferred)' : ' (strict)') : ' · 自动路由') + (model.lastProvider ? ' · last ' + esc(model.lastProvider) + ' ' + model.lastMs + 'ms' : '') + '</span>' +
      '</span>' +
      '<span class="chevron">›</span>' +
    '</summary>' + body + '</details>';
}

function filteredModels() {
  const needle = ui.modelQuery.trim().toLowerCase();
  let models = state.models.filter((model) => {
    if (ui.modelView === 'hidden' && !model.hidden) return false;
    if (ui.modelView !== 'hidden' && model.hidden) return false;
    if (ui.modelView === 'pinned' && model.pinned.length === 0) return false;
    if (ui.modelView === 'unpinned' && model.pinned.length > 0) return false;
    if (ui.modelView === 'unvalidated' && (model.upstreamStatus.length > 0 || model.upstreams.length === 0)) return false;
    return true;
  });
  if (needle) {
    models = models.filter((model) => model.id.toLowerCase().includes(needle) || String(model.displayName || '').toLowerCase().includes(needle) || model.pinned.some((name) => name.toLowerCase().includes(needle)) || model.upstreams.some((name) => name.toLowerCase().includes(needle)));
  }
  if (ui.modelSort === 'pinned') models = models.slice().sort((a, b) => Number(b.pinned.length > 0) - Number(a.pinned.length > 0));
  if (ui.modelSort === 'recent') models = models.slice().sort((a, b) => Number(b.probedAt || 0) - Number(a.probedAt || 0));
  return models;
}

function renderModels() {
  const search = $('model-search');
  if (document.activeElement !== search) search.value = ui.modelQuery;
  $('model-view').value = ui.modelView;
  $('model-sort').value = ui.modelSort;
  const models = filteredModels();
  const visible = state.models.length - state.hiddenModels;
  $('model-count').textContent = '显示 ' + models.length + ' / ' + state.models.length + ' · 可见 ' + visible + ' · 已钉 ' + state.pinnedModels;
  $('model-hint').textContent = state.models.length + ' 个订阅模型 · ' + visible + ' 个在选择器中可见 · ' + state.pinnedModels + ' 个已钉住';
  $('model-list').innerHTML = models.length ? models.map(modelCard).join('') : '<div class="empty">没有匹配的模型。调整搜索或视图筛选。</div>';
  document.querySelectorAll('details.model-card').forEach((card) => {
    card.addEventListener('toggle', () => {
      const id = card.dataset.model;
      const set = new Set(ui.open);
      if (card.open) set.add(id); else set.delete(id);
      ui.open = [...set];
      saveUI();
    });
  });
  renderVisibility();
}

function historyMatches(entry) {
  if (ui.historyErrors && !entry.error) return false;
  const needle = ui.historyQuery.trim().toLowerCase();
  if (!needle) return true;
  return String(entry.model || '').toLowerCase().includes(needle) || String(entry.provider || '').toLowerCase().includes(needle) || String(entry.account || '').toLowerCase().includes(needle);
}

function renderHistory() {
  const wrap = $('history-wrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;
  const search = $('history-search');
  if (document.activeElement !== search) search.value = ui.historyQuery;
  $('history-errors').checked = ui.historyErrors;
  $('history-auto').checked = ui.historyAuto;
  const entries = historyEntries.filter(historyMatches);
  $('history-summary').textContent = '显示 ' + entries.length + ' / ' + historyTotal + (ui.historyAuto ? ' · 自动刷新' : '') + (historyLoading ? ' · 加载中…' : '');
  $('history-hint').textContent = '本进程内的最近 ' + historyTotal + ' 条请求；重启清空';
  $('stat-history').textContent = historyTotal;
  if (wrap) wrap.scrollTop = scrollTop;
  if (!entries.length) {
    $('history-table').innerHTML = '<tbody><tr><td colspan="8" class="muted">' + (historyTotal ? '筛选后没有匹配记录' : '本进程还没有请求记录') + '</td></tr></tbody>';
    if (wrap) wrap.scrollTop = scrollTop;
    return;
  }
  const rows = entries.map((entry) => {
    const tokens = entry.usageReported ? '↓' + fmtTokens(entry.usage.inputTokens) + ' ↑' + fmtTokens(entry.usage.outputTokens) + (entry.usage.cacheReadTokens ? ' ⚡' + fmtTokens(entry.usage.cacheReadTokens) : '') + (entry.usage.reasoningTokens ? ' 🧠' + fmtTokens(entry.usage.reasoningTokens) : '') : '—';
    const status = entry.error ? '<span class="tag bad">' + esc(entry.code || 'error') + '</span><div class="history-error" title="' + esc(entry.error) + '">' + esc(entry.error) + '</div>' : '<span class="tag ok">ok</span>';
    const attempts = entry.attempts && entry.attempts.length ? ' title="attempts: ' + esc(entry.attempts.join(' > ')) + '"' : '';
    return '<tr><td class="mono nowrap">' + esc(fmtTime(entry.ts)) + '</td><td class="mono">' + esc(entry.model) + '</td><td class="mono"' + attempts + '>' + esc(entry.provider || '(auto)') + '</td><td>' + adherenceTag(entry.adherence) + '</td><td class="mono">' + esc(entry.account || '-') + '</td><td class="mono nowrap">' + (entry.ttft ? fmtDuration(entry.ttft) : '—') + ' / ' + fmtDuration(entry.ms) + '</td><td class="mono nowrap">' + tokens + '</td><td>' + status + '</td></tr>';
  }).join('');
  $('history-table').innerHTML = '<thead><tr><th>时间</th><th>模型</th><th>上游</th><th>PIN</th><th>账号</th><th>首字 / 总耗时</th><th>Tokens</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody>';
  if (wrap) wrap.scrollTop = scrollTop;
}

function captureOpen() {
  const open = new Set(ui.open);
  const shown = new Set();
  for (const card of document.querySelectorAll('details.model-card')) {
    const id = card.dataset.model;
    if (!id) continue;
    shown.add(id);
    if (card.open) open.add(id); else open.delete(id);
  }
  // A card hidden by the current filter is not in the DOM; keep its open state
  // so switching back restores it.
  ui.open = [...open];
  saveUI();
}

function restoreScroll(top) {
  if (typeof top === 'number') window.scrollTo(0, top);
}

async function refreshState(options) {
  const top = window.scrollY;
  captureOpen();
  try {
    state = await api('state', {});
    renderHeader();
    renderAccounts();
    renderUsage();
    renderModels();
    restoreScroll(top);
    if (options && options.toast) toast(options.toast, 'ok');
  } catch (error) {
    toast(String(error), 'error');
  }
}

async function applyState(next, message) {
  const top = window.scrollY;
  captureOpen();
  state = next;
  renderHeader();
  renderAccounts();
  renderUsage();
  renderModels();
  restoreScroll(top);
  if (message) toast(message, 'ok');
}

async function savePinFromDom(details, message) {
  const model = details.dataset.model;
  const pinned = dedupe(splitList(details.querySelector('[data-field="pinned"]').value));
  const excluded = dedupe(splitList(details.querySelector('[data-field="excluded"]').value)).filter((name) => !pinned.includes(name));
  const pinMode = details.querySelector('[data-field="pinMode"]').value;
  const sort = details.querySelector('[data-field="sort"]').value;
  const result = await api('model.pin', { model, upstreams: pinned, exclude: excluded, pinMode, sort });
  const entry = state.models.find((item) => item.id === model);
  if (entry) {
    entry.pinned = pinned;
    entry.excluded = excluded;
    entry.pinMode = pinMode === 'preferred' ? 'preferred' : 'strict';
    entry.sort = sort;
  }
  state.pinnedModels = state.models.filter((item) => item.pinned.length > 0).length;
  updatePinUI(details, pinned, excluded);
  updateStats();
  if (message) toast(message, 'ok');
}

function updateStats() {
  $('stat-pinned').textContent = state.pinnedModels;
  $('model-count').textContent = '显示 ' + filteredModels().length + ' / ' + state.models.length + ' · 可见 ' + (state.models.length - state.hiddenModels) + ' · 已钉 ' + state.pinnedModels;
  $('model-hint').textContent = state.models.length + ' 个订阅模型 · ' + (state.models.length - state.hiddenModels) + ' 个在选择器中可见 · ' + state.pinnedModels + ' 个已钉住';
}

function updatePinUI(details, pinned, excluded) {
  details.querySelector('[data-field="pinned"]').value = pinned.join(',');
  details.querySelector('[data-field="excluded"]').value = excluded.join(',');
  const summary = details.querySelector('[data-role="pin-summary"]');
  if (summary) summary.innerHTML = pinChainHTML(pinned, excluded);
  for (const card of details.querySelectorAll('.channel')) {
    const name = card.dataset.channel;
    const isPinned = pinned.includes(name);
    const isExcluded = excluded.includes(name);
    card.classList.toggle('pinned', isPinned);
    card.classList.toggle('excluded', isExcluded);
    const pinButton = card.querySelector('[data-channel-action="pin"]');
    const excludeButton = card.querySelector('[data-channel-action="exclude"]');
    if (pinButton) { pinButton.textContent = isPinned ? '已钉 ✓' : '钉住'; pinButton.classList.toggle('primary', isPinned); }
    if (excludeButton) { excludeButton.textContent = isExcluded ? '已排除 ×' : '排除'; excludeButton.classList.toggle('danger', isExcluded); }
  }
  const pinDot = details.querySelector('.pin-dot');
  if (pinDot) pinDot.classList.toggle('on', pinned.length > 0);
  const pinTag = details.querySelector('[data-role="pin-tag"]');
  if (pinTag) pinTag.textContent = pinned.length ? 'pin: ' + pinned.join(' > ') : 'auto';
  const excludeTag = details.querySelector('[data-role="exclude-tag"]');
  if (excludeTag) { excludeTag.textContent = excluded.length ? 'exclude: ' + excluded.join(',') : ''; excludeTag.style.display = excluded.length ? '' : 'none'; }
  const entry = state.models.find((item) => item.id === details.dataset.model);
  if (entry) {
    const channelSummary = entry.upstreams.length ? entry.upstreams.length + ' 渠道' : '未探测渠道';
    const mode = details.querySelector('[data-field="pinMode"]');
    const modeText = pinned.length ? ' · ' + pinned[0] + (mode && mode.value === 'preferred' ? ' (preferred)' : ' (strict)') : ' · 自动路由';
    const lastText = entry.lastProvider ? ' · last ' + entry.lastProvider + ' ' + entry.lastMs + 'ms' : '';
    const sub = details.querySelector('.model-sub');
    if (sub) sub.textContent = channelSummary + modeText + lastText;
  }
  const dirty = details.querySelector('[data-role="pin-dirty"]');
  if (dirty) dirty.textContent = '';
}

async function updateChannelFilter(input) {
  const details = input.closest('details.model-card');
  if (!details) return;
  const model = details.dataset.model;
  ui.channelQuery[model] = input.value;
  saveUI();
  const needle = input.value.trim().toLowerCase();
  details.querySelectorAll('.channel').forEach((card) => {
    card.style.display = !needle || String(card.dataset.channel || '').toLowerCase().includes(needle) ? '' : 'none';
  });
}

async function setVisibility(model, visible) {
  try {
    const result = await api('model.visibility', { model, visible });
    await applyState(result, visible ? '已显示；v2 会即时刷新选择器' : '已隐藏；v2 会即时刷新选择器');
  } catch (error) {
    toast(String(error), 'error');
    await refreshState();
  }
}

async function loadUsage() {
  if (usageLoading) return;
  usageLoading = true;
  renderUsage();
  try {
    if (ui.usageTab === 'quota') {
      const result = await api('usage', {});
      state = result;
      usageUpdated = result.usage && result.usage.fetchedAt ? result.usage.fetchedAt : Date.now();
      renderHeader();
    } else {
      daily = await api('usage.daily', {});
      usageUpdated = daily.fetchedAt || Date.now();
    }
  } catch (error) {
    toast(String(error), 'error');
  } finally {
    usageLoading = false;
    renderUsage();
  }
}

async function loadHistory(silent) {
  if (historyLoading) return;
  historyLoading = true;
  if (!silent) renderHistory();
  try {
    const result = await api('history', { limit: 100 });
    historyEntries = result.entries || [];
    historyTotal = result.total || historyEntries.length;
    renderHistory();
  } catch (error) {
    if (!silent) toast(String(error), 'error');
  } finally {
    historyLoading = false;
    renderHistory();
  }
}

function renderSettings() {
  $('setting-url').textContent = DASHBOARD_URL;
  $('setting-config').textContent = state.configPath;
  $('setting-build').textContent = state.build;
  $('expose-tools').checked = state.exposeTools !== false;
  $('expose-note').textContent = state.exposeTools !== false ? '已注册；修改需重启 opencode 生效' : '未注册；勾选并重启 opencode 生效';
}

function renderAll() {
  renderHeader();
  renderAccounts();
  renderUsage();
  renderModels();
  renderSettings();
}

async function runModelAction(button, details, label, task) {
  const restore = busy(button, label);
  try { await task(); }
  catch (error) { toast(String(error), 'error'); }
  finally { restore(); }
}

async function handleModelAction(button, action) {
  const details = button.closest('details.model-card');
  const model = details && details.dataset.model;
  if (!details || !model) return;
  if (action === 'probe') {
    await runModelAction(button, details, '探测中', async () => {
      const result = await api('model.probe', { model });
      const found = result.result && result.result.upstreams ? result.result.upstreams.length : 0;
      toast('探测完成：' + found + ' 个渠道 · pipeline=' + ((result.result && result.result.pipeline) || 'unknown'), 'ok');
      await refreshState();
    });
    return;
  }
  if (action === 'validate') {
    await runModelAction(button, details, '校验中', async () => {
      const result = await api('model.validate', { model });
      const summary = result.summary || {};
      toast('校验完成：可用 ' + (summary.ok || 0) + ' · 限流 ' + (summary.limited || 0) + ' · 不可钉 ' + (summary.bad || 0) + ' · 认证失败 ' + (summary.auth || 0) + ' · 无法确认 ' + (summary.unknown || 0), 'ok');
      await refreshState();
    });
    return;
  }
  if (action === 'test') {
    await runModelAction(button, details, '测试中', async () => {
      const result = await api('model.test', { model });
      result.ts = Date.now();
      ui.tests[model] = result;
      saveUI();
      const container = details.querySelector('[data-role="test-result"]');
      if (container) container.innerHTML = testResultHTML({ id: model });
      const adherence = result.adherence || (result.adopted ? 'adopted' : '');
      if (result.ok && adherence === 'adopted') toast('✓ pin adopted · actual=' + (result.actual || '?') + ' · ' + fmtDuration(result.ms), 'ok');
      else if (result.ok && adherence === 'fallback') toast('⚠ 请求成功，但回退到 ' + (result.actual || '?'), 'warn');
      else if (result.ok && adherence === 'unresolved') toast('⚠ 请求成功，但响应未报告渠道，无法确认 pin', 'warn');
      else toast('✗ 测试失败：' + (result.error || 'pin 未采纳'), 'error');
      await refreshState();
      await loadHistory(true);
    });
    return;
  }
  if (action === 'reset') {
    if (!confirm('重置这个模型的 pin / 排除 / 排序？')) return;
    await runModelAction(button, details, '重置中', async () => {
      await api('model.reset', { model });
      toast('已重置为自动路由', 'ok');
      await refreshState();
    });
    return;
  }
  if (action === 'pin-save') {
    await runModelAction(button, details, '保存中', async () => {
      await savePinFromDom(details, 'pin 已保存');
    });
  }
}

async function handleChannelAction(button, action) {
  const details = button.closest('details.model-card');
  if (!details) return;
  const pinnedInput = details.querySelector('[data-field="pinned"]');
  const excludedInput = details.querySelector('[data-field="excluded"]');
  const model = details.dataset.model;
  let pinned = splitList(pinnedInput.value);
  let excluded = splitList(excludedInput.value);
  const channel = button.dataset.channel || '';
  if (action === 'clear-pin') pinned = [];
  else if (action === 'clear-exclude') excluded = [];
  else if (action === 'pin') {
    excluded = excluded.filter((name) => name !== channel);
    pinned = pinned.includes(channel) ? pinned.filter((name) => name !== channel) : pinned.concat(channel);
  } else if (action === 'exclude') {
    pinned = pinned.filter((name) => name !== channel);
    excluded = excluded.includes(channel) ? excluded.filter((name) => name !== channel) : excluded.concat(channel);
  } else return;
  pinnedInput.value = pinned.join(',');
  excludedInput.value = excluded.join(',');
  updatePinUI(details, pinned, excluded);
  try {
    await savePinFromDom(details, 'pin 已更新');
  } catch (error) {
    toast(String(error), 'error');
    await refreshState();
  }
}

async function handlePinOrder(button, mode) {
  const details = button.closest('details.model-card');
  if (!details) return;
  const input = details.querySelector('[data-field="pinned"]');
  let pinned = splitList(input.value);
  const channel = button.dataset.channel || '';
  const index = pinned.indexOf(channel);
  if (mode === 'remove') pinned = pinned.filter((name) => name !== channel);
  else if (index >= 0 && mode === 'up' && index > 0) { const next = pinned.slice(); [next[index - 1], next[index]] = [next[index], next[index - 1]]; pinned = next; }
  else if (index >= 0 && mode === 'down' && index < pinned.length - 1) { const next = pinned.slice(); [next[index + 1], next[index]] = [next[index], next[index + 1]]; pinned = next; }
  input.value = pinned.join(',');
  updatePinUI(details, pinned, splitList(details.querySelector('[data-field="excluded"]').value));
  try { await savePinFromDom(details, 'pin 顺序已保存'); }
  catch (error) { toast(String(error), 'error'); await refreshState(); }
}

async function handleAccountAction(button, action) {
  const name = button.dataset.name || '';
  if (action === 'account-save-key') {
    const input = document.querySelector('[data-key-input="' + name.replace(/"/g, '') + '"]');
    const value = input ? input.value : '';
    if (!value.trim()) { toast('请输入新密钥', 'warn'); return; }
    const restore = busy(button, '保存中');
    try {
      const result = await api('key.set', { ref: button.dataset.ref, value });
      await applyState(result, '密钥已保存');
      if (input) input.value = '';
    } catch (error) { toast(String(error), 'error'); }
    finally { restore(); }
    return;
  }
  if (action === 'account-test-key') {
    const input = document.querySelector('[data-key-input="' + name.replace(/"/g, '') + '"]');
    const restore = busy(button, '测试中');
    try {
      const result = await api('key.test', input && input.value ? { ref: button.dataset.ref, value: input.value } : { ref: button.dataset.ref });
      toast((result.ok ? '✓ ' : '✗ ') + (result.label || '') + ' · ' + fmtDuration(result.ms) + (result.error ? ' · ' + result.error : ''), result.ok ? 'ok' : 'error');
    } catch (error) { toast(String(error), 'error'); }
    finally { restore(); }
    return;
  }
  if (action === 'account-remove') {
    if (!confirm('删除账号 ' + name + '？已存储的凭据会保留。')) return;
    const restore = busy(button, '删除中');
    try {
      const result = await api('account.remove', { name });
      await applyState(result, '账号已删除');
    } catch (error) { toast(String(error), 'error'); }
    finally { restore(); }
  }
}

document.addEventListener('click', async (event) => {
  const usageTab = event.target.closest('[data-usage-tab]');
  if (usageTab) {
    ui.usageTab = usageTab.dataset.usageTab;
    saveUI();
    if (ui.usageTab === 'quota' && (!state.usage || !state.usage.accounts || !state.usage.accounts.length)) await loadUsage();
    else if (ui.usageTab === 'daily' && !daily) await loadUsage();
    else renderUsage();
    return;
  }
  const visibilityMode = event.target.closest('[data-visibility-mode]');
  if (visibilityMode) {
    const restore = busy(visibilityMode, '处理中');
    try {
      const mode = visibilityMode.dataset.visibilityMode;
      const result = await api('models.visibility', { mode });
      await applyState(result, '模型可见性已更新');
    } catch (error) { toast(String(error), 'error'); }
    finally { restore(); }
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    const kind = copy.dataset.copy;
    const text = kind === 'url' ? DASHBOARD_URL : state && state.configPath;
    if (text) await copyText(text, kind === 'url' ? '仪表盘地址' : '配置路径');
    return;
  }
  const channelAction = event.target.closest('[data-channel-action]');
  if (channelAction) {
    await handleChannelAction(channelAction, channelAction.dataset.channelAction);
    return;
  }
  const pinMove = event.target.closest('[data-pin-move]');
  if (pinMove) {
    await handlePinOrder(pinMove, pinMove.dataset.pinMove);
    return;
  }
  const pinRemove = event.target.closest('[data-pin-remove]');
  if (pinRemove) {
    await handlePinOrder(pinRemove, 'remove');
    return;
  }
  const excludeRemove = event.target.closest('[data-exclude-remove]');
  if (excludeRemove) {
    const details = excludeRemove.closest('details.model-card');
    if (!details) return;
    const input = details.querySelector('[data-field="excluded"]');
    const excluded = splitList(input.value).filter((name) => name !== excludeRemove.dataset.excludeRemove);
    input.value = excluded.join(',');
    updatePinUI(details, splitList(details.querySelector('[data-field="pinned"]').value), excluded);
    try { await savePinFromDom(details, '排除已更新'); }
    catch (error) { toast(String(error), 'error'); await refreshState(); }
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'expand-all' || action === 'collapse-all') {
    const open = action === 'expand-all';
    const cards = [...document.querySelectorAll('details.model-card')];
    for (const card of cards) card.open = open;
    ui.open = open ? cards.map((card) => card.dataset.model) : [];
    saveUI();
    return;
  }
  if (action === 'usage-refresh') { const restore = busy(button, '刷新中'); try { await loadUsage(); } finally { restore(); } return; }
  if (action === 'probe' || action === 'validate' || action === 'test' || action === 'reset' || action === 'pin-save') { await handleModelAction(button, action); return; }
  if (action === 'account-save-key' || action === 'account-test-key' || action === 'account-remove') { await handleAccountAction(button, action); return; }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.matches('[data-account-enable]')) {
    const name = target.dataset.accountEnable;
    const checked = target.checked;
    try {
      const result = await api('account.enable', { name, enabled: checked });
      await applyState(result, checked ? '账号已启用' : '账号已停用');
    } catch (error) { target.checked = !checked; toast(String(error), 'error'); }
    return;
  }
  if (target.matches('[data-visibility-model]')) {
    await setVisibility(target.dataset.visibilityModel, target.checked);
    return;
  }
  if (target.matches('[data-field="visible"]')) {
    const details = target.closest('details.model-card');
    if (details) await setVisibility(details.dataset.model, target.checked);
    return;
  }
  if (target.matches('[data-field="pinMode"], [data-field="sort"]')) {
    const details = target.closest('details.model-card');
    if (!details) return;
    try { await savePinFromDom(details, '路由设置已保存'); }
    catch (error) { toast(String(error), 'error'); await refreshState(); }
    return;
  }
  if (target.id === 'model-view') {
    ui.modelView = target.value; saveUI(); renderModels(); return;
  }
  if (target.id === 'model-sort') {
    ui.modelSort = target.value; saveUI(); renderModels(); return;
  }
  if (target.id === 'history-errors') {
    ui.historyErrors = target.checked; saveUI(); renderHistory(); return;
  }
  if (target.id === 'history-auto') {
    ui.historyAuto = target.checked; saveUI(); renderHistory(); return;
  }
  if (target.id === 'expose-tools') {
    target.disabled = true;
    try {
      const result = await api('tools.expose', { value: target.checked });
      await applyState(result, '已保存；重启 opencode 后生效');
    } catch (error) { target.checked = !target.checked; toast(String(error), 'error'); }
    finally { target.disabled = false; }
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'model-search') {
    ui.modelQuery = target.value;
    saveUI();
    clearTimeout(modelFilterTimer);
    modelFilterTimer = setTimeout(renderModels, 120);
    return;
  }
  if (target.id === 'visibility-search') {
    ui.visibilityQuery = target.value; saveUI(); renderVisibility(); return;
  }
  if (target.id === 'history-search') {
    ui.historyQuery = target.value; saveUI(); renderHistory(); return;
  }
  if (target.matches('[data-channel-filter]')) { void updateChannelFilter(target); return; }
  if (target.matches('details.model-card [data-field="pinned"], details.model-card [data-field="excluded"]')) {
    const details = target.closest('details.model-card');
    const dirty = details && details.querySelector('[data-role="pin-dirty"]');
    if (dirty) dirty.textContent = '未保存';
  }
});

$('refresh-all').addEventListener('click', async (event) => {
  const restore = busy(event.currentTarget, '刷新中');
  try { await refreshState({ toast: '已刷新' }); await loadHistory(true); }
  finally { restore(); }
});
$('copy-dashboard').addEventListener('click', () => copyText(DASHBOARD_URL, '仪表盘地址'));
$('account-add-toggle').addEventListener('click', () => {
  const form = $('account-add-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('new-account-name').focus();
});
$('account-add-cancel').addEventListener('click', () => { $('account-add-form').hidden = true; });
$('account-add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const restore = busy(button, '添加中');
  try {
    const result = await api('account.add', {
      name: $('new-account-name').value,
      key: $('new-account-key').value,
      displayName: $('new-account-display').value,
      baseURL: $('new-account-base').value
    });
    form.reset();
    form.hidden = true;
    await applyState(result, '账号已添加');
  } catch (error) { toast(String(error), 'error'); }
  finally { restore(); }
});
$('account-mode-save').addEventListener('click', async (event) => {
  const restore = busy(event.currentTarget, '保存中');
  try {
    const result = await api('account.mode', { mode: $('account-mode').value, active: $('active-account').value });
    await applyState(result, '账号模式已保存');
  } catch (error) { toast(String(error), 'error'); }
  finally { restore(); }
});
$('usage-refresh').addEventListener('click', async (event) => {
  const restore = busy(event.currentTarget, '刷新中');
  try { await loadUsage(); }
  finally { restore(); }
});
$('refresh-catalog').addEventListener('click', async (event) => {
  const restore = busy(event.currentTarget, '扫描中');
  try {
    const result = await api('models.refresh', {});
    await applyState(result, '目录已刷新' + (result.added && result.added.length ? '；新增 ' + result.added.length + ' 个模型' : ''));
  } catch (error) { toast(String(error), 'error'); }
  finally { restore(); }
});
$('history-refresh').addEventListener('click', async (event) => {
  const restore = busy(event.currentTarget, '刷新中');
  try { await loadHistory(false); }
  finally { restore(); }
});

async function init() {
  try {
    state = await api('state', {});
    renderAll();
    await loadHistory(true);
    if (state.ready && state.accounts.some((account) => account.keyConfigured) && (!state.usage || !Array.isArray(state.usage.accounts) || state.usage.accounts.length === 0)) {
      loadUsage();
    }
    setInterval(() => {
      if (!document.hidden && ui.historyAuto && !historyLoading) loadHistory(true);
    }, 5000);
  } catch (error) {
    $('status').textContent = '加载失败';
    $('status').className = 'pill bad';
    toast(String(error), 'error');
  }
}
window.addEventListener('beforeunload', saveUI);
init();
</script>
</body>
</html>`
}
