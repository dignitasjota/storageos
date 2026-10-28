import { CabeTemplate } from './cabe-template';
import { CorporateTemplate } from './corporate-template';
import { EscaparateTemplate } from './escaparate-template';
import { getLanding } from './landing-shared';
import { OnePageTemplate } from './onepage-template';
import { OnePageMovilTemplate } from './onepagemovil-template';
import { TenantWebChrome } from './tenant-web-chrome';
import { TrstromTemplate } from './trstrom-template';

import type { PublicWebLocale } from './i18n/messages';
import type { ComponentProps, ReactNode } from 'react';

type Brand = ComponentProps<typeof TenantWebChrome>['data'];

/**
 * La misma cabecera y el mismo pie que la portada del tenant, para las páginas
 * de su web que no son la portada (reserva y firma). Las plantillas con marco
 * propio (Onepage, Escaparate, Corporativa, OnePageMovil, Trstrom y Cabe) lo
 * pintan alrededor del contenido; el resto usa `TenantWebChrome` con la
 * plantilla y el color de la cabecera de la portada. Si la portada no se puede
 * cargar, el marco genérico con los datos de marca que traiga la página.
 */
export async function TenantSiteChrome({
  slug,
  fallback,
  locale,
  googleAnalyticsId,
  languageHrefBuilder,
  children,
}: {
  slug: string;
  fallback: Brand;
  locale: PublicWebLocale;
  googleAnalyticsId?: string | null;
  languageHrefBuilder?: (locale: PublicWebLocale) => string;
  children: ReactNode;
}) {
  const landing = await getLanding(slug).catch(() => null);
  if (landing) {
    // El selector de idioma de la cabecera lleva a esta misma página en el
    // otro idioma, no a la portada.
    const otherLocale: PublicWebLocale = locale === 'es' ? 'en' : 'es';
    const otherLocaleHref = languageHrefBuilder?.(otherLocale);
    const props = {
      data: landing,
      locale,
      children,
      ...(otherLocaleHref ? { otherLocaleHref } : {}),
    };
    switch (landing.webTemplate) {
      case 'cabe':
        return <CabeTemplate {...props} />;
      case 'trstrom':
        return <TrstromTemplate {...props} />;
      case 'onepagemovil':
        return <OnePageMovilTemplate {...props} />;
      case 'onepage':
        return <OnePageTemplate {...props} />;
      case 'escaparate':
        return <EscaparateTemplate {...props} />;
      case 'corporate':
        return <CorporateTemplate {...props} />;
    }
  }
  return (
    <TenantWebChrome
      hideReserve
      locale={locale}
      data={landing ?? fallback}
      hasBlog={landing?.hasBlog}
      googleAnalyticsId={landing?.googleAnalyticsId ?? googleAnalyticsId}
      {...(languageHrefBuilder ? { languageHrefBuilder } : {})}
    >
      {children}
    </TenantWebChrome>
  );
}
