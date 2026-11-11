import { wavBase64 } from './audio-utils.js';
const BASE = 'http://127.0.0.1:3000';
let recording = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function event(state, name, payload = {}, error = '') {
  const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_EVENT', tabId: state.tabId, event: name, payload, error });
  if (!response?.success) throw new Error(response?.error || 'Mất kết nối trang YouTube.');
  if (response.data?.success === false) throw new Error(response.data.error || 'Không điều khiển được video.');
  return response.data;
}
async function api(path, options = {}) {
  const response = await fetch(BASE + path, { ...options, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `TAI Desktop HTTP ${response.status}`);
  return result;
}
async function stop() {
  const state = recording;
  recording = null;
  if (!state) return;
  state.stopped = true;
  state.audio?.pause(); state.finishAudio?.();
  state.stream.getTracks().forEach(track => track.stop());
  await state.context.close();
}
async function playSegment(state, segment) {
  if (state.stopped) return;
  const audio = new Audio(BASE + segment.audioUrl);
  state.audio = audio;
  await new Promise((resolve, reject) => {
    state.finishAudio = resolve;
    audio.onended = resolve;
    audio.onerror = () => reject(new Error('Không phát được giọng đọc đã dịch.'));
    audio.onloadedmetadata = () => {
      audio.playbackRate = Number.isFinite(audio.duration) ? Math.min(1.65, Math.max(1, audio.duration / (segment.end - segment.start))) : 1;
      audio.play().catch(reject);
    };
  });
}
async function processWindow(state, window) {
  const submitted = await api('/audio-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: state.videoId, start: window.start, audioBase64: window.audioBase64 }) });
  const deadline = Date.now() + 190000;
  while (!state.stopped) {
    const job = await api(`/audio-jobs/${submitted.jobId}`);
    if (job.status === 'ERROR') throw new Error(job.error);
    if (job.status === 'READY') {
      await event(state, 'PROGRESS', { prepared: window.start + window.duration });
      if (state.mode === 'listen') for (const segment of job.segments || []) await playSegment(state, segment);
      return;
    }
    if (Date.now() > deadline) throw new Error('Worker chưa xử lý xong sau 190 giây. Kiểm tra Colab.');
    await sleep(1000);
  }
}
async function drain(state) {
  if (state.draining) return;
  state.draining = true;
  try {
    while (state.queue.length && !state.stopped) {
      const window = state.queue.shift();
      await processWindow(state, window);
      if (state.paused && !state.finished && !state.stopped) {
        state.paused = false;
        state.node.port.postMessage({ action: 'resume' });
        await event(state, 'PLAY');
      }
    }
    if (state.finished && !state.stopped) { await stop(); await event(state, 'DONE'); }
  } catch (error) { await stop(); await event(state, 'ERROR', {}, error.message).catch(() => {}); }
  finally { state.draining = false; }
}
async function start(message) {
  await stop();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false });
  let context;
  try { context = new AudioContext({ sampleRate: 16000 }); }
  catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  const state = { ...message, stream, context, queue: [], cursor: message.start, stopped: false, finished: false, paused: false, draining: false };
  recording = state;
  try {
    await context.audioWorklet.addModule('pcm-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'tai-pcm-recorder');
    state.node = node;
    source.connect(node);
    const silence = context.createGain(); silence.gain.value = 0;
    node.connect(silence).connect(context.destination);
    // The original tab remains the capture source. Translated audio is played
    // from this extension document, outside the captured tab, avoiding feedback.
    if (state.mode === 'listen') { const quiet = context.createGain(); quiet.gain.value = 0.12; source.connect(quiet).connect(context.destination); }
    node.port.onmessage = async ({ data }) => {
      if (state.stopped) return;
      if (data.finished) { state.finished = true; void drain(state); return; }
      if (!data.samples) return;
      const samples = new Float32Array(data.samples);
      const duration = samples.length / context.sampleRate;
      if (duration < 0.1) return;
      const window = { start: state.cursor, duration, audioBase64: wavBase64(samples, context.sampleRate) };
      state.cursor += duration;
      state.queue.push(window);
      if (state.mode === 'prepare' || state.queue.length >= 2) {
        state.paused = true; node.port.postMessage({ action: 'pause' });
        const paused = await event(state, 'PAUSE', { reason: 'Đang nhận diện, dịch và tạo giọng đọc…' }).catch(() => null);
        if (Number.isFinite(paused?.time)) state.cursor = paused.time;
      }
      void drain(state);
    };
    stream.getAudioTracks()[0].onended = () => { if (!state.stopped) { void stop().then(() => event(state, 'ERROR', {}, 'Chrome đã dừng chia sẻ audio.')); } };
    await context.resume();
  } catch (error) { await stop(); throw error; }
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  const operation = message.action === 'START' ? start(message) : message.action === 'STOP' ? stop() : message.action === 'FINISH' ? Promise.resolve(recording?.node.port.postMessage({ action: 'flush' })) : Promise.reject(new Error('Unknown action'));
  operation.then(() => sendResponse({ success: true })).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
