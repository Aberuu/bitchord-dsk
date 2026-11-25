// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { initFocusModality } from './focusModality';

describe('initFocusModality', () => {
  it('defaults to pointer, switches to keyboard on Tab, and resets to pointer on pointerdown', () => {
    initFocusModality();
    expect(document.documentElement.dataset.inputModality).toBe('pointer');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.documentElement.dataset.inputModality).toBe('keyboard');

    window.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.documentElement.dataset.inputModality).toBe('pointer');

    // Modified shortcuts like Ctrl+Tab or plain letters do not activate keyboard outline mode.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(document.documentElement.dataset.inputModality).toBe('pointer');
  });
});
