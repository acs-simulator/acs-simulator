// Settorizzazione simulata di ROMA ACC.
// Il perimetro esterno segue le linee reali della carta AIP ENR 6.1-3 (limite con Milano,
// Padova e Brindisi ACC, confini UIR con Francia, Tunisi e Malta, mediana adriatica).
// La divisione verticale segue la struttura di Roma ACC: FL195 separa lo spazio aereo inferiore da quello
// superiore (dove inizia il Free Route italiano) e le configurazioni dei settori alti partono da FL305.
// Il simulatore usa tre strati, uguali in tutto l'ACC:
//   bassi  dall'uscita dall'avvicinamento a FL195. Le partenze lasciano il settore partenze dell'APP
//          intorno a FL80 e gli arrivi vengono consegnati all'APP a FL90/100. La base è FL85 come le zone
//          esterne della TMA di Roma, FL75 sul mare attorno alla Sardegna, più alta su Appennino e Sicilia;
//   medi   da FL195 a FL305: fine salita, inizio discesa, crociera dei voli nazionali e dei turboelica;
//   alti   da FL305 a FL660: crociera, ultima parte della salita e inizio della discesa.
// Passaggi fra strati come nelle procedure di Roma ACC: chi sale viene consegnato al livello più alto del
// proprio settore (FL190/180, FL300/290), chi scende al più basso (FL310/320, FL200/210, FL90/100 all'APP).
// La divisione orizzontale è quella dei settori di Roma ACC pubblicata da VATITA (wiki.vatita.net, SOP LIRR),
// georeferenziata sugli aeroporti della mappa (errore medio 0,6 NM) e agganciata al perimetro AIP:
//   settori bassi e medi  NW, NN, NE, NC, OV, US, TS, EW, EE, SU, ES (il modulo WE è unito a NW);
//   settori alti          NW (NW+OV), NE (NN+NE+NC+US+TS), SU (SU+ES), EW (EW+EE).
// Nella realtà i settori "lower" vanno dal limite inferiore a FL305: qui sono divisi a FL195 in bassi e medi.
// La tabella DFL di Roma ACC (VATITA) ha sette blocchi - 1 MEL-FL285, 2 FL285-305, 3 FL305-335, 4 FL335-345,
// 5 FL345-365, 6 FL365-375, 7 FL375-660 - quindi il taglio a FL195 (limite fra spazio aereo inferiore e
// superiore e base del Free Route italiano) è una scelta del simulatore, non un confine di settore reale.

import { makeSector } from './sector-model.js';

export const LAYERS = {
  alto: { label: 'Settori alti', short: 'crociera, fine salita e inizio discesa', detail: 'da FL305 a FL660' },
  medio: { label: 'Settori medi', short: 'salite, discese e crociera nazionale', detail: 'da FL195 a FL305' },
  basso: { label: 'Settori bassi', short: 'partenze e arrivi', detail: 'dall\'avvicinamento (FL75-FL105) a FL195' },
};
export const LAYER_ORDER = ['alto', 'medio', 'basso'];

const FL_LOW_TOP = 195;  // spazio aereo inferiore / superiore
const FL_UPPER = 305;   // settori medi / settori alti
const FL_TOP = 660;


// --- perimetro (lat, lon), dalla carta AIP, diviso dove finiscono i confini fra settori ---
const NW_CORNER = [43.169, 9.759];
const NORTH_W = [[43.623, 10.088], [43.928, 10.38]];
const P_NW_NN = [44.089, 10.569];
const NORTH_C = [[44.117, 10.602], [44.173, 10.642], [44.39, 11.138]];
const P_NN_NE = [43.872, 11.688];
const NORTH_E = [[43.833, 11.729], [43.778, 11.834], [43.297, 13.046]];
const P_NE_NC = [43.285, 13.231];
const ADRIATIC = [[43.284, 13.244], [43.253, 13.692], [43.567, 14.435], [43.502, 14.509], [42.437, 16.173],
  [42.335, 16.208], [42.319, 16.285], [42.349, 16.363], [42.066, 16.972], [41.532, 16.645], [41.416, 16.532]];
const BRINDISI_BEND = [41.268, 14.944]; // il confine con Brindisi piega verso sud-est
const BRINDISI_WEST = [41.206, 15.124];
const P_US_TS = [40.891, 15.305];
const P_TS_ES = [39.325, 16.207];
const BRINDISI_SOUTH = [[39.235, 16.259], [38.986, 16.525]];
const SOUTH_E = [[37.732, 17.537], [37.499, 17.761], [36.956, 18.737], [36.507, 19.005], [36.502, 14.72],
  [36.807, 14.793], [36.865, 14.401]];
