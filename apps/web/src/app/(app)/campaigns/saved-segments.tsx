'use client';

import { type CampaignSegmentInput } from '@storageos/shared';
import { Bookmark, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useCampaignSegments,
  useDeleteCampaignSegment,
  useSaveCampaignSegment,
} from '@/lib/campaigns/hooks';

/**
 * Elegir un segmento guardado (rellena «a quién va») o guardar el actual para
 * reutilizarlo. Los segmentos son del equipo.
 */
export function SavedSegmentPicker({
  current,
  onPick,
}: {
  current: () => CampaignSegmentInput;
  onPick: (segment: CampaignSegmentInput) => void;
}) {
  const ask = useConfirm();
  const segments = useCampaignSegments();
  const save = useSaveCampaignSegment();
  const remove = useDeleteCampaignSegment();
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const list = segments.data ?? [];

  async function confirmSave() {
    if (name.trim().length < 2) {
      toast.error('Ponle un nombre al segmento.');
      return;
    }
    try {
      const created = await save.mutateAsync({ name: name.trim(), segment: current() });
      setSelected(created.id);
      setSaving(false);
      setName('');
      toast.success('Segmento guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  async function removeSelected() {
    const seg = list.find((s) => s.id === selected);
    if (!seg) return;
    const ok = await ask({
      title: `¿Borrar el segmento «${seg.name}»?`,
      description: 'Las campañas que ya lo usaron no cambian.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(seg.id);
      setSelected('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar');
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      {list.length > 0 && (
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-sm">Usar un segmento guardado</Label>
          <Select
            value={selected}
            onValueChange={(id) => {
              setSelected(id);
              const s = list.find((x) => x.id === id);
              if (s) onPick(s.segment);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Elige uno" />
            </SelectTrigger>
            <SelectContent>
              {list.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {selected && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Borrar el segmento"
          title="Borrar el segmento"
          onClick={() => void removeSelected()}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => setSaving(true)}>
        <Bookmark className="mr-1 size-4" />
        Guardar este segmento
      </Button>
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Guardar el segmento</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="segment-name">Nombre</Label>
            <Input
              id="segment-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Inquilinos sin seguro"
              className="text-base sm:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Guarda los filtros de «A quién va» para usarlos en otras campañas.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaving(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void confirmSave()} disabled={save.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
