import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';

export const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_GROUP_SIZE = 3;

/** Keep only uppercase ASCII letters and digits, capped to 6 pairing characters. */
export function sanitizePairingCode(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, PAIRING_CODE_LENGTH);
}

/** Extract a 6-character pairing code from raw text, formatted `XXX-XXX` strings, or quick-login URLs. */
export function extractPairingCodeInput(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const queryMatch = /[?&]code=([a-z0-9-]+)/i.exec(trimmed);
  return sanitizePairingCode(queryMatch?.[1] ?? trimmed);
}

/** Format a 6-character pairing code with a `-` after the first 3 characters. */
export function formatPairingCode(raw: string | null | undefined): string {
  const clean = sanitizePairingCode(raw);
  if (clean.length <= PAIRING_CODE_GROUP_SIZE) return clean;
  return `${clean.slice(0, PAIRING_CODE_GROUP_SIZE)}-${clean.slice(PAIRING_CODE_GROUP_SIZE)}`;
}

function slotsFromCompact(compact: string): string[] {
  return Array.from({ length: PAIRING_CODE_LENGTH }, (_, idx) => compact[idx] ?? '');
}

function replaceChangedSlotChar(previousChar: string, rawTyped: string): string {
  if (rawTyped.length <= 1) return rawTyped;
  if (previousChar && rawTyped.startsWith(previousChar)) {
    return rawTyped[rawTyped.length - 1] ?? '';
  }
  if (previousChar && rawTyped.endsWith(previousChar)) {
    return rawTyped[0] ?? '';
  }
  return rawTyped[rawTyped.length - 1] ?? '';
}

interface PairingCodeBoxesProps {
  /** Current code string (accepts `SHD-7J6`, `SHD7J6`, or partial input). */
  value: string | null | undefined;
  /** Called with formatted code whenever interactive input changes. */
  onChange?: (nextFormattedCode: string) => void;
  /** Optional callback receiving the untouched pasted clipboard text. */
  onPasteRaw?: (rawClipboardText: string) => void;
  /** Render non-editable display boxes instead of interactive `<input>` cells. */
  readOnly?: boolean;
  /** Disable all interactive inputs. */
  disabled?: boolean;
  /** Accessible group label describing the code boxes. */
  ariaLabel?: string;
  /** Optional wrapper classes. */
  className?: string;
}

const BASE_BOX_CLASS =
  'inline-flex shrink-0 items-center justify-center rounded-[10px] border border-(--searchBarBorderColor) bg-page font-mono font-bold uppercase tabular-nums transition-colors';

const READONLY_BOX_CLASS =
  `${BASE_BOX_CLASS} h-[44px] w-[clamp(30px,9vw,40px)] text-[17px] sm:text-[19px] text-primary select-none`;

const INTERACTIVE_BOX_CLASS =
  `${BASE_BOX_CLASS} h-[44px] sm:h-[46px] w-[clamp(32px,9.5vw,42px)] text-center text-[16px] sm:text-[18px] text-primary caret-(--systemSecondary) focus:border-(--systemSecondary) focus:bg-quinary/40 disabled:opacity-50`;

const DASH_CLASS =
  'inline-flex w-3 shrink-0 items-center justify-center font-mono text-[16px] font-semibold text-secondary select-none';

/**
 * 6-character pairing/OTP box group split into two triplets with a `-` divider (`XXX-XXX`).
 * Supports read-only display (`QuickSignInModal`) and multi-slot keyboard/paste input (`OneKeySessionSection`).
 */
