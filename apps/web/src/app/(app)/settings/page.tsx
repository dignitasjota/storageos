'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { MODULE_SETTINGS } from './settings-nav';
import { useVisibleSettingsNav } from './use-settings-nav';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/lib/auth/hooks';

/** Inicio de Configuración: qué hay en cada sitio, agrupado por tema. */
export default function SettingsHomePage() {
  const groups = useVisibleSettingsNav();
  const permissions = usePermissions();
  const moduleSettings = MODULE_SETTINGS.filter(
    (i) => !i.permission || permissions.includes(i.permission),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
        <p className="text-sm text-muted-foreground">
          Todo lo que puedes ajustar, agrupado por tema.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{g.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {g.items.map((i) => (
                <SettingsLink
                  key={i.href}
                  href={i.href}
                  label={i.label}
                  description={i.description}
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      {moduleSettings.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Ajustes en cada módulo</CardTitle>
            <p className="text-sm text-muted-foreground">
              Estos se configuran en su propia página, junto a lo que ajustan.
            </p>
          </CardHeader>
          <CardContent className="grid gap-1 lg:grid-cols-2">
            {moduleSettings.map((i) => (
              <SettingsLink
                key={i.href}
                href={i.href}
                label={i.label}
                description={i.description}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SettingsLink({
  href,
  label,
  description,
}: {
  href: string;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
    >
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
