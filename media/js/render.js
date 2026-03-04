// Rendering functions for AI review UI
(function() {
  const AIReview = window.AIReview = window.AIReview || {};
  const { state } = AIReview;
  const { escapeHtml, renderMarkdown } = AIReview.utils;

  function showLoadingState(message) {
    state.app.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">${escapeHtml(message)}</div>
        <div class="loading-subtext">This may take a minute...</div>
      </div>
    `;
  }

  function showError(message, canRetry = false) {
    state.app.innerHTML = `
      <div class="error-container">
        <div class="error-icon">⚠️</div>
        <div class="error-title">An Error Occurred</div>
        <div class="error-message">${escapeHtml(message)}</div>
        ${canRetry ? `
          <button class="error-retry-btn" id="btn-retry">
            <span>Retry</span>
          </button>
        ` : ''}
      </div>
    `;

    if (canRetry) {
      document.getElementById('btn-retry')?.addEventListener('click', () => {
        state.vscode.postMessage({ command: 'retry' });
      });
    }
  }

  function renderSkeletonUI() {
    const totalGroups = state.groups.length;
    const progress = totalGroups > 0 ? (state.groups.filter(g => g.loaded).length / totalGroups) * 100 : 0;

    state.app.innerHTML = `
      ${renderHeader(state.reviewTitle, progress, totalGroups, state.changesAuthoredByAi)}
      <div class="groups-container">
        ${state.groups.map((group, index) => renderSkeletonGroup(group, index)).join('')}
      </div>
      ${renderBottomBar()}
    `;

    AIReview.navigation.attachEventListeners();
    AIReview.navigation.updateActiveStates();
    AIReview.navigation.setupScrollObserver();
  }

  function renderSkeletonGroup(group, index) {
    const isActive = index === state.currentIndex;
    const isEven = index % 2 === 0;
    const isLoaded = group.loaded;
    const isCollapsed = state.collapsedGroups.has(group.id);

    const skeletonContent = `
      <div class="skeleton-block" style="height: 120px;"></div>
      <div class="skeleton-block" style="height: 80px; width: 80%;"></div>
    `;

    const validHunks = isLoaded && group.hunks ? group.hunks.filter(h => h.lines && h.lines.length > 0) : [];

    const codePanel = `
      <div class="code-panel ${isLoaded ? '' : 'skeleton-panel'}">
        ${isLoaded
          ? renderGroupedHunks(validHunks, index)
          : `<div class="skeleton-hunk">${skeletonContent}</div>`
        }
      </div>
    `;

    const explanationPanel = `
      <div class="explanation-panel">
        <div class="explanation-bubble ${isLoaded ? '' : 'skeleton-bubble'}" data-group-id="${group.id}">
          ${isLoaded
            ? `<div class="explanation-text streaming-complete">${renderMarkdown(group.explanation)}</div>
               <button class="copy-explanation-btn" title="Copy explanation to clipboard" aria-label="Copy explanation to clipboard">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                   <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
                   <path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="currentColor" stroke-width="2"/>
                 </svg>
               </button>`
            : `<div class="skeleton-lines">
                <div class="skeleton-line"></div>
                <div class="skeleton-line"></div>
                <div class="skeleton-line" style="width: 60%;"></div>
                <div class="skeleton-loading">Analyzing...</div>
              </div>`
          }
        </div>
      </div>
    `;

    return `
      <article class="group-card ${isActive ? 'active' : ''} ${isLoaded ? 'loaded' : 'loading'} ${isCollapsed ? 'collapsed' : ''}"
               data-index="${index}"
               data-group-id="${group.id}"
               id="group-${index}">
        <div class="group-header" data-toggle="${group.id}">
          <div class="group-header-left">
            <button class="collapse-btn ${isCollapsed ? 'collapsed' : ''}" aria-label="${isCollapsed ? 'Expand' : 'Collapse'}">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 2L8 6L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <h3 class="group-title">${escapeHtml(group.title)}</h3>
          </div>
          <button class="copy-group-btn" title="Copy group summary" aria-label="Copy group summary" data-group-id="${group.id}" ${!isLoaded ? 'style="display: none;"' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
              <path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
          ${group.fileCount ? `<span class="group-meta file-count-collapsed">${group.fileCount} files</span>` : ''}
        </div>
        <div class="group-layout ${isEven ? 'layout-code-first' : 'layout-explanation-first'}">
          ${isEven ? codePanel + explanationPanel : explanationPanel + codePanel}
        </div>
      </article>
    `;
  }

  function groupHunksByFile(hunks) {
    const fileMap = new Map();
    for (const hunk of hunks) {
      const fp = hunk.filePath;
      if (!fileMap.has(fp)) {
        fileMap.set(fp, []);
      }
      fileMap.get(fp).push(hunk);
    }
    const groups = [];
    for (const [filePath, fileHunks] of fileMap) {
      fileHunks.sort((a, b) => a.newStart - b.newStart);
      groups.push({ filePath, hunks: fileHunks });
    }
    return groups;
  }

  function renderGroupedHunks(hunks, groupIndex) {
    if (!hunks || hunks.length === 0) return '';

    const groups = groupHunksByFile(hunks);
    return groups.map((group, fileIndex) =>
      renderFileGroup(group.filePath, group.hunks, groupIndex, fileIndex)
    ).join('');
  }

  function renderFileGroup(filePath, hunks, groupIndex, fileIndex) {
    const idPrefix = `g${groupIndex}-f${fileIndex}`;

    let diffContent = '';

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];

      if (i === 0 && hunk.newStart > 1) {
        const hiddenCount = hunk.newStart - 1;
        const offset = hunk.newStart - hunk.oldStart;
        const fromLine = Math.max(1, hunk.newStart - 20);
        diffContent += renderExpander({
          id: `${idPrefix}-above`,
          filePath,
          fromLine: fromLine,
          toLine: hunk.newStart - 1,
          oldLineStart: Math.max(1, fromLine - offset),
          type: 'up',
          hiddenCount: hiddenCount
        });
      }

      diffContent += renderHunkLines(hunk, idPrefix, i);

      if (i < hunks.length - 1) {
        const nextHunk = hunks[i + 1];
        const hunkNewEnd = AIReview.context.computeHunkNewEnd(hunk);
        const hunkOldEnd = AIReview.context.computeHunkOldEnd(hunk);
        const gapNewStart = hunkNewEnd + 1;
        const gapNewEnd = nextHunk.newStart - 1;
        const gapCount = gapNewEnd - gapNewStart + 1;

        if (gapCount > 0) {
          diffContent += renderExpander({
            id: `${idPrefix}-between-${i}`,
            filePath,
            fromLine: gapNewStart,
            toLine: gapNewEnd,
            oldLineStart: hunkOldEnd + 1,
            type: 'between',
            hiddenCount: gapCount
          });
        }
      } else {
        const hunkNewEnd = AIReview.context.computeHunkNewEnd(hunk);
        const hunkOldEnd = AIReview.context.computeHunkOldEnd(hunk);
        diffContent += renderExpander({
          id: `${idPrefix}-below`,
          filePath,
          fromLine: hunkNewEnd + 1,
          toLine: hunkNewEnd + 20,
          oldLineStart: hunkOldEnd + 1,
          type: 'down',
          hiddenCount: -1
        });
      }
    }

    return `
      <div class="file-group" data-file="${escapeHtml(filePath)}" id="${idPrefix}">
        <div class="file-group-header" data-file-path="${escapeHtml(filePath)}">
          <button class="file-collapse-btn" aria-label="Collapse file" data-file-id="${idPrefix}">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 2L8 6L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <code class="file-path" title="Open in editor">${escapeHtml(filePath)}</code>
        </div>
        <div class="file-content">
          <div class="diff-table">
            <div class="diff-content">
              ${diffContent}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderExpander({ id, filePath, fromLine, toLine, oldLineStart, type, hiddenCount }) {
    const icon = type === 'up' ? '↑' : type === 'down' ? '↓' : '↕';
    let label;
    if (type === 'up') {
      label = `${icon} Show ${Math.min(20, hiddenCount)} of ${hiddenCount} lines above`;
    } else if (type === 'down') {
      label = `${icon} Show 20 lines below`;
    } else {
      label = `${icon} ${hiddenCount} hidden line${hiddenCount !== 1 ? 's' : ''}`;
    }

    return `
      <div class="context-expander"
           id="expander-${escapeHtml(id)}"
           data-expander-id="${escapeHtml(id)}"
           data-file="${escapeHtml(filePath)}"
           data-from="${fromLine}"
           data-to="${toLine}"
           data-old-line-start="${oldLineStart}"
           data-type="${type}"
           data-hidden="${hiddenCount}">
        <button class="expand-btn" title="Load more context">
          <span class="expand-label">${label}</span>
        </button>
      </div>
    `;
  }

  function renderHunkLines(hunk, idPrefix, hunkIndex) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    const lines = (hunk.tokenizedLines || []).map(line => {
      let type = 'context';
      let oldNum = oldLine;
      let newNum = newLine;

      if (line.type === 'add') {
        type = 'add';
        oldNum = '';
        newLine++;
      } else if (line.type === 'del') {
        type = 'del';
        newNum = '';
        oldLine++;
      } else {
        oldLine++;
        newLine++;
      }

      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

      return `
        <div class="diff-line ${type}">
          <span class="line-num ${type === 'del' ? 'old' : type === 'add' ? 'new' : ''}">${oldNum || ''}</span>
          <span class="line-num ${type === 'add' ? 'new' : type === 'del' ? 'old' : ''}">${newNum || ''}</span>
          <span class="line-content syntax-highlighted">${prefix} ${line.html}</span>
        </div>
      `;
    }).join('');

    return `<div class="hunk-lines" data-hunk="${idPrefix}-h${hunkIndex}">${lines}</div>`;
  }

  function renderHeader(title, progressPercent, totalGroups, aiAuthored) {
    const isComplete = progressPercent >= 100;
    const explanationsVisible = !state.explanationsHidden;
    const aiIndicator = aiAuthored
      ? `<div class="ai-authored-indicator" aria-label="Changes in this review were authored by AI">
          <span class="ai-authored-badge">AI</span>
          <span class="ai-authored-tooltip" role="tooltip">Changes in this review were authored by AI</span>
        </div>`
      : '';
    const providerBadge = state.providerName
      ? `<span class="provider-badge">${escapeHtml(state.providerName)}</span>`
      : '';
    const explanationToggleText = explanationsVisible ? 'Hide explanations' : 'Show explanations';
    return `
      <header class="experiment-header">
        <div class="header-content">
          <div class="header-left">
            <h1 class="experiment-title">${escapeHtml(title || 'Codebrief')}</h1>
            ${providerBadge}
          </div>
          <div class="header-actions">
            <button
              class="header-btn explanation-toggle"
              id="btn-toggle-explanations"
              type="button"
              data-state="${explanationsVisible ? 'visible' : 'hidden'}"
              aria-pressed="${explanationsVisible}"
              aria-label="${explanationToggleText}"
              title="${explanationToggleText}"
            >
              <span class="toggle-icon" aria-hidden="true">
                <svg class="icon-visible" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 12C4.5 7.5 8 5 12 5C16 5 19.5 7.5 22 12C19.5 16.5 16 19 12 19C8 19 4.5 16.5 2 12Z" stroke="currentColor" stroke-width="2"/>
                  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
                </svg>
                <svg class="icon-hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 12C4.5 7.5 8 5 12 5C16 5 19.5 7.5 22 12C19.5 16.5 16 19 12 19C8 19 4.5 16.5 2 12Z" stroke="currentColor" stroke-width="2"/>
                  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
                  <path d="M4 4L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </span>
            </button>
          </div>
          <div class="experiment-progress">
            ${aiIndicator}
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progressPercent}%"></div>
            </div>
            <span class="progress-text">
              <span class="progress-spinner ${isComplete ? 'hidden' : ''}"></span>
              ${state.currentIndex + 1} / ${totalGroups}
            </span>
          </div>
        </div>
      </header>
    `;
  }

  function renderBottomBar() {
    const totalGroups = state.groups.length;
    const hasCommitMessage = !!state.suggestedCommitMessage;
    let commitTitle;
    if (hasCommitMessage) {
      commitTitle = `Click to stage all and open Source Control view\\n\\nSuggested commit message:\\n${state.suggestedCommitMessage}`;
    } else {
      commitTitle = 'Generating commit message...';
    }
    return `
      <div class="bottom-bar">
        <div class="nav-group">
          <button class="bottom-btn btn-nav" id="btn-prev" ${state.currentIndex === 0 ? 'disabled' : ''}>
            <span>← Prev</span>
          </button>
          <button class="bottom-btn btn-nav btn-next" id="btn-next" ${state.currentIndex === totalGroups - 1 ? 'disabled' : ''}>
            <span>Next →</span>
          </button>
        </div>
        <button class="bottom-btn btn-commit-all hidden" id="btn-commit-all" title="${AIReview.utils.escapeHtml(commitTitle)}" ${hasCommitMessage ? '' : 'disabled'}>
          <span>${hasCommitMessage ? 'Stage & Commit' : 'Preparing...'}</span>
        </button>
      </div>
    `;
  }

  function updateCommitButtonState() {
    const commitBtn = document.getElementById('btn-commit-all');
    if (!commitBtn) return;

    const hasCommitMessage = !!state.suggestedCommitMessage;
    
    if (hasCommitMessage) {
      const commitTitle = `Click to stage all and open Source Control view\n\nSuggested commit message:\n${state.suggestedCommitMessage}`;
      commitBtn.title = commitTitle;
      commitBtn.disabled = false;
      commitBtn.querySelector('span').textContent = 'Stage & Commit';
    }
  }

  AIReview.render = {
    showLoadingState,
    showError,
    renderSkeletonUI,
    renderSkeletonGroup,
    renderHeader,
    renderBottomBar,
    updateCommitButtonState,
    renderGroupedHunks,
    renderFileGroup,
    renderExpander,
    renderHunkLines
  };
})();
