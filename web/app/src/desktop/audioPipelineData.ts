import type {
  AudioDeviceInfo,
  BitPerfectStatus,
  NativePlaybackSnapshot,
} from '@/desktop/tauriBridge';
import { computeEqCurve, presetLabel, type EqConfig } from '@/playback/webAudioEq';

export type PipelineOutputPrecision = 'pcm16' | 'float32';

export interface PipelineStreamLike {
  codec?: string | null;
  sampleRateHz?: number | null;
  bitrateKbps?: number | null;
  channels?: number | null;
}

export interface PipelineNowPlayingLike {
  videoId: string;
  streamInfo: string | null;
  stream: PipelineStreamLike | null;
}

export interface PipelineMetricRow {
  label: string;
  value: string;
}

export interface AudioPipelineStage {
  id: 'track' | 'decoder' | 'resampler' | 'dsp' | 'output';
  title: string;
  rows: PipelineMetricRow[];
}

export interface AudioPipelineSummary {
  shortSubtitle: string;
  activeDeviceName: string;
  stages: AudioPipelineStage[];
}

export interface PipelineInput {
  nowPlaying: PipelineNowPlayingLike | null;
  eq: EqConfig;
  balance: number;
  spatialAudio: boolean;
  loudnessNormalization: boolean;
  outputPrecision: PipelineOutputPrecision;
  bitPerfect: BitPerfectStatus | null;
  nativeSnapshot: NativePlaybackSnapshot | null;
  devices: AudioDeviceInfo[];
  webAudioSampleRateHz: number | null;
  desktop: boolean;
}

const NONE = '-';

export function formatSampleRate(hz: number | null | undefined): string {
  if (!hz || !Number.isFinite(hz) || hz <= 0) return NONE;
  const khz = hz / 1000;
  return Number.isInteger(khz) ? `${khz} kHz` : `${khz.toFixed(1)} kHz`;
}

function formatChannels(ch: number | null | undefined): string {
  if (!ch || ch <= 0) return 'Stereo';
  if (ch === 1) return 'Mono';
  if (ch === 2) return 'Stereo';
  return `${ch}ch Surround`;
}

