/**
 * Indicador de progreso del embudo de reserva self-service (Tus datos → Firma).
 * Reduce la ansiedad de abandono dejando claro cuánto falta — el pago (si
 * aplica) se muestra dentro del propio paso de firma, ya con contexto.
 */
export function FunnelSteps({
  current,
  total,
  label,
  stepOfLabel,
}: {
  current: number;
  total: number;
  label: string;
  stepOfLabel: string;
}) {
  return (
    <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <div className="flex gap-1" aria-hidden="true">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 w-6 rounded-full ${i < current ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </div>
      <span>
        {stepOfLabel} · {label}
      </span>
    </div>
  );
}
