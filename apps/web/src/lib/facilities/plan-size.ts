/**
 * Escala del editor/visor de plano: px por metro real. Se usa SOLO para dar
 * un tamaño inicial al rectángulo de un trastero que aún no tiene
 * `planWidth`/`planHeight` guardados — que nazca proporcional a sus
 * dimensiones reales en vez de un tamaño fijo arbitrario. No se persiste en
 * BD (no hay concepto de "escala del plano" en `FacilityFloor`); una vez el
 * usuario guarda el layout, el tamaño exacto en px queda fijado y esta
 * función deja de intervenir para esa unit.
 */
export const PLAN_PX_PER_METER = 40;

const MIN_PLAN_SIZE_PX = 20;

export function proportionalPlanSize(
  widthM: number,
  depthM: number,
): { width: number; height: number } {
  return {
    width: Math.max(MIN_PLAN_SIZE_PX, Math.round(widthM * PLAN_PX_PER_METER)),
    height: Math.max(MIN_PLAN_SIZE_PX, Math.round(depthM * PLAN_PX_PER_METER)),
  };
}
