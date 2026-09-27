// Only capture/transfer here; decoding runs in Vosk's separate worker.
class NumberCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(1024);
    this.offset = 0;
    this.startFrame = 0;
    this.stopped = false;
    this.receivedInput = false;
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
  process(inputs, outputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) this.receivedInput = true;
    // Preserve elapsed audio time across input gaps after capture begins.
    // Otherwise word offsets compress those gaps and appear too early.
    if (this.receivedInput) {
      const length = channel?.length ?? outputs?.[0]?.[0]?.length ?? 128;
      for (let index = 0; index < length; index++) {
        if (this.offset === 0) this.startFrame = currentFrame + index;
        this.samples[this.offset++] = channel?.[index] ?? 0;
        if (this.offset === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("number-capture", NumberCapture);
