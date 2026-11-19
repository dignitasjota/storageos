'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';

import type { AiAboutType } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';

/**
 * «Preguntar al asistente» desde una ficha: abre el asistente con este
 * registro ya cargado («¿cuánto me debe este inquilino?»).
 */
export function AskAssistantButton({
  type,
  id,
  label,
}: {
  type: AiAboutType;
  id: string;
  /** Cómo se llama el registro («Laura Martín», «C-2026-00012»…). */
  label: string;
}) {
  const hasFeature = useHasFeature('ai_assistant');
  const canUse = useHasPermission('ai:use');
  if (!hasFeature || !canUse) return null;
  const params = new URLSearchParams({ about: `${type}:${id}`, label });
  return (
    <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
      <Link href={`/assistant?${params.toString()}`}>
        <Sparkles className="mr-1 h-3.5 w-3.5" /> Preguntar al asistente
      </Link>
    </Button>
  );
}
