import type { FacilityScope } from './facility-scope';
import type { Prisma } from '@storageos/database';

/**
 * Contactos que ve quien solo tiene unos locales: los de sus locales y los que
 * no han elegido local (el mismo criterio que Analítica).
 */
export function leadScopeWhere(scope: FacilityScope): Prisma.LeadWhereInput {
  if (!scope) return {};
  return { OR: [{ preferredFacilityId: null }, { preferredFacilityId: { in: scope } }] };
}
