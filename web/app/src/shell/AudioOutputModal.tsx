import {
  AudioLines,
  Bluetooth,
  Cast,
  Check,
  ChevronRight,
  ExternalLink,
  Headphones,
  MonitorSpeaker,
  RefreshCw,
  Speaker,
  Usb,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BitPerfectConfirmBanner } from '@/desktop/BitPerfectBypass';
import { isExclusiveOutputMode } from '@/desktop/bitPerfectMode';
import { desktopApi, type AudioDeviceKind, type OutputMode } from '@/desktop/tauriBridge';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { useCastSession, useCastSupport } from '@/desktop/useCastSupport';
import { useDesktopAudioDevices } from '@/desktop/useDesktopAudioDevices';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

function OutputDeviceIcon({ kind }: { kind: AudioDeviceKind }) {
  switch (kind) {
    case 'headphones':
      return <Headphones size={18} aria-hidden="true" />;
    case 'usb_dac':
      return <Usb size={18} aria-hidden="true" />;
    case 'bluetooth':
      return <Bluetooth size={18} aria-hidden="true" />;
    case 'hdmi':
      return <MonitorSpeaker size={18} aria-hidden="true" />;
    default:
      return <Speaker size={18} aria-hidden="true" />;
  }
}

export function AudioOutputModal() {
  const open = useUi((s) => s.audioOutputOpen);
  if (!open) return null;
  return <AudioOutputModalContent />;
}

