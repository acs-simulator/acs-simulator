// Processo principale: apre la finestra del simulatore e fa da guardiano verso l'esterno.
// La pagina gira senza Node e senza accesso al disco: può solo chiedere di aprire uno degli
// indirizzi elencati qui sotto nel browser del sistema (sostegno al progetto e fonti dei dati).
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

// Siti verso cui la finestra può chiedere di aprire un collegamento: il dominio esatto o un suo
// sottodominio, sempre in https. Qualunque altro indirizzo viene rifiutato senza aprire niente.
const ALLOWED_HOSTS = [
  'buymeacoffee.com',
  'github.com',
  'www.enav.it',
  'enav.it',
  'ivao.aero',
  'vatsim.net',
  'vatita.net',
];

function isAllowed(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    title: 'ACS Simulator',
    backgroundColor: '#050a10',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // la versione arriva al preload senza bisogno di un canale asincrono
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });

  // la finestra compare già disegnata: niente lampo bianco all'avvio
  win.once('ready-to-show', () => win.show());

  // nessuna navigazione fuori dai file dell'applicazione, e nessuna finestra secondaria:
  // i collegamenti esterni passano tutti dal controllo qui sotto
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('open-external', async (_event, url) => {
  if (!isAllowed(url)) return false;
  await shell.openExternal(url);
  return true;
});

// una sola istanza: al secondo avvio si riporta davanti la finestra già aperta
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions?.({
      applicationName: 'ACS Simulator',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © 2026 ACS Simulator\nSimulazione didattica, senza valore operativo.',
    });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
