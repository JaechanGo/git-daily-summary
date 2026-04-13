# Git Daily Summary - v1.1.0 개발 가이드

## 변경 이력

| 버전 | 날짜 | 주요 변경 |
|------|------|-----------|
| v1.0.0 | 초기 릴리즈 | 커밋 추출, AI 요약, 복사/붙여넣기, 자동 추출 스케줄, 업데이트 체크 |
| v1.1.0 | 2026-04-13 | 업무 생성하기, 날짜 자동 입력, 버전 표시, 설정 페이지 버전 관리 |

---

## v1.1.0 신규 기능

### 1. 업무 생성하기 (✚ 생성하기 버튼)

HRMS 캘린더에 직접 업무를 생성하는 기능입니다.

#### 동작 흐름

```
[사용자] 생성하기 클릭
    ↓
[popup.js] contentHtml 변환 → background에 메시지 전송
    ↓
[background.js] handleCreateTask 실행
    ↓
  ┌─ 현재 탭 URL이 https://hrms.cudo.co.kr:9700/tasks 인가?
  │   NO → chrome.tabs.update()로 이동 → waitForTabLoad() → 2.5초 대기
  │   YES → 바로 진행
  └─
    ↓
  Step 1: executeScript — 날짜 셀 찾기 + "새로 만들기" 클릭
    ↓ (600ms 대기)
  Step 2: executeScript — "업무 생성" 클릭
    ↓ (1000ms 대기)
  Step 3: executeScript — 제목/내용/상태(완료)/날짜 폼 채우기
```

#### 핵심 설계 결정: background에서 처리

팝업에서 `chrome.tabs.update()`로 페이지를 이동하면 **팝업이 닫힘** → 이후 코드 미실행. 따라서 전체 로직을 background service worker로 이동했습니다.

```
popup.js → chrome.runtime.sendMessage({ action: 'createTask', ... })
background.js → handleCreateTask() 실행 (팝업 닫혀도 계속 동작)
```

#### 핵심 설계 결정: 단계별 동기 executeScript

하나의 큰 `async` 함수를 `executeScript`에 넣으면 내부 에러가 전파되지 않는 문제가 있습니다. 3개의 **동기 함수**로 분리하고, 대기(`sleep`)는 background에서 처리합니다.

```javascript
// 각 단계에서 에러 발생 시 { error: '...' } 반환
func: (args) => {
  try {
    // DOM 조작 (동기)
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}
```

`getScriptResult()` 헬퍼가 결과를 확인하고 에러 시 즉시 throw합니다.

#### 관련 파일

| 파일 | 변경 |
|------|------|
| `popup.html` | `.btn-create` 스타일 추가 |
| `popup.js` | 버튼 렌더링, 이벤트 리스너, `createTaskInActiveTab()` (background 위임) |
| `background.js` | `handleCreateTask()`, `waitForTabLoad()`, `sleep()`, `getScriptResult()` |
| `manifest.json` | `"tabs"` 권한 추가 (background에서 `tab.url` 읽기 위해) |

---

### 2. 날짜 자동 입력

붙여넣기(📌)와 생성하기(✚) 모두 `input[placeholder="yyyy-mm-dd"]`에 선택된 날짜를 자동 설정합니다.

#### 변경 사항

- `renderResults()`에서 `btn-paste`에 `data-date="${targetDate}"` 속성 추가
- `pasteToActiveTab(title, content, btn)` → `pasteToActiveTab(title, content, targetDate, btn)`으로 시그니처 변경
- 함수 내부에 날짜 input 설정 코드 추가:

```javascript
// React controlled input을 위한 네이티브 setter
const dateInput = document.querySelector('input[placeholder="yyyy-mm-dd"]');
if (dateInput) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  setter.call(dateInput, dateStr);
  dateInput.dispatchEvent(new Event('input', { bubbles: true }));
  dateInput.dispatchEvent(new Event('change', { bubbles: true }));
}
```

---

### 3. 버전 표시 (팝업 헤더)

팝업 헤더에 현재 버전을 배지로 표시합니다.

```
Git Daily Summary v1.1.0  2026년 4월 13일 (일)
```

#### 구현

**popup.html:**
```html
<h1>
  Git Daily Summary
  <span class="version" id="app-version"></span>
  <span class="date" id="today-date"></span>
</h1>
```

**popup.js:**
```javascript
$('#app-version').textContent = `v${chrome.runtime.getManifest().version}`;
```

---

### 4. 설정 페이지 — 버전 정보 섹션

설정 페이지(`options.html`) 하단에 버전 관리 UI를 추가했습니다.

#### 구성 요소

| UI 요소 | 기능 |
|---------|------|
| 현재 버전 표시 | `chrome.runtime.getManifest().version` |
| 최신 버전 확인 버튼 | `checkUpdate` 메시지 → GitHub Releases API 호출 |
| 버전 상태 | "✅ 최신 버전입니다" 또는 "→ v1.x.x 업데이트 가능" (빨간색) |
| 다운로드 버튼 | asset이 있으면 asset URL, 없으면 archive ZIP URL |
| 릴리즈 노트 | 마크다운 → HTML 렌더링하여 표시 |

#### 마크다운 렌더링

`markdownToHtml()` 함수로 별도 라이브러리 없이 GitHub Release 노트를 HTML로 변환합니다:

- `## 헤더` → `<h2>`, `### 서브` → `<h3>`
- `**bold**` → `<strong>`, `` `code` `` → `<code>`
- `- 항목` → `<ul><li>`
- 나머지 → `<p>`

