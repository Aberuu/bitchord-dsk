import { party, useParty } from '@/party/listenTogether';
import { GripVertical, Infinity as InfinityIcon, MoreHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useContextMenu } from '@/components/contextMenu';
import { Menu, MenuHeader, MenuItem, MenuSeparator } from '@/components/Menu';
import { Artwork } from '@/components/music/Artwork';
import { formatDuration } from '@/components/music/links';
import {
  autoplaySectionStart,
  resolveQueueDropTarget,
  upcomingUserQueueIndices,
  type QueueDropTarget,
  type QueueEntry,
  type QueueRowBox,
  type QueueSection,
} from '@/playback/queue/timeline';
import { CROSSFADE_CHOICES, usePlayer } from '@/state/player';

// The panel's square buttons: AutoPlay (the key colour when on) and the options menu.
const square = 'grid size-7 place-items-center rounded-[6px] text-secondary hover:bg-quinary aria-pressed:text-key';
const list = 'flex flex-col';

interface DragSession {
  entryId: string;
  startX: number;
  startY: number;
  active: boolean;
  immediate: boolean;
}

/** A row: 55px, [art] 40px [title] 1fr [right] 40px [grip] 20px, gap 10px, radius 6px; a key-colour line where a drag would drop. */
function Row({
  entry,
  at,
  section,
  dragging,
  dropEdge,
  canMoveUp,
  canMoveDown,
  onRowPointerDown,
  onKeyboardMove,
}: {
  entry: QueueEntry;
  at: number;
  section: QueueSection;
  dragging: boolean;
  dropEdge: 'top' | 'bottom' | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRowPointerDown: (e: React.PointerEvent<HTMLLIElement>, entryId: string) => void;
  onKeyboardMove: (entryId: string, direction: -1 | 1) => void;
}) {
  const { jumpTo, removeAt, playNext } = usePlayer.getState();
  const menu = useContextMenu();
  const { track } = entry;

  return (
    <li
      className="group/row relative grid h-[55px] select-none grid-cols-[40px_minmax(0,1fr)_40px_20px] items-center gap-x-2.5 rounded-row px-2.5 transition-colors duration-150 ease-out hover:bg-quinary data-open:bg-quinary data-dragging:bg-quinary data-dragging:opacity-45 data-[drop-edge=bottom]:after:pointer-events-none data-[drop-edge=bottom]:after:absolute data-[drop-edge=bottom]:after:inset-x-2.5 data-[drop-edge=bottom]:after:-bottom-px data-[drop-edge=bottom]:after:z-10 data-[drop-edge=bottom]:after:h-0.5 data-[drop-edge=bottom]:after:rounded-full data-[drop-edge=bottom]:after:bg-key data-[drop-edge=bottom]:after:content-[''] data-[drop-edge=top]:before:pointer-events-none data-[drop-edge=top]:before:absolute data-[drop-edge=top]:before:inset-x-2.5 data-[drop-edge=top]:before:-top-px data-[drop-edge=top]:before:z-10 data-[drop-edge=top]:before:h-0.5 data-[drop-edge=top]:before:rounded-full data-[drop-edge=top]:before:bg-key data-[drop-edge=top]:before:content-['']"
      data-queue-index={at}
      data-queue-section={section}
      data-entry-id={entry.entryId}
      data-drop-edge={dropEdge ?? undefined}
      data-dragging={dragging || undefined}
      data-open={menu.isOpen || undefined}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => onRowPointerDown(e, entry.entryId)}
      onContextMenu={menu.openAtEvent}
      onDoubleClick={() => jumpTo(at)}
    >
      <div className="relative size-10">
        <div className="size-full overflow-hidden rounded-artwork-sm transition-transform duration-150 ease-out group-hover/row:scale-[1.03] group-data-dragging/row:scale-100">
          <Artwork src={track.thumbnail} displayWidth={40} radius="var(--radius-artwork-small)" />
        </div>
        {/* The ✕ over the artwork's top-left, on hover. */}
        <button
          type="button"
          data-no-drag="true"
          className="absolute -top-1.5 -left-1.5 hidden size-[22px] place-items-center rounded-full bg-thick-material text-primary shadow-[0_1px_3px_#0004] [backdrop-filter:blur(10px)] group-hover/row:grid"
          aria-label={`Remove ${track.title}`}
          onClick={() => removeAt(at)}
        >
          <X size={12} strokeWidth={3} />
        </button>
      </div>
      <button type="button" className="flex min-w-0 flex-col text-start" onClick={() => jumpTo(at)} aria-label={`Play ${track.title}`}>
        <span className="truncate type-body text-primary">{track.title}</span>
        <span className="truncate type-body text-secondary">{track.artists.map((a) => a.name).join(', ')}</span>
      </button>
      <div className="relative grid items-center justify-items-end">
        <span className="type-body tabular-nums text-secondary group-hover/row:invisible group-has-[[data-open]]/row:invisible">{formatDuration(track.durationSec)}</span>
        <button
          type="button"
          data-no-drag="true"
          className="absolute inset-y-0 right-0 my-auto hidden size-7 place-items-center rounded-full text-key group-hover/row:grid data-open:grid"
          aria-label={`More options for ${track.title}`}
          aria-haspopup="menu"
          data-open={menu.isOpen || undefined}
          onClick={(e) => menu.toggleFromAnchor(e.currentTarget)}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      <button
        type="button"
        data-drag-handle="true"
        className="grid h-8 w-5 cursor-grab touch-none place-items-center rounded-[4px] text-tertiary transition-colors hover:text-primary group-hover/row:text-secondary focus-visible:text-key focus-visible:outline-2 focus-visible:outline-key active:cursor-grabbing"
        aria-label={`Reorder ${track.title}. Press Alt+Up or Alt+Down to move.`}
        title="Drag to reorder (or Alt+Up / Alt+Down)"
        onKeyDown={(e) => {
          if (!e.altKey) return;
          if (e.key === 'ArrowUp' && canMoveUp) {
            e.preventDefault();
            onKeyboardMove(entry.entryId, -1);
          } else if (e.key === 'ArrowDown' && canMoveDown) {
            e.preventDefault();
            onKeyboardMove(entry.entryId, 1);
          }
        }}
      >
        <GripVertical size={15} />
      </button>
      {menu.isOpen && (
        <Menu anchor={menu.anchor} point={menu.point} returnFocusTo={menu.returnFocusTo} onClose={menu.close} label={track.title}>
          <MenuItem onSelect={() => (menu.close(), jumpTo(at))}>Play Now</MenuItem>
          <MenuItem
            onSelect={() => {
              menu.close();
              removeAt(at);
              playNext([track], entry.source);
            }}
          >
            Play Next
          </MenuItem>
          <MenuSeparator />
          <MenuItem destructive onSelect={() => (menu.close(), removeAt(at))}>
            Remove from Up Next
          </MenuItem>
        </Menu>
      )}
    </li>
  );
}

