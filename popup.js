// ========== Popup Logic ==========

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ----- 버전 표시 -----
$('#app-version').textContent = `v${chrome.runtime.getManifest().version}`;

// ----- 날짜 관련 -----
function getLocalDateStr(date) {
  // YYYY-MM-DD (로컬 타임존 기준)
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 오늘 날짜를 date picker 기본값으로 설정
const today = new Date();
const dateInput = $('#target-date');
dateInput.value = getLocalDateStr(today);
dateInput.max = getLocalDateStr(today); // 미래 날짜 선택 방지
// 최대 1년 전까지 조회 가능
const oneYearAgo = new Date(today);
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
dateInput.min = getLocalDateStr(oneYearAgo);

// 헤더에 날짜 표시 업데이트
function updateDateDisplay() {
  const d = new Date(dateInput.value + 'T00:00:00');
  $('#today-date').textContent = d.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}
updateDateDisplay();

// 이전/다음 날 버튼
function shiftDate(days) {
  const current = new Date(dateInput.value + 'T00:00:00');
  current.setDate(current.getDate() + days);
  dateInput.value = getLocalDateStr(current);
  updateDateDisplay();
  updateNavButtons();
  loadSavedResult(dateInput.value);
}

function updateNavButtons() {
  const todayStr = getLocalDateStr(new Date());
  const minStr = dateInput.min;
  $('#btn-next').disabled = dateInput.value >= todayStr;
  $('#btn-prev').disabled = dateInput.value <= minStr;
}

$('#btn-prev').addEventListener('click', () => shiftDate(-1));
$('#btn-next').addEventListener('click', () => shiftDate(1));
updateNavButtons(); // 초기 상태

// 날짜 변경 시 버튼 상태도 업데이트
dateInput.addEventListener('change', () => {
  updateDateDisplay();
  updateNavButtons();
  loadSavedResult(dateInput.value);
});

// "오늘" 버튼
$('#btn-today').addEventListener('click', () => {
  dateInput.value = getLocalDateStr(new Date());
  updateDateDisplay();
  updateNavButtons();
  loadSavedResult(dateInput.value);
});

// 설정 페이지 열기
$('#btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 추출하기 버튼 — 선택된 날짜를 함께 전달
$('#btn-extract').addEventListener('click', async () => {
  const btn = $('#btn-extract');
  btn.disabled = true;
  btn.textContent = '추출 중...';

  const targetDate = dateInput.value; // "YYYY-MM-DD"
  showLoading();

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'extract',
      date: targetDate,
    });

    if (response.success) {
      renderResults(response.data, targetDate);
    } else {
      showError(response.error);
    }
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '추출하기';
  }
});

