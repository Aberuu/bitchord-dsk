export const BIT_PERFECT_BYPASS_WARNING =
  'Sends the track directly to your DAC. Equalizer, loudness normalization, crossfade, Automix, playback speed, and BitChord software volume are bypassed at 100% scale.';

export const BIT_PERFECT_BYPASSED_FOOTER =
  'Bit-perfect output (WASAPI Exclusive) is active, so the faded settings above are bypassed. Turn off WASAPI Exclusive to use them again.';

export function bypassedRowClasses(bypassed: boolean): string {
  return bypassed ? 'pointer-events-none select-none opacity-40' : '';
}

export function BitPerfectConfirmBanner({
  onConfirm,
  onCancel,
  variant = 'modal',
  mode = 'wasapi_exclusive',
}: {
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'modal' | 'page';
  mode?: 'wasapi_exclusive' | 'asio';
}) {
  const isModal = variant === 'modal';
  const modeTitle =
    mode === 'asio' ? 'Enable ASIO Driver (Bit-Perfect)?' : 'Enable WASAPI Exclusive (Bit-Perfect)?';
  return (
    <div
      role="alertdialog"
      aria-labelledby="bitperfect-confirm-title"
      aria-describedby="bitperfect-confirm-desc"
      className={
        isModal
          ? 'flex flex-col gap-3 rounded-[16px] border border-white/14 bg-white/10 px-3.5 py-3 text-white'
          : 'flex flex-col gap-3 px-4 py-4 hairline-[16px]'
      }
    >
      <div className="flex flex-col gap-1">
        <span
          id="bitperfect-confirm-title"
          className={`type-title-3-emphasized ${isModal ? 'text-white' : 'text-primary'}`}
        >
          {modeTitle}
        </span>
        <p
          id="bitperfect-confirm-desc"
          className={`type-callout ${isModal ? 'text-white/75' : 'text-secondary'}`}
        >
          {BIT_PERFECT_BYPASS_WARNING} Adjust loudness using your DAC or amplifier hardware controls.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={
            isModal
              ? 'rounded-pill bg-white/12 px-3.5 py-1.5 type-callout-emphasized text-white/85 transition-colors hover:bg-white/20'
              : 'rounded-pill bg-quaternary px-3.5 py-1.5 type-callout-emphasized text-primary transition-colors hover:bg-tracklist-hover'
          }
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-pill bg-key-bg px-3.5 py-1.5 type-callout-emphasized text-white transition-opacity hover:opacity-90"
        >
          Enable
        </button>
      </div>
    </div>
  );
}
