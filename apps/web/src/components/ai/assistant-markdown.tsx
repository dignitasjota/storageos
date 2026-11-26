'use client';

import Link from 'next/link';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * La respuesta del asistente con formato (negritas, listas, tablas). Los
 * enlaces a fichas (`/customers/…`) van dentro del panel; los externos solo si
 * son https y en otra pestaña; cualquier otro esquema se quita.
 */
export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-2 break-words [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith('/') && !url.startsWith('//')
            ? url
            : url.startsWith('https://')
              ? defaultUrlTransform(url)
              : ''
        }
        components={{
          a: ({ href, children }) =>
            !href ? (
              <>{children}</>
            ) : href.startsWith('/') ? (
              <Link href={href} className="text-primary underline underline-offset-2">
                {children}
              </Link>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary underline underline-offset-2"
              >
                {children}
              </a>
            ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b px-2 py-1 tabular-nums">{children}</td>,
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          h1: ({ children }) => <p className="font-semibold">{children}</p>,
          h2: ({ children }) => <p className="font-semibold">{children}</p>,
          h3: ({ children }) => <p className="font-semibold">{children}</p>,
          img: () => null,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
