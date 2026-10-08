'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';

import { CONSENT_EVENT, readConsent, type CookieConsent } from '@/components/public/cookie-consent';

/**
 * Google Analytics 4 de la web de TrasterOS (ID en panel admin → Web de
 * TrasterOS → SEO). Solo se carga cuando el visitante acepta la analítica.
 */
export function PlatformAnalytics({ measurementId }: { measurementId: string }) {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    setAllowed(readConsent() === 'all');
    const onChange = (e: Event) =>
      setAllowed((e as CustomEvent<CookieConsent | null>).detail === 'all');
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, []);

  if (!allowed) return null;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="platform-ga4" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}', { anonymize_ip: true });`}
      </Script>
    </>
  );
}
