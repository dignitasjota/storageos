'use client';

import {
  CreateSeoProjectSchema,
  SEO_STRATEGY_LABELS,
  type CreateSeoProjectInput,
  type SeoProjectDto,
  type SeoStrategy,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from './seo-errors';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/** Alta o edición de los datos de un proyecto de SEO. */
export function SeoProjectDialog({
  open,
  onOpenChange,
  project,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sin proyecto, es un alta. */
  project?: SeoProjectDto | null;
  onSubmit: (input: CreateSeoProjectInput) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('ES');
  const [language, setLanguage] = useState('es');
  const [strategy, setStrategy] = useState<SeoStrategy>('local');
  const [businessType, setBusinessType] = useState('');
  const [targetLocation, setTargetLocation] = useState('');
  const [brandTerms, setBrandTerms] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setCountry(project?.country ?? 'ES');
    setLanguage(project?.language ?? 'es');
    setStrategy(project?.strategy ?? 'local');
    setBusinessType(project?.businessType ?? '');
    setTargetLocation(project?.targetLocation ?? '');
    setBrandTerms((project?.brandTerms ?? []).join(', '));
  }, [open, project]);

  const submit = async () => {
    const parsed = CreateSeoProjectSchema.safeParse({
      name,
      country,
      language,
      strategy,
      businessType: businessType.trim() || null,
      targetLocation: targetLocation.trim() || null,
      brandTerms: brandTerms
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos');
      return;
    }
    setSaving(true);
    try {
      await onSubmit(parsed.data);
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{project ? 'Datos del proyecto' : 'Nuevo proyecto de SEO'}</DialogTitle>
          <DialogDescription>
            Un proyecto agrupa una web con sus dominios. Los datos se usan para leer mejor lo que
            llega de Google.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="seo-name">Nombre</Label>
            <Input id="seo-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="seo-country">País (dos letras)</Label>
              <Input
                id="seo-country"
                value={country}
                maxLength={2}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seo-language">Idioma (dos letras)</Label>
              <Input
                id="seo-language"
                value={language}
                maxLength={2}
                onChange={(e) => setLanguage(e.target.value.toLowerCase())}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Alcance</Label>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as SeoStrategy)}>
              <SelectTrigger aria-label="Alcance">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SEO_STRATEGY_LABELS) as SeoStrategy[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {SEO_STRATEGY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seo-location">Zona donde quieres salir</Label>
            <Input
              id="seo-location"
              value={targetLocation}
              placeholder="Valencia y alrededores"
              onChange={(e) => setTargetLocation(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seo-business">Tipo de negocio</Label>
            <Input
              id="seo-business"
              value={businessType}
              placeholder="Alquiler de trasteros"
              onChange={(e) => setBusinessType(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seo-brand">Palabras de tu marca</Label>
            <Input
              id="seo-brand"
              value={brandTerms}
              placeholder="guardalo, guardalobox"
              onChange={(e) => setBrandTerms(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Separadas por comas. Sirven para distinguir a quien ya te conoce.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            {project ? 'Guardar' : 'Crear proyecto'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
