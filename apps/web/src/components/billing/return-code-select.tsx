'use client';

import { SEPA_RETURN_CODES, type SepaReturnCode } from '@storageos/shared';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const NONE = 'none';

/** El código de devolución que da el banco (AM04, MD06…), opcional. */
export function ReturnCodeSelect({
  value,
  onChange,
}: {
  value: SepaReturnCode | null;
  onChange: (code: SepaReturnCode | null) => void;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : (v as SepaReturnCode))}
    >
      <SelectTrigger aria-label="Código de devolución">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Sin código</SelectItem>
        {(Object.keys(SEPA_RETURN_CODES) as SepaReturnCode[]).map((code) => (
          <SelectItem key={code} value={code}>
            {code} · {SEPA_RETURN_CODES[code]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
