/** Rendimiento de una campaña en un día (lo que dan Google Ads y Meta Ads). */
export interface AdDailyStats {
  /** YYYY-MM-DD */
  date: string;
  /** En la divisa de la cuenta. */
  cost: number;
  impressions: number;
  clicks: number;
  /** Conversiones que cuenta la plataforma (Google puede dar fracciones). */
  conversions: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