const P_ES_SU = [36.935, 14.203];
const SOUTH_W = [[37.126, 13.662], [37.347, 13.199], [37.347, 13.034], [37.174, 12.558], [36.816, 11.974],
  [36.622, 11.508], [37.502, 11.508]];
const P_SU_EE = [37.762, 10.901];
const SARDINIA_SW = [39.002, 8.008];
const P_EE_EW = [39.993, 8.008];
const SARDINIA_NW = [[41.002, 8.009], [41.335, 8.343]];
const BONIFACIO = [41.335, 9.76];
const P_EW_NW = [41.742, 9.76];

// --- confini interni (VATITA georeferenziata) ---
const J_NW_OV_EW = [41.742, 10.573];
const NW_OV = [42.164, 11.439];
const J_NW_NN_OV = [42.243, 11.548];
const J_NN_OV_US = [42.218, 12.076];
const J_NN_NE_US = [42.224, 12.288];
const NN_NE = [42.569, 12.075];
const NE_US = [[42.235, 12.637], [42.287, 12.747], [42.315, 12.941]];
const J_NE_NC_US = [42.639, 13.48];
const NC_US = [42.34, 13.595];
const J_OV_US_TS = [41.455, 12.405];
const US_TS = [[41.41, 12.698], [41.331, 13.124], [41.088, 13.818], [41.087, 13.923], [40.914, 14.335]];
const OV_TS = [41.212, 12.53];
const J_OV_TS_SU = [40.353, 12.416];
const J_OV_EE_SU = [40.354, 11.276];
const J_OV_EW_EE = [40.767, 11.067];
const J_TS_SU_ES = [40.153, 13.242];
const TS_ES = [39.814, 14.646];
const SU_ES = [39.201, 13.668];

const rev = (points) => [...points].reverse();

// settori bassi e medi
const A_NW = [P_EW_NW, NW_CORNER, ...NORTH_W, P_NW_NN, J_NW_NN_OV, NW_OV, J_NW_OV_EW];
const A_NN = [P_NW_NN, ...NORTH_C, P_NN_NE, NN_NE, J_NN_NE_US, J_NN_OV_US, J_NW_NN_OV];
const A_NE = [P_NN_NE, ...NORTH_E, P_NE_NC, J_NE_NC_US, ...rev(NE_US), J_NN_NE_US, NN_NE];
const A_NC = [P_NE_NC, ...ADRIATIC, BRINDISI_BEND, NC_US, J_NE_NC_US];
const A_US = [J_NN_OV_US, J_NN_NE_US, ...NE_US, J_NE_NC_US, NC_US, BRINDISI_BEND, BRINDISI_WEST, P_US_TS,
  ...rev(US_TS), J_OV_US_TS];
const A_TS = [J_OV_US_TS, ...US_TS, P_US_TS, P_TS_ES, TS_ES, J_TS_SU_ES, J_OV_TS_SU, OV_TS];
const A_OV = [J_NW_OV_EW, NW_OV, J_NW_NN_OV, J_NN_OV_US, J_OV_US_TS, OV_TS, J_OV_TS_SU, J_OV_EE_SU, J_OV_EW_EE];
const A_EW = [P_EE_EW, ...SARDINIA_NW, BONIFACIO, P_EW_NW, J_NW_OV_EW, J_OV_EW_EE];
const A_EE = [P_SU_EE, SARDINIA_SW, P_EE_EW, J_OV_EW_EE, J_OV_EE_SU];
const A_SU = [J_OV_EE_SU, J_OV_TS_SU, J_TS_SU_ES, SU_ES, P_ES_SU, ...SOUTH_W, P_SU_EE];
const A_ES = [J_TS_SU_ES, TS_ES, P_TS_ES, ...BRINDISI_SOUTH, ...SOUTH_E, P_ES_SU, SU_ES];

// settori alti: unioni dei settori sottostanti
const U_NW = [P_EW_NW, NW_CORNER, ...NORTH_W, P_NW_NN, J_NW_NN_OV, J_NN_OV_US, J_OV_US_TS, OV_TS, J_OV_TS_SU,
  J_OV_EE_SU, J_OV_EW_EE, J_NW_OV_EW];
