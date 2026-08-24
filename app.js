/* Clip Captioner — app shell. Vanilla JS, no framework, no runtime downloads. */
(function () {
  'use strict';

  var E = window.CaptionEngine;
  var $ = function (id) { return document.getElementById(id); };
  var LS_KEY = 'villagepgh-brand-kit';
  var FONTS_HEAD = ['Anton', 'Archivo Black', 'Oswald'];
  var FONTS_BODY = ['Space Grotesk', 'Oswald'];
  var DEF_BRAND = {
    black: '#0A0908', gold: '#E8B34B', accent: '#FF4B2E',
    headFont: 'Anton', bodyFont: 'Space Grotesk',
    handles: '@thevillagepgh · @ftk.pgh'
  };

  var uid = function () { return Math.random().toString(36).slice(2, 9); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  function fmt(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function loadBrand() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return Object.assign({}, DEF_BRAND, raw);
    } catch (e) { return Object.assign({}, DEF_BRAND); }
  }
  function saveBrand(b) { try { localStorage.setItem(LS_KEY, JSON.stringify(b)); } catch (e) {} }

  // ---------------------------------------------------------------- state

  var state = {
    clips: [], sel: null, selBox: null,
    aspect: '9:16',
    playing: false, time: 0,
    brand: loadBrand(),
    quality: 'high', format: null, scope: 'one',
    exporting: false, pct: 0,
    exportUrl: null, exportName: '', exportSize: '',
    tab: null
  };

  var el = {};
  ['app','stage','frame','video','canvas','empty','emptyAdd','aspectSeg','playBtn','clock','timeline','playhead',
   'rail','addBtn','fileInput','sheet','sheetTitle','sheetClose','sheetGrow','tabbar',
   'tplChips','tplHint','bdChips','bdOpacityRow','bdOpacity','bdOpacityOut','rotateBtn','resetPosBtn',
   'fieldsGrp','fieldsLbl','fields','boxesGrp','boxChips','boxEditor','boxText','boxSize','boxSizeOut',
   'boxFonts','boxColors','delBox','tStart','tEnd','animChips','dupNext',
   'trimLbl','trimbar','cutL','cutR','keepBox','trimPh','trimL','trimR','setStart','setEnd','splitBtn','resetTrim',
   'moveL','moveR','removeClip',
   'scopeChips','formatChips','qualityChips','exportBtn','exportProgress','exportBar','exportPctText','exportDl','saveHint','formatNote',
   'cBlack','cGold','cAccent','bHandles','headFonts','bodyFonts','resetBrand'
  ].forEach(function (k) { el[k] = $(k); });

  var video = el.video, canvas = el.canvas, ctx = canvas.getContext('2d');
  video.muted = false;
  video.playsInline = true;

  var isDesktop = function () { return window.matchMedia('(min-width: 900px)').matches; };
  var isIOS = function () {
    return /iP(hone|od|ad)/.test(navigator.platform) ||
      (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
  };
  var cur = function () {
    for (var i = 0; i < state.clips.length; i++) if (state.clips[i].id === state.sel) return state.clips[i];
    return null;
  };
  var idxOf = function (id) { for (var i = 0; i < state.clips.length; i++) if (state.clips[i].id === id) return i; return -1; };

  // ---------------------------------------------------------------- toast

  var toastEl = null, toastTimer = 0;
  function toast(msg, kind) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.dataset.kind = kind || 'info';
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, kind === 'err' ? 6000 : 3200);
  }

  // ---------------------------------------------------------------- clip model

  function span(c) {
    var st = c.trimStart || 0;
    var en = (c.trimEnd && c.trimEnd > st) ? c.trimEnd : (c.duration || 0);
    return Math.max(0.05, en - st);
  }
  function seqTotal() {
    var t = 0;
    for (var i = 0; i < state.clips.length; i++) t += span(state.clips[i]);
    return t || 1;
  }
  function seqOffset(id) {
    var off = 0;
    for (var i = 0; i < state.clips.length; i++) { if (state.clips[i].id === id) break; off += span(state.clips[i]); }
    return off;
  }
  function layersOf(c) { return (c.templates && c.templates.length) ? c.templates : [c.template]; }
  function valsFor(c, tplId) {
    if (!E) return {};
    var id = tplId || c.template;
    var defs = {};
    (((E.TEMPLATES[id] || {}).fields) || []).forEach(function (f) { defs[f.id] = f.def; });
    return Object.assign(defs, (c.valsByTpl || {})[id] || {});
  }
  function resolvedClip(c) {
    var valsAll = {};
    layersOf(c).forEach(function (id) { valsAll[id] = valsFor(c, id); });
    return Object.assign({}, c, {
      templates: layersOf(c), valsAll, vals: valsFor(c),
      trimEnd: c.trimEnd || c.duration || 0
    });
  }
  // Templates animate in over ~1.5s. Parking a paused preview at trimStart would
  // show an empty frame, so default to a moment where the caption has settled.
  function settledTime(c) {
    var st = c.trimStart || 0;
    if (!c.duration) return st;
    return st + Math.min(1.6, span(c) * 0.4);
  }

  function newBox() {
    return { id: uid(), text: 'YOUR TEXT', x: 0.5, y: 0.5, size: 90, font: state.brand.headFont, color: '#FFFFFF' };
  }

  // ---------------------------------------------------------------- preview

  var rafId = 0, dirty = true, lastClock = 0, hitRects = {};

  function schedule() { if (!rafId) rafId = requestAnimationFrame(loop); }
  function requestDraw() { dirty = true; schedule(); }

  function sizeStage() {
    var res = (E && E.RES[state.aspect]) || [1080, 1920];
    var rw = res[0], rh = res[1];
    var pad = isDesktop() ? 32 : 16;
    var aw = Math.max(60, el.stage.clientWidth - pad);
    var ah = Math.max(60, el.stage.clientHeight - pad);
    var sc = Math.min(aw / rw, ah / rh);
    var w = Math.max(60, Math.round(rw * sc));
    var h = Math.max(60, Math.round(rh * sc));
    el.frame.style.width = w + 'px';
    el.frame.style.height = h + 'px';

    // Backing store follows the *displayed* size, not the 1080p export size.
    // A phone never has to shade 2 megapixels per frame just to show a preview.
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    var cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    var MAXPX = 1600 * 900;
    if (cw * ch > MAXPX) { var k = Math.sqrt(MAXPX / (cw * ch)); cw = Math.round(cw * k); ch = Math.round(ch * k); }
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    requestDraw();
  }

  function draw(t) {
    if (!E) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var clip = cur();
    if (!clip) return;
    if (clip.rotate) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (video.readyState >= 2) E.drawVideoCover(ctx, video, canvas.width, canvas.height, clip.rotate);
    }
    var opts = { selectedBox: state.selBox, editing: clip.template === 'custom', rectsOut: {} };
    E.renderAll(ctx, canvas.width, canvas.height, resolvedClip(clip), state.brand, t, opts);
    hitRects = opts.rectsOut || {};
  }

  function updatePlayhead() {
    var clip = cur();
    if (!clip) { el.playhead.style.left = '0%'; return; }
    var st = clip.trimStart || 0;
    var frac = (seqOffset(clip.id) + clamp(video.currentTime - st, 0, span(clip))) / seqTotal();
    el.playhead.style.left = (clamp(frac, 0, 1) * 100) + '%';
    el.trimPh.style.left = (clip.duration ? clamp(video.currentTime / clip.duration, 0, 1) * 100 : 0) + '%';
  }

  function loop() {
    rafId = 0;
    var clip = cur();
    if (clip && video.readyState >= 1) {
      var dur = clip.duration || video.duration || 0;
      var st = clip.trimStart || 0;
      var te = (clip.trimEnd && clip.trimEnd > st) ? clip.trimEnd : dur;
      if (state.playing && te > st + 0.05 && video.currentTime >= te) {
        var i = idxOf(clip.id);
        var next = state.clips[i + 1] || state.clips[0];
        if (next && next.id !== clip.id) selectClip(next.id, { play: true });
        else video.currentTime = st;
      }
      draw(video.currentTime);
      updatePlayhead();
      var now = performance.now();
      if (now - lastClock > 180) { lastClock = now; state.time = video.currentTime; renderClock(); }
    } else if (dirty) {
      draw(0);
      updatePlayhead();
    }
    dirty = false;
    if (state.playing) schedule();
  }

  // ---------------------------------------------------------------- files

  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) {
      return (f.type && f.type.indexOf('video/') === 0) || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(f.name || '');
    });
    if (!files.length) { toast('No video files in that selection.', 'err'); return; }
    var added = files.map(function (f) {
      return {
        id: uid(), name: f.name || 'clip', url: URL.createObjectURL(f),
        duration: 0, thumb: null, trimStart: 0, trimEnd: 0,
        template: 'promo', templates: ['promo'], valsByTpl: {}, tplOffset: {},
        rotate: 0, backdrop: 'auto', backdropOpacity: 100,
        timing: { start: 0, end: null, anim: 'fade' },
        custom: [newBox()]
      };
    });
    var first = state.clips.length === 0;
    state.clips = state.clips.concat(added);
    if (!state.sel) selectClip(added[0].id, { play: false });
    render();
    added.forEach(function (c) {
      if (!E) return;
      E.probe(c.url).then(function (m) {
        var live = state.clips[idxOf(c.id)];
        if (!live) return;
        live.thumb = m.thumb;
        live.duration = m.duration;
        if (live.id === state.sel && video.paused && video.currentTime < (live.trimStart || 0) + 0.05) {
          video.currentTime = settledTime(live);
        }
        render();
        requestDraw();
      });
    });
    if (first && !isDesktop()) openTab('text');
  }

  function selectClip(id, opts) {
    opts = opts || {};
    var c = state.clips[idxOf(id)];
    if (!c) return;
    state.sel = id;
    state.selBox = (c.custom && c.custom[0] && c.custom[0].id) || null;
    clearExport();
    var target = opts.time != null ? opts.time : settledTime(c);
    if (video.getAttribute('src') !== c.url) {
      video.src = c.url;
      video.addEventListener('loadedmetadata', function () {
        video.currentTime = target;
        if (opts.play) playVideo();
        requestDraw();
      }, { once: true });
    } else {
      video.currentTime = target;
      if (opts.play) playVideo();
    }
    render();
    requestDraw();
  }

  function playVideo() {
    var p = video.play();
    if (p && p.catch) p.catch(function () {
      video.muted = true;
      var p2 = video.play();
      if (p2 && p2.catch) p2.catch(function () {});
    });
  }
  function togglePlay() {
    if (!cur()) return;
    if (video.paused) playVideo(); else video.pause();
  }

  function removeClip(id) {
    var c = state.clips[idxOf(id)];
    if (!c) return;
    var shared = state.clips.some(function (x) { return x.id !== id && x.url === c.url; });
    if (!shared) URL.revokeObjectURL(c.url);
    state.clips = state.clips.filter(function (x) { return x.id !== id; });
    if (state.sel === id) {
      state.sel = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (state.clips.length) selectClip(state.clips[0].id, { play: false });
    }
    render();
    requestDraw();
  }

  function moveClip(dir) {
    var i = idxOf(state.sel);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= state.clips.length) return;
    var arr = state.clips.slice();
    var m = arr.splice(i, 1)[0];
    arr.splice(j, 0, m);
    state.clips = arr;
    render();
  }

  // ---------------------------------------------------------------- seeking

  function seekSeqFrac(frac) {
    var total = seqTotal();
    var t = clamp(frac, 0, 1) * total;
    for (var i = 0; i < state.clips.length; i++) {
      var c = state.clips[i], sp = span(c);
      if (t <= sp || i === state.clips.length - 1) {
        var local = (c.trimStart || 0) + Math.min(t, sp);
        if (c.id !== state.sel) {
          var now = performance.now();
          if (now - (seekSeqFrac._last || 0) < 220) return; // don't thrash video.src while dragging
          seekSeqFrac._last = now;
          selectClip(c.id, { time: local, play: false });
        } else {
          video.currentTime = local;
          state.time = local;
          renderClock();
          requestDraw();
        }
        return;
      }
      t -= sp;
    }
  }

  // Drags are bound to the pointer that started them. Without the id check a
  // second finger anywhere on screen would drive whatever handle is being dragged.
  function dragWindow(start, onMove, onUp) {
    var id = start && start.pointerId;
    function mv(e) { if (e.pointerId === id) onMove(e); }
    function up(e) {
      if (e.pointerId !== id) return;
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (onUp) onUp(e);
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- render

  function chipButton(label, active, onClick, extra) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (extra && extra.on) b.dataset.on = '1';
    if (extra && extra.font) b.style.fontFamily = '"' + extra.font + '", sans-serif';
    if (extra && extra.disabled) { b.disabled = true; b.title = extra.title || ''; }
    b.addEventListener('click', onClick);
    return b;
  }
  function fill(node, items) {
    node.textContent = '';
    items.forEach(function (n) { node.appendChild(n); });
  }

  function renderClock() {
    var clip = cur();
    el.clock.textContent = clip
      ? fmt(seqOffset(clip.id) + clamp(state.time - (clip.trimStart || 0), 0, span(clip))) + ' / ' + fmt(seqTotal())
      : '0:00.0 / 0:00.0';
  }

  function renderRail() {
    var rail = el.rail;
    Array.prototype.slice.call(rail.querySelectorAll('.clip')).forEach(function (n) { n.remove(); });
    state.clips.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'clip';
      b.setAttribute('aria-pressed', c.id === state.sel ? 'true' : 'false');
      b.innerHTML =
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="thumb"></span>' +
        '<span class="meta"><span class="nm"></span><span class="dur"></span></span>';
      var th = b.querySelector('.thumb');
      if (c.thumb) th.style.backgroundImage = 'url(' + c.thumb + ')';
      else th.textContent = 'loading…';
      b.querySelector('.nm').textContent = c.name;
      b.querySelector('.dur').textContent = c.duration ? fmt(span(c)) : '…';
      b.addEventListener('click', function () { selectClip(c.id, { play: false }); });
      rail.appendChild(b);
    });
  }

  function renderTimeline() {
    var tl = el.timeline;
    Array.prototype.slice.call(tl.querySelectorAll('.seg-clip')).forEach(function (n) { n.remove(); });
    var total = seqTotal();
    state.clips.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'seg-clip';
      d.style.width = (span(c) / total * 100).toFixed(2) + '%';
      if (c.id === state.sel) d.dataset.sel = '1';
      if (c.thumb) d.style.backgroundImage = 'url(' + c.thumb + ')';
      d.innerHTML = '<span class="sd">' + fmt(span(c)) + '</span>';
      tl.insertBefore(d, el.playhead);
    });
    tl.setAttribute('aria-valuenow', String(Math.round(
      cur() ? (seqOffset(state.sel) + clamp(state.time - (cur().trimStart || 0), 0, span(cur()))) / total * 100 : 0
    )));
  }

  var fieldsSig = '';

  function renderPanes() {
    var clip = cur();
    var has = !!clip;
    var brand = state.brand;

    // --- style
    var tplDefs = (E && E.TEMPLATES) || {};
    fill(el.tplChips, Object.keys(tplDefs).map(function (id) {
      var layers = has ? layersOf(clip) : [];
      var on = layers.indexOf(id) >= 0;
      var focused = has && clip.template === id;
      return chipButton((on ? '● ' : '') + tplDefs[id].name, focused, function () {
        if (!clip) { toast('Add a clip first.'); return; }
        if (!on) { clip.templates = layers.concat([id]); clip.template = id; }
        else if (!focused) { clip.template = id; }
        else {
          var rest = layers.filter(function (x) { return x !== id; });
          if (!rest.length) { toast('A clip needs at least one layer.'); return; }
          clip.templates = rest; clip.template = rest[rest.length - 1];
        }
        if (clip.template === 'custom' && clip.custom.length) state.selBox = clip.custom[0].id;
        fieldsSig = '';
        render(); requestDraw();
      }, { on: on && !focused, disabled: !has });
    }));

    fill(el.bdChips, [['auto', 'Auto'], ['fade', 'Fade'], ['dim', 'Dim'], ['none', 'None']].map(function (p) {
      return chipButton(p[1], has && (clip.backdrop || 'auto') === p[0], function () {
        if (!clip) return;
        clip.backdrop = p[0]; render(); requestDraw();
      }, { disabled: !has });
    }));

    var bdOn = (function () {
      if (!has) return false;
      var bd = clip.backdrop || 'auto';
      if (bd === 'none') return false;
      if (bd !== 'auto') return true;
      return layersOf(clip).some(function (id) { return ((tplDefs[id] || {}).backdrop || 'none') !== 'none'; });
    })();
    el.bdOpacityRow.hidden = !bdOn;
    if (has && document.activeElement !== el.bdOpacity) el.bdOpacity.value = String(clip.backdropOpacity != null ? clip.backdropOpacity : 100);
    el.bdOpacityOut.textContent = el.bdOpacity.value + '%';

    el.rotateBtn.disabled = !has;
    el.rotateBtn.textContent = '⟳ Rotate' + (has && clip.rotate ? ' (' + clip.rotate * 90 + '°)' : '');
    var offs = has && clip.tplOffset && clip.tplOffset[clip.template];
    el.resetPosBtn.disabled = !(offs && (offs.x || offs.y));

    // --- text
    var isCustom = has && clip.template === 'custom';
    el.fieldsGrp.hidden = !has || isCustom;
    el.boxesGrp.hidden = !isCustom;
    el.fieldsLbl.textContent = has && tplDefs[clip.template] ? tplDefs[clip.template].name : 'Text';

    var sig = has ? clip.id + '|' + clip.template : '';
    if (!isCustom && has) {
      var defs = (tplDefs[clip.template] || {}).fields || [];
      if (sig !== fieldsSig) {
        fieldsSig = sig;
        el.fields.textContent = '';
        defs.forEach(function (f) {
          var lab = document.createElement('label');
          lab.className = 'field';
          var sp = document.createElement('span');
          sp.textContent = f.label;
          var inp = f.multi ? document.createElement('textarea') : document.createElement('input');
          if (!f.multi) inp.type = 'text';
          else inp.rows = 3;
          inp.dataset.fid = f.id;
          inp.addEventListener('input', function () {
            var c = cur(); if (!c) return;
            var byTpl = Object.assign({}, c.valsByTpl);
            byTpl[c.template] = Object.assign({}, valsFor(c), (function () { var o = {}; o[f.id] = inp.value; return o; })());
            c.valsByTpl = byTpl;
            requestDraw();
          });
          lab.appendChild(sp); lab.appendChild(inp);
          el.fields.appendChild(lab);
        });
      }
      var vals = valsFor(clip);
      Array.prototype.slice.call(el.fields.querySelectorAll('[data-fid]')).forEach(function (inp) {
        if (inp === document.activeElement) return;
        var v = vals[inp.dataset.fid];
        inp.value = v != null ? v : '';
      });
    } else if (!has) {
      fieldsSig = '';
      el.fields.textContent = '';
    }

    if (isCustom) {
      var boxes = clip.custom || [];
      var chips = boxes.map(function (b, i) {
        return chipButton((String(b.text || 'Text').split('\n')[0] || ('Text ' + (i + 1))).slice(0, 18),
          b.id === state.selBox, function () { state.selBox = b.id; render(); requestDraw(); });
      });
      var addBox = chipButton('+ Text box', false, function () {
        var b = newBox();
        b.y = 0.3 + 0.12 * (boxes.length % 5);
        clip.custom = boxes.concat([b]);
        state.selBox = b.id;
        render(); requestDraw();
      });
      addBox.style.borderStyle = 'dashed';
      addBox.style.color = brand.gold;
      addBox.style.borderColor = brand.gold;
      chips.push(addBox);
      fill(el.boxChips, chips);

      var sb = boxes.filter(function (b) { return b.id === state.selBox; })[0];
      el.boxEditor.hidden = !sb;
      if (sb) {
        if (document.activeElement !== el.boxText) el.boxText.value = sb.text || '';
        if (document.activeElement !== el.boxSize) el.boxSize.value = String(sb.size);
        el.boxSizeOut.textContent = String(sb.size);
        fill(el.boxFonts, FONTS_HEAD.concat(['Space Grotesk']).map(function (n) {
          return chipButton(n, sb.font === n, function () { sb.font = n; render(); requestDraw(); }, { font: n });
        }));
        fill(el.boxColors, ['#FFFFFF', brand.gold, brand.accent, brand.black].map(function (c) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'swatch';
          b.style.background = c;
          b.title = c;
          b.setAttribute('aria-label', 'Text colour ' + c);
          b.setAttribute('aria-pressed', sb.color === c ? 'true' : 'false');
          b.addEventListener('click', function () { sb.color = c; render(); requestDraw(); });
          return b;
        }));
      }
    }

    if (has) {
      if (document.activeElement !== el.tStart) el.tStart.value = String(clip.timing.start || 0);
      if (document.activeElement !== el.tEnd) el.tEnd.value = clip.timing.end != null ? String(clip.timing.end) : '';
    }
    el.tStart.disabled = el.tEnd.disabled = !has;
    fill(el.animChips, [['fade', 'Fade'], ['slide', 'Slide up'], ['none', 'Cut']].map(function (p) {
      return chipButton(p[1], has && clip.timing.anim === p[0], function () {
        clip.timing.anim = p[0]; render(); requestDraw();
      }, { disabled: !has });
    }));
    el.dupNext.disabled = !has || idxOf(state.sel) >= state.clips.length - 1;

    // --- trim
    var dur = has ? (clip.duration || 0) : 0;
    var st = has ? (clip.trimStart || 0) : 0;
    var en = has && clip.trimEnd && clip.trimEnd > st ? clip.trimEnd : dur;
    var lp = dur ? (st / dur) * 100 : 0;
    var rp = dur ? (en / dur) * 100 : 100;
    el.trimLbl.textContent = has ? 'Keep ' + fmt(st) + ' → ' + fmt(en) + '  (' + fmt(Math.max(0, en - st)) + ')' : 'Keep';
    el.trimbar.style.backgroundImage = has && clip.thumb ? 'url(' + clip.thumb + ')' : 'none';
    el.cutL.style.width = lp + '%';
    el.cutR.style.width = (100 - rp) + '%';
    el.keepBox.style.left = lp + '%';
    el.keepBox.style.width = Math.max(0, rp - lp) + '%';
    // clamp so the grab handles never slide half-way out of the (overflow-hidden) bar
    el.trimL.style.left = 'clamp(0px, calc(' + lp + '% - 20px), calc(100% - 40px))';
    el.trimR.style.left = 'clamp(0px, calc(' + rp + '% - 20px), calc(100% - 40px))';
    [el.trimL, el.trimR, el.setStart, el.setEnd, el.splitBtn, el.resetTrim, el.removeClip].forEach(function (b) { b.disabled = !has; });
    el.moveL.disabled = !has || idxOf(state.sel) <= 0;
    el.moveR.disabled = !has || idxOf(state.sel) >= state.clips.length - 1;

    // --- export
    fill(el.scopeChips, [['one', 'This clip'], ['all', state.clips.length > 1 ? 'Join all ' + state.clips.length : 'Join all']].map(function (p) {
      return chipButton(p[1], state.scope === p[0], function () { state.scope = p[0]; render(); },
        { disabled: p[0] === 'all' && state.clips.length < 2 });
    }));
    var defFormat = defaultFormat();
    fill(el.formatChips, ['mp4', 'webm-vp9', 'webm-vp8'].map(function (id) {
      var ok = !!(E && E.supportedMime(id));
      var label = id === 'mp4' ? 'MP4' : (id === 'webm-vp9' ? 'WebM VP9' : 'WebM VP8');
      return chipButton(label, (state.format || defFormat) === id, function () { state.format = id; render(); },
        { disabled: !ok, title: ok ? '' : 'This browser cannot record ' + label });
    }));
    fill(el.qualityChips, [['standard', 'Standard'], ['high', 'High'], ['max', 'Max']].map(function (p) {
      return chipButton(p[1], state.quality === p[0], function () { state.quality = p[0]; render(); });
    }));
    el.exportBtn.disabled = !has || state.exporting || !defFormat;
    el.exportBtn.textContent = state.exporting ? 'EXPORTING…' : (state.scope === 'all' && state.clips.length > 1 ? 'EXPORT ' + state.clips.length + ' CLIPS' : 'EXPORT CLIP');
    el.exportProgress.hidden = !state.exporting;
    el.exportBar.style.width = state.pct + '%';
    el.exportPctText.textContent = 'Burning in text… ' + state.pct + '%';
    el.exportDl.hidden = !state.exportUrl || state.exporting;
    el.saveHint.hidden = el.exportDl.hidden;
    if (state.exportUrl) {
      el.exportDl.href = state.exportUrl;
      el.exportDl.download = state.exportName;
      el.exportDl.textContent = '↓ Save ' + state.exportName + ' (' + state.exportSize + ')';
      el.saveHint.textContent = isIOS()
        ? 'On iPhone this saves into Files. To post it, open Files → Downloads, tap the video, then Share → Save Video to get it into Photos.'
        : 'Saves to your downloads folder.';
    }
    el.formatNote.textContent = formatNote();

    // --- brand
    [['cBlack', 'black'], ['cGold', 'gold'], ['cAccent', 'accent']].forEach(function (p) {
      if (document.activeElement !== el[p[0]]) el[p[0]].value = brand[p[1]];
    });
    if (document.activeElement !== el.bHandles) el.bHandles.value = brand.handles;
    fill(el.headFonts, FONTS_HEAD.map(function (n) {
      return chipButton(n, brand.headFont === n, function () { setBrand({ headFont: n }); }, { font: n });
    }));
    fill(el.bodyFonts, FONTS_BODY.map(function (n) {
      return chipButton(n, brand.bodyFont === n, function () { setBrand({ bodyFont: n }); }, { font: n });
    }));
  }

  function defaultFormat() {
    if (!E) return null;
    if (state.format && E.supportedMime(state.format)) return state.format;
    return ['mp4', 'webm-vp9', 'webm-vp8'].filter(function (f) { return !!E.supportedMime(f); })[0] || null;
  }
  function formatNote() {
    if (!E) return '';
    if (!window.MediaRecorder || !document.createElement('canvas').captureStream) {
      return 'This browser cannot record video. On iPhone, update to iOS 15 or later, or open this page in Safari or Chrome.';
    }
    if (E.supportedMime('mp4')) {
      return 'MP4 (H.264) uploads straight to Instagram and TikTok. Export runs in real time, so a 30s clip takes about 30s — keep this tab in front.';
    }
    return 'This browser can only record WebM, which Instagram and TikTok may reject. Export from Chrome, or from Safari on iOS 17.4+, to get MP4.';
  }

  function setBrand(patch) {
    state.brand = Object.assign({}, state.brand, patch);
    saveBrand(state.brand);
    render();
    requestDraw();
  }

  function render() {
    var has = !!cur();
    el.empty.hidden = has;
    el.frame.style.visibility = 'visible';
    el.playBtn.disabled = !has;
    el.playhead.hidden = !has;
    el.playBtn.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
    renderClock();
    renderRail();
    renderTimeline();
    renderPanes();
    Array.prototype.slice.call(el.tabbar.querySelectorAll('button')).forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === state.tab ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------------- tabs

  function openTab(name) {
    var same = state.tab === name;
    state.tab = same ? null : name;
    el.sheet.dataset.open = state.tab ? '1' : '0';
    el.app.dataset.sheet = state.tab ? '1' : '0';
    el.sheet.dataset.tall = '0';
    el.sheetGrow.setAttribute('aria-pressed', 'false');
    el.sheetGrow.innerHTML = '&#9650;';
    Array.prototype.slice.call(el.sheet.querySelectorAll('.pane')).forEach(function (p) {
      p.dataset.active = p.dataset.pane === state.tab ? '1' : '0';
    });
    if (state.tab) el.sheetTitle.textContent = { style: 'Style', text: 'Text', trim: 'Trim', export: 'Export', brand: 'Brand kit' }[state.tab] || '';
    render();
    // Let the flex layout settle, then re-fit the preview into whatever height is left.
    requestAnimationFrame(sizeStage);
  }

  // ---------------------------------------------------------------- export

  function clearExport() {
    if (state.exportUrl) { URL.revokeObjectURL(state.exportUrl); }
    state.exportUrl = null; state.exportName = ''; state.exportSize = '';
  }

  function fileSize(bytes) {
    return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' KB';
  }

  function doExport() {
    var clip = cur();
    if (!clip || !E || state.exporting) return;
    var fmtId = defaultFormat();
    if (!fmtId) { toast('This browser cannot record video.', 'err'); return; }
    video.pause();
    clearExport();
    state.exporting = true; state.pct = 0;
    render();

    var all = state.scope === 'all' && state.clips.length > 1;
    var items = (all ? state.clips : [clip]).map(function (c) { return { src: c.url, clip: resolvedClip(c) }; });
    var expected = items.reduce(function (a, it) {
      var c = it.clip, st = c.trimStart || 0;
      var en = (c.trimEnd && c.trimEnd > st) ? c.trimEnd : (c.duration || 0);
      return a + Math.max(0.1, en - st);
    }, 0);

    // Recording is real time and frame-driven, so a backgrounded tab or a sleeping
    // screen silently truncates the file. Hold the screen awake and, if we lost
    // visibility anyway, say so rather than handing over a broken clip.
    var wentHidden = document.visibilityState === 'hidden';
    var onVis = function () { if (document.visibilityState === 'hidden') wentHidden = true; };
    document.addEventListener('visibilitychange', onVis);

    var lock = null;
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {});
    }
    var finishUp = function () {
      document.removeEventListener('visibilitychange', onVis);
      if (lock) { try { lock.release(); } catch (e) {} lock = null; }
    };

    E.exportSequence({
      items: items, brand: state.brand, aspect: state.aspect,
      quality: state.quality, format: fmtId,
      onProgress: function (p) {
        var pct = Math.round(p * 100);
        if (pct !== state.pct) {
          state.pct = pct;
          el.exportBar.style.width = pct + '%';
          el.exportPctText.textContent = 'Burning in text… ' + pct + '%';
        }
      }
    }).then(function (res) {
      finishUp();
      state.exporting = false;
      state.exportUrl = URL.createObjectURL(res.blob);
      var base = all ? ('joined-' + state.clips.length + '-clips') : String(clip.name).replace(/\.[^.]+$/, '') + '-captioned';
      state.exportName = base.replace(/[^\w\-. ]+/g, '_') + '.' + (res.ext || 'webm');
      state.exportSize = fileSize(res.blob.size);
      render();
      // ~40KB per second is far below anything a real 1080p recording produces.
      var starved = res.blob.size < expected * 40000;
      if (wentHidden || starved) {
        toast('That export looks incomplete — recording stops when the tab is in the background or the screen sleeps. Check it, and re-export with this tab in front if it is short.', 'err');
      } else {
        toast('Done. Tap Save to keep it.');
      }
    }).catch(function (err) {
      finishUp();
      state.exporting = false;
      render();
      toast('Export failed: ' + ((err && err.message) || err), 'err');
    });
  }

  // ---------------------------------------------------------------- events

  el.addBtn.addEventListener('click', function () { el.fileInput.click(); });
  el.emptyAdd.addEventListener('click', function () { el.fileInput.click(); });
  el.fileInput.addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });

  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); el.app.classList.add('dropping'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); if (t === 'drop' || e.relatedTarget === null) el.app.classList.remove('dropping'); });
  });
  document.addEventListener('drop', function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });

  el.playBtn.addEventListener('click', togglePlay);
  video.addEventListener('play', function () { state.playing = true; render(); schedule(); });
  video.addEventListener('pause', function () { state.playing = false; render(); requestDraw(); });
  video.addEventListener('seeked', requestDraw);
  video.addEventListener('loadeddata', requestDraw);

  el.aspectSeg.textContent = '';
  ['9:16', '1:1', '16:9'].forEach(function (a) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = a;
    b.setAttribute('aria-pressed', state.aspect === a ? 'true' : 'false');
    b.addEventListener('click', function () {
      state.aspect = a;
      Array.prototype.slice.call(el.aspectSeg.children).forEach(function (x) {
        x.setAttribute('aria-pressed', x.textContent === a ? 'true' : 'false');
      });
      sizeStage();
    });
    el.aspectSeg.appendChild(b);
  });

  Array.prototype.slice.call(el.tabbar.querySelectorAll('button')).forEach(function (b) {
    b.addEventListener('click', function () { openTab(b.dataset.tab); });
  });
  el.sheetClose.addEventListener('click', function () { openTab(state.tab); });
  el.sheetGrow.addEventListener('click', function () {
    var tall = el.sheet.dataset.tall !== '1';
    el.sheet.dataset.tall = tall ? '1' : '0';
    el.sheetGrow.setAttribute('aria-pressed', tall ? 'true' : 'false');
    el.sheetGrow.innerHTML = tall ? '&#9660;' : '&#9650;';
    el.sheetGrow.setAttribute('aria-label', tall ? 'Make this panel shorter' : 'Make this panel taller');
    requestAnimationFrame(sizeStage);
  });

  // timeline scrub
  el.timeline.addEventListener('pointerdown', function (e) {
    if (!cur()) return;
    e.preventDefault();
    var r = el.timeline.getBoundingClientRect();
    var frac = function (ev) { return clamp((ev.clientX - r.left) / r.width, 0, 1); };
    var sx = e.clientX, moved = false;
    var startFrac = frac(e);
    dragWindow(e, function (ev) {
      if (!moved && Math.abs(ev.clientX - sx) > 6) moved = true;
      if (moved) seekSeqFrac(frac(ev));
    }, function () {
      if (moved) return;
      // A clean tap on another clip selects it; on the current clip it seeks.
      var tapped = clipAtFrac(startFrac);
      if (tapped && tapped.id !== state.sel) selectClip(tapped.id, { play: false });
      else seekSeqFrac(startFrac);
    });
  });

  function clipAtFrac(frac) {
    var t = clamp(frac, 0, 1) * seqTotal();
    for (var i = 0; i < state.clips.length; i++) {
      var sp = span(state.clips[i]);
      if (t <= sp || i === state.clips.length - 1) return state.clips[i];
      t -= sp;
    }
    return null;
  }
  el.timeline.addEventListener('keydown', function (e) {
    if (!cur()) return;
    var step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSeq(step); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSeq(-step); }
  });
  function nudgeSeq(d) {
    var clip = cur(); if (!clip) return;
    var pos = (seqOffset(clip.id) + clamp(video.currentTime - (clip.trimStart || 0), 0, span(clip))) / seqTotal();
    seekSeqFrac(pos + d);
  }

  // canvas: drag text / tap to play
  canvas.addEventListener('pointerdown', function (e) {
    var clip = cur();
    if (!clip) { el.fileInput.click(); return; }
    var r = canvas.getBoundingClientRect();
    var moved = false;
    var sx = e.clientX, sy = e.clientY;

    if (clip.template !== 'custom') {
      e.preventDefault();
      var tpl = clip.template;
      var start = (clip.tplOffset || {})[tpl] || { x: 0, y: 0 };
      dragWindow(e, function (ev) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) moved = true;
        if (!moved) return;
        var t = Object.assign({}, clip.tplOffset);
        t[tpl] = {
          x: clamp(start.x + (ev.clientX - sx) / r.width, -0.6, 0.6),
          y: clamp(start.y + (ev.clientY - sy) / r.height, -0.85, 0.85)
        };
        clip.tplOffset = t;
        requestDraw();
      }, function () { if (!moved) togglePlay(); else render(); });
      return;
    }

    var fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    var hit = null;
    var ids = Object.keys(hitRects);
    for (var i = ids.length - 1; i >= 0; i--) {
      var b = hitRects[ids[i]];
      var pad = 10; // finger slop, in canvas px
      if (fx * canvas.width >= b.x - pad && fx * canvas.width <= b.x + b.w + pad &&
          fy * canvas.height >= b.y - pad && fy * canvas.height <= b.y + b.h + pad) { hit = ids[i]; break; }
    }
    if (!hit) { togglePlay(); return; }
    e.preventDefault();
    state.selBox = hit;
    render();
    var box = clip.custom.filter(function (x) { return x.id === hit; })[0];
    if (!box) return;
    var dx = box.x - fx, dy = box.y - fy;
    dragWindow(e, function (ev) {
      box.x = clamp((ev.clientX - r.left) / r.width + dx, 0.04, 0.96);
      box.y = clamp((ev.clientY - r.top) / r.height + dy, 0.06, 0.96);
      requestDraw();
    });
  });

  // style pane
  el.bdOpacity.addEventListener('input', function () {
    var c = cur(); if (!c) return;
    c.backdropOpacity = Number(el.bdOpacity.value);
    el.bdOpacityOut.textContent = el.bdOpacity.value + '%';
    requestDraw();
  });
  el.rotateBtn.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    c.rotate = ((c.rotate || 0) + 1) % 4;
    render(); requestDraw();
  });
  el.resetPosBtn.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    var t = Object.assign({}, c.tplOffset);
    delete t[c.template];
    c.tplOffset = t;
    render(); requestDraw();
  });

  // text pane
  el.boxText.addEventListener('input', function () {
    var c = cur(); if (!c) return;
    var b = (c.custom || []).filter(function (x) { return x.id === state.selBox; })[0];
    if (b) { b.text = el.boxText.value; requestDraw(); }
  });
  el.boxSize.addEventListener('input', function () {
    var c = cur(); if (!c) return;
    var b = (c.custom || []).filter(function (x) { return x.id === state.selBox; })[0];
    if (b) { b.size = Number(el.boxSize.value); el.boxSizeOut.textContent = el.boxSize.value; requestDraw(); }
  });
  el.delBox.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    var rest = (c.custom || []).filter(function (x) { return x.id !== state.selBox; });
    c.custom = rest;
    state.selBox = rest.length ? rest[0].id : null;
    render(); requestDraw();
  });
  el.tStart.addEventListener('input', function () {
    var c = cur(); if (!c) return;
    c.timing.start = Math.max(0, Number(el.tStart.value) || 0);
    requestDraw();
  });
  el.tEnd.addEventListener('input', function () {
    var c = cur(); if (!c) return;
    c.timing.end = el.tEnd.value === '' ? null : Math.max(0, Number(el.tEnd.value) || 0);
    requestDraw();
  });
  el.dupNext.addEventListener('click', function () {
    var i = idxOf(state.sel);
    if (i < 0 || i + 1 >= state.clips.length) return;
    var src = state.clips[i], next = state.clips[i + 1];
    next.template = src.template;
    next.templates = layersOf(src).slice();
    next.tplOffset = JSON.parse(JSON.stringify(src.tplOffset || {}));
    next.valsByTpl = JSON.parse(JSON.stringify(src.valsByTpl || {}));
    next.timing = Object.assign({}, src.timing);
    next.backdrop = src.backdrop;
    next.backdropOpacity = src.backdropOpacity;
    next.custom = src.custom.map(function (b) { return Object.assign({}, b, { id: uid() }); });
    fieldsSig = '';
    selectClip(next.id, { play: false });
    toast('Styling copied to clip ' + (i + 2) + '.');
  });

  // trim pane
  function trimDrag(which) {
    return function (e) {
      var c = cur(); if (!c || !c.duration) return;
      e.preventDefault(); e.stopPropagation();
      var r = el.trimbar.getBoundingClientRect();
      dragWindow(e, function (ev) {
        var t = clamp((ev.clientX - r.left) / r.width, 0, 1) * c.duration;
        var st = c.trimStart || 0;
        var en = (c.trimEnd && c.trimEnd > st) ? c.trimEnd : c.duration;
        if (which === 'L') c.trimStart = clamp(t, 0, en - 0.2);
        else c.trimEnd = clamp(t, st + 0.2, c.duration);
        render();
      });
    };
  }
  el.trimL.addEventListener('pointerdown', trimDrag('L'));
  el.trimR.addEventListener('pointerdown', trimDrag('R'));
  el.trimbar.addEventListener('pointerdown', function (e) {
    var c = cur(); if (!c || !c.duration) return;
    if (e.target === el.trimL || e.target === el.trimR || e.target.closest('.h')) return;
    var r = el.trimbar.getBoundingClientRect();
    var seek = function (ev) {
      video.currentTime = clamp((ev.clientX - r.left) / r.width, 0, 1) * c.duration;
      state.time = video.currentTime;
      renderClock();
      requestDraw();
    };
    seek(e);
    dragWindow(e, seek);
  });
  el.setStart.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    var en = (c.trimEnd && c.trimEnd > 0) ? c.trimEnd : c.duration;
    c.trimStart = clamp(video.currentTime, 0, Math.max(0, en - 0.2));
    render();
  });
  el.setEnd.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    c.trimEnd = clamp(video.currentTime, (c.trimStart || 0) + 0.2, c.duration || video.currentTime);
    render();
  });
  el.resetTrim.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    c.trimStart = 0; c.trimEnd = 0;
    render();
  });
  el.splitBtn.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    var dur = c.duration || 0, t = video.currentTime;
    var st = c.trimStart || 0;
    var en = (c.trimEnd && c.trimEnd > st) ? c.trimEnd : dur;
    if (!dur || t < st + 0.2 || t > en - 0.2) { toast('Scrub to the moment you want to cut, then hit Split.', 'err'); return; }
    var copy = JSON.parse(JSON.stringify(c));
    copy.id = uid();
    copy.name = String(c.name).replace(/\.[^.]+$/, '') + ' ✂2';
    copy.trimStart = t;
    copy.trimEnd = en === dur ? 0 : en;
    (copy.custom || []).forEach(function (b) { b.id = uid(); });
    c.trimEnd = t;
    var arr = state.clips.slice();
    arr.splice(idxOf(c.id) + 1, 0, copy);
    state.clips = arr;
    render();
    toast('Split into two clips.');
  });
  el.moveL.addEventListener('click', function () { moveClip(-1); });
  el.moveR.addEventListener('click', function () { moveClip(1); });
  el.removeClip.addEventListener('click', function () {
    var c = cur(); if (!c) return;
    removeClip(c.id);
    toast('Clip removed.');
  });

  // export pane
  el.exportBtn.addEventListener('click', doExport);

  // brand pane
  el.cBlack.addEventListener('input', function () { setBrand({ black: el.cBlack.value }); });
  el.cGold.addEventListener('input', function () { setBrand({ gold: el.cGold.value }); });
  el.cAccent.addEventListener('input', function () { setBrand({ accent: el.cAccent.value }); });
  el.bHandles.addEventListener('input', function () { setBrand({ handles: el.bHandles.value }); });
  el.resetBrand.addEventListener('click', function () {
    state.brand = Object.assign({}, DEF_BRAND);
    saveBrand(state.brand);
    render(); requestDraw();
    toast('Brand kit reset.');
  });

  // keyboard (desktop)
  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === '[') { el.setStart.click(); }
    else if (e.key === ']') { el.setEnd.click(); }
  });

  // layout
  var resizeTimer = 0;
  function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(sizeStage, 60); }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', function () { setTimeout(sizeStage, 220); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(sizeStage).observe(el.stage);

  window.matchMedia('(min-width: 900px)').addEventListener('change', function (m) {
    if (m.matches) {
      el.sheet.dataset.open = '1';
      Array.prototype.slice.call(el.sheet.querySelectorAll('.pane')).forEach(function (p) { p.dataset.active = '1'; });
    } else {
      el.sheet.dataset.open = state.tab ? '1' : '0';
    }
    sizeStage();
  });

  // ---------------------------------------------------------------- boot

  if (!E) {
    document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif;color:#F4EEE0">Could not load the caption engine. Try a hard refresh.</p>';
    return;
  }

  if (document.fonts && document.fonts.load) {
    ['400 60px "Anton"', '400 60px "Archivo Black"', '600 60px "Oswald"', '700 60px "Space Grotesk"', '400 30px "Space Grotesk"']
      .forEach(function (f) { document.fonts.load(f).catch(function () {}); });
    document.fonts.ready.then(function () { E.clearLayoutCache && E.clearLayoutCache(); requestDraw(); });
  }

  if (isDesktop()) {
    el.sheet.dataset.open = '1';
    Array.prototype.slice.call(el.sheet.querySelectorAll('.pane')).forEach(function (p) { p.dataset.active = '1'; });
  }

  render();
  sizeStage();
  requestDraw();
  setTimeout(sizeStage, 300);
})();
