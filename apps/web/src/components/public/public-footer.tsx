import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function PublicFooter() {
  const t = useTranslations('publicFooter');
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-border">
      <div className="container flex flex-col gap-3 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>{t('copyright', { year })}</p>
        <nav className="flex items-center gap-4">
          <Link href="/terminos" className="transition hover:text-foreground">
            {t('terms')}
          </Link>
          <Link href="/privacidad" className="transition hover:text-foreground">
            {t('privacy')}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
