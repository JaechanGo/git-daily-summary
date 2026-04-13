# Git Daily Summary - 업데이트 기능 개발 가이드

## 왜 git pull이 안 되는가?

Chrome 확장 프로그램은 보안 샌드박스 안에서 실행됩니다. 파일 시스템 접근, 프로세스 실행(`git` 명령어) 등이 불가능하므로 확장 프로그램이 스스로 자신의 파일을 덮어쓸 수 없습니다.

## 현실적인 방법: GitHub Releases 기반 업데이트

**흐름 요약:**
1. GitHub에 새 버전을 Release로 발행 (ZIP 첨부)
2. 확장 프로그램이 주기적으로 GitHub API를 호출하여 최신 버전 체크
3. 현재 버전(`manifest.json`)과 비교하여 새 버전이 있으면 팝업에 업데이트 배지 표시
4. 사용자가 "업데이트" 클릭 → GitHub Releases 페이지 열기 (또는 ZIP 직접 다운로드)
5. 사용자가 다운로드 후 `chrome://extensions`에서 "압축 해제된 확장 프로그램 로드"로 덮어쓰기

---

## 수정이 필요한 파일 목록

| 파일 | 변경 내용 |
|------|-----------|
| `manifest.json` | `host_permissions`에 GitHub API 이미 포함되어 있어 추가 불필요 |
| `background.js` | 버전 체크 로직, 메시지 핸들러 추가 |
| `popup.html` | 업데이트 배지 UI 추가 |
| `popup.js` | 업데이트 상태 표시 및 버튼 이벤트 |
| `options.html` / `options.js` | (선택) GitHub 레포 URL 설정 필드 |

---

## 1단계: background.js — 버전 체크 로직 추가

```javascript
// ========== 업데이트 체크 ==========

// ★ 본인의 GitHub 레포 정보로 변경하세요
const UPDATE_REPO_OWNER = 'your-github-username';
const UPDATE_REPO_NAME = 'git-daily-summary';
const UPDATE_CHECK_ALARM = 'updateCheck';
const UPDATE_CHECK_INTERVAL_HOURS = 6; // 6시간마다 체크

/**
 * GitHub Releases API로 최신 버전 확인
 * 공개 레포: 토큰 불필요, 비공개 레포: settings의 GitHub 토큰 재활용
 */
async function checkForUpdate() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    
    // 설정에서 GitHub 토큰 가져오기 (비공개 레포일 경우)
    const settings = await loadSettings();
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (settings?.github?.token) {
      headers['Authorization'] = `token ${settings.github.token}`;
    }

    const response = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`,
      { headers }
    );

    if (!response.ok) {
      console.log('[Update] GitHub API 응답 실패:', response.status);
      return null;
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, ''); // "v1.2.0" → "1.2.0"

    const updateInfo = {
      currentVersion,
      latestVersion,
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      releaseUrl: release.html_url,
      downloadUrl: release.assets?.[0]?.browser_download_url || release.zipball_url,
      releaseName: release.name,
      releaseBody: release.body, // 릴리스 노트 (마크다운)
      publishedAt: release.published_at,
      checkedAt: new Date().toISOString(),
    };

    // 결과를 storage에 캐시
    await chrome.storage.local.set({ updateInfo });

    // 새 버전이 있으면 배지 표시
    if (updateInfo.hasUpdate) {
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }

    return updateInfo;
  } catch (e) {
    console.error('[Update] 체크 실패:', e);
    return null;
  }
}

/**
 * 시맨틱 버전 비교: latest가 current보다 높으면 true
 * "1.2.0" vs "1.1.0" → true
 */
function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] || 0;
    const cv = c[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

// 주기적 체크 알람 설정
async function setupUpdateCheckAlarm() {
  await chrome.alarms.clear(UPDATE_CHECK_ALARM);
  chrome.alarms.create(UPDATE_CHECK_ALARM, {
    delayInMinutes: 1, // 시작 1분 후 첫 체크
    periodInMinutes: UPDATE_CHECK_INTERVAL_HOURS * 60,
  });
}
```

### 기존 코드에 추가할 부분

```javascript
// ── 알람 리스너 수정 (기존 onAlarm에 업데이트 체크 추가) ──

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === UPDATE_CHECK_ALARM) {
    console.log('[Update] 업데이트 체크 시작');
    await checkForUpdate();
    return;
  }

  if (alarm.name !== AUTO_EXTRACT_ALARM) return;
  // ... 기존 자동 추출 코드 ...
});

