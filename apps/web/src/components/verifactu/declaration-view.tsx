import type { VerifactuDeclarationDto } from '@storageos/shared';

/**
 * La declaración responsable tal como se firma: su título y cada dato con el
 * texto que lo describe (art. 15 de la Orden HAC/1177/2024). La usan la página
 * pública y el panel.
 */
export function DeclarationView({ doc }: { doc: VerifactuDeclarationDto }) {
  return (
    <article className="space-y-5 text-sm">
      <h2 className="text-center text-sm font-semibold tracking-wide sm:text-base">{doc.title}</h2>
      <dl className="space-y-4">
        {doc.items.map((item) => (
          <div key={item.key}>
            <dt className="font-semibold">{item.label}:</dt>
            <dd className="mt-1 space-y-2 text-muted-foreground">
              {item.value.split(/\n{2,}/).map((p) => (
                <p key={p}>{p}</p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="space-y-1 border-t pt-4 text-xs text-muted-foreground">
        {doc.contact.map((item) => (
          <div key={item.label}>
            <dt className="inline font-medium text-foreground">{item.label}: </dt>
            <dd className="inline break-all">{item.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
