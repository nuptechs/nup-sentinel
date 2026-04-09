// ─────────────────────────────────────────────
// Sentinel SDK — QA Annotator Overlay
// Floating UI for testers to annotate issues
// on the page without leaving the app
// ─────────────────────────────────────────────

/**
 * Annotator creates a minimal floating panel that lets
 * testers highlight elements, take screenshots, and
 * describe issues — then submits them as Findings.
 *
 * Usage:
 *   const annotator = new Annotator({ reporter });
 *   annotator.mount(); // shows the floating button
 *   annotator.unmount(); // removes it
 */
export class Annotator {
  constructor({ reporter, position = 'bottom-right' } = {}) {
    if (!reporter) throw new Error('Annotator: reporter is required');

    this._reporter = reporter;
    this._position = position;
    this._root = null;
    this._panel = null;
    this._isOpen = false;
    this._highlightedElement = null;
    this._highlightOverlay = null;
    this._selecting = false;
  }

  /**
   * Mount the floating QA button on the page.
   */
  mount() {
    if (this._root) return;

    this._root = document.createElement('div');
    this._root.id = 'sentinel-annotator';
    this._root.setAttribute('data-sentinel-block', '');
    this._injectStyles();
    this._createTriggerButton();
    document.body.appendChild(this._root);
  }

  /**
   * Remove the annotator from the DOM.
   */
  unmount() {
    this._stopSelecting();
    if (this._root) {
      this._root.remove();
      this._root = null;
    }
  }

  // ── UI Construction ───────────────────────

