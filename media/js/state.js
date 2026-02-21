// Shared state for the AI review webview
(function() {
  const AIReview = window.AIReview = window.AIReview || {};

  AIReview.state = {
    vscode: null,
    app: null,
    initialData: null,
    currentIndex: 0,
    isStreaming: false,
    reviewTitle: '',
    providerName: '',
    groups: [],
    changesAuthoredByAi: false,
    streamingState: new Map(),
    collapsedGroups: new Set(),
    collapsedFiles: new Set(),
    pendingContextLoads: new Set()
  };
})();
