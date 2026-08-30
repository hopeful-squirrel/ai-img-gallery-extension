// 갤러리 프롬프트 패널 - NovelAI 콘텐츠 스크립트
// 역할:
//  1) NAI 프롬프트 에디터(ProseMirror)에 갤러리 프롬프트를 삽입/교체
//  2) 삽입한 영역을 추적(사용자가 그 부분을 수정해도 경계 유지) → 다른 프롬프트로 교체 가능
//  3) 프롬프트 드래그 선택 시 "갤러리에 저장" 칩 표시 → 선택 텍스트 + 현재 생성 이미지 캡처
(() => {
  'use strict';

  const STORAGE_KEY = 'naiRegion:base';
  const ZWSP = /\uFEFF/g;

  /** @type {HTMLElement|null} 현재 추적 중인 기본 프롬프트 에디터 */
  let editorEl = null;
  /** 에디터의 마지막 전체 텍스트 (diff 기준) */
  let lastFullText = '';
  /** 삽입 영역: {start, end, text, originalText, promptId, title} | null */
  let region = null;
  /** 에디터 내 마지막 캐럿 오프셋 (첫 삽입 위치용) */
  let lastCaretOffset = null;
  /** 에디터 내 마지막 선택 범위 {a, b, used} (변경 직전 선택 = 교체 범위 추정용) */
  let lastSelSpan = null;
  /** applyPrompt 실행 중 플래그 (자체 변경을 외부 변경으로 오인하지 않도록) */
  let applying = false;
  let persistTimer = null;
  let chipEl = null;
  let chipHideTimer = null;
  /** 추적 구간 하이라이트 표시 여부 (패널 설정과 동기화) */
  let showRegionHighlight = true;
  /** ✦ 마커 색상 (패널 설정과 동기화) */
  let markerStyle = { color: '#facc15', bg: '' };
  let overlayBox = null;
  let overlayRaf = 0;

  // ---------- 에디터 탐색 ----------

  function isRendered(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findEditor() {
    // NAI 이미지 생성 페이지의 메인 프롬프트 박스.
    // .image-gen-prompt-main 안에는 Base Prompt / Undesired Content 에디터가 함께 있고
    // 숨겨진 중복 레이아웃도 존재하므로, "화면에 보이는 것 중 첫 번째"(= Base Prompt)를 고른다.
    const inMain = Array.from(
      document.querySelectorAll('.image-gen-prompt-main div.ProseMirror[contenteditable="true"]')
    );
    const visibleMain = inMain.find(isRendered);
    if (visibleMain) return visibleMain;
    if (inMain.length) return inMain[0];
    // 구조가 바뀐 경우 대비: 페이지의 보이는 첫 번째 ProseMirror
    const all = Array.from(document.querySelectorAll('div.ProseMirror[contenteditable="true"]'));
    return all.find(isRendered) || all[0] || null;
  }

  function ensureEditor() {
    const el = findEditor();
    if (el !== editorEl) {
      if (editorEl) unbindEditor(editorEl);
      editorEl = el;
      if (editorEl) {
        bindEditor(editorEl);
        const full = getText(editorEl);
        // 에디터가 교체(리마운트)된 경우 저장된 영역을 텍스트 매칭으로 다시 고정
        reanchorRegion(full);
        lastFullText = full;
      }
      scheduleOverlayUpdate();
    }
    return editorEl;
  }

  function bindEditor(el) {
    el.addEventListener('beforeinput', onEditorBeforeInput);
    el.addEventListener('input', onEditorInput);
  }
  function unbindEditor(el) {
    el.removeEventListener('beforeinput', onEditorBeforeInput);
    el.removeEventListener('input', onEditorInput);
  }

  // ---------- 텍스트 모델 (블록 = 문단, 문단 사이 = "\n") ----------

  function blockNodes(root) {
    const kids = Array.from(root.children).filter((n) => n.nodeType === 1);
    return kids.length ? kids : [root];
  }

  function textNodesIn(block) {
    const out = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.data !== '' && n.data.replace(ZWSP, '') === '') continue; // 폭 없는 장식 노드 제외
      out.push(n);
    }
    return out;
  }

  function getText(root) {
    return blockNodes(root)
      .map((b) => textNodesIn(b).map((n) => n.data).join(''))
      .join('\n');
  }

  /** 문자 오프셋 → DOM 위치 {node, offset} */
  function posToDom(root, offset) {
    const blocks = blockNodes(root);
    let remain = Math.max(0, offset);
    for (let i = 0; i < blocks.length; i++) {
      const nodes = textNodesIn(blocks[i]);
      const len = nodes.reduce((s, n) => s + n.data.length, 0);
      if (remain <= len) {
        for (const n of nodes) {
          if (remain <= n.data.length) return { node: n, offset: remain };
          remain -= n.data.length;
        }
        return { node: blocks[i], offset: 0 }; // 빈 문단
      }
      remain -= len + 1; // 문단 경계 "\n"
    }
    // 범위를 벗어나면 맨 끝
    const last = blocks[blocks.length - 1];
    const nodes = textNodesIn(last);
    if (nodes.length) {
      const n = nodes[nodes.length - 1];
      return { node: n, offset: n.data.length };
    }
    return { node: last, offset: 0 };
  }

  /** DOM 위치 → 문자 오프셋 (에디터 밖이면 null) */
  function domToPos(root, node, nodeOffset) {
    if (!root.contains(node) && root !== node) return null;
    // 컨테이너가 에디터 루트 자체인 경우 (selectAllChildren 등): 블록 인덱스로 계산
    if (node === root && root.children.length) {
      const rblocks = blockNodes(root);
      const boundary = root.childNodes[nodeOffset] || null;
      let accr = 0;
      for (let k = 0; k < rblocks.length; k++) {
        if (boundary === rblocks[k]) return accr; // 해당 블록의 시작 위치
        accr += textNodesIn(rblocks[k]).reduce((s, n) => s + n.data.length, 0) + 1;
      }
      return Math.max(0, accr - 1); // 끝 위치
    }
    const blocks = blockNodes(root);
    let acc = 0;
    for (const block of blocks) {
      const nodes = textNodesIn(block);
      const blockLen = nodes.reduce((s, n) => s + n.data.length, 0);
      const inBlock = block === node || block.contains(node);
      if (!inBlock) {
        acc += blockLen + 1;
        continue;
      }
      if (node.nodeType === 3) {
        let cnt = 0;
        for (const n of nodes) {
          if (n === node) return acc + cnt + Math.min(nodeOffset, n.data.length);
          cnt += n.data.length;
        }
        return acc + cnt;
      }
      // 요소 노드에 캐럿: childNodes[nodeOffset] 이전까지의 텍스트 길이
      const boundary = node.childNodes[nodeOffset] || null;
      let cnt = 0;
      for (const n of nodes) {
        if (!boundary) { cnt += n.data.length; continue; }
        if (n === boundary || (boundary.nodeType === 1 && boundary.contains(n))) break;
        if (boundary.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) {
          cnt += n.data.length;
        } else {
          break;
        }
      }
      return acc + cnt;
    }
    return null;
  }

  function setSelection(root, start, end) {
    const sel = window.getSelection();
    const a = posToDom(root, start);
    const b = end === start ? a : posToDom(root, end);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---------- 삽입 (ProseMirror에 안전하게) ----------

  function execInsertText(text) {
    // execCommand는 beforeinput을 발생시켜 ProseMirror가 정상 처리함
    return document.execCommand('insertText', false, text);
  }

  function insertTextSmart(text) {
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        if (!document.execCommand('insertParagraph', false)) {
          execInsertText('\n');
        }
      }
      if (lines[i]) execInsertText(lines[i]);
    }
  }

  /** beforeinput 직접 발송 (execCommand 실패 시 폴백) */
  function insertViaBeforeInput(el, text) {
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(ev);
  }

  // ---------- diff & 영역 추적 ----------

  function diffTexts(oldText, newText) {
    if (oldText === newText) return null;
    let p = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (p < minLen && oldText[p] === newText[p]) p++;
    let s = 0;
    while (
      s < minLen - p &&
      oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
    ) s++;
    return { a: p, removed: oldText.length - p - s, inserted: newText.length - p - s };
  }

  function adjustRegion(d) {
    if (!region || !d) return;
    const { a, removed, inserted } = d;
    const delta = inserted - removed;
    const changeEnd = a + removed;
    const { start, end } = region;

    // 영역 시작점은 배타적(시작점 바로 앞 입력은 영역 밖),
    // 끝점은 포함적(끝에 이어서 입력하면 영역이 늘어남 = 사용자가 프롬프트를 이어 수정한 것)
    const pureInsertAtStart = removed === 0 && a === start;
    const fullyBefore = changeEnd < start || (changeEnd === start && removed > 0) || pureInsertAtStart;
    const fullyAfter = a > end || (a === end && removed > 0);

    // 이번 변경이 영역을 얼마나 덮었는지 / 영역 밖까지 얼마나 침범했는지.
    // d.exact(=beforeinput targetRange 기반)면 오차 여유 없이, diff 기반이면 약간의 여유를 두고 판단.
    const coveredLen = Math.min(changeEnd, end) - Math.max(a, start);
    const outsideBefore = Math.max(0, start - a);
    const outsideAfter = Math.max(0, changeEnd - end);
    const regionLen = end - start;
    const coverSlack = d.exact ? 0 : 2;
    const outsideSlack = d.exact ? 0 : 2;
    const wholesale =
      coveredLen >= Math.max(1, regionLen - coverSlack) &&
      (outsideBefore > outsideSlack || outsideAfter > outsideSlack);

    if (fullyBefore) {
      region.start += delta;
      region.end += delta;
    } else if (fullyAfter) {
      // 영역 뒤 - 변화 없음
    } else if (wholesale || d.mega) {
      // 영역을 (거의) 통째로 포함해 바깥까지 갈아끼움 (전체 선택 후 재입력, NAI 프리셋 로드 등) → 추적 해제
      region = null;
    } else {
      if (a < region.start) region.start = a;
      if (changeEnd <= end) region.end += delta;
      else region.end = a + inserted;
      if (region.end <= region.start) region = null;
    }
  }

  /** beforeinput의 targetRanges = 이번 입력이 실제로 대체할 범위 (diff보다 정확) */
  let pendingSpan = null;
  function onEditorBeforeInput(e) {
    if (!editorEl) return;
    try {
      const ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
      if (ranges && ranges.length) {
        const r = ranges[0];
        const a = domToPos(editorEl, r.startContainer, r.startOffset);
        const b = domToPos(editorEl, r.endContainer, r.endOffset);
        if (a != null && b != null) {
          pendingSpan = { a: Math.min(a, b), b: Math.max(a, b), at: Date.now() };
        }
      }
    } catch (err) { /* ignore */ }
  }

  function processEditorChange() {
    if (!editorEl) return;
    const newText = getText(editorEl);
    if (newText === lastFullText) return;
    // 복원됐지만 아직 위치를 못 찾은 영역: 이번 변경(NAI의 저장 프롬프트 하이드레이션 등)에서 다시 찾아본다
    if (region && !region.anchored && !applying) {
      reanchorRegion(newText);
      lastFullText = newText;
      if (region && region.anchored) {
        schedulePersist();
        notifyPanel();
      }
      scheduleOverlayUpdate();
      return;
    }
    let d = diffTexts(lastFullText, newText);
    const span = pendingSpan && Date.now() - pendingSpan.at < 400 ? pendingSpan : null;
    pendingSpan = null;
    if (span && !applying) {
      const removed = span.b - span.a;
      const inserted = newText.length - lastFullText.length + removed;
      if (span.a >= 0 && span.b <= lastFullText.length && inserted >= 0) {
        d = { a: span.a, removed, inserted, exact: true };
      }
    }
    // beforeinput이 없던 변경: 변경 직전 선택 범위가 diff와 모순 없으면 그것을 실제 교체 범위로 사용
    if (d && !d.exact && !applying && lastSelSpan && !lastSelSpan.used) {
      const { a: sa, b: sb } = lastSelSpan;
      lastSelSpan.used = true;
      const inserted = newText.length - lastFullText.length + (sb - sa);
      const diffInsideSel = d.a >= sa - 1 && d.a + d.removed <= sb + 1;
      if (sb <= lastFullText.length && sb - sa >= d.removed && inserted >= 0 && diffInsideSel) {
        d = { a: sa, removed: sb - sa, inserted, exact: true };
      }
    }
    // 문서 대부분을 갈아끼운 초대형 변경(프리셋 로드/메타데이터 가져오기 등)은 범위 추정이 불가능 → 추적 해제 신호
    if (d && !d.exact && d.removed >= Math.max(20, Math.round(lastFullText.length * 0.7))) {
      d.mega = true;
    }
    if (d && !applying) {
      adjustRegion(d);
      if (region) {
        region.start = Math.max(0, Math.min(region.start, newText.length));
        region.end = Math.max(region.start, Math.min(region.end, newText.length));
        region.text = newText.slice(region.start, region.end);
        if (!region.text.trim()) region = null;
      }
      schedulePersist();
      notifyPanel();
    }
    lastFullText = newText;
    scheduleOverlayUpdate();
  }

  function onEditorInput() {
    processEditorChange();
  }

  // ---------- 영역 저장/복원 ----------

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistRegion, 300);
  }

  function persistRegion() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: region ? { ...region, savedAt: Date.now() } : null });
    } catch (e) { /* 확장 컨텍스트 소멸 시 무시 */ }
  }

  function reanchorRegion(fullText) {
    if (!region) return;
    const cur = fullText.slice(region.start, region.end);
    if (region.text && cur === region.text) {
      region.anchored = true; // 그대로 유효
      return;
    }
    if (region.text) {
      const idx = nearestIndexOf(fullText, region.text, region.start);
      if (idx >= 0) {
        region.start = idx;
        region.end = idx + region.text.length;
        region.anchored = true;
        return;
      }
    }
    if (region.anchored) {
      // 유효했던 영역이 사라짐 → 추적 종료
      region = null;
      schedulePersist();
      notifyPanel();
    }
    // 복원 직후(anchored=false)라면 에디터가 아직 내용을 채우기 전일 수 있으므로 유지하고 기다림
  }

  function nearestIndexOf(haystack, needle, preferPos) {
    let best = -1;
    let bestDist = Infinity;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      const dist = Math.abs(idx - preferPos);
      if (dist < bestDist) { best = idx; bestDist = dist; }
      idx = haystack.indexOf(needle, idx + 1);
    }
    return best;
  }

  async function restoreRegion() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const saved = data[STORAGE_KEY];
      if (saved && typeof saved.start === 'number') {
        // 3일 넘게 지난 영역은 복원하지 않음 (우연한 텍스트 일치로 되살아나는 것 방지)
        if (saved.savedAt && Date.now() - saved.savedAt > 3 * 24 * 60 * 60 * 1000) return;
        region = { ...saved, anchored: false };
        if (editorEl) reanchorRegion(getText(editorEl));
        scheduleOverlayUpdate();
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- 캐럿/선택 추적 ----------

  function closestPm(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.closest('div.ProseMirror[contenteditable="true"]') : null;
  }

  function onSelectionChange() {
    const el = ensureEditor();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);

    if (el && (el.contains(r.startContainer) || r.startContainer === el)) {
      const startPos = domToPos(el, r.startContainer, r.startOffset);
      if (startPos != null) lastCaretOffset = startPos;

      // 변경 직전 선택 범위 기록: beforeinput이 없는 변경(execCommand 등)의 교체 범위 추정에 사용
      const endPos = el.contains(r.endContainer) || r.endContainer === el
        ? domToPos(el, r.endContainer, r.endOffset)
        : null;
      if (startPos != null && endPos != null) {
        lastSelSpan = { a: Math.min(startPos, endPos), b: Math.max(startPos, endPos), used: false };
      }

      if (!sel.isCollapsed && el.contains(r.endContainer)) {
        const text = sel.toString().replace(ZWSP, '');
        if (text.trim().length >= 2) {
          showChip(r);
          return;
        }
      }
      hideChipSoon();
      return;
    }

    // 다른 프롬프트 박스(Undesired Content, 캐릭터 프롬프트)에서의 드래그도 저장 칩 지원
    const pm = closestPm(r.startContainer);
    if (pm && !sel.isCollapsed && pm.contains(r.endContainer)) {
      const text = sel.toString().replace(ZWSP, '');
      if (text.trim().length >= 2) {
        showChip(r);
        return;
      }
    }
    hideChipSoon();
  }

  // ---------- "갤러리에 저장" 플로팅 칩 ----------

  function makeChip() {
    if (chipEl && chipEl.isConnected) return chipEl;
    chipEl = document.createElement('div');
    chipEl.className = 'gpp-save-chip';
    chipEl.textContent = '📁 갤러리에 저장';
    chipEl.addEventListener('mousedown', (e) => {
      // 선택 해제 방지
      e.preventDefault();
      e.stopPropagation();
      onChipClick();
    });
    document.body.appendChild(chipEl);
    return chipEl;
  }

  function showChip(range) {
    const chip = makeChip();
    clearTimeout(chipHideTimer);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    chip.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
    chip.style.top = `${rect.bottom + window.scrollY + 8}px`;
    chip.classList.add('gpp-visible');
  }

  function hideChipSoon() {
    clearTimeout(chipHideTimer);
    chipHideTimer = setTimeout(() => {
      if (chipEl) chipEl.classList.remove('gpp-visible');
    }, 250);
  }

  async function onChipClick() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().replace(ZWSP, '').trim() : '';
    if (!text) return;
    if (chipEl) chipEl.classList.remove('gpp-visible');
    const image = await grabCurrentImage().catch(() => null);
    safeSendMessage({
      type: 'nai:saveSelection',
      payload: { text, image, pageUrl: location.href, grabbedAt: Date.now() },
    });
  }

  // ---------- 추적 구간 하이라이트 오버레이 ----------
  // ProseMirror 문서를 건드리면 에디터 상태가 깨지므로, DOM 위에 클릭 통과되는 박스를 겹쳐 그린다.

  function ensureOverlayBox() {
    if (overlayBox && overlayBox.isConnected) return overlayBox;
    overlayBox = document.createElement('div');
    overlayBox.className = 'gpp-region-overlay';
    for (let i = 0; i < 2; i++) {
      const m = document.createElement('span');
      m.className = 'gpp-region-marker';
      m.textContent = '✦';
      overlayBox.appendChild(m);
    }
    document.body.appendChild(overlayBox);
    return overlayBox;
  }

  function hideOverlay() {
    if (overlayBox) overlayBox.style.display = 'none';
  }

  function scheduleOverlayUpdate() {
    // rAF는 숨겨진 탭에서 실행되지 않으므로 setTimeout 사용
    if (overlayRaf) return;
    overlayRaf = setTimeout(() => {
      overlayRaf = 0;
      updateOverlay();
    }, 30);
  }

  function updateOverlay() {
    if (!showRegionHighlight || !editorEl || !editorEl.isConnected || !region || region.anchored === false) {
      hideOverlay();
      return;
    }
    try {
      const edRect = editorEl.getBoundingClientRect();
      if (edRect.width < 2 || edRect.height < 2) {
        hideOverlay();
        return;
      }
      const a = posToDom(editorEl, region.start);
      const b = posToDom(editorEl, region.end);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = Array.from(range.getClientRects()).filter((r) => r.height > 2);
      if (!rects.length) {
        hideOverlay();
        return;
      }
      // 구간 시작/끝 지점에 ✦ 마커 두 개 (텍스트 위에 겹치되 클릭은 통과)
      const first = rects[0];
      const last = rects[rects.length - 1];
      const points = [
        { x: first.left, y: first.top + first.height / 2, h: first.height },
        { x: last.right, y: last.top + last.height / 2, h: last.height },
      ];
      const box = ensureOverlayBox();
      box.style.display = 'block';
      let anyVisible = false;
      points.forEach((p, i) => {
        const m = box.children[i];
        const inside =
          p.x >= edRect.left - 3 && p.x <= edRect.right + 3 &&
          p.y >= edRect.top - 1 && p.y <= edRect.bottom + 1;
        if (!inside) {
          m.style.display = 'none';
          return;
        }
        anyVisible = true;
        m.style.display = 'block';
        m.style.left = `${p.x}px`;
        m.style.top = `${p.y}px`;
        // 시작 마커는 경계 왼쪽에, 끝 마커는 경계 오른쪽에 (문장 앞뒤로 ✦)
        m.style.transform = i === 0
          ? 'translate(-100%, -50%) translateX(-1px)'
          : 'translate(0, -50%) translateX(1px)';
        m.style.fontSize = `${Math.max(10, Math.min(16, Math.round(p.h * 0.72)))}px`;
        m.style.color = markerStyle.color || '#facc15';
        if (markerStyle.bg) {
          m.style.background = markerStyle.bg;
          m.style.padding = '1px 3px';
          m.style.textShadow = 'none';
        } else {
          m.style.background = 'transparent';
          m.style.padding = '0';
          m.style.textShadow = '0 0 3px rgba(0, 0, 0, 0.55)';
        }
      });
      if (!anyVisible) hideOverlay();
    } catch (e) {
      hideOverlay();
    }
  }

  function applyMarkerSettings(s) {
    showRegionHighlight = s.showRegion !== false;
    markerStyle = {
      color: typeof s.markerColor === 'string' && s.markerColor ? s.markerColor : '#facc15',
      bg: typeof s.markerBg === 'string' ? s.markerBg : '',
    };
  }

  async function loadHighlightSetting() {
    try {
      const data = await chrome.storage.local.get('gppSettings');
      applyMarkerSettings(data.gppSettings || {});
    } catch (e) { /* ignore */ }
    scheduleOverlayUpdate();
  }

  // ---------- 생성 이미지 캡처 ----------

  function isVisibleEl(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  async function grabCurrentImage() {
    // 화면에 표시 중인 blob 이미지 중 가장 크게 보이는 것 = 현재 생성 결과로 간주
    const imgs = Array.from(document.images).filter(
      (i) => /^(blob|data):/.test(i.src) && i.naturalWidth >= 200 && isVisibleEl(i)
    );
    imgs.sort((x, y) => {
      const rx = x.getBoundingClientRect();
      const ry = y.getBoundingClientRect();
      return ry.width * ry.height - rx.width * rx.height;
    });
    const img = imgs[0];
    if (img) {
      const resp = await fetch(img.src);
      const blob = await resp.blob();
      if (blob.size > 30 * 1024 * 1024) return null; // 30MB 초과 방어
      const dataUrl = await blobToDataUrl(blob);
      return {
        dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        mime: blob.type || 'image/png',
        size: blob.size,
      };
    }
    // 이미지가 캔버스로 표시되는 경우 폴백
    const canvases = Array.from(document.querySelectorAll('canvas')).filter(
      (c) => c.width >= 256 && c.height >= 256 && isVisibleEl(c)
    );
    canvases.sort((x, y) => y.width * y.height - x.width * x.height);
    const canvas = canvases[0];
    if (canvas) {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 2000) {
          return { dataUrl, width: canvas.width, height: canvas.height, mime: 'image/png', size: dataUrl.length };
        }
      } catch (e) { /* tainted canvas 등 */ }
    }
    return null;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  // ---------- 프롬프트 적용 (삽입/교체) ----------

  function needsSepBefore(ch) {
    return ch !== undefined && !/[\s,{[(|:\n]/.test(ch);
  }
  function needsSepAfter(ch) {
    return ch !== undefined && !/[\s,}\])|:\n]/.test(ch);
  }

  function applyPrompt(msg) {
    const el = ensureEditor();
    if (!el) return { ok: false, error: 'NAI 프롬프트 입력창을 찾지 못했어요. 이미지 생성 화면을 열어주세요.' };

    const fullBefore = getText(el);
    lastFullText = fullBefore;
    if (region) reanchorRegion(fullBefore);
    if (region && !region.anchored) region = null; // 끝내 위치를 못 찾은 복원 영역은 버리고 새로 삽입

    let selStart;
    let selEnd;
    let replacing = false;
    if (region && region.end <= fullBefore.length) {
      selStart = region.start;
      selEnd = region.end;
      replacing = true;
    } else {
      region = null;
      const mode = msg.insertMode || 'caret';
      if (mode === 'caret' && lastCaretOffset != null && lastCaretOffset <= fullBefore.length) {
        selStart = selEnd = lastCaretOffset;
      } else if (mode === 'start') {
        selStart = selEnd = 0;
      } else {
        selStart = selEnd = fullBefore.length;
      }
    }

    // 자동 구분자: 삽입 지점 앞뒤 문자에 따라 ", " 붙이기
    let insert = String(msg.text ?? '').replace(/\r\n/g, '\n').trim();
    let sepBeforeLen = 0;
    let sepAfterLen = 0;
    if (msg.autoComma !== false && insert !== '') {
      const before = fullBefore[selStart - 1];
      const after = fullBefore[selEnd];
      if (selStart > 0 && needsSepBefore(before)) {
        insert = ', ' + insert;
        sepBeforeLen = 2;
      }
      if (needsSepAfter(after)) {
        insert = insert + ', ';
        sepAfterLen = 2;
      }
    }

    applying = true;
    try {
      el.focus();
      setSelection(el, selStart, selEnd);
      insertTextSmart(insert);

      let fullAfter = getText(el);
      if (fullAfter === fullBefore && insert) {
        // execCommand가 막힌 경우 폴백
        setSelection(el, selStart, selEnd);
        insertViaBeforeInput(el, insert.replace(/\n/g, ' '));
        fullAfter = getText(el);
      }
      if (fullAfter === fullBefore && insert) {
        return { ok: false, error: '입력이 반영되지 않았어요. NAI 화면을 새로고침한 뒤 다시 시도해 주세요.' };
      }

      // 영역 확정은 diff가 아니라 산술로 한다.
      // diff는 기존 영역과 새 프롬프트가 같은 접두어/접미어를 공유하면 그 부분을 "안 바뀐 배경"으로
      // 밀어내 영역이 꼬리로 쪼그라들고, 다음 교체 때 접두어가 남아 중복 삽입되는 버그를 만든다.
      // 우리는 [selStart, selEnd)를 insert로 바꿨으므로 결과 영역은 정확히 계산 가능하다.
      const actualInserted = Math.max(0, fullAfter.length - fullBefore.length + (selEnd - selStart));
      let newStart = selStart;
      let newEnd = selStart + actualInserted;
      // 자동으로 붙인 구분자(", ")는 추적 영역에서 제외 (마커 표시/교체 동작 일관성)
      if (sepBeforeLen + sepAfterLen <= actualInserted) {
        newStart += sepBeforeLen;
        newEnd -= sepAfterLen;
      }
      const landed = fullAfter.slice(newStart, newEnd);
      region = {
        start: Math.min(newStart, fullAfter.length),
        end: Math.min(newEnd, fullAfter.length),
        text: landed,
        originalText: landed,
        promptId: msg.promptId ?? null,
        title: msg.title ?? '',
        anchored: true,
      };
      lastFullText = fullAfter;
      persistRegion();
      return { ok: true, region: publicRegion(), replaced: replacing };
    } finally {
      applying = false;
      scheduleOverlayUpdate();
    }
  }

  function removeRegionText() {
    const el = ensureEditor();
    if (!el || !region) return { ok: false, error: '삽입된 프롬프트가 없어요.' };
    const full = getText(el);
    reanchorRegion(full);
    if (!region || !region.anchored) return { ok: false, error: '삽입 영역을 찾지 못했어요.' };
    lastFullText = full;

    // 영역과 함께, 자동으로 붙였던 구분자(쉼표)도 한쪽만 정리
    let s = region.start;
    let e = region.end;
    const afterMatch = full.slice(e).match(/^ ?, ?/);
    if (afterMatch) {
      e += afterMatch[0].length;
    } else {
      const beforeMatch = full.slice(0, s).match(/ ?, ?$/);
      if (beforeMatch) s -= beforeMatch[0].length;
    }

    applying = true;
    try {
      el.focus();
      setSelection(el, s, e);
      document.execCommand('delete', false);
      lastFullText = getText(el);
      region = null;
      persistRegion();
      return { ok: true };
    } finally {
      applying = false;
      scheduleOverlayUpdate();
    }
  }

  function publicRegion() {
    if (!region || region.anchored === false) return null;
    return {
      start: region.start,
      end: region.end,
      text: region.text,
      promptId: region.promptId,
      title: region.title,
      edited: typeof region.originalText === 'string' && region.text !== region.originalText,
    };
  }

  function getState() {
    const el = ensureEditor();
    const full = el ? getText(el) : '';
    if (el && region) reanchorRegion(full);
    return {
      ok: true,
      editorFound: !!el,
      promptLength: full.length,
      region: publicRegion(),
      caretOffset: lastCaretOffset,
      url: location.href,
    };
  }

  // ---------- 메시징 ----------

  function safeSendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) { /* 패널이 닫혀 있으면 무시 */ }
  }

  let notifyTimer = null;
  function notifyPanel() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      safeSendMessage({ type: 'nai:regionUpdate', region: publicRegion() });
    }, 400);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'nai:ping':
        sendResponse({ ok: true, editorFound: !!ensureEditor() });
        return undefined;
      case 'nai:getState':
        sendResponse(getState());
        return undefined;
      case 'nai:apply':
        sendResponse(applyPrompt(msg));
        return undefined;
      case 'nai:clearRegion':
        region = null;
        persistRegion();
        scheduleOverlayUpdate();
        sendResponse({ ok: true });
        return undefined;
      case 'nai:removeRegion':
        sendResponse(removeRegionText());
        return undefined;
      case 'nai:grabImage':
        grabCurrentImage()
          .then((image) => sendResponse({ ok: true, image }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true; // 비동기 응답
      case 'nai:getSelection': {
        const sel = window.getSelection();
        const text = sel ? sel.toString().replace(ZWSP, '').trim() : '';
        sendResponse({ ok: true, text });
        return undefined;
      }
      default:
        return undefined;
    }
  });

  // ---------- 초기화 ----------

  const mo = new MutationObserver((muts) => {
    ensureEditor();
    // ProseMirror가 input 이벤트 없이 DOM을 직접 바꾸는 경우(붙여넣기, 프리셋 로드 등)도 감지
    if (editorEl) {
      for (const m of muts) {
        if (m.target === editorEl || editorEl.contains(m.target)) {
          processEditorChange();
          break;
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  document.addEventListener('selectionchange', onSelectionChange);

  // 하이라이트 위치 갱신: 스크롤(내부 스크롤러 포함)·리사이즈·주기적 보정
  document.addEventListener('scroll', scheduleOverlayUpdate, true);
  window.addEventListener('resize', scheduleOverlayUpdate);
  setInterval(() => {
    if (region && showRegionHighlight) scheduleOverlayUpdate();
  }, 1500);

  // 패널 설정 변경(추적 구간 표시 on/off) 실시간 반영
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.gppSettings) {
        applyMarkerSettings(changes.gppSettings.newValue || {});
        scheduleOverlayUpdate();
      }
    });
  } catch (e) { /* ignore */ }

  ensureEditor();
  restoreRegion();
  loadHighlightSetting();
})();
