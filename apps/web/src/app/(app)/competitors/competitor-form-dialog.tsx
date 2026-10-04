'use client';

import {
  COMPETITOR_CONTACT_METHOD_LABELS,
  COMPETITOR_FEATURE_LABELS,
  CompetitorContactMethodEnum,
  CompetitorFeatureEnum,
  type CompetitorContactMethod,
  type CompetitorFacilityDto,
  type CompetitorFeature,
  type CreateCompetitorFacilityInput,
} from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCreateCompetitorFacility, useUpdateCompetitorFacility } from '@/lib/competitors/hooks';

interface FormState {
  name: string;
  zone: string;
  facilityId: string;
  priceIncludesVat: boolean;
  phone: string;
  website: string;
  address: string;
  contactMethod: CompetitorContactMethod | '';
  contactNotes: string;
  distanceKm: string;
  inventoryComplete: boolean;
  knownTotalUnits: string;
  currentPromotion: string;
  depositAmount: string;
  setupFee: string;
  mandatoryInsuranceMonthly: string;
  features: CompetitorFeature[];
  notes: string;
}

const empty: FormState = {
  name: '',
  zone: '',
  facilityId: '',
  priceIncludesVat: true,
  phone: '',
  website: '',
  address: '',
  contactMethod: '',
  contactNotes: '',
  distanceKm: '',
  inventoryComplete: false,
  knownTotalUnits: '',
  currentPromotion: '',
  depositAmount: '',
  setupFee: '',
  mandatoryInsuranceMonthly: '',
  features: [],
  notes: '',
};

const str = (n: number | null) => (n == null ? '' : String(n));
const toNum = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

function fromDto(f: CompetitorFacilityDto): FormState {
  return {
    name: f.name,
    zone: f.zone ?? '',
    facilityId: f.facilityId ?? '',
    priceIncludesVat: f.priceIncludesVat,
    phone: f.phone ?? '',
    website: f.website ?? '',
    address: f.address ?? '',
    contactMethod: f.contactMethod ?? '',
    contactNotes: f.contactNotes ?? '',
    distanceKm: str(f.distanceKm),
    inventoryComplete: f.inventoryComplete,
    knownTotalUnits: str(f.knownTotalUnits),
    currentPromotion: f.currentPromotion ?? '',
    depositAmount: str(f.depositAmount),
    setupFee: str(f.setupFee),
    mandatoryInsuranceMonthly: str(f.mandatoryInsuranceMonthly),
    features: f.features,
    notes: f.notes ?? '',
  };
}

