import type { UnitStatusValue } from '../facilities/schemas';

/** Un trastero en un estado incoherente con sus contratos/reservas. */
export interface InventoryIssueDto {
  unitId: string;
  code: string;
  facilityId: string;
  facilityName: string;
  currentStatus: UnitStatusValue;
  /** Estado que debería tener según sus contratos/reservas. */
  expectedStatus: UnitStatusValue;
  reason: string;
  /**
   * Se corrige con «Corregir» (un cambio de estado). Si no (p. ej. una cesión
   * viva con el trastero en otro estado), hay que ir a la ficha: `link`.
   */
  fixable: boolean;
  /** Dónde arreglarlo cuando no basta con cambiar el estado. */
  link: string | null;
}
