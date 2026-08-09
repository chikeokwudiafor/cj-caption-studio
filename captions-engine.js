/* Caption engine: canvas text templates + video export. Global: window.CaptionEngine */
(function () {
  const RES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
  const WEIGHTS = { 'Anton': 400, 'Archivo Black': 400, 'Oswald': 600, 'Space Grotesk': 700 };
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const easeOut = p => 1 - Math.pow(1 - clamp01(p), 3);
  const fontStr = (name, px) => (WEIGHTS[name] || 700) + ' ' + px + 'px "' + name + '"';

  function layoutText(ctx, text, maxW, size, font, opt) {
    opt = opt || {};
    const maxLines = opt.maxLines || 4, minSize = opt.minSize || 22, lh = opt.lineHeight || 1.04;
    let s = size;
    for (;;) {
      ctx.font = fontStr(font, s);
      const lines = [];
      String(text || '').split('\n').forEach(par => {
        const words = par.split(/\s+/).filter(Boolean);
        let cur = '';
        for (const w of words) {
          const test = cur ? cur + ' ' + w : w;
          if (ctx.measureText(test).width <= maxW || !cur) cur = test; else { lines.push(cur); cur = w; }
        }
        if (cur || !words.length) lines.push(cur);
      });
      const tooWide = lines.some(l => ctx.measureText(l).width > maxW);
      if ((lines.length <= maxLines && !tooWide) || s <= minSize)
        return { lines, size: s, lineH: s * lh, height: lines.length * s * lh };
      s = Math.floor(s * 0.92);
    }
  }
  function drawLines(ctx, lay, x, y, font, color, align) {
    ctx.font = fontStr(font, lay.size); ctx.fillStyle = color;
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    lay.lines.forEach((l, i) => ctx.fillText(l, x, y + lay.size * 0.86 + i * lay.lineH));
  }
  function scrim(ctx, W, H, from, to, a) {
    const g = ctx.createLinearGradient(0, H * from, 0, H * to);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,' + a + ')');
    ctx.fillStyle = g; ctx.fillRect(0, H * from, W, H * (to - from));
  }
  function watermark(ctx, W, H, u, brand, alpha) {
    ctx.save(); ctx.globalAlpha *= alpha;
    ctx.font = fontStr(brand.bodyFont, 30 * u); ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    const m = 44 * u;
    ctx.fillStyle = brand.gold; ctx.beginPath();
    ctx.arc(W - m - ctx.measureText(brand.handles).width - 22 * u, m - 9 * u, 7 * u, 0, 7); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.fillText(brand.handles, W - m, m);
    ctx.restore();
  }
  function ent(ctx, lt, rise, u) {
    const p = easeOut(lt / 0.55);
    ctx.globalAlpha *= clamp01(lt / 0.35);
    ctx.translate(0, (1 - p) * rise * u);
    return lt > -0.001;
  }

  const TEMPLATES = {
    promo: {
      name: 'Event promo', backdrop: 'fade',
      fields: [
        { id: 'title', label: 'Event title', def: 'KULTUR SATURDAYS', multi: false },
        { id: 'dateline', label: 'Date + venue', def: 'SAT AUG 22 · SPIRIT HALL · LAWRENCEVILLE', multi: false },
        { id: 'lineup', label: 'Lineup (one per line)', def: 'DJ SELECTA ROY · KWEEN B\nJUJU SOUNDS · MADDY FRESH', multi: true },
        { id: 'cta', label: 'Ticket CTA', def: 'TICKETS IN BIO', multi: false }
      ],
      render(ctx, env) {
        const { W, H, u, brand, vals, t } = env;
        const maxW = W * 0.84, x = W / 2;
        const title = layoutText(ctx, (vals.title || '').toUpperCase(), maxW, 150 * u, brand.headFont, { maxLines: 3, lineHeight: 0.98 });
        const date = layoutText(ctx, vals.dateline || '', maxW, 42 * u, brand.bodyFont, { maxLines: 2 });
        const lineup = layoutText(ctx, vals.lineup || '', maxW, 38 * u, brand.bodyFont, { maxLines: 5, lineHeight: 1.3 });
        const ctaTxt = (vals.cta || '').toUpperCase();
        ctx.font = fontStr(brand.bodyFont, 34 * u);
        const ctaW = ctx.measureText(ctaTxt).width + 76 * u, ctaH = 84 * u;
        const gap = 34 * u;
        const total = title.height + gap + date.height + gap * 0.7 + lineup.height + gap + ctaH;
        let y = H - H * 0.07 - total;
        const blocks = [
          () => drawLines(ctx, title, x, y, brand.headFont, '#FFFFFF', 'center'),
          () => drawLines(ctx, date, x, y, brand.bodyFont, brand.gold, 'center'),
          () => drawLines(ctx, lineup, x, y, brand.bodyFont, 'rgba(255,255,255,0.92)', 'center'),
          () => {
            ctx.fillStyle = brand.accent;
            const r = ctaH / 2;
            ctx.beginPath(); ctx.roundRect(x - ctaW / 2, y, ctaW, ctaH, r); ctx.fill();
            ctx.fillStyle = brand.black; ctx.textAlign = 'center'; ctx.font = fontStr(brand.bodyFont, 34 * u);
            ctx.fillText(ctaTxt, x, y + ctaH * 0.66);
          }
        ];
        const heights = [title.height + gap, date.height + gap * 0.7, lineup.height + gap, ctaH];
        blocks.forEach((draw, i) => {
          ctx.save();
          if (ent(ctx, t - 0.12 - i * 0.16, 46, u)) draw();
          ctx.restore();
          y += heights[i];
        });
      }
    },
    lineup: {
      name: 'Lineup card', backdrop: 'dim',
      fields: [
        { id: 'eyebrow', label: 'Eyebrow', def: 'FEATURING', multi: false },
        { id: 'names', label: 'Names (one per line)', def: 'DJ SELECTA ROY\nKWEEN B\nJUJU SOUNDS\nMADDY FRESH', multi: true },
        { id: 'footer', label: 'Footer line', def: 'SAT AUG 22 · DOORS 10PM', multi: false }
      ],
      render(ctx, env) {
        const { W, H, u, brand, vals, t } = env;
        const names = String(vals.names || '').split('\n').map(s => s.trim()).filter(Boolean);
        const x = W / 2, size = Math.min(110 * u, (H * 0.5) / Math.max(names.length, 1) / 1.12);
        const lh = size * 1.18;
        const blockH = 70 * u + names.length * lh + 90 * u;
        let y = (H - blockH) / 2;
        ctx.save();
        if (ent(ctx, t - 0.1, 30, u)) {
          ctx.font = fontStr(brand.bodyFont, 34 * u); ctx.fillStyle = brand.gold;
          ctx.textAlign = 'center'; ctx.letterSpacing = (10 * u) + 'px';
          ctx.fillText((vals.eyebrow || '').toUpperCase(), x, y + 34 * u);
          ctx.letterSpacing = '0px';
        }
        ctx.restore();
        y += 90 * u;
        names.forEach((n, i) => {
          ctx.save();
          if (ent(ctx, t - 0.45 - i * 0.45, 60, u)) {
            const lay = layoutText(ctx, n.toUpperCase(), W * 0.86, size, brand.headFont, { maxLines: 1 });
            drawLines(ctx, lay, x, y, brand.headFont, i % 2 ? brand.gold : '#FFFFFF', 'center');
          }
          ctx.restore();
          y += lh;
        });
        ctx.save();
        if (ent(ctx, t - 0.45 - names.length * 0.45, 30, u)) {
          ctx.font = fontStr(brand.bodyFont, 32 * u); ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.textAlign = 'center';
          ctx.fillText(vals.footer || '', x, y + 50 * u);
        }
        ctx.restore();
      }
    },
    recap: {
      name: 'Recap', backdrop: 'none',
      fields: [
        { id: 'caption', label: 'Caption', def: 'NO KULTUR. NO PARTY.', multi: false }
      ],
      render(ctx, env) {
        const { W, H, u, brand, vals, t } = env;
        watermark(ctx, W, H, u, brand, 0.85 * clamp01(t / 0.4));
        const txt = (vals.caption || '').toUpperCase();
        const lay = layoutText(ctx, txt, W * 0.78, 74 * u, brand.headFont, { maxLines: 2, lineHeight: 1.32 });
        ctx.save();
        const p = easeOut((t - 0.15) / 0.5);
        ctx.globalAlpha *= clamp01((t - 0.15) / 0.3);
        ctx.translate(W / 2, H * 0.74 + (1 - p) * 60 * u);
        ctx.rotate(-2 * Math.PI / 180);
        ctx.font = fontStr(brand.headFont, lay.size);
        lay.lines.forEach((l, i) => {
          const w = ctx.measureText(l).width, bh = lay.size * 1.28;
          const by = i * lay.lineH - lay.size;
          ctx.fillStyle = brand.accent;
          ctx.fillRect(-w / 2 - 26 * u, by, w + 52 * u, bh);
          ctx.fillStyle = brand.black; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(l, 0, by + lay.size * 0.98);
        });
        ctx.restore();
      }
    },
    announce: {
      name: 'Announcement', backdrop: 'dim',
      fields: [
        { id: 'headline', label: 'Headline', def: 'AMAPIANO NIGHT IS BACK', multi: false },
        { id: 'subline', label: 'Subline', def: 'FRI SEP 4 · TICKETS IN BIO', multi: false }
      ],
      render(ctx, env) {
        const { W, H, u, brand, vals, t } = env;
        const x = W / 2;
        const lay = layoutText(ctx, (vals.headline || '').toUpperCase(), W * 0.82, 128 * u, brand.headFont, { maxLines: 3, lineHeight: 1.04 });
        const y = H / 2 - (lay.height + 120 * u) / 2;
        ctx.save();
        if (ent(ctx, t - 0.1, 40, u)) drawLines(ctx, lay, x, y, brand.headFont, '#FFFFFF', 'center');
        ctx.restore();
        const last = lay.lines[lay.lines.length - 1] || '';
        ctx.font = fontStr(brand.headFont, lay.size);
        const lw = Math.min(ctx.measureText(last).width * 1.06, W * 0.84);
        const uy = y + lay.height + 8 * u;
        const grow = easeOut((t - 0.55) / 0.45);
        if (grow > 0) {
          ctx.save(); ctx.globalAlpha *= clamp01((t - 0.5) / 0.2);
          ctx.fillStyle = brand.accent;
          ctx.fillRect(x - (lw * grow) / 2, uy, lw * grow, 16 * u);
          ctx.restore();
        }
        ctx.save();
        if (ent(ctx, t - 0.8, 30, u)) {
          ctx.font = fontStr(brand.bodyFont, 40 * u); ctx.fillStyle = brand.gold; ctx.textAlign = 'center';
          ctx.fillText(vals.subline || '', x, uy + 96 * u);
        }
        ctx.restore();
      }
    },
    custom: {
      name: 'Custom', backdrop: 'none',
      fields: [],
      render(ctx, env) {
        const { W, H, u, brand, t, clip, opts } = env;
        const rects = {};
        (clip.custom || []).forEach((b, i) => {
          ctx.save();
          if (ent(ctx, t - 0.1 - i * 0.12, 24, u)) {
            const size = b.size * u;
            const lay = layoutText(ctx, b.text, W * 0.92, size, b.font, { maxLines: 6, minSize: 10, lineHeight: 1.08 });
            const x = b.x * W, y = b.y * H - lay.height / 2;
            let maxLW = 0;
            ctx.font = fontStr(b.font, lay.size);
            lay.lines.forEach(l => { maxLW = Math.max(maxLW, ctx.measureText(l).width); });
            drawLines(ctx, lay, x, y, b.font, b.color, 'center');
            rects[b.id] = { x: x - maxLW / 2 - 14 * u, y: y - 10 * u, w: maxLW + 28 * u, h: lay.height + 20 * u };
            if (opts && opts.editing && opts.selectedBox === b.id) {
              const r = rects[b.id];
              ctx.globalAlpha = 1; ctx.strokeStyle = brand.gold; ctx.setLineDash([10 * u, 8 * u]); ctx.lineWidth = 3 * u;
              ctx.strokeRect(r.x, r.y, r.w, r.h);
            }
          }
          ctx.restore();
        });
        if (opts) opts.rectsOut = rects;
      }
    }
  };

  function renderOverlay(ctx, W, H, clip, brand, time, opts) {
    const tpl = TEMPLATES[clip.template]; if (!tpl) return;
    const off = (clip.tplOffset && clip.tplOffset[clip.template]) || null;
    const timing = clip.timing || { start: 0, end: null, anim: 'fade' };
    const t = time - (timing.start || 0);
    if (t < 0) { if (opts) opts.rectsOut = {}; return; }
    const endA = timing.end != null && timing.end > 0 ? clamp01((timing.end - time) / 0.35) : 1;
    if (endA <= 0) { if (opts) opts.rectsOut = {}; return; }
    const u = Math.min(W, H) / 1080;
    ctx.save();
    ctx.globalAlpha = endA;
    if (timing.anim === 'slide') {
      const p = easeOut(t / 0.6);
      ctx.translate(0, (1 - p) * 90 * u);
      ctx.globalAlpha *= clamp01(t / 0.3);
    } else if (timing.anim === 'fade') {
      ctx.globalAlpha *= clamp01(t / 0.4);
    }
    if (off && clip.template !== 'custom') ctx.translate(off.x * W, off.y * H);
    tpl.render(ctx, { W, H, u, brand, vals: clip.vals || {}, t, clip, opts });
    ctx.restore();
  }

  // Backdrop drawn once, full-frame, NOT moved by text offset
  const BD_RANK = { none: 0, fade: 1, dim: 2 };
  function renderAll(ctx, W, H, clip, brand, time, opts) {
    const list = (clip.templates && clip.templates.length) ? clip.templates : [clip.template];
    let bd = (clip.backdrop && clip.backdrop !== 'auto') ? clip.backdrop : null;
    if (!bd) {
      bd = 'none';
      list.forEach(id => { const d = (TEMPLATES[id] || {}).backdrop || 'none'; if (BD_RANK[d] > BD_RANK[bd]) bd = d; });
    }
    const timing = clip.timing || { start: 0 };
    const bt = time - (timing.start || 0);
    if (bd !== 'none' && bt >= 0) {
      const endA = timing.end != null && timing.end > 0 ? clamp01((timing.end - time) / 0.35) : 1;
      if (endA > 0) {
        const k = clip.backdropOpacity != null ? clamp01(clip.backdropOpacity / 100) : 1;
        ctx.save();
        ctx.globalAlpha = clamp01(bt / 0.4) * endA * k;
        if (bd === 'fade') scrim(ctx, W, H, 0.35, 1, 0.7);
        else { ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(0, 0, W, H); }
        ctx.restore();
      }
    }
    list.forEach(id => {
      const sub = Object.assign({}, clip, { template: id, vals: (clip.valsAll && clip.valsAll[id]) || clip.vals });
      renderOverlay(ctx, W, H, sub, brand, time, id === 'custom' ? opts : null);
    });
  }

  // rot: 0..3 quarter-turns clockwise
  function drawVideoCover(ctx, v, W, H, rot) {
    rot = rot || 0;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const odd = rot % 2 === 1;
    const ew = odd ? vh : vw, eh = odd ? vw : vh; // effective dims after rotation
    const s = Math.max(W / ew, H / eh);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rot * Math.PI / 2);
    ctx.drawImage(v, -vw * s / 2, -vh * s / 2, vw * s, vh * s);
    ctx.restore();
  }

  function probe(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
      let done = false;
      const finish = (thumb, duration) => { if (done) return; done = true; resolve({ thumb, duration }); v.removeAttribute('src'); };
      v.addEventListener('loadedmetadata', async () => {
        let dur = v.duration && isFinite(v.duration) ? v.duration : 0;
        if (!isFinite(v.duration) || dur < 0.5) {
          // MediaRecorder-produced WebM: metadata duration is Infinity or bogus-tiny
          await new Promise(res => {
            let done = false;
            const check = () => { if (!done && isFinite(v.duration) && v.duration >= 0.05) { done = true; cleanup(); res(); } };
            const cleanup = () => { v.removeEventListener('durationchange', check); v.removeEventListener('seeked', check); };
            v.addEventListener('durationchange', check);
            v.addEventListener('seeked', check);
            setTimeout(() => { if (!done) { done = true; cleanup(); res(); } }, 3000);
            v.currentTime = 1e10;
          });
          dur = isFinite(v.duration) ? v.duration : 0;
        }
        const seekTo = Math.min(0.4, dur ? dur / 2 : 0);
        v.addEventListener('seeked', () => {
          try {
            const c = document.createElement('canvas');
            const w = 200, h = Math.round(w * (v.videoHeight / v.videoWidth)) || 112;
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(v, 0, 0, w, h);
            finish(c.toDataURL('image/jpeg', 0.7), dur);
          } catch (e) { finish(null, dur); }
        }, { once: true });
        v.currentTime = seekTo;
      });
      v.addEventListener('error', () => finish(null, 0));
      setTimeout(() => finish(null, v.duration || 0), 8000);
    });
  }

  const BITRATES = { standard: 12e6, high: 20e6, max: 30e6 };
  const FORMATS = {
    'mp4': { label: 'MP4 (H.264)', ext: 'mp4', mimes: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'] },
    'webm-vp9': { label: 'WebM (VP9)', ext: 'webm', mimes: ['video/webm;codecs=vp9,opus'] },
    'webm-vp8': { label: 'WebM (VP8)', ext: 'webm', mimes: ['video/webm;codecs=vp8,opus', 'video/webm'] }
  };
  function supportedMime(fmt) {
    const f = FORMATS[fmt];
    return (f && f.mimes.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m))) || null;
  }
  function pickMime() {
    const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return opts.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || 'video/webm';
  }

  // items: [{ src, clip }] rendered back-to-back into one file
  async function exportSequence({ items, brand, aspect, quality, format, onProgress }) {
    const [W, H] = RES[aspect] || RES['9:16'];
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    await ac.resume();
    const dest = ac.createMediaStreamDestination();
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));

    const mime = supportedMime(format) || pickMime();
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATES[quality] || BITRATES.high, audioBitsPerSecond: 192000 });
    } catch (e) {
      rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: BITRATES[quality] || BITRATES.high });
    }
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    let recErr = null;
    rec.onerror = e => { recErr = (e.error && e.error.message) || 'Recorder error'; };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(250);

    // total duration for cross-item progress
    const spans = items.map(it => {
      const c = it.clip;
      const st = Math.max(0, c.trimStart || 0);
      const en = (c.trimEnd && c.trimEnd > st) ? c.trimEnd : (c.duration || 0);
      return Math.max(0.1, en - st);
    });
    const totalDur = spans.reduce((a, b) => a + b, 0);
    let doneDur = 0;
    const cleanup = [];

    try {
      for (let i = 0; i < items.length; i++) {
        const { src, clip } = items[i];
        const v = document.createElement('video');
        v.src = src; v.preload = 'auto'; v.playsInline = true;
        v.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;';
        document.body.appendChild(v);
        cleanup.push(() => v.remove());
        await new Promise((res, rej) => {
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', () => rej(new Error('Could not load "' + (clip.name || 'clip') + '"')), { once: true });
        });
        const dur = (isFinite(v.duration) && v.duration >= 0.5) ? v.duration : await new Promise(res => {
          let done = false;
          const check = () => { if (!done && isFinite(v.duration) && v.duration >= 0.05) { done = true; cleanup(); res(v.duration); } };
          const cleanup = () => { v.removeEventListener('durationchange', check); v.removeEventListener('seeked', check); };
          v.addEventListener('durationchange', check);
          v.addEventListener('seeked', check);
          setTimeout(() => { if (!done) { done = true; cleanup(); res(clip.duration || 60); } }, 3000);
          v.currentTime = 1e10;
        });
        const start = Math.max(0, clip.trimStart || 0);
        const end = Math.min(dur, (clip.trimEnd && clip.trimEnd > start) ? clip.trimEnd : dur);
        v.currentTime = start;
        await new Promise(res => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 600); });
        const srcNode = ac.createMediaElementSource(v);
        srcNode.connect(dest);
        cleanup.push(() => { try { srcNode.disconnect(); } catch (e) {} });

        await new Promise((resolve, reject) => {
          let raf, ended = false;
          const finish = () => {
            if (ended) return; ended = true;
            cancelAnimationFrame(raf);
            v.pause();
            resolve();
          };
          const draw = () => {
            const t = v.currentTime;
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
            drawVideoCover(ctx, v, W, H, clip.rotate || 0);
            renderAll(ctx, W, H, clip, brand, t, null);
            if (onProgress) onProgress(Math.min(1, (doneDur + (t - start)) / totalDur));
            if (t >= end - 0.03 || v.ended) { finish(); return; }
            raf = requestAnimationFrame(draw);
          };
          v.addEventListener('ended', finish);
          v.play().then(draw).catch(() => {
            v.muted = true; // iOS gesture timeout — keep video, lose that clip's audio
            v.play().then(draw).catch(reject);
          });
        });
        doneDur += spans[i];
      }
    } finally {
      try { rec.stop(); } catch (e) {}
      await stopped;
      cleanup.forEach(fn => fn());
      try { ac.close(); } catch (e) {}
    }
    if (recErr) throw new Error(recErr);
    if (!chunks.length) throw new Error('No video data was captured — try a different format.');
    const outMime = rec.mimeType || mime;
    const ext = outMime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    return { blob: new Blob(chunks, { type: outMime.split(';')[0] }), mime: outMime, ext };
  }

  async function exportClip({ src, clip, brand, aspect, quality, format, onProgress }) {
    return exportSequence({ items: [{ src, clip }], brand, aspect, quality, format, onProgress });
  }

  window.CaptionEngine = { RES, TEMPLATES, FORMATS, supportedMime, renderOverlay, renderAll, drawVideoCover, probe, exportClip, exportSequence };
})();
