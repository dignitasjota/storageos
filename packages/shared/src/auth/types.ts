import type { SubscriptionStatus, TenantStatus, UserRole } from './enums';
import type { Permission } from './permissions';
import type { TenantFeature } from '../features';

/**
 * Representacion publica de un usuario para el frontend. Nunca incluye
 * `passwordHash`, `twoFactorSecretEncrypted` ni datos sensibles.
 */
export interface UserDto {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  twoFactorEnabled: boolean;
}

/**
 * Datos publicos del tenant para el usuario logueado. Incluye los campos de
 * configuracion que el frontend necesita para formatear fechas/monedas e
 * indicar el estado de la cuenta.
 */
export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  trialEndsAt: string | null;
  locale: string;
  currency: string;
  timezone: string;
  /** Marca del tenant (el panel la muestra con la función `branded_panel`). */
  brandColor: string | null;
  logoUrl: string | null;
  /** El logo es un fichero subido (se puede usar en el icono de la app). */
  logoUploaded: boolean;
}

/** Datos minimos de la suscripcion (para banners del trial, etc.). */
export interface SubscriptionDto {
  status: SubscriptionStatus;
  planSlug: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

/** Cuerpo de respuesta para `POST /auth/login` y `POST /auth/verify-email`. */
export interface AuthSuccessResponse {
  user: UserDto;
  tenant: TenantDto;
  subscription: SubscriptionDto;
  accessToken: string;
  /** Tiempo de vida del access token, en segundos. */
  expiresIn: number;
}

/**
 * Cuerpo de respuesta para `POST /auth/register`. NO emite tokens hasta
 * que el usuario verifique su email; el frontend debe redirigir a la
 * pantalla "Te hemos enviado un email".
 */
export interface RegisterPendingResponse {
  user: UserDto;
  tenant: TenantDto;
  subscription: SubscriptionDto;
  requiresEmailVerification: true;
}

/** Cuerpo de respuesta para `POST /auth/refresh`. */
export interface RefreshSuccessResponse {
  accessToken: string;
  expiresIn: number;
}

/** Cuerpo de respuesta para `GET /auth/me`. */
export interface MeResponse {
  user: UserDto;
  tenant: TenantDto;
  subscription: SubscriptionDto;
  /** Permisos efectivos del usuario (derivados de su rol). */
  permissions: Permission[];
  /** Features premium incluidas en el plan del tenant (gating por plan). */
  features: TenantFeature[];
  /** Locales (facility IDs) a los que el usuario está restringido; null = todos. */
  facilityScope: string[] | null;
  /**
   * Presente solo si la sesión es una impersonación del soporte de TrasterOS:
   * el panel muestra un aviso con la hora de fin y no deja salir a otra sesión.
   */
  impersonation?: ImpersonationSessionDto;
}

export interface ImpersonationSessionDto {
  /** Fin de la sesión (ISO). */
  expiresAt: string;
  /** Solo lectura: el API rechaza cualquier cambio. */
  readOnly: boolean;
}

/**
 * Respuesta de `POST /auth/login` cuando el user tiene 2FA activado. NO
 * emite tokens: el frontend debe pedir el codigo y llamar a `/auth/2fa/challenge`
 * con el `pendingToken`.
 */
export interface LoginRequires2faResponse {
  requires2fa: true;
  pendingToken: string;
  /** TTL en segundos del pendingToken. */
  expiresIn: number;
}

/**
 * Respuesta de `POST /auth/login` cuando el tenant tiene
 * `requireTwoFactorForManagers` activo y el user (owner|manager) no tiene
 * 2FA configurado. NO emite tokens: el frontend debe redirigir al usuario
 * a la pagina de enrolment forzoso con este `enrolmentToken`.
 */
export interface LoginRequires2faEnrolmentResponse {
  requires2faEnrolment: true;
  enrolmentToken: string;
  /** TTL en segundos del enrolmentToken. */
  expiresIn: number;
}

/** Respuesta de `POST /auth/2fa/setup`. El frontend renderiza el QR. */
export interface Setup2faResponse {
  otpauthUri: string;
  secretBase32: string;
}

/**
 * Respuesta de `POST /auth/2fa/verify` y `POST /auth/2fa/recovery-codes/regenerate`.
 * Los recovery codes se muestran al user UNA SOLA VEZ.
 */
export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

/** Estado del 2FA del user (para `/settings/security`). */
export interface TwoFactorStatusResponse {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

/**
 * Estado de la politica de seguridad del tenant. El owner puede leerlo y
 * mutarlo desde `/settings/security`. Por ahora solo expone el flag
 * `requireTwoFactorForManagers`; en el futuro alojaremos aqui otras
 * politicas (longitud minima de contrasena, etc).
 */
export interface TenantSecuritySettingsResponse {
  requireTwoFactorForManagers: boolean;
}

/** GET/PATCH /settings/tenant/profile. */
export interface TenantProfileResponse {
  name: string;
  slug: string;
  timezone: string;
  contactPhone: string | null;
  contactEmail: string | null;
}

/**
 * Ajustes de facturacion del tenant gestionables por el owner desde
 * `/settings/billing`.
 */
export interface TenantBillingSettingsResponse {
  autoChargeOnIssue: boolean;
  autoIssueRecurring: boolean;
  lateFeeEnabled: boolean;
  lateFeeType: 'percentage' | 'fixed';
  lateFeeValue: number;
  lateFeeGraceDays: number;
  /** Desde este día del mes, el primer pago incluye el mes siguiente (null = no). */
  firstPaymentNextMonthFromDay: number | null;
  autoChargeRetryEnabled: boolean;
  autoChargeRetryMax: number;
  autoChargeRetryIntervalDays: number;
  transferIban: string | null;
}

/** Respuesta de `/settings/tenant/reviews` (auto-solicitud de valoraciones). */
export interface TenantReviewsSettingsResponse {
  reviewsAutoRequest: boolean;
  reviewRequestDelayDays: number;
  googleReviewUrl: string | null;
}

export interface TenantMonthlyDigestSettingsResponse {
  enabled: boolean;
}

export interface TenantMonthlyDigestResultDto {
  sent: boolean;
  recipients: number;
}

export interface TenantBrandingResponse {
  portalBrandColor: string | null;
  /** Cabecera de la web pública con el color de la marca (botón «Reservar» en blanco). */
  webHeaderBranded: boolean;
  portalLogoUrl: string | null;
  /** El logo es un fichero subido (no una dirección pegada). */
  logoUploaded: boolean;
  /** Dominio propio configurado (white-label), o null. */
  customDomain: string | null;
  /** null = pendiente de activación por el super admin; ISO = activo. */
  customDomainVerifiedAt: string | null;
  /** Contenido de la meta tag de verificación de Google Search Console, o null. */
  googleSiteVerification: string | null;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  /** Favicon de la web pública (subido al bucket público), o null = el de TrasterOS. */
  faviconUrl: string | null;
}

/** URL firmada para subir el favicon de la web del tenant. */
export interface TenantFaviconUploadDto {
  uploadUrl: string;
  key: string;
  requiredHeaders: Record<string, string>;
}

export interface TenantAccessSettingsResponse {
  /** Máximo de accesos adicionales que un inquilino puede crearse en el portal. */
  extraAccessLimit: number;
  /** Pase nocturno: compra de un código de un solo uso que salta el toque de queda. */
  nightPassEnabled: boolean;
  nightPassPrice: number;
}

/** GET /me/sessions — una sesión abierta del usuario. */
export interface UserSessionDto {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  installedApp: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** La de este navegador. */
  current: boolean;
}

/** GET /settings/tenant/health — algo de la configuración que conviene revisar. */
export interface ConfigHealthItemDto {
  key: string;
  /** `error`: impide algo (facturar, cobrar…); `warning`: conviene revisarlo. */
  level: 'error' | 'warning';
  title: string;
  detail: string;
  /** Dónde se arregla. */
  href: string;
}

/** POST /settings/tenant/domain/check — ¿apunta ya el dominio a la plataforma? */
export interface CustomDomainCheckDto {
  domain: string;
  pointsToPlatform: boolean;
  /** Lo que devuelve hoy el DNS del dominio (direcciones o el CNAME). */
  found: string[];
  /** A qué tiene que apuntar. */
  expected: string[];
  /** Cuándo se avisó al equipo de TrasterOS de que ya apunta. */
  readyAt: string | null;
}
