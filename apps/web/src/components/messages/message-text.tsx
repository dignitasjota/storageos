const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
/** Lo que suele ir pegado detrás de un enlace y no forma parte de él. */
const TRAILING = /[.,;:!?)\]»]+$/;

/** Texto de un mensaje con sus saltos de línea y los enlaces pulsables. */
export function MessageText({ text, className = '' }: { text: string; className?: string }) {
  const parts = text.split(URL_RE);
  return (
    <p className={`whitespace-pre-wrap break-words ${className}`}>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const tail = TRAILING.exec(part)?.[0] ?? '';
        const url = tail ? part.slice(0, -tail.length) : part;
        return (
          <span key={`${i}-${url}`}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {url}
            </a>
            {tail}
          </span>
        );
      })}
    </p>
  );
}
