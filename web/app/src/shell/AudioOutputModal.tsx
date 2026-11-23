import {
  AudioLines,
  Bluetooth,
  Check,
  ChevronRight,
  Headphones,
  MonitorSpeaker,
  RefreshCw,
  Speaker,
  Usb,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AudioDeviceKind, OutputMode } from '@/desktop/tauriBridge';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
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
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const { setVolume, toggleMute } = usePlayer.getState();
  const pipeline = useAudioPipeline();
  const { desktop, devicesQuery, snapQuery, updateAudio, refresh } = useDesktopAudioDevices({
    enabled: true,
    live: true,
  });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setOpen]);

  const snap = snapQuery.data;
  const settings = snap?.settings;
  const devices = devicesQuery.data ?? [];
  const defaultDevice = devices.find((d) => d.isDefault) ?? null;
  const activeDeviceId = settings?.deviceId ?? null;
  const activeMode: OutputMode = settings?.outputMode ?? 'shared';
  const fallbackReason = snap?.bitPerfect.fallbackReason ?? null;

  const selectDevice = (deviceId: string | null) => {
    if (!settings || deviceId === activeDeviceId) return;
    updateAudio.mutate({ ...settings, deviceId });
  };

  const toggleExclusive = () => {
    if (!settings) return;
    const nextMode: OutputMode = activeMode === 'wasapi_exclusive' ? 'shared' : 'wasapi_exclusive';
    updateAudio.mutate({ ...settings, outputMode: nextMode });
  };

  const level = muted ? 0 : volume;
  const refreshing = devicesQuery.isFetching || snapQuery.isFetching;

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)-1)] flex items-end justify-center bg-black/55 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-output-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) setOpen(false);
      }}
    >
      <div
        data-full-screen
        className="w-[min(420px,95vw)] overflow-hidden rounded-[24px] border border-white/12 bg-[#1c1c1e]/94 p-4 text-white shadow-[0_24px_64px_rgba(0,0,0,0.65)] backdrop-blur-2xl animate-zoom"
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/25 sm:hidden" aria-hidden="true" />
        <div className="mb-3.5 flex items-center justify-between px-1">
          <h2 id="audio-output-title" className="type-[700_18px/22px] text-white">
            Audio output
          </h2>
          <div className="flex items-center gap-1.5">
            {desktop && (
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label="Refresh audio devices"
                title="Refresh audio devices"
                className="grid size-8 place-items-center rounded-full bg-white/10 text-white/75 transition-colors hover:bg-white/18 hover:text-white"
              >
                <RefreshCw
                  size={14}
                  className={refreshing ? 'motion-safe:animate-spin' : undefined}
                  aria-hidden="true"
                />
              </button>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close audio output"
              className="grid size-8 place-items-center rounded-full bg-white/10 text-white/75 transition-colors hover:bg-white/18 hover:text-white"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          {/* Keep 4px inset breathing room so focus-visible outlines never clip at scroll corners. */}
          <div className="-m-1 flex max-h-[220px] flex-col gap-2 overflow-y-auto p-1 [scrollbar-width:thin]">
            <button
              type="button"
              onClick={() => selectDevice(null)}
              className={`flex w-full items-center gap-3.5 rounded-[16px] px-3.5 py-3 text-start transition-colors ${
                activeDeviceId === null ? 'bg-white/14' : 'bg-white/7 hover:bg-white/11'
              }`}
            >
              <span className="grid size-10 flex-none place-items-center rounded-full bg-white/12 text-white">
                <MonitorSpeaker size={18} aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate type-title-3-emphasized text-white">
                  {desktop ? 'This PC (Default Output)' : 'This PC'}
                </span>
                <span className="truncate type-callout text-white/60">
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
                <Check size={18} strokeWidth={2.4} className="flex-none text-white" aria-hidden="true" />
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
                    selected ? 'bg-white/14' : 'bg-white/7 hover:bg-white/11'
                  }`}
                >
                  <span className="grid size-10 flex-none place-items-center rounded-full bg-white/12 text-white">
                    <OutputDeviceIcon kind={dev.kind} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate type-title-3-emphasized text-white">{dev.name}</span>
                    <span className="truncate type-callout text-white/60">
                      {dev.isUsbDac ? 'USB DAC · ' : ''}
                      {dev.backend} · up to {Math.round(dev.maxSampleRateHz / 1000)} kHz
                    </span>
                  </span>
                  {selected && (
                    <Check size={18} strokeWidth={2.4} className="flex-none text-white" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          {desktop && settings && (
            <button
              type="button"
              onClick={toggleExclusive}
              className="flex w-full items-center justify-between gap-3 rounded-[16px] bg-white/7 px-3.5 py-3 text-start transition-colors hover:bg-white/11"
            >
              <span className="flex min-w-0 flex-col">
                <span className="type-body-emphasized text-white">WASAPI Exclusive (Bit-Perfect)</span>
                <span className="truncate type-callout text-white/60">
                  {fallbackReason
                    ? fallbackReason
                    : activeMode === 'wasapi_exclusive'
                      ? 'Bypassing Windows mixer on active device'
                      : 'Bypass Windows mixer on compatible DACs'}
                </span>
              </span>
              <span
                className={`rounded-pill px-2.5 py-1 type-caption-2 uppercase ${
                  activeMode === 'wasapi_exclusive'
                    ? 'bg-green/20 text-green'
                    : 'bg-white/10 text-white/65'
                }`}
              >
                {activeMode === 'wasapi_exclusive' ? 'On' : 'Off'}
              </span>
            </button>
          )}

          <div className="flex items-center gap-3 rounded-[16px] bg-white/7 px-3.5 py-3.5">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="grid size-7 flex-none place-items-center rounded-full text-white/75 transition-colors hover:text-white"
            >
              {muted || level === 0 ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={level}
              aria-label="Output volume"
              onChange={(e) => setVolume(Number(e.currentTarget.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/22 accent-white"
            />
            <span className="w-9 text-right type-callout tabular-nums text-white/70">
              {Math.round(level * 100)}%
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPipelineOpen(true);
            }}
            className="flex w-full items-center gap-3.5 rounded-[16px] bg-white/7 px-3.5 py-3 text-start transition-colors hover:bg-white/12"
          >
            <span className="grid size-10 flex-none place-items-center rounded-full bg-white/12 text-white">
              <AudioLines size={18} aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="type-title-3-emphasized text-white">Audio Pipeline</span>
              <span className="truncate type-callout text-white/60 tabular-nums">{pipeline.shortSubtitle}</span>
            </span>
            <ChevronRight size={18} className="flex-none text-white/50" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
