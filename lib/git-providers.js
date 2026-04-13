// ========== Git Provider Abstraction ==========

class GitHubProvider {
  constructor(token, username) {
    this.token = token;
    this.username = username;
    this.baseUrl = 'https://api.github.com';
    this.type = 'github';
    this._loginName = null; // 실제 GitHub login (캐시)
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
    };
  }

  /**
   * 실제 GitHub login ID를 가져옴 (한글 이름이 아닌 영문 login)
   * /user API로 인증된 사용자의 정확한 login을 확인
   */
  async _getLoginName() {
    if (this._loginName) return this._loginName;
    try {
      const res = await fetch(`${this.baseUrl}/user`, { headers: this.headers() });
      if (res.ok) {
        const user = await res.json();
        this._loginName = user.login;
        console.log(`GitHub 실제 login: ${user.login} (설정된 username: ${this.username})`);
        return user.login;
      }
    } catch (e) {
      console.warn('GitHub /user API 실패:', e);
    }
    // fallback: 설정된 username 사용
    return this.username;
  }

  async getAllRepos() {
    const repos = [];
    let page = 1;
    while (true) {
      const url = `${this.baseUrl}/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`GitHub repos API 실패: ${res.status}`);
      const data = await res.json();
      if (data.length === 0) break;
      for (const r of data) {
        repos.push({ fullName: r.full_name, source: 'GitHub' });
      }
      if (data.length < 100) break;
      page++;
    }
    return repos;
  }

  async getCommitsByDate(since, until, selectedRepos = []) {
    let repoNames;
    if (selectedRepos.length > 0) {
      // 실제 GitHub 레포 목록을 가져와서, 선택된 레포와 교차 필터링
      // (Gitea 레포가 GitHub API로 호출되는 문제 방지)
      const myRepos = await this._getMyRepoNames();
      const selectedSet = new Set(selectedRepos);
      repoNames = myRepos.filter((r) => selectedSet.has(r));
      console.log(`GitHub: 선택된 레포 ${selectedRepos.length}개 중 GitHub 레포 ${repoNames.length}개 매칭`);
    } else {
      repoNames = await this._getActiveRepos(since);
    }

    const results = [];
    for (const repo of repoNames) {
      try {
        const commits = await this._getRepoCommits(repo, since, until);
        if (commits.length > 0) {
          results.push({ provider: 'GitHub', repo, commits });
        }
      } catch (e) {
        console.warn(`GitHub: ${repo} 커밋 조회 실패`, e);
      }
    }
    return results;
  }

  /**
   * 현재 사용자의 GitHub 레포 fullName 목록 (캐시)
   */
  async _getMyRepoNames() {
    if (this._myRepoNames) return this._myRepoNames;
    try {
      const repos = await this.getAllRepos();
      this._myRepoNames = repos.map((r) => r.fullName);
      return this._myRepoNames;
    } catch (e) {
      console.warn('GitHub 레포 목록 조회 실패:', e);
      return [];
    }
  }

  async _getActiveRepos(since) {
    const url = `${this.baseUrl}/users/${this.username}/events?per_page=100`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub events API 실패: ${res.status}`);
    const events = await res.json();

    const repos = new Set();
    const sinceDate = new Date(since);
    for (const event of events) {
      if (new Date(event.created_at) >= sinceDate && event.type === 'PushEvent') {
        repos.add(event.repo.name);
      }
    }
    return Array.from(repos);
  }

  async _getRepoCommits(repoFullName, since, until) {
    const login = await this._getLoginName();
    const url = `${this.baseUrl}/repos/${repoFullName}/commits?author=${encodeURIComponent(login)}&since=${since}&until=${until}&per_page=100`;
    console.log(`GitHub API 호출: ${url}`);
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      console.warn(`GitHub API ${res.status}: ${repoFullName} (author=${login})`);
      return [];
    }
    const data = await res.json();
    const loginLower = login.toLowerCase();

    return data
      .filter((c) => {
        // 머지 커밋 제외
        if (c.parents && c.parents.length >= 2) return false;
        const authorLogin = c.author?.login?.toLowerCase() || '';
        return authorLogin === loginLower;
      })
      .map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        date: c.commit.author.date,
        url: c.html_url,
      }));
  }

  async getCommitDiff(repoFullName, sha) {
    const url = `${this.baseUrl}/repos/${repoFullName}/commits/${sha}`;
    const res = await fetch(url, {
      headers: { ...this.headers(), Accept: 'application/vnd.github.v3.diff' },
    });
    if (!res.ok) return '';
    return truncateDiff(await res.text(), 8000);
  }
}

