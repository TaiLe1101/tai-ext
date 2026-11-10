const DESKTOP_URL = "http://127.0.0.1:3000";
const CAPTION_STATE_KEY = "tai:caption-state:v1";
const CAPTION_TTL = 24 * 60 * 60 * 1000;
const NO_CAPTION_TTL = 5 * 60 * 1000;
const ERROR_COOLDOWN = 60 * 1000;
const REQUEST_GAP = 5 * 1000;
let captionTask = null;

async function captionState() {
  try {
    const saved = (await chrome.storage.local.get(CAPTION_STATE_KEY))[CAPTION_STATE_KEY] || {};
    return { entries: saved.entries || {}, nextRequestAt: saved.nextRequestAt || 0,
      blockedUntil: saved.blockedUntil || 0, failures: saved.failures || 0 };
  } catch { throw new Error("Không đọc được cache phụ đề của extension. Chưa gửi yêu cầu tới YouTube."); }
}
async function saveCaptionState(state) {
  // Persist cooldown BEFORE fetching. Worker/browser restarts cannot reset it.
  const entries = Object.entries(state.entries).filter(([, entry]) => entry.expiresAt > Date.now())
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 20);
  while (entries.length && new TextEncoder().encode(JSON.stringify(entries)).byteLength > 4 * 1024 * 1024) entries.pop();
  state.entries = Object.fromEntries(entries);
  try { await chrome.storage.local.set({ [CAPTION_STATE_KEY]: state }); }
  catch { throw new Error("Không lưu được cache/thời gian chờ phụ đề. Hãy kiểm tra bộ nhớ extension trước khi thử lại."); }
}
function remember(state, id, value, ttl) {
  state.entries[id] = { ...value, updatedAt: Date.now(), expiresAt: Date.now() + ttl };
}
function waitMessage(until) {
  return `Đang tạm ngừng lấy phụ đề YouTube. Vui lòng đợi ${Math.max(1, Math.ceil((until - Date.now()) / 1000))} giây rồi bấm lại; extension không tự thử lại.`;
}
function retryAfterUntil(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Date.now() + seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function captions(tabId, expectedVideoId) {
  if (typeof expectedVideoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(expectedVideoId)) return Promise.reject(new Error("Video ID không hợp lệ."));
  if (captionTask) {
    if (captionTask.videoId === expectedVideoId) return captionTask.promise;
    return Promise.reject(new Error("Đang lấy phụ đề cho video khác. Vui lòng đợi rồi bấm lại."));
  }
  const task = { videoId: expectedVideoId, promise: null };
  task.promise = loadCaptions(tabId, expectedVideoId).finally(() => { if (captionTask === task) captionTask = null; });
  captionTask = task;
  return task.promise;
}

// Read the player response in MAIN because content scripts have isolated globals.
async function loadCaptions(tabId, expectedVideoId) {
  const state = await captionState();
  const cached = state.entries[expectedVideoId];
  if (cached?.expiresAt > Date.now()) {
    if (cached.error) throw new Error(`${cached.error} ${waitMessage(cached.expiresAt)}`);
    return cached.subtitles;
  }
  const until = Math.max(state.blockedUntil, state.nextRequestAt);
  if (until > Date.now()) throw new Error(waitMessage(until));
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", args: [expectedVideoId],
    func: (videoId) => {
      if (new URLSearchParams(location.search).get("v") !== videoId) throw new Error("Video đã thay đổi. Hãy bấm lại trên video hiện tại.");
      const player = document.querySelector("#movie_player");
      const data = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      if (data?.videoDetails?.videoId !== videoId) throw new Error("Player chưa tải xong video. Hãy đợi rồi bấm lại.");
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      const track = tracks?.find(t => t.languageCode.startsWith("en")) || tracks?.[0];
      return track?.baseUrl || null;
    }
  });
  if (!result?.result) {
    remember(state, expectedVideoId, { subtitles: null }, NO_CAPTION_TTL);
    await saveCaptionState(state);
    return null;
  }
  const url = new URL(result.result);
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.pathname !== "/api/timedtext") throw new Error("URL phụ đề không hợp lệ.");
  url.searchParams.set("fmt", "json3");
  state.nextRequestAt = Date.now() + REQUEST_GAP;
  remember(state, expectedVideoId, { error: 'Yêu cầu phụ đề trước chưa hoàn tất.' }, ERROR_COOLDOWN);
  await saveCaptionState(state);
  let response;
  try {
    response = await fetch(url.href, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`YouTube trả HTTP ${response.status} khi lấy phụ đề.`);
    const data = await response.json();
    if (!Array.isArray(data.events)) throw new Error("YouTube chưa trả dữ liệu phụ đề JSON3 hợp lệ.");
    const subtitles = data.events.filter(e => Array.isArray(e.segs) && Number.isFinite(e.tStartMs)).map(e => ({
      start: e.tStartMs / 1000,
      end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000,
      text: e.segs.map(s => s.utf8 || "").join("").replace(/\s+/g, " ").trim()
    })).filter(s => s.text);
    if (new TextEncoder().encode(JSON.stringify(subtitles)).byteLength > 1024 * 1024) throw new Error("Phụ đề vượt giới hạn 1 MB của cache extension.");
    state.failures = 0;
    state.blockedUntil = 0;
    remember(state, expectedVideoId, { subtitles: subtitles.length ? subtitles : null }, subtitles.length ? CAPTION_TTL : NO_CAPTION_TTL);
    await saveCaptionState(state);
    return subtitles.length ? subtitles : null;
  } catch (error) {
    const limited = response?.status === 403 || response?.status === 429;
    if (limited) state.failures++;
    const backoff = limited ? Math.min(6 * 60 * 60 * 1000, 30 * 60 * 1000 * 2 ** Math.min(state.failures - 1, 4)) : ERROR_COOLDOWN;
    state.blockedUntil = Math.max(state.blockedUntil, Date.now() + backoff, retryAfterUntil(response?.headers.get("Retry-After")));
    const message = `${error.message} ${waitMessage(state.blockedUntil)}`;
    remember(state, expectedVideoId, { error: error.message }, state.blockedUntil - Date.now());
    await saveCaptionState(state);
    throw new Error(message);
  }
}
async function local(path, options = {}) {
  let response;
  try { response = await fetch(`${DESKTOP_URL}${path}`, { ...options, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("Không kết nối được TAI Desktop. Hãy mở app và kiểm tra cổng 3000."); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `TAI Desktop trả HTTP ${response.status}.`);
  return data;
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!sender.tab || !sender.url?.startsWith("https://www.youtube.com/")) return;
  const actions = {
    FETCH_CAPTIONS: () => captions(sender.tab.id, request.payload?.videoId),
    START_VOICEOVER: () => local("/voiceover/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.payload)
    }),
    FETCH_CHUNKS: () => local(`/voiceover/chunks?${new URLSearchParams({ videoId: request.payload?.videoId, fromTime: request.payload?.fromTime ?? 0 })}`)
  };
  if (!Object.hasOwn(actions, request.action)) return;
  Promise.resolve().then(actions[request.action]).then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
