import { ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LogoMark } from '@/components/icons/LogoMark';
import type { ReplayFocus, ReplayHeroCard } from '@/desktop/statsApi';
import { ReplayCreditCard } from './ReplayCreditCard';

const arrowBtn =
  'absolute top-1/2 z-3 hidden h-11 w-7 -translate-y-1/2 place-items-center rounded-pill bg-thin-material text-secondary opacity-0 transition-[opacity,background-color,color] duration-150 ease-linear [backdrop-filter:saturate(180%)_blur(40px)] hover:text-primary disabled:pointer-events-none lg:grid lg:enabled:group-hover/replay-row:opacity-100';

export interface ReplayCardCarouselProps {
  cards: ReplayHeroCard[];
  holder: string;
  memberSince: string | null;
  loading?: boolean;
  onSelectCard: (focus: ReplayFocus) => void;
  onImportBackup?: () => void;
}

export function ReplayCardCarousel({
  cards,
  holder,
  memberSince,
  loading = false,
  onSelectCard,
  onImportBackup,
}: ReplayCardCarouselProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 2,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, cards.length]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * 324, behavior: 'smooth' });
  };

  if (loading) {
    return (
      <div
        className="flex gap-3 overflow-hidden px-(--body-gutter) py-2"
        aria-busy="true"
        aria-label="Loading listening cards"
      >
        {[0, 1, 2, 3].map((idx) => (
          <div
            key={idx}
            className="aspect-[1.586/1] w-[284px] flex-none animate-shimmer rounded-[20px] bg-skeleton sm:w-[308px]"
          />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    const holderText = (holder.trim() || 'BITCHORD LISTENER').toUpperCase();
    return (
      <div className="px-(--body-gutter) py-2">
        <div
          className="relative flex aspect-[1.586/1] w-full max-w-[336px] flex-col justify-between overflow-hidden rounded-[20px] px-[18px] py-4 text-white shadow-[0_14px_32px_rgb(0_0_0/0.25)]"
          style={{
            background:
              'linear-gradient(145deg, #38383d 0%, #242428 52%, #17171a 100%)',
            boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.09), 0 14px 32px rgba(0, 0, 0, 0.25)',
          }}
        >
          <div className="flex items-start justify-between gap-2.5">
            <span className="truncate type-[700_10.5px/13px] tracking-[1.4px] text-white/75 uppercase">
              YOUR LISTENING EXPERIENCE
            </span>
            <LogoMark size={34} className="flex-none text-white" />
          </div>

          <div className="my-auto flex flex-col gap-1">
            <span className="type-[800_21px/25px] text-white">
              Play a song to start your card
            </span>
            <span className="type-[400_12px/16px] text-white/70">
              Minutes, top songs, artists, and albums appear here as you listen, or import your Android backup JSON.
            </span>
          </div>

          <div className="flex items-end justify-between gap-2">
            <span className="truncate font-mono text-[12px] leading-[15px] font-semibold tracking-[1.5px] text-white/80 uppercase">
              {holderText}
            </span>
            {onImportBackup && (
              <button
                type="button"
                onClick={onImportBackup}
                className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-white/14 px-3 py-1.5 type-[600_11.5px/14px] text-white transition-colors hover:bg-white/22"
              >
                <Upload size={12} aria-hidden="true" />
                Import Backup
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/replay-row relative">
      <button
        type="button"
        className={`${arrowBtn} left-1.5`}
        aria-label="Previous listening cards"
        disabled={edges.start}
        onClick={() => scrollByPage(-1)}
      >
        <ChevronLeft size={20} strokeWidth={2.4} />
      </button>

      <div
        ref={listRef}
        onScroll={measure}
        className="flex snap-x snap-mandatory gap-3.5 overflow-x-auto overflow-y-visible px-(--body-gutter) py-3 scroll-px-(--body-gutter) scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden *:snap-start"
      >
        {cards.map((card) => (
          <ReplayCreditCard
            key={card.id}
            label={card.label}
            value={card.value}
            detail={card.detail}
            artworkUrl={card.artworkUrl}
            holder={holder}
            memberSince={memberSince}
            onClick={() => onSelectCard(card.focus)}
          />
        ))}
      </div>

      <button
        type="button"
        className={`${arrowBtn} right-1.5`}
        aria-label="Next listening cards"
        disabled={edges.end}
        onClick={() => scrollByPage(1)}
      >
        <ChevronRight size={20} strokeWidth={2.4} />
      </button>
    </div>
  );
}
