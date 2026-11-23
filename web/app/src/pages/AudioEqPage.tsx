import { AudioLines, Check, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { PrefetchLink } from '@/components/PrefetchLink';
import { Select } from '@/components/Select';
import { SubpageHeader } from '@/components/SubpageHeader';
import { BIT_PERFECT_BYPASS_WARNING, bypassedRowClasses } from '@/desktop/BitPerfectBypass';
import type { EqualizerPresetId } from '@/desktop/tauriBridge';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { useBitPerfectUi } from '@/desktop/useBitPerfectUi';
import {
  BAND_LABELS,
  computeEqCurve,
  DEFAULT_EQ_CONFIG,
  formatBalanceLabel,
  MANUAL_BANDS_HZ,
  PRESET_MAP,
  TONE_STEPS,
  type EqConfig,
} from '@/playback/webAudioEq';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

function hzToX(hz: number): number {
  return (Math.log10(Math.max(20, Math.min(20000, hz)) / 20) / Math.log10(1000)) * 520;
}

function dbToY(db: number): number {
  return 80 - Math.max(-14, Math.min(14, db)) * (62 / 14);
}

function EqCurveSvg({ points, eq }: { points: [number, number][]; eq: EqConfig }) {
  const { linePath, areaPath, bandDots } = useMemo(() => {
    if (!points.length) {
      return {
        linePath: 'M 0 80 L 520 80',
        areaPath: 'M 0 80 L 520 80 L 520 80 L 0 80 Z',
        bandDots: [] as { x: number; y: number; label: string }[],
      };
    }
    const coords = points.map(([hz, db]) => [hzToX(hz), dbToY(db)] as const);
    const line = coords
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ');
    const area = `${line} L 520 80 L 0 80 Z`;

    const dots = MANUAL_BANDS_HZ.map((freq, idx) => {
      let nearestDb = 0;
      let bestDist = Infinity;
      for (const [hz, db] of points) {
        const dist = Math.abs(hz - freq);
        if (dist < bestDist) {
          bestDist = dist;
          nearestDb = db;
        }
      }
      return {
        x: hzToX(freq),
        y: dbToY(nearestDb),
        label: BAND_LABELS[idx]!,
      };
    });

    return { linePath: line, areaPath: area, bandDots: dots };
  }, [points]);

  return (
    <div className="rounded-[12px] bg-page/75 p-3">
      <svg
        viewBox="0 0 520 160"
        className="h-[152px] w-full overflow-visible"
        role="img"
        aria-label="Equalizer frequency response curve"
      >
        <defs>
          <linearGradient id="bitchord-eq-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--keyColor)" stopOpacity={eq.enabled ? '0.32' : '0.1'} />
            <stop offset="50%" stopColor="var(--keyColor)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--keyColor)" stopOpacity={eq.enabled ? '0.24' : '0.08'} />
          </linearGradient>
        </defs>

        {[-12, -6, 0, 6, 12].map((db) => {
          const y = dbToY(db);
          const isZero = db === 0;
          return (
            <g key={db}>
              <line
                x1="0"
                y1={y}
                x2="520"
                y2={y}
                stroke="var(--labelDivider)"
                strokeWidth={isZero ? '1.1' : '0.6'}
                strokeDasharray={isZero ? undefined : '3 3'}
              />
              <text x="4" y={y - 4} fill="var(--systemTertiary)" fontSize="9.5" fontFamily="var(--font-sans)">
                {db > 0 ? `+${db} dB` : `${db} dB`}
              </text>
            </g>
          );
        })}

        {MANUAL_BANDS_HZ.map((freq, idx) => {
          const x = hzToX(freq);
          return (
            <g key={freq}>
              <line
                x1={x}
                y1="14"
                x2={x}
                y2="144"
                stroke="var(--labelDivider)"
                strokeWidth="0.5"
                strokeDasharray="2 3"
              />
              <text
                x={x}
                y="156"
                textAnchor="middle"
                fill="var(--systemSecondary)"
                fontSize="9.5"
                fontFamily="var(--font-sans)"
              >
                {BAND_LABELS[idx]}
              </text>
            </g>
          );
        })}

        <path d={areaPath} fill="url(#bitchord-eq-fill)" />
        <path
          d={linePath}
          fill="none"
          stroke={eq.enabled ? 'var(--keyColor)' : 'var(--systemSecondary)'}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {eq.mode === 'manual' &&
          bandDots.map((dot) => (
            <circle
              key={dot.label}
              cx={dot.x}
              cy={dot.y}
              r={eq.enabled ? 4 : 3}
              fill={eq.enabled ? 'var(--keyColor)' : 'var(--systemSecondary)'}
              stroke="var(--pageBG)"
              strokeWidth="1.5"
            />
          ))}
      </svg>
    </div>
  );
}

const GRID_POINTS = Array.from({ length: TONE_STEPS * 2 + 1 }, (_, i) => i - TONE_STEPS);

function TonePad2D({
  x,
  y,
  enabled,
  disabled = false,
  onChange,
}: {
  x: number;
  y: number;
  enabled: boolean;
  disabled?: boolean;
  onChange: (nextX: number, nextY: number) => void;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const updateFromClientPoint = (clientX: number, clientY: number) => {
    if (disabled) return;
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const inset = 18;
    const nx = Math.max(0, Math.min(1, (clientX - (rect.left + inset)) / Math.max(1, rect.width - inset * 2)));
    const ny = Math.max(0, Math.min(1, (clientY - (rect.top + inset)) / Math.max(1, rect.height - inset * 2)));
    const stepX = Math.round((nx * 2 - 1) * TONE_STEPS);
    const stepY = Math.round((1 - ny * 2) * TONE_STEPS);
    onChange(stepX, stepY);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFromClientPoint(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || disabled) return;
    updateFromClientPoint(e.clientX, e.clientY);
  };

  const handlePointerUp = () => {
    dragging.current = false;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(Math.max(-TONE_STEPS, x - 1), y);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(Math.min(TONE_STEPS, x + 1), y);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(x, Math.min(TONE_STEPS, y + 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(x, Math.max(-TONE_STEPS, y - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(0, 0);
    }
  };

  const puckLeftPct = ((x + TONE_STEPS) / (TONE_STEPS * 2)) * 100;
  const puckTopPct = ((TONE_STEPS - y) / (TONE_STEPS * 2)) * 100;

  return (
    <div className="flex flex-col gap-2.5 px-4 pt-4 pb-3">
      <div className="flex items-center justify-between type-caption-2 tracking-[0.06em] text-tertiary uppercase">
        <span>Warm</span>
        <span>Mid Boost</span>
        <span>Bright</span>
      </div>

      <div
        ref={padRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label="Dynamic 2D Tone Pad. Use arrow keys or drag to adjust warmth and mid contour."
        aria-valuetext={`Warm to Bright ${x}, Mid Contour ${y}`}
        aria-valuemin={-TONE_STEPS}
        aria-valuemax={TONE_STEPS}
        aria-valuenow={x}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        className={`relative mx-auto aspect-[16/10] w-full max-w-[440px] touch-none rounded-[14px] bg-page/75 p-[18px] select-none ${
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        }`}
      >
        <div className="relative size-full">
          {/* 11x11 dot grid matching BitChord Mobile TonePad */}
          <div className="grid size-full grid-cols-11 grid-rows-11 place-items-center" aria-hidden="true">
            {GRID_POINTS.map((row) =>
              GRID_POINTS.map((col) => {
                const isOrigin = row === 0 && col === 0;
                const isAxis = row === 0 || col === 0;
                return (
                  <span
                    key={`${row}-${col}`}
                    className={`rounded-full ${
                      isOrigin
                        ? 'size-[5px] bg-secondary'
                        : isAxis
                          ? 'size-[3.5px] bg-tertiary/60'
                          : 'size-[3px] bg-tertiary/35'
                    }`}
                  />
                );
              }),
            )}
          </div>

          {/* Interactive puck */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-[left,top,transform] duration-120 ease-out ${
              enabled
                ? 'border-white bg-key-bg shadow-[0_3px_14px_rgba(250,45,72,0.45)]'
                : 'border-white/70 bg-secondary shadow-sm'
            }`}
            style={{ left: `${puckLeftPct}%`, top: `${puckTopPct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 type-callout tabular-nums text-secondary">
        <span>
          Tone Tilt:{' '}
          <strong className="font-semibold text-primary">
            {x === 0 ? 'Neutral' : x < 0 ? `Warm ${Math.abs(x)}` : `Bright +${x}`}
          </strong>
        </span>
        <span>
          Mid Contour:{' '}
          <strong className="font-semibold text-primary">
            {y === 0 ? 'Flat' : y > 0 ? `+${y}` : `${y}`}
          </strong>
        </span>
      </div>
    </div>
  );
}

export default function AudioEqPage() {
  const eq = usePlayer((s) => s.eq);
  const balance = usePlayer((s) => s.balance);
  const { setEq, setBalance } = usePlayer.getState();
  const pipeline = useAudioPipeline();
  const setPipelineOpen = useUi((s) => s.setAudioPipelineOpen);
  const { lockDspFeatures } = useBitPerfectUi();

  const curve = useMemo(() => computeEqCurve(eq), [eq]);

  const resetFlat = () => {
    if (lockDspFeatures) return;
    setEq({
      ...DEFAULT_EQ_CONFIG,
      enabled: eq.enabled,
      mode: eq.mode,
    });
  };

  return (
    <div className={settingsUi.centered}>
      <SubpageHeader title="Equalizer" backTo="/settings" />
      <div className={settingsUi.body}>
        {lockDspFeatures && (
          <section
            className={`${settingsUi.group} mb-5 px-4 py-3.5`}
            role="status"
            aria-label="Equalizer bypassed"
          >
            <div className="flex flex-col gap-1">
              <span className="type-title-3-emphasized text-primary">
                Equalizer &amp; Balance bypassed (Bit-Perfect active)
              </span>
              <p className="type-callout text-secondary">
                {BIT_PERFECT_BYPASS_WARNING} Your saved EQ settings stay intact.{' '}
                <PrefetchLink to="/settings/playback" className={settingsUi.inlineLink}>
                  Playback settings
                </PrefetchLink>
              </p>
            </div>
          </section>
        )}

        <section className={`${settingsUi.group} ${bypassedRowClasses(lockDspFeatures)}`}>
          <Toggle
            label="Equalizer"
            detail={
              lockDspFeatures
                ? 'Bypassed while WASAPI Exclusive (Bit-Perfect) is active.'
                : eq.enabled
                  ? `Active · Preamp ${curve.preampDb >= 0 ? `+${curve.preampDb.toFixed(1)}` : curve.preampDb.toFixed(1)} dB`
                  : '10-slot parametric & shelf filter bank with automatic makeup preamp and limiter.'
            }
            checked={eq.enabled}
            disabled={lockDspFeatures}
            onChange={(enabled) => {
              if (!lockDspFeatures) setEq({ enabled });
            }}
          />
        </section>

        {/* Segmented pill switching Dynamic Tone Pad vs Manual 7-Band matching EqualizerScreen.kt */}
        <div
          role="tablist"
          aria-label="Equalizer mode"
          aria-disabled={lockDspFeatures || undefined}
          className={`mt-5 grid grid-cols-2 gap-1 rounded-pill bg-segmented p-1 ${bypassedRowClasses(lockDspFeatures)}`}
        >
          {(
            [
              { id: 'tone', label: 'Dynamic' },
              { id: 'manual', label: 'Manual' },
            ] as const
          ).map((tab) => {
            const active = eq.mode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={lockDspFeatures}
                onClick={() => {
                  if (!lockDspFeatures) setEq({ mode: tab.id });
                }}
                className={`rounded-pill px-3 py-2 text-center type-callout-emphasized transition-colors ${
                  active
                    ? 'bg-segmented-selected text-primary shadow-xs'
                    : 'text-secondary hover:text-primary'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Always-visible live Frequency Response Curve */}
        <h2 className={settingsUi.sectionHeader}>Frequency Response</h2>
        <section className={`${settingsUi.group} ${bypassedRowClasses(lockDspFeatures)}`}>
          <div className="px-4 py-3.5">
            <EqCurveSvg points={curve.points} eq={eq} />
          </div>
        </section>

        {eq.mode === 'tone' ? (
          <>
            <h2 className={settingsUi.sectionHeader}>Tone Pad</h2>
            <section
              className={`${settingsUi.group} ${bypassedRowClasses(lockDspFeatures)}`}
              aria-disabled={lockDspFeatures || undefined}
            >
              <TonePad2D
                x={eq.toneX}
                y={eq.toneY}
                enabled={eq.enabled}
                disabled={lockDspFeatures}
                onChange={(toneX, toneY) => {
                  if (!lockDspFeatures) setEq({ enabled: true, mode: 'tone', toneX, toneY });
                }}
              />

              <button
                type="button"
                disabled={lockDspFeatures}
                onClick={() => {
                  if (!lockDspFeatures) setEq({ toneFocused: false });
                }}
                className={`${settingsUi.integrationPlain} ${settingsUi.linkRow}`}
              >
                <span className={settingsUi.rowText}>
                  <span className="type-title-3 text-primary">Broad</span>
                  <span className={settingsUi.rowDetail}>Gentle wide-Q shelves across lows, mids, and highs.</span>
                </span>
                {!eq.toneFocused && <Check size={18} strokeWidth={2.4} className="text-key" aria-hidden="true" />}
              </button>

              <button
                type="button"
                disabled={lockDspFeatures}
                onClick={() => {
                  if (!lockDspFeatures) setEq({ toneFocused: true });
                }}
                className={`${settingsUi.integrationPlain} ${settingsUi.linkRow}`}
              >
                <span className={settingsUi.rowText}>
                  <span className="type-title-3 text-primary">Focused</span>
                  <span className={settingsUi.rowDetail}>Narrower shelf and mid-band Q for targeted shaping.</span>
                </span>
                {eq.toneFocused && <Check size={18} strokeWidth={2.4} className="text-key" aria-hidden="true" />}
              </button>

              <button
                type="button"
                disabled={lockDspFeatures}
                onClick={resetFlat}
                className="relative flex w-full items-center justify-center gap-1.5 px-4 py-3 type-body-emphasized text-key transition-colors hover:bg-tracklist-hover hairline-[16px]"
              >
                <RotateCcw size={14} aria-hidden="true" />
                Reset Tone Pad
              </button>
            </section>
          </>
        ) : (
          <>
            <h2 className={settingsUi.sectionHeader}>Bands &amp; Presets</h2>
            <section
              className={`${settingsUi.group} ${bypassedRowClasses(lockDspFeatures)}`}
              aria-disabled={lockDspFeatures || undefined}
            >
              <div className={settingsUi.controlRow}>
                <span>Preset</span>
                <div className="flex items-center gap-2">
                  <Select<EqualizerPresetId>
                    label="Equalizer Preset"
                    value={eq.preset}
                    disabled={lockDspFeatures}
                    options={(Object.keys(PRESET_MAP) as EqualizerPresetId[]).map((id) => ({
                      value: id,
                      label: PRESET_MAP[id].label,
                    }))}
                    onChange={(preset) => {
                      if (lockDspFeatures) return;
                      const bands = PRESET_MAP[preset].bands;
                      setEq({
                        enabled: true,
                        preset,
                        ...(bands ? { bandsDb: [...bands] as EqConfig['bandsDb'] } : {}),
                      });
                    }}
                  />
                  <button
                    type="button"
                    disabled={lockDspFeatures}
                    onClick={resetFlat}
                    className={settingsUi.inlineButton}
                    title="Reset all bands to 0 dB"
                  >
                    <span className="inline-flex items-center gap-1">
                      <RotateCcw size={12} aria-hidden="true" />
                      Flat
                    </span>
                  </button>
                </div>
              </div>

              <div className="relative grid grid-cols-7 gap-2 px-4 py-4 hairline-[16px]">
                {BAND_LABELS.map((label, idx) => {
                  const val = eq.bandsDb[idx] ?? 0;
                  return (
                    <div key={label} className="flex flex-col items-center gap-2">
                      <span className="type-caption-2 tabular-nums text-secondary">
                        {val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={-12}
                        max={12}
                        step={0.5}
                        value={val}
                        disabled={lockDspFeatures}
                        aria-label={`${label} band gain in dB`}
                        className="h-28 w-2 cursor-pointer accent-key [writing-mode:vertical-lr] [direction:rtl] disabled:cursor-not-allowed"
                        onChange={(e) => {
                          if (lockDspFeatures) return;
                          const next = [...eq.bandsDb] as EqConfig['bandsDb'];
                          next[idx] = Number(e.currentTarget.value);
                          setEq({ enabled: true, preset: 'custom', bandsDb: next });
                        }}
                      />
                      <span className="type-caption-2 text-secondary">{label}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* Channel Balance section matching EqualizerScreen.kt */}
        <h2 className={settingsUi.sectionHeader}>Balance</h2>
        <section
          className={`${settingsUi.group} ${bypassedRowClasses(lockDspFeatures)}`}
          aria-disabled={lockDspFeatures || undefined}
        >
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-center justify-between">
              <span className="type-title-3 text-primary">Left / Right Balance</span>
              <div className="flex items-center gap-2">
                <span className="type-callout tabular-nums text-secondary">{formatBalanceLabel(balance)}</span>
                {Math.abs(balance) > 0.01 && (
                  <button
                    type="button"
                    disabled={lockDspFeatures}
                    onClick={() => {
                      if (!lockDspFeatures) setBalance(0);
                    }}
                    className={settingsUi.inlineButton}
                  >
                    Center
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="type-caption-2 font-semibold text-secondary">L</span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={balance}
                disabled={lockDspFeatures}
                aria-label="Stereo channel balance"
                onChange={(e) => {
                  if (!lockDspFeatures) setBalance(Number(e.currentTarget.value));
                }}
                className="h-2 flex-1 cursor-pointer accent-key disabled:cursor-not-allowed"
              />
              <span className="type-caption-2 font-semibold text-secondary">R</span>
            </div>
          </div>
        </section>

        <h2 className={settingsUi.sectionHeader}>Audio Output &amp; Signal Path</h2>
        <section className={settingsUi.group}>
          <button
            type="button"
            onClick={() => setPipelineOpen(true)}
            className={`${settingsUi.integration} ${settingsUi.linkRow}`}
          >
            <span className={settingsUi.iconPlain}>
              <AudioLines size={19} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Audio Pipeline</span>
              <span className={settingsUi.rowDetail}>{pipeline.shortSubtitle} · {pipeline.activeDeviceName}</span>
            </span>
            <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
          </button>

          <PrefetchLink to="/settings/playback" className={`${settingsUi.integration} ${settingsUi.linkRow}`}>
            <span className={settingsUi.iconPlain}>
              <SlidersHorizontal size={19} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Playback &amp; WASAPI Output</span>
              <span className={settingsUi.rowDetail}>Output precision, bit-perfect mode, crossfade, and spatial audio</span>
            </span>
            <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
          </PrefetchLink>
        </section>
      </div>
    </div>
  );
}
