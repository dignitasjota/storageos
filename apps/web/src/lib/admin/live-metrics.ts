/** Métricas y Finanzas se refrescan cada minuto mientras la pestaña está a la vista. */
export const LIVE_METRICS = {
  staleTime: 30_000,
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
} as const;
