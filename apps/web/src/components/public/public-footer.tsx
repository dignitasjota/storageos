import {
  DEFAULT_PLATFORM_FOOTER,
  FOOTER_SOCIAL_NETWORKS,
  type FooterSocialNetwork,
  type UpdatePlatformFooterInput,
} from '@storageos/shared';
import {
  ArrowRight,
  Facebook,
  Instagram,
  Linkedin,
  Mail,
  MapPin,
  Phone,
  Twitter,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CookieSettingsLink } from '@/components/public/cookie-settings-link';
import { PlatformLogo } from '@/components/public/platform-logo';
import { Button } from '@/components/ui/button';

const SOCIAL_ICONS: Record<FooterSocialNetwork, LucideIcon> = {
  linkedin: Linkedin,
  instagram: Instagram,
  facebook: Facebook,
  x: Twitter,
  youtube: Youtube,
};

const SOCIAL_LABELS: Record<FooterSocialNetwork, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  youtube: 'YouTube',
};

/** Enlace externo (otra web): se abre en pestaña nueva. */
const isExternal = (href: string) => href.startsWith('https://');

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const className = 'text-slate-400 transition hover:text-white';
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  if (href.startsWith('mailto:') || href.startsWith('tel:')) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

/**
 * Pie de la web de TrasterOS: llamada a la acción, marca con contacto y redes,
 * columnas de enlaces (gestionadas desde el panel admin → Web de TrasterOS) y
 * barra inferior con los textos legales.
 */
export function PublicFooter({
  logoUrl,
  hasContact = false,
  footer,
  analytics = false,
}: {
  logoUrl: string | null;
  hasContact?: boolean;
  footer?: UpdatePlatformFooterInput | null;
  /** Con analítica, enlace para cambiar el consentimiento de cookies. */
  analytics?: boolean;
}) {
  const t = useTranslations('publicFooter');
  const year = new Date().getUTCFullYear();
  const data = footer ?? DEFAULT_PLATFORM_FOOTER;
  // El ancla del formulario solo existe si está activo.
  const columns = data.columns
    .map((col) => ({
      ...col,
      links: col.links.filter((l) => hasContact || l.href !== '/#contacto'),
    }))
    .filter((col) => col.links.length > 0);
  const socials = FOOTER_SOCIAL_NETWORKS.filter((n) => data.social[n]);

  return (
    <footer className="bg-slate-900 text-slate-300">
      {/* Llamada a la acción */}
      <div className="border-b border-slate-800">
        <div className="container flex flex-col items-start justify-between gap-6 py-12 md:flex-row md:items-center">
          <div>
            <p className="text-2xl font-semibold tracking-tight text-white">{t('ctaTitle')}</p>
            <p className="mt-2 max-w-xl text-slate-400">{t('ctaSubtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/register">
                {t('ctaPrimary')}
                <ArrowRight className="ml-2 size-4" aria-hidden />
              </Link>
            </Button>
            {hasContact && (
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-slate-600 bg-transparent text-white hover:bg-slate-800 hover:text-white"
              >
                <Link href="/#contacto">{t('ctaSecondary')}</Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Marca + columnas */}
      <div className="container grid grid-cols-2 gap-x-6 gap-y-10 py-14 md:grid-cols-4 lg:grid-cols-6">
        <div className="col-span-2 space-y-5">
          <PlatformLogo logoUrl={logoUrl} className="h-8" />
          {data.tagline && (
            <p className="max-w-sm text-sm leading-relaxed text-slate-400">{data.tagline}</p>
          )}
          {(data.email || data.phone || data.address) && (
            <ul className="space-y-2 text-sm">
              {data.email && (
                <li className="flex items-center gap-2">
                  <Mail className="size-4 shrink-0 text-slate-500" aria-hidden />
                  <a href={`mailto:${data.email}`} className="text-slate-200 hover:text-white">
                    {data.email}
                  </a>
                </li>
              )}
              {data.phone && (
                <li className="flex items-center gap-2">
                  <Phone className="size-4 shrink-0 text-slate-500" aria-hidden />
                  <a
                    href={`tel:${data.phone.replace(/\s+/g, '')}`}
                    className="text-slate-200 hover:text-white"
                  >
                    {data.phone}
                  </a>
                </li>
              )}
              {data.address && (
                <li className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden />
                  <span>{data.address}</span>
                </li>
              )}
            </ul>
          )}
          {socials.length > 0 && (
            <ul className="flex gap-2">
              {socials.map((n) => {
                const Icon = SOCIAL_ICONS[n];
                return (
                  <li key={n}>
                    <a
                      href={data.social[n]}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={SOCIAL_LABELS[n]}
                      title={SOCIAL_LABELS[n]}
                      className="flex size-9 items-center justify-center rounded-full bg-slate-800 text-slate-300 transition hover:bg-primary hover:text-white"
                    >
                      <Icon className="size-4" aria-hidden />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="text-sm font-semibold text-white">{col.title}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {col.links.map((link) => (
                <li key={`${link.href}-${link.label}`}>
                  <FooterLink href={link.href}>{link.label}</FooterLink>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      {/* Barra inferior */}
      <div className="border-t border-slate-800">
        <div className="container flex flex-col gap-3 py-5 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>{t('copyright', { year })}</span>
          <nav aria-label={t('legal')} className="flex flex-wrap gap-x-5 gap-y-1">
            <Link href="/terminos" className="hover:text-white">
              {t('terms')}
            </Link>
            <Link href="/privacidad" className="hover:text-white">
              {t('privacy')}
            </Link>
            <Link href="/cookies" className="hover:text-white">
              {t('cookies')}
            </Link>
            {analytics && <CookieSettingsLink label={t('cookieSettings')} />}
          </nav>
        </div>
      </div>
    </footer>
  );
}
