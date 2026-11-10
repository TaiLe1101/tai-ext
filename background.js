const DESKTOP_URL = "http://127.0.0.1:3000";

// Read the player response in MAIN because content scripts have isolated globals.
async function captions(tabId, expectedVideoId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", args: [expectedVideoId],
    func: (videoId) => {
      if (new URLSearchParams(location.search).get("v") !== videoId) return null;
      const player = document.querySelector("#movie_player");
      const data = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      if (data?.videoDetails?.videoId !== videoId) return null;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      const track = tracks?.find(t => t.languageCode.startsWith("en")) || tracks?.[0];
      return track?.baseUrl || null;
    }
  });
  if (!result?.result) return null;
  const url = new URL(result.result);
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.pathname !== "/api/timedtext") throw new Error("URL phụ đề không hợp lệ.");
  url.searchParams.set("fmt", "json3");
  const response = await fetch(url.href, { credentials: "include", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`YouTube trả HTTP ${response.status} khi lấy phụ đề.`);
  const data = await response.json();
  return (data.events || []).filter(e => e.segs && Number.isFinite(e.tStartMs)).map(e => ({
    start: e.tStartMs / 1000,
    end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000,
    text: e.segs.map(s => s.utf8 || "").join("").replace(/\s+/g, " ").trim()
  })).filter(s => s.text);
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
