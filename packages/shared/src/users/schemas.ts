import { z } from 'zod';

import { UserRoles } from '../auth/enums';

const passwordSchema = z
  .string()
  .min(8, 'La contrasena debe tener al menos 8 caracteres')
  .max(128, 'La contrasena no puede tener mas de 128 caracteres')
  .refine((p) => /[A-Z]/.test(p), 'Debe incluir al menos una mayuscula')
  .refine((p) => /[a-z]/.test(p), 'Debe incluir al menos una minuscula')
  .refine((p) => /\d/.test(p), 'Debe incluir al menos un digito');

const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(200, 'El nombre no puede tener mas de 200 caracteres');

const phoneSchema = z
  .string()
  .trim()
  .max(40, 'El telefono no puede tener mas de 40 caracteres')
  .regex(/^[+\d\s().-]+$/, 'Telefono no valido')
  .optional()
  .or(z.literal(''));

/**
 * Roles que el frontend puede asignar al invitar o al editar un usuario.
 * `owner` queda fuera: se gestiona solo via transferencia.
 */
const assignableRole = z.enum(['manager', 'staff', 'readonly']);

/** POST /invitations — body. */
export const InviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email no valido'),
  role: assignableRole,
  fullName: fullNameSchema.optional(),
});
export type InviteUserInput = z.infer<typeof InviteUserSchema>;

/** PATCH /users/:id — body parcial. */
export const UpdateUserSchema = z
  .object({
    fullName: fullNameSchema,
    phone: phoneSchema,
    role: assignableRole,
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/** PATCH /me — body parcial. */
export const UpdateProfileSchema = z
  .object({
    fullName: fullNameSchema,
    phone: phoneSchema,
  })
  .partial()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

/** POST /me/change-password — body. */
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'La contrasena actual es obligatoria'),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

/** POST /invitations/token/:token/accept — body. */
export const AcceptInvitationSchema = z.object({
  fullName: fullNameSchema,
  password: passwordSchema,
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

// Re-export para que el caller no tenga que importar de '@storageos/shared/auth' directamente.
export { UserRoles };
