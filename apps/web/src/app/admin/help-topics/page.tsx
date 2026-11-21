'use client';

import {
  FEATURE_LABELS,
  HELP_IMAGE_MAX_BYTES,
  HELP_IMAGE_MIME_TYPES,
  HELP_TOPIC_GROUPS,
  HELP_TOPIC_ID_RE,
  HelpTopicContentSchema,
  TenantFeatures,
  searchHelpTopics,
  toEmbedVideoUrl,
  type AdminHelpTopicDto,
  type HelpTopic,
  type HelpTopicContentInput,
  type HelpTopicGroup,
  type TenantFeature,
} from '@storageos/shared';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import {
  useAdminHelpTopics,
  useCreateHelpTopic,
  useResetHelpTopic,
  useUpdateHelpTopic,
  useUploadHelpImage,
} from '@/lib/admin/help-topics-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const NO_FEATURE = '__none__';

interface FormState {
  id: string;
  group: HelpTopicGroup;
  title: string;
  summary: string;
  steps: string[];
  links: { label: string; href: string }[];
  keywords: string;
  feature: TenantFeature | null;
  position: string;
  published: boolean;
  imageKey: string | null;
  imageUrl: string | null;
  videoUrl: string;
}

function formFrom(topic: AdminHelpTopicDto | null, nextPosition: number): FormState {
  if (!topic) {
    return {
      id: '',
      group: 'Día a día',
      title: '',
      summary: '',
      steps: [''],
      links: [],
      keywords: '',
      feature: null,
      position: String(nextPosition),
      published: true,
      imageKey: null,
      imageUrl: null,
      videoUrl: '',
    };
  }
  return {
    id: topic.id,
    group: topic.group,
    title: topic.title,
    summary: topic.summary,
    steps: topic.steps.length > 0 ? [...topic.steps] : [''],
    links: topic.links.map((l) => ({ ...l })),
    keywords: topic.keywords ?? '',
    feature: topic.feature ?? null,
    position: String(topic.position),
    published: topic.published,
    imageKey: topic.imageKey,
    imageUrl: topic.imageUrl,
    videoUrl: topic.videoUrl ?? '',
  };
}

function contentOf(form: FormState): HelpTopicContentInput {
  return {
    group: form.group,
    title: form.title.trim(),
    summary: form.summary.trim(),
    steps: form.steps.map((s) => s.trim()).filter(Boolean),
    links: form.links
      .map((l) => ({ label: l.label.trim(), href: l.href.trim() }))
      .filter((l) => l.label || l.href),
    keywords: form.keywords.trim() || null,
    feature: form.feature,
  };
}

/** El texto del formulario es el mismo que el de la guía del código. */
function sameAsOriginal(content: HelpTopicContentInput, original: HelpTopic): boolean {
  return (
    content.group === original.group &&
    content.title === original.title &&
    content.summary === original.summary &&
    JSON.stringify(content.steps) === JSON.stringify(original.steps) &&
    JSON.stringify(content.links) === JSON.stringify(original.links) &&
    (content.keywords ?? '') === (original.keywords ?? '') &&
    (content.feature ?? null) === (original.feature ?? null)
  );
}

/** Mueve un elemento de una lista una posición arriba (-1) o abajo (+1). */
function move<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}

const FIELD_LABELS: Record<string, string> = {
  group: 'Grupo',
  title: 'Título',
  summary: 'Resumen',
  steps: 'Pasos',
  links: 'Enlaces',
  keywords: 'Palabras clave',
};

