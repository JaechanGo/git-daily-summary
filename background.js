// ========== Background Service Worker ==========
importScripts('lib/git-providers.js', 'lib/ai-providers.js');

// ========== 업데이트 체크 ==========
const UPDATE_REPO_OWNER = 'JaechanGo';
const UPDATE_REPO_NAME = 'git-daily-summary';
const UPDATE_CHECK_ALARM = 'updateCheck';
const UPDATE_CHECK_INTERVAL_HOURS = 6;

/**
 * GitHub Releases API로 최신 버전 확인
 */
async function checkForUpdate() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;

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
    const latestVersion = release.tag_name.replace(/^v/, '');

    const updateInfo = {
      currentVersion,
      latestVersion,
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      releaseUrl: release.html_url,
      downloadUrl: release.assets?.[0]?.browser_download_url
        || `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/archive/refs/tags/${release.tag_name}.zip`,
      releaseName: release.name || `v${latestVersion}`,
      releaseBody: release.body || '',
      publishedAt: release.published_at,
      checkedAt: new Date().toISOString(),
    };

    await chrome.storage.local.set({ updateInfo });

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
 * 시맨틱 버전 비교: latest > current 이면 true
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

async function setupUpdateCheckAlarm() {
  await chrome.alarms.clear(UPDATE_CHECK_ALARM);
  chrome.alarms.create(UPDATE_CHECK_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: UPDATE_CHECK_INTERVAL_HOURS * 60,
  });
}

// ----- 설정 로드 -----
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', ({ settings }) => {
      resolve(settings || null);
    });
  });
}

// ----- Git Provider 인스턴스 생성 -----
function createGitProviders(settings) {
  const providers = [];

  // 설정에 있는 모든 git 이메일 수집 (GitHub 매칭에도 사용)
  const extraEmails = [];
  if (settings.gitea && Array.isArray(settings.gitea)) {
    for (const inst of settings.gitea) {
      if (inst.email) extraEmails.push(inst.email);
    }
  }

  // GitHub
  if (settings.github?.token && settings.github?.username) {
    providers.push(new GitHubProvider(settings.github.token, settings.github.username, extraEmails));
  }

  // Gitea (다중 인스턴스)
  if (settings.gitea && Array.isArray(settings.gitea)) {
    for (const inst of settings.gitea) {
      if (inst.url && inst.token && inst.username) {
        providers.push(new GiteaProvider(inst.url, inst.token, inst.username, inst.name, inst.email));
      }
    }
  }

  return providers;
}

// ----- 요약 프롬프트 생성 -----
function buildSummaryPrompt(aiSettings) {
  const langMap = {
    ko: '한국어',
    en: 'English',
    ja: '日本語',
  };
  const lang = langMap[aiSettings.language] || '한국어';

  // 커스텀 프롬프트가 있으면 사용 ({{language}} 치환)
  if (aiSettings.customPrompt) {
    return aiSettings.customPrompt.replace(/\{\{language\}\}/g, lang);
  }

  return `당신은 개발자의 일일 Git 커밋을 요약하는 어시스턴트입니다.
다음 규칙을 따르세요:
1. 응답 언어: ${lang}
2. "제목(title)"은 해당 프로젝트에서 오늘 한 작업을 한 문장으로 요약합니다.
3. "내용(content)"은 커밋 diff를 분석하여 카테고리별로 분류하고, 각 항목을 간결하게 정리합니다.
4. 카테고리 예시: API개발, 기능개발, 오류수정, 리팩토링, 설정변경, UI개선, 테스트, 문서화, 연동, 배포 등
   - 실제 변경 내용에 맞는 카테고리를 자유롭게 생성하세요.
5. 각 카테고리 아래 변경사항을 "* " 로 나열합니다.
6. 전체 내용은 최대 10줄 이내로 간결하게 작성합니다.
7. 중요하지 않은 변경(공백, import 정렬 등)은 생략합니다.
8. 커밋 메시지와 diff 내용을 모두 참고하여 실제 작업 내용을 파악합니다.

출력 형식 예시:
{
  "title": "사용자 인증 API 및 결제 연동 개발",
  "content": "API개발\\n* 로그인 API 구현\\n* 회원가입 API 구현\\n\\n기능개발\\n* 결제 모듈 연동\\n* 이메일 알림 기능 추가\\n\\n오류수정\\n* 토큰 만료 처리 오류 수정"
}

반드시 위 JSON 형식으로만 응답하세요. JSON 외의 텍스트는 포함하지 마세요.`;
}

