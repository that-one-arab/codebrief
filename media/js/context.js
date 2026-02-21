// Context expansion handlers
(function() {
  const AIReview = window.AIReview = window.AIReview || {};
  const { state } = AIReview;

  function computeHunkNewEnd(hunk) {
    let newLine = hunk.newStart;
    const lines = hunk.tokenizedLines || hunk.lines || [];
    for (const line of lines) {
      if (line.type === 'add' || line.type === 'context') {
        newLine++;
      }
    }
    return newLine - 1;
  }

  function computeHunkOldEnd(hunk) {
    let oldLine = hunk.oldStart;
    const lines = hunk.tokenizedLines || hunk.lines || [];
    for (const line of lines) {
      if (line.type === 'del' || line.type === 'context') {
        oldLine++;
      }
    }
    return oldLine - 1;
  }

  function handleExpandClick(expanderEl) {
    const id = expanderEl.dataset.expanderId;
    if (state.pendingContextLoads.has(id)) return;

    const filePath = expanderEl.dataset.file;
    const fromLine = parseInt(expanderEl.dataset.from, 10);
    const toLine = parseInt(expanderEl.dataset.to, 10);
    const oldLineStart = parseInt(expanderEl.dataset.oldLineStart, 10);
    const type = expanderEl.dataset.type;

    if (fromLine > toLine) {
      expanderEl.remove();
      return;
    }

    state.pendingContextLoads.add(id);

    const btn = expanderEl.querySelector('.expand-btn');
    if (btn) {
      btn.classList.add('loading');
      btn.querySelector('.expand-label').textContent = 'Loading...';
    }

    state.vscode.postMessage({
      command: 'loadContext',
      filePath,
      fromLine,
      toLine,
      oldLineStart,
      insertId: id
    });
  }

  function handleContextLoaded(message) {
    const { insertId, tokenizedLines, fromLine, toLine, oldLineStart, totalFileLines } = message;

    state.pendingContextLoads.delete(insertId);

    const expanderEl = document.getElementById(`expander-${insertId}`);
    if (!expanderEl) return;

    const type = expanderEl.dataset.type;

    if (!tokenizedLines || tokenizedLines.length === 0) {
      expanderEl.remove();
      return;
    }

    let oldLine = oldLineStart;
    let newLine = fromLine;

    const linesHtml = tokenizedLines.map(line => {
      const oNum = oldLine;
      const nNum = newLine;
      oldLine++;
      newLine++;

      return `
        <div class="diff-line context expanded-context">
          <span class="line-num">${oNum}</span>
          <span class="line-num">${nNum}</span>
          <span class="line-content syntax-highlighted">  ${line.html}</span>
        </div>
      `;
    }).join('');

    const temp = document.createElement('div');
    temp.innerHTML = linesHtml;

    if (type === 'up') {
      const fragment = document.createDocumentFragment();
      while (temp.firstChild) {
        fragment.appendChild(temp.firstChild);
      }
      expanderEl.parentNode.insertBefore(fragment, expanderEl.nextSibling);

      const remainingAbove = fromLine - 1;
      if (remainingAbove > 0) {
        const newFrom = Math.max(1, fromLine - 20);
        const newHidden = fromLine - 1;
        expanderEl.dataset.from = newFrom;
        expanderEl.dataset.to = fromLine - 1;
        expanderEl.dataset.oldLineStart = oldLineStart - (fromLine - newFrom);
        expanderEl.dataset.hidden = newHidden;
        const btn = expanderEl.querySelector('.expand-btn');
        if (btn) {
          btn.classList.remove('loading');
          const showCount = Math.min(20, newHidden);
          btn.querySelector('.expand-label').textContent =
            `↑ Show ${showCount} of ${newHidden} lines above`;
        }
      } else {
        expanderEl.remove();
      }
    } else if (type === 'down') {
      const fragment = document.createDocumentFragment();
      while (temp.firstChild) {
        fragment.appendChild(temp.firstChild);
      }
      expanderEl.parentNode.insertBefore(fragment, expanderEl);

      const actualLoaded = tokenizedLines.length;
      const newFrom = toLine + 1;
      if (actualLoaded < (toLine - fromLine + 1) || (totalFileLines && toLine >= totalFileLines)) {
        expanderEl.remove();
      } else {
        expanderEl.dataset.from = newFrom;
        expanderEl.dataset.to = newFrom + 19;
        expanderEl.dataset.oldLineStart = parseInt(expanderEl.dataset.oldLineStart, 10) + actualLoaded;
        const btn = expanderEl.querySelector('.expand-btn');
        if (btn) {
          btn.classList.remove('loading');
          btn.querySelector('.expand-label').textContent = '↓ Show 20 lines below';
        }
      }
    } else if (type === 'between') {
      const fragment = document.createDocumentFragment();
      while (temp.firstChild) {
        fragment.appendChild(temp.firstChild);
      }
      expanderEl.parentNode.insertBefore(fragment, expanderEl);
      expanderEl.remove();
    }
  }

  AIReview.context = {
    computeHunkNewEnd,
    computeHunkOldEnd,
    handleExpandClick,
    handleContextLoaded
  };
})();
