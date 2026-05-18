import { z } from 'zod';

/**
 * Regla de slug: solo minusculas, digitos y guiones simples. Sin guion al
 * inicio o al final, sin guiones consecutivos. Longitud 3-63 (limite de
 * dominio DNS).
 */
const slugRegex = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const passwordSchema = z
  .string()
  .min(8, 'La contrasena debe tener al menos 8 caracteres')
  .max(128, 'La contrasena no puede tener mas de 128 caracteres')
  .refine((p) => /[A-Z]/.test(p), 'Debe incluir al menos una mayuscula')
  .refine((p) => /[a-z]/.test(p), 'Debe incluir al menos una minuscula')
  .refine((p) => /\d/.test(p), 'Debe incluir al menos un digito');

/**
 * POST /auth/register — body.
 *
 * `tenantSlug` es opcional: si se omite, el backend lo deriva de `tenantName`
 * y le aplica un sufijo numerico si colisiona.
 */
export const RegisterSchema = z.object({
  tenantName: z
    .string()
    .trim()
    .min(2, 'El nombre de la empresa debe tener al menos 2 caracteres')
    .max(100, 'El nombre de la empresa no puede tener mas de 100 caracteres'),
  tenantSlug: z
    .string()
    .trim()
    .min(3, 'El slug debe tener al menos 3 caracteres')
    .max(63, 'El slug no puede tener mas de 63 caracteres')
    .regex(slugRegex, 'Solo letras, digitos y guiones (no al inicio ni al final)')
    .optional(),
  fullName: z
    .string()
    .trim()
    .min(2, 'El nombre debe tener al menos 2 caracteres')
    .max(200, 'El nombre no puede tener mas de 200 caracteres'),
  email: z.string().trim().toLowerCase().email('Email no valido').max(254, 'Email demasiado largo'),
  password: passwordSchema,
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: 'Debes aceptar los terminos y condiciones' }),
  }),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

/**
 * POST /auth/login — body.
 *
 * Exigimos `tenantSlug` explicitamente: el mismo email puede repetirse entre
 * tenants distintos, asi que la pareja `(tenantSlug, email)` identifica
 * univocamente al usuario.
 */
export const LoginSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(3).max(63).regex(slugRegex, 'Slug invalido'),
  email: z.string().trim().toLowerCase().email('Email no valido'),
  password: z.string().min(1, 'La contrasena es obligatoria'),
});
export type LoginInput = z.infer<typeof LoginSchema>;
