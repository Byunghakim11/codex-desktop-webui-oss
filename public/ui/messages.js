// Additive UI label bundle for the new UI-CORE surfaces (context menus,
// favorites, compact header, project "+" and language switch).
// Every key is a NEW `ui.*` key: registering an existing base key throws, so
// this module must never duplicate `public/i18n/en.js` / `ko.js` entries.
// Labels only: no user content, thread titles, paths or tokens belong here.

const en = {
  "ui.context.menuLabel": "Actions",
  "ui.context.messageMenuLabel": "Message actions",
  "ui.context.threadMenuLabel": "Conversation actions",
  "ui.context.open": "Open",
  "ui.context.rename": "Rename",
  "ui.context.copyMessage": "Copy message",
  "ui.context.copyMarkdown": "Copy as Markdown",
  "ui.context.copyLink": "Copy link",
  "ui.context.copyLinkDone": "Link copied without sign-in token",
  "ui.context.copyFailed": "Could not copy to the clipboard",
  "ui.context.openNewTab": "Open in new tab",
  "ui.context.openNewWindow": "Open in new window",
  "ui.context.openBlocked": "The browser blocked the new tab or window",
  "ui.context.favorite": "Add to favorites",
  "ui.context.unfavorite": "Remove from favorites",
  "ui.context.unavailable": "Unavailable right now",
  "ui.favorites.title": "Favorites",
  "ui.favorites.add": "Add favorite",
  "ui.favorites.remove": "Remove favorite",
  "ui.favorites.empty": "No favorite conversations yet",
  "ui.favorites.localOnly": "Favorites stay in this browser and are not app pins",
  "ui.favorites.limit": "Favorite limit reached; remove one first",
  "ui.favorites.storage": "Favorites could not be saved in this browser",
  "ui.header.more": "More",
  "ui.header.search": "Search loaded conversation",
  "ui.header.bookmarks": "Bookmarks",
  "ui.header.files": "Files",
  "ui.header.outline": "Conversation outline",
  "ui.header.export": "Export Markdown",
  "ui.header.activity": "Activity",
  "ui.header.connection": "Connection",
  "ui.header.connected": "Connected to Codex Desktop",
  "ui.header.connectedApp": "Connected to the app",
  "ui.header.desktopOffline": "Desktop app offline",
  "ui.header.reconnecting": "Reconnecting…",
  "ui.header.noProject": "No project",
  "ui.header.project": "Project: {project}",
  "ui.header.actions": "Header actions",
  "ui.project.newThread": "New conversation in {project}",
  "ui.project.newThreadPlain": "New conversation in this project",
  "ui.language.label": "Language",
  "ui.language.english": "English",
  "ui.language.korean": "한국어",
  "ui.transition.blocked": "Finish the current draft, attachment or unsaved file before switching",
  "ui.transition.pending": "Waiting for the current change to finish"
};

const ko = {
  "ui.context.menuLabel": "작업",
  "ui.context.messageMenuLabel": "메시지 작업",
  "ui.context.threadMenuLabel": "대화 작업",
  "ui.context.open": "열기",
  "ui.context.rename": "이름 바꾸기",
  "ui.context.copyMessage": "메시지 복사",
  "ui.context.copyMarkdown": "Markdown으로 복사",
  "ui.context.copyLink": "링크 복사",
  "ui.context.copyLinkDone": "로그인 토큰 없이 링크를 복사했습니다",
  "ui.context.copyFailed": "클립보드에 복사하지 못했습니다",
  "ui.context.openNewTab": "새 탭에서 열기",
  "ui.context.openNewWindow": "새 창에서 열기",
  "ui.context.openBlocked": "브라우저가 새 탭 또는 창을 차단했습니다",
  "ui.context.favorite": "즐겨찾기에 추가",
  "ui.context.unfavorite": "즐겨찾기에서 제거",
  "ui.context.unavailable": "지금은 사용할 수 없습니다",
  "ui.favorites.title": "즐겨찾기",
  "ui.favorites.add": "즐겨찾기 추가",
  "ui.favorites.remove": "즐겨찾기 제거",
  "ui.favorites.empty": "즐겨찾기한 대화가 없습니다",
  "ui.favorites.localOnly": "즐겨찾기는 이 브라우저에만 저장되며 앱의 고정 기능과 다릅니다",
  "ui.favorites.limit": "즐겨찾기 한도에 도달했습니다. 먼저 하나를 제거하세요",
  "ui.favorites.storage": "이 브라우저에 즐겨찾기를 저장하지 못했습니다",
  "ui.header.more": "더보기",
  "ui.header.search": "현재 대화에서 검색",
  "ui.header.bookmarks": "북마크",
  "ui.header.files": "파일",
  "ui.header.outline": "대화 개요",
  "ui.header.export": "Markdown 내보내기",
  "ui.header.activity": "작업 기록",
  "ui.header.connection": "연결",
  "ui.header.connected": "Codex Desktop에 연결됨",
  "ui.header.connectedApp": "앱에 연결됨",
  "ui.header.desktopOffline": "Desktop 앱 오프라인",
  "ui.header.reconnecting": "다시 연결 중…",
  "ui.header.noProject": "프로젝트 없음",
  "ui.header.project": "프로젝트: {project}",
  "ui.header.actions": "헤더 작업",
  "ui.project.newThread": "{project}에서 새 대화",
  "ui.project.newThreadPlain": "이 프로젝트에서 새 대화",
  "ui.language.label": "언어",
  "ui.language.english": "English",
  "ui.language.korean": "한국어",
  "ui.transition.blocked": "전환하기 전에 현재 초안, 첨부 또는 저장하지 않은 파일을 정리하세요",
  "ui.transition.pending": "현재 변경이 끝나기를 기다리는 중"
};

export const uiMessages = Object.freeze({
  en: Object.freeze(en),
  ko: Object.freeze(ko)
});

// Thin wrapper so app code does not need to know the registration contract.
// Returns the number of newly registered keys (0 for a missing registrar).
export function registerUI(registerMessages) {
  if (typeof registerMessages !== "function") return 0;
  return registerMessages(uiMessages);
}
