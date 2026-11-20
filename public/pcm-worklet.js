// Captures mono PCM from the microphone and posts Float32Array blocks to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = true;
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.active === 'boolean') this.active = e.data.active;
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.active) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