// ── onInstalled에 업데이트 알람도 추가 ──
chrome.runtime.onInstalled.addListener(async (details) => {
  // 기존 자동 추출 알람 복원
  const settings = await loadSettings();
  if (settings?.autoExtract?.enabled) {
    await setupAutoExtractAlarm(settings.autoExtract);
  }

  // 업데이트 체크 알람 시작
  await setupUpdateCheckAlarm();

  // 업데이트로 설치된 경우 배지 제거
  if (details.reason === 'update') {
    chrome.action.setBadgeText({ text: '' });
    await chrome.storage.local.remove('updateInfo');
  }
});

// ── onStartup에도 추가 ──
chrome.runtime.onStartup.addListener(async () => {
  const settings = await loadSettings();
  if (settings?.autoExtract?.enabled) {
    await setupAutoExtractAlarm(settings.autoExtract);
  }
  await setupUpdateCheckAlarm();
});

// ── 메시지 핸들러 추가 (기존 onMessage 안에) ──

if (msg.action === 'checkUpdate') {
  checkForUpdate()
    .then((info) => sendResponse({ success: true, data: info }))
    .catch((e) => sendResponse({ success: false, error: e.message }));
  return true;
}

if (msg.action === 'getUpdateInfo') {
  chrome.storage.local.get('updateInfo', ({ updateInfo }) => {
    sendResponse({ success: true, data: updateInfo || null });
  });
  return true;
}

if (msg.action === 'dismissUpdate') {
  chrome.action.setBadgeText({ text: '' });
  chrome.storage.local.get('updateInfo', ({ updateInfo }) => {
    if (updateInfo) {
      updateInfo.dismissed = true;
      chrome.storage.local.set({ updateInfo }, () => {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: true });
    }
  });
  return true;
}
```

---

## 2단계: popup.html — 업데이트 알림 UI 추가

헤더 아래, date-bar 위에 업데이트 배너를 삽입합니다.

```html
<!-- date-bar 바로 위에 추가 -->
<div class="update-bar" id="update-bar" style="display:none;">
  <div class="update-info">
    <span class="update-icon">🔄</span>
    <span id="update-text">새 버전이 있습니다</span>
  </div>
  <div class="update-actions">
    <button class="btn btn-update" id="btn-update">업데이트</button>
    <button class="btn btn-dismiss" id="btn-dismiss-update">✕</button>
  </div>
