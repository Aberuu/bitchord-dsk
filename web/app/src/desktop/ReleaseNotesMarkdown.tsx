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

/**
 * Cleans up raw release-note Markdown from GitHub Releases:
 * - repairs legacy backslash-wrapped tokens emitted by double-quoted shell calls
 * - omits redundant top-level version headers and installer binary file lists
 */
export function preprocessReleaseNotes(raw: string): string {
  const repaired = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u000b([A-Za-z0-9_.-]+\\)/g, 'v$1')
    .replace(/\\([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)\\/g, '`$1`');

  const lines = repaired.split('\n');
  const out: string[] = [];
  let seenContent = false;
  let skippingInstallersSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);

    if (headingMatch) {
      const headingText = headingMatch[2]!.trim();
      if (!seenContent && /^bitchord(?:\s+desktop)?\s+v?\d+\.\d+/i.test(headingText)) {
        continue;
      }
      if (/^(?:windows(?:\s+x64)?\s+)?installers\b/i.test(headingText)) {
        skippingInstallersSection = true;
        continue;
      }
      skippingInstallersSection = false;
      seenContent = true;
      out.push(line);
      continue;
    }

    if (skippingInstallersSection) {
      continue;
    }

    if (trimmed.length > 0) {
      seenContent = true;
    }
    out.push(line);
  }

  return out.join('\n').trim();
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
      className="my-2.5 block aspect-video max-h-44 w-full rounded-[10px] border border-(--labelDivider) object-cover"
    />
  );
}

function renderInline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|(?<!\w)\*[^*\n]+\*(?!\w)|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
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
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push(
        <em key={keyIdx++} className="italic text-primary/90">
          {raw.slice(1, -1)}
        </em>,
      );
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(
        <code
          key={keyIdx++}
          className="rounded-[5px] bg-primary/8 px-1.5 py-[1px] font-mono text-[12px] text-primary/90 [overflow-wrap:anywhere]"
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

interface ParsedListItem {
  text: string;
  children: string[];
}

interface ActiveList {
  ordered: boolean;
  items: ParsedListItem[];
}

export function ReleaseNotesMarkdown({ notes }: { notes: string }) {
  const cleaned = preprocessReleaseNotes(notes);
  const lines = cleaned.split('\n');
  const blocks: ReactNode[] = [];
  let activeList: ActiveList | null = null;
  let blockKey = 0;

  const flushList = () => {
    if (!activeList || activeList.items.length === 0) {
      activeList = null;
      return;
    }
    const { ordered, items } = activeList;
    activeList = null;
    const ListTag = ordered ? 'ol' : 'ul';
    blocks.push(
      <ListTag
        key={blockKey++}
        className={`my-2 space-y-2 pl-4.5 text-left ${ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {items.map((item, idx) => (
          <li
            key={idx}
            className="text-[13.5px] leading-[1.55] text-primary/88 marker:text-secondary"
          >
            <span>{renderInline(item.text)}</span>
            {item.children.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                {item.children.map((sub, subIdx) => (
                  <li
                    key={subIdx}
                    className="text-[12.5px] leading-[1.5] text-secondary marker:text-secondary/75"
                  >
                    {renderInline(sub)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ListTag>,
    );
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    const imgMatch = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(trimmed);
    if (imgMatch) {
      flushList();
      const safeSrc = sanitizeSafeImageUrl(imgMatch[2]!);
      if (safeSrc) {
        blocks.push(
          <ReleaseImage key={blockKey++} src={safeSrc} alt={imgMatch[1] || 'Update preview'} />,
        );
      }
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushList();
      blocks.push(<hr key={blockKey++} className="my-2.5 border-(--labelDivider)" />);
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1]!.length;
      if (level <= 2) {
        blocks.push(
          <h3
            key={blockKey++}
            className="mt-3 mb-1.5 text-left text-[14px] leading-[1.35] font-semibold tracking-[-0.01em] text-primary first:mt-0"
          >
            {renderInline(headingMatch[2]!)}
          </h3>,
        );
      } else {
        blocks.push(
          <h4
            key={blockKey++}
            className="mt-2.5 mb-1 text-left text-[13px] leading-[1.35] font-semibold text-primary/95 first:mt-0"
          >
            {renderInline(headingMatch[2]!)}
          </h4>,
        );
      }
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushList();
      blocks.push(
        <blockquote
          key={blockKey++}
          className="my-2 border-l-2 border-(--labelDivider) pl-3 text-left text-[13px] leading-[1.5] text-secondary"
        >
          {renderInline(quoteMatch[1]!)}
        </blockquote>,
      );
      continue;
    }

    const unorderedMatch = /^(\s*)(?:[-*+•])\s+(.+)$/.exec(rawLine);
    if (unorderedMatch) {
      const indent = unorderedMatch[1]!.length;
      const content = unorderedMatch[2]!.trim();
      if (indent >= 2 && activeList && activeList.items.length > 0) {
        activeList.items[activeList.items.length - 1]!.children.push(content);
      } else {
        if (!activeList || activeList.ordered) {
          flushList();
          activeList = { ordered: false, items: [] };
        }
        activeList.items.push({ text: content, children: [] });
      }
      continue;
    }

    const orderedMatch = /^(\s*)\d+[.)]\s+(.+)$/.exec(rawLine);
    if (orderedMatch) {
      const content = orderedMatch[2]!.trim();
      if (!activeList || !activeList.ordered) {
        flushList();
        activeList = { ordered: true, items: [] };
      }
      activeList.items.push({ text: content, children: [] });
      continue;
    }

    flushList();
    blocks.push(
      <p key={blockKey++} className="my-1.5 text-left text-[13.5px] leading-[1.55] text-primary/85">
        {renderInline(trimmed)}
      </p>,
    );
  }

  flushList();

  return <div className="w-full space-y-1 text-left">{blocks}</div>;
}
