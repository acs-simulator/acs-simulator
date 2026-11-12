// Settorizzazione simulata di MILANO ACC.
// Milano ACC lavora la parte occidentale della FIR/UIR di Milano: Piemonte, Valle d'Aosta, Lombardia,
// Liguria ed Emilia occidentale, fino ai confini con Francia (Marsiglia), Svizzera (Ginevra e Zurigo),
// Padova ACC a est e Roma ACC a sud.
// La divisione orizzontale è quella dei moduli di Milano ACC pubblicata da VATITA (SOP Milano di VATSIM Italia,
// VATITA - wiki.vatita.net, edizione 1.3 gennaio 2026): EN, WN, WS, ES. I poligoni sono georeferenziati
// sugli aeroporti della carta dei settori (19 punti di appoggio, errore medio 0,5 NM) e il confine sud è
// esattamente quello usato per Roma ACC, così i due ACC combaciano.
// Configurazioni reali: un solo settore (ALPHA) fino a quattro moduli separati (ECHO), con lo strato alto
// aperto a parte da FL305 (BRAVO, DELTA, FOXTROT) e diviso in WS (WN+WS) ed ES (EN+ES) nella configurazione
// GOLF: nel simulatore i settori alti sono proprio questi due.
// La divisione verticale è quella reale, in due blocchi: i moduli "2" vanno dal limite
// dell'avvicinamento a FL305, i moduli "5" da FL305 a FL660. A differenza di Roma ACC, qui il
// simulatore non divide il blocco inferiore a FL195: gli avvicinamenti di Milano arrivano molto in alto
// (Milano APP - ANE, ANW, ASW, LAR, ADE - consegna gli arrivi fra FL150 e FL200, Torino, Genova e Verona
// - i moduli WN0, WS0, ES0 - a FL140/FL150), quindi fra la base dei settori e FL195 resterebbero poche
// migliaia di piedi. Le basi sono FL155 su EN e FL145 sugli altri moduli.
//   bassi  dall'avvicinamento a FL305: partenze in salita, arrivi in discesa e crociera dei voli nazionali;
//   alti   da FL305 a FL660: crociera, ultima parte della salita e inizio della discesa.
// Sotto FL195 EN ed ES si allargano a est fino a Brescia, Verona e Mantova, dove sopra FL195 lo spazio
// aereo è di Padova ACC (limite tratteggiato "GND-FL195" della carta dei settori): i settori bassi del
// simulatore, che arrivano a FL305, usano comunque questo confine più esteso, così Verona e Brescia (il
// modulo ES0 di Milano ACC) restano di competenza.
// Nessuna delle sette configurazioni pubblicate prevede uno strato intermedio: i "settori medi" a Milano
// non esistono (verificato sulla SOP di VATITA e sulle tabelle DFL - Division Flight Levels - degli ACC confinanti:
// Roma ha il blocco 1 da MEL a FL285, Padova ha un livello a FL195 solo nei moduli centrali e meridionali).
// Passaggi fra strati come nelle procedure reali: chi sale viene consegnato al livello più alto del proprio
// settore (FL300/290), chi scende al più basso (FL310/320, FL150/140 all'APP).

import { makeSector } from './sector-model.js';
import { NORTH_BOUNDARY as ROMA_NORTH, BOUNDARY as ROMA_BOUNDARY } from './sectors-roma.js';

export const LAYERS = {
  alto: { label: 'Settori alti', short: 'crociera, fine salita e inizio discesa', detail: 'da FL305 a FL660' },
  basso: { label: 'Settori bassi', short: 'partenze e arrivi di Malpensa, Linate, Bergamo, Torino e Genova, crociera dei voli nazionali', detail: 'dall\'avvicinamento (FL145-FL155) a FL305' },
};
export const LAYER_ORDER = ['alto', 'basso'];

const FL_UPPER = 305;   // moduli "2" / moduli "5"
const FL_TOP = 660;

// --- confine sud con Roma ACC: gli stessi punti del file di Roma ---
const SOUTH_W = ROMA_NORTH.slice(0, 3);          // dal Tirreno davanti all'Elba all'Appennino tosco-emiliano
const P_WS_ES_S = [43.978, 10.439];              // confine WS/ES sulla linea di Roma
const SOUTH_E = ROMA_NORTH.slice(3, 6);          // Appennino e pianura fino al confine con Padova
const P_ES_RM_PD = ROMA_NORTH[6];                // punto triplo Milano / Roma / Padova

