// Vivera docs site behavior. Plain browser JavaScript, loaded with `defer`.
(function () {
  'use strict';

  var PAGEFIND_BASE = '/docs/pagefind/';
  var COPY_RESET_MS = 2000;

  function isIndonesian() {
    return (document.documentElement.lang || '').toLowerCase().split('-')[0] === 'id';
  }

  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  function wrapTables() {
    document.querySelectorAll('article.doc table').forEach(function (table) {
      if (table.parentElement.classList.contains('table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  // Fallback when the Clipboard API is missing or refused (plain http, old
  // browsers): select the code so a manual copy still works.
  function selectContents(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function setupCopyButtons() {
    var pres = document.querySelectorAll('article.doc pre');
    if (pres.length === 0) return;
    var labels = isIndonesian()
      ? { copy: 'Salin', done: 'Tersalin' }
      : { copy: 'Copy', done: 'Copied' };

    // A changed button label is not reliably announced, so a status region is.
    var status = document.createElement('div');
    status.className = 'visually-hidden';
    status.setAttribute('role', 'status');
    document.body.appendChild(status);

    pres.forEach(function (pre) {
      if (pre.parentElement.classList.contains('code-block')) return;
      var block = document.createElement('div');
      block.className = 'code-block';
      pre.parentNode.insertBefore(block, pre);

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-code';
      button.textContent = labels.copy;
      block.appendChild(button);
      block.appendChild(pre);

      var timer = 0;
      button.addEventListener('click', function () {
        var code = pre.querySelector('code') || pre;
        var text = code.textContent;
        Promise.resolve()
          .then(function () { return navigator.clipboard.writeText(text); })
          .then(function () {
            button.textContent = labels.done;
            status.textContent = labels.done;
            clearTimeout(timer);
            timer = setTimeout(function () {
              button.textContent = labels.copy;
              status.textContent = '';
            }, COPY_RESET_MS);
          }, function () {
            selectContents(code);
          });
      });
    });
  }

  function setupSidebar() {
    var toggle = document.querySelector('button.sidebar-toggle');
    var sidebar = document.getElementById('sidebar');
    if (!toggle || !sidebar) return null;

    function set(open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) sidebar.setAttribute('data-open', '');
      else sidebar.removeAttribute('data-open');
    }

    set(false);
    toggle.addEventListener('click', function () {
      set(!sidebar.hasAttribute('data-open'));
    });

    return {
      isOpen: function () { return sidebar.hasAttribute('data-open'); },
      close: function () {
        set(false);
        toggle.focus();
      },
    };
  }

  function loadOnce(tag, attrs) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      el.onload = function () { resolve(); };
      el.onerror = function () {
        el.remove();
        reject(new Error('failed to load ' + (attrs.src || attrs.href)));
      };
      document.head.appendChild(el);
    });
  }

  function setupSearch() {
    var toggle = document.querySelector('button.search-toggle');
    var panel = document.getElementById('search');
    if (!toggle || !panel) return null;

    var ready = null;
    toggle.setAttribute('aria-expanded', 'false');

    function load() {
      if (!ready) {
        ready = Promise.all([
          loadOnce('link', { rel: 'stylesheet', href: PAGEFIND_BASE + 'pagefind-ui.css' }),
          loadOnce('script', { src: PAGEFIND_BASE + 'pagefind-ui.js' }),
        ]).then(function () {
          new window.PagefindUI({ element: '#search', showSubResults: true });
        });
        // A failed load is retried on the next open instead of staying broken.
        ready.catch(function () { ready = null; });
      }
      return ready;
    }

    // The Pagefind UI may render its input a frame after construction.
    function focusInput(tries) {
      if (panel.hidden) return;
      var input = panel.querySelector('input');
      if (input) {
        input.focus();
        return;
      }
      if ((tries || 0) < 60) {
        requestAnimationFrame(function () { focusInput((tries || 0) + 1); });
      }
    }

    function open() {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      load().then(function () { focusInput(0); }, function (err) {
        console.error(err);
      });
    }

    function close() {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }

    toggle.addEventListener('click', function () {
      if (panel.hidden) open();
      else close();
    });

    return {
      isOpen: function () { return !panel.hidden; },
      open: open,
      close: close,
      focusInput: focusInput,
    };
  }

  function setupKeys(sidebar, search) {
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (search && search.isOpen()) search.close();
        else if (sidebar && sidebar.isOpen()) sidebar.close();
        return;
      }
      if (!search || event.defaultPrevented || event.altKey || isTypingTarget(event.target)) return;
      var slash = event.key === '/' && !event.ctrlKey && !event.metaKey;
      var ctrlK = (event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K');
      if (!slash && !ctrlK) return;
      event.preventDefault();
      if (search.isOpen()) search.focusInput(0);
      else search.open();
    });
  }

  function init() {
    wrapTables();
    setupCopyButtons();
    setupKeys(setupSidebar(), setupSearch());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
