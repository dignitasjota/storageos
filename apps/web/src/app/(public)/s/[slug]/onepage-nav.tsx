'use client';

import { Menu, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { goToSection, goToTop } from './site-sections';

export interface OnePageNavItem {
  id: string;
  label: string;
}

/**
 * Barra superior de la plantilla «una página». Los enlaces de sección hacen
 * scroll suave a su ancla; «Área cliente» es un enlace real al portal del
 * inquilino (no hace scroll). Menú hamburguesa en móvil.
 */
export function OnePageNav({
  items,
  brand,
  tenantName,
  logoUrl,
  portalHref,
  blogHref,
  languageSwitcher,
  onBrand = false,
  homeHref,
}: {
  items: OnePageNavItem[];
  brand: string;
  tenantName: string;
  logoUrl: string | null;
  portalHref: string;
  /** Enlace real al blog del tenant (no hace scroll), o `undefined` si no tiene. */
  blogHref?: string;
  /** Selector ES/EN. */
  languageSwitcher?: ReactNode;
  /** Cabecera del color de la marca: textos en blanco y el botón en blanco. */
  onBrand?: boolean;
  /** Desde otra página (la reserva): las secciones y el logo llevan a la portada. */
  homeHref?: string;
}) {
  const t = useTranslations('publicWeb');
  const [open, setOpen] = useState(false);
  const linkTone = onBrand
    ? 'text-white/80 hover:text-white'
    : 'text-muted-foreground hover:text-foreground';
  const panelTone = onBrand
    ? 'text-white/90 hover:bg-white/10 hover:text-white'
    : 'text-muted-foreground hover:bg-accent hover:text-foreground';
  const buttonStyle = onBrand
    ? { backgroundColor: '#ffffff', color: brand }
    : { backgroundColor: brand, color: '#ffffff' };

  function goTo(id: string) {
    setOpen(false);
    goToSection(id, homeHref);
  }
  function goTop() {
    setOpen(false);
    goToTop(homeHref);
  }

  return (
    <header
      className={`sticky top-0 z-50 border-b backdrop-blur ${
        onBrand ? 'border-black/10 text-white' : 'border-border/60 bg-background/90'
      }`}
      style={onBrand ? { backgroundColor: brand } : undefined}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={goTop}
          className="flex items-center gap-2 font-semibold"
          aria-label={tenantName}
        >
          {logoUrl ? (
            <Image
              unoptimized
              src={logoUrl}
              alt={tenantName}
              width={120}
              height={28}
              className="h-7 w-auto object-contain"
            />
          ) : (
            <span>{tenantName}</span>
          )}
        </button>

        {/* Navegación de escritorio */}
        <nav className="hidden items-center gap-1 md:flex">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => goTo(it.id)}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${linkTone}`}
            >
              {it.label}
            </button>
          ))}
          {blogHref && (
            <Link
              href={blogHref}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${linkTone}`}
            >
              {t('blog.title')}
            </Link>
          )}
          {languageSwitcher && <span className="ml-2">{languageSwitcher}</span>}
          <Link
            href={portalHref}
            className="ml-2 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium shadow-sm transition-opacity hover:opacity-90"
            style={buttonStyle}
          >
            {t('chrome.clientAccess')}
          </Link>
        </nav>

        {/* Móvil: acceso + botón de menú */}
        <div className="flex items-center gap-2 md:hidden">
          {languageSwitcher}
          <Link
            href={portalHref}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium shadow-sm"
            style={buttonStyle}
          >
            {t('chrome.clientAccess')}
          </Link>
          <button
            type="button"
            aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
            onClick={() => setOpen((v) => !v)}
            className={`flex h-9 w-9 items-center justify-center rounded-md border ${onBrand ? 'border-white/40' : ''}`}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Panel de navegación en móvil */}
      {open && (
        <nav className={`border-t md:hidden ${onBrand ? 'border-white/20' : ''}`}>
          <div className="mx-auto flex max-w-6xl flex-col px-2 py-2">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => goTo(it.id)}
                className={`rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${panelTone}`}
              >
                {it.label}
              </button>
            ))}
            {blogHref && (
              <Link
                href={blogHref}
                onClick={() => setOpen(false)}
                className={`rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${panelTone}`}
              >
                {t('blog.title')}
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
