'use client';

import { ChevronDown, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { PlatformLogo } from '@/components/public/platform-logo';
import {
  FEATURE_ICONS,
  PRODUCT_MENU,
  RESOURCES_MENU,
  SOLUTIONS_MENU,
  featureAnchor,
  type SiteMenuLink,
} from '@/components/public/site-nav';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuthStore } from '@/lib/auth/store';

type MenuKey = 'product' | 'solutions' | 'resources';

/** Cabecera de la web de TrasterOS: fondo del color de marca, menú desplegable y logo configurable. */
export function PublicHeader({
  logoUrl,
  hasContact = false,
}: {
  logoUrl: string | null;
  hasContact?: boolean;
}) {
  const t = useTranslations('publicHeader');
  const common = useTranslations('common');
  const pathname = usePathname();
  const accessToken = useAuthStore((s) => s.accessToken);
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);
  const showAppCta = !isBootstrapping && accessToken !== null;
  // En el portal del inquilino (acceso por magic link) no tienen sentido los
  // CTA de iniciar sesión / crear cuenta del staff.
  const isPortal = pathname?.startsWith('/portal') ?? false;
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const resources = RESOURCES_MENU.filter((l) => !l.needsContact || hasContact);
  const close = () => setOpen(null);

  return (
    <header
      className="sticky top-0 z-30 bg-primary text-primary-foreground shadow-sm"
      onMouseLeave={close}
    >
      <div className="container flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex shrink-0 items-center" aria-label={common('appName')}>
          <PlatformLogo logoUrl={logoUrl} className="h-7 sm:h-8" />
        </Link>
        {!isPortal && (
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Principal">
            <MenuTrigger
              label={t('menu.product')}
              active={open === 'product'}
              onOpen={() => setOpen('product')}
              onToggle={() => setOpen(open === 'product' ? null : 'product')}
            />
            <MenuTrigger
              label={t('menu.solutions')}
              active={open === 'solutions'}
              onOpen={() => setOpen('solutions')}
              onToggle={() => setOpen(open === 'solutions' ? null : 'solutions')}
            />
            <Link
              href="/#precios"
              onMouseEnter={close}
              className="rounded-md px-3 py-2 text-sm font-medium text-primary-foreground/85 transition hover:bg-white/10 hover:text-primary-foreground"
            >
              {t('menu.pricing')}
            </Link>
            <MenuTrigger
              label={t('menu.resources')}
              active={open === 'resources'}
              onOpen={() => setOpen('resources')}
              onToggle={() => setOpen(open === 'resources' ? null : 'resources')}
            />
          </nav>
        )}
        <div className="flex items-center gap-2">
          {isPortal ? null : showAppCta ? (
            <Button asChild className="bg-white text-primary hover:bg-white/90">
              <Link href="/dashboard">{t('goToApp')}</Link>
            </Button>
          ) : (
            <>
              <Button
                asChild
                variant="ghost"
                className="hidden text-primary-foreground hover:bg-white/10 hover:text-primary-foreground sm:inline-flex"
              >
                <Link href="/login">{t('login')}</Link>
              </Button>
              <Button asChild className="bg-white text-primary shadow-sm hover:bg-white/90">
                <Link href="/register">{t('register')}</Link>
              </Button>
            </>
          )}
          {!isPortal && (
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground lg:hidden"
              aria-label={t('menu.open')}
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
          )}
        </div>
      </div>

      {/* Desplegable de escritorio */}
      {open && !isPortal && (
        <div className="absolute inset-x-0 top-full hidden border-t border-border/60 bg-background text-foreground shadow-xl lg:block">
          <div className="container py-8">
            {open === 'product' && <ProductPanel onNavigate={close} />}
            {open === 'solutions' && (
              <LinkPanel
                title={t('menu.solutions')}
                links={SOLUTIONS_MENU}
                onNavigate={close}
                columns="sm:grid-cols-3"
              />
            )}
            {open === 'resources' && (
              <LinkPanel
                title={t('menu.resources')}
                links={resources}
                onNavigate={close}
                columns="sm:grid-cols-3"
              />
            )}
          </div>
        </div>
      )}

      {/* Menú del móvil */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="right" className="w-80 overflow-y-auto p-0">
          <SheetTitle className="border-b px-5 py-4 text-base">{t('menu.title')}</SheetTitle>
          <MobileMenu
            resources={resources}
            showLogin={!showAppCta}
            onNavigate={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </header>
  );
}

function MenuTrigger({
  label,
  active,
  onOpen,
  onToggle,
}: {
  label: string;
  active: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={active}
      onMouseEnter={onOpen}
      onClick={onToggle}
      className={`flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium transition hover:bg-white/10 hover:text-primary-foreground ${
        active ? 'bg-white/10 text-primary-foreground' : 'text-primary-foreground/85'
      }`}
    >
      {label}
      <ChevronDown className={`size-4 transition ${active ? 'rotate-180' : ''}`} aria-hidden />
    </button>
  );
}

function ProductPanel({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('publicHeader');
  const landing = useTranslations('landing');
  return (
    <div className="grid gap-8 md:grid-cols-4">
      {PRODUCT_MENU.map((col) => (
        <div key={col.group}>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t(`menu.groups.${col.group}`)}
          </p>
          <ul className="mt-3 space-y-1">
            {col.features.map((key) => {
              const Icon = FEATURE_ICONS[key];
              return (
                <li key={key}>
                  <Link
                    href={featureAnchor(key)}
                    onClick={onNavigate}
                    className="group flex items-center gap-3 rounded-lg p-2 text-sm font-medium transition hover:bg-primary/5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    {landing(`features.${key}.title`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="md:col-span-4">
        <Link
          href="/#funcionalidades"
          onClick={onNavigate}
          className="text-sm font-medium text-primary hover:underline"
        >
          {t('menu.allFeatures')} →
        </Link>
      </div>
    </div>
  );
}

function LinkPanel({
  title,
  links,
  onNavigate,
  columns,
}: {
  title: string;
  links: SiteMenuLink[];
  onNavigate: () => void;
  columns: string;
}) {
  const t = useTranslations('publicHeader');
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul className={`mt-3 grid gap-2 ${columns}`}>
        {links.map((l) => (
          <li key={l.key}>
            <Link
              href={l.href}
              onClick={onNavigate}
              className="group flex items-start gap-3 rounded-lg p-3 transition hover:bg-primary/5"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
                <l.icon className="size-4" aria-hidden />
              </span>
              <span>
                <span className="block text-sm font-medium">{t(`menu.links.${l.key}.title`)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(`menu.links.${l.key}.description`)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MobileMenu({
  resources,
  showLogin,
  onNavigate,
}: {
  resources: SiteMenuLink[];
  showLogin: boolean;
  onNavigate: () => void;
}) {
  const t = useTranslations('publicHeader');
  const landing = useTranslations('landing');
  const section = (title: string, items: { key: string; href: string; label: string }[]) => (
    <div className="border-b px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul className="mt-2 space-y-1">
        {items.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              onClick={onNavigate}
              className="block rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div>
      {section(
        t('menu.product'),
        PRODUCT_MENU.flatMap((c) => c.features).map((key) => ({
          key,
          href: featureAnchor(key),
          label: landing(`features.${key}.title`),
        })),
      )}
      {section(
        t('menu.solutions'),
        SOLUTIONS_MENU.map((l) => ({
          key: l.key,
          href: l.href,
          label: t(`menu.links.${l.key}.title`),
        })),
      )}
      <div className="border-b px-5 py-4">
        <Link href="/#precios" onClick={onNavigate} className="block text-sm font-medium">
          {t('menu.pricing')}
        </Link>
      </div>
      {section(
        t('menu.resources'),
        resources.map((l) => ({
          key: l.key,
          href: l.href,
          label: t(`menu.links.${l.key}.title`),
        })),
      )}
      {showLogin && (
        <div className="px-5 py-4">
          <Button asChild variant="outline" className="w-full">
            <Link href="/login" onClick={onNavigate}>
              {t('login')}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
