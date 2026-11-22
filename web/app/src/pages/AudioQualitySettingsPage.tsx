import { AudioLines, Check, ChevronRight, Layers, Wifi } from 'lucide-react';
import { SubpageHeader } from '@/components/SubpageHeader';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { usePlayer, type StreamingQuality } from '@/state/player';
import { useUi } from '@/state/ui';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

const QUALITY_OPTIONS: { id: StreamingQuality; title: string; detail: string }[] = [
  {
    id: 'lossless',
    title: 'Lossless / Highest Available',
    detail: 'Prefer highest bitrate Opus (251) or native lossless local files without re-encoding.',
  },
  {
    id: 'high',
    title: 'High',
    detail: 'High bitrate streaming suitable for fast desktop connections.',
  },
  {
    id: 'normal',
    title: 'Normal',
    detail: 'Balanced bandwidth usage for metered or slower networks.',
  },
];

export default function AudioQualitySettingsPage() {
  const streamingQuality = usePlayer((s) => s.streamingQuality);
  const directSourceStream = usePlayer((s) => s.directSourceStream);
  const { setStreamingQuality, setDirectSourceStream } = usePlayer.getState();
  const pipeline = useAudioPipeline();
  const setPipelineOpen = useUi((s) => s.setAudioPipelineOpen);

  return (
    <div className={settingsUi.centered}>
      <SubpageHeader title="Audio Quality" backTo="/settings" />
      <div className={settingsUi.body}>
        <h2 className={settingsUi.sectionHeader}>Streaming Quality</h2>
        <section className={settingsUi.group}>
          {QUALITY_OPTIONS.map((opt) => {
            const active = streamingQuality === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setStreamingQuality(opt.id)}
                className={`${settingsUi.integration} ${settingsUi.linkRow}`}
              >
                <span className={settingsUi.iconPlain}>
                  <Wifi size={18} strokeWidth={2} aria-hidden="true" />
                </span>
                <span className={settingsUi.rowText}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate type-title-3 text-primary">{opt.title}</span>
                    {active && (
                      <span className="shrink-0 whitespace-nowrap rounded-[6px] bg-quaternary px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] text-secondary uppercase">
                        IN USE
                      </span>
                    )}
                  </span>
                  <span className={settingsUi.rowDetail}>{opt.detail}</span>
                </span>
                {active && <Check size={18} strokeWidth={2.4} className="text-key" aria-hidden="true" />}
              </button>
            );
          })}
        </section>

        <h2 className={settingsUi.sectionHeader}>Source Routing</h2>
        <section className={settingsUi.group}>
          <Toggle
            label="Direct Source Stream"
            detail="Stream directly from the highest-priority resolved audio source before fallback."
            checked={directSourceStream}
            onChange={setDirectSourceStream}
          />
          <div className={settingsUi.integration}>
            <span className={settingsUi.iconPlain}>
              <Layers size={18} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Source Priority</span>
              <span className={settingsUi.rowDetail}>
                Local Files &amp; Offline Downloads first, then YouTube Music direct stream proxy.
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPipelineOpen(true)}
            className={`${settingsUi.integration} ${settingsUi.linkRow}`}
          >
            <span className={settingsUi.iconPlain}>
              <AudioLines size={18} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Audio Pipeline</span>
              <span className={settingsUi.rowDetail}>Inspect live signal path ({pipeline.shortSubtitle})</span>
            </span>
            <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
          </button>
        </section>
      </div>
    </div>
  );
}
