import { create } from 'zustand';

interface AuthState {
  /** Access token JWT en memoria (RAM). Se pierde al recargar la pagina,
   *  y se recupera via /auth/refresh con la cookie httpOnly. */
  accessToken: string | null;
  /** `true` mientras se intenta recuperar el access token al cargar la app. */
  isBootstrapping: boolean;

  setAccessToken: (token: string | null) => void;
  setBootstrapping: (value: boolean) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  isBootstrapping: true,
  setAccessToken: (token) => set({ accessToken: token }),
  setBootstrapping: (value) => set({ isBootstrapping: value }),
  clear: () => set({ accessToken: null }),
}));