class GiteaProvider {
  constructor(url, token, username, instanceName, gitEmail) {
    this.baseUrl = url.replace(/\/+$/, '');
    this.token = token;
    this.username = username;
    this.instanceName = instanceName || this.baseUrl;
    this.gitEmail = gitEmail || '';  // 설정에서 입력한 git author email
    this.type = 'gitea';
    this._myIdentifiers = null; // 캐시: 매칭용 식별자 세트
  }

  headers() {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/json',
    };
  }

  /**
   * 내 식별자 세트를 구축 (한 번만 실행, 캐시됨)
   * - 설정의 username, gitEmail
   * - /api/v1/user 의 login, full_name, email
   * - /api/v1/user/emails 의 모든 이메일
   */
  async _getMyIdentifiers() {
    if (this._myIdentifiers) return this._myIdentifiers;

    // 엄격 매칭: 이메일(전체) + 로그인만 사용, 로컬 파트/이름 제외
    const emails = new Set();  // 정확한 이메일 주소만
    const logins = new Set();  // Gitea 로그인 ID만

    // 1) 설정값
    if (this.username) logins.add(this.username.toLowerCase());
    if (this.gitEmail) emails.add(this.gitEmail.toLowerCase());

    // 2) /api/v1/user - 프로필 정보
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/user`, { headers: this.headers() });
      if (res.ok) {
        const user = await res.json();
        if (user.login) logins.add(user.login.toLowerCase());
        if (user.email) emails.add(user.email.toLowerCase());
      }
    } catch (e) {
      console.warn('Gitea /user API 실패:', e);
    }

    // 3) /api/v1/user/emails - 등록된 모든 이메일
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/user/emails`, { headers: this.headers() });
      if (res.ok) {
        const emailList = await res.json();
        for (const entry of emailList) {
          if (entry.email) emails.add(entry.email.toLowerCase());
        }
      }
    } catch (e) {
      console.warn('Gitea /user/emails API 실패:', e);
    }

    emails.delete('');
    logins.delete('');

    const result = { emails, logins };
    console.log('Gitea 매칭 식별자 - emails:', Array.from(emails), 'logins:', Array.from(logins));
    this._myIdentifiers = result;
    return result;
  }

  /**
   * 커밋이 내 커밋인지 확인 (엄격 매칭: 이메일 or 로그인 일치만)
   */
  async _isMyCommit(commit) {
    const { emails, logins } = await this._getMyIdentifiers();

    // 머지 커밋 제외 (parents가 2개 이상이면 머지)
    if (commit.parents && commit.parents.length >= 2) {
      console.log(`[_isMyCommit] SKIP 머지: ${commit.sha?.substring(0,7)} parents=${commit.parents.length}`);
      return false;
    }

    // author만 체크 (committer는 머지/리베이스 시 다른 사람 커밋도 본인으로 찍힘)
    const authorEmail = (commit.commit.author?.email || '').toLowerCase();
    const topAuthorLogin = (commit.author?.login || '').toLowerCase();

    const emailMatch = authorEmail && emails.has(authorEmail);
    const loginMatch = topAuthorLogin && logins.has(topAuthorLogin);

    if (!emailMatch && !loginMatch) {
      console.log(`[_isMyCommit] NO MATCH: sha=${commit.sha?.substring(0,7)} authorEmail="${authorEmail}" authorLogin="${topAuthorLogin}" | myEmails=${Array.from(emails)} myLogins=${Array.from(logins)}`);
    }

    if (emailMatch || loginMatch) return true;
    return false;
  }

  async getAllRepos() {
    const repos = [];
    let page = 1;
    while (true) {
      const url = `${this.baseUrl}/api/v1/user/repos?limit=50&page=${page}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Gitea repos API 실패: ${res.status}`);
      const data = await res.json();
      if (data.length === 0) break;
      for (const r of data) {
        repos.push({
          fullName: r.full_name,
          source: `Gitea (${this.instanceName})`,
        });
      }
      if (data.length < 50) break;
      page++;
    }
    return repos;
  }

  async getCommitsByDate(since, until, selectedRepos = []) {
    // 매칭용 식별자 미리 로드
    await this._getMyIdentifiers();

    let reposToSearch;
    if (selectedRepos.length > 0) {
      const allRepos = await this._getUserRepos();
      const selectedSet = new Set(selectedRepos);
      reposToSearch = allRepos.filter((r) => selectedSet.has(r.full_name));
      console.log(`[Gitea] 전체 레포 ${allRepos.length}개, 선택된 레포 ${selectedRepos.length}개, 매칭 ${reposToSearch.length}개`);
      console.log(`[Gitea] 선택된 레포:`, selectedRepos);
      console.log(`[Gitea] API 레포:`, allRepos.map(r => r.full_name));
      console.log(`[Gitea] 매칭된 레포:`, reposToSearch.map(r => r.full_name));
    } else {
      reposToSearch = await this._getUserRepos();
    }

    const results = [];
    for (const repo of reposToSearch) {
      try {
        const commits = await this._getRepoCommits(repo, since, until);
        console.log(`[Gitea] ${repo.full_name}: ${commits.length}건 커밋 발견`);
        if (commits.length > 0) {
          results.push({
            provider: `Gitea (${this.instanceName})`,
            repo: repo.full_name,
            commits,
          });
        }
      } catch (e) {
        console.warn(`Gitea: ${repo.full_name} 커밋 조회 실패`, e);
      }
    }
    return results;
  }

  async _getUserRepos() {
    const repos = [];
    let page = 1;
    while (true) {
      const url = `${this.baseUrl}/api/v1/user/repos?limit=50&page=${page}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Gitea repos API 실패: ${res.status}`);
      const data = await res.json();
      if (data.length === 0) break;
      repos.push(...data);
      if (data.length < 50) break;
      page++;
    }
    console.log(`[Gitea] _getUserRepos: ${repos.length}개 (${page}페이지)`);
    return repos;
  }

  async _getRepoCommits(repo, since, until) {
    const targetDate = since.split('T')[0]; // "2026-04-10"

    // 1) 레포의 브랜치 목록 가져오기
    const branches = await this._getRepoBranches(repo.full_name);
    console.log(`[_getRepoCommits] repo=${repo.full_name}, targetDate=${targetDate}, branches=${branches.join(',')}`);

    // 2) 모든 브랜치에서 병렬로 커밋 검색, SHA로 중복 제거
    const seenSha = new Set();
    const filtered = [];

    // 브랜치를 3개씩 병렬 처리
    const BRANCH_BATCH = 3;
    for (let bi = 0; bi < branches.length; bi += BRANCH_BATCH) {
      const branchBatch = branches.slice(bi, bi + BRANCH_BATCH);
      const branchPromises = branchBatch.map(branch =>
        this._getCommitsForBranch(repo, branch, targetDate)
      );
      const branchResults = await Promise.all(branchPromises);

      for (const commits of branchResults) {
        for (const c of commits) {
          if (seenSha.has(c.sha)) continue;
          seenSha.add(c.sha);
          filtered.push(c);
        }
      }
    }

    console.log(`[_getRepoCommits] ${repo.full_name} 결과: ${filtered.length}건 (${branches.length}개 브랜치 검색)`);
    return filtered;
  }

  /**
   * 레포의 브랜치 목록 조회
   */
  async _getRepoBranches(repoFullName) {
    try {
      const url = `${this.baseUrl}/api/v1/repos/${repoFullName}/branches?limit=50`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) return ['main'];
      const data = await res.json();
      return data.map(b => b.name);
    } catch (e) {
      console.warn(`브랜치 목록 조회 실패: ${repoFullName}`, e);
      return ['main'];
    }
  }

  /**
   * 특정 브랜치에서 targetDate 커밋 검색
   *
   * 이진 탐색(Binary Search) 알고리즘:
   * - 커밋은 역시간순(newest→oldest) 정렬됨
   * - X-Total 헤더로 총 페이지 수 파악
   * - 이진 탐색으로 targetDate가 포함된 페이지를 log₂(N)회 만에 찾음
   * - 찾은 페이지 주변만 정밀 스캔
   *
   * 예: 60페이지 레포에서 1개월 전 날짜 → 최대 6+3회 = ~9회 API 호출
   *     (순차 스캔 대비 60회 → 9회로 85% 감소)
   */
  async _getCommitsForBranch(repo, branch, targetDate) {
    const perPage = 50;
    const branchParam = encodeURIComponent(branch);
    const mkUrl = (page) => `${this.baseUrl}/api/v1/repos/${repo.full_name}/commits?sha=${branchParam}&limit=${perPage}&page=${page}&stat=false&files=false&verification=false`;

    // ── 1단계: 1페이지 조회 → 전체 페이지 수 + 최신 날짜 확인 ──
    const firstRes = await fetch(mkUrl(1), { headers: this.headers() });
    if (!firstRes.ok) return [];
    const firstData = await firstRes.json();
    if (firstData.length === 0) return [];

    const totalCommits = parseInt(firstRes.headers.get('X-Total') || '0');
    const totalPages = Math.ceil(totalCommits / perPage) || 1;

    // 1페이지 첫 커밋(=최신)이 targetDate보다 과거면 → 해당 날짜 커밋 없음
    const latestDate = this._commitDate(firstData[0]);
    if (targetDate > latestDate) return [];

    console.log(`[Branch:${branch}] total=${totalCommits}, pages=${totalPages}, latest=${latestDate}, target=${targetDate}`);

    // ── 2단계: 이진 탐색 → targetDate 커밋이 시작되는 페이지 찾기 ──
    // 찾으려는 것: targetDate 이상인 커밋이 있는 가장 마지막 페이지
    // 페이지의 마지막 커밋 날짜가 targetDate 이상이면 → 더 뒤 페이지에도 있을 수 있음
    // 페이지의 마지막 커밋 날짜가 targetDate 미만이면 → 이 페이지가 경계
    let left = 1, right = totalPages;

    // 1페이지는 이미 가져왔으므로 캐시
    const pageCache = new Map();
    pageCache.set(1, firstData);

    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      const data = await this._fetchPage(mkUrl, mid, pageCache);
      if (!data || data.length === 0) { right = mid - 1; continue; }

      const pageFirstDate = this._commitDate(data[0]); // 이 페이지의 최신 커밋

      if (pageFirstDate >= targetDate) {
        // 이 페이지에도 targetDate 이상 커밋 있음 → 더 뒤로
        left = mid;
      } else {
        // 이 페이지는 전부 targetDate 이전 → 앞으로
        right = mid - 1;
      }
    }
    // left = targetDate 커밋이 포함된 마지막 페이지

    console.log(`[Branch:${branch}] 이진탐색 완료 → 시작 페이지=${left}`);

    // ── 3단계: 해당 페이지부터 앞으로 스캔하며 targetDate 커밋 수집 ──
    // left 페이지부터 1페이지 방향(최신)으로 거슬러 올라감
    const filtered = [];

    for (let page = left; page >= 1; page--) {
      const data = await this._fetchPage(mkUrl, page, pageCache);
      if (!data || data.length === 0) break;

      let hasTargetDate = false;
      for (const c of data) {
        const d = this._commitDate(c);
        if (d === targetDate) {
          hasTargetDate = true;
          const isMe = await this._isMyCommit(c);
          if (isMe) {
            filtered.push({
              sha: c.sha,
              message: c.commit.message,
              date: c.commit.author?.date || c.created,
              url: c.html_url,
            });
          }
        }
      }

      // 이 페이지에 targetDate 커밋이 하나도 없고, 전부 미래 날짜면 → 더 이상 볼 필요 없음
      const pageOldestDate = this._commitDate(data[data.length - 1]);
      if (pageOldestDate > targetDate && !hasTargetDate) break;
    }

    // left 페이지 다음(더 오래된) 페이지에도 targetDate가 있을 수 있으므로 뒤쪽도 확인
    for (let page = left + 1; page <= totalPages; page++) {
      const data = await this._fetchPage(mkUrl, page, pageCache);
      if (!data || data.length === 0) break;

      let foundOlder = false;
      for (const c of data) {
        const d = this._commitDate(c);
        if (d < targetDate) { foundOlder = true; break; }
        if (d !== targetDate) continue;
        const isMe = await this._isMyCommit(c);
        if (isMe) {
          filtered.push({
            sha: c.sha,
            message: c.commit.message,
            date: c.commit.author?.date || c.created,
            url: c.html_url,
          });
        }
      }
      if (foundOlder) break;
    }

    return filtered;
  }

  /** 페이지 fetch (캐시 사용) */
  async _fetchPage(mkUrl, page, cache) {
    if (cache.has(page)) return cache.get(page);
    try {
      const res = await fetch(mkUrl(page), { headers: this.headers() });
      const data = res.ok ? await res.json() : [];
      cache.set(page, data);
      return data;
    } catch {
      return [];
    }
  }

  /** 커밋의 로컬 날짜 추출 */
  _commitDate(c) {
    return getLocalDateFromISO(c.commit.author?.date || c.created);
  }

  async getCommitDiff(repoFullName, sha) {
    const url = `${this.baseUrl}/api/v1/repos/${repoFullName}/git/commits/${sha}.diff`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.ok) return truncateDiff(await res.text(), 8000);

    const url2 = `${this.baseUrl}/api/v1/repos/${repoFullName}/git/commits/${sha}`;
    const res2 = await fetch(url2, { headers: this.headers() });
    if (!res2.ok) return '';
    const data = await res2.json();
    if (data.files && data.files.length > 0) {
      const patchText = data.files
        .map((f) => `--- ${f.filename}\n+++ ${f.filename}\n${f.patch || '(binary)'}`)
        .join('\n\n');
      return truncateDiff(patchText, 8000);
    }
    return '';
  }
}

