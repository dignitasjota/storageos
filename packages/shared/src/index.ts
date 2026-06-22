/**
 * @storageos/shared — tipos, DTOs y schemas Zod compartidos entre apps.
 *
 * Subpaths:
 *   - `@storageos/shared` (este barrel) -> re-exporta todo lo publico.
 *   - `@storageos/shared/auth` (subpath estable, ver index del modulo) ->
 *     enums, schemas y DTOs de autenticacion.
 */
export * from './auth';
export * from './users';
export * from './facilities';
export * from './customers';
export * from './billing';
export * from './communications';
export * from './operations';
export * from './reports';
export * from './access';
export * from './admin';
export * from './integrations';
export * from './imports';
export * from './move-in';
export * from './landing';
export * from './accounting';
export * from './notifications';
export * from './reviews';
export * from './referrals';
export * from './campaigns';
export * from './rent-increases';
export * from './insurance';
export * from './portal';
export * from './sepa';
export * from './bank-reconciliation';
export * from './ai';

export const SHARED_PACKAGE_VERSION = '0.0.0' as const;
