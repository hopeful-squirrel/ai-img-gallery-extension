// 갤러리 프롬프트 패널 - 백그라운드 서비스 워커
// 툴바 아이콘 클릭 → 사이드패널 열기, NAI 콘텐츠 스크립트의 "저장" 요청 중계

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'nai:saveSelection') return;

  // 패널이 열리기 전에 도착할 수 있으므로 세션 스토리지에 보관 → 패널이 로드/포커스 시 읽음
  chrome.storage.session
    .set({ pendingSave: { ...msg.payload, tabId: sender.tab ? sender.tab.id : null } })
    .catch(() => {});

  if (sender.tab && sender.tab.id != null) {
    // 콘텐츠 스크립트의 클릭(사용자 제스처)에서 전달된 요청이므로 사이드패널을 열 수 있음
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  }

  // 이미 열려 있는 패널에도 알림
  chrome.runtime.sendMessage({ type: 'panel:pendingSave' }).catch(() => {});
});
