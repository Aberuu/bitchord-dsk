import { Keyboard, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useUi } from '@/state/ui';

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Playback',
    items: [
      { keys: ['Space'], description: 'Play or pause' },
      { keys: ['M'], description: 'Mute or unmute audio' },
      { keys: ['S'], description: 'Toggle shuffle' },
      { keys: ['R'], description: 'Cycle repeat mode (Off, All, One)' },
      { keys: ['Left / Right'], description: 'Seek backward or forward 5 seconds' },
      { keys: ['Up / Down'], description: 'Increase or decrease volume by 5%' },
      { keys: ['Ctrl', 'Left / Right'], description: 'Previous or next track' },
      { keys: ['Ctrl', 'Up / Down'], description: 'Adjust volume by 10%' },
    ],
  },
  {
    title: 'Navigation & Views',
    items: [
      { keys: ['F'], description: 'Toggle full-screen player' },
      { keys: ['L'], description: 'Open or leave Lyrics view' },
      { keys: ['Q'], description: 'Toggle Up Next side panel' },
      { keys: ['Ctrl', 'B'], description: 'Collapse or expand left sidebar' },
      { keys: ['Ctrl', 'K'], description: 'Focus music search (also Ctrl+F or /)' },
      { keys: ['Esc'], description: 'Close active overlay, panel, or exit Settings' },
    ],
  },
  {
    title: 'Audio & Reference',
    items: [
      { keys: ['O'], description: 'Open Audio Output switcher' },
      { keys: ['P'], description: 'Open Audio Pipeline inspector' },
      { keys: ['?'], description: 'Show or hide this keyboard shortcuts reference' },
    ],
  },
];

export function ShortcutsModal() {
  const open = useUi((s) => s.shortcutsOpen);
  if (!open) return null;
  return <ShortcutsModalContent />;
}

function ShortcutsModalContent() {
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setOpen]);

  return (
    <div
      className="fixed inset-0 z-(--z-modal) flex items-end justify-center bg-black/55 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[min(86vh,680px)] w-[min(560px,95vw)] flex-col overflow-hidden rounded-[22px] border border-search-border/70 bg-page text-primary shadow-[0_24px_64px_rgba(0,0,0,0.45)] outline-none animate-zoom"
      >
        <div className="flex items-center justify-between border-b border-search-border/50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-[10px] bg-quinary text-primary">
              <Keyboard size={17} strokeWidth={2} aria-hidden="true" />
            </span>
            <div>
              <h2 id="shortcuts-title" className="type-[700_17px/22px] text-primary">
                Keyboard shortcuts
              </h2>
              <p className="type-footnote text-secondary">
                Single-key shortcuts pause while typing or adjusting sliders.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close keyboard shortcuts"
            className="grid size-8 place-items-center rounded-full bg-quinary text-secondary transition-colors hover:bg-quaternary hover:text-primary"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-2 px-1 type-subhead-emphasized tracking-[0.04em] text-secondary uppercase">
                {group.title}
              </h3>
              <div className="overflow-hidden rounded-[14px] bg-quinary">
                {group.items.map((item, idx) => (
                  <div
                    key={item.description}
                    className={`flex items-center justify-between gap-4 px-3.5 py-2.5 ${
                      idx > 0 ? 'border-t border-search-border/40' : ''
                    }`}
                  >
                    <span className="type-body-reduced text-primary">{item.description}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((keyLabel, kIdx) => (
                        <span key={`${keyLabel}-${kIdx}`} className="inline-flex items-center gap-1">
                          {kIdx > 0 && <span className="text-[11px] text-tertiary">+</span>}
                          <kbd className="inline-flex min-w-[26px] items-center justify-center rounded-[7px] border border-search-border/70 bg-page px-2 py-0.5 font-mono text-[11px] font-semibold text-primary shadow-[0_1px_0_rgb(0_0_0/0.08)]">
                            {keyLabel}
                          </kbd>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="flex items-center justify-end border-t border-search-border/50 px-5 py-3">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-pill bg-quaternary px-4 py-1.5 type-callout-emphasized text-primary transition-colors hover:bg-tracklist-hover"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
