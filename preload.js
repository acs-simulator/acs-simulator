// Ponte fra la finestra e il processo principale. La pagina non ha accesso a Node (contextIsolation
// attivo, preload in sandbox): l'unica cosa che può chiedere è di aprire un indirizzo nel browser del
// sistema, e solo verso i siti elencati in main.js. Serve per il pulsante del sostegno e per i link
// alle fonti dei dati nella schermata delle informazioni.
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--app-version='));

contextBridge.exposeInMainWorld('acs', {
  version: arg ? arg.slice('--app-version='.length) : '',
  platform: process.platform,
  // true se l'indirizzo è stato aperto, false se il processo principale lo ha rifiutato
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url)),
});
