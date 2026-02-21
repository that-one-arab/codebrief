// Utilities for rendering and escaping
(function() {
  const AIReview = window.AIReview = window.AIReview || {};

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\\/g, '&#92;')
      .replace(/\{/g, '&#123;')
      .replace(/\}/g, '&#125;');
  }

  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined') {
      console.warn('marked library not loaded, falling back to plain text');
      return escapeHtml(text);
    }
    const html = marked.parse(text, {
      gfm: true,
      breaks: true,
      headerIds: false
    });
    return html;
  }

  AIReview.utils = {
    escapeHtml,
    renderMarkdown
  };
})();
