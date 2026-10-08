import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { PlatformLogo } from '@/components/public/platform-logo';

const CONTACT_EMAIL = 'info@trasteros.pro';

/** Pie de la web de TrasterOS: gris oscuro, con columnas de enlaces. */
export function PublicFooter({ logoUrl }: { logoUrl: string | null }) {
  const t = useTranslations('publicFooter');
  const year = new Date().getUTCFullYear();
  const columns: { title: string; links: { href: string; label: string }[] }[] = [
    {
      title: t('product'),
      links: [
        { href: '/#funcionalidades', label: t('features') },
        { href: '/#precios', label: t('pricing') },
        { href: '/#faq', label: t('faq') },
      ],
    },
    {
      title: t('solutions'),
      links: [
        { href: '/#para-quien', label: t('operators') },
        { href: '/#administradores', label: t('managers') },
        { href: '/#viviendas', label: t('housing') },
      ],
    },
    {
      title: t('account'),
      links: [
        { href: '/login', label: t('login') },
        { href: '/register', label: t('register') },
        { href: '/portal/login', label: t('tenantPortal') },
      ],
    },
    {
      title: t('legal'),
      links: [
        { href: '/terminos', label: t('terms') },
        { href: '/privacidad', label: t('privacy') },
        { href: '/cookies', label: t('cookies') },
      ],
    },
  ];

  return (
    <footer className="bg-slate-900 text-slate-300">
      <div className="container grid grid-cols-2 gap-x-6 gap-y-10 py-14 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="col-span-2 space-y-4 md:col-span-1">
          <PlatformLogo logoUrl={logoUrl} className="h-8" />
          <p className="max-w-xs text-sm leading-relaxed text-slate-400">{t('tagline')}</p>
          <p className="text-sm">
            <span className="text-slate-400">{t('contact')}: </span>
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-slate-200 hover:text-white">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="text-sm font-semibold text-white">{col.title}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-slate-400 transition hover:text-white">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-slate-800">
        <div className="container py-5 text-sm text-slate-500">{t('copyright', { year })}</div>
      </div>
    </footer>
  );
}