// --- perimetro ovest e nord: limite della FIR sul confine con Francia e Svizzera ---
const P_WS_FR = [43.706, 7.835];                 // angolo sud-ovest, mar Ligure davanti a Mentone
const WEST_LIG = [[43.82, 7.757]];
const P_WN_WS_FR = [44.021, 7.757];              // Alpi Marittime
// dal Monte Bianco verso sud, lungo il confine con la Francia
// confine con la Francia dal Monte Bianco alle Alpi Marittime (da nord a sud)
const WEST_ALPS = [[45.9, 7.361], [45.915, 7.278], [45.868, 7.202],
  [45.886, 7.176], [45.874, 7.102], [45.913, 7.08],
  [45.922, 7.022], [45.872, 6.968], [45.836, 6.806],
  [45.737, 6.79], [45.651, 6.906], [45.633, 6.987],
  [45.517, 7.013], [45.492, 7.053], [45.456, 7.025],
  [45.373, 7.148], [45.333, 7.118], [45.263, 7.139],
  [45.217, 7.077], [45.207, 6.982], [45.127, 6.87],
  [45.142, 6.675], [45.099, 6.617], [45.025, 6.666],
  [45.002, 6.748], [44.905, 6.772], [44.87, 6.819],
  [44.84, 6.892], [44.867, 6.936], [44.824, 7.019],
  [44.8, 7.017], [44.811, 7.121], [44.143, 7.287],
  [44.149, 7.62]];
const P_WN_EN_FR = [45.922, 7.44];               // Monte Bianco: confine WN/EN sul limite FIR
const NORTH_ALPS = [[45.998, 7.603], [45.963, 7.687], [45.92, 7.721], [45.929, 7.842], [45.969, 7.899],
  [46.001, 8.019], [46.105, 8.055], [46.131, 8.134], [46.203, 8.164], [46.273, 8.078], [46.317, 8.213],
  [46.399, 8.292], [46.456, 8.394], [46.456, 8.465], [46.369, 8.475], [46.257, 8.451], [46.222, 8.532],
  [46.103, 8.673], [46.18, 9.194], [46.3, 9.292], [46.355, 9.296], [46.436, 9.258], [46.496, 9.302],
  [46.5, 9.383], [46.468, 9.413], [46.492, 9.455], [46.35, 9.457], [46.312, 9.553], [46.29, 9.692],
  [46.356, 9.805], [46.376, 9.978]];
const P_EN_PD_N = [46.287, 9.995];               // il confine con Padova incontra la Svizzera

// --- confini interni fra i moduli ---
const J_EN_WN_WS = [45.058, 8.709];              // punto triplo EN / WN / WS, a ovest di Milano
const J_EN_WS_ES = [45.205, 9.373];              // punto triplo EN / WS / ES, a sud di Linate
const J_EN_ES_PD = [45.267, 10.677];             // EN / ES sul confine con Padova (sopra FL195)
const EN_WN = [[45.314, 8.599], [45.439, 8.246], [45.722, 7.728]];
const EN_WS = [[45.136, 9.127]];
const EN_ES = [[45.437, 9.924]];
const WN_WS = [[44.368, 8.69], [44.914, 8.641]];
const WS_ES = [[44.314, 10.163], [44.548, 9.602]];

// --- confine con Padova ACC ---
const PD_EN = [[46.036, 10.11], [45.796, 10.427], [45.56, 10.511]];   // da nord fino a J_EN_ES_PD
// sotto FL195 il confine si sposta a est: Brescia, Verona e Mantova sono di Milano ACC
const J_EN_ES_LOW = [45.27, 11.23];
const EN_LOBE = [[45.56, 10.95], [45.51, 11.095], [45.5, 11.124], [45.422, 11.124]];
const ES_LOBE = [[44.967, 11.188], [44.851, 11.138], [44.809, 11.093], [44.775, 10.985], [44.761, 10.939]];

const rev = (points) => [...points].reverse();

// moduli WN e WS: non confinano con Padova, sono uguali a tutte le quote
const A_WN = [P_WN_EN_FR, ...WEST_ALPS, P_WN_WS_FR, ...WN_WS, J_EN_WN_WS, ...EN_WN];
const A_WS = [J_EN_WS_ES, ...rev(EN_WS), J_EN_WN_WS, ...rev(WN_WS), P_WN_WS_FR, ...rev(WEST_LIG), P_WS_FR,
  ...SOUTH_W, P_WS_ES_S, ...WS_ES];

// moduli EN ed ES dei settori bassi, con la sporgenza verso Brescia, Verona e Mantova
const A_EN = [P_WN_EN_FR, ...NORTH_ALPS, P_EN_PD_N, ...PD_EN, ...EN_LOBE, J_EN_ES_LOW, J_EN_ES_PD,
  ...EN_ES, J_EN_WS_ES, ...EN_WS, J_EN_WN_WS, ...EN_WN];
const A_ES = [J_EN_WS_ES, ...EN_ES, J_EN_ES_PD, J_EN_ES_LOW, ...ES_LOBE, P_ES_RM_PD, ...rev(SOUTH_E),
  P_WS_ES_S, ...WS_ES];

