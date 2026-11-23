import { AudioLines, Cpu, FileAudio2, SlidersHorizontal, Volume2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useAudioPipeline, type AudioPipelineStage } from '@/desktop/useAudioPipeline';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

function StageIcon({ id }: { id: AudioPipelineStage['id'] }) {
  switch (id) {
    case 'track':
      return <FileAudio2 size={14} strokeWidth={2} aria-hidden="true" />;
    case 'decoder':
      return <Cpu size={14} strokeWidth={2} aria-hidden="true" />;
    case 'resampler':
      return <SlidersHorizontal size={14} strokeWidth={2} aria-hidden="true" />;
    case 'dsp':
      return <AudioLines size={14} strokeWidth={2} aria-hidden="true" />;
    case 'output':
      return <Volume2 size={14} strokeWidth={2} aria-hidden="true" />;
  }
}

export function AudioPipelineDialog() {
  const open = useUi((s) => s.audioPipelineOpen);
  const setOpen = useUi((s) => s.setAudioPipelineOpen);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const pipeline = useAudioPipeline();
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    doneRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/62 p-4 backdrop-blur-xs animate-fade"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-pipeline-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) setOpen(false);
      }}
    >
      <div
        data-full-screen
        className="flex max-h-[84dvh] w-[min(450px,94vw)] flex-col overflow-hidden rounded-[24px] border border-white/14 bg-[#1c1c1e]/94 text-white shadow-[0_24px_70px_rgba(0,0,0,0.65)] backdrop-blur-2xl animate-zoom"
      >
        <div className="flex flex-col items-center px-6 pt-5 pb-4 text-center">
          <h2 id="audio-pipeline-title" className="type-[700_19px/24px] tracking-[-0.01em] text-white">
            Audio Pipeline
          </h2>
          <p className="mt-1 type-callout text-white/60">Live signal path, decoder to output</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 scrollbar-compact">
          <div className="relative flex flex-col">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-5 bottom-12 left-[14px] w-[2px] overflow-hidden bg-white/22"
            >
              {playing && (
                <div className="h-14 w-full bg-[linear-gradient(180deg,transparent,rgba(255,255,255,0.95)_75%,transparent)] motion-safe:animate-[pipeline-pulse_2.4s_linear_infinite]" />
              )}
            </div>

            {pipeline.stages.map((stage, idx) => (
              <div
                key={stage.id}
                className={`relative flex items-start gap-4 py-4 ${
                  idx > 0 ? 'border-t border-white/10' : 'border-t border-white/10'
                }`}
              >
                <div
                  className={`relative z-1 mt-0.5 grid size-[30px] flex-none place-items-center rounded-full border bg-[#131315] text-white/85 ${
                    playing
                      ? 'border-white/55 shadow-[0_0_12px_rgba(255,255,255,0.22)]'
                      : 'border-white/30'
                  }`}
                >
                  <StageIcon id={stage.id} />
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h3 className="mb-1 text-[11px] font-semibold tracking-[0.07em] text-white/55 uppercase">
                    {stage.title}
                  </h3>
                  {stage.rows.map((row) => (
                    <p key={row.label} className="type-[400_13px/18px] break-words text-white/75 tabular-nums">
                      <span className="font-semibold text-white/95">{row.label}:</span> {row.value}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-white/12">
          <button
            ref={doneRef}
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-12 w-full items-center justify-center type-title-3-emphasized text-white transition-colors hover:bg-white/10 active:bg-white/15"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
