'use client';

import { Menu, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

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
}: {
  items: OnePageNavItem[];
  brand: string;
  tenantName: string;
  logoUrl: string | null;
  portalHref: string;
}) {
  const [open, setOpen] = useState(false);

  function goTo(id: string) {
    setOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function goTop() {
    setOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={goTop}
          className="flex items-center gap-2 font-semibold"
          aria-label={tenantName}
        >
          {logoUrl ? (
            <Image
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
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {it.label}
            </button>
          ))}
          <Link
            href={portalHref}
            className="ml-2 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            Área cliente
          </Link>
        </nav>

        {/* Móvil: acceso + botón de menú */}
        <div className="flex items-center gap-2 md:hidden">
          <Link
            href={portalHref}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-white shadow-sm"
            style={{ backgroundColor: brand }}
          >
            Área cliente
          </Link>
          <button
            type="button"
            aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
            onClick={() => setOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-md border"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Panel de navegación en móvil */}
      {open && (
        <nav className="border-t md:hidden">
          <div className="mx-auto flex max-w-6xl flex-col px-2 py-2">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => goTo(it.id)}
                className="rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {it.label}
              </button>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