function showLoading() {
  $('#content').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>커밋을 수집하고 AI가 요약하는 중...</p>
    </div>
  `;
}

function showError(msg) {
  $('#content').innerHTML = `
    <div class="error-msg">⚠ ${escapeHtml(msg)}</div>
    <div class="empty">
      <p>설정을 확인하고 다시 시도해주세요.<br>
      <a href="#" id="open-settings" style="color:#58a6ff;">설정 페이지 열기</a></p>
    </div>
  `;
  const link = $('#open-settings');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
}

function renderResults(data, targetDate, savedAt) {
  const content = $('#content');
  const isToday = targetDate === getLocalDateStr(new Date());
  const noCommitMsg = isToday
    ? '오늘 커밋이 없습니다.'
    : `${targetDate} 에 커밋이 없습니다.`;

  if (!data.projects || data.projects.length === 0) {
    content.innerHTML = `
      <div class="empty">
        <div class="icon">✨</div>
        <p>${data.message || noCommitMsg}</p>
      </div>
    `;
    return;
  }

  let html = '';

  // 프로젝트별 카드
  for (const proj of data.projects) {
    const providerClass = proj.provider.toLowerCase().includes('github') ? 'github' : 'gitea';
    const errorClass = proj.error ? ' error' : '';

    html += `
      <div class="project${errorClass}" data-repo="${escapeAttr(proj.repo)}">
        <div class="project-header">
          <span class="toggle-icon">▼</span>
          <div class="project-info">
            <div class="project-provider">
              <span class="provider-badge ${providerClass}">${escapeHtml(proj.provider)}</span>
              <span>${escapeHtml(proj.repo)}</span>
            </div>
            <div class="project-title">${escapeHtml(proj.title)}</div>
          </div>
          <span class="commit-count">${proj.commitCount}건</span>
        </div>
        <div class="project-body">${formatContent(proj.content)}</div>
        <div class="project-actions">
          <button class="btn btn-copy" data-title="${escapeAttr(proj.title)}" data-content="${escapeAttr(proj.content)}">📋 복사</button>
          <button class="btn btn-paste" data-title="${escapeAttr(proj.title)}" data-content="${escapeAttr(proj.content)}" data-date="${escapeAttr(targetDate)}">📌 붙여넣기</button>
          <button class="btn btn-create" data-title="${escapeAttr(proj.title)}" data-content="${escapeAttr(proj.content)}" data-date="${escapeAttr(targetDate)}">✚ 생성하기</button>
        </div>
      </div>
    `;
  }

  // 저장 시각 표시
  if (savedAt) {
    const savedTime = new Date(savedAt);
    const timeStr = savedTime.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    html += `<div style="text-align:center; font-size:11px; color:#484f58; margin-bottom:6px;">마지막 추출: ${timeStr} (재추출 시 갱신됨)</div>`;
  }

  // 전체 복사 버튼
  html += `
    <button class="btn btn-primary" id="btn-copy-all" style="width:100%; justify-content:center; margin-top: 4px;">
      📋 전체 복사
    </button>
  `;

  content.innerHTML = html;

  // 접기/펼치기 이벤트
  $$('.project-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('collapsed');
    });
  });

  // 복사 이벤트
  $$('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const title = btn.dataset.title;
      const body = btn.dataset.content;
      copyToClipboard(`${title}\n${body}`, btn);
    });
  });

  // 붙여넣기 이벤트 (활성 탭에 자동 입력)
  $$('.btn-paste').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = btn.dataset.title;
      const content = btn.dataset.content;
      const date = btn.dataset.date;
      await pasteToActiveTab(title, content, date, btn);
    });
  });

  // 생성하기 이벤트 (새로 만들기 → 업무 생성 → 폼 입력)
  $$('.btn-create').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = btn.dataset.title;
      const content = btn.dataset.content;
      const date = btn.dataset.date;
      await createTaskInActiveTab(title, content, date, btn);
    });
  });

  const btnCopyAll = $('#btn-copy-all');
  if (btnCopyAll) {
    btnCopyAll.addEventListener('click', () => {
      const allText = data.projects
        .map((p) => `[${p.repo}]\n${p.title}\n${p.content}`)
        .join('\n\n---\n\n');
      copyToClipboard(allText, btnCopyAll);
    });
  }
}

function formatContent(text) {
  if (!text) return '<span style="color:#484f58;">(내용 없음)</span>';

  const lines = text.split('\n');
  let html = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // "* 항목" 또는 "- 항목" → 요약 항목
    if (/^[\*\-•]\s+/.test(trimmed)) {
      const itemText = trimmed.replace(/^[\*\-•]\s+/, '');
      html += `<div class="summary-item">${escapeHtml(itemText)}</div>`;
    }
    // 카테고리 라벨 (한글+영문으로 끝나는 줄, 뒤에 * 항목이 따라옴)
    else if (/^[\w가-힣]+$/.test(trimmed) || /^[\w가-힣]+(?:개발|수정|추가|변경|개선|리팩토링|설정|기타|연동|테스트|배포|문서화|구현|정리|작업)$/.test(trimmed)) {
      html += `<div class="category-label">${escapeHtml(trimmed)}</div>`;
    }
    // 그 외 일반 텍스트
    else {
      html += `<div style="margin-top:2px;">${escapeHtml(trimmed)}</div>`;
    }
  }

  return html || `<span style="color:#484f58;">(내용 없음)</span>`;
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = '✓ 복사됨';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ========== 저장된 결과 로드 ==========
async function loadSavedResult(dateStr) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'loadSaved',
      date: dateStr,
    });

    if (response.success && response.data) {
      renderResults(response.data, dateStr, response.savedAt);
    } else {
      // 저장된 결과 없음 → 빈 상태 표시
      showEmptyState(dateStr);
    }
  } catch (e) {
    showEmptyState(dateStr);
  }
}

function showEmptyState(dateStr) {
  const isToday = dateStr === getLocalDateStr(new Date());
  $('#content').innerHTML = `
    <div class="empty" id="empty-state">
      <div class="icon">📋</div>
      <p><strong>추출하기</strong> 버튼을 눌러<br>${isToday ? '오늘의' : dateStr} 커밋을 AI로 요약하세요</p>
    </div>
  `;
}

// ========== 활성 탭에 붙여넣기 ==========
async function pasteToActiveTab(title, content, targetDate, btn) {
  try {
    // 활성 탭 가져오기
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      alert('활성 탭을 찾을 수 없습니다.');
      return;
    }

    // content의 줄바꿈을 HTML로 변환 (tiptap 에디터용)
    // "카테고리\n* 항목1\n* 항목2" → "<p>카테고리</p><p>• 항목1</p><p>• 항목2</p>"
    const contentHtml = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const trimmed = line.trim();
        if (/^[\*\-•]\s+/.test(trimmed)) {
          return `<p>• ${trimmed.replace(/^[\*\-•]\s+/, '')}</p>`;
        }
        return `<p><strong>${trimmed}</strong></p>`;
      })
      .join('');

    // 활성 탭에 스크립트 주입
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (titleText, htmlContent, dateStr) => {
        // 1) 제목 input (placeholder="태스크 제목")
        const titleInput = document.querySelector('input[placeholder="태스크 제목"]');
        if (titleInput) {
          // React controlled input을 위한 네이티브 setter 사용
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(titleInput, titleText);
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // 2) 내용 (tiptap ProseMirror contenteditable)
        const editor = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
        if (editor) {
          editor.innerHTML = htmlContent;
          // tiptap이 변경을 감지하도록 input 이벤트 발생
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          // focus 후 blur로 상태 업데이트 트리거
          editor.focus();
          editor.dispatchEvent(new Event('blur', { bubbles: true }));
          editor.focus();
        }

        // 3) 상태 select → "완료"(done) 선택
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          // "할당/작업중/완료" 옵션이 있는 select 찾기
          const doneOption = Array.from(select.options).find(
            (opt) => opt.value === 'done'
          );
          if (doneOption) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype, 'value'
            ).set;
            nativeSetter.call(select, 'done');
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          }
        }

        // 4) 날짜 input (placeholder="yyyy-mm-dd") 에 날짜 설정
        const dateInput = document.querySelector('input[placeholder="yyyy-mm-dd"]');
        if (dateInput) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(dateInput, dateStr);
          dateInput.dispatchEvent(new Event('input', { bubbles: true }));
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return true;
      },
      args: [title, contentHtml, targetDate],
    });

    // 성공 피드백
    const original = btn.textContent;
    btn.textContent = '✓ 입력 완료';
    btn.classList.add('pasted');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('pasted');
    }, 2000);

  } catch (e) {
    console.error('붙여넣기 실패:', e);
    alert(`붙여넣기 실패: ${e.message}\n\n대상 페이지를 열어둔 상태에서 다시 시도해주세요.`);
  }
}

// ========== 업데이트 알림 ==========
async function checkAndShowUpdate() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getUpdateInfo' });

    if (response.success && response.data?.hasUpdate && !response.data?.dismissed) {
      const info = response.data;
      const updateBar = $('#update-bar');

      $('#update-text').textContent = `v${info.latestVersion} 사용 가능 (현재 v${info.currentVersion})`;
      updateBar.style.display = 'flex';

      // 업데이트 버튼 → ZIP 다운로드 (asset이 있으면) 또는 Releases 페이지
      $('#btn-update').addEventListener('click', () => {
        chrome.tabs.create({ url: info.downloadUrl || info.releaseUrl });
      });

      // 닫기
      $('#btn-dismiss-update').addEventListener('click', async () => {
        updateBar.style.display = 'none';
        await chrome.runtime.sendMessage({ action: 'dismissUpdate' });
      });
    }
  } catch (e) {
    console.log('[Update] 업데이트 정보 로드 실패:', e);
  }
}

// ========== 활성 탭에 업무 생성하기 (background로 위임) ==========
async function createTaskInActiveTab(title, content, targetDate, btn) {
  try {
    // content → HTML 변환 (붙여넣기와 동일)
    const contentHtml = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const trimmed = line.trim();
        if (/^[\*\-•]\s+/.test(trimmed)) {
          return `<p>• ${trimmed.replace(/^[\*\-•]\s+/, '')}</p>`;
        }
        return `<p><strong>${trimmed}</strong></p>`;
      })
      .join('');

    const original = btn.textContent;
    btn.textContent = '⏳ 생성 중...';
    btn.disabled = true;

    // background에 메시지 전달 — 팝업이 닫혀도 background에서 계속 처리
    const response = await chrome.runtime.sendMessage({
      action: 'createTask',
      title,
      contentHtml,
      targetDate,
    });

    if (response?.success) {
      btn.textContent = '✓ 생성 완료';
      btn.classList.add('created');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('created');
        btn.disabled = false;
      }, 2000);
    } else {
      throw new Error(response?.error || '생성 실패');
    }
  } catch (e) {
    console.error('생성하기 실패:', e);
    alert(`업무 생성 실패: ${e.message}\n\n대상 페이지(캘린더)를 열어둔 상태에서 다시 시도해주세요.`);
    btn.textContent = '✚ 생성하기';
    btn.disabled = false;
  }
}

// 팝업 열릴 때 오늘 날짜의 저장된 결과 자동 로드 + 업데이트 체크
loadSavedResult(getLocalDateStr(today));
checkAndShowUpdate();
