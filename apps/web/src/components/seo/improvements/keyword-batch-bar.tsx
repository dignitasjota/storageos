'use client';

import { SEO_KEYWORD_INTENT_LABELS, SEO_KEYWORD_PRIORITY_LABELS } from '@storageos/shared';
import { Loader2, Pencil, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

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
import { useKeywordBatch, type ImprovementScope } from '@/lib/seo-advanced/improvement-hooks';

const KEEP = '__keep__';
const CLEAR = '__clear__';

/**
 * Barra de las palabras elegidas (mejora 10): poner a la vez grupo,
 * prioridad, intención y URL objetivo. Lo que se deja en «No cambiar» no se
 * toca.
 */
export function KeywordBatchBar({
  scope,
  ids,
  groups,
  onDone,
}: {
  scope: ImprovementScope;
  ids: string[];
  groups: string[];
  onDone: () => void;
}) {
  const { update } = useKeywordBatch(scope);
  const [group, setGroup] = useState('');
  const [priority, setPriority] = useState(KEEP);
  const [intent, setIntent] = useState(KEEP);
  const [url, setUrl] = useState('');
  const [clearGroup, setClearGroup] = useState(false);

  if (ids.length === 0) return null;
  const nothing =
    !group.trim() && !clearGroup && priority === KEEP && intent === KEEP && !url.trim();

  const apply = async () => {
    try {
      const res = await update.mutateAsync({
        ids,
        ...(clearGroup ? { groupName: null } : group.trim() ? { groupName: group.trim() } : {}),
        ...(priority !== KEEP ? { priority: Number(priority) } : {}),
        ...(intent !== KEEP ? { intent: intent === CLEAR ? null : intent } : {}),
        ...(url.trim() ? { targetUrl: url.trim() } : {}),
      });
      toast.success(
        res.updated === 1 ? 'Palabra actualizada' : `${res.updated} palabras actualizadas`,
      );
      setGroup('');
      setPriority(KEEP);
      setIntent(KEEP);
      setUrl('');
      setClearGroup(false);
      onDone();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {ids.length === 1 ? '1 palabra elegida' : `${ids.length} palabras elegidas`}
        </p>
        <Button variant="ghost" size="sm" onClick={onDone}>
          <X className="mr-1 size-4" aria-hidden /> Quitar la selección
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="batch-group">Grupo</Label>
          <Input
            id="batch-group"
            list="batch-groups"
            value={group}
            disabled={clearGroup}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="No cambiar"
          />
          <datalist id="batch-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={clearGroup}
              onChange={(e) => setClearGroup(e.target.checked)}
            />
            Quitar del grupo
          </label>
        </div>
        <div className="space-y-1">
          <Label>Prioridad</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger aria-label="Prioridad">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>No cambiar</SelectItem>
              {[1, 2, 3].map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {SEO_KEYWORD_PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Intención</Label>
          <Select value={intent} onValueChange={setIntent}>
            <SelectTrigger aria-label="Intención">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>No cambiar</SelectItem>
              {Object.entries(SEO_KEYWORD_INTENT_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
              <SelectItem value={CLEAR}>Sin decidir</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="batch-url">URL objetivo</Label>
          <Input
            id="batch-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="No cambiar"
          />
        </div>
      </div>
      <Button size="sm" onClick={() => void apply()} disabled={nothing || update.isPending}>
        {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
        Aplicar a {ids.length === 1 ? 'la palabra' : `las ${ids.length}`}
      </Button>
    </div>
  );
}

/** Aceptar de un golpe las URL que propone Google para las palabras que no tienen una. */
export function AcceptSuggestedUrlsButton({
  scope,
  count,
}: {
  scope: ImprovementScope;
  count: number;
}) {
  const { acceptUrls } = useKeywordBatch(scope);
  if (count === 0) return null;
  const run = async () => {
    try {
      const res = await acceptUrls.mutateAsync();
      toast.success(`${res.updated} URL objetivo guardadas`);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => void run()}
      disabled={acceptUrls.isPending}
    >
      {acceptUrls.isPending ? (
        <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
      ) : (
        <Wand2 className="mr-1 size-4" aria-hidden />
      )}
      Aceptar las {count} URL propuestas
    </Button>
  );
}

/** Renombrar un grupo (si ya hay otro con ese nombre, se juntan). */
export function RenameGroupDialog({
  scope,
  group,
  onClose,
}: {
  scope: ImprovementScope;
  group: string | null;
  onClose: () => void;
}) {
  const { renameGroup } = useKeywordBatch(scope);
  const [name, setName] = useState('');
  const [prev, setPrev] = useState<string | null>(null);
  if (group !== prev) {
    setPrev(group);
    setName(group ?? '');
  }
  const save = async () => {
    if (!group || !name.trim() || name.trim() === group) return;
    try {
      const res = await renameGroup.mutateAsync({ from: group, to: name.trim() });
      toast.success(`Grupo renombrado (${res.updated} palabras)`);
      onClose();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4" aria-hidden /> Renombrar el grupo
          </DialogTitle>
          <DialogDescription>
            Cambia el nombre en todas sus palabras. Si ya existe un grupo con el nuevo nombre, se
            juntan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="rename-group">Nombre nuevo</Label>
          <Input id="rename-group" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={renameGroup.isPending || !name.trim() || name.trim() === group}
          >
            Renombrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
