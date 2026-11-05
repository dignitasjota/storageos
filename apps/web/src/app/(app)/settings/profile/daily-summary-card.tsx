'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { DailySummaryPrefs } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDailySummaryPrefs, useSaveDailySummaryPrefs } from '@/lib/dashboard/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const HOURS = Array.from({ length: 16 }, (_, i) => i + 5);

/** A qué hora, de qué locales y por dónde llega el resumen del día. */
export function DailySummaryCard() {
  const prefs = useDailySummaryPrefs();
  const save = useSaveDailySummaryPrefs();
  const facilities = useFacilities();
  const [form, setForm] = useState<DailySummaryPrefs | null>(null);
  useEffect(() => {
    if (prefs.data) setForm(prefs.data);
  }, [prefs.data]);
  if (!form) return null;

  const toggleFacility = (id: string, on: boolean) =>
    setForm({
      ...form,
      facilityIds: on ? [...form.facilityIds, id] : form.facilityIds.filter((f) => f !== id),
    });
  const submit = async () => {
    try {
      await save.mutateAsync(form);
      toast.success('Resumen del día guardado.');
    } catch {
      toast.error('No se ha podido guardar.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Resumen del día</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-40 space-y-1">
          <Label>Hora</Label>
          <Select
            value={String(form.hour)}
            onValueChange={(v) => setForm({ ...form, hour: Number(v) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, '0')}:00
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(facilities.data?.length ?? 0) > 1 && (
          <div className="space-y-2">
            <Label>Locales (sin marcar ninguno, todos los tuyos)</Label>
            {facilities.data?.map((f) => (
              <div key={f.id} className="flex items-center gap-2">
                <Checkbox
                  id={`summary-${f.id}`}
                  checked={form.facilityIds.includes(f.id)}
                  onCheckedChange={(v) => toggleFacility(f.id, v === true)}
                />
                <Label htmlFor={`summary-${f.id}`} className="font-normal">
                  {f.name}
                </Label>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Checkbox
            id="summary-push"
            checked={form.push}
            onCheckedChange={(v) => setForm({ ...form, push: v === true })}
          />
          <Label htmlFor="summary-push" className="font-normal">
            Avisarme también en el móvil
          </Label>
        </div>
        <Button disabled={save.isPending} onClick={() => void submit()}>
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