// ----- AI 응답 파싱 (잘린 JSON, 코드블록 등 처리) -----
function parseAIResponse(raw, repoName) {
  if (!raw || !raw.trim()) {
    return { title: `${repoName} 작업 요약`, content: '(AI 응답이 비어있습니다)' };
  }

  // 1) 코드블록 마커 제거
  let cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 2) JSON 파싱 시도
  try {
    const obj = JSON.parse(cleaned);
    if (obj.title && obj.content) return obj;
  } catch {}

  // 3) JSON 시작점 찾기 ({ 로 시작하는 부분)
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart >= 0) {
    let jsonStr = cleaned.substring(jsonStart);

    // 닫는 } 가 없으면 추가 (잘린 경우 복구)
    const openCount = (jsonStr.match(/{/g) || []).length;
    const closeCount = (jsonStr.match(/}/g) || []).length;
    if (openCount > closeCount) {
      // content 값이 잘렸을 수 있으므로 적절히 닫아줌
      if (!jsonStr.endsWith('"')) jsonStr += '"';
      for (let i = 0; i < openCount - closeCount; i++) jsonStr += '}';
    }

    try {
      const obj = JSON.parse(jsonStr);
      return {
        title: obj.title || `${repoName} 작업 요약`,
        content: obj.content || '(내용 잘림)',
      };
    } catch {}

    // 4) 정규식으로 title/content 개별 추출
    const titleMatch = jsonStr.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const contentMatch = jsonStr.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"?/);

    if (titleMatch || contentMatch) {
      return {
        title: titleMatch ? unescapeJSON(titleMatch[1]) : `${repoName} 작업 요약`,
        content: contentMatch ? unescapeJSON(contentMatch[1]) : '(내용 파싱 실패)',
      };
    }
  }

  // 5) JSON이 전혀 아닌 경우 — 텍스트 그대로 사용하되 깔끔하게
  return {
    title: `${repoName} 작업 요약`,
    content: cleaned.replace(/```/g, '').trim(),
  };
}

function unescapeJSON(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

// ----- 전체 레포 목록 가져오기 (설정 페이지용) -----
async function fetchAllRepos() {
  const settings = await loadSettings();
  if (!settings) throw new Error('설정이 없습니다.');

  const providers = createGitProviders(settings);
  if (providers.length === 0) throw new Error('토큰을 먼저 설정해주세요.');

  const repos = [];

  for (const provider of providers) {
    try {
      const list = await provider.getAllRepos();
      for (const r of list) {
        repos.push({
          name: r.fullName,
          source: r.source,
        });
      }
    } catch (e) {
      console.error(`${provider.type} 레포 목록 실패:`, e);
    }
  }

  // 이름순 정렬
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

// ----- 메인: 지정 날짜 커밋 추출 및 요약 -----
async function extractAndSummarize(targetDate) {
  const settings = await loadSettings();
  if (!settings) throw new Error('설정이 없습니다. 설정 페이지에서 토큰을 입력해주세요.');

  const gitProviders = createGitProviders(settings);
  if (gitProviders.length === 0) {
    throw new Error('GitHub 또는 Gitea 토큰을 설정해주세요.');
  }

  // 선택된 레포 목록 (비어있으면 전체 검색)
  const selectedRepos = settings.selectedRepos || [];

  const aiProvider = createAIProvider(settings.ai);
  const prompt = buildSummaryPrompt(settings.ai);

  // 날짜 범위 계산 (로컬 타임존 기준으로 UTC 변환)
  const dateStr = targetDate || new Date().toISOString().split('T')[0];
  const localStart = new Date(`${dateStr}T00:00:00`); // 로컬 자정
  const localEnd = new Date(`${dateStr}T23:59:59`);   // 로컬 23:59:59
  const since = localStart.toISOString(); // UTC로 변환 (KST 00:00 → UTC 전날 15:00)
  const until = localEnd.toISOString();   // UTC로 변환 (KST 23:59 → UTC 14:59)
  console.log(`[Extract] 날짜: ${dateStr}, since(UTC): ${since}, until(UTC): ${until}`);

  // 1) 모든 provider에서 해당 날짜 커밋 수집 (병렬)
  const providerResults = await Promise.allSettled(
    gitProviders.map((provider) =>
      provider.getCommitsByDate(since, until, selectedRepos, dateStr)
        .then((repos) => repos.map((repo) => ({ ...repo, _provider: provider })))
    )
  );

  const allRepoCommits = [];
  for (const result of providerResults) {
    if (result.status === 'fulfilled') {
      allRepoCommits.push(...result.value);
    } else {
      console.error('커밋 수집 실패:', result.reason);
    }
  }

  if (allRepoCommits.length === 0) {
    return { projects: [], message: `${dateStr} 에 커밋이 없습니다.` };
  }

  // 2) 프로젝트별로 diff 수집 + AI 요약 (병렬)
  const projects = await Promise.all(
    allRepoCommits.map(async (repoData) => {
      try {
        const commitsToProcess = repoData.commits.slice(0, 5);

        // diff를 병렬로 가져오기
        const diffResults = await Promise.allSettled(
          commitsToProcess.map((commit) =>
            repoData._provider.getCommitDiff(repoData.repo, commit.sha)
              .then((diff) => diff ? `### Commit: ${commit.message}\n${diff}` : null)
          )
        );
        const diffs = diffResults
          .filter((r) => r.status === 'fulfilled' && r.value)
          .map((r) => r.value);

        const commitSummary = repoData.commits
          .map((c) => `- ${c.message} (${c.sha.substring(0, 7)})`)
          .join('\n');

        const userMessage = `프로젝트: ${repoData.repo}
플랫폼: ${repoData.provider}
커밋 수: ${repoData.commits.length}

커밋 목록:
${commitSummary}

Diff 내용:
${diffs.join('\n\n---\n\n') || '(diff를 가져올 수 없습니다)'}`;

        const aiResponse = await aiProvider.summarize(prompt, userMessage);
        const parsed = parseAIResponse(aiResponse, repoData.repo);

        return {
          repo: repoData.repo,
          provider: repoData.provider,
          commitCount: repoData.commits.length,
          title: parsed.title,
          content: parsed.content,
          commits: repoData.commits,
        };
      } catch (e) {
        console.error(`${repoData.repo} 요약 실패:`, e);
        return {
          repo: repoData.repo,
          provider: repoData.provider,
          commitCount: repoData.commits.length,
          title: `${repoData.repo}`,
          content: `요약 생성 실패: ${e.message}`,
          commits: repoData.commits,
          error: true,
        };
      }
    })
  );

  return { projects };
}

