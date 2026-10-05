const { app, BrowserWindow } = require("electron");
const fs = require("fs");

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const htmlPath = process.argv[2];
const pdfPath = process.argv[3];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(htmlPath);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: "Letter",
      margins: { top: 0.7, bottom: 0.9, left: 0.6, right: 0.6 },
    });
    fs.writeFileSync(pdfPath, pdf);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