const U_NE = [P_NW_NN, ...NORTH_C, P_NN_NE, ...NORTH_E, P_NE_NC, ...ADRIATIC, BRINDISI_BEND, BRINDISI_WEST, P_US_TS,
  P_TS_ES, TS_ES, J_TS_SU_ES, J_OV_TS_SU, OV_TS, J_OV_US_TS, J_NN_OV_US, J_NW_NN_OV];
const U_SU = [J_OV_EE_SU, J_OV_TS_SU, J_TS_SU_ES, TS_ES, P_TS_ES, ...BRINDISI_SOUTH, ...SOUTH_E, P_ES_SU, ...SOUTH_W,
  P_SU_EE];
const U_EW = [P_SU_EE, SARDINIA_SW, P_EE_EW, ...SARDINIA_NW, BONIFACIO, P_EW_NW, J_NW_OV_EW, J_OV_EW_EE, J_OV_EE_SU];

// transitMin: minuti in cui un volo resta in media di nostra competenza (dall'offerta all'hand-off), misurati
// con la simulazione. Nei settori bassi e medi sono pochi minuti: quasi tutti i voli salgono o scendono e passano
// al settore superiore o inferiore appena si avvicinano al limite verticale, quindi servono molte più offerte. Le offerte orarie (demand, a velocità 1x) ne derivano: quante ne servono perché il numero
// medio di voli in contatto sia quello della difficoltà.
const HIGH = (...args) => makeSector('alto', FL_UPPER, FL_TOP, ...args);
const MID = (...args) => makeSector('medio', FL_LOW_TOP, FL_UPPER, ...args);
const LOW = (id, name, floorFL, ...args) => makeSector('basso', floorFL, FL_LOW_TOP, id, name, ...args);

const AREA = {
  NW: 'Toscana costiera, Arcipelago e Tirreno settentrionale fino alla Corsica: Pisa e i flussi da Milano e dalla Francia.',
  NN: 'Dorsale appenninica da Firenze all\'Umbria: il corridoio nord-sud fra Milano, Bologna e Roma.',
  NE: 'Umbria, Marche e Abruzzo interno: Perugia e i flussi fra Roma, l\'Adriatico e i Balcani.',
  NC: 'Adriatico centrale fino al Gargano: Pescara e i flussi verso Bari, i Balcani e la Grecia.',
  OV: 'Tirreno centrale a ovest di Roma: Fiumicino e i flussi verso Sardegna, Spagna e Francia.',
  US: 'Lazio interno e Campania settentrionale: Ciampino e gli incroci fra Roma, Napoli e l\'Adriatico.',
  TS: 'Golfo di Napoli, Cilento e Tirreno meridionale: Capodichino, Salerno e i flussi verso Sicilia e Calabria.',
  EW: 'Sardegna settentrionale e Bocche di Bonifacio: Olbia, Alghero e i flussi fra Francia e Tirreno.',
  EE: 'Sardegna meridionale e Tirreno sud-occidentale: Cagliari e i flussi da Spagna e Nord Africa.',
  SU: 'Sicilia occidentale e canale di Sicilia: Palermo, Trapani e i flussi da Tunisi e Malta.',
  ES: 'Sicilia orientale, Calabria e Ionio: Catania, Reggio, Lamezia e i flussi verso Grecia e Medio Oriente.',
};

