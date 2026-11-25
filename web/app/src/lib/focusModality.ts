const KEYBOARD_NAV_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

let initialized = false;

/**
 * Tracks whether the user is actively navigating via keyboard or pointer so
 * click and programmatic focus never flash focus rings while Tab navigation
 * remains clearly indicated.
 */
export function initFocusModality(): void {
  if (initialized || typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }
  initialized = true;

  const root = document.documentElement;
  root.dataset.inputModality = 'pointer';

  const setPointer = () => {
    if (root.dataset.inputModality !== 'pointer') {
      root.dataset.inputModality = 'pointer';
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (KEYBOARD_NAV_KEYS.has(ev.key) && root.dataset.inputModality !== 'keyboard') {
      root.dataset.inputModality = 'keyboard';
    }
  };

  window.addEventListener('pointerdown', setPointer, true);
  window.addEventListener('mousedown', setPointer, true);
  window.addEventListener('touchstart', setPointer, true);
  window.addEventListener('keydown', onKeyDown, true);
}