function AudioOutputModalContent() {
  const setOpen = useUi((s) => s.setAudioOutputOpen);
  const setPipelineOpen = useUi((s) => s.setAudioPipelineOpen);
  const setCastModalOpen = useUi((s) => s.setCastModalOpen);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const { setVolume, toggleMute } = usePlayer.getState();
  const pipeline = useAudioPipeline();
  const castSupport = useCastSupport();
  const castSession = useCastSession();
  const { desktop, devicesQuery, snapQuery, updateAudio, refresh } = useDesktopAudioDevices({
    enabled: true,
    live: true,
  });
  const dialogRef = useRef<HTMLDivElement>(null);
  const [confirmExclusiveOpen, setConfirmExclusiveOpen] = useState(false);
  const [asioPanelError, setAsioPanelError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (confirmExclusiveOpen) {
          setConfirmExclusiveOpen(false);
        } else {
          setOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setOpen, confirmExclusiveOpen]);

  const snap = snapQuery.data;
  const settings = snap?.settings;
  const devices = devicesQuery.data ?? [];
  const defaultDevice = devices.find((d) => d.isDefault) ?? null;
  const activeDeviceId = settings?.deviceId ?? null;
  const activeMode: OutputMode = settings?.outputMode ?? 'shared';
  const fallbackReason = snap?.bitPerfect.fallbackReason ?? null;
  const bitPerfectActive = desktop && snap?.bitPerfect.active === true;
  const bitPerfectExact = bitPerfectActive && snap?.bitPerfect.exact === true;

  const selectDevice = (deviceId: string | null) => {
    if (!settings || deviceId === activeDeviceId) return;
    setAsioPanelError(null);
    if (deviceId?.startsWith('asio:')) {
      updateAudio.mutate({ ...settings, deviceId, outputMode: 'asio' });
      return;
    }
    if (activeMode === 'asio') {
      updateAudio.mutate({ ...settings, deviceId, outputMode: 'shared' });
      return;
    }
    updateAudio.mutate({ ...settings, deviceId });
  };

  const toggleExclusive = () => {
    if (!settings) return;
    if (isExclusiveOutputMode(activeMode)) {
      setConfirmExclusiveOpen(false);
      const resetDeviceId = activeDeviceId?.startsWith('asio:') ? null : activeDeviceId;
      updateAudio.mutate({ ...settings, deviceId: resetDeviceId, outputMode: 'shared' });
      return;
    }
    setConfirmExclusiveOpen((open) => !open);
  };

  const confirmEnableExclusive = () => {
    if (!settings) return;
    setConfirmExclusiveOpen(false);
    updateAudio.mutate({ ...settings, outputMode: 'wasapi_exclusive' });
  };

  const openAsioControlPanel = async () => {
    setAsioPanelError(null);
    try {
      await desktopApi.audioOpenAsioControlPanel(activeDeviceId);
    } catch (err) {
      setAsioPanelError(err instanceof Error ? err.message : String(err));
    }
  };

  const level = muted ? 0 : volume;
  const displayLevel = bitPerfectActive ? 1 : level;
  const refreshing = devicesQuery.isFetching || snapQuery.isFetching;
  const showCastRow = desktop || castSupport.supported;

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)-1)] flex items-end justify-center bg-black/45 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-output-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-[min(420px,95vw)] overflow-hidden rounded-[24px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) p-4 text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] outline-none backdrop-blur-2xl animate-zoom"
        style={{ backdropFilter: 'saturate(200%) blur(28px)' }}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-secondary/35 sm:hidden" aria-hidden="true" />
        <div className="mb-3.5 flex items-center justify-between px-1">
          <h2 id="audio-output-title" className="type-[700_18px/22px] text-primary">
            Audio output
          </h2>
          <div className="flex items-center gap-1.5">
            {desktop && (
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label="Refresh audio devices"
                title="Refresh audio devices"
                className="grid size-8 place-items-center rounded-full bg-primary/8 text-secondary transition-colors hover:bg-primary/14 hover:text-primary"
              >
                <RefreshCw
                  size={14}
                  className={refreshing ? 'motion-safe:animate-spin' : undefined}
                  aria-hidden="true"
                />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close audio output"
              className="grid size-8 place-items-center rounded-full bg-primary/8 text-secondary transition-colors hover:bg-primary/14 hover:text-primary"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="-m-1 flex max-h-[220px] flex-col gap-2 overflow-y-auto p-1 scrollbar-compact">
            <button
              type="button"
              onClick={() => selectDevice(null)}
              className={`flex w-full items-center gap-3.5 rounded-[16px] px-3.5 py-3 text-start transition-colors ${
                activeDeviceId === null ? 'bg-primary/12' : 'bg-primary/6 hover:bg-primary/10'
              }`}
            >
              <span className="grid size-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                <MonitorSpeaker size={18} aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate type-title-3-emphasized text-primary">
                  {desktop ? 'This PC (Default Output)' : 'This PC'}
                </span>
                <span className="truncate type-callout text-secondary">
                  {defaultDevice
                    ? activeDeviceId === null
                      ? `Playing via ${defaultDevice.name}`
                      : `Windows default · ${defaultDevice.name}`
                    : activeDeviceId === null
                      ? 'Playing here'
                      : 'Windows system default'}
                </span>
              </span>
              {activeDeviceId === null && (
                <Check size={18} strokeWidth={2.4} className="flex-none text-primary" aria-hidden="true" />
              )}
            </button>

            {devices.map((dev) => {
              const selected = activeDeviceId === dev.id;
              return (
                <button
                  key={dev.id}
                  type="button"
                  onClick={() => selectDevice(dev.id)}
                  className={`flex w-full items-center gap-3.5 rounded-[16px] px-3.5 py-3 text-start transition-colors ${
                    selected ? 'bg-primary/12' : 'bg-primary/6 hover:bg-primary/10'
                  }`}
                >
                  <span className="grid size-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                    <OutputDeviceIcon kind={dev.kind} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate type-title-3-emphasized text-primary">{dev.name}</span>
                    <span className="truncate type-callout text-secondary">
                      {dev.isUsbDac ? 'USB DAC · ' : ''}
                      {dev.backend} · up to {Math.round(dev.maxSampleRateHz / 1000)} kHz
                    </span>
                  </span>
                  {selected && (
                    <Check size={18} strokeWidth={2.4} className="flex-none text-primary" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          {showCastRow && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCastModalOpen(true);
              }}
              className="flex w-full items-center gap-3.5 rounded-[16px] bg-primary/6 px-3.5 py-3 text-start transition-colors hover:bg-primary/10"
            >
              <span className="grid size-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                <Cast size={18} aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="type-title-3-emphasized text-primary">Cast</span>
                <span className="truncate type-callout text-secondary">
                  {castSession.connected && castSession.device
                    ? `Casting to ${castSession.device.name}`
                    : 'Chromecast and Google Cast speakers'}
                </span>
              </span>
              <ChevronRight size={18} className="flex-none text-secondary" aria-hidden="true" />
            </button>
          )}

          {desktop && settings && (
            <>
              <button
                type="button"
                onClick={toggleExclusive}
                aria-expanded={confirmExclusiveOpen}
                className="flex w-full items-center justify-between gap-3 rounded-[16px] bg-primary/6 px-3.5 py-3 text-start transition-colors hover:bg-primary/10"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="type-body-emphasized text-primary">
                    {activeMode === 'asio' ? 'ASIO Native (Bit-Perfect)' : 'WASAPI Exclusive (Bit-Perfect)'}
                  </span>
                  <span className="truncate type-callout text-secondary">
                    {fallbackReason
                      ? fallbackReason
                      : bitPerfectActive
                        ? bitPerfectExact
                          ? snap.asioNativeDsd
                            ? `Native DSD · ${(snap.bitPerfect.sampleRateHz / 1_000_000).toFixed(2)} MHz`
                            : `Bit-exact · ${(snap.bitPerfect.sampleRateHz / 1000).toFixed(1).replace(/\.0$/, '')} kHz / ${snap.bitPerfect.outputBits}-bit`
                          : `Active (${snap.bitPerfect.driver ?? 'WASAPI Exclusive'} · ${(snap.bitPerfect.sampleRateHz / 1000).toFixed(1).replace(/\.0$/, '')} kHz / ${snap.bitPerfect.outputBits}-bit)`
                        : isExclusiveOutputMode(activeMode)
                          ? 'Armed for active playback on compatible DACs'
                          : 'Bypass Windows mixer on compatible DACs'}
                  </span>
                </span>
                <span
                  className={`rounded-pill px-2.5 py-1 type-caption-2 uppercase ${
                    isExclusiveOutputMode(activeMode)
                      ? 'bg-green/20 text-green'
                      : 'bg-primary/10 text-secondary'
                  }`}
                >
                  {bitPerfectExact ? 'Exact' : isExclusiveOutputMode(activeMode) ? 'On' : 'Off'}
                </span>
              </button>

              {activeMode === 'asio' && (
                <button
                  type="button"
                  onClick={() => void openAsioControlPanel()}
                  className="flex w-full items-center justify-between gap-3 rounded-[16px] bg-primary/6 px-3.5 py-2.5 text-start transition-colors hover:bg-primary/10"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="type-callout-emphasized text-primary">ASIO Control Panel</span>
                    <span className="truncate type-caption-1 text-secondary">
                      {asioPanelError ??
                        (snap.asioBufferSamples
                          ? `${snap.asioBufferSamples} samples · ${snap.asioSampleType ?? 'Native ASIO'}`
                          : 'Configure DAC buffer size and clock source')}
                    </span>
                  </span>
                  <ExternalLink size={15} className="flex-none text-secondary" aria-hidden="true" />
                </button>
              )}

              {confirmExclusiveOpen && (
                <BitPerfectConfirmBanner
                  variant="modal"
                  onConfirm={confirmEnableExclusive}
                  onCancel={() => setConfirmExclusiveOpen(false)}
                />
              )}
            </>
          )}

          <div
            className={`flex items-center gap-3 rounded-[16px] bg-primary/6 px-3.5 py-3.5 ${
              bitPerfectActive ? 'opacity-45' : ''
            }`}
            aria-disabled={bitPerfectActive || undefined}
          >
            <button
              type="button"
              disabled={bitPerfectActive}
              onClick={() => {
                if (!bitPerfectActive) toggleMute();
              }}
              aria-label={bitPerfectActive ? 'Volume bypassed in Bit-Perfect mode' : muted ? 'Unmute' : 'Mute'}
              title={bitPerfectActive ? 'Volume is bypassed in Bit-Perfect (WASAPI Exclusive) mode' : undefined}
              className="grid size-7 flex-none place-items-center rounded-full text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:hover:text-secondary"
            >
              {bitPerfectActive ? (
                <Volume2 size={17} aria-hidden="true" />
              ) : muted || level === 0 ? (
                <VolumeX size={17} aria-hidden="true" />
              ) : (
                <Volume2 size={17} aria-hidden="true" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={displayLevel}
              disabled={bitPerfectActive}
              aria-label={bitPerfectActive ? 'Output volume bypassed in Bit-Perfect mode' : 'Output volume'}
              title={bitPerfectActive ? 'Volume is bypassed in Bit-Perfect (WASAPI Exclusive) mode' : undefined}
              onChange={(e) => {
                if (!bitPerfectActive) setVolume(Number(e.currentTarget.value));
              }}
              className={`h-1.5 flex-1 appearance-none rounded-full bg-secondary/30 accent-primary ${
                bitPerfectActive ? 'cursor-not-allowed' : 'cursor-pointer'
              }`}
            />
            <span
              className={`text-right type-callout tabular-nums text-secondary ${
                bitPerfectActive ? 'w-16' : 'w-9'
              }`}
            >
              {bitPerfectActive ? 'Bypassed' : `${Math.round(displayLevel * 100)}%`}
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPipelineOpen(true);
            }}
            className="flex w-full items-center gap-3.5 rounded-[16px] bg-primary/6 px-3.5 py-3 text-start transition-colors hover:bg-primary/10"
          >
            <span className="grid size-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
              <AudioLines size={18} aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="type-title-3-emphasized text-primary">Audio Pipeline</span>
              <span className="truncate type-callout text-secondary tabular-nums">{pipeline.shortSubtitle}</span>
            </span>
            <ChevronRight size={18} className="flex-none text-secondary" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
