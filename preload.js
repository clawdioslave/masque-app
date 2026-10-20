// The bridge between the Masque pages (the app's own screens and the setup page on clawdioslave.com) and the app.
const { contextBridge, ipcRenderer } = require("electron");
const ok = location.protocol === "file:" || location.origin === "https://clawdioslave.com";
if (ok) contextBridge.exposeInMainWorld("masqueApp", {
  obsStatus: () => ipcRenderer.invoke("obs:status"),
  downloadObs: () => ipcRenderer.invoke("obs:download"),
  startObs: () => ipcRenderer.invoke("obs:start"),
  connectObs: () => ipcRenderer.invoke("obs:connect"),
  credentials: () => ipcRenderer.invoke("obs:creds"),
  askMic: () => ipcRenderer.invoke("mic:ask"),
  openMicSettings: () => ipcRenderer.invoke("mic:openSettings"),
  character: () => ipcRenderer.invoke("app:character"),
  setCharacter: (c) => ipcRenderer.invoke("app:setCharacter", c),
  openSetup: (o) => ipcRenderer.invoke("app:openSetup", o),
  done: () => ipcRenderer.invoke("app:done"),
  hide: () => ipcRenderer.invoke("app:hide"),
  version: () => ipcRenderer.invoke("app:version"),
  attention: (o) => ipcRenderer.invoke("app:attention", o),
  onCharacter: (fn) => ipcRenderer.on("character", (_e, c) => fn(c)),
});
