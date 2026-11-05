'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFacilities, useUnits } from '@/lib/facilities/hooks';

export interface AccessScopeValue {
  /** own = sus trasteros en uso · choose = lo que se marque · all = todos los locales. */
  mode: 'own' | 'choose' | 'all';
  facilityIds: string[];
  unitIds: string[];
}

/** Hasta dónde abre una credencial. */
export function AccessScopeFields({
  value,
  onChange,
}: {
  value: AccessScopeValue;
  onChange: (value: AccessScopeValue) => void;
}) {
  const facilities = useFacilities();

  function toggleFacility(id: string, checked: boolean) {
    onChange({
      ...value,
      facilityIds: checked ? [...value.facilityIds, id] : value.facilityIds.filter((f) => f !== id),
    });
  }

  return (
    <div className="space-y-2">
      <Label>Qué abre</Label>
      <Select
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode: mode as AccessScopeValue['mode'] })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="own">Solo lo suyo: sus trasteros en uso</SelectItem>
          <SelectItem value="choose">Los locales y trasteros que elija</SelectItem>
          <SelectItem value="all">Todos los locales y trasteros</SelectItem>
        </SelectContent>
      </Select>
      {value.mode === 'all' && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Abrirá cualquier puerta y cerradura de la empresa, también las de otros inquilinos.
        </p>
      )}
      {value.mode === 'choose' && (
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
          {(facilities.data ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">No hay locales disponibles.</p>
          )}
          {(facilities.data ?? []).map((f) => {
            const checked = value.facilityIds.includes(f.id);
            return (
              <div key={f.id} className="space-y-1">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => toggleFacility(f.id, v === true)}
                  />
                  <span>{f.name}</span>
                </label>
                {checked && (
                  <FacilityUnits
                    facilityId={f.id}
                    unitIds={value.unitIds}
                    onChange={(unitIds) => onChange({ ...value, unitIds })}
                  />
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Abre las puertas del local. Marca los trasteros que tengan cerradura propia y deba
            abrir.
          </p>
        </div>
      )}
    </div>
  );
}

function FacilityUnits({
  facilityId,
  unitIds,
  onChange,
}: {
  facilityId: string;
  unitIds: string[];
  onChange: (unitIds: string[]) => void;
}) {
  const units = useUnits({ facilityId });
  return (
    <div className="ml-6 flex flex-wrap gap-x-3 gap-y-1">
      {(units.data?.items ?? []).map((u) => (
        <label key={u.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
          <Checkbox
            checked={unitIds.includes(u.id)}
            onCheckedChange={(v) =>
              onChange(v === true ? [...unitIds, u.id] : unitIds.filter((id) => id !== u.id))
            }
          />
          <span>{u.code}</span>
        </label>
      ))}
    </div>
  );
}
