'use client';

import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useSetProjectPlatformSistrix,
  useSistrixWorkspace,
} from '@/lib/seo-advanced/sistrix-hooks';

/**
 * En la ficha de un proyecto de tenant (panel admin): «Usar la conexión de
 * SISTRIX de la plataforma». Solo para negocios propios: los datos de SISTRIX
 * no se pueden ceder a terceros.
 */
export function PlatformSistrixToggle({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const ws = useSistrixWorkspace({ kind: 'admin', projectId });
  const set = useSetProjectPlatformSistrix(projectId);
  const value = ws.data?.workspace?.usePlatformSistrix ?? false;

  const toggle = async (next: boolean) => {
    if (next) {
      const yes = await confirm({
        title: '¿Usar la conexión de SISTRIX de la plataforma?',
        description:
          'Solo para negocios propios (como GUÁRDALO): las condiciones de SISTRIX no permiten ceder sus datos a otros negocios. Las consultas de este proyecto irán con tu cuenta y su cuota.',
        confirmLabel: 'Usar la de la plataforma',
      });
      if (!yes) return;
    }
    try {
      await set.mutateAsync(next);
      toast.success(next ? 'Usa la conexión de la plataforma' : 'Usa la clave del negocio');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SISTRIX de este negocio</CardTitle>
        <CardDescription>
          Por defecto, un negocio solo tiene SISTRIX con su propia clave de API. Actívalo solo en
          negocios tuyos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value}
            disabled={!canEdit || set.isPending || ws.isLoading}
            onCheckedChange={(v) => void toggle(v === true)}
          />
          Usar la conexión de SISTRIX de la plataforma
        </label>
        {!canEdit && (
          <p className="mt-2 text-xs text-muted-foreground">
            Solo lo puede cambiar el rol superadmin.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
