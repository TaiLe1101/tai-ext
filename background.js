// Background Service Worker: đóng vai trò proxy gọi NestJS local
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_VOICEOVER") {
    fetch("http://localhost:3000/voiceover/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.payload),
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Bắt buộc để giữ kênh async sendResponse
  }

  if (request.action === "FETCH_CHUNKS") {
    const { videoId, fromTime } = request.payload;
    fetch(`http://localhost:3000/voiceover/chunks?videoId=${videoId}&fromTime=${fromTime}`)
      .then((res) => res.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});