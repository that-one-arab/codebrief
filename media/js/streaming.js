// Streaming update logic
(function() {
  const AIReview = window.AIReview = window.AIReview || {};
  const { state } = AIReview;
  const { escapeHtml, renderMarkdown } = AIReview.utils;

  function updateGroupWithContent(groupId, groupData) {
    const groupIndex = state.groups.findIndex(g => g.id === groupId);
    if (groupIndex === -1) return;

    state.groups[groupIndex] = {
      ...state.groups[groupIndex],
      ...groupData,
      loaded: true,
      skeleton: false
    };

    const groupEl = document.getElementById(`group-${groupIndex}`);
    if (groupEl) {
      const isEven = groupIndex % 2 === 0;
      const isCollapsed = state.collapsedGroups.has(groupId);

      const validHunks = groupData.hunks ? groupData.hunks.filter(h => h.lines && h.lines.length > 0) : [];

      const codePanel = `
        <div class="code-panel">
          ${AIReview.render.renderGroupedHunks(validHunks, groupIndex)}
        </div>
      `;

      const explanationPanel = `
        <div class="explanation-panel">
          <div class="explanation-bubble" data-group-id="${groupId}">
            <div class="explanation-text" id="explanation-text-${groupIndex}" data-full-text="${escapeHtml(groupData.explanation)}" data-markdown="true">
            </div>
            <button class="copy-explanation-btn" title="Copy explanation to clipboard" aria-label="Copy explanation to clipboard" style="opacity: 0; visibility: hidden;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
                <path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="currentColor" stroke-width="2"/>
              </svg>
            </button>
          </div>
        </div>
      `;

      groupEl.classList.remove('loading');
      groupEl.classList.add('loaded');
      if (isCollapsed) {
        groupEl.classList.add('collapsed');
      }
      groupEl.querySelector('.group-layout').innerHTML =
        isEven ? codePanel + explanationPanel : explanationPanel + codePanel;

      // Show copy button in header when loaded
      const groupHeader = groupEl.querySelector('.group-header');
      const copyBtn = groupHeader?.querySelector('.copy-group-btn');
      if (copyBtn) {
        copyBtn.style.display = '';
      }

      AIReview.navigation.attachExpandListeners(groupEl);
      AIReview.navigation.attachCopyButtonListeners();
      AIReview.navigation.attachGroupCopyListeners();
      
      // Attach file collapse listeners
      groupEl.querySelectorAll('.file-group').forEach(fileGroup => {
        AIReview.navigation.attachFileCollapseListeners(fileGroup);
      });
      
      AIReview.navigation.setupScrollObserver();

      // Start streaming immediately for the updated group
      startStreaming(groupIndex);
    }

    updateProgress();
  }

  function updateProgress() {
    const totalGroups = state.groups.length;
    const loadedGroups = state.groups.filter(g => g.loaded).length;
    const progress = totalGroups > 0 ? (loadedGroups / totalGroups) * 100 : 0;

    const progressFill = document.querySelector('.progress-fill');
    const progressText = document.querySelector('.progress-text');
    const progressSpinner = document.querySelector('.progress-spinner');

    if (progressFill) progressFill.style.width = `${progress}%`;
    if (progressText) {
      const textNode = progressText.lastChild;
      if (textNode) {
        textNode.textContent = ` ${loadedGroups} / ${totalGroups}`;
      } else {
        progressText.appendChild(document.createTextNode(` ${loadedGroups} / ${totalGroups}`));
      }
    }
    if (progressSpinner) {
      progressSpinner.classList.toggle('hidden', progress >= 100);
    }

    // Show commit button when all groups are loaded
    if (progress >= 100) {
      const commitBtn = document.getElementById('btn-commit-all');
      if (commitBtn) {
        commitBtn.classList.remove('hidden');
      }
    }
  }

  function onStreamingComplete() {
    console.log('Streaming complete');
    const commitBtn = document.getElementById('btn-commit-all');
    if (commitBtn) {
      commitBtn.classList.remove('hidden');
    }
  }

  function startStreaming(groupIndex) {
    const element = document.getElementById(`explanation-text-${groupIndex}`);
    if (!element) return;

    const fullText = element.dataset.fullText;
    if (!fullText) return;

    // Remove streaming-pending class if present (for backwards compatibility)
    element.classList.remove('streaming-pending');

    // If already complete, just show full text
    const existingState = state.streamingState.get(groupIndex);
    if (existingState && existingState.complete) {
      element.innerHTML = renderMarkdown(fullText);
      element.classList.add('streaming-complete');
      return;
    }

    // If already streaming, don't restart
    if (existingState && existingState.isStreaming) {
      return;
    }

    let currentChar = 0;
    state.streamingState.set(groupIndex, { isStreaming: true });

    function streamNextBatch() {
      if (currentChar < fullText.length) {
        const charsToAdd = Math.floor(Math.random() * 12) + 8;
        currentChar = Math.min(currentChar + charsToAdd, fullText.length);

        const partialText = fullText.slice(0, currentChar);
        element.innerHTML = renderMarkdown(partialText);

        if (!element.querySelector('.streaming-cursor')) {
          const cursor = document.createElement('span');
          cursor.className = 'streaming-cursor';
          cursor.textContent = '▋';
          element.appendChild(cursor);
        }

        const delay = Math.random() * 70 + 30;
        setTimeout(streamNextBatch, delay);
      } else {
        state.streamingState.set(groupIndex, { isStreaming: false, complete: true });
        element.classList.add('streaming-complete');
        const cursor = element.querySelector('.streaming-cursor');
        if (cursor) cursor.remove();
        
        // Show copy button now that streaming is complete
        const bubble = element.closest('.explanation-bubble');
        if (bubble) {
          const copyBtn = bubble.querySelector('.copy-explanation-btn');
          if (copyBtn) {
            copyBtn.style.opacity = '';
            copyBtn.style.visibility = '';
          }
        }
      }
    }

    streamNextBatch();
  }

  AIReview.streaming = {
    updateGroupWithContent,
    updateProgress,
    onStreamingComplete,
    startStreaming
  };
})();
