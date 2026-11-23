import { isTauriDesktop } from '@/desktop/tauriBridge';
import { DesktopAudioTap } from '../audioTap';
import { WebAudioEqualizer } from '../webAudioEq';
import { AutoDJ, type AutomixHost, type AutoDJSnapshot } from './engine/autodj';
import { Deck } from './engine/deck';
import { LoopDeck } from './engine/loopDeck';
import type { TransitionPlan } from './engine/transition-scheduler';

export type { AutomixHost, AutoDJSnapshot, TransitionPlan };
export type { MixWindow } from './engine/autodj';
export type { LoopMixPlan, SungSpans } from './engine/loopMix';
export { sungSpansFromLines } from './engine/loopMix';
export { analyzer } from './analysis/analyzer';

export { AUTOMIX_BARS } from './choices';

export interface AutomixGraph {
  ctx: AudioContext;
  /** The user's volume and mute. */
  master: GainNode;
  /** 10-slot Web Audio parametric & tone equalizer + limiter on the master bus. */
  eq: WebAudioEqualizer;
  /** Gates direct Chromium audio output when the desktop Rust audio tap is active. */
  directGain: GainNode;
  tap: DesktopAudioTap | null;
  decks: Deck[];
  dj: AutoDJ;
}

/**
 * Routes the player's two <audio> elements through Web Audio, one AutoMix
 * deck each, and builds the mix loop over them. A media element can be
 * routed only once, so this is for the life of the page; from then on the
 * elements stay at volume 1 and the graph carries volume, EQ, and crossfades.
 */
export function createAutomixGraph(
  audios: HTMLAudioElement[],
  host: (decks: Deck[]) => Omit<AutomixHost, 'ctx' | 'loopDecks'>,
  onUpdate?: (snap: AutoDJSnapshot) => void,
): AutomixGraph {
  const ctx = new AudioContext({ latencyHint: 'playback' });
  void ctx.resume();
  const directGain = new GainNode(ctx, { gain: 1 });
  directGain.connect(ctx.destination);
  const eq = new WebAudioEqualizer(ctx, directGain);
  const tap = isTauriDesktop() ? new DesktopAudioTap(ctx, eq.output, directGain) : null;
  const master = new GainNode(ctx, { gain: 1 });
  master.connect(eq.input);
  const decks = audios.map((audio, n) => new Deck(n === 0 ? 'A' : 'B', ctx, audio, master));
  let loops: Promise<[LoopDeck, LoopDeck]> | null = null;
  const loopDecks = () => (loops ??= Promise.all([LoopDeck.create(ctx, master), LoopDeck.create(ctx, master)]));
  const dj = new AutoDJ({ ctx, loopDecks, ...host(decks) }, onUpdate);
  return { ctx, master, eq, directGain, tap, decks, dj };
}
