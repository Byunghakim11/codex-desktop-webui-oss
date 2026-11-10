# Codex Desktop WebUI

[English](README_EN.md) · [MIT License](LICENSE)

Windows의 Codex Desktop을 켜둔 채 브라우저에서 **같은 실행 엔진과 채팅**을 사용하는 셀프호스팅 WebUI입니다. 별도 Codex 인스턴스를 시작하지 않으며 기존 Codex 로그인을 사용합니다.

이 저장소는 [DusuWorks/codex-webui](https://github.com/DusuWorks/codex-webui)와 그 선행 프로젝트를 기반으로 한 비공식 MIT 파생 프로젝트입니다. OpenAI 또는 원저작자의 공식 제품이 아닙니다. 출처는 [NOTICE](NOTICE.md)에 있습니다.

## 주요 기능

- Desktop과 공유하는 대화·스트리밍·모델 설정, 승인·거절 및 구조화된 질문 답변.
- 접고 펼치는 오른쪽 파일 패널: 파일 트리, 텍스트·이미지·PDF 확인, 다운로드.
- 로드된 대화 검색, 메시지/코드 복사, 검토 후 Markdown 내보내기, 북마크와 대화 개요.
- 대화별 탭 내 초안, 삭제 되돌리기, 명령 팔레트와 키보드 도움말.
- 텍스트파일 검색·줄 이동, PDF 페이지/확대/폭 맞춤, 읽기 모드와 숫자 진단.
- 디렉터리 범위 접근 토큰과 선택적인 Cloudflare Tunnel + Access 인증.
- 사용자가 직접 설정하는 선택적 외부 앱 바로가기. 기본 접속 주소는 없습니다.

## 설치

필요 조건: Windows, Node.js 22.13 이상, PowerShell 7 이상, 로그인된 Codex Desktop. Windows native bridge를 사용합니다. Linux/macOS용 Desktop bridge 지원을 주장하지 않습니다.

```powershell
git clone https://github.com/Byunghakim11/codex-desktop-webui-oss.git
cd codex-desktop-webui-oss
npm ci
npm run setup
npm run check
$env:CODEX_WEBUI_TEST_PWSH = (Get-Command pwsh).Source
npm test
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1
```

여기까지는 설치·검증입니다. 진행 중인 작업이 끝나고 Desktop을 종료할 수 있을 때 활성화합니다.

```powershell
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1 -Activate
# Codex Desktop을 완전히 종료한 뒤 다시 실행
codex-webui qr default
```

브리지가 WebUI 하나를 자동으로 시작합니다. 중복 서버를 따로 시작하지 마세요. QR에는 접근 토큰이 포함되므로 공개하지 마세요. 자세한 설치·복구는 [Desktop bridge 안내](docs/DESKTOP_BRIDGE.md)를 따르세요.

## 접속과 사용

- 신뢰하는 LAN: 토큰 관리 명령으로 장치별 범위를 지정하고 QR로 접속합니다.
- 외부 접속: HTTPS와 별도 인증 계층을 구성합니다. [원격 접속 안내](docs/REMOTE_ACCESS.md)는 예시 주소만 사용합니다. 이 저장소 자체가 호스팅된 Codex 서비스는 아닙니다.
- 상단 Tools에서 대화 도구를 열고, 오른쪽 가장자리의 Files로 파일 패널을 열고 숨깁니다.
- 입력창 밖에서 Ctrl/Cmd+K는 명령 팔레트, ?는 도움말입니다. 외부 앱 주소는 Apps 메뉴에서 사용자가 직접 설정·삭제합니다.

초안과 북마크는 현재 탭 메모리만 사용하며 새로고침/탭 종료 시 사라집니다. 검색은 현재 로드된 지원 메시지·파일 부분만 대상으로 합니다. 분류가 불확실한 native 기록은 새 복사/검색/내보내기 도구에서 제외될 수 있습니다. PDF는 인쇄 기준 미리보기이며 일부 레이어 표시가 원본 뷰어와 다를 수 있습니다.

## 보안과 공개 범위

운영 주소·개인 이메일·개인 채팅 ID·로컬 프로필 경로·작업 기록·실제 화면 캡처·토큰·업로드·기존 개인 Git 이력을 포함하지 않는 공개용 snapshot입니다. 로그인과 권한은 각 설치자가 직접 구성합니다. 익명 인터넷 공개를 지원하지 않으며 토큰이나 인증 화면을 이슈에 올리지 마세요. 자세한 내용은 [SECURITY](SECURITY.md), [구조](docs/ARCHITECTURE.md)를 참고하세요.

검사는 임시 디렉터리와 가짜 엔진을 사용합니다. 검사 통과가 모든 Codex 버전·네트워크·장치의 호환성이나 무결점을 보증하지 않습니다.

## 라이선스와 기여

프로젝트 코드는 [MIT](LICENSE)입니다. 원저작권 고지와 [별도 의존성 라이선스](THIRD_PARTY_NOTICES.md)는 유지합니다. Codex 실행 파일·모델·계정은 포함하지 않습니다. [기여 안내](CONTRIBUTING.md)를 참고하세요.