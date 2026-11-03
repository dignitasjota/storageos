'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renderiza Markdown con estilos legibles (sin plugin `typography`). Con
 * `resolveHref`, los enlaces `web:…` del blog pasan a la dirección real de la
 * web del tenant (el resto de esquemas peligrosos los quita react-markdown).
 * Con `remark-gfm` entiende también tablas (`| a | b |`), tachado y listas de tareas.
 */
export function MarkdownView({
  content,
  resolveHref,
  siteOrigin,
}: {
  content: string;
  resolveHref?: (href: string) => string;
  /** Origen de la propia web (dominio propio): sus enlaces no abren otra pestaña. */
  siteOrigin?: string | null;
}) {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith('web:') ? (resolveHref ? resolveHref(url) : '#') : defaultUrlTransform(url)
        }
        components={{
          h1: ({ children }) => (
            <h1 className="mt-8 text-2xl font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-6 text-base font-semibold text-foreground">{children}</h3>
          ),
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          // En el móvil la tabla se desplaza en horizontal sin romper la página.
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          tr: ({ children }) => <tr className="border-b last:border-b-0">{children}</tr>,
          th: ({ children, style }) => (
            <th className="px-3 py-2 font-semibold text-foreground" style={style}>
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td className="px-3 py-2 align-top" style={style}>
              {children}
            </td>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="underline hover:text-foreground"
              {...(href?.startsWith('http') && !(siteOrigin && href.startsWith(siteOrigin))
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
