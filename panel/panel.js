// 갤러리 프롬프트 패널 - 사이드패널 로직
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const DEFAULT_SETTINGS = {
    origin: 'https://gallery.ai-thanks.com',
    insertMode: 'caret',
    autoComma: true,
    showRegion: true,
    markerColor: '#facc15',
    markerBg: '',
  };

  const MARKER_COLORS = [
    ['검정', '#000000'],
    ['하양', '#ffffff'],
    ['노랑', '#facc15'],
    ['파랑', '#3b82f6'],
    ['주황', '#fb923c'],
    ['초록', '#22c55e'],
  ];

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    csrf: null,
    galleries: [],
    accountId: null,
    sections: [],
    filter: { sectionId: 0, folderId: 0, q: '' },
    posts: [],
    total: 0,
    page: 1,
    perPage: 20,
    nav: { sectionId: 0, folderId: 0 }, // 저장 위치 탐색기 현재 위치
    browseOpen: false, // 탐색 내비게이터 펼침 여부 (기본 접힘)
    applied: null, // {promptId, title, edited}
    pendingImage: null, // {dataUrl, mime}
    naiTabId: null,
    loadingPosts: false,
  };

  // ---------- 유틸 ----------

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function dataUrlToBlob(dataUrl) {
    const [head, body] = dataUrl.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function assetUrl(path) {
    if (!path) return '';
    return /^(data:|blob:|https?:)/.test(path) ? path : state.settings.origin + path;
  }

  function extFromMime(mime) {
    if (/jpe?g/.test(mime)) return 'jpg';
    if (/webp/.test(mime)) return 'webp';
    if (/gif/.test(mime)) return 'gif';
    return 'png';
  }

  // ---------- 설정 ----------

  async function loadSettings() {
    const data = await chrome.storage.local.get(['gppSettings', 'gppAccountId', 'gppSaveTarget']);
    state.settings = { ...DEFAULT_SETTINGS, ...(data.gppSettings || {}) };
    state.accountId = data.gppAccountId || null;
    state.saveTarget = data.gppSaveTarget || null; // {sectionId, folderId}
  }

  function persistSettings() {
    chrome.storage.local.set({ gppSettings: state.settings });
  }

  // ---------- 갤러리 API ----------

  function apiUrl(action, params = {}) {
    const u = new URL('/api.php', state.settings.origin);
    u.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async function apiGet(action, params) {
    const resp = await fetch(apiUrl(action, params), { credentials: 'include' });
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('갤러리 서버 응답을 읽지 못했어요. (api.php 배포 확인)');
    }
    if (!json.ok) throw new Error(json.error || '요청에 실패했어요.');
    return json;
  }

  async function apiPost(formData) {
    const resp = await fetch(new URL('/api.php', state.settings.origin).toString(), {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const json = await resp.json().catch(() => null);
    if (!json) throw new Error('갤러리 서버 응답을 읽지 못했어요.');
    if (!json.ok) throw new Error(json.error || '요청에 실패했어요.');
    return json;
  }

  // ---------- NAI 탭 ----------

  async function findNaiTab() {
    const tabs = await chrome.tabs.query({ url: 'https://novelai.net/*' });
    if (!tabs.length) return null;
    const active = tabs.find((t) => t.active) || tabs[0];
    return active;
  }

  async function naiSend(msg) {
    const tab = await findNaiTab();
    if (!tab) throw new Error('NovelAI 탭이 열려 있지 않아요.');
    state.naiTabId = tab.id;
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      throw new Error('NAI 페이지와 연결하지 못했어요. NAI 탭을 새로고침해 주세요.');
    }
  }

  async function checkNaiStatus() {
    const el = $('naiStatus');
    try {
      const resp = await naiSend({ type: 'nai:getState' });
      if (resp && resp.editorFound) {
        el.textContent = 'NAI 연결됨';
        el.className = 'status-chip ok';
      } else {
        el.textContent = 'NAI: 프롬프트 창 없음';
        el.className = 'status-chip bad';
      }
      if (resp && resp.region) {
        setApplied({
          promptId: resp.region.promptId,
          title: resp.region.title,
          edited: resp.region.edited,
        });
      } else if (resp) {
        setApplied(null);
      }
    } catch (e) {
      el.textContent = 'NAI 탭 없음';
      el.className = 'status-chip bad';
    }
  }

  // ---------- 로그인 / 갤러리 선택 ----------

  async function refreshWhoami() {
    const gs = $('galleryStatus');
    try {
      const json = await apiGet('whoami');
      state.csrf = json.csrf;
      state.galleries = json.galleries || [];
      if (!json.logged_in) {
        gs.textContent = '갤러리: 로그인 필요';
        gs.className = 'status-chip bad';
        $('loginSection').hidden = false;
        $('browserSection').hidden = true;
        return false;
      }
      gs.textContent = '갤러리 연결됨';
      gs.className = 'status-chip ok';
      $('loginSection').hidden = true;
      $('browserSection').hidden = false;

      if (!state.galleries.some((g) => g.account_id === state.accountId)) {
        state.accountId = state.galleries[0].account_id;
      }
      renderGallerySelect();
      refreshMetaUI(true);
      return true;
    } catch (e) {
      gs.textContent = '갤러리 연결 실패';
      gs.className = 'status-chip bad';
      $('loginSection').hidden = false;
      $('browserSection').hidden = true;
      toast(e.message, true);
      return false;
    }
  }

  function renderGallerySelect() {
    const sel = $('gallerySelect');
    sel.innerHTML = '';
    for (const g of state.galleries) {
      const opt = document.createElement('option');
      opt.value = String(g.account_id);
      opt.textContent = g.name || g.slug;
      sel.appendChild(opt);
    }
    if (!state.galleries.length) {
      const opt = document.createElement('option');
      opt.textContent = '갤러리 프롬프트';
      sel.appendChild(opt);
    }
    sel.value = String(state.accountId || '');
    sel.disabled = state.galleries.length <= 1;
  }

  // ---------- 트리(탭/폴더) ----------

  async function loadTree() {
    if (!state.accountId) return;
    const json = await apiGet('tree', { account_id: state.accountId });
    state.sections = json.sections || [];
    renderSectionChips();
    renderBrowseNav();
    renderSaveTargets();
  }

  function renderSectionChips() {
    const nav = $('sectionChips');
    nav.innerHTML = '';
    const mk = (label, id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (state.filter.sectionId === id ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        state.filter.sectionId = id;
        state.filter.folderId = 0;
        renderSectionChips();
        renderBrowseNav();
        reloadPosts();
      });
      nav.appendChild(b);
    };
    mk('전체', 0);
    for (const s of state.sections) mk(s.name, s.id);
  }

  function flatFolders(folders, depth = 0, out = []) {
    for (const f of folders) {
      out.push({ ...f, depth });
      if (f.children && f.children.length) flatFolders(f.children, depth + 1, out);
    }
    return out;
  }

  /** 자신 + 하위 폴더의 게시글 수 합계 */
  function subtreeSum(f) {
    const own = typeof f.item_count === 'number' ? f.item_count : 0;
    return own + (f.children || []).reduce((s, c) => s + subtreeSum(c), 0);
  }

  /** 서버가 폴더별 게시글 수를 내려주는지 (구버전 api.php 호환) */
  function hasCounts(folders) {
    for (const f of folders) {
      if (typeof f.item_count === 'number') return true;
      if (f.children && f.children.length && hasCounts(f.children)) return true;
    }
    return false;
  }

  /** 게시글이 하나도 없는 (하위 포함) 폴더 가지치기 — 탐색 드롭다운용 */
  function pruneEmptyFolders(folders) {
    const out = [];
    for (const f of folders) {
      const kids = pruneEmptyFolders(f.children || []);
      const own = typeof f.item_count === 'number' ? f.item_count : 0;
      if (own > 0 || kids.length) out.push({ ...f, children: kids });
    }
    return out;
  }

  function renderBrowseNav() {
    const crumbs = $('browseCrumbs');
    const list = $('browseList');
    crumbs.innerHTML = '';
    list.innerHTML = '';

    let section = state.filter.sectionId
      ? state.sections.find((sct) => sct.id === state.filter.sectionId) || null
      : null;
    if (state.filter.sectionId && !section) {
      state.filter.sectionId = 0;
      state.filter.folderId = 0;
    }

    // 현재 폴더 경로 확인 (사라진 폴더면 탭 루트로)
    let chain = [];
    let current = null;
    if (section && state.filter.folderId) {
      const found = findFolderInTree(section.folders, state.filter.folderId);
      if (found) {
        chain = found.path;
        current = found.folder;
      } else {
        state.filter.folderId = 0;
      }
    }

    const go = (sectionId, folderId) => {
      state.filter.sectionId = sectionId;
      state.filter.folderId = folderId;
      renderSectionChips();
      renderBrowseNav();
      reloadPosts();
    };

    const addCrumb = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb' + (onClick ? '' : ' current');
      b.textContent = label;
      b.title = label;
      if (onClick) b.addEventListener('click', onClick);
      crumbs.appendChild(b);
    };
    const addSep = () => {
      const sp = document.createElement('span');
      sp.className = 'crumb-sep';
      sp.textContent = '›';
      crumbs.appendChild(sp);
    };

    addCrumb('전체', section ? () => go(0, 0) : null);
    if (section) {
      addSep();
      addCrumb(section.name, chain.length ? () => go(section.id, 0) : null);
      chain.forEach((f, i) => {
        addSep();
        addCrumb(f.name, i === chain.length - 1 ? null : () => go(section.id, f.id));
      });
    }

    // 우측 접기/펼치기 화살표
    const toggle = document.createElement('span');
    toggle.className = 'nav-toggle';
    toggle.textContent = state.browseOpen ? '▴' : '▾';
    toggle.title = state.browseOpen ? '접기' : '펼치기';
    crumbs.appendChild(toggle);

    list.hidden = !state.browseOpen;

    const addRow = (name, meta, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'folder-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'fr-name';
      nameEl.textContent = name;
      b.appendChild(nameEl);
      if (meta) {
        const metaEl = document.createElement('span');
        metaEl.className = 'fr-meta';
        metaEl.textContent = meta;
        b.appendChild(metaEl);
      }
      b.addEventListener('click', onClick);
      list.appendChild(b);
    };

    if (!section) {
      // '전체' 루트: 탭 목록
      for (const sct of state.sections) {
        const counted = hasCounts(sct.folders);
        const total = counted ? sct.folders.reduce((sum, f) => sum + subtreeSum(f), 0) : null;
        addRow(`📂 ${sct.name}`, `${total !== null ? total + '개 · ' : ''}›`, () => go(sct.id, 0));
      }
    } else {
      // 탭/폴더 안: 하위 폴더 목록 (빈 폴더 숨김 + 개수)
      const baseFolders = current ? current.children || [] : section.folders;
      const counted = hasCounts(section.folders);
      const folders = counted ? pruneEmptyFolders(baseFolders) : baseFolders;
      for (const f of folders) {
        const kids = (f.children || []).length;
        const meta = `${counted ? subtreeSum(f) + '개' : ''}${kids ? (counted ? ' · ' : '') + '›' : ''}`;
        addRow(`📁 ${f.name}`, meta, () => go(section.id, f.id));
      }
    }
  }

  // ---------- 프롬프트 목록 ----------

  async function reloadPosts() {
    state.page = 1;
    state.posts = [];
    await loadPosts();
  }

  async function loadPosts() {
    if (!state.accountId || state.loadingPosts) return;
    state.loadingPosts = true;
    try {
      const json = await apiGet('posts', {
        account_id: state.accountId,
        section_id: state.filter.sectionId || '',
        folder_id: state.filter.folderId || '',
        q: state.filter.q,
        page: state.page,
        per_page: state.perPage,
      });
      state.total = json.total;
      state.posts = json.items;
      renderPosts();
    } catch (e) {
      toast(e.message, true);
    } finally {
      state.loadingPosts = false;
    }
  }

  function promptSummary(post) {
    return (
      post.common_prompt || post.extra_prompt_1 || post.extra_prompt_2 || post.extra_prompt_3 || post.content || ''
    ).trim();
  }

  /** [적용] 버튼용 텍스트: 공통 프롬프트가 비어 있으면 네거티브가 아닌 첫 추가 프롬프트로 폴백 */
  function mainApplyText(post) {
    const cp = (post.common_prompt || '').trim();
    if (cp) return cp;
    for (let i = 1; i <= 3; i++) {
      const p = (post['extra_prompt_' + i] || '').trim();
      if (!p) continue;
      const t = (post['extra_title_' + i] || '');
      if (/네거|negative|neg\b|undesired|\buc\b/i.test(t)) continue; // 네거티브는 베이스 프롬프트에 넣지 않음
      return p;
    }
    return '';
  }

  function renderPosts() {
    const list = $('postList');
    list.innerHTML = '';
    for (const post of state.posts) list.appendChild(renderCard(post));
    $('listEmpty').hidden = state.posts.length > 0;
    renderPager();
    highlightApplied();
  }

  function totalPages() {
    return Math.max(1, Math.ceil(state.total / state.perPage));
  }

  function pageNumbers(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const wanted = new Set([1, total, cur - 1, cur, cur + 1]);
    const list = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const p of list) {
      if (p - prev > 1) out.push('gap');
      out.push(p);
      prev = p;
    }
    return out;
  }

  function renderPager() {
    const pager = $('pager');
    const pages = totalPages();
    pager.innerHTML = '';
    pager.hidden = pages <= 1;
    if (pages <= 1) return;

    const mk = (label, page, opts = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'page-btn' + (opts.current ? ' current' : '');
      b.textContent = label;
      b.disabled = !!opts.disabled;
      if (!opts.disabled && !opts.current) b.addEventListener('click', () => gotoPage(page));
      pager.appendChild(b);
    };
    mk('◀', state.page - 1, { disabled: state.page <= 1 });
    for (const p of pageNumbers(state.page, pages)) {
      if (p === 'gap') {
        const s = document.createElement('span');
        s.className = 'page-gap';
        s.textContent = '…';
        pager.appendChild(s);
      } else {
        mk(String(p), p, { current: p === state.page });
      }
    }
    mk('▶', state.page + 1, { disabled: state.page >= pages });
  }

  async function gotoPage(p) {
    const next = Math.min(Math.max(1, p), totalPages());
    if (next === state.page || state.loadingPosts) return;
    state.page = next;
    await loadPosts();
    $('postList').scrollTop = 0;
  }

  function renderCard(post) {
    const card = document.createElement('article');
    card.className = 'post-card';
    card.dataset.postId = String(post.id);

    if (post.thumb_url) {
      const img = document.createElement('img');
      img.className = 'post-thumb';
      img.loading = 'lazy';
      img.src = assetUrl(post.thumb_url);
      img.alt = '';
      img.title = '원본 이미지 보기';
      img.addEventListener('click', () => {
        chrome.tabs.create({ url: assetUrl(post.image_url || post.thumb_url) });
      });
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'post-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'post-title-row';
    const title = document.createElement('span');
    title.className = 'post-title';
    title.textContent = post.title || '(제목 없음)';
    titleRow.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'post-badge';
    badge.hidden = true;
    titleRow.appendChild(badge);
    body.appendChild(titleRow);

    const folder = document.createElement('div');
    folder.className = 'post-folder';
    folder.textContent = [post.section_name, post.folder_name].filter(Boolean).join(' › ')
      + (post.locked ? ' · 🔒' : '')
      + (post.is_visible ? '' : ' · 숨김');
    body.appendChild(folder);

    const preview = document.createElement('div');
    preview.className = 'post-preview';
    preview.textContent = promptSummary(post) || '(프롬프트 없음)';
    preview.title = '클릭해서 전체 보기/접기';
    preview.addEventListener('click', () => preview.classList.toggle('expanded'));
    body.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'post-actions';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'mini-btn';
    applyBtn.textContent = state.applied && state.applied.promptId === post.id ? '다시 적용' : '적용';
    applyBtn.addEventListener('click', () => applyPost(post, mainApplyText(post), post.title));
    actions.appendChild(applyBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'mini-btn';
    copyBtn.textContent = '복사';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(promptSummary(post));
      toast('복사했어요.');
    });
    actions.appendChild(copyBtn);

    const extras = [];
    for (let i = 1; i <= 3; i++) {
      const p = (post['extra_prompt_' + i] || '').trim();
      if (p) extras.push({ name: (post['extra_title_' + i] || `추가 프롬프트 ${i}`).trim(), text: p });
    }

    if (extras.length || post.share_url) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'mini-btn';
      moreBtn.textContent = '자세히';
      const extraBox = document.createElement('div');
      extraBox.className = 'post-extras';
      extraBox.hidden = true;
      moreBtn.addEventListener('click', () => {
        extraBox.hidden = !extraBox.hidden;
        moreBtn.textContent = extraBox.hidden ? '자세히' : '접기';
      });
      actions.appendChild(moreBtn);

      for (const ex of extras) {
        const row = document.createElement('div');
        row.className = 'extra-row';
        const name = document.createElement('span');
        name.className = 'extra-name';
        name.textContent = ex.name;
        name.title = ex.text;
        row.appendChild(name);
        const a = document.createElement('button');
        a.className = 'mini-btn';
        a.textContent = '적용';
        a.addEventListener('click', () => applyPost(post, ex.text, `${post.title} · ${ex.name}`));
        row.appendChild(a);
        const c = document.createElement('button');
        c.className = 'mini-btn';
        c.textContent = '복사';
        c.addEventListener('click', async () => {
          await navigator.clipboard.writeText(ex.text);
          toast('복사했어요.');
        });
        row.appendChild(c);
        extraBox.appendChild(row);
      }

      if (post.share_url) {
        const row = document.createElement('div');
        row.className = 'extra-row';
        const link = document.createElement('button');
        link.className = 'mini-btn';
        link.textContent = '갤러리에서 보기';
        link.addEventListener('click', () => {
          chrome.tabs.create({ url: assetUrl(post.share_url) });
        });
        row.appendChild(link);
        extraBox.appendChild(row);
      }
      body.appendChild(actions);
      body.appendChild(extraBox);
    } else {
      body.appendChild(actions);
    }

    card.appendChild(body);
    return card;
  }

  // ---------- 적용 상태 ----------

  function setApplied(applied) {
    state.applied = applied;
    const banner = $('appliedBanner');
    if (!applied) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      $('appliedTitle').textContent = applied.title || '(이름 없는 프롬프트)';
      $('appliedEdited').hidden = !applied.edited;
    }
    highlightApplied();
  }

  function highlightApplied() {
    const cards = document.querySelectorAll('.post-card');
    for (const card of cards) {
      const id = Number(card.dataset.postId);
      const isApplied = !!(state.applied && state.applied.promptId === id);
      card.classList.toggle('applied', isApplied);
      const badge = card.querySelector('.post-badge');
      if (badge) {
        badge.hidden = !isApplied;
        badge.textContent = state.applied && state.applied.edited ? '적용됨 · 수정됨' : '적용됨';
      }
    }
  }

  async function applyPost(post, text, label) {
    const t = (text || '').trim();
    if (!t) {
      toast('이 게시글엔 적용할 프롬프트가 없어요. (공통·추가 프롬프트 칸이 비어 있음) [자세히]를 확인해 주세요.', true);
      return;
    }
    try {
      const resp = await naiSend({
        type: 'nai:apply',
        text: t,
        promptId: post.id,
        title: label || post.title,
        insertMode: state.settings.insertMode,
        autoComma: state.settings.autoComma,
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '적용에 실패했어요.');
      setApplied({
        promptId: resp.region ? resp.region.promptId : post.id,
        title: resp.region ? resp.region.title : (label || post.title),
        edited: false,
      });
      toast(resp.replaced ? '프롬프트를 교체했어요.' : '프롬프트를 삽입했어요.');
      checkNaiStatusSoon();
    } catch (e) {
      toast(e.message, true);
    }
  }

  let naiStatusTimer = null;
  function checkNaiStatusSoon() {
    clearTimeout(naiStatusTimer);
    naiStatusTimer = setTimeout(checkNaiStatus, 500);
  }

  // ---------- 저장 폼 ----------

  function renderSaveTargets() {
    const secSel = $('saveSection_');
    secSel.innerHTML = '';
    for (const sct of state.sections) {
      const opt = document.createElement('option');
      opt.value = String(sct.id);
      opt.textContent = sct.name;
      secSel.appendChild(opt);
    }
    const currentSel = Number(secSel.dataset.current || 0);
    let preferred;
    if (currentSel && state.sections.some((sct) => sct.id === currentSel)) {
      preferred = currentSel; // 사용자가 보고 있던 탭 유지
    } else if (state.saveTarget && state.sections.some((sct) => sct.id === state.saveTarget.sectionId)) {
      preferred = state.saveTarget.sectionId;
    } else {
      preferred = state.sections[0] ? state.sections[0].id : 0;
    }
    secSel.value = String(preferred);
    secSel.dataset.current = String(preferred);

    if (state.nav.sectionId !== preferred) {
      state.nav.sectionId = preferred;
      state.nav.folderId = 0;
      // 마지막 저장 위치가 이 탭이면 그 폴더에서 시작
      if (state.saveTarget && state.saveTarget.sectionId === preferred) {
        state.nav.folderId = state.saveTarget.folderId || 0;
      }
    }
    renderFolderNav();
  }

  // ---------- 파인더식 저장 위치 탐색기 ----------

  function findFolderInTree(folders, id, path = []) {
    for (const f of folders) {
      if (f.id === id) return { folder: f, path: [...path, f] };
      const r = findFolderInTree(f.children || [], id, [...path, f]);
      if (r) return r;
    }
    return null;
  }

  /** 현재 탐색 위치 정보: {section, chain(경로 폴더들), current(폴더|null=탭 루트), children} */
  function navInfo() {
    const section = state.sections.find((sct) => sct.id === state.nav.sectionId) || null;
    if (!section) return { section: null, chain: [], current: null, children: [] };
    if (!state.nav.folderId) return { section, chain: [], current: null, children: section.folders };
    const found = findFolderInTree(section.folders, state.nav.folderId);
    if (!found) {
      state.nav.folderId = 0; // 폴더가 사라짐 → 탭 루트로
      return { section, chain: [], current: null, children: section.folders };
    }
    return { section, chain: found.path, current: found.folder, children: found.folder.children || [] };
  }

  function renderFolderNav() {
    const info = navInfo();
    const crumbs = $('folderCrumbs');
    crumbs.innerHTML = '';

    const addCrumb = (label, folderId, isLast) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb' + (isLast ? ' current' : '');
      b.textContent = label;
      b.title = label;
      if (!isLast) {
        b.addEventListener('click', () => {
          state.nav.folderId = folderId;
          renderFolderNav();
        });
      }
      crumbs.appendChild(b);
    };
    const addSep = () => {
      const sp = document.createElement('span');
      sp.className = 'crumb-sep';
      sp.textContent = '›';
      crumbs.appendChild(sp);
    };
    addCrumb(info.section ? info.section.name : '탭', 0, info.chain.length === 0);
    info.chain.forEach((f, i) => {
      addSep();
      addCrumb(f.name, f.id, i === info.chain.length - 1);
    });

    const list = $('folderList');
    list.innerHTML = '';
    const addRow = (cls, name, meta, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'folder-row' + (cls ? ' ' + cls : '');
      const nameEl = document.createElement('span');
      nameEl.className = 'fr-name';
      nameEl.textContent = name;
      b.appendChild(nameEl);
      if (meta) {
        const metaEl = document.createElement('span');
        metaEl.className = 'fr-meta';
        metaEl.textContent = meta;
        b.appendChild(metaEl);
      }
      b.addEventListener('click', onClick);
      list.appendChild(b);
      return b;
    };

    // 위로 가기는 브레드크럼(탭/폴더 이름 클릭)으로 — 별도 행 없음
    const counted = info.section ? hasCounts(info.section.folders) : false;
    for (const f of info.children) {
      const kids = (f.children || []).length;
      const meta = `${counted ? subtreeSum(f) + '개' : ''}${kids ? (counted ? ' · ' : '') + '›' : ''}`;
      addRow('', `📁 ${f.name}`, meta, () => {
        state.nav.folderId = f.id;
        renderFolderNav();
      });
    }

    if (info.children.length === 0) {
      const note = document.createElement('p');
      note.className = 'folder-empty';
      note.textContent = info.current ? '하위 폴더가 없어요. 여기에 저장돼요.' : '폴더가 없어요.';
      list.appendChild(note);
    }

    // 새 폴더 입력칸은 헤더 버튼을 눌렀을 때만 열려요. 위치를 옮기면 다시 닫습니다.
    const addBtn = $('newFolderToggle');
    addBtn.textContent = info.current ? '＋ 하위 폴더' : '＋ 새 폴더';
    addBtn.classList.remove('is-open');
    $('newFolderBox').hidden = true;

    const canSave = !!info.current;
    $('saveSubmit').disabled = !canSave;
    $('savePathNote').textContent = canSave
      ? `저장 위치: ${info.section.name} › ${info.chain.map((f) => f.name).join(' › ')}`
      : '폴더를 클릭해 들어가면 그 폴더에 저장돼요.';
  }

  async function createFolder() {
    const name = $('newFolderName').value.trim();
    if (!name) {
      toast('폴더 이름을 입력해 주세요.', true);
      $('newFolderName').focus();
      return;
    }
    const sectionId = state.nav.sectionId;
    if (!sectionId) {
      toast('탭을 먼저 선택해 주세요.', true);
      return;
    }
    const parentId = state.nav.folderId || '';
    const btn = $('newFolderCreate');
    btn.disabled = true;
    btn.textContent = '만드는 중…';
    try {
      const fd = new FormData();
      fd.set('action', 'create_folder');
      fd.set('csrf_token', state.csrf || '');
      fd.set('account_id', String(state.accountId));
      fd.set('section_id', String(sectionId));
      fd.set('name', name);
      fd.set('parent_id', String(parentId));
      const resp = await apiPost(fd);
      await loadTree();
      if (resp.folder) state.nav = { sectionId, folderId: resp.folder.id };
      $('saveSection_').value = String(sectionId);
      $('saveSection_').dataset.current = String(sectionId);
      renderFolderNav();
      $('newFolderName').value = '';
      $('newFolderBox').hidden = true;
      toast(`'${name}' 폴더를 만들었어요. 이 폴더에 저장돼요.`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '만들기';
    }
  }

  function currentGallery() {
    return state.galleries.find((g) => g.account_id === state.accountId) || null;
  }

  /** 메타데이터 보존 체크박스/안내를 현재 갤러리 설정 기준으로 갱신 */
  function refreshMetaUI(resetCheckbox = false) {
    const g = currentGallery();
    const galleryOn = !!(g && g.preserve_originals);
    if (resetCheckbox) $('savePreserve').checked = galleryOn;
    $('metaNote').textContent = galleryOn
      ? '갤러리 설정(PNG 원본 보존)이 켜져 있어요 — 메타데이터가 함께 저장됩니다.'
      : '체크하면 이 글만 PNG 원본 그대로(NAI 메타데이터 포함) 저장돼요. 용량은 조금 커져요.';
  }

  function setSaveImage(image) {
    state.pendingImage = image;
    const img = $('saveImagePreview');
    const note = $('saveImageNote');
    if (image && image.dataUrl) {
      img.src = image.dataUrl;
      img.hidden = false;
      const sizeText = image.size
        ? (image.size >= 1024 * 1024
          ? `${(image.size / 1024 / 1024).toFixed(1)}MB`
          : `${Math.max(1, Math.round(image.size / 1024))}KB`)
        : '';
      note.textContent = image.width && image.height
        ? `${image.width}×${image.height}${sizeText ? ' · ' + sizeText : ''}`
        : '이미지 준비됨';
      $('clearImageBtn').hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      note.textContent = '이미지 없음 (저장하려면 필요)';
      $('clearImageBtn').hidden = true;
    }
  }

  // ---------- 추가 프롬프트 행 (최대 3개) ----------

  function extraRows() {
    return Array.from(document.querySelectorAll('#extraPrompts .extra-edit'));
  }

  function updateAddExtraBtn() {
    const n = extraRows().length;
    const btn = $('addExtraBtn');
    btn.textContent = `➕ 추가 프롬프트 (${n}/3)`;
    btn.disabled = n >= 3;
  }

  function addExtraRow(title = '', text = '', focus = false) {
    if (extraRows().length >= 3) return null;
    const row = document.createElement('div');
    row.className = 'extra-edit';

    const head = document.createElement('div');
    head.className = 'extra-edit-head';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 100;
    nameInput.placeholder = '이름 (예: 네거티브, left)';
    nameInput.value = title;
    head.appendChild(nameInput);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mini-btn mini-danger';
    delBtn.textContent = '✕';
    delBtn.title = '이 추가 프롬프트 삭제';
    delBtn.addEventListener('click', () => {
      row.remove();
      updateAddExtraBtn();
    });
    head.appendChild(delBtn);
    row.appendChild(head);

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = '프롬프트 내용';
    ta.value = text;
    row.appendChild(ta);

    $('extraPrompts').appendChild(row);
    updateAddExtraBtn();
    if (focus) nameInput.focus();
    return row;
  }

  function clearExtraRows() {
    $('extraPrompts').innerHTML = '';
    updateAddExtraBtn();
  }

  function collectExtras() {
    const out = [];
    for (const row of extraRows()) {
      const name = row.querySelector('input').value.trim();
      const text = row.querySelector('textarea').value.trim();
      if (text) out.push({ name, text });
    }
    return out.slice(0, 3);
  }

  function openSaveForm() {
    $('saveForm').hidden = false;
    $('saveToggle').textContent = '➖ 새 프롬프트 저장';
  }

  function toggleSaveForm() {
    const form = $('saveForm');
    form.hidden = !form.hidden;
    $('saveToggle').textContent = form.hidden ? '➕ 새 프롬프트 저장' : '➖ 새 프롬프트 저장';
  }

  async function consumePendingSave() {
    try {
      const data = await chrome.storage.session.get('pendingSave');
      const pending = data.pendingSave;
      if (!pending) return;
      await chrome.storage.session.remove('pendingSave');
      openSaveForm();
      const incoming = (pending.text || '').trim();
      const current = $('savePrompt').value.trim();
      if (!current) {
        // 첫 드래그 → 메인 프롬프트로
        $('savePrompt').value = incoming;
        toast('선택한 프롬프트를 가져왔어요. 제목과 폴더를 정해 주세요.');
      } else if (current === incoming) {
        toast('이미 같은 내용이 프롬프트에 있어요.');
      } else {
        // 이미 차 있으면 → 빈 추가 프롬프트로 (left/right처럼 나눠 담기)
        const row = addExtraRow('', incoming, false);
        if (row) {
          toast(`추가 프롬프트 ${extraRows().length}번에 넣었어요. 이름을 정해 주세요.`);
          row.querySelector('input').focus();
        } else {
          toast('프롬프트 칸이 모두 차서 넣지 못했어요. (최대 3개)', true);
        }
      }
      // 이미지는 비어 있을 때만 채움 (직접 고른 이미지를 덮어쓰지 않도록)
      if (pending.image && !state.pendingImage) setSaveImage(pending.image);
      if (!current && !$('saveTitle').value.trim()) $('saveTitle').focus();
    } catch (e) { /* ignore */ }
  }

  async function submitSave(ev) {
    ev.preventDefault();
    const title = $('saveTitle').value.trim();
    if (!title) {
      toast('제목을 입력해 주세요.', true);
      $('saveTitle').focus();
      return;
    }
    if (!state.pendingImage || !state.pendingImage.dataUrl) {
      toast('이미지가 필요해요. NAI 이미지를 가져오거나 파일을 선택해 주세요.', true);
      return;
    }
    const sectionId = state.nav.sectionId;
    const folderId = state.nav.folderId;
    if (!sectionId || !folderId) {
      toast('저장 위치 폴더를 선택해 주세요.', true);
      return;
    }

    const btn = $('saveSubmit');
    btn.disabled = true;
    btn.textContent = '저장 중…';
    try {
      const fd = new FormData();
      fd.set('action', 'add_item');
      fd.set('csrf_token', state.csrf || '');
      fd.set('account_id', String(state.accountId));
      fd.set('section_id', String(sectionId));
      fd.set('folder_id', String(folderId));
      fd.set('title', title);
      fd.set('content', $('saveContent').value.trim());
      fd.set('common_prompt', $('savePrompt').value.trim());
      const extras = collectExtras();
      for (let i = 1; i <= 3; i++) {
        const ex = extras[i - 1];
        fd.set('extra_title_' + i, ex ? ex.name : '');
        fd.set('extra_prompt_' + i, ex ? ex.text : '');
      }
      fd.set('hashtags', $('saveHashtags').value.trim());
      fd.set('is_visible', $('saveHidden').checked ? '0' : '1');
      fd.set('preserve_original', $('savePreserve').checked ? '1' : '0');
      const blob = dataUrlToBlob(state.pendingImage.dataUrl);
      fd.set('image_file', blob, 'novelai.' + extFromMime(blob.type));

      await apiPost(fd);

      state.saveTarget = { sectionId, folderId };
      chrome.storage.local.set({ gppSaveTarget: state.saveTarget });

      toast('갤러리에 저장했어요!');
      $('saveForm').reset();
      clearExtraRows();
      setSaveImage(null);
      refreshMetaUI(true);
      $('saveForm').hidden = true;
      $('saveToggle').textContent = '➕ 새 프롬프트 저장';
      renderSaveTargets();
      reloadPosts();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '갤러리에 저장';
    }
  }

  // ---------- 설정 다이얼로그 ----------

  let pendingMarker = { color: DEFAULT_SETTINGS.markerColor, bg: '' };

  function renderSwatchRow(rowEl, kind) {
    rowEl.innerHTML = '';
    const cur = String((kind === 'color' ? pendingMarker.color : pendingMarker.bg) || '').toLowerCase();
    const pick = (val) => {
      if (kind === 'color') pendingMarker.color = val;
      else pendingMarker.bg = val;
      renderSwatchRow($('markerColorRow'), 'color');
      renderSwatchRow($('markerBgRow'), 'bg');
      updateMarkerPreview();
    };

    if (kind === 'bg') {
      const none = document.createElement('button');
      none.type = 'button';
      none.className = 'swatch swatch-none' + (cur === '' ? ' selected' : '');
      none.title = '없음 (투명)';
      none.addEventListener('click', () => pick(''));
      rowEl.appendChild(none);
    }

    for (const [name, hex] of MARKER_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (cur === hex ? ' selected' : '');
      b.style.background = hex;
      b.title = name;
      b.addEventListener('click', () => pick(hex));
      rowEl.appendChild(b);
    }

    const isCustom = cur !== '' && !MARKER_COLORS.some(([, hex]) => hex === cur);
    const wrap = document.createElement('label');
    wrap.className = 'swatch swatch-custom' + (isCustom ? ' selected' : '');
    wrap.title = '직접 지정 (#색상)';
    if (isCustom) wrap.style.background = cur;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ff66aa';
    input.addEventListener('input', () => pick(input.value));
    wrap.appendChild(input);
    rowEl.appendChild(wrap);
  }

  function updateMarkerPreview() {
    for (const id of ['mkPrevA', 'mkPrevB']) {
      const el = $(id);
      el.style.color = pendingMarker.color || DEFAULT_SETTINGS.markerColor;
      if (pendingMarker.bg) {
        el.style.background = pendingMarker.bg;
        el.style.padding = '0 3px';
        el.style.textShadow = 'none';
      } else {
        el.style.background = 'transparent';
        el.style.padding = '0';
        el.style.textShadow = '0 0 3px rgba(0, 0, 0, 0.55)';
      }
    }
  }

  function openSettings() {
    $('setInsertMode').value = state.settings.insertMode;
    $('setAutoComma').checked = state.settings.autoComma;
    $('setShowRegion').checked = state.settings.showRegion !== false;
    pendingMarker = {
      color: state.settings.markerColor || DEFAULT_SETTINGS.markerColor,
      bg: state.settings.markerBg || '',
    };
    renderSwatchRow($('markerColorRow'), 'color');
    renderSwatchRow($('markerBgRow'), 'bg');
    updateMarkerPreview();
    $('settingsDialog').showModal();
  }

  function onSettingsClose() {
    if ($('settingsDialog').returnValue !== 'save') return;
    state.settings.insertMode = $('setInsertMode').value;
    state.settings.autoComma = $('setAutoComma').checked;
    state.settings.showRegion = $('setShowRegion').checked;
    state.settings.markerColor = pendingMarker.color || DEFAULT_SETTINGS.markerColor;
    state.settings.markerBg = pendingMarker.bg || '';
    persistSettings();
    refreshAll();
  }

  // ---------- 전체 새로고침 ----------

  async function refreshAll() {
    checkNaiStatus();
    const ok = await refreshWhoami();
    if (ok) {
      try {
        await loadTree();
        await reloadPosts();
      } catch (e) {
        toast(e.message, true);
      }
    }
  }

  // ---------- 이벤트 바인딩 ----------

  function bind() {
    $('refreshBtn').addEventListener('click', refreshAll);
    $('recheckBtn').addEventListener('click', refreshAll);
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsDialog').addEventListener('close', onSettingsClose);
    $('openGalleryBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: state.settings.origin + '/' });
    });

    $('gallerySelect').addEventListener('change', async () => {
      state.accountId = Number($('gallerySelect').value);
      chrome.storage.local.set({ gppAccountId: state.accountId });
      state.filter = { sectionId: 0, folderId: 0, q: '' };
      $('searchInput').value = '';
      refreshMetaUI(true);
      await loadTree();
      await reloadPosts();
    });

    $('browseCrumbs').addEventListener('click', (e) => {
      if (e.target.closest('.crumb')) return; // 이름 클릭 = 이동
      state.browseOpen = !state.browseOpen;
      renderBrowseNav();
    });

    let searchTimer = null;
    $('searchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter.q = $('searchInput').value.trim();
        reloadPosts();
      }, 300);
    });

    $('detachBtn').addEventListener('click', async () => {
      try {
        await naiSend({ type: 'nai:clearRegion' });
        setApplied(null);
        toast('추적을 해제했어요. 텍스트는 그대로 남아요.');
      } catch (e) {
        toast(e.message, true);
      }
    });

    $('removeBtn').addEventListener('click', async () => {
      try {
        const resp = await naiSend({ type: 'nai:removeRegion' });
        if (!resp.ok) throw new Error(resp.error);
        setApplied(null);
        toast('삽입했던 텍스트를 삭제했어요.');
      } catch (e) {
        toast(e.message, true);
      }
    });

    $('saveToggle').addEventListener('click', toggleSaveForm);
    $('saveForm').addEventListener('submit', submitSave);
    $('saveSection_').addEventListener('change', () => {
      const secId = Number($('saveSection_').value || 0);
      $('saveSection_').dataset.current = String(secId);
      state.nav = { sectionId: secId, folderId: 0 };
      renderFolderNav();
    });

    $('newFolderToggle').addEventListener('click', () => {
      const box = $('newFolderBox');
      box.hidden = !box.hidden;
      $('newFolderToggle').classList.toggle('is-open', !box.hidden);
      if (!box.hidden) $('newFolderName').focus();
    });
    $('newFolderCreate').addEventListener('click', createFolder);
    $('newFolderName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // 폼 전체 제출 방지
        createFolder();
      }
    });
    $('addExtraBtn').addEventListener('click', () => addExtraRow('', '', true));

    $('grabImageBtn').addEventListener('click', async () => {
      try {
        const resp = await naiSend({ type: 'nai:grabImage' });
        if (resp && resp.ok && resp.image) {
          setSaveImage(resp.image);
          toast('NAI 이미지를 가져왔어요.');
        } else {
          toast('표시 중인 생성 이미지를 찾지 못했어요.', true);
        }
      } catch (e) {
        toast(e.message, true);
      }
    });

    $('saveImageFile').addEventListener('change', () => {
      const file = $('saveImageFile').files[0];
      if (!file) return;
      const fr = new FileReader();
      fr.onload = () => setSaveImage({ dataUrl: fr.result, mime: file.type, size: file.size });
      fr.readAsDataURL(file);
    });

    $('clearImageBtn').addEventListener('click', () => setSaveImage(null));

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'nai:regionUpdate') {
        if (msg.region) {
          setApplied({ promptId: msg.region.promptId, title: msg.region.title, edited: msg.region.edited });
        } else {
          setApplied(null);
        }
      } else if (msg.type === 'panel:pendingSave' || msg.type === 'nai:saveSelection') {
        consumePendingSave();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkNaiStatusSoon();
    });
  }

  // ---------- 시작 ----------

  (async function init() {
    await loadSettings();
    bind();
    setSaveImage(null);
    await refreshAll();
    await consumePendingSave();
  })();
})();
