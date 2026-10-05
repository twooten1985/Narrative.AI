const { contextBridge, clipboard, ipcRenderer, webUtils } = require("electron");

try {
  contextBridge.exposeInMainWorld("electron", {
    platform: process.platform,
    writeClipboardText: (text) => {
      try {
        clipboard.writeText(text);
        return true;
      } catch (e) {
        console.error("Failed to write to clipboard:", e);
        return false;
      }
    },
    secrets: {
      setKey: (name, value) => ipcRenderer.invoke("secrets:set", name, value),
      clearKey: (name) => ipcRenderer.invoke("secrets:clear", name),
      hasKey: (name) => ipcRenderer.invoke("secrets:has", name),
    },
    getSessionToken: () => ipcRenderer.invoke("session:token"),
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch (e) { return ""; }
    },
    allowPath: (filePath) => ipcRenderer.invoke("files:allow", filePath),
    pickMediaFiles: () => ipcRenderer.invoke("files:pick"),
    reload: () => ipcRenderer.invoke("app:reload"),
    exportPdf: (payload) => ipcRenderer.invoke("export:pdf", payload),
  });
} catch (error) {
  console.error("Failed to expose electron bridge:", error);
}