// ----- 추출 결과 저장/로드 (날짜별 키로 chrome.storage.local 사용) -----
function resultStorageKey(dateStr) {
  return `result_${dateStr}`;
}

async function saveResult(dateStr, data) {
  const key = resultStorageKey(dateStr);
  const payload = { data, savedAt: new Date().toISOString() };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: payload }, resolve);
  });
}

async function loadResult(dateStr) {
  const key = resultStorageKey(dateStr);
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => {
      resolve(items[key] || null);
    });
  });
}

// ----- 메시지 핸들러 -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extract') {
    extractAndSummarize(msg.date)
      .then(async (result) => {
        // 추출 성공 시 날짜별로 저장
        const dateStr = msg.date || new Date().toISOString().split('T')[0];
        await saveResult(dateStr, result);
        sendResponse({ success: true, data: result });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'loadSaved') {
    const dateStr = msg.date || new Date().toISOString().split('T')[0];
    loadResult(dateStr)
      .then((saved) => {
        if (saved) {
          sendResponse({ success: true, data: saved.data, savedAt: saved.savedAt });
        } else {
          sendResponse({ success: false });
        }
      });
    return true;
  }

  if (msg.action === 'fetchRepos') {
    fetchAllRepos()
      .then((repos) => sendResponse({ success: true, repos }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'testAI') {
    loadSettings().then(async (settings) => {
      if (!settings?.ai) {
        sendResponse({ success: false, error: 'AI 설정이 없습니다.' });
        return;
      }
      try {
        const provider = createAIProvider(settings.ai);
        const result = await provider.test();
        sendResponse(result);
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    });
    return true;
  }

  if (msg.action === 'updateAutoExtract') {
    setupAutoExtractAlarm(msg.autoExtract)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── 업데이트 관련 메시지 ──
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

  // ── 업무 생성 (페이지 이동 포함) ──
  if (msg.action === 'createTask') {
    handleCreateTask(msg)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === 'dismissUpdate') {
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.get('updateInfo', ({ updateInfo }) => {
      if (updateInfo) {
        updateInfo.dismissed = true;
        chrome.storage.local.set({ updateInfo }, () => sendResponse({ success: true }));
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }
});

// ========== 자동 추출 스케줄 (Chrome Alarms) ==========

const AUTO_EXTRACT_ALARM = 'autoExtractDaily';

/**
 * 자동 추출 알람 설정
 * Chrome alarms는 분 단위로만 동작하므로, 매일 지정 시간에 1회 실행되도록 설정
 */
async function setupAutoExtractAlarm(autoExtract) {
  // 기존 알람 제거
  await chrome.alarms.clear(AUTO_EXTRACT_ALARM);

  if (!autoExtract?.enabled) {
    console.log('[AutoExtract] 알람 비활성화');
    return;
  }

  const [hours, minutes] = (autoExtract.time || '17:55').split(':').map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);

  // 이미 지난 시간이면 내일로
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const delayInMinutes = (target.getTime() - now.getTime()) / 60000;

  chrome.alarms.create(AUTO_EXTRACT_ALARM, {
    delayInMinutes,
    periodInMinutes: 24 * 60, // 24시간마다 반복
  });

  console.log(`[AutoExtract] 알람 설정: ${autoExtract.time}, 다음 실행까지 ${Math.round(delayInMinutes)}분`);
}

// 알람 발생 시 처리
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // 업데이트 체크 알람
  if (alarm.name === UPDATE_CHECK_ALARM) {
    console.log('[Update] 주기적 업데이트 체크');
    await checkForUpdate();
    return;
  }

  if (alarm.name !== AUTO_EXTRACT_ALARM) return;

  console.log('[AutoExtract] 자동 추출 시작');
  const todayStr = new Date().toISOString().split('T')[0];

  try {
    const result = await extractAndSummarize(todayStr);
    await saveResult(todayStr, result);

    const projectCount = result.projects?.length || 0;
    const commitCount = result.projects?.reduce((sum, p) => sum + p.commitCount, 0) || 0;

    // 알림 표시
    chrome.notifications.create('autoExtractDone', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Git Daily Summary - 자동 추출 완료',
      message: projectCount > 0
        ? `${todayStr}: ${projectCount}개 프로젝트, ${commitCount}건 커밋 요약 완료`
        : `${todayStr}: 오늘 커밋이 없습니다.`,
    });

    console.log(`[AutoExtract] 완료: ${projectCount}개 프로젝트, ${commitCount}건`);
  } catch (e) {
    console.error('[AutoExtract] 실패:', e);
    chrome.notifications.create('autoExtractFail', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Git Daily Summary - 자동 추출 실패',
      message: e.message,
    });
  }
});

// 서비스 워커 시작 시 알람 복원 (서비스 워커가 재시작될 수 있으므로)
chrome.runtime.onStartup.addListener(async () => {
  const settings = await loadSettings();
  if (settings?.autoExtract?.enabled) {
    await setupAutoExtractAlarm(settings.autoExtract);
  }
  await setupUpdateCheckAlarm();
});

// ========== 업무 생성 (background에서 단계별 처리) ==========
const TASKS_URL = 'https://hrms.cudo.co.kr:9700/tasks';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('페이지 로딩 타임아웃'));
    }, 15000);
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * executeScript 결과에서 에러를 추출하는 헬퍼
 */
