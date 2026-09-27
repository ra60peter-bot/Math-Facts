// Only capture/transfer here; decoding runs in Vosk's separate worker.
class NumberCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(1024);
    this.offset = 0;
    this.startFrame = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === "stop") {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ stopped: true });
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const samples = this.samples.slice(0, this.offset);
    this.port.postMessage({ samples, startFrame: this.startFrame }, [samples.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let index = 0; index < channel.length; index++) {
        if (this.offset === 0) this.startFrame = currentFrame + index;
        this.samples[this.offset++] = channel[index];
        if (this.offset === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("number-capture", NumberCapture);
