// ========== Options Page Logic ==========

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ----- Gitea Instance Management -----
let giteaInstances = [];

function renderGiteaInstances() {
  const container = $('#gitea-instances');
  container.innerHTML = '';
  giteaInstances.forEach((inst, idx) => {
    const div = document.createElement('div');
    div.className = 'gitea-instance';
    div.innerHTML = `
      <button class="btn-remove-instance" data-idx="${idx}">&times;</button>
      <label>인스턴스 이름 (별칭)</label>
      <input type="text" class="gitea-name" data-idx="${idx}" value="${inst.name || ''}" placeholder="예: 회사 Gitea">
      <label>Gitea URL</label>
      <input type="text" class="gitea-url" data-idx="${idx}" value="${inst.url || ''}" placeholder="https://gitea.example.com">
      <label>Token</label>
      <input type="password" class="gitea-token" data-idx="${idx}" value="${inst.token || ''}" placeholder="Gitea Personal Access Token">
      <label>Username (Gitea 로그인 ID)</label>
      <input type="text" class="gitea-username" data-idx="${idx}" value="${inst.username || ''}" placeholder="your-username">
      <label>Git Author Email (git config에 설정된 이메일)</label>
      <input type="email" class="gitea-email" data-idx="${idx}" value="${inst.email || ''}" placeholder="예: gjc@cudo.co.kr">
      <div style="font-size:11px; color:#484f58; margin-top:3px;">커밋의 author email과 매칭에 사용됩니다. <code>git config user.email</code> 값을 입력하세요.</div>
    `;
    container.appendChild(div);
  });

  $$('.btn-remove-instance').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      giteaInstances.splice(idx, 1);
      renderGiteaInstances();
    });
  });
}

$('#btn-add-gitea').addEventListener('click', () => {
  giteaInstances.push({ name: '', url: '', token: '', username: '' });
  renderGiteaInstances();
});

// ----- AI Provider Toggle -----
$('#ai-provider').addEventListener('change', (e) => {
  $$('.ai-provider-extra').forEach((el) => el.classList.remove('active'));
  const target = $(`#config-${e.target.value}`);
  if (target) target.classList.add('active');
});

// ----- Collect current Gitea inputs -----
function collectGiteaInstances() {
  const instances = [];
  $$('.gitea-instance').forEach((el) => {
    instances.push({
      name: el.querySelector('.gitea-name').value.trim(),
      url: el.querySelector('.gitea-url').value.trim().replace(/\/+$/, ''),
      token: el.querySelector('.gitea-token').value.trim(),
      username: el.querySelector('.gitea-username').value.trim(),
      email: el.querySelector('.gitea-email').value.trim(),
    });
  });
  return instances;
}

// ==========================================
// ===== 프로젝트(레포) 선택 관리 =====
// ==========================================
let allRepos = [];         // { name: string, source: 'GitHub' | 'Gitea (xxx)' }
let selectedRepos = [];    // 선택된 레포 name 목록 (저장됨)

function renderRepoList(filter = '') {
  const container = $('#repo-list');
  container.innerHTML = '';

  const filtered = filter
    ? allRepos.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()))
    : allRepos;

  if (allRepos.length === 0) return; // :empty CSS로 안내

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:#484f58;font-size:12px;">검색 결과 없음</div>';
    return;
  }

  for (const repo of filtered) {
    const checked = selectedRepos.includes(repo.name);
    const div = document.createElement('div');
    div.className = 'repo-item';
    div.innerHTML = `
      <input type="checkbox" data-repo="${escapeAttr(repo.name)}" ${checked ? 'checked' : ''}>
      <span class="repo-name">${escapeHtml(repo.name)}</span>
      <span class="repo-source">${escapeHtml(repo.source)}</span>
    `;
    // 행 전체 클릭 시 체크박스 토글
    div.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const cb = div.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    div.querySelector('input').addEventListener('change', (e) => {
      const name = e.target.dataset.repo;
      if (e.target.checked) {
        if (!selectedRepos.includes(name)) selectedRepos.push(name);
      } else {
        selectedRepos = selectedRepos.filter((r) => r !== name);
      }
      updateRepoCount();
    });
    container.appendChild(div);
  }

  updateRepoCount();
}

