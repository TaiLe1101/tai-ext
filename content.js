const DESKTOP_URL = "http://127.0.0.1:3000";
const ICONS = {
  idle: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM5 11h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h-2v-3.08A7 7 0 0 1 5 11z"/></svg>',
  loading: '<svg class="yt-voiceover-spin" viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  playing: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm11-5v2a6 6 0 0 1 0 12v2a8 8 0 0 0 0-16z"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'
};
let session = 0;
let enabled = false;
let loading = false;
let currentId = null;
let activeAudio = null;
let video = null;
let savedVolume = 1;
let chunks = [];
let pool = new Map();
let listeners = null;
let polling = null;
let pageVideoId = getVideoId();
function getVideoId() { return new URLSearchParams(location.search).get("v"); }
function buttonState(state, title) {
  const button = document.getElementById("btn-yt-voiceover");
  if (button) { button.innerHTML = ICONS[state]; button.title = title; button.setAttribute("aria-label", title); }
}
async function request(action, payload) {
  const response = await chrome.runtime.sendMessage({ action, payload });
  if (!response?.success) throw new Error(response?.error || "Extension mất kết nối. Hãy tải lại trang YouTube.");
  return response.data;
}
function stop() {
  session++;
  enabled = loading = false;
  clearTimeout(polling);
  listeners?.abort();
  listeners = null;
  for (const audio of pool.values()) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
  pool.clear();
  activeAudio = null;
  currentId = null;
  chunks = [];
  if (video) video.volume = savedVolume;
  video = null;
  buttonState("idle", "Bật lồng tiếng AI tiếng Việt (tua về đầu)");
}
function audioFor(chunk) {
  if (!pool.has(chunk.id)) {
    const audio = new Audio(`${DESKTOP_URL}${chunk.audioUrl}`);
    audio.preload = "auto";
    audio.onerror = () => {
      if (enabled) { stop(); buttonState("error", "Không tải được âm thanh. Kiểm tra TAI Desktop và quyền truy cập mạng cục bộ của Chrome."); }
    };
    pool.set(chunk.id, audio);
  }
  return pool.get(chunk.id);
}
function syncAudio() {
  if (!enabled || !video) return;
  const now = video.currentTime;
  for (const chunk of chunks) if (chunk.end > now && chunk.start <= now + 8) audioFor(chunk);
  for (const [id, audio] of pool) {
    const chunk = chunks.find(c => c.id === id);
    if (chunk && (chunk.end < now - 15 || chunk.start > now + 20) && audio !== activeAudio) {
      audio.pause(); audio.removeAttribute("src"); audio.load(); pool.delete(id);
    }
  }
  const chunk = chunks.find(c => now >= c.start && now < c.end);
  if (!chunk) {
    activeAudio?.pause(); activeAudio = null; currentId = null;
    video.volume = savedVolume;
    return;
  }
  const audio = audioFor(chunk);
  if (currentId !== chunk.id) { activeAudio?.pause(); activeAudio = audio; currentId = chunk.id; }
  const play = () => {
    if (!enabled || activeAudio !== audio || !video) return;
    if (video.currentTime < chunk.start || video.currentTime >= chunk.end) return;
    const speed = Math.min(1.65, Math.max(1, audio.duration / (chunk.end - chunk.start) || 1));
    const offset = (video.currentTime - chunk.start) * speed;
    audio.playbackRate = Math.min(4, speed * video.playbackRate);
    if (Math.abs(audio.currentTime - offset) > 0.35 && offset < audio.duration) audio.currentTime = offset;
    audio.muted = video.muted;
    if (!video.paused && offset < audio.duration && audio.paused) {
      void audio.play().then(() => { if (enabled && activeAudio === audio && video) video.volume = savedVolume * 0.15; }).catch(() => {});
    }
  };
  if (audio.readyState >= 1) play();
  else audio.onloadedmetadata = play;
}
async function fetchChunks(id, token) {
  const data = await request("FETCH_CHUNKS", { videoId: id, fromTime: video?.currentTime || 0 });
  if (token !== session || id !== getVideoId()) return null;
  if (data.status === "ERROR") throw new Error(data.error || "AI worker xử lý thất bại. Bấm lại để thử tiếp các đoạn còn thiếu.");
  for (const chunk of data.chunks || []) if (!chunks.some(c => c.id === chunk.id)) chunks.push(chunk);
  chunks.sort((a, b) => a.start - b.start);
  return data;
}
async function poll(id, token) {
  if (token !== session || !enabled) return;
  try { await fetchChunks(id, token); if (token === session) syncAudio(); }
  catch (error) { if (token === session) { stop(); buttonState("error", error.message); } return; }
  if (token === session) polling = setTimeout(() => { void poll(id, token); }, 1500);
}
async function start() {
  if (enabled || loading) { stop(); return; }
  stop();
  const id = getVideoId();
  const token = session;
  video = document.querySelector("video");
  if (!id || !video) return;
  savedVolume = video.volume;
  loading = true;
  video.pause();
  video.currentTime = 0;
  buttonState("loading", "Đang lấy phụ đề và chuẩn bị giọng đọc… Bấm để hủy.");
  try {
    // A cached video should start without waiting for YouTube caption requests.
    const cached = await request("FETCH_CHUNKS", { videoId: id, fromTime: 0 });
    const subtitles = cached.chunks?.length ? null : await request("FETCH_CAPTIONS", { videoId: id }).catch(() => null);
    if (token !== session || id !== getVideoId()) return;
    await request("START_VOICEOVER", { videoId: id, subtitles });
    const deadline = Date.now() + 45000;
    while (token === session && id === getVideoId()) {
      const data = await fetchChunks(id, token);
      if (!data) return;
      if (chunks.length) break;
      if (Date.now() > deadline) throw new Error("Chưa có âm thanh sau 45 giây. Kiểm tra AI worker trong TAI Desktop rồi thử lại.");
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    if (token !== session || !video) return;
    loading = false;
    enabled = true;
    listeners = new AbortController();
    for (const event of ["timeupdate", "play", "ratechange", "seeked"]) video.addEventListener(event, syncAudio, { signal: listeners.signal });
    video.addEventListener("pause", () => activeAudio?.pause(), { signal: listeners.signal });
    video.addEventListener("seeking", () => { activeAudio?.pause(); currentId = null; if (video) video.volume = savedVolume; }, { signal: listeners.signal });
    buttonState("playing", "Đang lồng tiếng AI · Bấm để tắt");
    await video.play();
    void poll(id, token);
  } catch (error) { if (token === session) { stop(); buttonState("error", error.message); } }
}
function injectButton() {
  if (document.getElementById("btn-yt-voiceover")) return;
  const controls = document.querySelector(".ytp-right-controls");
  if (!controls) return;
  const button = document.createElement("button");
  button.id = "btn-yt-voiceover";
  button.className = "ytp-button yt-voiceover-btn";
  button.onclick = () => { void start(); };
  controls.prepend(button);
  buttonState("idle", "Bật lồng tiếng AI tiếng Việt (tua về đầu)");
}
function navigation() {
  const id = getVideoId();
  if (id !== pageVideoId || location.pathname !== "/watch") { stop(); pageVideoId = id; }
  if (location.pathname === "/watch") injectButton();
}
document.addEventListener("yt-navigate-finish", navigation);
setInterval(navigation, 1000);