export function buildAudioPipelineData(input: PipelineInput): AudioPipelineSummary {
  const {
    nowPlaying,
    eq,
    balance,
    spatialAudio,
    loudnessNormalization,
    outputPrecision,
    bitPerfect,
    nativeSnapshot,
    devices,
    webAudioSampleRateHz,
    desktop,
  } = input;

  const isLocal = nowPlaying?.videoId.startsWith('local:') ?? false;
  const nativeActive = nativeSnapshot?.active === true;
  const tapActive = nativeSnapshot?.tapActive === true;
  const stream = nowPlaying?.stream ?? null;

  const sourceName = !nowPlaying
    ? 'Idle (No track loaded)'
    : isLocal
      ? 'Local File'
      : nowPlaying.streamInfo === 'Offline download'
        ? 'Offline Download'
        : 'YouTube Music';

  const codec = nativeActive
    ? nativeSnapshot.codec ?? 'PCM'
    : stream?.codec ?? (isLocal ? 'FLAC / Local Audio' : nowPlaying ? 'Opus' : NONE);

  const isLossless =
    /flac|alac|wav|pcm|aiff|dsd/i.test(codec) ||
    (nativeActive && nativeSnapshot.bitDepth >= 16);

  const sourceRateHz = nativeActive
    ? nativeSnapshot.sampleRateHz
    : stream?.sampleRateHz ?? (nowPlaying ? 48000 : null);

  const sourceBits = nativeActive
    ? nativeSnapshot.bitDepth
    : isLossless
      ? 16
      : null;

  const channels = nativeActive
    ? nativeSnapshot.channels
    : stream?.channels ?? (nowPlaying ? 2 : null);

  const bitrateText = stream?.bitrateKbps
    ? `${stream.bitrateKbps} kbps`
    : nativeActive && sourceRateHz && sourceBits && channels
      ? `${Math.round((sourceRateHz * sourceBits * channels) / 1000)} kbps`
      : NONE;

  const pcmDataRateText =
    sourceRateHz && channels
      ? `${Math.round((sourceRateHz * (sourceBits ?? 16) * channels) / 1000)} kbps`
      : NONE;

  const decoderName = nativeActive
    ? 'Symphonia Native Decoder (Rust)'
    : nowPlaying
      ? codec.toLowerCase().includes('aac') || codec.toLowerCase().includes('mp4')
        ? 'Chromium / WebView2 AAC Decoder'
        : 'Chromium / WebView2 Opus Decoder'
      : 'Standby';

  const decoderFormat =
    outputPrecision === 'float32' ? '32-bit float PCM' : '16-bit PCM';

  const selectedDeviceId = nativeSnapshot?.settings.deviceId ?? null;
  const matchedDevice =
    (selectedDeviceId ? devices.find((d) => d.id === selectedDeviceId) : null) ??
    devices.find((d) => d.isDefault) ??
    devices[0] ??
    null;

  const outRateHz = bitPerfect?.sampleRateHz
    ? bitPerfect.sampleRateHz
    : nativeActive
      ? nativeSnapshot.sampleRateHz
      : tapActive && matchedDevice
        ? matchedDevice.maxSampleRateHz
        : webAudioSampleRateHz ?? sourceRateHz ?? 48000;

  const isPassthrough =
    sourceRateHz !== null && outRateHz !== null && sourceRateHz === outRateHz;

  const ioRateText =
    sourceRateHz && outRateHz
      ? `${formatSampleRate(sourceRateHz)} -> ${formatSampleRate(outRateHz)}`
      : formatSampleRate(outRateHz);

  const resamplerType = !sourceRateHz
    ? NONE
    : isPassthrough
      ? 'None'
      : nativeActive
        ? 'Rubato Sinc Resampler'
        : tapActive
          ? 'Desktop Tap Resampler'
          : 'Web Audio Resampler';

  const resamplerQuality = !sourceRateHz
    ? NONE
    : isPassthrough
      ? 'Passthrough'
      : 'Resampled';

  const eqCurve = computeEqCurve(eq);
  const eqPresetText = eq.enabled
    ? eq.mode === 'tone'
      ? `Tone Pad (${eq.toneX >= 0 ? `+${eq.toneX}` : eq.toneX}, ${eq.toneY >= 0 ? `+${eq.toneY}` : eq.toneY})`
      : presetLabel(eq.preset)
    : 'Flat';

  const stereoExpandText = spatialAudio ? '250%' : '100%';
  const loudnessGainText = !loudnessNormalization
    ? 'Off'
    : eq.enabled
      ? `${(eqCurve.preampDb - 0.7).toFixed(1)} dB`
      : '-0.7 dB';

  const selectedMode = nativeSnapshot?.settings.outputMode ?? 'shared';
  const outputApi = bitPerfect?.driver
    ? bitPerfect.driver
    : !desktop
      ? 'Web Audio API'
      : nativeActive || tapActive
        ? selectedMode === 'wasapi_exclusive'
          ? 'WASAPI Exclusive'
          : selectedMode === 'asio'
            ? 'ASIO'
            : 'WASAPI Shared'
        : 'WASAPI Shared (System Default)';

  const bitExactVerdict = (() => {
    if (bitPerfect?.active && bitPerfect.exact) {
      return `Yes (bit-perfect to ${bitPerfect.deviceName ?? 'DAC'})`;
    }
    if (bitPerfect?.active && bitPerfect.dacLimited) {
      return `No (converted with TPDF dither for ${bitPerfect.deviceName ?? 'DAC'})`;
    }
    if (eq.enabled) return 'No (equalizer active)';
    if (spatialAudio) return 'No (spatial audio active)';
    if (Math.abs(balance) > 0.01) return 'No (channel balance shifted)';
    if (loudnessNormalization) return 'No (loudness normalization)';
    if (isPassthrough) {
      return `Yes (${decoderFormat} -> ${outputPrecision === 'float32' ? 'Float32' : 'PCM16'})`;
    }
    return 'No (system mixer resampled)';
  })();

  const activeDeviceName =
    bitPerfect?.deviceName ??
    matchedDevice?.name ??
    (desktop ? 'Windows Default Speakers' : 'System Default Output');

  const routeText = !desktop
    ? 'BROWSER'
    : nativeActive
      ? 'DESKTOP (Native Lossless)'
      : tapActive
        ? 'DESKTOP (Audio Tap)'
        : 'DESKTOP (System Default)';

  const directText = bitPerfect?.active
    ? `Active (${bitPerfect.driver ?? 'WASAPI Exclusive'}, bypasses mixer)`
    : desktop && selectedMode === 'wasapi_exclusive'
      ? tapActive
        ? 'Active via WASAPI Exclusive Tap'
        : 'Armed (activates on local lossless files or custom device)'
      : tapActive
        ? `Active Tap (${matchedDevice?.name ?? 'Selected output'})`
        : 'Shared Mixed Path (Windows Audio Engine)';

  const outputFormatText = bitPerfect?.active
    ? `PCM${bitPerfect.outputBits} / ${formatSampleRate(bitPerfect.sampleRateHz)}`
    : `${outputPrecision === 'float32' ? 'Float32' : 'PCM16'} / ${formatSampleRate(outRateHz)}`;

  const systemMixerText = bitPerfect?.active
    ? bitPerfect.dacLimited
      ? 'Bypassed (DAC ceiling dithered)'
      : 'Bypassed (bit-perfect)'
    : desktop
      ? `Windows WASAPI Mixer ${formatSampleRate(outRateHz)}`
      : `Browser AudioContext ${formatSampleRate(outRateHz)}`;

  const outputRows: PipelineMetricRow[] = [
    { label: 'Device Name', value: activeDeviceName },
    { label: 'Route', value: routeText },
    { label: 'Transport', value: outputApi },
    { label: 'Direct', value: directText },
    { label: 'Output', value: outputFormatText },
    { label: 'System', value: systemMixerText },
  ];

  if (bitPerfect?.fallbackReason) {
    outputRows.push({ label: 'Fallback', value: bitPerfect.fallbackReason });
  }

  const shortSubtitle = `${outputPrecision === 'float32' ? '32-bit float' : '16-bit PCM'} · ${formatSampleRate(outRateHz)}`;

  return {
    shortSubtitle,
    activeDeviceName,
    stages: [
      {
        id: 'track',
        title: 'TRACK INFO',
        rows: [
          { label: 'Source', value: sourceName },
          { label: 'Format', value: codec },
          { label: 'Bit Depth', value: sourceBits ? `${sourceBits}-bit` : NONE },
          { label: 'Sample Rate', value: formatSampleRate(sourceRateHz) },
          { label: 'Bitrate', value: bitrateText },
          { label: 'PCM Data Rate', value: pcmDataRateText },
          { label: 'Channels', value: channels ? formatChannels(channels) : NONE },
        ],
      },
      {
        id: 'decoder',
        title: 'DECODER',
        rows: [
          { label: 'Decoder Name', value: decoderName },
          { label: 'Format', value: decoderFormat },
        ],
      },
      {
        id: 'resampler',
        title: 'RESAMPLER',
        rows: [
          { label: 'I/O Rate', value: ioRateText },
          { label: 'Type', value: resamplerType },
          { label: 'Cutoff', value: NONE },
          { label: 'Quality', value: resamplerQuality },
        ],
      },
      {
        id: 'dsp',
        title: 'DSP',
        rows: [
          { label: 'PCM Format', value: 'Float32' },
          { label: 'Sample Rate', value: formatSampleRate(outRateHz) },
          { label: 'Gain', value: loudnessGainText },
          { label: 'Measured', value: loudnessNormalization ? '-14.0 LUFS target' : NONE },
          { label: 'EQ Preset', value: eqPresetText },
          { label: 'Stereo Expand', value: stereoExpandText },
          { label: 'Buffers', value: `2x (20 ms, ${Math.round(outRateHz * 0.02)} frames)` },
          { label: 'Output API', value: outputApi },
          { label: 'Bit-exact', value: bitExactVerdict },
        ],
      },
      {
        id: 'output',
        title: 'OUTPUT DEVICE',
        rows: outputRows,
      },
    ],
  };
}
