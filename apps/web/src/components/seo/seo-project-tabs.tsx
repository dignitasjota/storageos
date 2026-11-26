'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { SEO_OPEN_TAB_EVENT } from '@/components/seo/assistant/seo-ai-context';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const SEO_PROJECT_TABS = [
  { id: 'rendimiento', label: 'Rendimiento' },
  { id: 'palabras', label: 'Palabras y diagnóstico' },
  { id: 'oportunidades', label: 'Oportunidades' },
  { id: 'competencia', label: 'Competencia' },
  { id: 'tecnico', label: 'Técnico' },
  { id: 'plan', label: 'Plan' },
  { id: 'informes', label: 'Informes y alertas' },
  { id: 'asistente', label: 'Asistente' },
  { id: 'ajustes', label: 'Ajustes' },
] as const;
export type SeoProjectTab = (typeof SEO_PROJECT_TABS)[number]['id'];

const isTab = (v: string | null): v is SeoProjectTab => SEO_PROJECT_TABS.some((t) => t.id === v);

/**
 * Las anclas de los avisos y correos de las PR anteriores (`#alertas`,
 * `#informes`, `#plan`…) llevan a su pestaña.
 */
const HASH_TAB: Record<string, SeoProjectTab> = {
  conversiones: 'rendimiento',
  'paginas-ga4': 'rendimiento',
  ga4: 'ajustes',
  alertas: 'informes',
  informes: 'informes',
  plan: 'plan',
  inspeccion: 'tecnico',
  velocidad: 'tecnico',
  rastreo: 'tecnico',
};

/**
 * La página de un proyecto SEO en pestañas de primer nivel. La pestaña va en
 * la URL (`?tab=`) para poder enlazarla y volver a ella; se lee en el
 * navegador (sin `useSearchParams`, que obligaría a un `Suspense` en la
 * página). Solo se monta la pestaña abierta.
 */
export function SeoProjectTabs({ panels }: { panels: Record<SeoProjectTab, ReactNode> }) {
  const [tab, setTab] = useState<SeoProjectTab>('rendimiento');

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('tab');
    const hash = window.location.hash.replace(/^#/, '');
    const next = isTab(fromQuery) ? fromQuery : (HASH_TAB[hash] ?? null);
    if (next) setTab(next);
    if (hash && HASH_TAB[hash]) {
      // Tras montar la pestaña, baja a la tarjeta del ancla.
      const t = setTimeout(() => document.getElementById(hash)?.scrollIntoView(), 300);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);

  // «Abrir» un brief desde otra pestaña lleva a la del asistente.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const next = (e as CustomEvent<string>).detail;
      if (isTab(next)) setTab(next);
    };
    window.addEventListener(SEO_OPEN_TAB_EVENT, onOpen);
    return () => window.removeEventListener(SEO_OPEN_TAB_EVENT, onOpen);
  }, []);

  const change = (value: string) => {
    if (!isTab(value)) return;
    setTab(value);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', value);
    url.hash = '';
    window.history.replaceState(window.history.state, '', url.toString());
  };

  return (
    <Tabs value={tab} onValueChange={change} className="space-y-4">
      <TabsList aria-label="Secciones del proyecto" className="w-full sm:w-auto">
        {SEO_PROJECT_TABS.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SEO_PROJECT_TABS.map((t) => (
        <TabsContent key={t.id} value={t.id} className="mt-0 space-y-6">
          {panels[t.id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
