interface PillRangeSliderProps {
  value: number;
  min?: number;
  max: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: number) => void;
}

/**
 * Shared thick pill slider with a vertical thumb indicator matching BitChord's
 * Playback Crossfade and Source Matching Track Length Tolerance controls.
 */
export function PillRangeSlider({
  value,
  min = 0,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  onChange,
}: PillRangeSliderProps) {
  const span = Math.max(1, max - min);
  const clamped = Math.max(min, Math.min(max, value));
  const pct = ((clamped - min) / span) * 100;

  return (
    <div className="relative flex h-9 items-center">
      <div className="relative h-4 w-full overflow-hidden rounded-pill bg-quaternary">
        <div className="h-full rounded-l-pill bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-primary shadow-[0_1px_6px_rgba(0,0,0,0.45)]"
        style={{ left: `calc(${pct}% + ${pct < 8 ? 6 : pct > 92 ? -6 : 0}px)` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          if (!disabled) onChange(Number(e.currentTarget.value));
        }}
        className={`absolute inset-0 h-full w-full opacity-0 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      />
    </div>
  );
}
