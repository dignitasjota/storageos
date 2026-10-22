/**
 * ¿Se está usando como app instalada (pantalla de inicio) y no en una pestaña
 * del navegador? Safari de iOS lo indica con `navigator.standalone`; el resto,
 * con la media query `display-mode`.
 */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayMode =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches;
  return standalone || Boolean(displayMode);
}
