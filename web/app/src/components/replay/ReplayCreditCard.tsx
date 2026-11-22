import { useEffect, useRef, type CSSProperties } from 'react';
import { LogoMark } from '@/components/icons/LogoMark';
import { GRID, meshPalette, type Rgb } from '@/lib/meshPalette';

// Metallic vertical ink fill and raised drop shadow matching ReplayCard.kt PolishedInk + EmbossShadow.
const polishedInkStyle: CSSProperties = {
  backgroundImage: 'linear-gradient(180deg, #ffffff 0%, #f3f4f8 52%, #c9ccd6 100%)',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: '#f3f4f8',
  filter: 'drop-shadow(0 2px 3px rgba(0, 0, 0, 0.62))',
};

const CHARCOAL_FALLBACK: Rgb[] = [
  [66, 66, 72],
  [58, 58, 64],
  [48, 48, 54],
  [42, 42, 48],
  [56, 56, 62],
  [50, 50, 56],
  [42, 42, 47],
  [36, 36, 42],
  [45, 45, 50],
  [40, 40, 45],
  [34, 34, 39],
  [29, 29, 34],
  [36, 36, 41],
  [31, 31, 36],
  [26, 26, 31],
  [22, 22, 27],
];

const CANVAS_W = 64;
const CANVAS_H = 40;

const BLOB_COORDS: [number, number, number][] = Array.from({ length: GRID * GRID }, (_, i) => {
  const row = Math.floor(i / GRID);
  const col = i % GRID;
  const spread = (n: number) => -0.08 + ((n + 0.5) / GRID) * 1.16;
  return [spread(GRID - 1 - row), spread(col), 0.68];
});

function paintStaticMesh(canvas: HTMLCanvasElement, cells: Rgb[]): void {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  if (canvas.width !== CANVAS_W) canvas.width = CANVAS_W;
  if (canvas.height !== CANVAS_H) canvas.height = CANVAS_H;

  const avg = cells.reduce<Rgb>(
    (acc, c) => [acc[0] + c[0] / cells.length, acc[1] + c[1] / cells.length, acc[2] + c[2] / cells.length],
    [0, 0, 0],
  );
  ctx.fillStyle = `rgb(${avg[0] | 0} ${avg[1] | 0} ${avg[2] | 0})`;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const side = Math.max(CANVAS_W, CANVAS_H);
  BLOB_COORDS.forEach(([bx, by, reach], idx) => {
    const [r, g, b] = cells[idx] ?? avg;
    const x = bx * CANVAS_W;
    const y = by * CANVAS_H;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, reach * side);
    grad.addColorStop(0, `rgb(${r | 0} ${g | 0} ${b | 0} / 0.92)`);
    grad.addColorStop(0.55, `rgb(${r | 0} ${g | 0} ${b | 0} / 0.38)`);
    grad.addColorStop(1, `rgb(${r | 0} ${g | 0} ${b | 0} / 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  });
}

function StaticCardMesh({ artworkUrl }: { artworkUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    paintStaticMesh(el, CHARCOAL_FALLBACK);
    if (!artworkUrl) return;
    let active = true;
    void meshPalette(artworkUrl)
      .then((cells) => {
        if (active && canvasRef.current) {
          paintStaticMesh(canvasRef.current, cells);
        }
      })
      .catch(() => {
        // Unreadable cover keeps the brushed charcoal metallic base.
      });
    return () => {
      active = false;
    };
  }, [artworkUrl]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />;
}

export interface ReplayCreditCardProps {
  label: string;
  value: string;
  detail: string | null;
  artworkUrl: string | null;
  holder: string;
  memberSince: string | null;
  onClick?: () => void;
  className?: string;
}

export function ReplayCreditCard({
  label,
  value,
  detail,
  artworkUrl,
  holder,
  memberSince,
  onClick,
  className = '',
}: ReplayCreditCardProps) {
  const holderText = (holder.trim() || 'BITCHORD LISTENER').toUpperCase();
  const labelUpper = label.toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Your listening experience: ${value} ${label}${detail ? `, ${detail}` : ''}`}
      className={`group/card relative flex aspect-[1.586/1] w-[284px] flex-none flex-col justify-between overflow-hidden rounded-[20px] px-[18px] py-4 text-start shadow-[0_14px_32px_rgb(0_0_0/0.28)] transition-transform duration-150 ease-out hover:-translate-y-0.5 active:translate-y-0 sm:w-[308px] ${className}`}
    >
      <StaticCardMesh artworkUrl={artworkUrl} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(0, 0, 0, 0.18) 0%, rgba(0, 0, 0, 0.30) 55%, rgba(0, 0, 0, 0.55) 100%)',
          boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.09)',
          borderRadius: 'inherit',
        }}
      />

      <div className="relative z-1 flex w-full items-start justify-between gap-2.5">
        <span className="min-w-0 flex-1 truncate type-[700_10.5px/13px] tracking-[1.4px] text-white/75 uppercase">
          YOUR LISTENING EXPERIENCE
        </span>
        <LogoMark size={34} className="flex-none text-white" />
      </div>

      <div className="relative z-1 my-auto flex w-full flex-col pt-1">
        <span
          className="line-clamp-2 type-[800_27px/30px] tracking-[-0.01em]"
          style={polishedInkStyle}
        >
          {value}
        </span>
        <span className="mt-1 truncate type-[700_10.5px/13px] tracking-[1.8px] text-white/68 uppercase">
          {labelUpper}
        </span>
      </div>

      <div className="relative z-1 flex w-full items-end justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate font-mono text-[13px] leading-[16px] font-semibold tracking-[1.6px] uppercase"
            style={polishedInkStyle}
          >
            {holderText}
          </span>
          {detail && (
            <span className="mt-0.5 truncate type-[500_11.5px/15px] text-white/65">
              {detail}
            </span>
          )}
        </div>

        {memberSince && (
          <div className="flex flex-none flex-col items-end text-right">
            <span className="text-[7.5px] leading-[8.5px] font-semibold tracking-[0.8px] text-white/60 uppercase">
              MEMBER{'\n'}SINCE
            </span>
            <span
              className="mt-0.5 font-mono text-[12px] leading-[15px] font-semibold tracking-[1.6px] tabular-nums"
              style={polishedInkStyle}
            >
              {memberSince}
            </span>
          </div>
        )}
      </div>
    </button>
  );
}
