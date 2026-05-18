import type { SubscriptionStatus, TenantStatus, UserRole } from './enums';

/**
 * Representacion publica de un usuario para el frontend. Nunca incluye
 * `passwordHash`, `twoFactorSecret` ni datos sensibles.
 */
export interface UserDto {
  id: string;
  email: string;
  fullName: string;
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

/** Cuerpo de respuesta para `POST /auth/register` y `POST /auth/login`. */
export interface AuthSuccessResponse {
  user: UserDto;
  tenant: TenantDto;
  subscription: SubscriptionDto;
  accessToken: string;
  /** Tiempo de vida del access token, en segundos. */
  expiresIn: number;
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
}
