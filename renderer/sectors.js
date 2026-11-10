// Registro degli ACC simulati: tiene il centro attivo e ne espone settori, strati e perimetro.
// I dati di ogni ACC stanno nel proprio file; le parti comuni (difficoltà, costruzione dei settori,
// regola semicircolare) in sector-model.js.
import {
  DIFFICULTY, DIFFICULTY_ORDER, sectorDemand, isSouthbound, isSemicircularLevel, levelsForTrack, topTransferFL,
  bottomTransferFL,
} from './sector-model.js';
import { CENTRE as ROMA } from './sectors-roma.js';
import { CENTRE as MILANO } from './sectors-milano.js';

export {
  DIFFICULTY, DIFFICULTY_ORDER, sectorDemand, isSouthbound, isSemicircularLevel, levelsForTrack, topTransferFL,
  bottomTransferFL,
};

export const CENTRES = [ROMA, MILANO];

// Il centro attivo e i suoi dati: cambiano con setCentre e i moduli che li importano vedono il nuovo valore.
export let CENTRE = ROMA;
export let SECTORS = CENTRE.sectors;
export let LAYERS = CENTRE.layers;
export let LAYER_ORDER = CENTRE.layerOrder;
export let ACC_BOUNDARY = CENTRE.boundary;

export function setCentre(id) {
  CENTRE = CENTRES.find((c) => c.id === id) ?? CENTRES[0];
  SECTORS = CENTRE.sectors;
  LAYERS = CENTRE.layers;
  LAYER_ORDER = CENTRE.layerOrder;
  ACC_BOUNDARY = CENTRE.boundary;
  return CENTRE;
}
