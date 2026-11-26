'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { AssistantScope } from '@/lib/seo-advanced/assistant-hooks';

/**
 * Lo que necesitan el asistente y «Preparar contenido» en cualquier pestaña
 * del proyecto: el ámbito (panel admin o tenant), si esta persona puede
 * generar briefs (gasta IA) y si puede cambiar el proyecto (confirmar
 * acciones, editar y pasar a borrador).
 */
export interface SeoAiContextValue {
  scope: AssistantScope;
  canGenerate: boolean;
  canWrite: boolean;
}

const SeoAiContext = createContext<SeoAiContextValue | null>(null);

export function SeoAiProvider({
  value,
  children,
}: {
  value: SeoAiContextValue;
  children: ReactNode;
}) {
  return <SeoAiContext.Provider value={value}>{children}</SeoAiContext.Provider>;
}

/** null fuera de la página de un proyecto (no se enseña «Preparar contenido»). */
export function useSeoAi(): SeoAiContextValue | null {
  return useContext(SeoAiContext);
}

/** Evento para cambiar de pestaña del proyecto desde otra pestaña. */
export const SEO_OPEN_TAB_EVENT = 'seo:open-tab';
/** Evento para abrir un brief si la pestaña del asistente ya está montada. */
export const SEO_OPEN_BRIEF_EVENT = 'seo:open-brief';

/** Lleva a la pestaña «Asistente» y abre ese brief. */
export function openSeoBrief(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', 'asistente');
  url.searchParams.set('brief', id);
  url.hash = '';
  window.history.replaceState(window.history.state, '', url.toString());
  window.dispatchEvent(new CustomEvent(SEO_OPEN_TAB_EVENT, { detail: 'asistente' }));
  window.dispatchEvent(new CustomEvent(SEO_OPEN_BRIEF_EVENT, { detail: id }));
}
