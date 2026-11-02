'use client';

import { LEGAL_SLUGS, type LegalSlug, type LegalVersionDto } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  fetchLegalVersion,
  useAdminLegalDoc,
  useLegalFill,
  useLegalVersions,
  useUpdateLegalDoc,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const SLUG_LABEL: Record<LegalSlug, string> = {
  terms: 'Términos y Condiciones',
  privacy: 'Política de Privacidad',
  cookies: 'Política de Cookies',
  'data-deletion': 'Eliminación de datos',
};

/** Huecos por rellenar del texto de serie: «[NIF]», «[Domicilio social]»… */
function placeholders(content: string): string[] {
  return [...new Set(content.match(/\[[^\]\n]{2,40}\](?!\()/g) ?? [])];
}

export default function AdminLegalPage() {
  const confirm = useConfirm();
  const [tab, setTab] = useState<LegalSlug>('terms');
  const [dirty, setDirty] = useState<Partial<Record<LegalSlug, boolean>>>({});
  const anyDirty = Object.values(dirty).some(Boolean);

  // Aviso al cerrar o recargar la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [anyDirty]);

  async function changeTab(next: string) {
    if (
      dirty[tab] &&
      !(await confirm({ title: 'Tienes cambios sin guardar. ¿Salir igualmente?' }))
    ) {
      return;
    }
    setDirty((d) => ({ ...d, [tab]: false }));
    setTab(next as LegalSlug);
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Páginas legales</h1>
        <p className="text-sm text-muted-foreground">
          El texto (en Markdown) de las páginas legales de trasteros.pro. La web las muestra en unos
          minutos tras guardar. Completa los datos entre corchetes (razón social, NIF, domicilio,
          correo…).
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => void changeTab(v)}>
        <TabsList className="flex h-auto flex-wrap">
          {LEGAL_SLUGS.map((slug) => (
            <TabsTrigger key={slug} value={slug}>
              {SLUG_LABEL[slug]}
              {dirty[slug] && <span className="ml-1 text-amber-600">•</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {LEGAL_SLUGS.map((slug) => (
          <TabsContent key={slug} value={slug} className="mt-4">
            <LegalEditor
              slug={slug}
              onDirtyChange={(v) => setDirty((d) => (d[slug] === v ? d : { ...d, [slug]: v }))}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function LegalEditor({
  slug,
  onDirtyChange,
}: {
  slug: LegalSlug;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const canEdit = useIsSuperadmin();
  const doc = useAdminLegalDoc(slug);
  const update = useUpdateLegalDoc(slug);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [notifyTenants, setNotifyTenants] = useState(false);
  const [viewing, setViewing] = useState<LegalVersionDto | null>(null);
  const versions = useLegalVersions(slug);
  const fill = useLegalFill();
  const confirm = useConfirm();

  // Precargar cuando llegan los datos (o se vuelven a cargar tras guardar).
  useEffect(() => {
    if (doc.data) {
      setTitle(doc.data.title);
      setContent(doc.data.content);
    }
  }, [doc.data]);

  const dirty = !!doc.data && (title !== doc.data.title || content !== doc.data.content);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const holes = placeholders(content);
  const fillable = holes.filter((h) => fill.data?.values[h]);

  function fillHoles() {
    const values = fill.data?.values ?? {};
    let next = content;
    for (const [k, v] of Object.entries(values)) next = next.split(k).join(v);
    setContent(next);
    toast.success('Rellenado con los datos de Facturación SaaS. Revísalo y guarda.');
  }

  async function openVersion(id: string) {
    try {
      setViewing(await fetchLegalVersion(slug, id));
    } catch {
      toast.error('No se pudo abrir la versión.');
    }
  }

  async function save() {
    try {
      if (
        notifyTenants &&
        !(await confirm({
          title: 'Se avisará por correo a todos los tenants y tendrán que aceptarla en su panel.',
        }))
      ) {
        return;
      }
      await update.mutateAsync({ title: title.trim(), content, notifyTenants });
      setNotifyTenants(false);
      void versions.refetch();
      toast.success(
        notifyTenants
          ? 'Guardado. Los tenants recibirán el aviso para aceptarla.'
          : 'Guardado. La página pública lo mostrará en unos minutos.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  if (doc.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{SLUG_LABEL[slug]}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {doc.data?.updatedAt
              ? `Última actualización: ${formatDateTime(doc.data.updatedAt)}`
              : 'Texto de serie: aún no se ha guardado ninguna versión propia.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Editar' : 'Vista previa'}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={
              update.isPending || !title.trim() || content.trim().length < 20 || !canEdit || !dirty
            }
          >
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {holes.length > 0 && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            <p>Quedan datos por rellenar y se publican tal cual: {holes.join(', ')}.</p>
            {fillable.length > 0 && canEdit && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={fillHoles}>
                Rellenar con los datos de Facturación SaaS
              </Button>
            )}
            {(fill.data?.missing.length ?? 0) > 0 && (
              <p>
                Faltan en Facturación SaaS: {fill.data?.missing.join(', ')}.{' '}
                <a href="/admin/platform-billing" className="underline">
                  Completarlos
                </a>
              </p>
            )}
          </div>
        )}
        {(slug === 'terms' || slug === 'privacy') && canEdit && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={notifyTenants}
              onChange={(e) => setNotifyTenants(e.target.checked)}
            />
            <span>
              Es un cambio importante: avisar a los tenants por correo y pedirles que lo acepten en
              su panel (queda registrado quién y cuándo).
            </span>
          </label>
        )}
        {preview ? (
          <div className="rounded-lg border border-border p-4">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">{title}</h2>
            <MarkdownView content={content} />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`title-${slug}`}>Título</Label>
              <Input
                id={`title-${slug}`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`content-${slug}`}>Contenido (Markdown)</Label>
              <textarea
                id={`content-${slug}`}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                className="h-[60vh] w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Markdown: <code># Título</code>, <code>## Sección</code>, <code>- lista</code>,{' '}
                <code>**negrita**</code>, <code>[texto](/enlace)</code>.
              </p>
            </div>
          </>
        )}
        <VersionsList versions={versions.data ?? []} onOpen={(id) => void openVersion(id)} />
        {viewing && (
          <VersionView
            version={viewing}
            current={content}
            onClose={() => setViewing(null)}
            onRestore={() => {
              setTitle(viewing.title);
              setContent(viewing.content ?? '');
              setViewing(null);
              setPreview(false);
              toast.info('Versión cargada en el editor. Guarda para volver a publicarla.');
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function VersionsList({
  versions,
  onOpen,
}: {
  versions: LegalVersionDto[];
  onOpen: (id: string) => void;
}) {
  if (versions.length === 0) return null;
  return (
    <details className="rounded-lg border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Versiones ({versions.length})</summary>
      <ul className="mt-2 divide-y">
        {versions.map((v, i) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>
              {formatDateTime(v.createdAt)}
              {i === 0 && <span className="ml-1 text-xs text-emerald-600">vigente</span>}
              {v.authorName && (
                <span className="text-xs text-muted-foreground"> · {v.authorName}</span>
              )}
              {v.notifyTenants && (
                <span className="text-xs text-muted-foreground">
                  {' '}
                  · aceptada por {v.acceptedCount} tenant(s)
                </span>
              )}
            </span>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onOpen(v.id)}>
              Ver y comparar
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Diferencias línea a línea entre una versión y el texto del editor. */
function lineDiff(a: string, b: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  // LCS acotado: textos legales de unos cientos de líneas.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: 'same', text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: x[i++]! });
    } else {
      out.push({ type: 'add', text: y[j++]! });
    }
  }
  while (i < n) out.push({ type: 'del', text: x[i++]! });
  while (j < m) out.push({ type: 'add', text: y[j++]! });
  return out;
}

function VersionView({
  version,
  current,
  onClose,
  onRestore,
}: {
  version: LegalVersionDto;
  current: string;
  onClose: () => void;
  onRestore: () => void;
}) {
  const diff = lineDiff(version.content ?? '', current).filter((d) => d.text.trim() !== '');
  const changed = diff.filter((d) => d.type !== 'same').length;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Versión del {formatDateTime(version.createdAt)} frente al editor
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {changed === 0 ? 'sin cambios' : `${changed} línea(s) distintas`}
          </span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onRestore}>
            Cargar esta versión
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        En rojo, lo que tenía esa versión y ya no está; en verde, lo nuevo del editor.
      </p>
      <div className="max-h-[50vh] overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs">
        {diff.map((d, k) => (
          <p
            key={k}
            className={
              d.type === 'add'
                ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                : d.type === 'del'
                  ? 'bg-red-100 text-red-900 line-through dark:bg-red-950 dark:text-red-200'
                  : 'text-muted-foreground'
            }
          >
            {d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  '}
            {d.text}
          </p>
        ))}
      </div>
    </div>
  );
}
