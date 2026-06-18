import { z } from 'zod';

import { UserRoles } from './enums';
import { Permissions, type Permission } from './permissions';

import type { UserRole } from './enums';

/**
 * Roles personalizados por tenant (RBAC v1). Un rol custom define un conjunto
 * de permisos del catálogo + un `baseRole` enum de respaldo para los endpoints
 * que aún autorizan por `@Roles`.
 */
export const CreateTenantRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.enum(Permissions)).default([]),
  baseRole: z.enum(UserRoles).default('staff'),
});
export type CreateTenantRoleInput = z.infer<typeof CreateTenantRoleSchema>;

export const UpdateTenantRoleSchema = CreateTenantRoleSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateTenantRoleInput = z.infer<typeof UpdateTenantRoleSchema>;

/** Asignar/quitar un rol custom a un usuario (`null` = volver al rol enum). */
export const AssignTenantRoleSchema = z.object({
  tenantRoleId: z.string().uuid().nullable(),
});
export type AssignTenantRoleInput = z.infer<typeof AssignTenantRoleSchema>;

export interface TenantRoleDto {
  id: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  baseRole: UserRole;
  /** Nº de usuarios con este rol asignado. */
  userCount: number;
  createdAt: string;
  updatedAt: string;
}
