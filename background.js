const DESKTOP_URL = "http://127.0.0.1:3000";
let starting = false;
let creating = null;

async function local(path, options = {}) {
  let response;
  try { response = await fetch(`${DESKTOP_URL}${path}`, { ...options, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("Không kết nối được TAI Desktop. Hãy mở app và kiểm tra cổng 3000."); }
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`TAI Desktop trả dữ liệu không phải JSON (HTTP ${response.status}). Kiểm tra cổng 3000.`); }
  if (!response.ok) throw new Error(data?.error || `TAI Desktop HTTP ${response.status}`);
  if (!data || typeof data !== 'object') throw new Error('Phản hồi TAI Desktop không hợp lệ.');
  return data;
}
async function captureState() { return (await chrome.storage.session.get('capture')).capture || null; }
async function notify(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}
async function offscreen() {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Thu audio của tab người dùng chọn để nhận diện và dịch bằng worker đã cấu hình.' });
  })().finally(() => { creating = null; });
  return creating;
}
async function stopCapture(error = '') {
  const state = await captureState();
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'STOP' }).catch(() => {});
  await chrome.storage.session.remove('capture');
  await chrome.action.setBadgeText({ text: '' });
  if (state) await notify(state.tabId, { action: 'CAPTURE_DONE', error }).catch(() => {});
}
async function beginCapture(tabId, mode) {
  if (starting) throw new Error('Đang bắt đầu thu một tab.');
  if (!['prepare', 'listen'].includes(mode)) throw new Error('Chế độ không hợp lệ.');
  starting = true;
  let initialized = false;
  let attempted = false;
  try {
    if (await captureState()) throw new Error('Đang thu một tab. Hãy dừng phiên hiện tại trước.');
    attempted = true;
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url || '');
    const videoId = url.searchParams.get('v');
    if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/watch' || !/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('Mở video YouTube trước.');
    await local('/health');
    await local('/worker-health');
    const cached = await local(`/voiceover/chunks?${new URLSearchParams({ videoId, fromTime: 0 })}`);
    // Must originate from the user's extension popup click (activeTab grant).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await offscreen();
    const init = await notify(tabId, { action: 'CAPTURE_INIT', videoId, mode, start: mode === 'prepare' ? cached.preparedUntil || 0 : null });
    if (!init?.success) throw new Error(init?.error || 'Tải lại trang YouTube rồi thử lại.');
    initialized = true;
    const state = { tabId, videoId, mode };
    await chrome.storage.session.set({ capture: state });
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'START', streamId, ...state, start: init.start });
    if (!response?.success) throw new Error(response?.error || 'Không thu được audio của tab.');
    const played = await notify(tabId, { action: 'CAPTURE_PLAY' });
    if (!played?.success) throw new Error(played?.error || 'Không phát được video.');
    await chrome.action.setBadgeText({ text: mode === 'prepare' ? 'PREP' : 'LIVE' });
    await chrome.action.setBadgeBackgroundColor({ color: '#426ef1' });
    return state;
  } catch (error) {
    if (attempted) await stopCapture(error.message);
    if (attempted && !initialized) await notify(tabId, { action: 'CAPTURE_DONE', error: error.message }).catch(() => {});
    throw error;
  } finally { starting = false; }
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === 'offscreen') return;
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const recording = sender.url === chrome.runtime.getURL('offscreen.html');
  const page = sender.tab && sender.url?.startsWith('https://www.youtube.com/');
  const actions = {
    CAPTURE_STATUS: async () => { if (!popup) throw new Error('Không có quyền.'); return captureState(); },
    BEGIN_CAPTURE: () => { if (!popup) throw new Error('Bấm nút trong popup extension để cho phép thu tab.'); return beginCapture(request.tabId, request.mode); },
    STOP_CAPTURE: async () => {
      const active = await captureState();
      if (!popup && (!page || active?.tabId !== sender.tab.id)) throw new Error('Không có quyền.');
      await stopCapture(); return {};
    },
    CAPTURE_EVENT: async () => {
      if (!recording) throw new Error('Không có quyền.');
      const active = await captureState();
      if (!active || active.tabId !== request.tabId) return {};
      if (request.event === 'DONE' || request.event === 'ERROR') { await stopCapture(request.error || ''); return {}; }
      return notify(active.tabId, { action: `CAPTURE_${request.event}`, ...request.payload });
    },
    FINISH_CAPTURE: async () => {
      const active = await captureState();
      if (!page || active?.tabId !== sender.tab.id) throw new Error('Không có quyền.');
      return chrome.runtime.sendMessage({ target: 'offscreen', action: 'FINISH' });
    },
    FETCH_CHUNKS: () => { if (!page) throw new Error('Không có quyền.'); return local(`/voiceover/chunks?${new URLSearchParams({ videoId: request.payload?.videoId, fromTime: request.payload?.fromTime ?? 0 })}`); },
    START_VOICEOVER: () => { if (!page) throw new Error('Không có quyền.'); return local('/voiceover/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.payload) }); }
  };
  if (!Object.hasOwn(actions, request.action)) return;
  Promise.resolve().then(actions[request.action]).then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void captureState().then(state => { if (state?.tabId === tabId) return stopCapture(); }); });
