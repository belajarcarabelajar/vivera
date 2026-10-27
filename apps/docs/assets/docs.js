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

  // Step-by-step walkthrough of a hero diagram. The page lists the steps as
  // <ol data-stepper="NAME"> with <li data-nodes="Mermaid node ids">; this code
  // inlines the matching NAME.svg (or NAME-dark.svg) and highlights one step at
  // a time. Any failure leaves the page as written: the picture and the list.
  var NODE_KEY = /(?:^|-)flowchart-([A-Za-z0-9_]+)-\d+$/;
  var EDGE_KEY = /(?:^|-)L_(.+)_\d+$/;

  // Node ids may contain underscores, so an edge splits where both halves are
  // known nodes.
  function edgeEnds(body, names) {
    for (var i = body.indexOf('_'); i !== -1; i = body.indexOf('_', i + 1)) {
      var a = body.slice(0, i);
      var b = body.slice(i + 1);
      if (names[a] && names[b]) return [a, b];
    }
    return null;
  }

  // Keys are SVG element ids (`my-svg-flowchart-Gate1-17`, `my-svg-L_A_B_0`)
  // or edge label data-ids (`L_A_B_0`). A node is on when the step names it, an
  // edge when both its ends are on; keys that are neither are left out.
  function stepTargets(keys, nodes) {
    var names = {};
    var lit = {};
    keys.forEach(function (k) {
      var m = NODE_KEY.exec(k);
      if (m) names[m[1]] = true;
    });
    nodes.forEach(function (n) { lit[n] = true; });
    var on = [];
    var off = [];
    keys.forEach(function (k) {
      var node = NODE_KEY.exec(k);
      if (node) {
        (lit[node[1]] ? on : off).push(k);
        return;
      }
      var edge = EDGE_KEY.exec(k);
      if (!edge) return;
      var ends = edgeEnds(edge[1], names);
      (ends && lit[ends[0]] && lit[ends[1]] ? on : off).push(k);
    });
    return { on: on, off: off };
  }

  // The source the browser would pick right now: the first <source> whose
  // media matches, else the img. currentSrc can lag a colour scheme change.
  function heroSrc(picture, img) {
    var sources = picture ? picture.querySelectorAll('source[srcset]') : [];
    for (var i = 0; i < sources.length; i++) {
      var media = sources[i].getAttribute('media');
      if (!media || window.matchMedia(media).matches) {
        var first = sources[i].getAttribute('srcset').trim().split(/\s+/)[0];
        return new URL(first, document.baseURI).href;
      }
    }
    return img.currentSrc || img.src;
  }

  function findHero(list, name) {
    var article = list.closest('article');
    if (!article || !/^[\w-]+$/.test(name)) return null;
    var pattern = new RegExp('/' + name + '(-dark)?\\.svg$');
    var imgs = article.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var src = (imgs[i].currentSrc || imgs[i].src || '').split(/[?#]/)[0];
      if (pattern.test(src)) return imgs[i];
    }
    return null;
  }

  // Inlined SVG runs in the page, unlike an <img>. Drop what could execute:
  // script elements, on* handlers, and javascript: links. foreignObject and
  // style stay, since Mermaid labels and colours need them.
  function sanitizeSvg(root) {
    [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'))).forEach(function (el) {
      if ((el.localName || '').toLowerCase() === 'script') {
        el.remove();
        return;
      }
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var local = name.slice(name.indexOf(':') + 1);
        if (local.indexOf('on') === 0 ||
            (local === 'href' && /^javascript:/i.test(String(attr.value).trim()))) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return root;
  }

  function fetchSvg(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('stepper: ' + res.status + ' for ' + url);
      return res.text();
    }).then(function (text) {
      var parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      var root = parsed.documentElement;
      if (root.nodeName !== 'svg' || parsed.querySelector('parsererror')) {
        throw new Error('stepper: not an SVG: ' + url);
      }
      return sanitizeSvg(document.importNode(root, true));
    });
  }

  function stepperLabels(n) {
    return isIndonesian()
      ? { prev: 'Sebelumnya', next: 'Berikutnya', all: 'Tampilkan semua',
          group: 'Langkah demi langkah', count: function (k) { return 'Langkah ' + k + ' dari ' + n; },
          none: 'Semua ' + n + ' langkah' }
      : { prev: 'Previous', next: 'Next', all: 'Show all',
          group: 'Step by step', count: function (k) { return 'Step ' + k + ' of ' + n; },
          none: 'All ' + n + ' steps' };
  }

  function button(label, className) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    return b;
  }

  function buildStepper(list, img) {
    var items = list.querySelectorAll('li[data-nodes]');
    if (items.length === 0) return;
    var picture = img.closest('picture');
    var hero = picture || img;
    var labels = stepperLabels(items.length);
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var current = -1;
    var url = '';
    var svg = null;
    var keyed = {};

    var root = document.createElement('div');
    root.className = 'stepper';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', labels.group);
    var figure = document.createElement('div');
    figure.className = 'stepper-figure';
    var bar = document.createElement('div');
    bar.className = 'stepper-bar';
    var prev = button(labels.prev, 'stepper-prev');
    var next = button(labels.next, 'stepper-next');
    var all = button(labels.all, 'stepper-all');
    var count = document.createElement('span');
    count.className = 'stepper-count';
    var caption = document.createElement('div');
    caption.className = 'stepper-caption';
    caption.setAttribute('aria-live', 'polite');
    bar.appendChild(prev);
    bar.appendChild(count);
    bar.appendChild(next);
    bar.appendChild(all);
    bar.appendChild(caption);
    root.appendChild(figure);
    root.appendChild(bar);

    function index(el) {
      keyed = {};
      function add(key, node) { (keyed[key] = keyed[key] || []).push(node); }
      el.querySelectorAll('.node[id], path[id]').forEach(function (n) { add(n.id, n); });
      el.querySelectorAll('.edgeLabel .label[data-id]').forEach(function (n) {
        add(n.getAttribute('data-id'), n);
      });
    }

    function mark(keys, add, remove) {
      keys.forEach(function (k) {
        keyed[k].forEach(function (n) {
          n.classList.add(add);
          n.classList.remove(remove);
        });
      });
    }

    function render(scroll) {
      var keys = Object.keys(keyed);
      prev.setAttribute('aria-disabled', current <= 0 ? 'true' : 'false');
      next.setAttribute('aria-disabled', current >= items.length - 1 ? 'true' : 'false');
      all.setAttribute('aria-disabled', current < 0 ? 'true' : 'false');
      caption.textContent = '';
      if (current < 0) {
        keys.forEach(function (k) {
          keyed[k].forEach(function (n) { n.classList.remove('is-step-on', 'is-step-off'); });
        });
        count.textContent = labels.none;
        return;
      }
      var item = items[current];
      var split = stepTargets(keys, item.getAttribute('data-nodes').trim().split(/\s+/));
      mark(split.on, 'is-step-on', 'is-step-off');
      mark(split.off, 'is-step-off', 'is-step-on');
      count.textContent = labels.count(current + 1);
      Array.prototype.forEach.call(item.childNodes, function (n) {
        caption.appendChild(n.cloneNode(true));
      });
      var first = split.on.length ? keyed[split.on[0]][0] : null;
      if (scroll && first) {
        var box = first.getBoundingClientRect();
        if (box.top < 0 || box.bottom > window.innerHeight - bar.offsetHeight) {
          first.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
        }
      }
    }

    function go(k) {
      if (k < -1 || k >= items.length || k === current) return;
      current = k;
      render(true);
    }

    function restore() {
      root.remove();
      hero.hidden = false;
      list.classList.remove('visually-hidden');
    }

    function load() {
      var want = heroSrc(picture, img);
      if (want === url) return;
      url = want;
      fetchSvg(want).then(function (el) {
        if (want !== url) return;
        if (svg) figure.replaceChild(el, svg);
        else figure.appendChild(el);
        svg = el;
        index(svg);
        if (!root.parentNode) {
          hero.parentNode.insertBefore(root, hero.nextSibling);
          hero.hidden = true;
          list.classList.add('visually-hidden');
        }
        render(false);
      }).catch(function (err) {
        console.error(err);
        if (want === url) restore();
      });
    }

    prev.addEventListener('click', function () { if (current > 0) go(current - 1); });
    next.addEventListener('click', function () { go(current + 1); });
    all.addEventListener('click', function () { go(-1); });
    root.addEventListener('keydown', function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === 'ArrowLeft' && current > 0) go(current - 1);
      else if (event.key === 'ArrowRight') go(current + 1);
      else return;
      event.preventDefault();
    });

    if (picture) {
      picture.querySelectorAll('source[media]').forEach(function (source) {
        var query = window.matchMedia(source.getAttribute('media'));
        if (query.addEventListener) query.addEventListener('change', load);
        else if (query.addListener) query.addListener(load);
      });
    }
    load();
  }

  function setupSteppers() {
    document.querySelectorAll('article.doc ol[data-stepper]').forEach(function (list) {
      var img = findHero(list, list.getAttribute('data-stepper'));
      if (img) buildStepper(list, img);
    });
  }

  // The one test seam: scripts/docs-stepper.test.mjs evaluates this file with
  // a stub window and reads the helpers from here.
  window.viveraDocs = { stepTargets: stepTargets, sanitizeSvg: sanitizeSvg };

  function init() {
    wrapTables();
    setupCopyButtons();
    setupSteppers();
    setupKeys(setupSidebar(), setupSearch());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
