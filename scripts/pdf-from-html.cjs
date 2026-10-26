const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { buildPdfOptions } = require(path.join(__dirname, "..", "electron", "pdfOptions.cjs"));

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const htmlPath = process.argv[2];
const pdfPath = process.argv[3];
// Optional: path to a JSON file { left, hashLine } for the footer.
const footerPath = process.argv[4];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const footer = footerPath ? JSON.parse(fs.readFileSync(footerPath, "utf8")) : { left: "", hashLine: "" };
    await win.loadFile(htmlPath);
    const pdf = await win.webContents.printToPDF(buildPdfOptions(footer));
    fs.writeFileSync(pdfPath, pdf);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});