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
  acceptTerms: z
    .boolean()
    .refine((v) => v === true, { message: 'Debes aceptar los terminos y condiciones' }),
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

const tokenRegex = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/;

/** POST /auth/verify-email — body. */
export const VerifyEmailSchema = z.object({
  token: z.string().regex(tokenRegex, 'Token de verificacion invalido'),
});
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;

/** POST /auth/resend-verification — body. */
export const ResendVerificationSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(3).max(63).regex(slugRegex, 'Slug invalido'),
  email: z.string().trim().toLowerCase().email('Email no valido'),
});
export type ResendVerificationInput = z.infer<typeof ResendVerificationSchema>;

/** POST /auth/password/forgot — body. */
export const ForgotPasswordSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(3).max(63).regex(slugRegex, 'Slug invalido'),
  email: z.string().trim().toLowerCase().email('Email no valido'),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

/** POST /auth/password/reset — body. */
export const ResetPasswordSchema = z.object({
  token: z.string().regex(tokenRegex, 'Token invalido'),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// ============================================================================
// 2FA TOTP
// ============================================================================

const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'El codigo debe tener 6 digitos');

const recoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(8, 'Codigo de recuperacion invalido')
  .max(20, 'Codigo de recuperacion invalido');

/** POST /auth/2fa/verify — body. Activa 2FA con el primer codigo TOTP. */
export const Verify2faSetupSchema = z.object({
  code: totpCodeSchema,
});
export type Verify2faSetupInput = z.infer<typeof Verify2faSetupSchema>;

/** POST /auth/2fa/disable — body. Requiere password + un metodo de prueba. */
export const Disable2faSchema = z
  .object({
    currentPassword: z.string().min(1, 'La contrasena actual es obligatoria'),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((v) => v.code !== undefined || v.recoveryCode !== undefined, {
    message: 'Debes enviar el codigo TOTP o un codigo de recuperacion',
    path: ['code'],
  });
export type Disable2faInput = z.infer<typeof Disable2faSchema>;

/** POST /auth/2fa/recovery-codes/regenerate — body. */
export const Regenerate2faRecoveryCodesSchema = z.object({
  currentPassword: z.string().min(1, 'La contrasena actual es obligatoria'),
  code: totpCodeSchema,
});
export type Regenerate2faRecoveryCodesInput = z.infer<typeof Regenerate2faRecoveryCodesSchema>;

/** POST /auth/2fa/challenge — body. */
export const Challenge2faSchema = z
  .object({
    pendingToken: z.string().min(20),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((v) => v.code !== undefined || v.recoveryCode !== undefined, {
    message: 'Debes enviar el codigo TOTP o un codigo de recuperacion',
    path: ['code'],
  });
export type Challenge2faInput = z.infer<typeof Challenge2faSchema>;

// ============================================================================
// 2FA enrolment forzoso (politica `requireTwoFactorForManagers`)
// ============================================================================

/**
 * POST /auth/2fa/enrol-required/setup — body. El endpoint es publico
 * (sin JwtAuthGuard); la autenticacion la aporta el `enrolmentToken` JWT
 * corto que devuelve el login cuando el tenant exige 2FA al user.
 */
export const Enrol2faRequiredSetupSchema = z.object({
  enrolmentToken: z.string().min(20),
});
export type Enrol2faRequiredSetupInput = z.infer<typeof Enrol2faRequiredSetupSchema>;

/**
 * POST /auth/2fa/enrol-required/verify — body. Verifica el primer codigo
 * TOTP, activa 2FA, emite recovery codes (una sola vez) y la sesion
 * (access + refresh cookie) en una unica llamada.
 */
export const Enrol2faRequiredVerifySchema = z.object({
  enrolmentToken: z.string().min(20),
  code: totpCodeSchema,
});
export type Enrol2faRequiredVerifyInput = z.infer<typeof Enrol2faRequiredVerifySchema>;

// ============================================================================
// Politica de seguridad del tenant
// ============================================================================

/**
 * PATCH /settings/tenant/security — body. Solo rol `owner`. Activa o
 * desactiva la obligacion de 2FA para owners y managers. Al activar NO se
 * cierran sesiones existentes; los usuarios sin 2FA seran redirigidos al
 * enrolment forzoso en su proximo login.
 */
export const UpdateTenantSecuritySettingsSchema = z.object({
  requireTwoFactorForManagers: z.boolean(),
});
export type UpdateTenantSecuritySettingsInput = z.infer<typeof UpdateTenantSecuritySettingsSchema>;

/**
 * PATCH /settings/tenant/billing — body. Solo rol `owner`. Activa o
 * desactiva el cobro automatico al emitir factura: con el flag activo,
 * cada factura emitida encola un cobro al metodo de pago predeterminado
 * del cliente (las facturas sin metodo quedan pendientes sin error).
 */
export const UpdateTenantBillingSettingsSchema = z.object({
  autoChargeOnIssue: z.boolean().optional(),
  /** Emite automáticamente las facturas recurrentes (opt-in) en vez de dejarlas en borrador. */
  autoIssueRecurring: z.boolean().optional(),
  /** Recargo por mora (opt-in): emite una factura de recargo a los N días de vencimiento. */
  lateFeeEnabled: z.boolean().optional(),
  lateFeeType: z.enum(['percentage', 'fixed']).optional(),
  lateFeeValue: z.number().nonnegative().max(100_000).optional(),
  lateFeeGraceDays: z.number().int().min(0).max(120).optional(),
});
export type UpdateTenantBillingSettingsInput = z.infer<typeof UpdateTenantBillingSettingsSchema>;

/**
 * PATCH /settings/tenant/reviews — body. Activa la auto-solicitud de
 * valoraciones (NPS) N días tras firmar el contrato. Opt-in por tenant.
 */
export const UpdateTenantReviewsSettingsSchema = z.object({
  reviewsAutoRequest: z.boolean().optional(),
  reviewRequestDelayDays: z.number().int().min(1).max(180).optional(),
  /** Link "deja tu reseña" en Google Business Profile (vacío = desactivado). */
  googleReviewUrl: z.string().trim().url().max(500).optional().or(z.literal('')),
});
export type UpdateTenantReviewsSettingsInput = z.infer<typeof UpdateTenantReviewsSettingsSchema>;

/** White-label del portal del inquilino: color de marca (hex) + URL del logo. */
/**
 * Nombre de host de un dominio propio: sin esquema, puerto ni ruta; al menos un
 * punto (dominio con TLD). Se valida el formato aquí y se normaliza a
 * minúsculas en el backend.
 */
export const HOSTNAME_REGEX = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/** ¿Es un hostname de dominio propio válido (formato, no resolución DNS)? */
export function isValidCustomDomain(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 253 && HOSTNAME_REGEX.test(v);
}

export const UpdateTenantBrandingSchema = z.object({
  /** Color de marca en hex (#RRGGBB); '' lo desactiva. */
  portalBrandColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color hex (#RRGGBB)')
    .optional()
    .or(z.literal('')),
  /** URL pública del logo; '' lo quita. */
  portalLogoUrl: z.string().trim().url().max(500).optional().or(z.literal('')),
  /** Dominio propio (white-label); '' lo quita. Requiere el plan/feature. */
  customDomain: z
    .string()
    .trim()
    .max(253)
    .regex(HOSTNAME_REGEX, 'Dominio no válido (p. ej. trasteros.com)')
    .optional()
    .or(z.literal('')),
});
export type UpdateTenantBrandingInput = z.infer<typeof UpdateTenantBrandingSchema>;

/** PATCH /settings/tenant/access — accesos adicionales + pase nocturno. */
export const UpdateTenantAccessSettingsSchema = z.object({
  extraAccessLimit: z.number().int().min(0).max(10).optional(),
  /** Pase nocturno: el inquilino compra un código de un solo uso que salta el toque de queda. */
  nightPassEnabled: z.boolean().optional(),
  nightPassPrice: z.number().min(0).max(1000).optional(),
});
export type UpdateTenantAccessSettingsInput = z.infer<typeof UpdateTenantAccessSettingsSchema>;