// settori alti: unioni dei moduli (configurazione GOLF), con il confine con Padova valido sopra FL195
const U_WS = [P_WN_EN_FR, ...WEST_ALPS, P_WN_WS_FR, ...rev(WEST_LIG), P_WS_FR, ...SOUTH_W, P_WS_ES_S,
  ...WS_ES, J_EN_WS_ES, ...rev(EN_WS), J_EN_WN_WS, ...EN_WN];
const U_ES = [P_WN_EN_FR, ...NORTH_ALPS, P_EN_PD_N, ...PD_EN, J_EN_ES_PD, P_ES_RM_PD, ...rev(SOUTH_E),
  P_WS_ES_S, ...WS_ES, J_EN_WS_ES, ...EN_WS, J_EN_WN_WS, ...EN_WN];

const HIGH = (...args) => makeSector('alto', FL_UPPER, FL_TOP, ...args);
const LOW = (id, name, floorFL, ...args) => makeSector('basso', floorFL, FL_UPPER, id, name, ...args);

const AREA = {
  EN: 'Lombardia, laghi e Alpi centrali: Malpensa, Linate, Bergamo e Lugano, le SID e le STAR della TMA di Milano e i flussi da Svizzera, Germania e Nord Europa.',
  WN: 'Piemonte e Valle d\'Aosta: Torino, Cuneo e i valichi alpini verso Francia e Ginevra.',
  WS: 'Liguria, Appennino e mar Ligure fino alla Corsica: Genova e i flussi fra il nord Italia, la Francia, la Spagna e il Tirreno.',
  ES: 'Emilia occidentale e pianura fra Po e Appennino: il corridoio nord-sud fra Milano, Bologna, Firenze e Roma e le discese verso Linate e Malpensa da sud.',
};

// Punti di coordinamento (COP) dei settori: punti FRA della carta AIP ENR 6.1-3 che stanno sul confine.
// Verso Francia e Svizzera sono i punti di ingresso/uscita del Free Route italiano (tipo E/X); sui confini
// interni con Padova, Roma e fra i moduli di Milano sono i punti attraversati dalle rotte, uno ogni 10 NM
// circa. Nei commenti i punti sono raggruppati per ente che riceve o consegna il traffico.
const COPS = {
  // Zurigo: ABESI ABREG AKASU CANNE ODINA · Ginevra: BIBAN CERVI PUNSA · Marsiglia: GARLO
  // Padova: IDREK LUSIL NESTI VABOK · ES BASSO: GIBLO IBUPU OTKEK UVNIB · WS BASSO: BOTAL
  ENB: ['ABESI', 'ABREG', 'AKASU', 'CANNE', 'ODINA', 'BIBAN', 'CERVI', 'PUNSA', 'GARLO',
    'IDREK', 'LUSIL', 'NESTI', 'VABOK', 'GIBLO', 'IBUPU', 'OTKEK', 'UVNIB', 'BOTAL'],
  // Ginevra: LURAG · Marsiglia: RONOP VAMTU · EN BASSO: BIBAN CERVI · WS BASSO: ASBOP BORDI ENOBA LAGEN TESTO
  WNB: ['LURAG', 'RONOP', 'VAMTU', 'BIBAN', 'CERVI', 'ASBOP', 'BORDI', 'ENOBA', 'LAGEN', 'TESTO'],
  // Marsiglia: BORDI MEGER NOSTA TALEP TORTU · Roma: EMBOS EVROG IRBAK OGLAK
  // WN BASSO: ASBOP ENOBA LAGEN TESTO · ES BASSO: BEROK GOLAS KALIK · EN BASSO: BOTAL
  WSB: ['BORDI', 'MEGER', 'NOSTA', 'TALEP', 'TORTU', 'EMBOS', 'EVROG', 'IRBAK', 'OGLAK',
    'ASBOP', 'ENOBA', 'LAGEN', 'TESTO', 'BEROK', 'GOLAS', 'KALIK', 'BOTAL'],
  // Padova: NISIL OGPUD VABOK · Roma: EKDIR OGLAK · EN BASSO: GIBLO IBUPU OTKEK UVNIB · WS BASSO: BEROK GOLAS KALIK
  ESB: ['NISIL', 'OGPUD', 'VABOK', 'EKDIR', 'OGLAK', 'GIBLO', 'IBUPU', 'OTKEK', 'UVNIB',
    'BEROK', 'GOLAS', 'KALIK'],
  // Zurigo: ABESI ABREG AKASU CANNE ODINA · Ginevra: BIBAN CERVI PUNSA · Marsiglia: GARLO
  // Padova: LUSIL NESTI OGPUD · Roma: EKDIR OGLAK · WS ALTO: BEROK BOTAL GOLAS KALIK
  ESA: ['ABESI', 'ABREG', 'AKASU', 'CANNE', 'ODINA', 'BIBAN', 'CERVI', 'PUNSA', 'GARLO',
    'LUSIL', 'NESTI', 'OGPUD', 'EKDIR', 'OGLAK', 'BEROK', 'BOTAL', 'GOLAS', 'KALIK'],
  // Marsiglia: BORDI MEGER NOSTA RONOP TALEP TORTU VAMTU · Ginevra: LURAG
  // Roma: EMBOS EVROG IRBAK OGLAK · ES ALTO: BEROK BIBAN BOTAL CERVI GOLAS KALIK
  WSA: ['BORDI', 'MEGER', 'NOSTA', 'RONOP', 'TALEP', 'TORTU', 'VAMTU', 'LURAG',
    'EMBOS', 'EVROG', 'IRBAK', 'OGLAK', 'BEROK', 'BIBAN', 'BOTAL', 'CERVI', 'GOLAS', 'KALIK'],
};