// ========== Utility ==========

/**
 * ISO 날짜 문자열에서 로컬 날짜(YYYY-MM-DD)를 추출
 * "2026-04-10T15:05:36+09:00" → "2026-04-10"
 * 타임존 오프셋이 포함된 경우 해당 타임존 기준 날짜를 사용
 */
function getLocalDateFromISO(isoStr) {
  if (!isoStr) return '';

  // 타임존 오프셋이 있으면 (예: +09:00) 그 기준으로 날짜 추출
  // 오프셋이 없으면 (Z) UTC 기준
  const d = new Date(isoStr);

  // 오프셋 파싱: "+09:00" → +540분, "-05:00" → -300분
  const offsetMatch = isoStr.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '+' ? 1 : -1;
    const hours = parseInt(offsetMatch[2]);
    const mins = parseInt(offsetMatch[3]);
    const totalOffsetMs = sign * (hours * 60 + mins) * 60 * 1000;

    // UTC 시간 + 오프셋 = 로컬 시간
    const localTime = new Date(d.getTime() + totalOffsetMs + d.getTimezoneOffset() * 60000);
    // 아니, 더 간단하게: isoStr 앞의 YYYY-MM-DD 부분이 이미 로컬 시간 기준
    // "2026-04-10T15:05:36+09:00" → 앞의 "2026-04-10"이 KST 기준 날짜
    return isoStr.substring(0, 10);
  }

  // "Z" 또는 오프셋 없음 → UTC 기준
  if (isoStr.endsWith('Z') || !isoStr.match(/[+-]\d{2}:\d{2}$/)) {
    return d.toISOString().substring(0, 10);
  }

  return isoStr.substring(0, 10);
}

function truncateDiff(diff, maxLen) {
  if (!diff) return '';
  if (diff.length <= maxLen) return diff;
  return diff.substring(0, maxLen) + '\n\n... (diff truncated)';
}

if (typeof self !== 'undefined') {
  self.GitHubProvider = GitHubProvider;
  self.GiteaProvider = GiteaProvider;
}