export function PairingCodeBoxes({
  value,
  onChange,
  onPasteRaw,
  readOnly = false,
  disabled = false,
  ariaLabel,
  className = '',
}: PairingCodeBoxesProps) {
  const externalCompact = sanitizePairingCode(value);
  const [slots, setSlots] = useState<string[]>(() => slotsFromCompact(externalCompact));
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Sync external programmatic updates (URL paste autofill or form reset) while
  // preserving sparse cursor placements while the user edits out of order.
  useEffect(() => {
    if (externalCompact !== slots.join('')) {
      setSlots(slotsFromCompact(externalCompact));
    }
  }, [externalCompact]);

  const commitSlots = (nextSlots: string[]) => {
    setSlots(nextSlots);
    onChange?.(formatPairingCode(nextSlots.join('')));
  };

  const focusSlot = (targetIndex: number) => {
    const clamped = Math.max(0, Math.min(PAIRING_CODE_LENGTH - 1, targetIndex));
    const el = inputRefs.current[clamped];
    if (!el) return;
    el.focus();
    el.select();
  };

  const applyChunk = (startIndex: number, cleanChars: string) => {
    if (!cleanChars) return;
    const baseStart = cleanChars.length >= PAIRING_CODE_LENGTH ? 0 : startIndex;
    const next = [...slots];
    let written = 0;
    for (let offset = 0; offset < cleanChars.length; offset += 1) {
      const target = baseStart + offset;
      if (target >= PAIRING_CODE_LENGTH) break;
      next[target] = cleanChars[offset] ?? '';
      written += 1;
    }
    commitSlots(next);
    focusSlot(Math.min(PAIRING_CODE_LENGTH - 1, baseStart + written));
  };

  const handleInputChange = (index: number, rawInput: string) => {
    const clean = sanitizePairingCode(rawInput);
    if (!clean) {
      const next = [...slots];
      next[index] = '';
      commitSlots(next);
      return;
    }

    if (clean.length > 2) {
      applyChunk(index, clean);
      return;
    }

    const nextChar = replaceChangedSlotChar(slots[index] ?? '', clean);
    const next = [...slots];
    next[index] = nextChar;
    commitSlots(next);
    if (nextChar && index < PAIRING_CODE_LENGTH - 1) {
      focusSlot(index + 1);
    }
  };

  const handleKeyDown = (index: number, ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Backspace') {
      ev.preventDefault();
      if (slots[index]) {
        const next = [...slots];
        next[index] = '';
        commitSlots(next);
      } else if (index > 0) {
        const next = [...slots];
        next[index - 1] = '';
        commitSlots(next);
        focusSlot(index - 1);
      }
      return;
    }

    if (ev.key === 'Delete') {
      ev.preventDefault();
      if (slots[index]) {
        const next = [...slots];
        next[index] = '';
        commitSlots(next);
      }
      return;
    }

    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      focusSlot(index - 1);
      return;
    }

    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      focusSlot(index + 1);
      return;
    }

    if (ev.key === 'Home') {
      ev.preventDefault();
      focusSlot(0);
      return;
    }

    if (ev.key === 'End') {
      ev.preventDefault();
      focusSlot(PAIRING_CODE_LENGTH - 1);
    }
  };

  const handlePaste = (index: number, ev: ClipboardEvent<HTMLInputElement>) => {
    ev.preventDefault();
    const rawClipboard = ev.clipboardData.getData('text');
    onPasteRaw?.(rawClipboard);
    const extracted = extractPairingCodeInput(rawClipboard);
    applyChunk(index, extracted);
  };

  if (readOnly) {
    const hasCode = externalCompact.length > 0;
    const formatted = formatPairingCode(value);
    const displaySlots = slotsFromCompact(externalCompact);
    const groupLabel = ariaLabel ?? (hasCode ? `Pairing code ${formatted}` : 'Pairing code unavailable');

    return (
      <div
        role="group"
        aria-label={groupLabel}
        className={`inline-flex max-w-full flex-nowrap items-center justify-center gap-1.5 ${className}`}
      >
        {displaySlots.map((char, index) => (
          <span key={index} className="contents">
            {index === PAIRING_CODE_GROUP_SIZE && (
              <span aria-hidden="true" className={DASH_CLASS}>
                -
              </span>
            )}
            <span
              aria-hidden="true"
              data-slot-index={index}
              className={`${READONLY_BOX_CLASS} ${char ? '' : 'text-tertiary'}`}
            >
              {char || '-'}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel ?? '6-character pairing code'}
      className={`inline-flex max-w-full flex-nowrap items-center justify-center gap-1.5 ${className}`}
    >
      {slots.map((char, index) => (
        <span key={index} className="contents">
          {index === PAIRING_CODE_GROUP_SIZE && (
            <span aria-hidden="true" className={DASH_CLASS}>
              -
            </span>
          )}
          <input
            ref={(el) => {
              inputRefs.current[index] = el;
            }}
            type="text"
            inputMode="text"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            autoCapitalize="characters"
            spellCheck={false}
            aria-label={`Character ${index + 1} of ${PAIRING_CODE_LENGTH}`}
            data-slot-index={index}
            value={char}
            disabled={disabled}
            onFocus={(ev) => ev.currentTarget.select()}
            onChange={(ev) => handleInputChange(index, ev.target.value)}
            onKeyDown={(ev) => handleKeyDown(index, ev)}
            onPaste={(ev) => handlePaste(index, ev)}
            className={INTERACTIVE_BOX_CLASS}
          />
        </span>
      ))}
    </div>
  );
}
