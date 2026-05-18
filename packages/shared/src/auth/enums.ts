/**
 * Catalogos compartidos entre backend y frontend.
 *
 * No importamos los enums Prisma de `@storageos/database` para evitar acoplar
 * el frontend al ORM. La fuente canonica vive aqui y debe permanecer
 * sincronizada con `schema.prisma`.
 */

export const UserRoles = ['owner', 'manager', 'staff', 'readonly'] as const;
export type UserRole = (typeof UserRoles)[number];

export const TenantStatuses = ['trial', 'active', 'suspended', 'cancelled'] as const;
export type TenantStatus = (typeof TenantStatuses)[number];

export const SubscriptionStatuses = [
  'trial',
  'active',
  'past_due',
  'cancelled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SubscriptionStatuses)[number];
