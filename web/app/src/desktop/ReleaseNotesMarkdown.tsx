import { Fragment, useState, type ReactNode } from 'react';

function sanitizeSafeImageUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^https:\/\//i.test(trimmed) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function sanitizeSafeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

function ReleaseImage({ src, alt }: { src: string; alt: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setHidden(true)}
      className="my-2 block max-h-40 w-full rounded-[10px] border border-white/10 object-cover"
    />
  );
}

function renderInline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let keyIdx = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push(text.slice(lastIndex, start));
    }
    const raw = match[0];
    if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push(
        <strong key={keyIdx++} className="font-semibold text-primary">
          {raw.slice(2, -2)}
        </strong>,
      );
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(
        <code
          key={keyIdx++}
          className="rounded-[5px] bg-quaternary/80 px-1.5 py-0.5 font-mono text-[11px] text-primary"
        >
          {raw.slice(1, -1)}
        </code>,
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      if (linkMatch) {
        const href = sanitizeSafeLinkUrl(linkMatch[2]!);
        if (href) {
          tokens.push(
            <a
              key={keyIdx++}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-key underline-offset-2 hover:underline"
            >
              {linkMatch[1]}
            </a>,
          );
        } else {
          tokens.push(<Fragment key={keyIdx++}>{linkMatch[1]}</Fragment>);
        }
      }
    }
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

export function ReleaseNotesMarkdown({ notes }: { notes: string }) {
  const lines = notes.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let blockKey = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    blocks.push(
      <ul key={blockKey++} className="my-1.5 space-y-1.5 pl-4 text-left">
        {items.map((item, idx) => (
          <li
            key={idx}
            className="list-disc text-[13px] leading-[1.42] text-secondary marker:text-secondary"
          >
            {renderInline(item)}
          </li>
        ))}
      </ul>,
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    const imgMatch = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(line);
    if (imgMatch) {
      flushList();
      const safeSrc = sanitizeSafeImageUrl(imgMatch[2]!);
      if (safeSrc) {
        blocks.push(<ReleaseImage key={blockKey++} src={safeSrc} alt={imgMatch[1] || 'Update preview'} />);
      }
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1]!.length;
      blocks.push(
        <h3
          key={blockKey++}
          className={`text-left font-bold tracking-[-0.01em] text-primary ${
            level <= 2 ? 'mt-2.5 text-[18px] leading-[1.25]' : 'mt-2 text-[14px] leading-[1.3]'
          }`}
        >
          {renderInline(headingMatch[2]!)}
        </h3>,
      );
      continue;
    }

    const bulletMatch = /^(?:[-*+•])\s+(.+)$/.exec(line);
    if (bulletMatch) {
      listItems.push(bulletMatch[1]!);
      continue;
    }

    flushList();
    blocks.push(
      <p key={blockKey++} className="my-1 text-left text-[13px] leading-[1.42] text-secondary">
        {renderInline(line)}
      </p>,
    );
  }

  flushList();

  return <div className="w-full space-y-1 text-left">{blocks}</div>;
}
