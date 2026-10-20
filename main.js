// Masque app: download OBS, download this, and it works.
// It finds OBS, switches on OBS's connection for apps (no settings to change, no password to copy), restarts OBS once
// if it has to, then runs the Masque setup inside its own window (no browser permission prompts). Afterwards it stays in
// the menu bar so laughs and mouth shapes keep working while you stream, and starts with your Mac.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, systemPreferences, session, Notification } = require("electron");
const path = require("node:path"), fs = require("node:fs"), os = require("node:os"), crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

const SITE = "https://clawdioslave.com";
const IS_MAC = process.platform === "darwin", IS_WIN = process.platform === "win32";
let win = null, tray = null, pendingChar = null, quitting = false;
const store = (() => { // tiny settings file
  const f = path.join(app.getPath("userData"), "settings.json");
  let d = {}; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  return { get: (k, v) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 1)); } catch {} } };
})();
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 15000 }, (err, out) => ok(err ? "" : String(out))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ OBS on this computer
const OBS_CFG_DIR = IS_MAC ? path.join(os.homedir(), "Library/Application Support/obs-studio")
  : IS_WIN ? path.join(process.env.APPDATA || "", "obs-studio") : path.join(os.homedir(), ".config/obs-studio");
const WS_CFG = path.join(OBS_CFG_DIR, "plugin_config/obs-websocket/config.json");

