import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Texto de una entrada del blog de TrasterOS: Markdown con estilos de lectura
 * (sin HTML crudo; react-markdown quita los esquemas peligrosos). Los enlaces
 * internos (`/…`) van por el router; los externos abren otra pestaña.
 */
export function ArticleMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-5 text-base leading-relaxed text-foreground/85 md:text-[17px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // El título de la entrada es el único h1 de la página.
          h1: ({ children }) => (
            <h2 className="mt-10 text-2xl font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h2 className="mt-10 text-2xl font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-8 text-lg font-semibold text-foreground">{children}</h3>
          ),
          ul: ({ children }) => <ul className="list-disc space-y-2 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-2 pl-6">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="rounded-r-lg border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-foreground/80">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          tr: ({ children }) => <tr className="border-b last:border-b-0">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-2 font-semibold text-foreground">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          img: ({ src, alt }) =>
            typeof src === 'string' ? (
              // Imágenes del texto (de nuestro almacenamiento o https): sin optimizar.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt ?? ''} loading="lazy" className="rounded-lg border" />
            ) : null,
          a: ({ href, children }) =>
            href?.startsWith('/') ? (
              <Link href={href} className="font-medium text-primary underline underline-offset-2">
                {children}
              </Link>
            ) : (
              <a
                href={href}
                className="font-medium text-primary underline underline-offset-2"
                target="_blank"
                rel="noopener noreferrer"
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
