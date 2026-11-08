const NEST_BASE_URL = "http://localhost:3000";

let chunkBuffer = [];
let audioPool = new Map();
let currentPlayingId = null;
let activeAudio = null;
let originalVideo = null;
let isVoiceoverEnabled = false;
let pollingTimer = null;

// Bộ SVG icon chuẩn style YouTube player
const ICONS = {
  idle: `
    <svg viewBox="0 0 24 24">
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
    </svg>
  `,
  loading: `
    <svg class="yt-voiceover-spin" viewBox="0 0 24 24">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
    </svg>
  `,
  playing: `
    <svg viewBox="0 0 24 24" style="fill: #3ea6ff;">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
    </svg>
  `,
  error: `
    <svg viewBox="0 0 24 24" style="fill: #ff4e45;">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
    </svg>
  `
};

function getVideoId() {
  return new URLSearchParams(window.location.search).get("v");
}

function preloadUpcomingAudio(currentTime) {
  const upcomingChunks = chunkBuffer.filter(
    (c) => c.start >= currentTime && c.start <= currentTime + 8
  );

  for (const chunk of upcomingChunks) {
    if (!audioPool.has(chunk.id)) {
      const audio = new Audio(`${NEST_BASE_URL}${chunk.audioUrl}`);
      audio.preload = "auto";
      audioPool.set(chunk.id, audio);
    }
  }
}

async function fetchClientCaptions() {
  try {
    const player = document.querySelector("#movie_player");
    const playerResponse = player?.getPlayerResponse
      ? player.getPlayerResponse()
      : window.ytInitialPlayerResponse;
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks || tracks.length === 0) return null;

    const selectedTrack =
      tracks.find((t) => t.languageCode.startsWith("en")) || tracks[0];
    const res = await fetch(selectedTrack.baseUrl + "&fmt=json3");
    const data = await res.json();

    const parsed = [];
    for (const ev of data.events || []) {
      if (!ev.segs || ev.tStartMs === undefined) continue;
      const text = ev.segs
        .map((s) => s.utf8 || "")
        .join("")
        .trim();
      if (!text || text === "\n") continue;

      const start = Number((ev.tStartMs / 1000).toFixed(2));
      const duration = Number(((ev.dDurationMs || 2000) / 1000).toFixed(2));
      parsed.push({ start, end: Number((start + duration).toFixed(2)), text });
    }
    return parsed;
  } catch (err) {
    console.error("Lỗi lấy caption:", err);
    return null;
  }
}

function setupAudioController() {
  originalVideo = document.querySelector("video");
  if (!originalVideo) return;

  originalVideo.addEventListener("pause", () => {
    if (activeAudio && !activeAudio.paused) activeAudio.pause();
  });

  originalVideo.addEventListener("play", () => {
    if (isVoiceoverEnabled && activeAudio && activeAudio.paused && currentPlayingId !== null) {
      activeAudio.play().catch(() => {});
    }
  });

  originalVideo.addEventListener("seeking", () => {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.currentTime = 0;
    }
    currentPlayingId = null;
    originalVideo.volume = 1.0;
    fetchChunks(originalVideo.currentTime);
  });

  originalVideo.addEventListener("timeupdate", () => {
    if (!isVoiceoverEnabled || chunkBuffer.length === 0) return;

    const currTime = originalVideo.currentTime;
    preloadUpcomingAudio(currTime);

    const activeChunk = chunkBuffer.find(
      (c) => currTime >= c.start && currTime < c.end
    );

    if (activeChunk) {
      if (currentPlayingId !== activeChunk.id) {
        if (activeAudio) {
          activeAudio.pause();
          activeAudio.currentTime = 0;
        }

        currentPlayingId = activeChunk.id;

        let audio = audioPool.get(activeChunk.id);
        if (!audio) {
          audio = new Audio(`${NEST_BASE_URL}${activeChunk.audioUrl}`);
          audioPool.set(activeChunk.id, audio);
        }
        activeAudio = audio;

        const timeOffset = Math.max(0, currTime - activeChunk.start);
        const allowedDuration = activeChunk.end - activeChunk.start;

        const playWithSync = () => {
          if (activeAudio !== audio) return;

          const rawAudioDuration = audio.duration;
          if (rawAudioDuration && allowedDuration > 0) {
            const neededSpeed = rawAudioDuration / allowedDuration;
            audio.playbackRate = Math.min(1.65, Math.max(1.0, neededSpeed));
          } else {
            audio.playbackRate = 1.0;
          }

          audio.currentTime = timeOffset;
          audio.play().catch(() => {});
          originalVideo.volume = 0.15;
        };

        if (audio.readyState >= 1) {
          playWithSync();
        } else {
          audio.onloadedmetadata = playWithSync;
        }
      }
    } else {
      if (activeAudio && !activeAudio.paused) {
        activeAudio.pause();
        activeAudio.currentTime = 0;
      }
      currentPlayingId = null;
      originalVideo.volume = 1.0;
    }
  });
}

