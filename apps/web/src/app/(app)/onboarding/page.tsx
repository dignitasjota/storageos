'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Rocket, Trash2, Truck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type {
  BulkCreateUnitsInput,
  FacilityDto,
  OnboardingDto,
  OnboardingPath,
  UnitTypeDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { useUpdateTenantBillingSettings } from '@/lib/tenant-settings/hooks';

const PATHS: { value: OnboardingPath; title: string; text: string; icon: typeof Rocket }[] = [
  {
    value: 'new',
    title: 'Empiezo de cero',
    text: 'Tengo el local en marcha, o casi, y voy a dar de alta mis trasteros aquí.',
    icon: Building2,
  },
  {
    value: 'opening',
    title: 'Abro pronto',
    text: 'El local aún no está abierto: quiero preparar la web y aceptar reservas.',
    icon: Rocket,
  },
  {
    value: 'migrating',
    title: 'Vengo de otro programa',
    text: 'Ya tengo inquilinos y contratos: los traeré desde un Excel o CSV.',
    icon: Truck,
  },
];

const STEPS = ['Tu punto de partida', 'Tu local', 'Tus trasteros', 'Cómo cobras'];

interface SizeRow {
  name: string;
  m2: string;
  price: string;
  count: string;
}

const DEFAULT_SIZES: SizeRow[] = [
  { name: 'Pequeño', m2: '2', price: '', count: '' },
  { name: 'Mediano', m2: '4', price: '', count: '' },
  { name: 'Grande', m2: '8', price: '', count: '' },
];

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo guardar. Inténtalo de nuevo.';
}

export default function OnboardingWizardPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<OnboardingPath | null>(null);
  const [resumed, setResumed] = useState(false);

  // Si vuelve a entrar con parte hecha, sigue por donde iba.
  useEffect(() => {
    if (resumed || !facilities.data || !unitTypes.data) return;
    setResumed(true);
    if (unitTypes.data.length > 0) setStep(3);
    else if (facilities.data.length > 0) setStep(2);
  }, [facilities.data, unitTypes.data, resumed]);

  const saveState = useMutation({
    mutationFn: (json: { path?: OnboardingPath; wizard?: 'done' | 'skipped' }) =>
      apiFetch<OnboardingDto>('/dashboard/onboarding/state', { method: 'PUT', json }),
    onSuccess: (data) => qc.setQueryData(['dashboard', 'onboarding'], data),
  });

  async function finish(wizard: 'done' | 'skipped') {
    try {
      await saveState.mutateAsync({ wizard });
      router.push(wizard === 'done' ? '/settings/getting-started' : '/dashboard');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Paso {step + 1} de {STEPS.length}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{STEPS[step]}</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void finish('skipped')}>
          Saltar por ahora
        </Button>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
        />
      </div>

      {step === 0 && (
        <div className="grid gap-3">
          {PATHS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                setPath(p.value);
                saveState.mutate({ path: p.value });
                setStep(1);
              }}
              className="flex items-start gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent"
            >
              <p.icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              <span>
                <span className="block font-medium">{p.title}</span>
                <span className="block text-sm text-muted-foreground">{p.text}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {step === 1 && (
        <FacilityStep path={path} onDone={() => setStep(path === 'migrating' ? 3 : 2)} />
      )}
      {step === 2 && (
        <SizesStep
          facilityId={facilities.data?.[0]?.id ?? null}
          onDone={() => setStep(3)}
          onSkip={() => setStep(3)}
        />
      )}
      {step === 3 && <PaymentStep onDone={() => void finish('done')} />}
    </div>
  );
}

