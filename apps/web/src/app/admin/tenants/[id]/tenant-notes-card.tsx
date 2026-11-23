'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminTenantNotes, useUpdateTenantNotes } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const LTV_TIERS = [
  { value: 'none', label: 'Sin clasificar' },
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
  { value: 'enterprise', label: 'Enterprise' },
] as const;

const SUGGESTED_TAGS = [
  'riesgo_precio',
  'poca_adopcion',
  'referido',
  'cuenta_clave',
  'churn_riesgo',
  'expansion',
];

export function TenantNotesCard({ tenantId }: { tenantId: string }) {
  const q = useAdminTenantNotes(tenantId);
  const data = q.data;
  const update = useUpdateTenantNotes(tenantId);
  const [ltvTier, setLtvTier] = useState('none');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data && !loaded) {
      setLtvTier(data.ltvTier ?? 'none');
      setNotes(data.strategicNotes ?? '');
      setTags(data.tags ?? []);
      setLoaded(true);
    }
  }, [data, loaded]);

  // Todas sus etiquetas (también las puestas en lote) y las sugeridas.
  const allTags = [...new Set([...tags, ...(data?.tags ?? []), ...SUGGESTED_TAGS])];

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function addTag() {
    const tag = newTag.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
    if (!tag) return;
    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag].slice(0, 20)));
    setNewTag('');
  }

  // Solo se envía lo que ha cambiado: lo que no se tocó no se pisa.
  const original = {
    ltvTier: data?.ltvTier ?? 'none',
    notes: data?.strategicNotes ?? '',
    tags: data?.tags ?? [],
  };
  const sameTags =
    tags.length === original.tags.length && tags.every((t) => original.tags.includes(t));
  const dirty = loaded && (ltvTier !== original.ltvTier || notes !== original.notes || !sameTags);

  async function onSave() {
    try {
      await update.mutateAsync({
        ...(ltvTier !== original.ltvTier
          ? {
              ltvTier:
                ltvTier === 'none' ? null : (ltvTier as 'low' | 'medium' | 'high' | 'enterprise'),
            }
          : {}),
        ...(notes !== original.notes ? { strategicNotes: notes.trim() || null } : {}),
        ...(!sameTags ? { tags } : {}),
      });
      toast.success('Notas guardadas.');
      setLoaded(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notas y valor (interno)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isError ? (
          <AdminError onRetry={() => void q.refetch()} />
        ) : !loaded ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Cargando…
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Valor de vida (LTV)</Label>
              <Select value={ltvTier} onValueChange={setLtvTier}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LTV_TIERS.map((tier) => (
                    <SelectItem key={tier.value} value={tier.value}>
                      {tier.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Etiquetas</Label>
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((tag) => {
                  const on = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      aria-pressed={on}
                      className={
                        on
                          ? 'rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-xs text-primary'
                          : 'rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent'
                      }
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 pt-1">
                <Input
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Otra etiqueta"
                  className="h-8 text-base sm:text-sm"
                  maxLength={40}
                />
                <Button type="button" size="sm" variant="outline" onClick={addTag}>
                  Añadir
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Notas estratégicas</Label>
              <Textarea
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Contexto comercial, razón de riesgo, próximos pasos…"
              />
            </div>

            <div className="flex justify-end">
              <Button size="sm" onClick={onSave} disabled={!dirty || update.isPending}>
                Guardar
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
