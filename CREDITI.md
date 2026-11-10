# Crediti e fonti dei dati

ACS Simulator ricostruisce spazi aerei e procedure reali a partire da pubblicazioni
e da progetti della comunità di simulazione. Questa pagina dice da dove viene
ogni cosa. Se sei titolare di uno dei materiali citati e vuoi che venga
rimosso o citato diversamente, apri una [segnalazione](https://github.com/acs-simulator/acs-simulator/issues)
nel repository del progetto e provvedo.

> **Nessun valore operativo.** I dati sono una ricostruzione parziale, non
> aggiornata agli ultimi cicli AIRAC, pensata per una simulazione didattica.
> Non rappresentano le procedure in vigore e non possono essere usati per la
> navigazione aerea. ACS Simulator non è prodotto, approvato né sostenuto da
> ENAV S.p.A., da IVAO o da VATSIM.

## Dati aeronautici

| Che cosa | Da dove | File |
|---|---|---|
| Punti FRA (nomi, coordinate, tipo), linea di costa, confini degli ACC italiani | AIP Italia **ENR 6.1-3** *Free Route Airspace Chart*, ENAV S.p.A. — AIS, ciclo AIRAC 09 JUL 2026 | `renderer/data/chart.js` |
| Zone P, R, D, TSA, TRA: contorni, limiti verticali, orari | AIP Italia **ENR 5.1** e **ENR 5.2**, ENAV S.p.A. — AIS | `renderer/data/areas.js` |
| SID, STAR, fix di procedura e piste degli aeroporti italiani | Settore **Aurora di IVAO Italia** (<https://github.com/ivao-italy/it-aurora-sector>) e, per i livelli sui punti iniziali delle STAR, le mappe **TopSky di VATSIM Italia** (<https://github.com/vatsim-italy/VATITA-GNG-Files>) | `renderer/data/procedures.js` |
| Settorizzazione di Roma ACC e Milano ACC (settori laterali, strati, limiti verticali, punti di coordinamento) | SOP di Roma ACC e di Milano ACC, confrontate con la documentazione pubblica ENAV | `renderer/sectors-roma.js`, `renderer/sectors-milano.js` |
| Regole di coordinamento, livelli di trasferimento, gestione delle emergenze e delle zone attive | Manuale operativo ENAV **MO-ATS**; regola semicircolare italiana da AIP Italia **ENR 1.7** | `renderer/sim.js`, `renderer/sector-model.js` |
| Movimenti commerciali per la composizione del traffico fra aeroporti | Dati pubblici di traffico degli aeroporti italiani | `renderer/world.js`, `renderer/flows.js` |

I dati dell'AIP Italia sono di **ENAV S.p.A.** e restano soggetti alle
condizioni d'uso dell'AIP. Qui sono usati in forma derivata, parziale e
ridisegnata, a fini didattici e non commerciali, con attribuzione.

I file dei settori IVAO e VATSIM sono pubblicati dalle rispettive comunità
italiane sotto le licenze indicate nei loro repository: fai riferimento a quelle
per qualsiasi riutilizzo. Da quei file ACS Simulator estrae soltanto geometrie di
procedura (sequenze di fix, piste, livelli iniziali delle STAR).

Il PDF della carta FRA da cui viene generato `renderer/data/chart.js` **non è
incluso** nel repository: è materiale ENAV e va scaricato dall'AIP Italia.
La rigenerazione dei dati si fa con gli script in `tools/`.

## Software di terze parti

| Componente | Licenza |
|---|---|
| [Electron](https://www.electronjs.org/) | MIT |
| Chromium | BSD 3-Clause e licenze collegate |
| Node.js | MIT |

Le licenze complete dei componenti sono incluse nei pacchetti distribuiti,
nella cartella delle risorse dell'applicazione. La versione nel browser non usa
nessuna libreria esterna.

## Il resto

Tutto il resto — motore di simulazione, modello delle prestazioni degli
aeromobili, generazione del traffico e dei conflitti, meteo, interfaccia radar,
etichette, modalità guidata, grafica e testi — è opera originale di
**ACS Simulator** ed è coperto dalla licenza nel file `LICENSE`.