export const SECTORS = [
  HIGH('NWA', 'NW ALTO', 'media', 9.0, 'NW e OV: Tirreno settentrionale e centrale, flussi nord-sud da Francia, Milano e Nord Europa.', U_NW),
  HIGH('NEA', 'NE ALTO', 'difficile', 10.9, 'NN, NE, NC, US e TS: la penisola da Firenze a Napoli e l\'Adriatico, dove si incrociano i flussi balcanici e nord-sud.', U_NE),
  HIGH('SUA', 'SU ALTO', 'media', 9.4, 'SU ed ES: Sicilia, canale di Sicilia, Calabria e Ionio fino ai confini con Malta e Tunisi.', U_SU),
  HIGH('EWA', 'EW ALTO', 'facile', 13.4, 'EW ed EE: Sardegna e Tirreno occidentale, flussi da Spagna, Francia e Nord Africa.', U_EW),

  MID('NWM', 'NW MEDIO', 'media', 5.7, AREA.NW, A_NW),
  MID('NNM', 'NN MEDIO', 'media', 5.5, AREA.NN, A_NN),
  MID('NEM', 'NE MEDIO', 'facile', 5.3, AREA.NE, A_NE),
  MID('NCM', 'NC MEDIO', 'facile', 4.9, AREA.NC, A_NC),
  MID('OVM', 'OV MEDIO', 'difficile', 3.9, AREA.OV, A_OV),
  MID('USM', 'US MEDIO', 'difficile', 5.1, AREA.US, A_US),
  MID('TSM', 'TS MEDIO', 'media', 4.8, AREA.TS, A_TS),
  MID('EWM', 'EW MEDIO', 'facile', 4.8, AREA.EW, A_EW),
  MID('EEM', 'EE MEDIO', 'facile', 4.6, AREA.EE, A_EE),
  MID('SUM', 'SU MEDIO', 'facile', 5.8, AREA.SU, A_SU),
  MID('ESM', 'ES MEDIO', 'media', 5.3, AREA.ES, A_ES),

  LOW('NWB', 'NW BASSO', 85, 'media', 6.0, AREA.NW, A_NW),
  LOW('NNB', 'NN BASSO', 95, 'media', 6.7, AREA.NN, A_NN),
  LOW('NEB', 'NE BASSO', 105, 'facile', 6.0, `${AREA.NE} Base a FL105 per l'Appennino.`, A_NE),
  LOW('NCB', 'NC BASSO', 105, 'facile', 6.7, `${AREA.NC} Base a FL105 per il Gran Sasso e la Maiella.`, A_NC),
  LOW('OVB', 'OV BASSO', 85, 'difficile', 5.4, AREA.OV, A_OV),
  LOW('USB', 'US BASSO', 85, 'difficile', 5.0, AREA.US, A_US),
  LOW('TSB', 'TS BASSO', 85, 'media', 7.1, AREA.TS, A_TS),
  LOW('EWB', 'EW BASSO', 75, 'facile', 7.3, AREA.EW, A_EW),
  LOW('EEB', 'EE BASSO', 75, 'facile', 7.0, AREA.EE, A_EE),
  LOW('SUB', 'SU BASSO', 85, 'media', 6.4, AREA.SU, A_SU),
  LOW('ESB', 'ES BASSO', 95, 'media', 7.5, AREA.ES, A_ES),
];

// Perimetro complessivo di ROMA ACC (per la mappa e per i nomi degli enti adiacenti).
export const BOUNDARY = [
  NW_CORNER, ...NORTH_W, P_NW_NN, ...NORTH_C, P_NN_NE, ...NORTH_E, P_NE_NC, ...ADRIATIC, BRINDISI_BEND, BRINDISI_WEST,
  P_US_TS, P_TS_ES, ...BRINDISI_SOUTH, ...SOUTH_E, P_ES_SU, ...SOUTH_W, P_SU_EE, SARDINIA_SW, P_EE_EW, ...SARDINIA_NW,
  BONIFACIO, P_EW_NW,
];


// Confine settentrionale con Milano e Padova ACC: lo stesso tracciato è il limite sud di Milano ACC.
export const NORTH_BOUNDARY = [NW_CORNER, ...NORTH_W, P_NW_NN, ...NORTH_C];

// Ente responsabile appena fuori da Roma ACC, per i livelli dei settori.
export function adjacentUnit(lat, lon) {
  if (lat > 43.1) return lon < 11.83 ? 'MILANO ACC' : 'PADOVA ACC';
  if (lon > 14.3 && lat > 42.05) return 'ZAGABRIA ACC';
  if (lon > 15.0) return 'BRINDISI ACC';
  if (lat < 37.6 && lon > 11.4) return 'MALTA ACC';
  if (lon < 9.9 && lat > 41.2) return 'MARSIGLIA ACC';
  if (lon < 8.1) return 'MARSIGLIA ACC';
  return 'TUNISI ACC';
}

export const CENTRE = {
  id: 'roma',
  name: 'ROMA ACC',
  subtitle: 'Italia centrale e meridionale, Sardegna e Sicilia',
  description: 'Undici settori laterali su tre strati: la penisola da Firenze alla Calabria, il Tirreno, '
    + 'la Sardegna, la Sicilia e il canale di Sicilia, con Fiumicino, Ciampino, Napoli, Palermo e Catania.',
  layers: LAYERS,
  layerOrder: LAYER_ORDER,
  sectors: SECTORS,
  boundary: BOUNDARY,
  adjacentUnit,
  fallbackUnit: 'ROMA ACC',
  // inquadratura della mappa nella schermata iniziale (centro della proiezione e riquadro in NM)
  mapView: { lat: 40.4, lon: 13.2, box: { xMin: -290, xMax: 300, yMin: -250, yMax: 250 } },
};
