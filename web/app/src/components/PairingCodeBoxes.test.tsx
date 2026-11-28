// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPairingCodeInput, formatPairingCode, PairingCodeBoxes } from './PairingCodeBoxes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setSlotInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pasteIntoSlot(input: HTMLInputElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent & {
    clipboardData: { getData: (type: string) => string };
  };
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
    },
  });
  input.dispatchEvent(ev);
}

describe('PairingCodeBoxes', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('normalizes and formats 6-character pairing codes and quick-login URLs', () => {
    expect(formatPairingCode('shd7j6')).toBe('SHD-7J6');
    expect(formatPairingCode('482-910')).toBe('482-910');
    expect(formatPairingCode('abc')).toBe('ABC');
    expect(extractPairingCodeInput('http://192.168.1.42:47923/quick-login?code=shd-7j6')).toBe('SHD7J6');
  });

  it('renders 6 read-only character boxes separated 3 + "-" + 3', async () => {
    await act(async () => {
      root.render(<PairingCodeBoxes value="shd-7j6" readOnly />);
    });

    const group = host.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Pairing code SHD-7J6');
    const slots = Array.from(host.querySelectorAll('[data-slot-index]'));
    expect(slots).toHaveLength(6);
    expect(slots.map((el) => el.textContent)).toEqual(['S', 'H', 'D', '7', 'J', '6']);
    expect(group?.textContent).toBe('SHD-7J6');
  });

  it('renders placeholder boxes cleanly when read-only code is absent', async () => {
    await act(async () => {
      root.render(<PairingCodeBoxes value={null} readOnly />);
    });

    const group = host.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Pairing code unavailable');
    expect(host.querySelectorAll('[data-slot-index]')).toHaveLength(6);
  });

  it('advances across the dash, handles Backspace, arrows, and multi-char paste', async () => {
    const onChange = vi.fn();
    const onPasteRaw = vi.fn();

    await act(async () => {
      root.render(
        <PairingCodeBoxes
          value=""
          ariaLabel="Peer 6-character code"
          onChange={onChange}
          onPasteRaw={onPasteRaw}
        />,
      );
    });

    const inputs = Array.from(host.querySelectorAll('input[data-slot-index]')) as HTMLInputElement[];
    expect(inputs).toHaveLength(6);

    await act(async () => {
      inputs[0]!.focus();
      setSlotInput(inputs[0]!, 's');
    });
    expect(document.activeElement).toBe(inputs[1]);
    expect(onChange).toHaveBeenLastCalledWith('S');

    await act(async () => {
      setSlotInput(inputs[1]!, 'h');
      setSlotInput(inputs[2]!, 'd');
    });
    expect(document.activeElement).toBe(inputs[3]);
    expect(onChange).toHaveBeenLastCalledWith('SHD');

    await act(async () => {
      setSlotInput(inputs[3]!, '7');
    });
    expect(document.activeElement).toBe(inputs[4]);
    expect(onChange).toHaveBeenLastCalledWith('SHD-7');

    // Empty slot Backspace steps back across the dash and clears slot 2 ('D').
    await act(async () => {
      inputs[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    // First Backspace clears slot 3 ('7'); second Backspace moves to slot 2 ('D') and clears it.
    expect(onChange).toHaveBeenLastCalledWith('SHD');
    await act(async () => {
      inputs[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(document.activeElement).toBe(inputs[2]);
    expect(onChange).toHaveBeenLastCalledWith('SH');

    // ArrowRight moves back toward slot 3 cleanly across the dash.
    await act(async () => {
      inputs[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(inputs[3]);

    // Pasting a full formatted code fills all 6 boxes regardless of source focus index.
    const urlPayload = 'http://192.168.1.10:47923/quick-login?code=482-910';
    await act(async () => {
      pasteIntoSlot(inputs[4]!, urlPayload);
    });
    expect(onPasteRaw).toHaveBeenCalledWith(urlPayload);
    expect(onChange).toHaveBeenLastCalledWith('482-910');
    expect(inputs.map((i) => i.value)).toEqual(['4', '8', '2', '9', '1', '0']);
  });
});
