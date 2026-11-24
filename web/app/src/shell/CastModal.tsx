import { Cast, Check, RefreshCw, Tv, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { castToDevice, stopCastingAndResumeLocal } from '@/desktop/castController';
import { useCast } from '@/desktop/castStore';
import type { CastDevice } from '@/desktop/tauriBridge';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

export function CastModal() {
  const open = useUi((s) => s.castModalOpen);
  if (!open) return null;
  return <CastModalContent />;
}

function CastModalContent() {
  const setOpen = useUi((s) => s.setCastModalOpen);
  const support = useCast((s) => s.support);
  const session = useCast((s) => s.session);
  const devices = useCast((s) => s.devices);
  const scanning = useCast((s) => s.scanning);
  const storeError = useCast((s) => s.error);
  const discoverDevices = useCast((s) => s.discoverDevices);
  const setError = useCast((s) => s.setError);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const hasNowPlaying = usePlayer((s) => s.nowPlaying !== null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    void discoverDevices();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [discoverDevices, setOpen]);

  const handleSelectDevice = async (device: CastDevice) => {
    if (session.connected && session.device?.id === device.id) return;
    if (!hasNowPlaying) {
      setError('Play a track first to cast audio to this TV.');
      return;
    }
    setPickingId(device.id);
    try {
      await castToDevice(device);
      setOpen(false);
    } catch {
      // Error state is published on useCast.
    } finally {
      setPickingId(null);
    }
  };

  const handleStopCasting = async () => {
    setStopping(true);
    try {
      await stopCastingAndResumeLocal();
      setOpen(false);
    } finally {
      setStopping(false);
    }
  };

  const remoteLevel = session.connected ? session.volume : muted ? 0 : volume;

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)-1)] flex items-end justify-center bg-black/55 p-4 backdrop-blur-xs animate-fade sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cast-modal-title"
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
          <div className="min-w-0">
            <h2 id="cast-modal-title" className="type-[700_18px/22px] text-white">
              Cast to TV
            </h2>
            {support.adapterName && (
              <p className="mt-0.5 truncate type-caption-1 text-white/55">
                {support.adapterName}
                {support.localIp ? ` · ${support.localIp}` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void discoverDevices()}
              disabled={scanning}
              aria-label="Scan for TVs"
              title="Scan for TVs and Cast receivers"
              className="grid size-8 place-items-center rounded-full bg-white/10 text-white/75 transition-colors hover:bg-white/18 hover:text-white disabled:opacity-50"
            >
              <RefreshCw
                size={14}
                className={scanning ? 'motion-safe:animate-spin' : undefined}
                aria-hidden="true"
              />
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close Cast to TV"
              className="grid size-8 place-items-center rounded-full bg-white/10 text-white/75 transition-colors hover:bg-white/18 hover:text-white"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          {storeError && (
            <div className="rounded-[14px] border border-red/30 bg-red/12 px-3.5 py-2.5 type-callout text-white/90">
              {storeError}
            </div>
          )}

          <div className="-m-1 flex max-h-[240px] flex-col gap-2 overflow-y-auto p-1 scrollbar-compact">
            {devices.length === 0 ? (
              <div className="flex flex-col items-center rounded-[16px] bg-white/6 px-5 py-6 text-center">
                <span className="grid size-10 place-items-center rounded-full bg-white/10 text-white/75">
                  <Tv size={19} aria-hidden="true" />
                </span>
                <p className="mt-3 type-title-3-emphasized text-white">
                  {scanning ? 'Searching for TVs...' : 'No TVs found on this network'}
                </p>
                <p className="mt-1 type-callout text-white/60">
                  {scanning
                    ? 'Scanning Wi-Fi and LAN for Chromecast and DLNA Smart TVs.'
                    : 'Make sure your TV and PC are on the same Wi-Fi network, then scan again.'}
                </p>
              </div>
            ) : (
              devices.map((dev) => {
                const connected = session.connected && session.device?.id === dev.id;
                const connecting = pickingId === dev.id || (session.connecting && session.device?.id === dev.id);
                const protocolLabel = dev.protocol === 'chromecast' ? 'Chromecast' : 'Smart TV (DLNA)';
                return (
                  <button
                    key={dev.id}
                    type="button"
                    disabled={connecting}
                    onClick={() => void handleSelectDevice(dev)}
                    className={`flex min-h-[56px] w-full items-center gap-3.5 rounded-[16px] px-3.5 py-3 text-start transition-colors ${
                      connected ? 'bg-white/16' : 'bg-white/7 hover:bg-white/11'
                    }`}
                  >
                    <span className="grid size-10 flex-none place-items-center rounded-full bg-white/12 text-white">
                      <Cast size={18} aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate type-title-3-emphasized text-white">{dev.name}</span>
                        <span className="shrink-0 rounded-full bg-white/12 px-2 py-0.5 text-[10px] font-medium text-white/75">
                          {protocolLabel}
                        </span>
                      </span>
                      <span className="truncate type-callout text-white/60">
                        {connecting
                          ? 'Connecting...'
                          : connected
                            ? `Casting audio · ${dev.host}`
                            : [dev.model, dev.host].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {connected && <Check size={17} strokeWidth={2.5} className="text-green" aria-hidden="true" />}
                  </button>
                );
              })
            )}
          </div>

          {session.connected && (
            <>
              <div className="flex items-center gap-3 rounded-[16px] bg-white/7 px-3.5 py-3.5">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted || remoteLevel === 0 ? 'Unmute TV' : 'Mute TV'}
                  className="grid size-7 flex-none place-items-center rounded-full text-white/75 transition-colors hover:text-white"
                >
                  {muted || remoteLevel === 0 ? (
                    <VolumeX size={17} aria-hidden="true" />
                  ) : (
                    <Volume2 size={17} aria-hidden="true" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={muted ? 0 : remoteLevel}
                  aria-label="TV volume"
                  onChange={(ev) => setVolume(Number(ev.currentTarget.value))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/22 accent-white"
                />
                <span className="w-9 text-right type-callout tabular-nums text-white/70">
                  {Math.round((muted ? 0 : remoteLevel) * 100)}%
                </span>
              </div>

              <button
                type="button"
                disabled={stopping}
                onClick={() => void handleStopCasting()}
                className="flex min-h-[44px] w-full items-center justify-center rounded-[16px] bg-red/18 px-4 py-2.5 type-body-emphasized text-[#ff7b73] transition-colors hover:bg-red/26 disabled:opacity-50"
              >
                {stopping ? 'Returning playback to PC...' : 'Stop Casting & Play Here'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
