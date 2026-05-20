'use client';

import { create } from 'zustand';

import type { SuperAdminDto } from '@storageos/shared';

/**
 * Store del super admin. Cambios respecto a la version previa (9A.3):
 *
 *   - El access token vive SOLO en memoria. Ya no se persiste en localStorage.
 *   - El refresh viaja en cookie httpOnly `super_admin_refresh` (path=/admin,
 *     sameSite=strict). El cliente nunca la lee, solo el navegador la envia
 *     automaticamente con `credentials: 'include'`.
 *   - `bootstrap` se hace llamando `/admin/auth/refresh` al montar el layout
 *     admin (analogo a `AuthBootstrap` del tenant).
 */
interface AdminAuthState {
  superAdminToken: string | null;
  superAdmin: SuperAdminDto | null;
  isBootstrapping: boolean;

  setAccessToken: (token: string | null) => void;
  setSession: (token: string, admin: SuperAdminDto) => void;
  setAdmin: (admin: SuperAdminDto | null) => void;
  setBootstrapping: (value: boolean) => void;
  clear: () => void;
}

export const useAdminAuthStore = create<AdminAuthState>((set) => ({
  superAdminToken: null,
  superAdmin: null,
  isBootstrapping: true,

  setAccessToken: (token) => set({ superAdminToken: token }),
  setSession: (token, admin) => set({ superAdminToken: token, superAdmin: admin }),
  setAdmin: (admin) => set({ superAdmin: admin }),
  setBootstrapping: (value) => set({ isBootstrapping: value }),
  clear: () => set({ superAdminToken: null, superAdmin: null }),
}));
