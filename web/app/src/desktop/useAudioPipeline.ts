import { useQuery } from '@tanstack/react-query';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { getAudioContextSampleRate, usePlayer } from '@/state/player';
import {
  buildAudioPipelineData,
  type AudioPipelineStage,
  type AudioPipelineSummary,
  type PipelineMetricRow,
} from './audioPipelineData';

export type { AudioPipelineStage, AudioPipelineSummary, PipelineMetricRow };

export function useAudioPipeline(): AudioPipelineSummary {
  const desktop = isTauriDesktop();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const eq = usePlayer((s) => s.eq);
  const balance = usePlayer((s) => s.balance);
  const spatialAudio = usePlayer((s) => s.spatialAudio);
  const loudnessNormalization = usePlayer((s) => s.loudnessNormalization);
  const outputPrecision = usePlayer((s) => s.outputPrecision);
  const bitPerfect = usePlayer((s) => s.bitPerfectStatus);

  const snapQuery = useQuery({
    queryKey: ['desktop', 'audio', 'snapshot'],
    queryFn: () => desktopApi.audioSnapshot(),
    enabled: desktop,
    staleTime: 10_000,
  });

  const devicesQuery = useQuery({
    queryKey: ['desktop', 'audio', 'devices'],
    queryFn: () => desktopApi.audioListDevices(),
    enabled: desktop,
    staleTime: 30_000,
  });

  return buildAudioPipelineData({
    nowPlaying,
    eq,
    balance,
    spatialAudio,
    loudnessNormalization,
    outputPrecision,
    bitPerfect: snapQuery.data?.bitPerfect ?? bitPerfect,
    nativeSnapshot: snapQuery.data ?? null,
    devices: devicesQuery.data ?? [],
    webAudioSampleRateHz: getAudioContextSampleRate(),
    desktop,
  });
}
