interface AdminTwoFactorPolicy {
  requireAdminTwoFactor: boolean;
  adminTwoFactorGraceDays: number;
  adminTwoFactorRequiredSince: Date | null;
}

/**
 * Hasta cuándo puede usar el panel un super admin sin 2FA: los días de gracia
 * cuentan desde que se activó la política o, si es posterior, desde su alta.
 * Null si la política no está activa.
 */
export function adminTwoFactorDeadline(policy: AdminTwoFactorPolicy, createdAt: Date): Date | null {
  if (!policy.requireAdminTwoFactor) return null;
  const since = Math.max(policy.adminTwoFactorRequiredSince?.getTime() ?? 0, createdAt.getTime());
  return new Date(since + policy.adminTwoFactorGraceDays * 86_400_000);
}
