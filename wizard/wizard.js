// Masque app: the first-run screens. Each one does one thing, with one big button; pop-ups explain anything unusual.
const $ = (id) => document.getElementById(id);
const A = window.masqueApp;
const API = "https://clawdioslave-masque.clawdgross.workers.dev", SITE = "https://clawdioslave.com";
const SAMPLES = [["wren", "Wren"], ["ember", "Ember"], ["vex", "Vex"], ["hettie", "Hettie"]];
const charBase = (c) => (/^[up]-[a-f0-9]{12}$/.test(c) ? `${API}/u/${c}/` : `${SITE}/masque/c/${c}/`);
let character = null, conn = null;
// check-ins (same as the setup page): how far the first run got, so a stuck customer can be helped
const sid = Math.random().toString(36).slice(2, 12); let appVer = "";
A.version().then((v) => (appVer = v));
function diag(step, detail = "") { try { fetch(`${API}/diag`, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ sid, c: character || "", app: true, ver: appVer, os: "mac", step: "app-" + step, detail: String(detail).slice(0, 300) }) }).catch(() => {}); } catch {} }
diag("open");

function show(id) { for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id; }
function popup({ title, text, yes = "OK", no = null, input = null }) {
  return new Promise((done) => {
    $("mTitle").textContent = title; $("mText").textContent = text; $("mYes").textContent = yes;
    $("mNo").hidden = !no; if (no) $("mNo").textContent = no;
    $("mInput").hidden = !input; if (input) { $("mInput").value = ""; $("mInput").placeholder = input; }
    $("modal").hidden = false; if (input) setTimeout(() => $("mInput").focus(), 50);
    $("mYes").onclick = () => { $("modal").hidden = true; done(input ? $("mInput").value.trim() || null : true); };
    $("mNo").onclick = () => { $("modal").hidden = true; done(null); };
  });
}

async function loadCharacter(c) {
  character = c;
  try {
    const m = await (await fetch(charBase(c) + "character.json")).json();
    $("heroImg").src = new URL(m.frames.idle, charBase(c)).href;
    $("helloTitle").textContent = `Let's put ${m.name} on your stream`;
  } catch {}
}
A.onCharacter((c) => c && loadCharacter(c));

// 1 hello
$("go").onclick = () => checkObs();

// 2 OBS installed?
let obsPoll = null;
async function checkObs() {
  const st = await A.obsStatus(); diag("obs-status", JSON.stringify(st));
  if (st.installed) { clearInterval(obsPoll); return connect(); }
  show("sObs");
  obsPoll ||= setInterval(checkObs, 2500);
}
$("getObs").onclick = () => A.downloadObs();

// 3 connect (the app switches on OBS's connection itself; it may ask to restart OBS)
async function connect() {
  show("sConnect"); $("connHelp").hidden = true; $("connRetry").hidden = true;
  $("connText").innerHTML = '<span class="spin"></span> Opening OBS and connecting. If OBS asks you anything the first time, just click through it.';
  conn = await A.connectObs(); diag("connect", JSON.stringify({ ok: conn.ok, needsQuit: conn.needsQuit, why: conn.why }));
  if (conn.needsQuit) { // OBS is open with its connection off: it has to close once
    $("connText").textContent = "Close OBS for a moment"; $("quitHelp").hidden = false;
    A.attention({ title: "Masque needs you for a second", body: "Close OBS (OBS menu → Quit OBS). Masque opens it again by itself." });
    while ((await A.obsStatus()).running) await new Promise((r) => setTimeout(r, 1000));
    $("quitHelp").hidden = true; $("connText").innerHTML = '<span class="spin"></span> Great. Opening OBS again and connecting…';
    conn = await A.connectObs(); diag("reconnect", JSON.stringify({ ok: conn.ok, why: conn.why }));
  }
  if (conn.ok) return character ? mic() : pickCharacter();
  $("connText").textContent = "We couldn't reach OBS.";
  $("connHelp").hidden = false; $("connRetry").hidden = false;
  $("connHelp").innerHTML = conn.why === "cancelled" ? "Masque needs to restart OBS once to connect. Click <b>Try again</b> when you're not live."
    : conn.why === "obs-wont-quit" ? "OBS didn't close. In OBS's menu, click <b>OBS → Quit OBS</b>, then click <b>Try again</b>."
    : "OBS didn't answer. Open OBS yourself, wait until you see its main window, then click <b>Try again</b>.";
}
$("connRetry").onclick = connect;

// 4 character
function pickCharacter() {
  show("sChar");
  const box = $("cast"); box.innerHTML = "";
  for (const [id, name] of SAMPLES) {
    const b = document.createElement("button"); b.innerHTML = `<img src="${SITE}/masque/c/${id}/idle.webp" alt=""><span>${name}</span>`;
    b.onclick = async () => { await A.setCharacter(id); await loadCharacter(id); mic(); };
    box.append(b);
  }
}
$("own").onclick = () => { location.href = `${SITE}/masque/make/?app=1`; };
$("haveOrder").onclick = async () => {
  const v = await popup({ title: "Your character", text: "Paste the setup link from your order page or email (it has c= in it).", yes: "Use it", no: "Cancel", input: "https://clawdioslave.com/masque/setup/?c=…" });
  if (!v) return;
  const c = (v.match(/[?&]c=([A-Za-z0-9-]+)/) || [])[1] || (/^[up]-[a-f0-9]{12}$/.test(v) ? v : null);
  if (!c) return popup({ title: "That link didn't work", text: "Open your order page and click \"Set it up in OBS\", or copy the setup link from your email." });
  await A.setCharacter(c); await loadCharacter(c); mic();
};

// 5 microphone (explained before the Mac asks)
function mic() { show("sMic"); $("micDenied").hidden = true; }
$("micOk").onclick = async () => {
  const r = await A.askMic();
  diag("mic", r); if (r !== "granted") { $("micDenied").hidden = false; return; }
  A.openSetup({ c: character, port: conn.port, password: conn.password });
};
$("micSettings").onclick = () => A.openMicSettings();
$("micRetry").onclick = () => $("micOk").click();

// start
(async () => {
  const c = await A.character(); if (c) await loadCharacter(c);
  if (new URLSearchParams(location.search).get("again")) checkObs();
})();
