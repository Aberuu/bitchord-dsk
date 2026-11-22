import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
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
import { usePlayer } from '@/state/player';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

const BAND_LABELS = ['60 Hz', '150 Hz', '400 Hz', '1 kHz', '2.5 kHz', '6 kHz', '14 kHz'] as const;

const PRESET_MAP: Record<EqualizerPresetId, { label: string; bands: [number, number, number, number, number, number, number] | null }> = {
  flat: { label: 'Flat', bands: [0, 0, 0, 0, 0, 0, 0] },
  acoustic: { label: 'Acoustic', bands: [3, 1.5, 0, 1.5, 2.5, 2, 1] },
  bass_boost: { label: 'Bass Boost', bands: [6, 4, 1.5, 0, 0, 0, 0] },
  bass_cut: { label: 'Bass Cut', bands: [-6, -4, -1.5, 0, 0, 0, 0] },
  vocal: { label: 'Vocal', bands: [-3, -1.5, 1, 3.5, 3, 1, -1] },
  treble_boost: { label: 'Treble Boost', bands: [0, 0, 0, 0, 1.5, 3.5, 5] },
  treble_cut: { label: 'Treble Cut', bands: [0, 0, 0, 0, -1.5, -3.5, -5] },
  loudness: { label: 'Loudness', bands: [6, 3.5, 0, -1.5, -1, 2, 5] },
  spoken_word: { label: 'Spoken Word', bands: [-5, -2.5, 1.5, 4, 3.5, 1.5, -2] },
  electronic: { label: 'Electronic', bands: [5, 3, -1, 0, 1, 3, 4] },
  rock: { label: 'Rock', bands: [4, 2.5, -1, -1.5, 1, 3, 3.5] },
  hip_hop: { label: 'Hip Hop', bands: [6, 4, 0.5, -1, 0.5, 2, 2.5] },
  jazz: { label: 'Jazz', bands: [3, 1.5, 0, 1, 1.5, 2, 2.5] },
  classical: { label: 'Classical', bands: [3, 2, 0, 0, 1, 2.5, 3] },
  small_speakers: { label: 'Small Speakers', bands: [5, 4, 2, 0.5, 0, -1, -2] },
  late_night: { label: 'Late Night', bands: [3, 1, 0, 1.5, 1, -1, -3] },
  custom: { label: 'Custom', bands: null },
};

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

