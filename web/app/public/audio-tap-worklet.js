const BATCH_BLOCKS = 4;
const BLOCK_FRAMES = 128;
const BATCH_FRAMES = BATCH_BLOCKS * BLOCK_FRAMES;

class BitChordTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.buf = new ArrayBuffer(8 + BATCH_FRAMES * 8);
    this.header = new Uint32Array(this.buf, 0, 2);
    this.pcm = new Float32Array(this.buf, 8);
    this.frameOffset = 0;

    this.port.onmessage = (ev) => {
      if (ev.data && typeof ev.data.enabled === 'boolean') {
        this.enabled = ev.data.enabled;
        this.frameOffset = 0;
      }
    };
  }

  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const left = input[0];
    const right = input[1] ?? left;
    const frames = left ? left.length : BLOCK_FRAMES;
    if (!left || frames === 0) return true;

    for (let i = 0; i < frames; i++) {
      const idx = this.frameOffset * 2;
      this.pcm[idx] = left[i] ?? 0;
      this.pcm[idx + 1] = (right ? right[i] : left[i]) ?? 0;
      this.frameOffset++;

      if (this.frameOffset >= BATCH_FRAMES) {
        this.header[0] = Math.round(sampleRate);
        this.header[1] = 2;
        const outgoing = this.buf;
        this.port.postMessage(outgoing, [outgoing]);
        this.buf = new ArrayBuffer(8 + BATCH_FRAMES * 8);
        this.header = new Uint32Array(this.buf, 0, 2);
        this.pcm = new Float32Array(this.buf, 8);
        this.frameOffset = 0;
      }
    }
    return true;
  }
}

registerProcessor('bitchord-audio-tap', BitChordTapProcessor);
