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
}
