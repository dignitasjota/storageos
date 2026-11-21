import { helpHighlightParts } from '@storageos/shared';
import { Fragment } from 'react';

/** Texto con las palabras buscadas resaltadas (sin distinguir tildes). */
export function HelpHighlight({ text, words }: { text: string; words: string[] }) {
  if (words.length === 0) return <>{text}</>;
  return (
    <>
      {helpHighlightParts(text, words).map((part, i) =>
        part.match ? (
          <mark
            key={i}
            className="rounded-sm bg-yellow-200/80 px-0.5 text-inherit dark:bg-yellow-500/30"
          >
            {part.text}
          </mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
