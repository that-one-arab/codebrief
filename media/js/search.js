// In-webview find widget similar to VS Code find
(function() {
  const AIReview = window.AIReview = window.AIReview || {};
  const { state } = AIReview;

  function init() {
    if (state.search && state.search.initialized) return;

    const widget = document.createElement('div');
    widget.className = 'find-widget';
    widget.innerHTML = `
      <input
        id="find-input"
        class="find-input"
        type="text"
        placeholder="Find"
        aria-label="Find in review"
      />
      <button id="find-case" class="find-btn find-case" title="Match Case (Alt+C)" aria-label="Match Case" aria-pressed="false">Aa</button>
      <span id="find-count" class="find-count" aria-live="polite"></span>
      <button id="find-prev" class="find-btn" title="Previous Match (Shift+Enter)" aria-label="Previous Match">↑</button>
      <button id="find-next" class="find-btn" title="Next Match (Enter)" aria-label="Next Match">↓</button>
      <button id="find-close" class="find-btn" title="Close (Escape)" aria-label="Close Find">✕</button>
    `;

    document.body.appendChild(widget);

    state.search = {
      initialized: true,
      visible: false,
      query: '',
      caseSensitive: false,
      activeIndex: -1,
      matches: [],
      refreshTimer: null,
      observer: null,
      widget,
      input: widget.querySelector('#find-input'),
      count: widget.querySelector('#find-count'),
      btnPrev: widget.querySelector('#find-prev'),
      btnNext: widget.querySelector('#find-next'),
      btnClose: widget.querySelector('#find-close'),
      btnCase: widget.querySelector('#find-case')
    };

    attachEventListeners();
    observeContentChanges();
  }

  function attachEventListeners() {
    const search = state.search;
    if (!search) return;

    search.input.addEventListener('input', () => {
      performSearch(search.input.value);
    });

    search.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateMatches(e.shiftKey ? -1 : 1);
      }
    });

    search.btnPrev.addEventListener('click', () => navigateMatches(-1));
    search.btnNext.addEventListener('click', () => navigateMatches(1));
    search.btnClose.addEventListener('click', closeFind);
    search.btnCase.addEventListener('click', toggleCaseSensitive);

    document.addEventListener('keydown', handleGlobalKeyDown, true);
  }

  function observeContentChanges() {
    const search = state.search;
    if (!search || !state.app) return;

    search.observer = new MutationObserver(() => {
      if (!search.visible || !search.query) return;
      scheduleRefresh();
    });

    search.observer.observe(state.app, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function scheduleRefresh() {
    const search = state.search;
    if (!search) return;
    if (search.refreshTimer) {
      clearTimeout(search.refreshTimer);
    }

    search.refreshTimer = setTimeout(() => {
      search.refreshTimer = null;
      performSearch(search.query, { preserveActive: true, shouldScroll: false });
    }, 120);
  }

  function handleGlobalKeyDown(e) {
    const search = state.search;
    if (!search) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
      return;
    }

    if (!search.visible) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      navigateMatches(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      toggleCaseSensitive();
      return;
    }

    if (e.key === 'F3') {
      e.preventDefault();
      navigateMatches(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  }

  function openFind() {
    const search = state.search;
    if (!search) return;

    search.visible = true;
    search.widget.classList.add('visible');

    if (!search.input.value) {
      const selectedText = getSelectedText();
      if (selectedText) {
        search.input.value = selectedText;
      }
    }
    performSearch(search.input.value, { shouldScroll: false });

    search.input.focus();
    search.input.select();
  }

  function closeFind() {
    const search = state.search;
    if (!search) return;

    search.visible = false;
    search.widget.classList.remove('visible');
    search.activeIndex = -1;
    search.matches = [];

    clearHighlights();
    search.count.textContent = '';
    search.count.classList.remove('no-results');
  }

  function toggleCaseSensitive() {
    const search = state.search;
    if (!search) return;

    search.caseSensitive = !search.caseSensitive;
    search.btnCase.classList.toggle('active', search.caseSensitive);
    search.btnCase.setAttribute('aria-pressed', String(search.caseSensitive));

    performSearch(search.input.value, { preserveActive: true, shouldScroll: false });
    search.input.focus();
  }

  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';

    const text = selection.toString();
    if (!text || text.length > 120 || text.includes('\n')) return '';

    const anchorNode = selection.anchorNode;
    if (!anchorNode) return '';

    const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE
      ? anchorNode
      : anchorNode.parentElement;

    if (!anchorElement || !state.app.contains(anchorElement)) return '';

    return text;
  }

  function performSearch(rawQuery, options = {}) {
    const search = state.search;
    if (!search) return;

    const { preserveActive = false, shouldScroll = true } = options;
    const query = rawQuery || '';

    const previousActiveIndex = preserveActive ? search.activeIndex : -1;

    search.query = query;
    clearHighlights();

    if (!query) {
      search.matches = [];
      search.activeIndex = -1;
      updateCount();
      return;
    }

    search.matches = highlightMatches(query, search.caseSensitive);

    if (search.matches.length === 0) {
      search.activeIndex = -1;
      updateCount();
      return;
    }

    let nextIndex = 0;
    if (previousActiveIndex >= 0) {
      nextIndex = Math.min(previousActiveIndex, search.matches.length - 1);
    }

    setActiveMatch(nextIndex, { shouldScroll });
  }

  function highlightMatches(query, caseSensitive) {
    if (!state.app) return [];

    const matches = [];
    const walker = document.createTreeWalker(
      state.app,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }

          if (parent.classList.contains('find-match')) {
            return NodeFilter.FILTER_REJECT;
          }

          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE') {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }

    const needle = caseSensitive ? query : query.toLowerCase();

    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      const haystack = caseSensitive ? text : text.toLowerCase();

      let start = haystack.indexOf(needle);
      if (start === -1) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      while (start !== -1) {
        if (start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
        }

        const end = start + query.length;
        const matchSpan = document.createElement('span');
        matchSpan.className = 'find-match';
        matchSpan.textContent = text.slice(start, end);
        fragment.appendChild(matchSpan);
        matches.push(matchSpan);

        cursor = end;
        start = haystack.indexOf(needle, cursor);
      }

      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }

      textNode.parentNode.replaceChild(fragment, textNode);
    }

    return matches;
  }

  function clearHighlights() {
    if (!state.app) return;

    const highlights = state.app.querySelectorAll('.find-match');
    const parents = new Set();

    highlights.forEach((highlight) => {
      const parent = highlight.parentNode;
      if (!parent) return;
      parents.add(parent);
      const textNode = document.createTextNode(highlight.textContent || '');
      highlight.replaceWith(textNode);
    });

    parents.forEach((parent) => {
      if (parent && typeof parent.normalize === 'function') {
        parent.normalize();
      }
    });
  }

  function navigateMatches(direction) {
    const search = state.search;
    if (!search || search.matches.length === 0) return;

    const total = search.matches.length;
    const current = search.activeIndex >= 0 ? search.activeIndex : 0;
    const next = (current + direction + total) % total;
    setActiveMatch(next, { shouldScroll: true });
  }

  function setActiveMatch(index, options = {}) {
    const search = state.search;
    if (!search || search.matches.length === 0) return;

    const { shouldScroll = true } = options;

    search.matches.forEach((m) => m.classList.remove('active'));

    const target = search.matches[index];
    if (!target) return;

    target.classList.add('active');
    search.activeIndex = index;
    updateCount();

    if (shouldScroll) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }

  function updateCount() {
    const search = state.search;
    if (!search) return;

    const total = search.matches.length;
    const hasQuery = !!search.query;

    if (!hasQuery) {
      search.count.textContent = '';
      search.count.classList.remove('no-results');
      return;
    }

    if (total === 0) {
      search.count.textContent = 'No results';
      search.count.classList.add('no-results');
      return;
    }

    search.count.textContent = `${search.activeIndex + 1} of ${total}`;
    search.count.classList.remove('no-results');
  }

  AIReview.search = {
    init,
    openFind,
    closeFind,
    performSearch
  };
})();