/** Alta y edición de un competidor (datos, contacto, inventario, costes y características). */
export function CompetitorFormDialog({
  open,
  onOpenChange,
  editing,
  myFacilities,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: CompetitorFacilityDto | null;
  myFacilities: { id: string; name: string }[];
  onCreated?: (id: string) => void;
}) {
  const create = useCreateCompetitorFacility();
  const update = useUpdateCompetitorFacility();
  const [form, setForm] = useState<FormState>(empty);
  useEffect(() => {
    if (open) setForm(editing ? fromDto(editing) : empty);
  }, [open, editing]);
  const set = (patch: Partial<FormState>) => setForm((s) => ({ ...s, ...patch }));

  async function onSubmit() {
    if (!form.name.trim()) {
      toast.error('Indica el nombre.');
      return;
    }
    const input: CreateCompetitorFacilityInput = {
      name: form.name.trim(),
      zone: form.zone.trim(),
      facilityId: form.facilityId || null,
      priceIncludesVat: form.priceIncludesVat,
      notes: form.notes.trim(),
      phone: form.phone.trim(),
      website: form.website.trim(),
      address: form.address.trim(),
      contactMethod: form.contactMethod || null,
      contactNotes: form.contactNotes.trim(),
      distanceKm: toNum(form.distanceKm),
      inventoryComplete: form.inventoryComplete,
      knownTotalUnits: toNum(form.knownTotalUnits),
      currentPromotion: form.currentPromotion.trim(),
      depositAmount: toNum(form.depositAmount),
      setupFee: toNum(form.setupFee),
      mandatoryInsuranceMonthly: toNum(form.mandatoryInsuranceMonthly),
      features: form.features,
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, input });
      } else {
        const created = await create.mutateAsync(input);
        onCreated?.(created.id);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar competidor' : 'Nuevo competidor'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <Section title="Datos">
            <Field label="Nombre">
              <Input
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="p. ej. BlueSpace Vallecas"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Zona">
                <Input
                  value={form.zone}
                  onChange={(e) => set({ zone: e.target.value })}
                  placeholder="Barrio"
                />
              </Field>
              <Field label="Distancia a mi local (km)">
                <Input
                  inputMode="decimal"
                  value={form.distanceKm}
                  onChange={(e) => set({ distanceKm: e.target.value })}
                  placeholder="—"
                />
              </Field>
            </div>
            <Field label="Dirección">
              <Input value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Compite con mi local">
                <Select
                  value={form.facilityId || 'none'}
                  onValueChange={(v) => set({ facilityId: v === 'none' ? '' : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Ninguno</SelectItem>
                    {myFacilities.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Sus precios">
                <Select
                  value={form.priceIncludesVat ? 'incl' : 'excl'}
                  onValueChange={(v) => set({ priceIncludesVat: v === 'incl' })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="incl">Incluyen IVA</SelectItem>
                    <SelectItem value="excl">Sin IVA</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>

          <Section title="Contacto">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Teléfono">
                <Input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                />
              </Field>
              <Field label="Web">
                <Input
                  value={form.website}
                  onChange={(e) => set({ website: e.target.value })}
                  placeholder="https://…"
                />
              </Field>
            </div>
            <Field label="Cómo lo consulto">
              <Select
                value={form.contactMethod || 'none'}
                onValueChange={(v) =>
                  set({ contactMethod: v === 'none' ? '' : (v as CompetitorContactMethod) })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin indicar</SelectItem>
                  {CompetitorContactMethodEnum.options.map((m) => (
                    <SelectItem key={m} value={m}>
                      {COMPETITOR_CONTACT_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Cómo hacerlo la próxima vez">
              <Textarea
                rows={2}
                value={form.contactNotes}
                onChange={(e) => set({ contactNotes: e.target.value })}
                placeholder="p. ej. página «Disponibilidad» de su web; preguntar por Ana de 10 a 14 h"
              />
            </Field>
          </Section>

          <Section title="Inventario">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={form.inventoryComplete}
                onCheckedChange={(v) => set({ inventoryComplete: v === true })}
                className="mt-0.5"
              />
              <span>
                Inventario completo: tengo fichados todos sus trasteros
                <span className="block text-xs text-muted-foreground">
                  Solo así su ocupación es fiable y cuenta para el precio.
                </span>
              </span>
            </label>
            {!form.inventoryComplete && (
              <Field label="Total de trasteros que sé que tiene (opcional)">
                <Input
                  inputMode="numeric"
                  value={form.knownTotalUnits}
                  onChange={(e) => set({ knownTotalUnits: e.target.value })}
                  placeholder="p. ej. lo dice su web"
                />
              </Field>
            )}
          </Section>

          <Section title="Costes y promoción">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Fianza (€)">
                <Input
                  inputMode="decimal"
                  value={form.depositAmount}
                  onChange={(e) => set({ depositAmount: e.target.value })}
                />
              </Field>
              <Field label="Alta (€)">
                <Input
                  inputMode="decimal"
                  value={form.setupFee}
                  onChange={(e) => set({ setupFee: e.target.value })}
                />
              </Field>
              <Field label="Seguro obligatorio (€/mes)">
                <Input
                  inputMode="decimal"
                  value={form.mandatoryInsuranceMonthly}
                  onChange={(e) => set({ mandatoryInsuranceMonthly: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Promoción actual">
              <Input
                value={form.currentPromotion}
                onChange={(e) => set({ currentPromotion: e.target.value })}
                placeholder="p. ej. primer mes gratis"
              />
            </Field>
          </Section>

          <Section title="Características">
            <div className="grid grid-cols-2 gap-2">
              {CompetitorFeatureEnum.options.map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.features.includes(f)}
                    onCheckedChange={(v) =>
                      set({
                        features:
                          v === true ? [...form.features, f] : form.features.filter((x) => x !== f),
                      })
                    }
                  />
                  {COMPETITOR_FEATURE_LABELS[f]}
                </label>
              ))}
            </div>
          </Section>

          <Section title="Notas">
            <Textarea
              rows={2}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </Section>
        </div>

        <DialogFooter>
          <Button onClick={() => void onSubmit()} disabled={create.isPending || update.isPending}>
            {editing ? 'Guardar' : 'Crear'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