function FacilityStep({ path, onDone }: { path: OnboardingPath | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [phone, setPhone] = useState('');
  const [open, setOpen] = useState('09:00');
  const [close, setClose] = useState('20:00');
  const [saturday, setSaturday] = useState(true);
  const [sunday, setSunday] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || !address.trim() || !city.trim()) {
      toast.error('Escribe el nombre, la dirección y la ciudad.');
      return;
    }
    const day = { open, close };
    setSaving(true);
    try {
      const facility = await apiFetch<FacilityDto>('/facilities', {
        method: 'POST',
        json: {
          name,
          address,
          city,
          postalCode,
          country: 'ES',
          timezone: 'Europe/Madrid',
          contactPhone: phone,
          openingHours: {
            mon: day,
            tue: day,
            wed: day,
            thu: day,
            fri: day,
            sat: saturday ? day : null,
            sun: sunday ? day : null,
          },
        },
      });
      if (path === 'opening') {
        await apiFetch(`/facilities/${facility.id}/opening`, {
          method: 'PUT',
          json: { preOpening: true, openingDate: null },
        });
      }
      await qc.invalidateQueries({ queryKey: ['facilities'] });
      onDone();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Los datos de tu local</CardTitle>
        <CardDescription>Salen en tu web y en los contratos.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ob-name">Nombre del local</Label>
          <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ob-address">Dirección</Label>
          <Input id="ob-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="ob-city">Ciudad</Label>
            <Input id="ob-city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-cp">Código postal</Label>
            <Input id="ob-cp" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ob-phone">Teléfono</Label>
          <Input id="ob-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ob-open">Abre</Label>
            <Input
              id="ob-open"
              type="time"
              value={open}
              onChange={(e) => setOpen(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-close">Cierra</Label>
            <Input
              id="ob-close"
              type="time"
              value={close}
              onChange={(e) => setClose(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={saturday} onCheckedChange={(v) => setSaturday(v === true)} />
            Abre los sábados
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={sunday} onCheckedChange={(v) => setSunday(v === true)} />
            Abre los domingos
          </label>
        </div>
        <Button onClick={() => void save()} disabled={saving}>
          Continuar
        </Button>
      </CardContent>
    </Card>
  );
}

function SizesStep({
  facilityId,
  onDone,
  onSkip,
}: {
  facilityId: string | null;
  onDone: () => void;
  onSkip: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<SizeRow[]>(DEFAULT_SIZES);
  const [saving, setSaving] = useState(false);
  const set = (i: number, patch: Partial<SizeRow>) =>
    setRows((r) => r.map((row, n) => (n === i ? { ...row, ...patch } : row)));

  async function save() {
    const used = rows.filter((r) => r.price.trim() || r.count.trim());
    if (!facilityId || used.length === 0) {
      toast.error('Rellena el precio y cuántos tienes de algún tamaño.');
      return;
    }
    const parsed = used.map((r) => ({
      name: r.name.trim(),
      m2: Number(r.m2.replace(',', '.')),
      price: Number(r.price.replace(',', '.')),
      count: Number(r.count),
    }));
    if (
      parsed.some(
        (r) =>
          !r.name || !(r.m2 > 0) || !(r.price >= 0) || !Number.isInteger(r.count) || r.count < 1,
      )
    ) {
      toast.error('Revisa cada fila: nombre, m², precio y cuántos.');
      return;
    }
    setSaving(true);
    try {
      for (const [i, r] of parsed.entries()) {
        const type = await apiFetch<UnitTypeDto>('/unit-types', {
          method: 'POST',
          json: { name: r.name, defaultPriceMonthly: r.price },
        });
        const widthM = Math.round(Math.sqrt(r.m2) * 100) / 100;
        const input: Omit<BulkCreateUnitsInput, 'padding'> & { padding: number } = {
          facilityId,
          unitTypeId: type.id,
          prefix: `${String.fromCharCode(65 + i)}-`,
          start: 1,
          count: r.count,
          padding: 2,
          widthM,
          depthM: Math.round((r.m2 / widthM) * 100) / 100,
          heightM: 2.5,
          basePriceMonthly: r.price,
        };
        await apiFetch('/units/bulk-create', { method: 'POST', json: input });
      }
      await qc.invalidateQueries({ queryKey: ['units'] });
      await qc.invalidateQueries({ queryKey: ['unit-types'] });
      onDone();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tus tamaños y precios</CardTitle>
        <CardDescription>
          Una fila por tamaño, con el precio al mes sin IVA y cuántos trasteros tienes. Crearemos
          todos de golpe; luego podrás ajustar cada uno.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_auto] items-end gap-2">
            <div className="space-y-1">
              {i === 0 && <Label className="text-xs">Tamaño</Label>}
              <Input
                aria-label="Tamaño"
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              {i === 0 && <Label className="text-xs">m²</Label>}
              <Input
                aria-label="Metros cuadrados"
                inputMode="decimal"
                value={r.m2}
                onChange={(e) => set(i, { m2: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              {i === 0 && <Label className="text-xs">€/mes</Label>}
              <Input
                aria-label="Precio al mes"
                inputMode="decimal"
                value={r.price}
                onChange={(e) => set(i, { price: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              {i === 0 && <Label className="text-xs">Cuántos</Label>}
              <Input
                aria-label="Cuántos"
                inputMode="numeric"
                value={r.count}
                onChange={(e) => set(i, { count: e.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Quitar este tamaño"
              onClick={() => setRows((all) => all.filter((_, n) => n !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRows((r) => [...r, { name: '', m2: '', price: '', count: '' }])}
        >
          <Plus className="mr-1 size-4" /> Añadir tamaño
        </Button>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button onClick={() => void save()} disabled={saving}>
            Crear mis trasteros
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Lo haré después
          </Button>
          <Link href="/units/import" className="text-sm text-primary hover:underline">
            Prefiero importar un Excel
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function PaymentStep({ onDone }: { onDone: () => void }) {
  const update = useUpdateTenantBillingSettings();
  const [iban, setIban] = useState('');
  const [cash, setCash] = useState(true);
  const [autoIssue, setAutoIssue] = useState(true);

  async function save() {
    try {
      const clean = iban.replace(/\s/g, '');
      await update.mutateAsync({
        ...(clean ? { transferIban: clean, offlineTransferEnabled: true } : {}),
        offlineCashEnabled: cash,
        autoIssueRecurring: autoIssue,
      });
      onDone();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cómo te pagan tus inquilinos</CardTitle>
        <CardDescription>
          Empieza por lo más sencillo. La tarjeta, Bizum y la domiciliación se añaden después en
          Configuración → Cobros, porque piden datos de tu banco.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ob-iban">IBAN para transferencias (opcional)</Label>
          <Input
            id="ob-iban"
            placeholder="ES00 0000 0000 0000 0000 0000"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={cash}
            onCheckedChange={(v) => setCash(v === true)}
          />
          <span>
            Acepto pagos en el local
            <span className="block text-muted-foreground">Efectivo o datáfono, en persona.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={autoIssue}
            onCheckedChange={(v) => setAutoIssue(v === true)}
          />
          <span>
            Emitir solas las facturas de cada mes
            <span className="block text-muted-foreground">
              Si lo desmarcas, se quedan en borrador hasta que las emitas tú.
            </span>
          </span>
        </label>
        <Button onClick={() => void save()} disabled={update.isPending}>
          Terminar
        </Button>
      </CardContent>
    </Card>
  );
}
