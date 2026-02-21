// Navigation and interaction handlers
(function() {
  const AIReview = window.AIReview = window.AIReview || {};
  const { state } = AIReview;
  let groupObserver = null;

  function attachEventListeners() {
    document.getElementById('btn-prev')?.addEventListener('click', () => navigate(-1));
    document.getElementById('btn-next')?.addEventListener('click', () => navigate(1));
    document.getElementById('btn-commit-all')?.addEventListener('click', () => {
      const btn = document.getElementById('btn-commit-all');
      if (btn && btn.dataset.committed) {
        state.vscode.postMessage({ command: 'closePanel' });
      } else {
        state.vscode.postMessage({ command: 'commitAll' });
      }
    });

    // Attach copy button listeners
    attachCopyButtonListeners();
    attachGroupCopyListeners();

    document.addEventListener('click', (e) => {
      const header = e.target.closest('.file-group-header');
      if (header) {
        const filePath = header.dataset.filePath;
        if (filePath) {
          openFile(filePath);
        }
      }
    });

    document.querySelectorAll('.group-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const index = parseInt(card.dataset.index, 10);
        if (index !== state.currentIndex) {
          setCurrentIndex(index);
        }
      });
    });

    document.querySelectorAll('[data-toggle]').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('button') && !e.target.closest('.collapse-btn')) return;

        const groupId = e.currentTarget.dataset.toggle;
        toggleGroup(groupId);
      });
    });

    document.querySelectorAll('.group-card').forEach(card => {
      attachExpandListeners(card);
    });

    document.querySelectorAll('.file-group').forEach(fileGroup => {
      attachFileCollapseListeners(fileGroup);
    });

    setupScrollObserver();
  }

  function attachExpandListeners(container) {
    container.querySelectorAll('.context-expander').forEach(expander => {
      const btn = expander.querySelector('.expand-btn');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          AIReview.context.handleExpandClick(expander);
        });
      }
    });
  }

  function attachFileCollapseListeners(fileGroup) {
    const header = fileGroup.querySelector('.file-group-header');
    const collapseBtn = fileGroup.querySelector('.file-collapse-btn');
    
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileId = collapseBtn.dataset.fileId;
        toggleFile(fileId);
      });
    }

    // Also allow clicking the header to open the file, but not when clicking collapse btn
    if (header) {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.file-collapse-btn')) return;
        const filePath = header.dataset.filePath;
        if (filePath) {
          openFile(filePath);
        }
      });
    }
  }

  function toggleFile(fileId) {
    const fileEl = document.getElementById(fileId);
    if (!fileEl) return;

    const collapseBtn = fileEl.querySelector('.file-collapse-btn');

    if (state.collapsedFiles.has(fileId)) {
      // Expand
      state.collapsedFiles.delete(fileId);
      fileEl.classList.remove('collapsed');
      if (collapseBtn) {
        collapseBtn.classList.remove('collapsed');
        collapseBtn.setAttribute('aria-label', 'Collapse file');
      }
    } else {
      // Collapse
      state.collapsedFiles.add(fileId);
      fileEl.classList.add('collapsed');
      if (collapseBtn) {
        collapseBtn.classList.add('collapsed');
        collapseBtn.setAttribute('aria-label', 'Expand file');
      }
    }
  }

  function attachCopyButtonListeners() {
    document.querySelectorAll('.copy-explanation-btn').forEach(btn => {
      // Remove existing listener to avoid duplicates
      btn.removeEventListener('click', handleCopyClick);
      btn.addEventListener('click', handleCopyClick);
    });
  }

  async function handleCopyClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const bubble = btn.closest('.explanation-bubble');
    const explanationText = bubble?.querySelector('.explanation-text');
    
    if (!explanationText) return;
    
    // Get plain text from the explanation
    const textToCopy = explanationText.textContent || '';
    
    try {
      await navigator.clipboard.writeText(textToCopy);
      
      // Visual feedback
      btn.classList.add('copied');
      const originalTitle = btn.title;
      btn.title = 'Copied!';
      
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = originalTitle;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy explanation:', err);
      btn.title = 'Failed to copy';
      setTimeout(() => {
        btn.title = 'Copy explanation to clipboard';
      }, 2000);
    }
  }

  function attachGroupCopyListeners() {
    document.querySelectorAll('.copy-group-btn').forEach(btn => {
      btn.removeEventListener('click', handleGroupCopyClick);
      btn.addEventListener('click', handleGroupCopyClick);
    });
  }

  async function handleGroupCopyClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const groupId = btn.dataset.groupId;
    
    // Find group data from state
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;
    
    // Build the formatted text
    let textToCopy = `Group title: \`${group.title || ''}\`\n\n`;
    textToCopy += `Summary:\n\`\`\`\n${group.explanation || ''}\n\`\`\`\n\n`;
    textToCopy += `Code Hunks:\n\`\`\`\n`;
    
    // Add code hunks
    if (group.hunks && group.hunks.length > 0) {
      const hunksByFile = new Map();
      
      // Group hunks by file path
      for (const hunk of group.hunks) {
        const fp = hunk.filePath;
        if (!hunksByFile.has(fp)) {
          hunksByFile.set(fp, []);
        }
        hunksByFile.get(fp).push(hunk);
      }
      
      // Format hunks by file
      for (const [filePath, hunks] of hunksByFile) {
        textToCopy += `--- ${filePath}\n`;
        textToCopy += `+++ ${filePath}\n`;
        
        for (const hunk of hunks) {
          textToCopy += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
          
          if (hunk.lines && hunk.lines.length > 0) {
            for (const line of hunk.lines) {
              const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
              textToCopy += `${prefix}${line.content}\n`;
            }
          }
        }
        textToCopy += '\n';
      }
    }
    
    textToCopy += '\`\`\`';
    
    try {
      await navigator.clipboard.writeText(textToCopy);
      
      // Visual feedback
      btn.classList.add('copied');
      const originalTitle = btn.title;
      btn.title = 'Copied!';
      
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = originalTitle;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy group:', err);
      btn.title = 'Failed to copy';
      setTimeout(() => {
        btn.title = 'Copy group summary';
      }, 2000);
    }
  }

  function toggleGroup(groupId) {
    const groupIndex = state.groups.findIndex(g => g.id === groupId);
    if (groupIndex === -1) return;

    const groupEl = document.getElementById(`group-${groupIndex}`);
    if (!groupEl) return;

    const collapseBtn = groupEl.querySelector('.collapse-btn');

    if (state.collapsedGroups.has(groupId)) {
      // Expanding the group
      state.collapsedGroups.delete(groupId);
      groupEl.classList.remove('collapsed');
      if (collapseBtn) {
        collapseBtn.classList.remove('collapsed');
        collapseBtn.setAttribute('aria-label', 'Collapse');
      }
      setupScrollObserver();
    } else {
      // Collapsing the group
      state.collapsedGroups.add(groupId);
      groupEl.classList.add('collapsed');
      if (collapseBtn) {
        collapseBtn.classList.add('collapsed');
        collapseBtn.setAttribute('aria-label', 'Expand');
      }
    }
  }

  function updateActiveStates() {
    const totalGroups = state.groups.length;

    document.querySelectorAll('.group-card').forEach((card, index) => {
      card.classList.toggle('active', index === state.currentIndex);
    });

    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    if (btnPrev) btnPrev.disabled = state.currentIndex === 0;
    if (btnNext) btnNext.disabled = state.currentIndex === totalGroups - 1;
  }

  function navigate(direction) {
    const totalGroups = state.groups.length;
    const newIndex = state.currentIndex + direction;
    if (newIndex >= 0 && newIndex < totalGroups) {
      setCurrentIndex(newIndex);
    }
  }

  function setCurrentIndex(index) {
    state.currentIndex = index;
    updateActiveStates();
    scrollToCurrent();
  }

  function setCurrentIndexFromScroll(index) {
    if (index === state.currentIndex) return;
    state.currentIndex = index;
    updateActiveStates();
  }

  function scrollToCurrent() {
    const element = document.getElementById(`group-${state.currentIndex}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function openFile(path) {
    state.vscode.postMessage({
      command: 'openFile',
      path: path,
      line: 0
    });
  }

  function setupScrollObserver() {
    if (!('IntersectionObserver' in window)) return;

    if (groupObserver) {
      groupObserver.disconnect();
    }

    groupObserver = new IntersectionObserver((entries) => {
      let bestEntry = null;

      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) {
          bestEntry = entry;
        }

        const groupEl = entry.target;
        const groupIndex = parseInt(groupEl.dataset.index, 10);
        const groupId = groupEl.dataset.groupId;
        if (Number.isNaN(groupIndex) || !groupId) continue;

        // Start streaming for any visible, loaded group (not collapsed)
        if (!state.collapsedGroups.has(groupId)) {
          const group = state.groups[groupIndex];
          if (group && group.loaded) {
            AIReview.streaming.startStreaming(groupIndex);
          }
        }
      }

      if (bestEntry) {
        const bestIndex = parseInt(bestEntry.target.dataset.index, 10);
        if (!Number.isNaN(bestIndex)) {
          setCurrentIndexFromScroll(bestIndex);
        }
      }
    }, {
      root: null,
      rootMargin: '-10% 0px -10% 0px',
      threshold: [0, 0.1, 0.5, 1.0]
    });

    document.querySelectorAll('.group-card').forEach(card => {
      groupObserver.observe(card);
    });

    // Also start streaming for groups that are already visible but not yet streaming
    document.querySelectorAll('.group-card').forEach(card => {
      const rect = card.getBoundingClientRect();
      const groupIndex = parseInt(card.dataset.index, 10);
      const groupId = card.dataset.groupId;
      
      if (rect.top < window.innerHeight && rect.bottom > 0 && !state.collapsedGroups.has(groupId)) {
        const group = state.groups[groupIndex];
        if (group && group.loaded) {
          AIReview.streaming.startStreaming(groupIndex);
        }
      }
    });
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
        case 'j':
        case 'l':
          e.preventDefault();
          navigate(1);
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'k':
        case 'h':
          e.preventDefault();
          navigate(-1);
          break;
      }
    });
  }

  function onCommitSuccess() {
    const btn = document.getElementById('btn-commit-all');
    if (btn) {
      btn.dataset.committed = 'true';
      btn.querySelector('span').textContent = 'Close';
    }
  }

  AIReview.navigation = {
    attachEventListeners,
    attachExpandListeners,
    attachFileCollapseListeners,
    attachCopyButtonListeners,
    attachGroupCopyListeners,
    toggleGroup,
    toggleFile,
    updateActiveStates,
    navigate,
    setCurrentIndex,
    setCurrentIndexFromScroll,
    scrollToCurrent,
    openFile,
    setupKeyboardShortcuts,
    onCommitSuccess,
    setupScrollObserver
  };
})();