function fetchChunks(fromTime = 0) {
  const videoId = getVideoId();
  if (!videoId) return;

  chrome.runtime.sendMessage(
    {
      action: "FETCH_CHUNKS",
      payload: { videoId, fromTime },
    },
    (response) => {
      if (response && response.success && response.data?.chunks) {
        response.data.chunks.forEach((newChunk) => {
          if (!chunkBuffer.some((c) => c.id === newChunk.id)) {
            chunkBuffer.push(newChunk);
          }
        });
        chunkBuffer.sort((a, b) => a.start - b.start);
      }
    }
  );
}

function injectButton() {
  if (document.getElementById("btn-yt-voiceover")) return;

  const rightControls = document.querySelector(".ytp-right-controls");
  if (!rightControls) return;

  const btn = document.createElement("button");
  btn.id = "btn-yt-voiceover";
  btn.className = "ytp-button yt-voiceover-btn";
  btn.innerHTML = ICONS.idle;
  btn.title = "Bật lồng tiếng AI tiếng Việt (Tua về 0s)";

  btn.onclick = async () => {
    const videoId = getVideoId();
    if (!videoId) return;

    originalVideo = document.querySelector("video");

    // 1. Tua video về đầu 0s ngay khi click
    if (originalVideo) {
      originalVideo.currentTime = 0;
      originalVideo.pause();
    }

    // Reset trạng thái audio cũ nếu đang chạy
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.currentTime = 0;
    }
    chunkBuffer = [];
    audioPool.clear();
    currentPlayingId = null;

    btn.innerHTML = ICONS.loading;
    btn.title = "Đang trích xuất phụ đề...";

    const captions = await fetchClientCaptions();

    btn.title = "Đang đệm âm thanh tiếng Việt...";

    chrome.runtime.sendMessage(
      {
        action: "START_VOICEOVER",
        payload: { videoId, subtitles: captions },
      },
      (response) => {
        if (!response || !response.success) {
          btn.innerHTML = ICONS.error;
          btn.title = "Lỗi kết nối tới NestJS backend";
          return;
        }

        if (response.data.status === "NO_SUBTITLES") {
          btn.innerHTML = ICONS.error;
          btn.title = "Video không có phụ đề";
          return;
        }

        isVoiceoverEnabled = true;
        btn.innerHTML = ICONS.playing;
        btn.title = "Đang lồng tiếng AI";

        setupAudioController();

        // Kéo chunk từ mốc 0s và bắt đầu phát video
        fetchChunks(0);
        if (originalVideo) {
          originalVideo.play().catch(() => {});
        }

        if (pollingTimer) clearInterval(pollingTimer);
        pollingTimer = setInterval(() => {
          if (originalVideo) fetchChunks(originalVideo.currentTime);
        }, 3000);
      }
    );
  };

  rightControls.prepend(btn);
}

setInterval(() => {
  if (location.pathname === "/watch") {
    injectButton();
  }
}, 1000);