async function obsInstalled() {
  if (IS_MAC) {
    if (fs.existsSync("/Applications/OBS.app") || fs.existsSync(path.join(os.homedir(), "Applications/OBS.app"))) return true;
    return !!(await run("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == 'com.obsproject.obs-studio'"])).trim();
  }
  if (IS_WIN) return ["ProgramFiles", "ProgramFiles(x86)"].some((v) => process.env[v] && fs.existsSync(path.join(process.env[v], "obs-studio/bin/64bit/obs64.exe")));
  return !!(await run("/usr/bin/which", ["obs"])).trim();
}
async function obsRunning() {
  if (IS_MAC) return !!(await run("/usr/bin/pgrep", ["-x", "OBS"])).trim();
  if (IS_WIN) return /obs64\.exe/i.test(await run("tasklist", ["/FI", "IMAGENAME eq obs64.exe"]));
  return !!(await run("/usr/bin/pgrep", ["-x", "obs"])).trim();
}
async function obsVersion() {
  if (!IS_MAC) return "";
  return (await run("/usr/bin/defaults", ["read", "/Applications/OBS.app/Contents/Info", "CFBundleShortVersionString"])).trim();
}
async function startObs() {
  if (IS_MAC) spawn("/usr/bin/open", ["-b", "com.obsproject.obs-studio"], { detached: true, stdio: "ignore" }).unref();
  else if (IS_WIN) { const exe = path.join(process.env.ProgramFiles || "C:/Program Files", "obs-studio/bin/64bit/obs64.exe"); spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" }).unref(); }
  else spawn("obs", [], { detached: true, stdio: "ignore" }).unref();
}
async function quitObs() {
  if (IS_MAC) await run("/usr/bin/osascript", ["-e", 'tell application id "com.obsproject.obs-studio" to quit']);
  else if (IS_WIN) await run("taskkill", ["/IM", "obs64.exe"]);
  for (let i = 0; i < 40; i++) { if (!(await obsRunning())) return true; await sleep(500); }
  return false;
}
function readWsCfg() { try { return JSON.parse(fs.readFileSync(WS_CFG, "utf8")); } catch { return null; } }
function writeWsCfg(c) { fs.mkdirSync(path.dirname(WS_CFG), { recursive: true }); fs.writeFileSync(WS_CFG, JSON.stringify(c, null, 4)); }

// can we log in to OBS's connection with this password? (the same handshake the setup page does)
function tryConnect(port, password, ms = 2500) {
  return new Promise((done) => {
    let ws, t = setTimeout(() => { try { ws.close(); } catch {} done("unreachable"); }, ms);
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`, "obswebsocket.json"); } catch { clearTimeout(t); return done("unreachable"); }
    const sha = (s) => crypto.createHash("sha256").update(s).digest("base64");
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.op === 0) {
        const a = m.d.authentication;
        if (a && !password) { clearTimeout(t); ws.close(); return done("needs-password"); }
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(a ? { authentication: sha(sha(password + a.salt) + a.challenge) } : {}) } }));
      } else if (m.op === 2) { clearTimeout(t); ws.close(); done("ok"); }
    };
    ws.onclose = (e) => { clearTimeout(t); done(e.code === 4009 ? "bad-password" : "unreachable"); };
    ws.onerror = () => {};
  });
}

// make sure OBS's connection is on, with a password we know; restart OBS only if we really have to
async function ensureConnection(ask) {
  const c = readWsCfg();
  if (c && c.server_enabled && (await obsRunning()) && !process.env.MASQUE_TEST_NEEDSQUIT) {
    const r = await tryConnect(c.server_port || 4455, c.auth_required ? c.server_password : "");
    if (r === "ok") return { ok: true, port: c.server_port || 4455, password: c.auth_required ? c.server_password : "" };
  }
  const password = c?.server_password && c.server_password.length >= 6 ? c.server_password : crypto.randomBytes(12).toString("base64url");
  const want = { ...(c || {}), alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: c?.server_port || 4455 };
  // OBS only reads this setting when it starts: the user closes OBS (our pop-up shows how), then we open it again
  if (await obsRunning() || process.env.MASQUE_TEST_NEEDSQUIT) return { ok: false, needsQuit: true };
  writeWsCfg(want);
  await startObs();
  for (let i = 0; i < 60; i++) { // OBS takes a few seconds to open
    await sleep(1000);
    const r = await tryConnect(want.server_port, password, 1500);
    if (r === "ok") return { ok: true, port: want.server_port, password };
  }
  return { ok: false, why: "obs-not-answering" };
}

// ------------------------------------------------------------------ window, menu bar, deep links
function charFromUrl(u) { try { const c = new URL(u).searchParams.get("c"); return /^[A-Za-z0-9-]{2,40}$/.test(c || "") ? c : null; } catch { return null; } }
function createWindow() {
  win = new BrowserWindow({ width: 980, height: 760, minWidth: 760, minHeight: 620, title: "Masque", backgroundColor: "#0b0f17", show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.loadFile(path.join(__dirname, "wizard/index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => { if (!quitting && store.get("setupDone")) { e.preventDefault(); win.hide(); if (IS_MAC) app.dock?.hide(); } });
  // only our own site may open inside the app; anything else goes to the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(SITE) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });
}
function show() { if (!win) createWindow(); if (IS_MAC) app.dock?.show(); win.show(); win.focus(); }
function makeTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "assets/trayTemplate.png")); img.setTemplateImage(true);
  tray = new Tray(img); tray.setToolTip("Masque");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Masque", click: show },
    { label: "Set up again", click: () => { show(); win.loadFile(path.join(__dirname, "wizard/index.html"), { query: { again: "1" } }); } },
    { type: "separator" },
    { label: "Help", click: () => shell.openExternal("mailto:hello@clawdioslave.com?subject=Masque%20help") },
    { label: "Quit Masque", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", show);
}

if (process.env.MASQUE_TEST) { // automated tests: a fake mic/camera, so the real Mac never shows a permission prompt
  app.commandLine.appendSwitch("use-fake-device-for-media-stream"); app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.setPath("userData", path.join(os.tmpdir(), "masque-app-test"));
}
if (!app.requestSingleInstanceLock()) app.quit();
// a "Open in Masque" link (masque://setup?c=...): start the setup for that character
function openLink(u) {
  const c = charFromUrl(u); if (!c) return;
  pendingChar = c; store.set("character", c);
  if (!app.isReady()) return;
  show(); win.loadFile(path.join(__dirname, "wizard/index.html"));
}
app.on("second-instance", (_e, argv) => { const u = argv.find((a) => a.startsWith("masque://")); if (u) openLink(u); else show(); });
app.on("open-url", (e, url) => { e.preventDefault(); openLink(url); });
if (app.isPackaged) app.setAsDefaultProtocolClient("masque");

app.whenReady().then(() => {
  // OBS lives on this computer: let our own pages talk to it and use the mic without browser-style prompts
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const ours = (details.requestingUrl || wc.getURL()).startsWith(SITE) || (details.requestingUrl || wc.getURL()).startsWith("file:");
    cb(ours && ["media", "local-network-access", "loopback-network", "local-network", "notifications"].includes(perm));
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => (origin || "").startsWith(SITE) || (origin || "").startsWith("file:"));
  makeTray(); createWindow();
  // set up before: start quietly in the menu bar with the setup page running (mouth shapes + laughs), no window
  const c = store.get("character");
  if (store.get("setupDone") && c && (app.getLoginItemSettings().wasOpenedAsHidden || process.argv.includes("--hidden"))) {
    win.once("ready-to-show", () => win.hide()); if (IS_MAC) app.dock?.hide();
    win.loadURL(`${SITE}/masque/setup/?c=${encodeURIComponent(c)}&app=1&bg=1`);
  }
  if (store.get("loginItem", true) && !process.env.MASQUE_TEST && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  app.on("activate", show);
});
app.on("window-all-closed", () => { if (!store.get("setupDone")) app.quit(); });
app.on("before-quit", () => { quitting = true; });

// ------------------------------------------------------------------ what the pages can ask for
ipcMain.handle("obs:status", async () => ({ installed: await obsInstalled(), running: await obsRunning(), version: await obsVersion(), platform: process.platform }));
ipcMain.handle("obs:download", () => shell.openExternal("https://obsproject.com/download"));
ipcMain.handle("obs:start", () => startObs());
ipcMain.handle("obs:creds", async () => { // quiet: what we know, if OBS is up and answering (never restarts anything)
  const c = readWsCfg(); if (!c?.server_enabled) return { ok: false };
  const port = c.server_port || 4455, password = c.auth_required ? c.server_password : "";
  return (await tryConnect(port, password)) === "ok" ? { ok: true, port, password } : { ok: false };
});
ipcMain.handle("obs:connect", async () => ensureConnection());
ipcMain.handle("mic:ask", async () => {
  if (!IS_MAC || process.env.MASQUE_TEST) return "granted";
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return "granted";
  return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
});
ipcMain.handle("mic:openSettings", () => IS_MAC && shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"));
ipcMain.handle("app:character", () => pendingChar || store.get("character", null));
ipcMain.handle("app:setCharacter", (_e, c) => { pendingChar = c; store.set("character", c); });
ipcMain.handle("app:openSetup", (_e, { c, port, password }) => {
  store.set("character", c);
  const test = process.env.MASQUE_PREFIX ? `&prefix=${encodeURIComponent(process.env.MASQUE_PREFIX)}` : ""; // test hook: builds beside the real scenes
  win.loadURL(`${process.env.MASQUE_SITE || SITE}/masque/setup/?c=${encodeURIComponent(c)}&app=1${test}`);
});
ipcMain.handle("app:done", () => { store.set("setupDone", true); });
ipcMain.handle("app:hide", () => { store.set("setupDone", true); win.hide(); if (IS_MAC) app.dock?.hide(); });
ipcMain.handle("app:version", () => app.getVersion());
// the user has to do something (e.g. close OBS): bring Masque to the front, over games and other windows, and say so
ipcMain.handle("app:attention", (_e, { title, body } = {}) => {
  show(); win.setAlwaysOnTop(true, "floating"); app.focus({ steal: true }); if (IS_MAC) app.dock?.bounce("critical");
  setTimeout(() => win?.setAlwaysOnTop(false), 4000);
  if (title && Notification.isSupported()) new Notification({ title, body: body || "", silent: false }).show();
});