function EqCurveSvg({ points }: { points: [number, number][] }) {
  const path = useMemo(() => {
    if (!points.length) return 'M 0 60 L 400 60';
    return points
      .map(([hz, db], i) => {
        const x = (Math.log10(Math.max(20, hz) / 20) / Math.log10(1000)) * 400;
        const y = 60 - Math.max(-14, Math.min(14, db)) * (48 / 14);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points]);

  return (
    <svg viewBox="0 0 400 120" className="h-[110px] w-full rounded-[8px] bg-page/60" role="img" aria-label="Equalizer frequency response curve">
      <line x1="0" y1="60" x2="400" y2="60" stroke="var(--labelDivider)" strokeWidth="1" />
      <line x1="0" y1="26" x2="400" y2="26" stroke="var(--labelDivider)" strokeWidth="0.5" strokeDasharray="3 3" />
      <line x1="0" y1="94" x2="400" y2="94" stroke="var(--labelDivider)" strokeWidth="0.5" strokeDasharray="3 3" />
      <path d={path} fill="none" stroke="var(--keyColor)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function AudioEqPage() {
  const desktop = isTauriDesktop();
  const playbackRate = usePlayer((s) => s.playbackRate);
  const sleepTimerEndMs = usePlayer((s) => s.sleepTimerEndMs);
  const sleepAfterTrack = usePlayer((s) => s.sleepAfterTrack);
  const { setPlaybackRate, setSleepTimer } = usePlayer.getState();

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
    save.mutate({ ...settings, ...patch });
  };

  const patchEq = (patch: Partial<AudioSettings['eq']>) => {
    if (!settings) return;
    save.mutate({ ...settings, eq: { ...settings.eq, ...patch } });
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

        {!desktop && (
          <p className={settingsUi.footer}>
            WASAPI Shared/Exclusive output routing, DAC format diagnostics, and the native 7-band Parametric &amp; Tone Equalizer activate when running BitChord Desktop via Tauri.
          </p>
        )}

        {desktop && snapQuery.isPending && (
          <section className={`${settingsUi.group} mt-6 p-4`} aria-busy="true">
            <p className="type-body text-secondary">Inspecting Windows audio output devices…</p>
          </section>
        )}

        {desktop && snapQuery.isError && (
          <section className={`${settingsUi.group} mt-6 flex items-center justify-between gap-3 p-4`}>
            <p className="type-callout text-red">Could not read audio engine state: {String(snapQuery.error)}</p>
            <button type="button" className={settingsUi.inlineButton} onClick={() => void snapQuery.refetch()}>
              Retry
            </button>
          </section>
        )}

        {desktop && settings && snap && (
          <>
            <h2 className={settingsUi.sectionHeader}>Windows Audio Output</h2>
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
                        : 'Inactive until local lossless audio plays in Exclusive mode'}
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

            <h2 className={settingsUi.sectionHeader}>Equalizer</h2>
            <section className={settingsUi.group}>
              <Toggle
                label="Enable Equalizer"
                detail={
                  settings.outputMode === 'wasapi_exclusive'
                    ? 'Bypassed automatically during Bit-Exact exclusive output to keep PCM untouched.'
                    : '10-slot filter bank with automatic half-boost preamp and stereo peak limiter.'
                }
                checked={settings.eq.enabled}
                onChange={(enabled) => patchEq({ enabled })}
              />

              <label className={settingsUi.controlRow}>
                <span>Mode</span>
                <Select<'manual' | 'tone'>
                  label="Equalizer Mode"
                  value={settings.eq.mode}
                  options={[
                    { value: 'manual', label: '7-Band Manual' },
                    { value: 'tone', label: 'Tone Pad' },
                  ]}
                  onChange={(mode) => patchEq({ mode })}
                />
              </label>

              <div className="px-4 py-3 hairline-[16px]">
                <EqCurveSvg points={snap.eqCurvePoints} />
              </div>

              {settings.eq.mode === 'manual' ? (
                <>
                  <label className={settingsUi.controlRow}>
                    <span>Preset</span>
                    <Select<EqualizerPresetId>
                      label="Equalizer Preset"
                      value={settings.eq.preset}
                      options={(Object.keys(PRESET_MAP) as EqualizerPresetId[]).map((id) => ({
                        value: id,
                        label: PRESET_MAP[id].label,
                      }))}
                      onChange={(preset) => {
                        const bands = PRESET_MAP[preset].bands;
                        patchEq({
                          preset,
                          ...(bands ? { bandsDb: [...bands] as AudioSettings['eq']['bandsDb'] } : {}),
                        });
                      }}
                    />
                  </label>
                  <div className="grid grid-cols-7 gap-2 px-4 py-4 hairline-[16px]">
                    {BAND_LABELS.map((label, idx) => {
                      const val = settings.eq.bandsDb[idx] ?? 0;
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
                              const next = [...settings.eq.bandsDb] as AudioSettings['eq']['bandsDb'];
                              next[idx] = Number(e.currentTarget.value);
                              patchEq({ preset: 'custom', bandsDb: next });
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
                    <span>Warm / Bright Tilt ({settings.eq.toneX})</span>
                    <input
                      type="range"
                      min={-5}
                      max={5}
                      step={1}
                      value={settings.eq.toneX}
                      className="w-44 cursor-pointer accent-key"
                      onChange={(e) => patchEq({ toneX: Number(e.currentTarget.value) })}
                    />
                  </label>
                  <label className={settingsUi.controlRow}>
                    <span>Mid Contour ({settings.eq.toneY})</span>
                    <input
                      type="range"
                      min={-5}
                      max={5}
                      step={1}
                      value={settings.eq.toneY}
                      className="w-44 cursor-pointer accent-key"
                      onChange={(e) => patchEq({ toneY: Number(e.currentTarget.value) })}
                    />
                  </label>
                  <Toggle
                    label="Focused Bandwidth"
                    detail="Narrows shelf and mid-band Q for targeted tone shaping."
                    checked={settings.eq.toneFocused}
                    onChange={(toneFocused) => patchEq({ toneFocused })}
                  />
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
