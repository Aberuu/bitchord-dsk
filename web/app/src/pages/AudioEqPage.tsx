import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Select } from '@/components/Select';
import {
  desktopApi,
  isTauriDesktop,
  type AudioSettings,
  type EqualizerPresetId,
  type OutputMode,
} from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import {
  BAND_LABELS,
  computeEqCurve,
  DEFAULT_EQ_CONFIG,
  MANUAL_BANDS_HZ,
  PRESET_MAP,
  type EqConfig,
} from '@/playback/webAudioEq';
import { usePlayer } from '@/state/player';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

const SPEED_OPTIONS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((r) => ({
  value: r,
  label: `${r}x`,
}));

const SLEEP_OPTIONS: { value: string; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: '60 minutes' },
  { value: 'track', label: 'End of current track' },
];

function hzToX(hz: number): number {
  return (Math.log10(Math.max(20, Math.min(20000, hz)) / 20) / Math.log10(1000)) * 520;
}

function dbToY(db: number): number {
  return 80 - Math.max(-14, Math.min(14, db)) * (62 / 14);
}

function EqCurveSvg({
  points,
  eq,
}: {
  points: [number, number][];
  eq: EqConfig;
}) {
  const { linePath, areaPath, bandDots } = useMemo(() => {
    if (!points.length) {
      return {
        linePath: 'M 0 80 L 520 80',
        areaPath: 'M 0 80 L 520 80 L 520 80 L 0 80 Z',
        bandDots: [] as { x: number; y: number; label: string; db: number }[],
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
        db: eq.bandsDb[idx] ?? 0,
      };
    });

    return { linePath: line, areaPath: area, bandDots: dots };
  }, [points, eq]);

  return (
    <div className="rounded-[10px] bg-page/70 p-3">
      <svg
        viewBox="0 0 520 160"
        className="h-[156px] w-full overflow-visible"
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
              <text
                x="4"
                y={y - 4}
                fill="var(--systemTertiary)"
                fontSize="9.5"
                fontFamily="var(--font-sans)"
              >
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

export default function AudioEqPage() {
  const desktop = isTauriDesktop();
  const playbackRate = usePlayer((s) => s.playbackRate);
  const sleepTimerEndMs = usePlayer((s) => s.sleepTimerEndMs);
  const sleepAfterTrack = usePlayer((s) => s.sleepAfterTrack);
  const eq = usePlayer((s) => s.eq);
  const { setPlaybackRate, setSleepTimer, setEq } = usePlayer.getState();

  const curve = useMemo(() => computeEqCurve(eq), [eq]);

  const devicesQuery = useQuery({
    queryKey: ['desktop', 'audio', 'devices'],
    queryFn: () => desktopApi.audioListDevices(),
    enabled: desktop,
  });

  const snapQuery = useQuery({
    queryKey: ['desktop', 'audio', 'snapshot'],
    queryFn: () => desktopApi.audioSnapshot(),
    enabled: desktop,
  });

  const save = useMutation({
    mutationFn: (next: AudioSettings) => desktopApi.audioUpdateSettings(next),
    onSuccess: (updated) => {
      queryClient.setQueryData(['desktop', 'audio', 'snapshot'], updated);
      usePlayer.setState({ bitPerfectStatus: updated.bitPerfect });
    },
  });

  const snap = snapQuery.data;
  const settings = snap?.settings;
  const devices = devicesQuery.data ?? [];

  const patchSettings = (patch: Partial<AudioSettings>) => {
    if (!settings) return;
    save.mutate({ ...settings, ...patch, eq });
  };

  const patchEq = (patch: Partial<EqConfig>) => {
    setEq(patch);
  };

  const resetFlat = () => {
    setEq({
      ...DEFAULT_EQ_CONFIG,
      enabled: eq.enabled,
      mode: eq.mode,
    });
  };

  const currentSleepValue = sleepAfterTrack
    ? 'track'
    : sleepTimerEndMs
      ? String(Math.max(15, Math.round((sleepTimerEndMs - Date.now()) / 60_000)))
      : 'off';

  return (
    <div className={settingsUi.centered}>
      <PageHeader title="Audio & Equalizer" />
      <div className={settingsUi.body}>
        <div className="flex items-center justify-between pr-2">
          <h2 className={settingsUi.sectionHeader}>Equalizer &amp; Frequency Response</h2>
          <span className="mt-5 type-caption-1 tabular-nums text-secondary">
            {eq.enabled
              ? `Active · Preamp ${curve.preampDb >= 0 ? `+${curve.preampDb.toFixed(1)}` : curve.preampDb.toFixed(1)} dB`
              : 'Bypassed (0.0 dB Flat)'}
          </span>
        </div>

        <section className={settingsUi.group}>
          <Toggle
            label="Enable Equalizer"
            detail={
              settings?.outputMode === 'wasapi_exclusive'
                ? 'Bypassed automatically during Bit-Exact exclusive output to keep PCM untouched.'
                : '10-slot parametric & shelf filter bank with automatic half-boost preamp and peak limiter.'
            }
            checked={eq.enabled}
            onChange={(enabled) => patchEq({ enabled })}
          />

          <label className={settingsUi.controlRow}>
            <span>Mode</span>
            <Select<'manual' | 'tone'>
              label="Equalizer Mode"
              value={eq.mode}
              options={[
                { value: 'manual', label: '7-Band Manual' },
                { value: 'tone', label: 'Tone Pad' },
              ]}
              onChange={(mode) => patchEq({ mode })}
            />
          </label>

          <div className="px-4 py-3 hairline-[16px]">
            <EqCurveSvg points={curve.points} eq={eq} />
          </div>

          {eq.mode === 'manual' ? (
            <>
              <div className={settingsUi.controlRow}>
                <span>Preset</span>
                <div className="flex items-center gap-2">
                  <Select<EqualizerPresetId>
                    label="Equalizer Preset"
                    value={eq.preset}
                    options={(Object.keys(PRESET_MAP) as EqualizerPresetId[]).map((id) => ({
                      value: id,
                      label: PRESET_MAP[id].label,
                    }))}
                    onChange={(preset) => {
                      const bands = PRESET_MAP[preset].bands;
                      patchEq({
                        enabled: true,
                        preset,
                        ...(bands ? { bandsDb: [...bands] as EqConfig['bandsDb'] } : {}),
                      });
                    }}
                  />
                  <button
                    type="button"
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

              <div className="grid grid-cols-7 gap-2 px-4 py-4 hairline-[16px]">
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
                        aria-label={`${label} band gain in dB`}
                        className="h-28 w-2 cursor-pointer accent-key [writing-mode:vertical-lr] [direction:rtl]"
                        onChange={(e) => {
                          const next = [...eq.bandsDb] as EqConfig['bandsDb'];
                          next[idx] = Number(e.currentTarget.value);
                          patchEq({ enabled: true, preset: 'custom', bandsDb: next });
                        }}
                      />
                      <span className="type-caption-2 text-secondary">{label}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <label className={settingsUi.controlRow}>
                <span>Warm / Bright Tilt ({eq.toneX > 0 ? `+${eq.toneX}` : eq.toneX})</span>
                <input
                  type="range"
                  min={-5}
                  max={5}
                  step={1}
                  value={eq.toneX}
                  aria-label="Warm or bright tilt"
                  className="w-44 cursor-pointer accent-key"
                  onChange={(e) => patchEq({ enabled: true, toneX: Number(e.currentTarget.value) })}
                />
              </label>
              <label className={settingsUi.controlRow}>
                <span>Mid Contour ({eq.toneY > 0 ? `+${eq.toneY}` : eq.toneY})</span>
                <input
                  type="range"
                  min={-5}
                  max={5}
                  step={1}
                  value={eq.toneY}
                  aria-label="Mid contour"
                  className="w-44 cursor-pointer accent-key"
                  onChange={(e) => patchEq({ enabled: true, toneY: Number(e.currentTarget.value) })}
                />
              </label>
              <Toggle
                label="Focused Bandwidth"
                detail="Narrows shelf and mid-band Q for targeted tone shaping."
                checked={eq.toneFocused}
                onChange={(toneFocused) => patchEq({ toneFocused })}
              />
            </>
          )}
        </section>

        <h2 className={settingsUi.sectionHeader}>Playback Control</h2>
        <section className={settingsUi.group}>
          <label className={settingsUi.controlRow}>
            <span>Playback Speed</span>
            <Select
              label="Playback Speed"
              value={playbackRate}
              options={SPEED_OPTIONS}
              onChange={(rate) => setPlaybackRate(rate)}
            />
          </label>
          <label className={settingsUi.controlRow}>
            <span className={settingsUi.rowText}>
              <span>Sleep Timer</span>
              {sleepTimerEndMs && (
                <span className={settingsUi.rowDetail}>
                  Stops at {new Date(sleepTimerEndMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              {sleepAfterTrack && <span className={settingsUi.rowDetail}>Will pause after this track finishes.</span>}
            </span>
            <Select
              label="Sleep Timer"
              value={SLEEP_OPTIONS.some((o) => o.value === currentSleepValue) ? currentSleepValue : '30'}
              options={SLEEP_OPTIONS}
              onChange={(val) => {
                if (val === 'off') setSleepTimer(null);
                else if (val === 'track') setSleepTimer('track');
                else setSleepTimer(Number(val));
              }}
            />
          </label>
        </section>

        <h2 className={settingsUi.sectionHeader}>Windows Audio Output</h2>
        {desktop && settings && snap ? (
          <>
            <section className={settingsUi.group}>
              <label className={settingsUi.controlRow}>
                <span className={settingsUi.rowText}>
                  <span>Output Mode</span>
                  <span className={settingsUi.rowDetail}>
                    WASAPI Exclusive bypasses the Windows mixer for local lossless files.
                  </span>
                </span>
                <Select<OutputMode>
                  label="Output Mode"
                  value={settings.outputMode}
                  options={[
                    { value: 'shared', label: 'WASAPI Shared' },
                    { value: 'wasapi_exclusive', label: 'WASAPI Exclusive (Bit-Perfect)' },
                    ...(snap.asioAvailable ? [{ value: 'asio' as const, label: 'ASIO Driver' }] : []),
                  ]}
                  onChange={(outputMode) => patchSettings({ outputMode })}
                />
              </label>

              <label className={settingsUi.controlRow}>
                <span className={settingsUi.rowText}>
                  <span>Output Device</span>
                  <span className={settingsUi.rowDetail}>
                    {devices.length ? `${devices.length} Windows audio endpoints detected` : 'System default output'}
                  </span>
                </span>
                <span className="inline-flex items-center gap-2">
                  <Select<string>
                    label="Output Device"
                    value={settings.deviceId ?? '__default__'}
                    options={[
                      { value: '__default__', label: 'Windows Default Device' },
                      ...devices.map((d) => ({
                        value: d.id,
                        label: `${d.name} (${d.backend})`,
                      })),
                    ]}
                    onChange={(v) => patchSettings({ deviceId: v === '__default__' ? null : v })}
                  />
                  <button
                    type="button"
                    className="grid size-7 cursor-pointer place-items-center rounded-[6px] bg-quaternary text-secondary hover:text-primary"
                    aria-label="Refresh audio devices"
                    onClick={() => void devicesQuery.refetch()}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                  </button>
                </span>
              </label>

              <div className={settingsUi.row}>
                <span className={settingsUi.rowText}>
                  <span>Hardware Path Status</span>
                  <span className={settingsUi.rowDetail}>
                    {snap.bitPerfect.active
                      ? snap.bitPerfect.exact
                        ? `Bit-exact via ${snap.bitPerfect.driver} (${snap.bitPerfect.sampleRateHz / 1000} kHz / ${snap.bitPerfect.outputBits}-bit)`
                        : `DAC format converted with TPDF dither (${snap.bitPerfect.sampleRateHz / 1000} kHz / ${snap.bitPerfect.outputBits}-bit; not bit-perfect)`
                      : snap.bitPerfect.fallbackReason
                        ? `Fallback to shared output: ${snap.bitPerfect.fallbackReason}`
                        : 'WASAPI Shared + Web Audio Biquad DSP active'}
                  </span>
                </span>
                <span className="type-callout-emphasized text-secondary">
                  {snap.bitPerfect.active ? (snap.bitPerfect.exact ? 'Bit-Exact' : 'Converted') : 'Shared'}
                </span>
              </div>
            </section>
            {!snap.asioAvailable && (
              <p className={settingsUi.footer}>
                ASIO output requires compiling with the Steinberg ASIO SDK (--features asio). WASAPI Exclusive handles class-compliant USB DACs and DoP streams directly.
              </p>
            )}
          </>
        ) : (
          <section className={settingsUi.group}>
            <div className={settingsUi.row}>
              <span className={settingsUi.rowText}>
                <span>Active Audio Engine</span>
                <span className={settingsUi.rowDetail}>
                  Web Audio API 10-slot BiquadFilter bank + Peak Limiter (WASAPI hardware device selection is active in the Windows Desktop app).
                </span>
              </span>
              <span className="type-callout-emphasized text-secondary">Web Audio DSP</span>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
