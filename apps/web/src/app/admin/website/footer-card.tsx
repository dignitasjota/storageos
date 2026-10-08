'use client';

import {
  DEFAULT_PLATFORM_FOOTER,
  FOOTER_SOCIAL_NETWORKS,
  UpdatePlatformFooterSchema,
  type FooterSocialNetwork,
  type UpdatePlatformFooterInput,
} from '@storageos/shared';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminPlatformWebsite, useUpdatePlatformFooter } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const SOCIAL_LABELS: Record<FooterSocialNetwork, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X (Twitter)',
  youtube: 'YouTube',
};

const MAX_COLUMNS = 5;
const MAX_LINKS = 12;

/** Mueve un elemento de una lista una posición arriba (-1) o abajo (+1). */
function move<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}

/** Pie de la web: contacto, redes y columnas de enlaces. */
export function FooterCard() {
  const { data } = useAdminPlatformWebsite();
  const update = useUpdatePlatformFooter();
  const [form, setForm] = useState<UpdatePlatformFooterInput | null>(null);

  useEffect(() => {
    if (data && !form) setForm(structuredClone(data.footer));
  }, [data, form]);

  if (!form) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const setColumns = (columns: UpdatePlatformFooterInput['columns']) =>
    setForm({ ...form, columns });
  const setColumn = (i: number, col: UpdatePlatformFooterInput['columns'][number]) =>
    setColumns(form.columns.map((c, idx) => (idx === i ? col : c)));

  async function onSave() {
    if (!form) return;
    const parsed = UpdatePlatformFooterSchema.safeParse(form);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      toast.error(
        issue ? `${describePath(issue.path, form)}: ${issue.message}` : 'Revisa los datos.',
      );
      return;
    }
    try {
      const res = await update.mutateAsync(parsed.data);
      setForm(structuredClone(res.footer));
      toast.success('Pie guardado. La web lo mostrará en un minuto como mucho.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Pie de la web</CardTitle>
        <CardDescription>
          Texto de la marca, datos de contacto, redes sociales y columnas de enlaces. Los enlaces
          pueden ser una ruta de la web (<code>/precios</code>), una sección de la portada (
          <code>/#faq</code>), una web externa (<code>https://…</code>), <code>mailto:</code> o{' '}
          <code>tel:</code>. Términos, privacidad y cookies van siempre en la barra inferior.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="ft-tagline">Texto bajo el logo</Label>
          <Textarea
            id="ft-tagline"
            value={form.tagline}
            maxLength={300}
            onChange={(e) => setForm({ ...form, tagline: e.target.value })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="ft-email">Email</Label>
            <Input
              id="ft-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ft-phone">Teléfono</Label>
            <Input
              id="ft-phone"
              value={form.phone}
              maxLength={40}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ft-address">Dirección</Label>
            <Input
              id="ft-address"
              value={form.address}
              maxLength={200}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
        </div>
        <p className="-mt-4 text-xs text-muted-foreground">Lo que dejes vacío no se muestra.</p>

        <div className="space-y-2">
          <p className="text-sm font-medium">Redes sociales</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FOOTER_SOCIAL_NETWORKS.map((n) => (
              <div key={n} className="space-y-1">
                <Label htmlFor={`ft-social-${n}`} className="text-xs">
                  {SOCIAL_LABELS[n]}
                </Label>
                <Input
                  id={`ft-social-${n}`}
                  value={form.social[n]}
                  placeholder="https://…"
                  onChange={(e) =>
                    setForm({ ...form, social: { ...form.social, [n]: e.target.value } })
                  }
                />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Columnas de enlaces</p>
            <Button
              size="sm"
              variant="outline"
              disabled={form.columns.length >= MAX_COLUMNS}
              onClick={() => setColumns([...form.columns, { title: 'Nueva columna', links: [] }])}
            >
              <Plus className="mr-1 size-4" />
              Añadir columna
            </Button>
          </div>
          {form.columns.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin columnas: solo se verá la marca.</p>
          )}
          {form.columns.map((col, ci) => (
            <div key={ci} className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Título de la columna"
                  value={col.title}
                  maxLength={40}
                  className="font-medium"
                  onChange={(e) => setColumn(ci, { ...col, title: e.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Subir columna"
                  disabled={ci === 0}
                  onClick={() => setColumns(move(form.columns, ci, -1))}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Bajar columna"
                  disabled={ci === form.columns.length - 1}
                  onClick={() => setColumns(move(form.columns, ci, 1))}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Quitar columna"
                  onClick={() => setColumns(form.columns.filter((_, idx) => idx !== ci))}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
              <ul className="space-y-2">
                {col.links.map((link, li) => {
                  const setLinks = (links: typeof col.links) => setColumn(ci, { ...col, links });
                  return (
                    <li key={li} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        aria-label="Texto del enlace"
                        placeholder="Texto"
                        value={link.label}
                        maxLength={60}
                        className="sm:w-48"
                        onChange={(e) =>
                          setLinks(
                            col.links.map((l, idx) =>
                              idx === li ? { ...l, label: e.target.value } : l,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label="Dirección del enlace"
                        placeholder="/#faq o https://…"
                        value={link.href}
                        maxLength={300}
                        onChange={(e) =>
                          setLinks(
                            col.links.map((l, idx) =>
                              idx === li ? { ...l, href: e.target.value } : l,
                            ),
                          )
                        }
                      />
                      <div className="flex shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Subir enlace"
                          disabled={li === 0}
                          onClick={() => setLinks(move(col.links, li, -1))}
                        >
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Bajar enlace"
                          disabled={li === col.links.length - 1}
                          onClick={() => setLinks(move(col.links, li, 1))}
                        >
                          <ArrowDown className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Quitar enlace"
                          onClick={() => setLinks(col.links.filter((_, idx) => idx !== li))}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                disabled={col.links.length >= MAX_LINKS}
                onClick={() =>
                  setColumn(ci, { ...col, links: [...col.links, { label: '', href: '/' }] })
                }
              >
                <Plus className="mr-1 size-4" />
                Añadir enlace
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setForm(structuredClone(DEFAULT_PLATFORM_FOOTER));
              toast.info('Pie por defecto cargado. Pulsa «Guardar» para aplicarlo.');
            }}
          >
            Restaurar el de por defecto
          </Button>
          <Button onClick={() => void onSave()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Traduce la ruta de un error de validación a algo legible. */
function describePath(path: (string | number)[], form: UpdatePlatformFooterInput): string {
  const [first, second, third, fourth] = path;
  if (first === 'columns' && typeof second === 'number') {
    const col = form.columns[second];
    const name = col?.title ? `«${col.title}»` : `columna ${second + 1}`;
    if (third === 'links' && typeof fourth === 'number') {
      return `Enlace ${fourth + 1} de ${name}`;
    }
    return `Columna ${name}`;
  }
  if (first === 'social' && typeof second === 'string') {
    return SOCIAL_LABELS[second as FooterSocialNetwork] ?? 'Red social';
  }
  const labels: Record<string, string> = {
    tagline: 'Texto bajo el logo',
    email: 'Email',
    phone: 'Teléfono',
    address: 'Dirección',
  };
  return labels[String(first)] ?? 'Dato';
}
