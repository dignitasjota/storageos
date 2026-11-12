/**
 * Conversiones de la web de TrasterOS en Google Analytics (si el visitante ha
 * aceptado la analítica: sin `gtag` cargado no se manda nada).
 */
export function trackConversion(name: string, params: Record<string, string> = {}): void {
  if (typeof window === 'undefined') return;
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  gtag?.('event', name, params);
}
