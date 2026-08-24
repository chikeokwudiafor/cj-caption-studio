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

  // Best contiguous window of `len` seconds by mean energy, with a small penalty
  // on the very start of a clip where the camera is usually still settling.
  function bestWindow(env, hop, duration, len) {
    if (!env || !env.length) return { start: Math.max(0, (duration - len) / 2), score: 0 };
    var w = Math.max(1, Math.round(len / hop));
    if (w >= env.length) return { start: 0, score: mean(env, 0, env.length) };

    var sum = 0;
    for (var i = 0; i < w; i++) sum += env[i];
    var bestSum = -Infinity, bestI = 0;
    for (var s = 0; s + w <= env.length; s++) {
      if (s > 0) sum += env[s + w - 1] - env[s - 1];
      var t = s * hop;
      var penalty = t < 0.5 ? 0.75 : 1;                    // ignore the settling-in shot
      var score = (sum / w) * penalty;
      if (score > bestSum) { bestSum = score; bestI = s; }
    }
    return { start: clamp(bestI * hop, 0, Math.max(0, duration - len)), score: bestSum };
  }

  function mean(arr, a, b) { var s = 0; for (var i = a; i < b; i++) s += arr[i]; return (b > a) ? s / (b - a) : 0; }

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

  /* Refine the chosen clips with motion, which costs a seek per sample. */
  async function refine(picks, analyses, segLen, onProgress) {
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      if (onProgress) onProgress(i / picks.length);
      var a = analyses[p.id];
      try {
        var v = await loadVideo(p.url);
        // Compare a few candidate windows and keep the busiest one.
        var cands = candidateWindows(a, segLen, p.duration);
        var best = null;
        for (var k = 0; k < cands.length; k++) {
          var to = Math.min(p.duration, cands[k] + segLen);
          var m = await motionScore(v, cands[k], to, 4);
          if (!best || m > best.motion) best = { start: cands[k], motion: m };
        }
        try { v.pause(); v.removeAttribute('src'); v.remove(); } catch (e) {}
        if (best) { p.start = best.start; p.motion = best.motion; }
      } catch (e) { /* keep the audio-only choice */ }
    }
    if (onProgress) onProgress(1);
    return picks;
  }

  function candidateWindows(a, segLen, duration) {
    var list = [];
    if (a && a.env && a.env.length) {
      var top = bestWindow(a.env, a.hop, duration, segLen);
      list.push(top.start);
      // two alternates, so motion gets a say rather than only confirming audio
      var third = Math.max(0, duration - segLen);
      list.push(clamp(third * 0.33, 0, third));
      list.push(clamp(third * 0.66, 0, third));
    } else {
      var span = Math.max(0, duration - segLen);
      list.push(span * 0.25, span * 0.5, span * 0.75);
    }
    // dedupe near-identical starts
    var seen = [];
    return list.filter(function (v) {
      if (seen.some(function (s) { return Math.abs(s - v) < 0.4; })) return false;
      seen.push(v); return true;
    });
  }

  /* Decide which clips make the cut and how long each segment runs. */
  function plan(clips, analyses, targetSec, vibe) {
    var scored = clips.map(function (c) {
      var a = analyses[c.id] || {};
      var dur = a.duration || c.duration || 0;
      var probe = Math.min(3, Math.max(1, dur * 0.5));
      var w = bestWindow(a.env, a.hop || HOP, dur, probe);
      return { id: c.id, url: c.url, name: c.name, duration: dur, score: w.score, start: w.start, tempo: a.tempo || 0 };
    }).filter(function (c) { return c.duration > 0.5; });

    if (!scored.length) return null;

    // How many clips can we fit while keeping segments watchable?
    var maxClips = Math.max(1, Math.floor(targetSec / MIN_SEG));
    var wantClips = clamp(Math.round(targetSec / (vibe === 'hype' ? 2.0 : 3.2)), 1, maxClips);
    wantClips = Math.min(wantClips, scored.length);

    var byScore = scored.slice().sort(function (a, b) { return b.score - a.score; });

    // Leave out the duds. A clip scoring a fraction of the best one is footage of
    // the floor or an empty room, and padding a recap with it makes it worse.
    var top = byScore[0].score;
    var floor = top * 0.28;
    var keep = byScore.filter(function (c) { return c.score >= floor; });
    var dropped = byScore.length - keep.length;
    if (!keep.length) { keep = byScore.slice(0, 1); dropped = byScore.length - 1; }

    var picks = keep.slice(0, wantClips);
    dropped += Math.max(0, keep.length - picks.length);

    var segLen = clamp(targetSec / Math.max(1, picks.length), MIN_SEG, MAX_SEG);

    // If the footage has a steady tempo, round segments to whole beats so the
    // cuts land with the music instead of against it.
    var tempos = picks.map(function (p) { return p.tempo; }).filter(function (t) { return t > 0; });
    if (tempos.length) {
      tempos.sort(function (a, b) { return a - b; });
      var bpm = tempos[Math.floor(tempos.length / 2)];
      var beat = 60 / bpm;
      var beats = Math.max(2, Math.round(segLen / beat));
      var snapped = beats * beat;
      if (snapped >= MIN_SEG && snapped <= MAX_SEG) segLen = snapped;
    }

    // Open on the strongest clip — that is the hook — then run the rest in the
    // order they were shot, which reads as a night unfolding.
    var hook = picks[0];
    var original = {};
    clips.forEach(function (c, i) { original[c.id] = i; });
    var rest = picks.slice(1).sort(function (a, b) { return original[a.id] - original[b.id]; });
    var ordered = [hook].concat(rest);

    ordered.forEach(function (p) {
      var len = Math.min(segLen, Math.max(0.4, p.duration));
      var w = bestWindow(analyses[p.id] && analyses[p.id].env, HOP, p.duration, len);
      p.start = clamp(w.start, 0, Math.max(0, p.duration - len));
      p.len = len;
    });

    return {
      picks: ordered, segLen: segLen, dropped: dropped,
      total: ordered.reduce(function (a, p) { return a + p.len; }, 0)
    };
  }

  window.AutoCut = { analyse: analyse, plan: plan, refine: refine, bestWindow: bestWindow };
})();
