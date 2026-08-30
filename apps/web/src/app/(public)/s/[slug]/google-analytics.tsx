import Script from 'next/script';

/**
 * Inyecta gtag.js (Google Analytics 4) en la web pública del tenant si
 * configuró su Measurement ID en Ajustes → Marca (SEO técnico). No-op si no
 * lo configuró — sin coste ni petición de red de más.
 */
/**
 * Envía un evento de conversión a GA4 (`gtag('event', ...)`). No-op si el
 * tenant no configuró GA4 (sin `window.gtag`, p. ej. server-render o sin
 * measurement ID) — llamar sin comprobar antes es siempre seguro.
 */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { gtag?: (...args: unknown[]) => void };
  w.gtag?.('event', name, params ?? {});
}

export function GoogleAnalyticsScript({ measurementId }: { measurementId: string | null }) {
  if (!measurementId) return null;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}');`}
      </Script>
    </>
  );
}