/** Apple's Up Next (report §7), over the three-tier queue: what's next, then AutoPlay's section. */
export function UpNext() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const localAutoplay = usePlayer((s) => s.autoplay);
  // In a party AutoPlay is the party's setting (Autoplay.autoplayEnabledFor).
  const inParty = useParty((s) => !!s.code);
  const partyAutoplay = useParty((s) => s.playback.autoplayEnabled);
  const autoplay = inParty ? partyAutoplay : localAutoplay;
  const repeat = usePlayer((s) => s.repeat);
  const crossfadeSec = usePlayer((s) => s.crossfadeSec);
  const automix = usePlayer((s) => s.automix);
  const { clearUpNext, setAutoplay, setCrossfade, setAutomix, move } = usePlayer.getState();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draggingEntryId, setDraggingEntryId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<QueueDropTarget | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const targetRef = useRef<QueueDropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const close = useCallback(() => setAnchor(null), []);

  const tiers = queue.map((e) => e.tier);
  const autoplayAt = autoplaySectionStart(tiers, index);
  const canClear = upcomingUserQueueIndices(tiers, index).length > 0;
  const upcoming = queue.map((entry, at) => ({ entry, at })).filter(({ at }) => at > index);
  const beforeAutoplay = upcoming.filter(({ at }) => at < autoplayAt);
  const afterAutoplay = upcoming.filter(({ at }) => at >= autoplayAt);
  const playingFrom = queue[index]?.source?.title;

  const measureRows = useCallback((): QueueRowBox[] => {
    const container = scrollRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll<HTMLLIElement>('li[data-queue-index]')).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        at: Number(el.dataset.queueIndex),
        section: el.dataset.queueSection === 'autoplay' ? 'autoplay' : 'upnext',
        top: rect.top,
        bottom: rect.bottom,
      };
    });
  }, []);

  const endDragSession = useCallback(() => {
    sessionRef.current = null;
    targetRef.current = null;
    document.body.style.cursor = '';
    setDraggingEntryId(null);
    setDropTarget(null);
  }, []);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const session = sessionRef.current;
      if (!session) return;

      if (!session.active) {
        const threshold = session.immediate ? 2 : 5;
        if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < threshold) return;
        session.active = true;
        window.getSelection()?.removeAllRanges();
        document.body.style.cursor = 'grabbing';
        setDraggingEntryId(session.entryId);
      }

      const container = scrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (e.clientY < rect.top + 36) container.scrollTop -= 8;
        else if (e.clientY > rect.bottom - 36) container.scrollTop += 8;
      }

      const state = usePlayer.getState();
      const from = state.queue.findIndex((item, pos) => pos > state.index && item.entryId === session.entryId);
      if (from <= state.index) {
        endDragSession();
        return;
      }

      const nextTarget = resolveQueueDropTarget(measureRows(), from, e.clientY);
      targetRef.current = nextTarget;
      setDropTarget(nextTarget);
    };

    const onPointerUp = () => {
      const session = sessionRef.current;
      if (!session) return;
      const target = targetRef.current;
      const wasActive = session.active;
      endDragSession();
      if (!wasActive) return;

      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 60);

      if (!target) return;
      const state = usePlayer.getState();
      const from = state.queue.findIndex((item, pos) => pos > state.index && item.entryId === session.entryId);
      if (from > state.index) state.move(from, target.to, target.section);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endDragSession);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', endDragSession);
      document.body.style.cursor = '';
    };
  }, [endDragSession, measureRows]);

  const handleRowPointerDown = useCallback((e: React.PointerEvent<HTMLLIElement>, entryId: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-no-drag="true"], [role="menu"], [role="menuitem"]')) return;
    const immediate = Boolean(target?.closest('[data-drag-handle="true"]'));
    sessionRef.current = {
      entryId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      immediate,
    };
  }, []);

  const handleKeyboardMove = useCallback(
    (entryId: string, direction: -1 | 1) => {
      const state = usePlayer.getState();
      const from = state.queue.findIndex((item, pos) => pos > state.index && item.entryId === entryId);
      if (from <= state.index) return;
      const to = from + direction;
      if (to <= state.index || to >= state.queue.length) return;
      move(from, to);
      requestAnimationFrame(() => {
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(entryId) : entryId.replace(/"/g, '\\"');
        scrollRef.current?.querySelector<HTMLButtonElement>(`li[data-entry-id="${escaped}"] [data-drag-handle="true"]`)?.focus();
      });
    },
    [move],
  );

  const rows = (items: typeof upcoming, section: QueueSection) =>
    items.map(({ entry, at }) => (
      <Row
        key={entry.entryId}
        entry={entry}
        at={at}
        section={section}
        dragging={draggingEntryId === entry.entryId}
        dropEdge={dropTarget?.indicatorAt === at ? dropTarget.edge : null}
        canMoveUp={at > index + 1}
        canMoveDown={at < queue.length - 1}
        onRowPointerDown={handleRowPointerDown}
        onKeyboardMove={handleKeyboardMove}
      />
    ));

  return (
    <>
      <div className="flex items-center gap-1.5 px-5 pt-[23px] pb-3">
        <h3 className="flex-1 type-title-2-emphasized">Up Next</h3>
        {canClear && (
          <button className="mr-1 type-title-3 text-key" onClick={clearUpNext}>
            Clear
          </button>
        )}
        <button
          className={square}
          aria-label="AutoPlay"
          title="AutoPlay: keep playing similar music when the queue ends"
          aria-pressed={autoplay}
          onClick={() => (inParty ? party.setAutoplay(!autoplay) : setAutoplay(!autoplay))}
        >
          <InfinityIcon size={16} strokeWidth={2.4} />
        </button>
        <button className={square} aria-label="Playback options" aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)}>
          <MoreHorizontal size={16} />
        </button>
        {anchor && (
          <Menu anchor={anchor} onClose={close} label="Playback options">
            <MenuHeader>Crossfade</MenuHeader>
            {CROSSFADE_CHOICES.map((seconds) => (
              <MenuItem key={seconds} checked={!automix && crossfadeSec === seconds} onSelect={() => (close(), setCrossfade(seconds))}>
                {seconds === 0 ? 'Off' : `${seconds} seconds`}
              </MenuItem>
            ))}
            <MenuItem checked={automix} onSelect={() => (close(), setAutomix(true))}>
              Automix
            </MenuItem>
          </Menu>
        )}
      </div>
      {playingFrom && <p className="truncate px-5 pb-2 type-callout text-secondary">Playing from {playingFrom}</p>}

      {upcoming.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-20 text-center type-callout text-secondary">
          <p className="type-callout-emphasized">Nothing in Up Next</p>
          <p>
            {autoplay && repeat === 'off' && index >= 0
              ? 'AutoPlay is finding similar music.'
              : 'Songs you play next appear here.'}
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-[120px] scrollbar-compact"
          onClickCapture={(e) => {
            if (!suppressClickRef.current) return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <ol className={list}>{rows(beforeAutoplay, 'upnext')}</ol>
          {afterAutoplay.length > 0 && (
            <>
              <h4 className="mx-2.5 mt-[18px] mb-0.5 flex items-center gap-1.5 type-callout-emphasized">
                <InfinityIcon size={14} strokeWidth={2.4} /> AutoPlay
              </h4>
              <p className="mx-2.5 mb-2 type-callout text-secondary">Similar music, from YouTube Music’s radio.</p>
              <ol className={list}>{rows(afterAutoplay, 'autoplay')}</ol>
            </>
          )}
        </div>
      )}
    </>
  );
}
