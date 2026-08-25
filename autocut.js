/* Auto-cut: find the good moments and assemble them. Global: window.AutoCut
 *
 * No model, no network, no key. For event footage the interesting moments are
 * measurable: the crowd gets loud and the frame gets busy. Audio energy is cheap
 * to compute over a whole clip, so it runs first and narrows things down; motion
 * sampling needs a video seek per sample, so it only runs on the windows that
 * already look promising.
 */
(function () {
  'use strict';

  var HOP = 0.1;            // seconds per energy sample
  var ANALYSIS_RATE = 22050;
  var MOTION_W = 64, MOTION_H = 36;
  var MIN_SEG = 1.2, MAX_SEG = 5.0;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function normalise(arr) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < arr.length; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
    var range = hi - lo;
    var out = new Float32Array(arr.length);
    if (!(range > 1e-9)) return out;
    for (var j = 0; j < arr.length; j++) out[j] = (arr[j] - lo) / range;
    return out;
  }

  // ---------------------------------------------------------------- audio

  var decodeCtx = null;
  function ctxFor() {
    if (!decodeCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      // Decoding at a low rate is plenty for an energy envelope and much faster.
      try { decodeCtx = new AC({ sampleRate: ANALYSIS_RATE }); }
      catch (e) { decodeCtx = new AC(); }
    }
    return decodeCtx;
  }

  async function audioEnvelope(url) {
    var buf;
    try {
      var bytes = await (await fetch(url)).arrayBuffer();
      buf = await ctxFor().decodeAudioData(bytes);
    } catch (e) { return null; }          // silent clip, or a codec we cannot decode

    var rate = buf.sampleRate;
    var n = buf.length;
    var chans = [];
    for (var c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    var hopN = Math.max(1, Math.round(rate * HOP));
    var count = Math.max(1, Math.floor(n / hopN));
    var env = new Float32Array(count);

    for (var i = 0; i < count; i++) {
      var s = i * hopN, e = Math.min(n, s + hopN), sum = 0;
      for (var k = s; k < e; k += 2) {           // every other sample is ample here
        var v = 0;
        for (var ch = 0; ch < chans.length; ch++) v += chans[ch][k];
        v /= chans.length;
        sum += v * v;
      }
      env[i] = Math.sqrt(sum / Math.max(1, (e - s) / 2));
    }
    return { env: env, hop: HOP, duration: buf.duration };
  }

  // Spectral-flux-ish onsets, then autocorrelation for a tempo in a dance range.
  function detectTempo(env) {
    if (!env || env.length < 40) return 0;
    var flux = new Float32Array(env.length);
    for (var i = 1; i < env.length; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);
    flux = normalise(flux);

    var best = 0, bestLag = 0;
    var minLag = Math.round(60 / 180 / HOP);     // 180 BPM
    var maxLag = Math.round(60 / 90 / HOP);      // 90 BPM
    for (var lag = minLag; lag <= maxLag; lag++) {
      var sum = 0, n = 0;
      for (var j = lag; j < flux.length; j++) { sum += flux[j] * flux[j - lag]; n++; }
      var score = n ? sum / n : 0;
      if (score > best) { best = score; bestLag = lag; }
    }
    if (!bestLag || best < 0.01) return 0;
    return 60 / (bestLag * HOP);
  }

  // ---------------------------------------------------------------- motion

  function seekTo(video, t) {
    return new Promise(function (resolve) {
      if (Math.abs(video.currentTime - t) < 1e-3) { resolve(); return; }
      var done = false;
      function fin() { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('seeked', fin); resolve(); }
      var timer = setTimeout(fin, 1500);
      video.addEventListener('seeked', fin);
      try { video.currentTime = t; } catch (e) { fin(); }
    });
  }

  function loadVideo(src) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      v.src = src; v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0;';
      document.body.appendChild(v);
      v.addEventListener('loadeddata', function () { resolve(v); }, { once: true });
      v.addEventListener('error', function () { reject(new Error('unreadable')); }, { once: true });
      setTimeout(function () { reject(new Error('timeout')); }, 15000);
    });
  }

  // Mean absolute frame difference at a handful of times inside one window.
  async function motionScore(video, from, to, samples) {
    var cv = document.createElement('canvas');
    cv.width = MOTION_W; cv.height = MOTION_H;
    var g = cv.getContext('2d', { willReadFrequently: true });
    var prev = null, total = 0, n = 0;
    for (var i = 0; i < samples; i++) {
      var t = from + (to - from) * (i / Math.max(1, samples - 1));
      await seekTo(video, t);
      g.drawImage(video, 0, 0, MOTION_W, MOTION_H);
      var d = g.getImageData(0, 0, MOTION_W, MOTION_H).data;
      if (prev) {
        var diff = 0;
        for (var p = 0; p < d.length; p += 4) {
          diff += Math.abs(d[p] - prev[p]) + Math.abs(d[p + 1] - prev[p + 1]) + Math.abs(d[p + 2] - prev[p + 2]);
        }
        total += diff / (d.length / 4 * 3 * 255);
        n++;
      }
      prev = d.slice(0);
    }
    return n ? total / n : 0;
  }

  // ---------------------------------------------------------------- windows

  function mean(arr, a, b) { var s = 0; for (var i = a; i < b; i++) s += arr[i]; return (b > a) ? s / (b - a) : 0; }

  /* Rolling mean energy over every window of `len` seconds. */
  function rollingScores(env, hop, len) {
    var w = Math.max(1, Math.round(len / hop));
    if (w >= env.length) return null;
    var roll = new Float32Array(env.length - w + 1);
    var sum = 0;
    for (var i = 0; i < w; i++) sum += env[i];
    roll[0] = sum / w;
    for (var s = 1; s + w <= env.length; s++) { sum += env[s + w - 1] - env[s - 1]; roll[s] = sum / w; }
    // The opening moment is usually the camera still settling.
    for (var k = 0; k < roll.length && k * hop < 0.5; k++) roll[k] *= 0.75;
    return { roll: roll, w: w };
  }

  function bestWindow(env, hop, duration, len) {
    if (!env || !env.length) return { start: Math.max(0, (duration - len) / 2), score: 0 };
    var r = rollingScores(env, hop, len);
    if (!r) return { start: 0, score: mean(env, 0, env.length) };
    var best = -Infinity, bi = 0;
    for (var s = 0; s < r.roll.length; s++) if (r.roll[s] > best) { best = r.roll[s]; bi = s; }
    return { start: clamp(bi * hop, 0, Math.max(0, duration - len)), score: best };
  }

  /* The best non-overlapping windows in one clip, strongest first. A 40s clip
     holds several good moments; taking only one is why a 30s target used to come
     back 15s long. */
  function candidatesFor(a, duration, len, maxCount) {
    var hop = (a && a.hop) || HOP;
    var env = a && a.env;
    var out = [];
    var latest = Math.max(0, duration - len);

    if (!env || !env.length) {
      var n = Math.max(1, Math.min(maxCount, Math.floor(duration / len)));
      for (var i = 0; i < n; i++) out.push({ start: clamp(i * (duration / n), 0, latest), score: 0 });
      return out;
    }
    var r = rollingScores(env, hop, len);
    if (!r) return [{ start: 0, score: mean(env, 0, env.length) }];

    var taken = new Uint8Array(r.roll.length);
    for (var c = 0; c < maxCount; c++) {
      var best = -Infinity, bi = -1;
      for (var s = 0; s < r.roll.length; s++) if (!taken[s] && r.roll[s] > best) { best = r.roll[s]; bi = s; }
      if (bi < 0 || best <= 0) break;
      out.push({ start: clamp(bi * hop, 0, latest), score: best });
      var from = Math.max(0, bi - r.w), to = Math.min(r.roll.length - 1, bi + r.w);
      for (var b = from; b <= to; b++) taken[b] = 1;   // no overlapping picks
    }
    return out;
  }

  // ---------------------------------------------------------------- public

  /* clips: [{id, url, duration}]. Returns a map id -> analysis. */
  async function analyse(clips, onProgress) {
    var out = {};
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (onProgress) onProgress(i / clips.length, c.name || '');
      var a = await audioEnvelope(c.url);
      out[c.id] = {
        env: a ? a.env : null,
        hop: HOP,
        duration: (a && a.duration) || c.duration || 0,
        tempo: a ? detectTempo(a.env) : 0,
        hasAudio: !!a,
        motion: null
      };
    }
    if (onProgress) onProgress(1, '');
    return out;
  }

  /* Nudge each chosen window to the busiest nearby framing. Costs a seek per
     sample, so it only ever looks just either side of what audio already chose. */
  async function refine(picks, analyses, segLen, onProgress) {
    var byUrl = {};
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      if (onProgress) onProgress(i / picks.length);
      try {
        if (!byUrl[p.url]) byUrl[p.url] = await loadVideo(p.url);
        var v = byUrl[p.url];
        var shift = segLen * 0.5;
        var latest = Math.max(0, p.duration - segLen);
        var cands = [p.start, clamp(p.start - shift, 0, latest), clamp(p.start + shift, 0, latest)]
          .filter(function (t, idx, arr) { return arr.indexOf(t) === idx; });
        var best = null;
        for (var k = 0; k < cands.length; k++) {
          var m = await motionScore(v, cands[k], Math.min(p.duration, cands[k] + segLen), 3);
          if (!best || m > best.motion) best = { start: cands[k], motion: m };
        }
        if (best) { p.start = best.start; p.motion = best.motion; }
      } catch (e) { /* keep the audio-only choice */ }
    }
    Object.keys(byUrl).forEach(function (u) {
      try { byUrl[u].pause(); byUrl[u].removeAttribute('src'); byUrl[u].remove(); } catch (e) {}
    });
    if (onProgress) onProgress(1);
    return picks;
  }

  /* Choose the segments that make up the cut. Several may come from one clip. */
  function plan(clips, analyses, targetSec, vibe) {
    var idealSeg = vibe === 'hype' ? 2.2 : 3.4;
    var nSegs = Math.max(1, Math.round(targetSec / idealSeg));
    var segLen = clamp(targetSec / nSegs, MIN_SEG, MAX_SEG);
    nSegs = Math.max(1, Math.round(targetSec / segLen));

    var usable = clips.map(function (c, i) {
      var a = analyses[c.id] || {};
      return { c: c, a: a, dur: a.duration || c.duration || 0, order: i };
    }).filter(function (u) { return u.dur > 0.5; });
    if (!usable.length) return null;

    // Spread the load: no single clip should carry the whole cut if others exist.
    var perClipCap = Math.max(1, Math.ceil(nSegs / usable.length) + 1);

    var all = [];
    usable.forEach(function (u) {
      var len = Math.min(segLen, u.dur);
      var fits = Math.max(1, Math.floor(u.dur / len));
      candidatesFor(u.a, u.dur, len, Math.min(perClipCap, fits)).forEach(function (w) {
        all.push({
          id: u.c.id, url: u.c.url, name: u.c.name, duration: u.dur, order: u.order,
          start: w.start, score: w.score, tempo: u.a.tempo || 0
        });
      });
    });
    if (!all.length) return null;

    all.sort(function (a, b) { return b.score - a.score; });

    // Leave out the duds — footage of the floor, or an empty room.
    var top = all[0].score;
    var kept = all.filter(function (w) { return w.score >= top * 0.28; });
    var pool = kept.length ? kept : all.slice(0, 1);
    var picks = pool.slice(0, nSegs);

    var used = {};
    picks.forEach(function (p) { used[p.id] = 1; });
    var dropped = usable.filter(function (u) { return !used[u.c.id]; }).length;

    // With a steady tempo, round segments to whole beats so cuts land with it.
    var tempos = picks.map(function (p) { return p.tempo; }).filter(function (t) { return t > 0; });
    if (tempos.length) {
      tempos.sort(function (a, b) { return a - b; });
      var beat = 60 / tempos[Math.floor(tempos.length / 2)];
      var beats = Math.max(2, Math.round(segLen / beat));
      var snapped = beats * beat;
      if (snapped >= MIN_SEG && snapped <= MAX_SEG) segLen = snapped;
    }

    // Open on the strongest moment, then run in the order the night happened.
    var hook = picks[0];
    var rest = picks.slice(1).sort(function (a, b) {
      return (a.order - b.order) || (a.start - b.start);
    });
    var ordered = [hook].concat(rest);
    ordered.forEach(function (p) {
      p.len = Math.min(segLen, Math.max(0.4, p.duration - p.start));
    });

    return {
      picks: ordered, segLen: segLen, dropped: dropped,
      total: ordered.reduce(function (a, p) { return a + p.len; }, 0)
    };
  }

  window.AutoCut = { analyse: analyse, plan: plan, refine: refine, bestWindow: bestWindow };
})();
