import { isBitPerfectBypassActive, isExclusiveOutputMode } from './bitPerfectMode';
import { isTauriDesktop, type BitPerfectStatus, type OutputMode } from './tauriBridge';
import { usePlayer } from '@/state/player';

export interface BitPerfectUiState {
  desktop: boolean;
  outputMode: OutputMode;
  exclusiveRequested: boolean;
  bitPerfectActive: boolean;
  bitPerfectExact: boolean;
  lockVolume: boolean;
  lockDspFeatures: boolean;
  bitPerfect: BitPerfectStatus | null;
}

/**
 * Reactive summary of desktop Bit-Perfect bypass flags for settings and player controls.
 */
export function useBitPerfectUi(): BitPerfectUiState {
  const desktop = isTauriDesktop();
  const bitPerfect = usePlayer((s) => s.bitPerfectStatus);
  const outputMode = usePlayer((s) => s.desktopOutputMode);

  const exclusiveRequested =
    desktop && isBitPerfectBypassActive({ outputMode }, bitPerfect);
  const bitPerfectActive = desktop && bitPerfect?.active === true;
  const bitPerfectExact = bitPerfectActive && bitPerfect?.exact === true;

  return {
    desktop,
    outputMode,
    exclusiveRequested,
    bitPerfectActive,
    bitPerfectExact,
    lockVolume: bitPerfectActive,
    lockDspFeatures: exclusiveRequested || (desktop && isExclusiveOutputMode(outputMode)),
    bitPerfect,
  };
}
