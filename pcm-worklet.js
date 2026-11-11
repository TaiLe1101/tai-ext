class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.frames = []; this.count = 0; this.enabled = true;
    this.port.onmessage = ({ data }) => {
      if (data.action === 'pause') { this.enabled = false; this.frames = []; this.count = 0; }
      if (data.action === 'resume') this.enabled = true;
      if (data.action === 'flush') { this.enabled = false; this.flush(); this.port.postMessage({ finished: true }); }
    };
  }
  flush() {
    if (!this.count) return;
    const samples = new Float32Array(this.count); let offset = 0;
    for (const frame of this.frames) { samples.set(frame, offset); offset += frame.length; }
    this.frames = []; this.count = 0;
    this.port.postMessage({ samples: samples.buffer }, [samples.buffer]);
  }
  process(inputs) {
    const channels = inputs[0];
    if (this.enabled && channels?.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      this.frames.push(mono); this.count += mono.length;
      if (this.count >= sampleRate * 15) this.flush();
    }
    return true;
  }
}
registerProcessor('tai-pcm-recorder', PCMRecorder);