function getScriptResult(results) {
  if (!results || results.length === 0) {
    throw new Error('스크립트 실행 결과가 없습니다.');
  }
  const r = results[0];
  // 주입된 함수가 { error: '...' } 를 반환한 경우
  if (r.result && r.result.error) {
    throw new Error(r.result.error);
  }
  return r.result;
}

async function handleCreateTask({ title, contentHtml, targetDate }) {
  const dayNum = parseInt(targetDate.split('-')[2], 10);
  console.log('[CreateTask] 시작:', { targetDate, dayNum });

  // 1) 활성 탭 확인
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('활성 탭을 찾을 수 없습니다.');
  console.log('[CreateTask] 현재 탭 URL:', tab.url);

  // 2) tasks 페이지가 아니면 이동 후 로딩 완료 대기
  if (!tab.url || !tab.url.startsWith(TASKS_URL)) {
    console.log('[CreateTask] tasks 페이지로 이동');
    await chrome.tabs.update(tab.id, { url: TASKS_URL });
    await waitForTabLoad(tab.id);
    await sleep(2500);
    console.log('[CreateTask] 페이지 로딩 완료');
  }

  // 3단계: "새로 만들기" 버튼 클릭 (동기 함수)
  const step1 = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (dayNumber, dateStr) => {
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        let cell;
        if (dateStr === todayStr) {
          cell = document.querySelector('.min-h-\\[120px\\].ring-2');
        } else {
          cell = Array.from(document.querySelectorAll('.min-h-\\[120px\\]')).find(
            (el) => el.querySelector('span.text-sm')?.textContent.trim() === String(dayNumber)
          );
        }
        if (!cell) return { error: `${dateStr} 날짜 셀을 찾을 수 없습니다. 해당 월의 캘린더를 열어주세요.` };

        const newBtn = cell.querySelector('button[title="새로 만들기"]');
        if (!newBtn) return { error: '해당 날짜 셀에 "새로 만들기" 버튼이 없습니다.' };
        newBtn.click();
        return { ok: true };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [dayNum, targetDate],
  });
  getScriptResult(step1);
  console.log('[CreateTask] 새로 만들기 클릭 완료');

  await sleep(600);

  // 4단계: "업무 생성" 클릭
  const step2 = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      try {
        const createBtn = Array.from(document.querySelectorAll('button')).find(
          (b) => b.querySelector('span')?.textContent.trim() === '업무 생성'
        );
        if (!createBtn) return { error: '"업무 생성" 버튼을 찾을 수 없습니다.' };
        createBtn.click();
        return { ok: true };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [],
  });
  getScriptResult(step2);
  console.log('[CreateTask] 업무 생성 클릭 완료');

  await sleep(1000);

  // 5단계: 폼 채우기 (제목, 내용, 상태, 날짜)
  const step3 = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (titleText, htmlContent, dateStr) => {
      try {
        // 제목
        const titleInput = document.querySelector('input[placeholder="태스크 제목"]');
        if (titleInput) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          setter.call(titleInput, titleText);
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // 내용 (tiptap)
        const editor = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
        if (editor) {
          editor.innerHTML = htmlContent;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          editor.focus();
          editor.dispatchEvent(new Event('blur', { bubbles: true }));
          editor.focus();
        }

        // 상태 → "완료"
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const doneOption = Array.from(select.options).find((opt) => opt.value === 'done');
          if (doneOption) {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype, 'value'
            ).set;
            setter.call(select, 'done');
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          }
        }

        // 날짜
        const dateInput = document.querySelector('input[placeholder="yyyy-mm-dd"]');
        if (dateInput) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          setter.call(dateInput, dateStr);
          dateInput.dispatchEvent(new Event('input', { bubbles: true }));
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return { ok: true };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [title, contentHtml, targetDate],
  });
  getScriptResult(step3);
  console.log('[CreateTask] 폼 입력 완료');
}

// 설치/업데이트 시에도 알람 복원
chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await loadSettings();
  if (settings?.autoExtract?.enabled) {
    await setupAutoExtractAlarm(settings.autoExtract);
  }
  await setupUpdateCheckAlarm();

  // 확장이 업데이트된 경우 이전 알림 제거
  if (details.reason === 'update') {
    chrome.action.setBadgeText({ text: '' });
    await chrome.storage.local.remove('updateInfo');
  }
});