export const SECTORS = [
  HIGH('ESA', 'ES ALTO', 'difficile', 7.6, 'EN ed ES: Lombardia, Alpi centrali ed Emilia, dove salgono le partenze di Malpensa, Linate e Bergamo e passano i flussi fra il Nord Europa, Roma e il Mediterraneo.', U_ES, COPS.ESA),
  HIGH('WSA', 'WS ALTO', 'media', 8.7, 'WN e WS: Piemonte, Valle d\'Aosta, Liguria e mar Ligure, con i flussi fra Francia, Spagna, Svizzera e centro-sud Italia.', U_WS, COPS.WSA),

  LOW('ENB', 'EN BASSO', 155, 'difficile', 7.0, `${AREA.EN} Sotto FL195 comprende anche Brescia e Verona.`, A_EN, COPS.ENB),
  LOW('WNB', 'WN BASSO', 145, 'media', 6.4, AREA.WN, A_WN, COPS.WNB),
  LOW('WSB', 'WS BASSO', 145, 'media', 9.0, AREA.WS, A_WS, COPS.WSB),
  LOW('ESB', 'ES BASSO', 145, 'difficile', 7.1, `${AREA.ES} Sotto FL195 comprende anche Mantova e il basso veronese.`, A_ES, COPS.ESB),
];

// Perimetro complessivo di MILANO ACC (limite sotto FL195, quello più esteso a est).
export const BOUNDARY = [P_WN_EN_FR, ...NORTH_ALPS, P_EN_PD_N, ...PD_EN, ...EN_LOBE, J_EN_ES_LOW, ...ES_LOBE,
  P_ES_RM_PD, ...rev(SOUTH_E), P_WS_ES_S, ...rev(SOUTH_W), P_WS_FR, ...rev(WEST_LIG), P_WN_WS_FR,
  ...rev(WEST_ALPS)];

// Ente responsabile appena fuori da Milano ACC. A sud si usa il perimetro vero di Roma ACC; a est c'è
// Padova, a nord la Svizzera (Ginevra sul Vallese, Zurigo dal Ticino ai Grigioni) e a ovest la Francia.
function inRomaAcc(lat, lon) {
  let inside = false;
  for (let i = 0, j = ROMA_BOUNDARY.length - 1; i < ROMA_BOUNDARY.length; j = i++) {
    const a = ROMA_BOUNDARY[i];
    const b = ROMA_BOUNDARY[j];
    if ((a[0] > lat) !== (b[0] > lat) && lon < ((b[1] - a[1]) * (lat - a[0])) / (b[0] - a[0]) + a[1]) inside = !inside;
  }
  return inside;
}

export function adjacentUnit(lat, lon) {
  if (inRomaAcc(lat, lon)) return 'ROMA ACC';
  if (lat < 43.7) return lon > 9.6 ? 'ROMA ACC' : 'MARSIGLIA ACC';
  if (lon > 10.2) return 'PADOVA ACC';
  if (lat > 45.75 && lon > 6.95) return lon < 8.25 ? 'GINEVRA ACC' : 'ZURIGO ACC';
  return 'MARSIGLIA ACC';
}

export const CENTRE = {
  id: 'milano',
  name: 'MILANO ACC',
  subtitle: 'Italia nord-occidentale, Alpi e mar Ligure',
  description: 'Quattro moduli laterali su tre strati: Lombardia e Alpi centrali, Piemonte e Valle d\'Aosta, '
    + 'Liguria e mar Ligure, Emilia occidentale, con Malpensa, Linate, Bergamo, Torino e Genova.',
  layers: LAYERS,
  layerOrder: LAYER_ORDER,
  sectors: SECTORS,
  boundary: BOUNDARY,
  adjacentUnit,
  fallbackUnit: 'MILANO ACC',
  mapView: { lat: 44.85, lon: 9.0, box: { xMin: -200, xMax: 200, yMin: -110, yMax: 110 } },
};