export default function AdminHelpTopicsPage() {
  const topics = useAdminHelpTopics();
  const canEdit = useIsSuperadmin();
  const update = useUpdateHelpTopic();
  const reset = useResetHelpTopic();
  const ask = useConfirm();
  const [editing, setEditing] = useState<AdminHelpTopicDto | 'new' | null>(null);
  const [search, setSearch] = useState('');

  const all = useMemo(() => topics.data ?? [], [topics.data]);
  const shown = useMemo(() => searchHelpTopics(all, search), [all, search]);
  const nextPosition = useMemo(() => Math.max(0, ...all.map((t) => t.position)) + 10, [all]);

  async function toggleHidden(topic: AdminHelpTopicDto) {
    try {
      await update.mutateAsync({ id: topic.id, input: { hidden: !topic.hidden } });
      toast.success(topic.hidden ? 'La guía vuelve a verse.' : 'Guía oculta para los tenants.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onReset(topic: AdminHelpTopicDto) {
    const custom = topic.source === 'custom';
    const ok = await ask({
      title: custom ? '¿Borrar esta guía?' : '¿Dejar la guía como viene en la aplicación?',
      description: custom
        ? 'Los tenants dejarán de verla. Los enlaces que apunten a ella llevarán a «Cómo funciona».'
        : 'Se quitan tus cambios, la imagen y el vídeo, y vuelve a verse si estaba oculta.',
      confirmLabel: custom ? 'Borrar' : 'Restaurar',
      destructive: custom,
    });
    if (!ok) return;
    try {
      await reset.mutateAsync(topic.id);
      toast.success(custom ? 'Guía borrada.' : 'Guía restaurada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo hacer.');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Guías de ayuda</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Las guías de «Cómo funciona» del panel de los tenants. Las que vienen con la aplicación
            se pueden cambiar, ocultar o completar con una imagen o un vídeo; también puedes crear
            guías nuevas.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="mr-1 size-4" aria-hidden />
            Nueva guía
          </Button>
        )}
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Buscar guías"
          placeholder="Buscar guías…"
          className="pl-9 text-base sm:text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {topics.isError ? (
        <AdminError onRetry={() => void topics.refetch()} />
      ) : topics.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Ninguna guía coincide con la búsqueda.
          </CardContent>
        </Card>
      ) : (
        HELP_TOPIC_GROUPS.filter((g) => shown.some((t) => t.group === g)).map((group) => (
          <section key={group} className="space-y-2">
            <h2 className="text-lg font-semibold">{group}</h2>
            <Card>
              <CardContent className="divide-y p-0">
                {shown
                  .filter((t) => t.group === group)
                  .map((topic) => (
                    <TopicRow
                      key={topic.id}
                      topic={topic}
                      canEdit={canEdit}
                      busy={update.isPending || reset.isPending}
                      onEdit={() => setEditing(topic)}
                      onToggleHidden={() => void toggleHidden(topic)}
                      onReset={() => void onReset(topic)}
                    />
                  ))}
              </CardContent>
            </Card>
          </section>
        ))
      )}

      {editing && (
        <TopicDialog
          initial={editing === 'new' ? null : editing}
          nextPosition={nextPosition}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TopicRow({
  topic,
  canEdit,
  busy,
  onEdit,
  onToggleHidden,
  onReset,
}: {
  topic: AdminHelpTopicDto;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggleHidden: () => void;
  onReset: () => void;
}) {
  const custom = topic.source === 'custom';
  const changed = topic.edited || !!topic.imageKey || !!topic.videoUrl || topic.hidden;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{topic.title}</span>
          <code className="text-xs text-muted-foreground">#{topic.id}</code>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-[10px] font-normal">
            {custom ? 'Creada en el panel' : 'De la aplicación'}
          </Badge>
          {topic.edited && <Badge className="text-[10px] font-normal">Texto cambiado</Badge>}
          {topic.hidden && (
            <Badge variant="secondary" className="text-[10px] font-normal">
              Oculta
            </Badge>
          )}
          {!topic.published && (
            <Badge variant="secondary" className="text-[10px] font-normal">
              Borrador
            </Badge>
          )}
          {topic.imageUrl && (
            <Badge variant="outline" className="text-[10px] font-normal">
              Imagen
            </Badge>
          )}
          {topic.videoEmbedUrl && (
            <Badge variant="outline" className="text-[10px] font-normal">
              Vídeo
            </Badge>
          )}
          {topic.feature && (
            <Badge variant="outline" className="text-[10px] font-normal">
              {FEATURE_LABELS[topic.feature]}
            </Badge>
          )}
        </div>
        {topic.updatedAt && (
          <p className="text-xs text-muted-foreground">
            Cambiada el {formatDateTime(topic.updatedAt)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={canEdit ? 'Editar' : 'Ver'}
          title={canEdit ? 'Editar' : 'Ver'}
          onClick={onEdit}
        >
          <Pencil className="size-4" aria-hidden />
        </Button>
        {canEdit && !custom && (
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={topic.hidden ? 'Volver a mostrar' : 'Ocultar'}
            title={topic.hidden ? 'Volver a mostrar' : 'Ocultar'}
            onClick={onToggleHidden}
          >
            {topic.hidden ? (
              <Eye className="size-4" aria-hidden />
            ) : (
              <EyeOff className="size-4" aria-hidden />
            )}
          </Button>
        )}
        {canEdit && (custom || changed) && (
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={custom ? 'Borrar' : 'Restaurar la original'}
            title={custom ? 'Borrar' : 'Restaurar la original'}
            onClick={onReset}
          >
            {custom ? (
              <Trash2 className="size-4 text-destructive" aria-hidden />
            ) : (
              <RotateCcw className="size-4" aria-hidden />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function TopicDialog({
  initial,
  nextPosition,
  onClose,
}: {
  initial: AdminHelpTopicDto | null;
  nextPosition: number;
  onClose: () => void;
}) {
  const canEdit = useIsSuperadmin();
  const create = useCreateHelpTopic();
  const update = useUpdateHelpTopic();
  const upload = useUploadHelpImage();
  const [form, setForm] = useState<FormState>(() => formFrom(initial, nextPosition));
  const isNew = !initial;
  const custom = !initial || initial.source === 'custom';
  const saving = create.isPending || update.isPending;
  const videoValid = !form.videoUrl.trim() || toEmbedVideoUrl(form.videoUrl) !== null;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onImage(file: File | undefined) {
    if (!file) return;
    if (!(HELP_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      toast.error('Solo imágenes PNG, JPG o WebP.');
      return;
    }
    if (file.size > HELP_IMAGE_MAX_BYTES) {
      toast.error('La imagen no puede pasar de 2 MB.');
      return;
    }
    try {
      const key = await upload.mutateAsync(file);
      setForm((f) => ({ ...f, imageKey: key, imageUrl: URL.createObjectURL(file) }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir la imagen.');
    }
  }

  async function onSave() {
    const content = contentOf(form);
    const parsed = HelpTopicContentSchema.safeParse(content);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = FIELD_LABELS[String(issue?.path[0] ?? '')] ?? 'Revisa los datos';
      toast.error(issue ? `${field}: ${issue.message}` : 'Revisa los datos.');
      return;
    }
    if (!videoValid) {
      toast.error('El vídeo tiene que ser de YouTube o de Vimeo.');
      return;
    }
    const position = form.position.trim() === '' ? null : Number(form.position);
    if (position !== null && (!Number.isInteger(position) || position < 0)) {
      toast.error('El orden tiene que ser un número entero.');
      return;
    }
    try {
      if (isNew) {
        const id = form.id.trim();
        if (!HELP_TOPIC_ID_RE.test(id)) {
          toast.error('El identificador solo admite minúsculas, números y guiones.');
          return;
        }
        await create.mutateAsync({
          id,
          content: parsed.data,
          imageKey: form.imageKey,
          videoUrl: form.videoUrl.trim() || null,
          position,
          published: form.published,
        });
        toast.success('Guía creada.');
      } else {
        const keepOriginal = initial.original && sameAsOriginal(parsed.data, initial.original);
        await update.mutateAsync({
          id: initial.id,
          input: {
            content: keepOriginal ? null : parsed.data,
            imageKey: form.imageKey,
            videoUrl: form.videoUrl.trim() || null,
            position,
            ...(custom ? { published: form.published } : {}),
          },
        });
        toast.success('Guía guardada.');
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const disabled = !canEdit;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isNew ? 'Nueva guía' : canEdit ? 'Editar guía' : 'Guía (solo lectura)'}
          </DialogTitle>
        </DialogHeader>
        <fieldset disabled={disabled} className="space-y-4">
          {!custom && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Esta guía viene con la aplicación. Si cambias el texto, los tenants verán el tuyo;
              «Restaurar la original» lo deshace.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ht-id">Identificador</Label>
              <Input
                id="ht-id"
                value={form.id}
                disabled={!isNew}
                placeholder="mi-guia"
                onChange={(e) => set('id', e.target.value.toLowerCase())}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Se enlaza como <code>/help#{form.id || 'identificador'}</code>; no se puede cambiar.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Grupo</Label>
              <Select value={form.group} onValueChange={(v) => set('group', v as HelpTopicGroup)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HELP_TOPIC_GROUPS.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ht-title">Título</Label>
            <Input
              id="ht-title"
              value={form.title}
              maxLength={120}
              onChange={(e) => set('title', e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ht-summary">Resumen</Label>
            <Input
              id="ht-summary"
              value={form.summary}
              maxLength={300}
              onChange={(e) => set('summary', e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label>Pasos</Label>
            {form.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="mt-2 w-5 text-right text-sm text-muted-foreground">{i + 1}.</span>
                <Textarea
                  value={step}
                  rows={2}
                  maxLength={400}
                  aria-label={`Paso ${i + 1}`}
                  onChange={(e) =>
                    set(
                      'steps',
                      form.steps.map((s, idx) => (idx === i ? e.target.value : s)),
                    )
                  }
                  className="text-base sm:text-sm"
                />
                <div className="flex flex-col">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Subir"
                    onClick={() => set('steps', move(form.steps, i, -1))}
                  >
                    <ArrowUp className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Bajar"
                    onClick={() => set('steps', move(form.steps, i, 1))}
                  >
                    <ArrowDown className="size-3.5" aria-hidden />
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Quitar el paso"
                  disabled={form.steps.length === 1}
                  onClick={() =>
                    set(
                      'steps',
                      form.steps.filter((_, idx) => idx !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            {form.steps.length < 12 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => set('steps', [...form.steps, ''])}
              >
                <Plus className="mr-1 size-4" aria-hidden />
                Añadir paso
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label>Enlaces</Label>
            <p className="text-xs text-muted-foreground">
              Solo a pantallas del panel: empiezan por «/» (por ejemplo, <code>/contracts</code>).
            </p>
            {form.links.map((link, i) => (
              <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={link.label}
                  placeholder="Texto"
                  aria-label={`Texto del enlace ${i + 1}`}
                  maxLength={60}
                  onChange={(e) =>
                    set(
                      'links',
                      form.links.map((l, idx) => (idx === i ? { ...l, label: e.target.value } : l)),
                    )
                  }
                  className="text-base sm:text-sm"
                />
                <div className="flex items-center gap-2">
                  <Input
                    value={link.href}
                    placeholder="/ruta"
                    aria-label={`Dirección del enlace ${i + 1}`}
                    onChange={(e) =>
                      set(
                        'links',
                        form.links.map((l, idx) =>
                          idx === i ? { ...l, href: e.target.value } : l,
                        ),
                      )
                    }
                    className="text-base sm:text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Quitar el enlace"
                    onClick={() =>
                      set(
                        'links',
                        form.links.filter((_, idx) => idx !== i),
                      )
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
            {form.links.length < 8 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => set('links', [...form.links, { label: '', href: '/' }])}
              >
                <Plus className="mr-1 size-4" aria-hidden />
                Añadir enlace
              </Button>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ht-keywords">Palabras clave</Label>
              <Input
                id="ht-keywords"
                value={form.keywords}
                maxLength={300}
                placeholder="Palabras que también la encuentran"
                onChange={(e) => set('keywords', e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Función del plan</Label>
              <Select
                value={form.feature ?? NO_FEATURE}
                onValueChange={(v) =>
                  set('feature', v === NO_FEATURE ? null : (v as TenantFeature))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FEATURE}>Ninguna (todos los planes)</SelectItem>
                  {TenantFeatures.map((f) => (
                    <SelectItem key={f} value={f}>
                      {FEATURE_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Imagen</Label>
            {form.imageUrl ? (
              <div className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={form.imageUrl}
                  alt=""
                  className="max-h-48 rounded-md border object-contain"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setForm((f) => ({ ...f, imageKey: null, imageUrl: null }))}
                >
                  Quitar la imagen
                </Button>
              </div>
            ) : (
              <Input
                type="file"
                accept={HELP_IMAGE_MIME_TYPES.join(',')}
                disabled={disabled || upload.isPending}
                onChange={(e) => void onImage(e.target.files?.[0])}
              />
            )}
            <p className="text-xs text-muted-foreground">PNG, JPG o WebP, hasta 2 MB.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ht-video">Vídeo</Label>
            <Input
              id="ht-video"
              value={form.videoUrl}
              placeholder="https://www.youtube.com/watch?v=…"
              onChange={(e) => set('videoUrl', e.target.value)}
              className="text-base sm:text-sm"
              aria-invalid={!videoValid}
            />
            <p
              className={videoValid ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}
            >
              {videoValid
                ? 'Enlace de YouTube o Vimeo. Se ve al pulsar «Ver vídeo» en la guía.'
                : 'Solo vídeos de YouTube o Vimeo.'}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ht-position">Orden en su grupo</Label>
              <Input
                id="ht-position"
                type="number"
                min={0}
                step={10}
                value={form.position}
                onChange={(e) => set('position', e.target.value)}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">Más bajo, más arriba.</p>
            </div>
            {custom && (
              <label className="flex items-center gap-2 self-center text-sm">
                <Checkbox
                  checked={form.published}
                  onCheckedChange={(v) => set('published', v === true)}
                />
                Publicada (la ven los tenants)
              </label>
            )}
          </div>
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {canEdit ? 'Cancelar' : 'Cerrar'}
          </Button>
          {canEdit && (
            <Button onClick={() => void onSave()} disabled={saving || upload.isPending}>
              {saving && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
              Guardar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