</div>
```

### CSS 추가 (style 태그 안에)

```css
/* 업데이트 알림 바 */
.update-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  background: linear-gradient(135deg, #1f6feb22, #f8514922);
  border-bottom: 1px solid #f8514966;
}
.update-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #f0f6fc;
}
.update-icon {
  font-size: 16px;
}
.update-actions {
  display: flex;
  gap: 6px;
}
.btn-update {
  padding: 4px 12px;
  background: #f85149;
  border: 1px solid #f85149;
  border-radius: 5px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-update:hover { background: #da3633; }
.btn-dismiss {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid #30363d;
  border-radius: 5px;
  color: #8b949e;
  font-size: 12px;
  cursor: pointer;
}
.btn-dismiss:hover { color: #f0f6fc; }
```

---

## 3단계: popup.js — 업데이트 상태 확인 및 이벤트 처리

팝업이 열릴 때 캐시된 업데이트 정보를 표시하고, 버튼 클릭 시 다운로드 페이지를 엽니다.

```javascript
// ========== 업데이트 알림 ==========

async function checkAndShowUpdate() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getUpdateInfo' });
    
    if (response.success && response.data?.hasUpdate && !response.data?.dismissed) {
      const info = response.data;
      const updateBar = $('#update-bar');
      const updateText = $('#update-text');
      
      updateText.textContent = `v${info.latestVersion} 사용 가능 (현재 v${info.currentVersion})`;
      updateBar.style.display = 'flex';

      // 업데이트 버튼 → GitHub Releases 페이지 열기
      $('#btn-update').addEventListener('click', () => {
        // 방법 1: Releases 페이지 열기 (사용자가 릴리스 노트 확인 후 다운로드)
        chrome.tabs.create({ url: info.releaseUrl });
        
        // 방법 2: ZIP 직접 다운로드 (더 빠르지만 릴리스 노트를 못 봄)
        // chrome.tabs.create({ url: info.downloadUrl });
      });

      // 닫기 버튼
      $('#btn-dismiss-update').addEventListener('click', async () => {
        updateBar.style.display = 'none';
        await chrome.runtime.sendMessage({ action: 'dismissUpdate' });
      });
    }
  } catch (e) {
    console.log('[Update] 업데이트 정보 로드 실패:', e);
  }
}

// 팝업 열릴 때 실행 (기존 loadSavedResult 호출 근처에 추가)
checkAndShowUpdate();
```

---

## 4단계: GitHub에서 Release 발행하는 방법

개발 흐름은 다음과 같습니다:

### 1) manifest.json 버전 올리기

```json
{
  "version": "1.1.0"
}
```

### 2) GitHub Release 생성

```bash
# 태그 생성 및 푸시
git tag v1.1.0
git push origin v1.1.0
```

GitHub 웹에서 Releases → "Create a new release":
- Tag: `v1.1.0`
- Title: `v1.1.0 - 업데이트 기능 추가`
- Description: 변경사항 작성
- Attach: 확장 프로그램 폴더를 ZIP으로 압축하여 첨부

### 3) 자동화 (선택): GitHub Actions

`.github/workflows/release.yml` 파일을 만들면 태그 푸시 시 자동으로 ZIP을 만들어 Release에 첨부합니다:

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

이렇게 하면 `git tag v1.2.0 && git push origin v1.2.0`만 실행하면 자동으로 ZIP이 만들어져 Release에 첨부됩니다.

---

## 사용자 업데이트 경험 (최종 흐름)

```
[사용자 시점]

1. 확장 아이콘에 "NEW" 배지가 보임
2. 팝업을 열면 상단에 "v1.2.0 사용 가능 (현재 v1.1.0)" 배너
3. "업데이트" 클릭 → GitHub Releases 페이지가 열림
4. ZIP 다운로드 → 압축 해제
5. chrome://extensions → "압축 해제된 확장 프로그램을 로드합니다" 
   → 기존 폴더를 새 폴더로 교체 (또는 같은 폴더에 덮어쓰기)
6. 확장이 자동 리로드되며 업데이트 완료
```

---

## 고급 옵션: 더 매끄러운 업데이트 (update_url 방식)

Chrome Web Store 없이도 Chromium의 자체 업데이트 메커니즘을 사용할 수 있습니다. 이 방식은 Chrome이 자동으로 CRX를 다운로드하여 설치하므로 사용자 개입이 최소화됩니다.

### 조건
- CRX 파일에 **서명**이 필요 (개발자 모드에서는 자동 서명)
- **update manifest XML**을 호스팅할 웹 서버 필요 (GitHub Pages 가능)
- Enterprise 정책이나 개발자 모드에서만 동작

### manifest.json에 추가

```json
{
  "update_url": "https://your-username.github.io/git-daily-summary/updates.xml"
}
```

### updates.xml (GitHub Pages에 호스팅)

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='여기에-확장-ID-입력'>
    <updatecheck crsxurl='https://github.com/user/repo/releases/download/v1.2.0/extension.crx'
                 version='1.2.0' />
  </app>
</gupdate>
```

> 이 방식은 설정이 복잡하므로, 먼저 GitHub Releases + 수동 다운로드 방식으로 시작하고 필요시 전환하는 것을 권장합니다.

---

## 요약

| 항목 | 내용 |
|------|------|
| **버전 체크** | GitHub Releases API → `chrome.runtime.getManifest().version`과 비교 |
| **체크 주기** | Chrome Alarms로 6시간마다 + 팝업 열 때 캐시 표시 |
| **알림 방식** | 확장 아이콘 배지("NEW") + 팝업 상단 배너 |
| **업데이트** | GitHub Releases 페이지 열기 → 사용자가 ZIP 다운로드 후 교체 |
| **자동화** | GitHub Actions로 태그 푸시 시 자동 Release 생성 |