function updateRepoCount() {
  const el = $('#repo-count');
  if (allRepos.length === 0) {
    el.textContent = '';
  } else {
    el.textContent = `${selectedRepos.length} / ${allRepos.length} 선택됨`;
  }
}

// 검색
$('#repo-search').addEventListener('input', (e) => {
  renderRepoList(e.target.value);
});

// 전체 선택 / 해제
$('#btn-select-all').addEventListener('click', () => {
  selectedRepos = allRepos.map((r) => r.name);
  renderRepoList($('#repo-search').value);
});
$('#btn-deselect-all').addEventListener('click', () => {
  selectedRepos = [];
  renderRepoList($('#repo-search').value);
});

// 레포 불러오기 (background에 요청)
$('#btn-fetch-repos').addEventListener('click', async () => {
  const btn = $('#btn-fetch-repos');
  btn.disabled = true;
  btn.textContent = '불러오는 중...';

  try {
    // 먼저 현재 입력값을 임시 저장 (토큰 정보가 필요하므로)
    const tempSettings = buildSettingsObject();
    await new Promise((resolve) => chrome.storage.local.set({ settings: tempSettings }, resolve));

    const response = await chrome.runtime.sendMessage({ action: 'fetchRepos' });
    if (response.success) {
      allRepos = response.repos;
      // 기존 선택 유지하면서 새 목록 반영
      renderRepoList();
      showStatus(`${allRepos.length}개 레포를 불러왔습니다.`, 'success');
    } else {
      showStatus(`레포 불러오기 실패: ${response.error}`, 'error');
    }
  } catch (e) {
    showStatus(`오류: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '레포 불러오기';
  }
});

// ==========================================
// ===== 저장 / 로드 =====
// ==========================================

// ----- 기본 프롬프트 (참조용) -----
const DEFAULT_PROMPT = `당신은 개발자의 일일 Git 커밋을 요약하는 어시스턴트입니다.
다음 규칙을 따르세요:
1. 응답 언어: {{language}}
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

// 프롬프트 관련 버튼
$('#btn-reset-prompt').addEventListener('click', () => {
  $('#custom-prompt').value = '';
  showStatus('기본 프롬프트로 초기화됨', 'success');
});

$('#btn-preview-prompt').addEventListener('click', () => {
  const lang = $('#ai-language').value;
  const langMap = { ko: '한국어', en: 'English', ja: '日本語' };
  $('#custom-prompt').value = DEFAULT_PROMPT.replace('{{language}}', langMap[lang] || '한국어');
  showStatus('기본 프롬프트가 입력란에 표시됨 (수정 후 저장 가능)', 'success');
});

function buildSettingsObject() {
  const provider = $('#ai-provider').value;
  return {
    github: {
      token: $('#github-token').value.trim(),
      username: $('#github-username').value.trim(),
    },
    gitea: collectGiteaInstances(),
    selectedRepos: selectedRepos,
    cachedRepos: allRepos,
    ai: {
      provider,
      language: $('#ai-language').value,
      customPrompt: $('#custom-prompt').value.trim(),  // 커스텀 프롬프트
      gemini: {
        apiKey: $('#gemini-api-key').value.trim(),
        model: $('#gemini-model').value.trim() || 'gemini-2.0-flash',
      },
      vllm: {
        endpoint: $('#vllm-endpoint').value.trim() || 'http://localhost:8000/v1',
        model: $('#vllm-model').value.trim(),
        apiKey: $('#vllm-api-key').value.trim(),
      },
      openai: {
        apiKey: $('#openai-api-key').value.trim(),
        model: $('#openai-model').value.trim() || 'gpt-4o-mini',
      },
      anthropic: {
        apiKey: $('#anthropic-api-key').value.trim(),
        model: $('#anthropic-model').value.trim() || 'claude-sonnet-4-20250514',
      },
      ollama: {
        endpoint: $('#ollama-endpoint').value.trim() || 'http://localhost:11434',
        model: $('#ollama-model').value.trim() || 'llama3',
      },
      custom: {
        endpoint: $('#custom-endpoint').value.trim(),
        model: $('#custom-model').value.trim(),
        apiKey: $('#custom-api-key').value.trim(),
      },
    },
    autoExtract: {
      enabled: $('#auto-extract-enabled').checked,
      time: $('#auto-extract-time').value || '17:55',
    },
  };
}

$('#btn-save').addEventListener('click', async () => {
  const settings = buildSettingsObject();
  await new Promise(resolve => chrome.storage.local.set({ settings }, resolve));

  // 자동 추출 알람 설정/해제
  await chrome.runtime.sendMessage({
    action: 'updateAutoExtract',
    autoExtract: settings.autoExtract,
  });

  updateAutoExtractStatus(settings.autoExtract);
  showStatus('저장 완료!', 'success');
});

function updateAutoExtractStatus(autoExtract) {
  const el = $('#auto-extract-status');
  if (autoExtract?.enabled) {
    el.textContent = `✅ 매일 ${autoExtract.time}에 자동 추출이 실행됩니다.`;
    el.style.color = '#3fb950';
  } else {
    el.textContent = '자동 추출이 비활성화되어 있습니다.';
    el.style.color = '#8b949e';
  }
}

function loadSettings() {
  chrome.storage.local.get('settings', ({ settings }) => {
    if (!settings) {
      giteaInstances = [];
      renderGiteaInstances();
      return;
    }

    // GitHub
    if (settings.github) {
      $('#github-token').value = settings.github.token || '';
      $('#github-username').value = settings.github.username || '';
    }

    // Gitea
    giteaInstances = settings.gitea || [];
    renderGiteaInstances();

    // 레포 선택
    selectedRepos = settings.selectedRepos || [];
    allRepos = settings.cachedRepos || [];
    renderRepoList();

    // 커스텀 프롬프트
    if (settings.ai?.customPrompt) {
      $('#custom-prompt').value = settings.ai.customPrompt;
    }

    // 자동 추출
    if (settings.autoExtract) {
      $('#auto-extract-enabled').checked = !!settings.autoExtract.enabled;
      $('#auto-extract-time').value = settings.autoExtract.time || '17:55';
      updateAutoExtractStatus(settings.autoExtract);
    }

    // AI
    if (settings.ai) {
      $('#ai-provider').value = settings.ai.provider || 'gemini';
      $('#ai-provider').dispatchEvent(new Event('change'));
      $('#ai-language').value = settings.ai.language || 'ko';

      if (settings.ai.gemini) {
        $('#gemini-api-key').value = settings.ai.gemini.apiKey || '';
        $('#gemini-model').value = settings.ai.gemini.model || 'gemini-2.0-flash';
      }
      if (settings.ai.vllm) {
        $('#vllm-endpoint').value = settings.ai.vllm.endpoint || 'http://localhost:8000/v1';
        $('#vllm-model').value = settings.ai.vllm.model || '';
        $('#vllm-api-key').value = settings.ai.vllm.apiKey || '';
      }
      if (settings.ai.openai) {
        $('#openai-api-key').value = settings.ai.openai.apiKey || '';
        $('#openai-model').value = settings.ai.openai.model || 'gpt-4o-mini';
      }
      if (settings.ai.anthropic) {
        $('#anthropic-api-key').value = settings.ai.anthropic.apiKey || '';
        $('#anthropic-model').value = settings.ai.anthropic.model || 'claude-sonnet-4-20250514';
      }
      if (settings.ai.ollama) {
        $('#ollama-endpoint').value = settings.ai.ollama.endpoint || 'http://localhost:11434';
        $('#ollama-model').value = settings.ai.ollama.model || 'llama3';
      }
      if (settings.ai.custom) {
        $('#custom-endpoint').value = settings.ai.custom.endpoint || '';
        $('#custom-model').value = settings.ai.custom.model || '';
        $('#custom-api-key').value = settings.ai.custom.apiKey || '';
      }
    }
  });
}

// ----- AI Test -----
$('#btn-test-ai').addEventListener('click', async () => {
  showStatus('테스트 중...', '');
  try {
    const response = await chrome.runtime.sendMessage({ action: 'testAI' });
    if (response && response.success) {
      showStatus('AI 연결 성공!', 'success');
    } else {
      showStatus(`실패: ${response?.error || '알 수 없는 오류'}`, 'error');
    }
  } catch (e) {
    showStatus(`오류: ${e.message}`, 'error');
  }
});

// ----- Utility -----
function showStatus(msg, type) {
  const el = $('#status-msg');
  el.textContent = msg;
  el.className = 'status' + (type ? ` ${type}` : '');
  if (type) setTimeout(() => { el.textContent = ''; }, 4000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ----- 버전 정보 -----
$('#current-version').textContent = `v${chrome.runtime.getManifest().version}`;

// 저장된 업데이트 정보가 있으면 바로 표시
chrome.runtime.sendMessage({ action: 'getUpdateInfo' }, (response) => {
  if (response?.success && response.data) {
    displayUpdateInfo(response.data);
  }
});

$('#btn-check-update').addEventListener('click', async () => {
  const btn = $('#btn-check-update');
  btn.disabled = true;
  btn.textContent = '확인 중...';
  $('#version-status').textContent = '';
  $('#btn-download').style.display = 'none';
  $('#release-info').style.display = 'none';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkUpdate' });
    if (response?.success && response.data) {
      displayUpdateInfo(response.data);
    } else if (response?.success && !response.data) {
      $('#version-status').textContent = '릴리즈 정보를 찾을 수 없습니다.';
      $('#version-status').style.color = '#f85149';
    } else {
      $('#version-status').textContent = `확인 실패: ${response?.error || '알 수 없는 오류'}`;
      $('#version-status').style.color = '#f85149';
    }
  } catch (e) {
    $('#version-status').textContent = `오류: ${e.message}`;
    $('#version-status').style.color = '#f85149';
  } finally {
    btn.disabled = false;
    btn.textContent = '최신 버전 확인';
  }
});

function displayUpdateInfo(info) {
  const statusEl = $('#version-status');
  const downloadBtn = $('#btn-download');
  const releaseInfo = $('#release-info');

  if (info.hasUpdate) {
    statusEl.innerHTML = `→ <strong style="color:#f85149;">v${info.latestVersion}</strong> 업데이트 가능`;
    statusEl.style.color = '#f85149';
    downloadBtn.href = info.downloadUrl || info.releaseUrl;
    downloadBtn.textContent = `v${info.latestVersion} 다운로드`;
    downloadBtn.style.display = 'inline-block';
  } else {
    statusEl.textContent = '✅ 최신 버전입니다.';
    statusEl.style.color = '#3fb950';
    downloadBtn.style.display = 'none';
  }

  // 릴리즈 노트 표시
  if (info.releaseName || info.releaseBody) {
    $('#release-name').textContent = info.releaseName || '';
    $('#release-body').innerHTML = markdownToHtml(info.releaseBody || '(릴리즈 노트 없음)');
    releaseInfo.style.display = 'block';
  }
}

/**
 * 간단한 마크다운 → HTML 변환 (GitHub Release 노트용)
 */
function markdownToHtml(md) {
  let html = escapeHtml(md);

  // ## 헤더 → h2
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  // ### 헤더 → h3
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');

  // **bold**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 리스트: "- 항목" → li 태그 (연속된 줄을 ul로 감싸기)
  html = html.replace(/((?:^- .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((line) => {
      return '<li>' + line.replace(/^- /, '') + '</li>';
    }).join('');
    return '<ul>' + items + '</ul>';
  });

  // 빈 줄을 기준으로 나머지 텍스트를 p 태그로 감싸기
  html = html.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<li') || trimmed.startsWith('</')) return line;
    return '<p>' + trimmed + '</p>';
  }).join('\n');

  return html;
}

// Init
loadSettings();
