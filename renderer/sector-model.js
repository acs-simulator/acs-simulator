// Parti comuni della settorizzazione: livelli di difficoltà, costruzione di un settore e regola
// semicircolare italiana. I dati veri e propri stanno nei file di ogni ACC (sectors-roma.js,
// sectors-milano.js), che il registro sectors.js tiene insieme.

// Parametri di gioco per livello di difficoltà: volume di traffico, conflitti e loro tipo.
//   conflictsPerHour     conflitti programmati all'ora: voli consegnati in conflitto con un traffico nostro
//   reactionS            tempo fra l'ultima offerta dei due voli e la perdita di separazione; il minimo vale
//                        anche per i conflitti non programmati
//   areaConflictsPerHour voli nostri pianificati attraverso una zona attiva (gli altri la evitano)
//   conflictMix          tipi di conflitto: level (entrambi livellati), target (il nostro traffico sale o scende
//                        al livello d'uscita), intruder (il volo offerto sale o scende attraverso il nostro),
//                        both (salita contro discesa)
//   evolvingBias         quota di voli livellati scartati: più salite e discese anche nel traffico normale
//   maxPendingConflicts  conflitti programmati in attesa di comparire nello stesso momento
//   waveAmp              ampiezza delle onde di traffico attorno alla domanda media (piccola: il carico resta
//                        costante, regolato da Simulation._balanceTick)
//   bunching             probabilità che due voli vengano offerti quasi insieme
//   load                 voli in contatto (offerti o assunti) in media: il volume di traffico del settore
//   maxDemand            offerte orarie massime: nei settori con passaggi brevi il carico resta un po' più basso
//   fillS                all'avvio i primi voli (tanti quanti load) sono già in avvicinamento appena fuori dal
//                        settore e ci vengono offerti entro fillS secondi: dopo 5 minuti il settore è a regime
export const DIFFICULTY = {
  facile: {
    label: 'Bassa',
    summary: 'Circa 5 voli in contatto insieme; il settore è a regime entro 5 minuti. 4 conflitti all\'ora con 4,5-8 minuti per reagire, soprattutto fra voli livellati.',
    conflictsPerHour: 4,
    areaConflictsPerHour: 2,
    reactionS: [270, 480],
    conflictMix: { level: 0.5, target: 0.25, intruder: 0.2, both: 0.05 },
    evolvingBias: 0,
    maxPendingConflicts: 1,
    waveAmp: 0.08,
    bunching: 0.1,
    load: 5,
    maxDemand: 75,
    fillS: 240,
  },
  media: {
    label: 'Media',
    summary: 'Circa 7-8 voli in contatto insieme; il settore è a regime entro 5 minuti. 8 conflitti all\'ora con 3,5-6 minuti per reagire, spesso con voli in salita o discesa.',
    conflictsPerHour: 8,
    areaConflictsPerHour: 3.5,
    reactionS: [200, 360],
    conflictMix: { level: 0.2, target: 0.3, intruder: 0.3, both: 0.2 },
    evolvingBias: 0.5,
    maxPendingConflicts: 2,
    waveAmp: 0.1,
    bunching: 0.2,
    load: 7.5,
    maxDemand: 105,
    fillS: 210,
  },
  difficile: {
    label: 'Alta',
    summary: 'Circa 10 voli in contatto insieme; il settore è a regime entro 4 minuti. 12 conflitti all\'ora con 2,5-5 minuti per reagire, quasi sempre salite contro discese.',
    conflictsPerHour: 12,
    areaConflictsPerHour: 5,
    reactionS: [150, 300],
    conflictMix: { level: 0.1, target: 0.25, intruder: 0.25, both: 0.4 },
    evolvingBias: 0.8,
    maxPendingConflicts: 3,
    waveAmp: 0.12,
    bunching: 0.3,
    load: 10,
    maxDemand: 140,
    fillS: 180,
  },
};

export const DIFFICULTY_ORDER = ['facile', 'media', 'difficile'];

// Offerte orarie del settore alla difficoltà scelta: quante ne servono perché il numero medio di voli in
// contatto sia quello della difficoltà (vedi transitMin sotto).
export function sectorDemand(sector, difficulty = sector.difficulty) {
  const d = DIFFICULTY[difficulty];
  return Math.min(d.maxDemand, Math.round((d.load * 60) / sector.transitMin));
}

// transitMin: minuti in cui un volo resta in media di nostra competenza (dall'offerta all'hand-off), misurati
// con la simulazione. Nei settori bassi e medi sono pochi minuti: quasi tutti i voli salgono o scendono e passano
// al settore superiore o inferiore appena si avvicinano al limite verticale, quindi servono molte più offerte.
// Le offerte orarie (demand, a velocità 1x) ne derivano: quante ne servono perché il numero medio di voli in
// contatto sia quello della difficoltà.
// cops: punti di coordinamento pubblicati del settore; se mancano vengono scelti fra i punti FRA vicini al confine.
export function makeSector(layer, floorFL, ceilingFL, id, name, difficulty, transitMin, description, polygon, cops = null) {
  return {
    id, name, layer, floorFL, ceilingFL, difficulty, transitMin, description, polygon, cops,
    demand: sectorDemand({ transitMin }, difficulty),
  };
}

// Livelli di passaggio al settore superiore o inferiore: il livello valido più vicino al nostro limite, 500 ft
// dentro il settore (limite FL105 -> FL110, FL195 -> FL200 o FL190, FL305 -> FL300). Il volo sta solo
// attraversando in verticale, quindi la semicircolare non conta.
export function topTransferFL(sector) {
  return Math.floor((sector.ceilingFL - 5) / 10) * 10;
}

export function bottomTransferFL(sector) {
  return Math.ceil((sector.floorFL + 5) / 10) * 10;
}

// Regola semicircolare italiana (AIP Italia ENR 1.7): rotta magnetica 090°-269° livelli
// dispari, 270°-089° livelli pari. L'asse è nord/sud invece del classico est/ovest ICAO.
export function isSouthbound(trackDeg) {
  return trackDeg >= 90 && trackDeg < 270;
}

export function isSemicircularLevel(fl, trackDeg) {
  const odd = Math.round(fl / 10) % 2 === 1;
  return odd === isSouthbound(trackDeg);
}

export function levelsForTrack(trackDeg, minFL, maxFL) {
  const levels = [];
  for (let fl = Math.ceil(minFL / 10) * 10; fl <= maxFL; fl += 10) {
    if (isSemicircularLevel(fl, trackDeg)) levels.push(fl);
  }
  return levels;
}
