import {
  desktopApi,
  getBootstrapSnapshot,
  initDesktopBootstrap,
  type NativePlaybackSnapshot,
} from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';

const WORKLET_URL = '/audio-tap-worklet.js';
const PROCESSOR_NAME = 'bitchord-audio-tap';
const SOCKET_CONNECT_TIMEOUT_MS = 2500;

/**
 * Taps processed WebAudio output (post-EQ, loudness, spatial, volume) into the Rust WASAPI/ASIO
 * sink whenever a non-default device or exclusive/ASIO mode is selected.
 */
export class DesktopAudioTap {
  private worklet: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private ws: WebSocket | null = null;
  private enabled = false;
  private queue: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly ctx: AudioContext,
    private readonly source: AudioNode,
    private readonly directGain: GainNode,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  setRouting(enable: boolean): Promise<boolean> {
    const next = this.queue.then(() => this.applyRouting(enable));
    this.queue = next.catch(() => false);
    return next;
  }

  flush(): void {
    if (!this.enabled) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send('flush');
      } catch {
        // Ignore transient close; invoke below also clears the Rust ring buffer.
      }
    }
    void desktopApi.audioFlushTap().catch(() => {});
  }

  private async applyRouting(enable: boolean): Promise<boolean> {
    if (!enable) {
      this.enabled = false;
      this.worklet?.port.postMessage({ enabled: false });
      this.directGain.gain.setValueAtTime(1, this.ctx.currentTime);
      const updated = await desktopApi.audioStopTap().catch(() => null);
      if (updated) queryClient.setQueryData(['desktop', 'audio', 'snapshot'], updated);
      return false;
    }

    try {
      await this.ensureWorkletConnected();
      await this.ensureSocketOpen();
      const cached = queryClient.getQueryData<NativePlaybackSnapshot>(['desktop', 'audio', 'snapshot']);
      if (!this.enabled || !cached?.tapActive) {
        const updated = await desktopApi.audioStartTap();
        queryClient.setQueryData(['desktop', 'audio', 'snapshot'], updated);
      }
      this.directGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.worklet?.port.postMessage({ enabled: true });
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn('[audioTap] Failed to enable desktop audio tap:', err);
      this.enabled = false;
      this.worklet?.port.postMessage({ enabled: false });
      this.directGain.gain.setValueAtTime(1, this.ctx.currentTime);
      return false;
    }
  }

  private async ensureWorkletConnected(): Promise<void> {
    if (this.worklet) return;
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(this.ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const zero = new GainNode(this.ctx, { gain: 0 });
    this.source.connect(node);
    node.connect(zero);
    zero.connect(this.ctx.destination);
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (!this.enabled) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(ev.data);
      }
    };
    this.worklet = node;
    this.silentSink = zero;
  }

  private async ensureSocketOpen(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch {
        // Ignore stale close errors.
      }
      this.ws = null;
    }

    const bootstrap = getBootstrapSnapshot() ?? (await initDesktopBootstrap());
    const url = bootstrap?.audioTapUrl;
    if (!url) {
      throw new Error('Desktop audio tap server URL unavailable');
    }

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const timer = window.setTimeout(() => {
        ws.close();
        reject(new Error('Audio tap WebSocket connection timed out'));
      }, SOCKET_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        window.clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Audio tap WebSocket failed to connect'));
      };
    });

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null;
        if (this.enabled) {
          this.enabled = false;
          this.worklet?.port.postMessage({ enabled: false });
          this.directGain.gain.setValueAtTime(1, this.ctx.currentTime);
        }
      }
    };

    this.ws = socket;
    return socket;
  }

  dispose(): void {
    this.enabled = false;
    this.worklet?.port.postMessage({ enabled: false });
    try {
      this.worklet?.disconnect();
      this.silentSink?.disconnect();
    } catch {
      // Ignore disconnect errors on shutdown.
    }
    try {
      this.ws?.close();
    } catch {
      // Ignore close errors.
    }
    this.worklet = null;
    this.silentSink = null;
    this.ws = null;
  }
}
