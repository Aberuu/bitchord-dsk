import type { AudioSettings, BitPerfectStatus } from './tauriBridge';

/**
 * Returns true when an exclusive/direct output mode (WASAPI Exclusive or ASIO) is configured.
 */
export function isExclusiveOutputMode(mode: AudioSettings['outputMode'] | null | undefined): boolean {
  return mode === 'wasapi_exclusive' || mode === 'asio';
}

/**
 * Returns true when upstream BitChord DSP (EQ, balance, loudness, spatial, crossfade,
 * Automix, and playback speed) must be bypassed in favor of direct hardware output.
 */
export function isBitPerfectBypassActive(
  settings: Pick<AudioSettings, 'outputMode'> | null | undefined,
  bitPerfect: Pick<BitPerfectStatus, 'active'> | null | undefined,
): boolean {
  return bitPerfect?.active === true || isExclusiveOutputMode(settings?.outputMode);
}
