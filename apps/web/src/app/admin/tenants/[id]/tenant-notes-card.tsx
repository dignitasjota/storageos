'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const { data } = useAdminTenantNotes(tenantId);
  const update = useUpdateTenantNotes(tenantId);
  const [ltvTier, setLtvTier] = useState('none');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data && !loaded) {
      setLtvTier(data.ltvTier ?? 'none');
      setNotes(data.strategicNotes ?? '');
      setTags(data.tags ?? []);
      setLoaded(true);
    }
  }, [data, loaded]);

  function toggleTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function onSave() {
    try {
      await update.mutateAsync({
        ltvTier: ltvTier === 'none' ? null : (ltvTier as 'low' | 'medium' | 'high' | 'enterprise'),
        strategicNotes: notes.trim() || null,
        tags,
      });
      toast.success('Notas guardadas.');
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
            {SUGGESTED_TAGS.map((tag) => {
              const on = tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
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
          <Button size="sm" onClick={onSave} disabled={update.isPending}>
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
