// Codebrief - Webview bootstrap
(function() {
  const AIReview = window.AIReview = window.AIReview || {};
  const { state } = AIReview;

  state.vscode = acquireVsCodeApi();
  state.app = document.getElementById('app');
  state.initialData = window.reviewData;
  state.isStreaming = window.isStreaming || false;
  state.changesAuthoredByAi = !!(state.initialData && state.initialData.changesAuthoredByAi);
  state.suggestedCommitMessage = state.initialData && state.initialData.suggestedCommitMessage;

  console.log('Codebrief: Initializing', { isStreaming: state.isStreaming, initialData: state.initialData });

  state.vscode.postMessage({ command: 'webviewReady' });

  if (AIReview.search && typeof AIReview.search.init === 'function') {
    AIReview.search.init();
  }

  if (state.isStreaming) {
    initStreamingMode();
  } else {
    initLegacyMode();
  }

  function initStreamingMode() {
    AIReview.render.showLoadingState('Analyzing changes...');
    window.addEventListener('message', handleExtensionMessage);
  }

  function initLegacyMode() {
    // Legacy mode is not used in streaming-only flow.
    AIReview.render.showLoadingState('Preparing review...');
  }

  function handleExtensionMessage(event) {
    const message = event.data;
    console.log('Received message:', message.command);

    switch (message.command) {
      case 'setLoading':
        AIReview.render.showLoadingState(message.message);
        break;

      case 'initGroups':
        state.reviewTitle = message.title;
        state.providerName = message.providerName || '';
        state.changesAuthoredByAi = !!message.changesAuthoredByAi;
        state.suggestedCommitMessage = message.suggestedCommitMessage;
        state.groups = message.groups.map((g) => ({
          ...g,
          loaded: false,
          skeleton: true
        }));
        AIReview.render.renderSkeletonUI();
        break;

      case 'updateGroup':
        AIReview.streaming.updateGroupWithContent(message.groupId, message.group);
        break;

      case 'updateCommitMessage':
        state.suggestedCommitMessage = message.message;
        AIReview.render.updateCommitButtonState();
        break;

      case 'complete':
        AIReview.streaming.onStreamingComplete();
        break;

      case 'commitSuccess':
        AIReview.navigation.onCommitSuccess();
        break;

      case 'error':
        AIReview.render.showError(message.message, message.canRetry);
        break;

      case 'contextLoaded':
        AIReview.context.handleContextLoaded(message);
        break;

      case 'focusFile':
        focusFile(message.filePath);
        break;
    }
  }

  function focusFile(filePath) {
    const fileGroup = document.querySelector(`[data-file="${AIReview.utils.escapeHtml(filePath)}"]`);
    if (fileGroup) {
      fileGroup.scrollIntoView({ block: 'start' });
      fileGroup.classList.add('file-group-highlight');
      setTimeout(() => {
        fileGroup.classList.remove('file-group-highlight');
      }, 2000);
    } else {
      console.warn('File not found in review:', filePath);
    }
  }
})();
