import {
  AudioLines,
  ChevronRight,
  Cpu,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Speaker,
  Usb,
  Volume2,
  VolumeX,
  Waves,
} from 'lucide-react';
import { useState } from 'react';
import { PillRangeSlider } from '@/components/PillRangeSlider';
import { PrefetchLink } from '@/components/PrefetchLink';
import { Select } from '@/components/Select';
import { SubpageHeader } from '@/components/SubpageHeader';
import {
  BitPerfectConfirmBanner,
  BIT_PERFECT_BYPASSED_FOOTER,
  bypassedRowClasses,
} from '@/desktop/BitPerfectBypass';
import { isExclusiveOutputMode } from '@/desktop/bitPerfectMode';
import {
  isTauriDesktop,
  type AudioSettings,
  type OutputMode,
} from '@/desktop/tauriBridge';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { useBitPerfectUi } from '@/desktop/useBitPerfectUi';
import { refreshDesktopAudioState, useDesktopAudioDevices } from '@/desktop/useDesktopAudioDevices';
import { AUTOMIX_BARS } from '@/playback/automix/choices';
import {
  usePlayer,
  type AutomixPerformance,
  type OutputPrecision,
} from '@/state/player';
import { useUi } from '@/state/ui';
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

export default function PlaybackSettingsPage() {
  const desktop = isTauriDesktop();
  const pipeline = useAudioPipeline();
  const setPipelineOpen = useUi((s) => s.setAudioPipelineOpen);

  const outputPrecision = usePlayer((s) => s.outputPrecision);
  const preferUsbDac = usePlayer((s) => s.preferUsbDac);
  const loudnessNormalization = usePlayer((s) => s.loudnessNormalization);
  const crossfadeSec = usePlayer((s) => s.crossfadeSec);
  const automix = usePlayer((s) => s.automix);
  const automixBars = usePlayer((s) => s.automixBars);
  const automixPerformance = usePlayer((s) => s.automixPerformance);
  const skipSilence = usePlayer((s) => s.skipSilence);
  const spatialAudio = usePlayer((s) => s.spatialAudio);
  const autoplay = usePlayer((s) => s.autoplay);
  const playbackRate = usePlayer((s) => s.playbackRate);
  const sleepTimerEndMs = usePlayer((s) => s.sleepTimerEndMs);
  const sleepAfterTrack = usePlayer((s) => s.sleepAfterTrack);
  const eq = usePlayer((s) => s.eq);

  const {
    setOutputPrecision,
    setPreferUsbDac,
    setLoudnessNormalization,
    setCrossfade,
    setAutomix,
    setAutomixBars,
    setAutomixPerformance,
    setSkipSilence,
    setSpatialAudio,
    setAutoplay,
    setPlaybackRate,
    setSleepTimer,
  } = usePlayer.getState();

  const { devicesQuery, snapQuery, updateAudio: saveNative, refresh } = useDesktopAudioDevices({
    enabled: desktop,
    live: true,
  });
  const { lockDspFeatures } = useBitPerfectUi();
  const [pendingOutputMode, setPendingOutputMode] = useState<OutputMode | null>(null);

  const snap = snapQuery.data;
  const settings = snap?.settings;
  const devices = devicesQuery.data ?? [];
  const dspLocked =
    lockDspFeatures || (desktop && isExclusiveOutputMode(settings?.outputMode));

  const patchNative = (patch: Partial<AudioSettings>) => {
    if (!settings) return;
    saveNative.mutate({ ...settings, ...patch, eq });
  };

  const currentSleepValue = sleepAfterTrack
    ? 'track'
    : sleepTimerEndMs
      ? String(Math.max(15, Math.round((sleepTimerEndMs - Date.now()) / 60_000)))
      : 'off';

  return (
    <div className={settingsUi.centered}>
      <SubpageHeader title="Playback" backTo="/settings" />
      <div className={settingsUi.body}>
        <section className={settingsUi.group} aria-label="Audio output and precision">
          {/* Output precision segmented pill matching Screenshot 3 */}
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-start gap-3.5">
              <span className={`${settingsUi.iconPlain} mt-0.5`}>
                <AudioLines size={20} strokeWidth={2} aria-hidden="true" />
              </span>
              <div className={settingsUi.rowText}>
                <span className="type-title-3 text-primary">Output precision</span>
                <span className="type-callout text-secondary tabular-nums">
                  {desktop ? 'WASAPI' : 'Web Audio'} · {pipeline.activeDeviceName} · {pipeline.shortSubtitle}
                </span>
              </div>
            </div>

            <div
              role="radiogroup"
              aria-label="Output precision"
              className="grid grid-cols-2 gap-1 rounded-pill bg-segmented p-1"
            >
              {(
                [
                  { id: 'pcm16', label: '16-bit PCM' },
                  { id: 'float32', label: '32-bit float' },
                ] as { id: OutputPrecision; label: string }[]
              ).map((opt) => {
                const active = outputPrecision === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setOutputPrecision(opt.id)}
                    className={`rounded-pill px-3 py-2 text-center type-callout-emphasized transition-colors ${
                      active
                        ? 'bg-segmented-selected text-primary shadow-xs'
                        : 'text-secondary hover:text-primary'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative hairline-[16px]">
            <Toggle
              label="Prefer USB DAC"
              detail="Automatically prioritize connected external USB DACs when available."
              checked={preferUsbDac}
              onChange={(checked) => {
                setPreferUsbDac(checked);
                if (checked) {
                  void refreshDesktopAudioState(true);
                }
              }}
            />
          </div>

          {/* Bit-perfect & Windows device controls */}
          {desktop && settings && snap ? (
            <>
              <label className={settingsUi.controlRow}>
                <span className="flex min-w-0 flex-1 items-start gap-3.5">
                  <span className={`${settingsUi.iconPlain} mt-0.5`}>
                    <Usb size={19} strokeWidth={2} aria-hidden="true" />
                  </span>
                  <span className={settingsUi.rowText}>
                    <span>Bit-perfect output</span>
                    <span className={settingsUi.rowDetail}>
                      {snap.bitPerfect.active
                        ? snap.tapActive
                          ? `Active via ${snap.bitPerfect.driver} (${snap.bitPerfect.sampleRateHz / 1000} kHz / ${snap.bitPerfect.outputBits}-bit)`
                          : snap.bitPerfect.exact
                            ? `Bit-exact via ${snap.bitPerfect.driver} (${snap.bitPerfect.sampleRateHz / 1000} kHz / ${snap.bitPerfect.outputBits}-bit)`
                            : `DAC ceiling converted with TPDF dither (${snap.bitPerfect.sampleRateHz / 1000} kHz)`
                        : 'WASAPI Exclusive bypasses the Windows mixer when supported'}
                    </span>
                  </span>
                </span>
                <Select<OutputMode>
                  label="Output Mode"
                  value={settings.outputMode}
                  options={[
                    { value: 'shared', label: 'WASAPI Shared' },
                    { value: 'wasapi_exclusive', label: 'WASAPI Exclusive' },
                    ...(snap.asioAvailable ? [{ value: 'asio' as const, label: 'ASIO Driver' }] : []),
                  ]}
                  onChange={(outputMode) => {
                    if (outputMode === 'shared') {
                      setPendingOutputMode(null);
                      patchNative({ outputMode });
                    } else if (outputMode !== settings.outputMode) {
                      setPendingOutputMode(outputMode);
                    }
                  }}
                />
              </label>

              {pendingOutputMode && (
                <BitPerfectConfirmBanner
                  variant="page"
                  onCancel={() => setPendingOutputMode(null)}
                  onConfirm={() => {
                    patchNative({ outputMode: pendingOutputMode });
                    setPendingOutputMode(null);
                  }}
                />
              )}

              <label className={settingsUi.controlRow}>
                <span className={settingsUi.rowText}>
                  <span>Output device</span>
                  <span className={settingsUi.rowDetail}>
                    {devices.length ? `${devices.length} Windows audio endpoints detected` : 'System default device'}
                  </span>
                </span>
                <span className="inline-flex items-center gap-2">
                  <Select<string>
                    label="Output device"
                    value={settings.deviceId ?? '__default__'}
                    options={[
                      { value: '__default__', label: 'Windows Default' },
                      ...devices.map((d) => ({
                        value: d.id,
                        label: `${d.name} (${d.backend})`,
                      })),
                    ]}
                    onChange={(v) => patchNative({ deviceId: v === '__default__' ? null : v })}
                  />
                  <button
                    type="button"
                    className="grid size-8 place-items-center rounded-full bg-quaternary text-secondary hover:text-primary"
                    aria-label="Refresh audio devices"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                  </button>
                </span>
              </label>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPipelineOpen(true)}
              className={`${settingsUi.integration} ${settingsUi.linkRow}`}
            >
              <span className={settingsUi.iconPlain}>
                <Usb size={19} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={settingsUi.rowText}>
                <span className="type-title-3 text-primary">Bit-perfect &amp; Signal Path</span>
                <span className={settingsUi.rowDetail}>
                  Web Audio DSP active ({pipeline.shortSubtitle}). Inspect full Audio Pipeline.
                </span>
              </span>
              <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
            </button>
          )}

          {/* Loudness normalization */}
          <label
            className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3.5">
              <span className={settingsUi.iconPlain}>
                <Volume2 size={20} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={settingsUi.rowText}>
                <span>Loudness normalization</span>
                <span className={settingsUi.rowDetail}>Levels every track to the same loudness</span>
              </span>
            </span>
            <input
              type="checkbox"
              className={settingsUi.switch}
              checked={loudnessNormalization}
              disabled={dspLocked}
              onChange={(e) => {
                if (!dspLocked) setLoudnessNormalization(e.currentTarget.checked);
              }}
            />
          </label>

          {/* Crossfade thick pill slider matching Screenshot 3 & 4 */}
          <div
            className={`relative flex flex-col gap-3 px-4 py-4 hairline-[16px] ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className={settingsUi.iconPlain}>
                  <Waves size={20} strokeWidth={2} aria-hidden="true" />
                </span>
                <div className={settingsUi.rowText}>
                  <span className="type-title-3 text-primary">Crossfade</span>
                  <span className={settingsUi.rowDetail}>Blends one track into the next</span>
                </div>
              </div>
              <span className="type-body-reduced tabular-nums text-secondary">
                {dspLocked ? 'Off (Bit-Perfect)' : automix ? 'Automix' : crossfadeSec === 0 ? 'Off' : `${crossfadeSec}s`}
              </span>
            </div>
            <div className="pl-10">
              <PillRangeSlider
                value={dspLocked || automix ? 0 : crossfadeSec}
                max={12}
                disabled={dspLocked}
                ariaLabel="Crossfade duration in seconds"
                onChange={(sec) => {
                  if (!dspLocked) setCrossfade(sec);
                }}
              />
            </div>
          </div>

          {/* Automix */}
          <label
            className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <span className="flex min-w-0 flex-1 items-start gap-3.5">
              <span className={`${settingsUi.iconPlain} mt-0.5`}>
                <Sparkles size={19} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={settingsUi.rowText}>
                <span>Automix</span>
                <span className={settingsUi.rowDetail}>
                  Times and blends transitions automatically on the beat, without a slider.
                </span>
              </span>
            </span>
            <input
              type="checkbox"
              className={settingsUi.switch}
              checked={automix}
              disabled={dspLocked}
              onChange={(e) => {
                if (!dspLocked) setAutomix(e.currentTarget.checked);
              }}
            />
          </label>

          {/* Automix performance & bars */}
          <label
            className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3.5">
              <span className={settingsUi.iconPlain}>
                <Cpu size={19} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={settingsUi.rowText}>
                <span>Automix performance</span>
                <span className={settingsUi.rowDetail}>Sets how much CPU background analysis may use</span>
              </span>
            </span>
            <Select<AutomixPerformance>
              label="Automix performance"
              value={automixPerformance}
              disabled={dspLocked}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'high', label: 'High' },
              ]}
              onChange={setAutomixPerformance}
            />
          </label>

          {automix && (
            <label
              className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
              aria-disabled={dspLocked || undefined}
            >
              <span className="pl-10">Blend length</span>
              <Select<number>
                label="Blend length"
                value={automixBars}
                disabled={dspLocked}
                options={AUTOMIX_BARS.map((b) => ({ value: b, label: `Up to ${b} bars` }))}
                onChange={setAutomixBars}
              />
            </label>
          )}

          {/* Skip silence */}
          <label
            className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3.5">
              <span className={settingsUi.iconPlain}>
                <VolumeX size={19} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={settingsUi.rowText}>
                <span>Skip silence</span>
                <span className={settingsUi.rowDetail}>Trim gaps longer than a second</span>
              </span>
            </span>
            <input
              type="checkbox"
              className={settingsUi.switch}
              checked={skipSilence}
              disabled={dspLocked}
              onChange={(e) => {
                if (!dspLocked) setSkipSilence(e.currentTarget.checked);
              }}
            />
          </label>

          {/* Spatial audio */}
          <label
            className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3.5">
              <span className={settingsUi.iconPlain}>
                <Speaker size={19} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={settingsUi.rowText}>
                <span>Spatial audio</span>
                <span className={settingsUi.rowDetail}>Widens stereo tracks for a more immersive feel</span>
              </span>
            </span>
            <input
              type="checkbox"
              className={settingsUi.switch}
              checked={spatialAudio}
              disabled={dspLocked}
              onChange={(e) => {
                if (!dspLocked) setSpatialAudio(e.currentTarget.checked);
              }}
            />
          </label>

          {/* Equalizer subpage link */}
          <PrefetchLink
            to="/settings/audio"
            aria-disabled={dspLocked || undefined}
            tabIndex={dspLocked ? -1 : undefined}
            onClick={(e) => {
              if (dspLocked) e.preventDefault();
            }}
            className={`${settingsUi.integration} ${settingsUi.linkRow} ${bypassedRowClasses(dspLocked)}`}
          >
            <span className={settingsUi.iconPlain}>
              <SlidersHorizontal size={19} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Equalizer</span>
              <span className={settingsUi.rowDetail}>
                {dspLocked ? 'Bypassed while Bit-Perfect mode is on' : 'Tone, seven bands and balance'}
              </span>
            </span>
            <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
          </PrefetchLink>
        </section>

        {dspLocked && <p className={settingsUi.footer}>{BIT_PERFECT_BYPASSED_FOOTER}</p>}

        <h2 className={settingsUi.sectionHeader}>Queue, Speed &amp; Timer</h2>
        <section className={settingsUi.group}>
          <Toggle
            label="AutoPlay"
            detail="When the queue ends, keep playing similar music."
            checked={autoplay}
            onChange={setAutoplay}
          />
          <label
            className={`${settingsUi.controlRow} ${bypassedRowClasses(dspLocked)}`}
            aria-disabled={dspLocked || undefined}
          >
            <span className={settingsUi.rowText}>
              <span>Playback speed</span>
              {dspLocked && (
                <span className={settingsUi.rowDetail}>Locked at 1x while Bit-Perfect mode is on</span>
              )}
            </span>
            <Select
              label="Playback speed"
              value={dspLocked ? 1 : playbackRate}
              disabled={dspLocked}
              options={SPEED_OPTIONS}
              onChange={(rate) => {
                if (!dspLocked) setPlaybackRate(rate);
              }}
            />
          </label>
          <label className={settingsUi.controlRow}>
            <span className={settingsUi.rowText}>
              <span>Sleep timer</span>
              {sleepTimerEndMs && (
                <span className={settingsUi.rowDetail}>
                  Stops at {new Date(sleepTimerEndMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              {sleepAfterTrack && <span className={settingsUi.rowDetail}>Will pause after this track finishes.</span>}
            </span>
            <Select
              label="Sleep timer"
              value={SLEEP_OPTIONS.some((o) => o.value === currentSleepValue) ? currentSleepValue : '30'}
              options={SLEEP_OPTIONS}
              onChange={(val) => {
                if (val === 'off') setSleepTimer(null);
                else if (val === 'track') setSleepTimer('track');
                else setSleepTimer(Number(val));
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => setPipelineOpen(true)}
            className={`${settingsUi.integrationPlain} ${settingsUi.linkRow}`}
          >
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Inspect Live Audio Pipeline</span>
              <span className={settingsUi.rowDetail}>View decoder, resampler, DSP, and output signal path</span>
            </span>
            <span className={settingsUi.value}>
              <span className="tabular-nums">{pipeline.shortSubtitle}</span>
              <ChevronRight size={17} aria-hidden="true" />
            </span>
          </button>
        </section>
      </div>
    </div>
  );
}
