import type { UserRole } from '../auth/enums';

/** Representacion completa de un user para la pantalla de gestion. */
export interface UserDetailDto {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  /** Rol personalizado del tenant asignado (null = solo rol enum). */
  tenantRoleId: string | null;
  /** Permisos por local: locales asignados ([] = ve todos los locales). */
  facilityIds: string[];
  isActive: boolean;
  emailVerifiedAt: string | null;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Resumen para listados. */
export type UserSummaryDto = Pick<
  UserDetailDto,
  'id' | 'email' | 'fullName' | 'role' | 'isActive' | 'lastLoginAt' | 'twoFactorEnabled'
>;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationDto {
  id: string;
  email: string;
  role: UserRole;
  invitedByName: string | null;
  status: InvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** GET /invitations/token/:token — informacion publica para mostrar la pantalla de aceptacion. */
export interface PublicInvitationDto {
  email: string;
  role: UserRole;
  tenant: { name: string; slug: string };
  inviterName: string | null;
  expiresAt: string;
}
