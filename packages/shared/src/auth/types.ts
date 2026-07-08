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
}

/** Respuesta de `/settings/tenant/reviews` (auto-solicitud de valoraciones). */
export interface TenantReviewsSettingsResponse {
  reviewsAutoRequest: boolean;
  reviewRequestDelayDays: number;
  googleReviewUrl: string | null;
}

export interface TenantBrandingResponse {
  portalBrandColor: string | null;
  portalLogoUrl: string | null;
  /** Dominio propio configurado (white-label), o null. */
  customDomain: string | null;
  /** null = pendiente de activación por el super admin; ISO = activo. */
  customDomainVerifiedAt: string | null;
}

export interface TenantAccessSettingsResponse {
  /** Máximo de accesos adicionales que un inquilino puede crearse en el portal. */
  extraAccessLimit: number;
  /** Pase nocturno: compra de un código de un solo uso que salta el toque de queda. */
  nightPassEnabled: boolean;
  nightPassPrice: number;
}
