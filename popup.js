async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.success) throw new Error(result?.error || 'Mất kết nối extension.');
  return result.data;
}
for (const mode of ['prepare', 'listen']) document.getElementById(mode).onclick = async () => {
  const buttons = document.querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await send({ action: 'BEGIN_CAPTURE', tabId: tab.id, mode });
    document.getElementById('message').textContent = 'Đã bắt đầu. Có thể đóng popup; trạng thái hiển thị trên video.';
  } catch (error) { document.getElementById('message').textContent = error.message; }
  finally { buttons.forEach(b => { b.disabled = false; }); }
};
document.getElementById('stop').onclick = async () => {
  try { await send({ action: 'STOP_CAPTURE' }); document.getElementById('message').textContent = 'Đã dừng. Các đoạn hoàn thành được giữ trong cache.'; }
  catch (error) { document.getElementById('message').textContent = error.message; }
};
void send({ action: 'CAPTURE_STATUS' }).then(state => {
  if (state) document.getElementById('message').textContent = state.mode === 'prepare' ? 'Đang chuẩn bị bản dịch.' : 'Đang nghe dịch trễ.';
}).catch(error => { document.getElementById('message').textContent = error.message; });
