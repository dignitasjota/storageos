'use client';

import { useEffect } from 'react';

import type { LandingSection } from '@storageos/shared';

/**
 * Secciones candidatas de cada dirección fija, en orden: cada plantilla nombra
 * sus secciones a su manera (`espacios`, `trasteros`, `centros`…); se baja a la
 * primera que exista. Sin formulario de contacto, `/contacto` baja a los
 * centros (teléfonos, direcciones y horarios).
 */
const TARGETS: Record<LandingSection, string[]> = {
  precios: ['espacios', 'trasteros', 'centros', 'precios', 'locales'],
  contacto: ['contacto', 'locales', 'centros', 'precios'],
};

/** Baja sola a la sección de `/precios` o `/contacto` al cargar la web. */
export function ScrollToSection({ section }: { section: LandingSection }) {
  useEffect(() => {
    const el = TARGETS[section]
      .map((id) => document.getElementById(id))
      .find((x): x is HTMLElement => x != null);
    if (!el) return;
    // Tras el primer pintado (imágenes y mapas pueden mover la posición).
    const go = () => el.scrollIntoView({ block: 'start' });
    const raf = requestAnimationFrame(go);
    const t = setTimeout(go, 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [section]);
  return null;
}