  _injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #sentinel-annotator {
        position: fixed;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        ${this._positionCSS()}
      }
      .sentinel-trigger {
        width: 48px; height: 48px; border-radius: 50%;
        background: #ef4444; color: white; border: none;
        cursor: pointer; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        display: flex; align-items: center; justify-content: center;
        transition: transform 0.2s;
      }
      .sentinel-trigger:hover { transform: scale(1.1); }
      .sentinel-panel {
        position: absolute; bottom: 60px; right: 0;
        width: 320px; background: white; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2); padding: 16px;
        display: none; color: #1a1a1a;
      }
      .sentinel-panel.open { display: block; }
      .sentinel-panel h3 { margin: 0 0 12px; font-size: 16px; }
      .sentinel-panel label { display: block; margin-bottom: 4px; font-weight: 500; font-size: 13px; }
      .sentinel-panel textarea, .sentinel-panel select {
        width: 100%; padding: 8px; border: 1px solid #d1d5db;
        border-radius: 6px; font-size: 13px; box-sizing: border-box;
        margin-bottom: 10px; font-family: inherit;
      }
      .sentinel-panel textarea { height: 80px; resize: vertical; }
      .sentinel-panel .sentinel-actions { display: flex; gap: 8px; margin-top: 4px; }
      .sentinel-btn {
        flex: 1; padding: 8px; border: none; border-radius: 6px;
        cursor: pointer; font-size: 13px; font-weight: 500;
      }
      .sentinel-btn-primary { background: #2563eb; color: white; }
      .sentinel-btn-primary:hover { background: #1d4ed8; }
      .sentinel-btn-secondary { background: #f3f4f6; color: #374151; }
      .sentinel-btn-select { background: #f59e0b; color: white; margin-bottom: 10px; width: 100%; }
      .sentinel-highlight {
        position: fixed; pointer-events: none;
        border: 3px solid #ef4444; border-radius: 4px;
        background: rgba(239,68,68,0.1);
        z-index: 2147483646;
        transition: all 0.15s;
      }
      .sentinel-info { font-size: 11px; color: #6b7280; margin-top: 8px; }
    `;
    this._root.appendChild(style);
  }

  _positionCSS() {
    const positions = {
      'bottom-right': 'bottom: 20px; right: 20px;',
      'bottom-left': 'bottom: 20px; left: 20px;',
      'top-right': 'top: 20px; right: 20px;',
      'top-left': 'top: 20px; left: 20px;',
    };
    return positions[this._position] || positions['bottom-right'];
  }

  _createTriggerButton() {
    const btn = document.createElement('button');
    btn.className = 'sentinel-trigger';
    btn.innerHTML = '🐛';
    btn.title = 'Report an issue';
    btn.addEventListener('click', () => this._toggle());
    this._root.appendChild(btn);

    this._createPanel();
  }

  _createPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'sentinel-panel';
    this._panel.innerHTML = `
      <h3>Report Issue</h3>
      <button class="sentinel-btn sentinel-btn-select" data-action="select">
        🎯 Select Element
      </button>
      <div class="sentinel-selected" style="display:none; margin-bottom:10px; font-size:12px; color:#6b7280;"></div>
      <label>Description</label>
      <textarea data-field="description" placeholder="Describe the issue..."></textarea>
      <label>Type</label>
      <select data-field="type">
        <option value="bug">Bug</option>
        <option value="ux">UX Issue</option>
        <option value="visual">Visual</option>
        <option value="performance">Performance</option>
        <option value="data">Data Issue</option>
        <option value="other">Other</option>
      </select>
      <label>Severity</label>
      <select data-field="severity">
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
        <option value="low">Low</option>
      </select>
      <div class="sentinel-actions">
        <button class="sentinel-btn sentinel-btn-secondary" data-action="cancel">Cancel</button>
        <button class="sentinel-btn sentinel-btn-primary" data-action="submit">Submit</button>
      </div>
      <div class="sentinel-info"></div>
    `;

    this._panel.querySelector('[data-action="select"]').addEventListener('click', () => this._startSelecting());
    this._panel.querySelector('[data-action="cancel"]').addEventListener('click', () => this._close());
    this._panel.querySelector('[data-action="submit"]').addEventListener('click', () => this._submit());
    this._root.appendChild(this._panel);
  }

  // ── Panel State ───────────────────────────

  _toggle() {
    this._isOpen ? this._close() : this._open();
  }

  _open() {
    this._isOpen = true;
    this._panel.classList.add('open');
  }

  _close() {
    this._isOpen = false;
    this._panel.classList.remove('open');
    this._stopSelecting();
    this._resetForm();
  }

  _resetForm() {
    this._panel.querySelector('[data-field="description"]').value = '';
    this._panel.querySelector('[data-field="type"]').value = 'bug';
    this._panel.querySelector('[data-field="severity"]').value = 'medium';
    this._panel.querySelector('.sentinel-selected').style.display = 'none';
    this._highlightedElement = null;
  }

  // ── Element Selection ─────────────────────

  _startSelecting() {
    this._selecting = true;
    document.body.style.cursor = 'crosshair';

    this._highlightOverlay = document.createElement('div');
    this._highlightOverlay.className = 'sentinel-highlight';
    this._highlightOverlay.setAttribute('data-sentinel-block', '');
    document.body.appendChild(this._highlightOverlay);

    this._onMouseMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('#sentinel-annotator')) return;

      const rect = el.getBoundingClientRect();
      Object.assign(this._highlightOverlay.style, {
        top: `${rect.top}px`, left: `${rect.left}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
        display: 'block',
      });
    };

    this._onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('#sentinel-annotator')) return;

      this._highlightedElement = {
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: el.className || undefined,
        textContent: el.textContent?.slice(0, 100),
        rect: el.getBoundingClientRect().toJSON(),
        xpath: this._getXPath(el),
      };

      const info = this._panel.querySelector('.sentinel-selected');
      info.textContent = `Selected: <${this._highlightedElement.tagName}${this._highlightedElement.id ? '#' + this._highlightedElement.id : ''}>`;
      info.style.display = 'block';
      this._stopSelecting();
    };

    document.addEventListener('mousemove', this._onMouseMove, true);
    document.addEventListener('click', this._onClick, true);
  }

  _stopSelecting() {
    this._selecting = false;
    document.body.style.cursor = '';
    if (this._highlightOverlay) {
      this._highlightOverlay.remove();
      this._highlightOverlay = null;
    }
    if (this._onMouseMove) {
      document.removeEventListener('mousemove', this._onMouseMove, true);
      this._onMouseMove = null;
    }
    if (this._onClick) {
      document.removeEventListener('click', this._onClick, true);
      this._onClick = null;
    }
  }

  _getXPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  // ── Submission ────────────────────────────

  async _submit() {
    const description = this._panel.querySelector('[data-field="description"]').value.trim();
    const type = this._panel.querySelector('[data-field="type"]').value;
    const severity = this._panel.querySelector('[data-field="severity"]').value;

    if (!description) {
      this._showInfo('Please describe the issue.', true);
      return;
    }

    const btn = this._panel.querySelector('[data-action="submit"]');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      // Take a screenshot if html2canvas is available
      let screenshot = null;
      try {
        const html2canvas = (await import('html2canvas')).default;
        const canvas = await html2canvas(document.body, {
          ignoreElements: (el) => el.id === 'sentinel-annotator',
          scale: 0.5,
          logging: false,
        });
        screenshot = canvas.toDataURL('image/jpeg', 0.6);
      } catch {
        // html2canvas not available — no screenshot
      }

      await this._reporter.reportFinding({
        annotation: {
          description,
          screenshot,
          element: this._highlightedElement,
          url: location.href,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          timestamp: Date.now(),
        },
        browserContext: {
          url: location.href,
          userAgent: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          timestamp: Date.now(),
        },
        type,
        severity,
        source: 'manual',
      });

      this._showInfo('Issue reported!', false);
      setTimeout(() => this._close(), 1500);
    } catch (err) {
      this._showInfo(`Error: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit';
    }
  }

  _showInfo(text, isError) {
    const info = this._panel.querySelector('.sentinel-info');
    info.textContent = text;
    info.style.color = isError ? '#ef4444' : '#22c55e';
  }
}
