// Dati della schermata "Informazioni e sostegno": chi fa il simulatore, da dove vengono i dati,
// che cosa si può farci e come sostenerlo. È l'unico file da toccare per cambiare il link delle
// donazioni o aggiungere una fonte.

// ---------------------------------------------------------------------------
// Nome utente di Buy Me a Coffee: la parte finale dell'indirizzo della pagina, cioè la
// "acssimulator" di https://www.buymeacoffee.com/acssimulator.
// La pagina va registrata con questo stesso nome. Se lo cambi, cambia anche qui.
// Lasciandolo vuoto i pulsanti del sostegno scompaiono (e `npm test` lo segnala).
export const BUYMEACOFFEE_USER = 'acssimulator';
// ---------------------------------------------------------------------------

export const APP_NAME = 'ACS Simulator';
export const TAGLINE = 'Area Control Simulator · il controllo del traffico aereo d\'area, Roma ACC e Milano ACC';

// Indirizzo di contatto del progetto, se ne hai uno (per esempio una casella dedicata).
// Compare nella schermata delle informazioni; lasciandolo vuoto non compare niente.
export const CONTACT = '';

// Pagina del progetto: download delle versioni e segnalazione dei problemi.
export const PROJECT_URL = 'https://github.com/acs-simulator/acs-simulator';
export const ISSUES_URL = `${PROJECT_URL}/issues`;

export const donateUrl = BUYMEACOFFEE_USER
  ? `https://www.buymeacoffee.com/${BUYMEACOFFEE_USER}`
  : '';

export const ABOUT = `ACS Simulator mette davanti a un radar di <b>controllo d'area</b>: non si fanno
  atterrare gli aerei, si prendono in carico i voli che entrano nel proprio settore, li si tiene separati
  e li si consegna all'ente successivo al livello e nel punto concordati. I settori, le rotte, le
  procedure e le zone riservate sono quelli veri dell'Italia centro-meridionale e del nord-ovest.`;

export const DISCLAIMER = `Simulazione realizzata a scopo didattico e ricreativo. <b>Non ha alcun
  valore operativo</b> e non può essere usata per la navigazione aerea né per l'addestramento
  professionale. I dati aeronautici sono una ricostruzione parziale, non aggiornata agli ultimi cicli
  AIRAC, e non rappresentano le procedure in vigore. Il simulatore non è prodotto, approvato né
  sostenuto da ENAV S.p.A., da IVAO o da VATSIM.`;

// Fonti dei dati, mostrate nella schermata e ripetute per esteso in CREDITI.md.
export const SOURCES = [
  {
    what: 'Punti FRA, coste e confini degli ACC',
    who: 'AIP Italia ENR 6.1-3 “Free Route Airspace Chart”, ENAV S.p.A. — AIS',
    url: 'https://www.enav.it',
  },
  {
    what: 'Zone P, R, D, TSA e TRA',
    who: 'AIP Italia ENR 5.1 e ENR 5.2, ENAV S.p.A. — AIS',
    url: 'https://www.enav.it',
  },
  {
    what: 'SID, STAR e piste degli aeroporti',
    who: 'Settore Aurora di IVAO Italia e file TopSky di VATSIM Italia',
    url: 'https://github.com/ivao-italy/it-aurora-sector',
  },
  {
    what: 'Settorizzazione e procedure di coordinamento',
    who: 'SOP di Roma ACC e Milano ACC e procedure ICAO PANS-ATM (Doc 4444)',
    url: '',
  },
];

// Apre un indirizzo nel browser del sistema passando dal processo principale (preload.js).
// Fuori dall'applicazione (per esempio in un browser) ricade sul comportamento normale.
export function openExternal(url) {
  if (!url) return;
  if (window.acs?.openExternal) window.acs.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export function appVersion() {
  return window.acs?.version || '';
}