#### 다운로드 URL 우선순위

```javascript
downloadUrl: release.assets?.[0]?.browser_download_url  // 1순위: 첨부 asset
  || `https://github.com/${OWNER}/${REPO}/archive/refs/tags/${tag}.zip`  // 2순위: archive ZIP
```

> **참고:** private 레포에서는 archive URL도 인증이 필요합니다. public 레포에서만 직접 다운로드가 작동합니다.

---

## 아키텍처 개요

### 파일 구조 및 역할

```
git-daily-summary/
├── manifest.json          # 확장 메타 (v1.1.0, tabs 권한 추가)
├── popup.html / popup.js  # 팝업 UI, 이벤트 처리
├── options.html / options.js  # 설정 페이지 (버전 정보 섹션 추가)
├── background.js          # 서비스 워커 (추출, 업데이트 체크, 업무 생성)
├── lib/
│   ├── git-providers.js   # GitHub/Gitea API 래퍼
│   └── ai-providers.js    # Gemini/OpenAI/Anthropic/Ollama 래퍼
└── icons/                 # 확장 아이콘
```

### 메시지 흐름

```
popup.js / options.js
    ↓ chrome.runtime.sendMessage()
background.js (onMessage 핸들러)
    ├── extract        → extractAndSummarize() → saveResult()
    ├── loadSaved      → loadResult()
    ├── createTask     → handleCreateTask() ★ v1.1.0 신규
    ├── checkUpdate    → checkForUpdate() → GitHub API
    ├── getUpdateInfo  → chrome.storage.local
    ├── dismissUpdate  → 배지 제거
    ├── fetchRepos     → fetchAllRepos()
    ├── testAI         → provider.test()
    └── updateAutoExtract → setupAutoExtractAlarm()
```

### 권한 (manifest.json)

```json
{
  "permissions": ["storage", "activeTab", "tabs", "scripting", "alarms", "notifications"],
  "host_permissions": ["https://api.github.com/*", "https://*/*"]
}
```

| 권한 | 용도 |
|------|------|
| `storage` | 설정, 추출 결과, 업데이트 정보 캐시 |
| `activeTab` | 팝업에서 활성 탭 접근 |
| `tabs` | background에서 `tab.url` 읽기 (v1.1.0 추가) |
| `scripting` | 활성 탭에 스크립트 주입 (붙여넣기, 생성하기) |
| `alarms` | 자동 추출 / 업데이트 체크 스케줄 |
| `notifications` | 자동 추출 완료 알림 |

---

## 릴리즈 발행 방법

### 1) 버전 올리기

`manifest.json`의 `version` 수정:

```json
{ "version": "1.2.0" }
```

### 2) GitHub Release 생성

```bash
git add -A
git commit -m "v1.2.0 - 변경사항 요약"
git push origin main
```

GitHub 웹 → Releases → "Create a new release":
- Tag: `v1.2.0` (Create new tag)
- Target: `main`
- Title: `v1.2.0 - 변경사항 요약`
- Description: 변경 내용 마크다운 작성
- Publish release

### 3) 자동화 (선택): GitHub Actions

`.github/workflows/release.yml`:

```yaml
name: Release Extension
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create ZIP
        run: |
          zip -r git-daily-summary-${{ github.ref_name }}.zip \
            manifest.json popup.html popup.js options.html options.js \
            background.js lib/ icons/ \
            -x "*.git*" "*.md" ".github/*"

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: git-daily-summary-${{ github.ref_name }}.zip
          generate_release_notes: true
```

이렇게 하면 `git tag v1.2.0 && git push origin v1.2.0`만으로 ZIP이 자동 첨부된 Release가 생성됩니다.

---

## 사용자 업데이트 경험

```
1. 확장 아이콘에 빨간 "NEW" 배지 표시 (6시간마다 자동 체크)
2. 팝업 상단에 "v1.2.0 사용 가능" 배너 + 업데이트 버튼
3. 설정 페이지 → "최신 버전 확인" → 릴리즈 노트 확인 → "다운로드"
4. ZIP 다운로드 → 압축 해제 → 기존 폴더에 덮어쓰기
5. chrome://extensions → 새로고침 (또는 자동 리로드)
```

---

## 트러블슈팅

### 업데이트 체크 시 404

- Release가 하나도 없으면 `/releases/latest` API가 404를 반환합니다. 정상 동작이며 에러는 발생하지 않습니다.
- private 레포에서는 GitHub 토큰이 설정에 저장되어 있어야 합니다.

### 생성하기 실패

- background 콘솔(`chrome://extensions` → 서비스 워커 검사)에서 `[CreateTask]` 로그를 확인하세요.
- 날짜 셀을 찾지 못하면 해당 월의 캘린더가 화면에 보이는지 확인하세요.
- 페이지 로딩이 느리면 `sleep()` 시간을 늘려보세요 (background.js `handleCreateTask` 내부).

### 팝업에서 생성하기 누르면 아무 일도 안 일어남

- `tabs` 권한이 `manifest.json`에 있는지 확인하세요.
- 확장을 다시 로드(`chrome://extensions` → 새로고침)해야 권한이 적용됩니다.

### 다운로드 시 404

- private 레포에서는 archive ZIP URL 접근 불가 → public으로 전환하거나, Release에 ZIP asset을 직접 첨부하세요.
- 캐시된 URL이 남아있을 수 있으므로 "최신 버전 확인"을 다시 눌러 갱신하세요.
