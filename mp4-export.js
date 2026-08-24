/* Fast export: WebCodecs encode + MP4 mux. Global: window.FastExport
 *
 * The MediaRecorder path in captions-engine.js records a canvas in wall-clock
 * time, so a 30s clip costs 30s and a backgrounded tab truncates the file.
 * WebCodecs encodes as fast as the device manages and does not care whether the
 * tab is visible. Nothing built in will wrap encoded chunks into an MP4 though,
 * so the muxer below writes the boxes by hand.
 */
(function () {
  'use strict';

  var RES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
  var BITRATES = { standard: 8e6, high: 14e6, max: 22e6 };
  var FPS = 30;
  var VIDEO_TIMESCALE = 30000;         // 1000 ticks per frame at 30fps
  var FRAME_TICKS = VIDEO_TIMESCALE / FPS;
  var GOP = 60;                        // keyframe every 2s
  var AUDIO_RATE = 48000;
  var AAC_FRAME = 1024;

  // ---------------------------------------------------------------- byte writer

  function Writer() { this.parts = []; this.len = 0; }
  Writer.prototype.push = function (u8) { this.parts.push(u8); this.len += u8.length; };
  Writer.prototype.u32 = function (v) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); this.push(b); };
  Writer.prototype.u16 = function (v) { var b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff); this.push(b); };
  Writer.prototype.u8 = function (v) { this.push(new Uint8Array([v & 0xff])); };
  Writer.prototype.str = function (s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); this.push(b); };
  Writer.prototype.zeros = function (n) { this.push(new Uint8Array(n)); };
  Writer.prototype.bytes = function (arr) { this.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr)); };
  Writer.prototype.merge = function () {
    var out = new Uint8Array(this.len), o = 0;
    for (var i = 0; i < this.parts.length; i++) { out.set(this.parts[i], o); o += this.parts[i].length; }
    return out;
  };

  // A box is written as [size][type][payload].
  function box(type, payloadWriter) {
    var body = payloadWriter.merge();
    var w = new Writer();
    w.u32(body.length + 8);
    w.str(type);
    w.bytes(body);
    return w.merge();
  }
  function fullBox(type, version, flags, payloadWriter) {
    var w = new Writer();
    w.u8(version);
    w.u8((flags >> 16) & 0xff); w.u8((flags >> 8) & 0xff); w.u8(flags & 0xff);
    w.bytes(payloadWriter.merge());
    return box(type, wrap(w));
  }
  function wrap(w) { var x = new Writer(); x.push(w.merge()); return x; }
  function W() { return new Writer(); }

  // ---------------------------------------------------------------- moov

  function stblFor(track) {
    var w = W();

    // stsd
    var sd = W();
    sd.u32(1); // entry count
    sd.bytes(track.kind === 'video' ? videoSampleEntry(track) : audioSampleEntry(track));
    w.bytes(fullBox('stsd', 0, 0, wrap(sd)));

    // stts — every sample has the same duration, so one entry covers the track
    var tts = W();
    tts.u32(1);
    tts.u32(track.samples.length);
    tts.u32(track.sampleDelta);
    w.bytes(fullBox('stts', 0, 0, wrap(tts)));

    // stss — sync samples (video only; every audio sample is a sync sample)
    if (track.kind === 'video') {
      var keys = [];
      for (var i = 0; i < track.samples.length; i++) if (track.samples[i].key) keys.push(i + 1);
      if (keys.length && keys.length !== track.samples.length) {
        var ss = W();
        ss.u32(keys.length);
        for (var k = 0; k < keys.length; k++) ss.u32(keys[k]);
        w.bytes(fullBox('stss', 0, 0, wrap(ss)));
      }
    }

    // stsc — one sample per chunk keeps the tables trivial
    var sc = W();
    sc.u32(1); sc.u32(1); sc.u32(1); sc.u32(1);
    w.bytes(fullBox('stsc', 0, 0, wrap(sc)));

    // stsz
    var sz = W();
    sz.u32(0);
    sz.u32(track.samples.length);
    for (var s = 0; s < track.samples.length; s++) sz.u32(track.samples[s].size);
    w.bytes(fullBox('stsz', 0, 0, wrap(sz)));

    // stco
    var co = W();
    co.u32(track.samples.length);
    for (var c = 0; c < track.samples.length; c++) co.u32(track.samples[c].offset);
    w.bytes(fullBox('stco', 0, 0, wrap(co)));

    return box('stbl', w);
  }

  function videoSampleEntry(track) {
    var e = W();
    e.zeros(6); e.u16(1);                       // reserved + data_reference_index
    e.u16(0); e.u16(0); e.u32(0); e.u32(0); e.u32(0);
    e.u16(track.width); e.u16(track.height);
    e.u32(0x00480000); e.u32(0x00480000);       // 72dpi
    e.u32(0); e.u16(1);
    e.zeros(32);                                // compressor name
    e.u16(0x0018); e.u16(0xffff);               // depth, pre_defined
    e.bytes(box('avcC', wrap((function () { var d = W(); d.bytes(track.description); return d; })())));
    return box('avc1', e);
  }

  function audioSampleEntry(track) {
    var e = W();
    e.zeros(6); e.u16(1);
    e.u32(0); e.u32(0);
    e.u16(track.channels); e.u16(16);
    e.u16(0); e.u16(0);
    e.u32(track.sampleRate << 16);              // 16.16 fixed
    e.bytes(esds(track.description));
    return box('mp4a', e);
  }

  // ES descriptor wrapping the AudioSpecificConfig the encoder handed us.
  function esds(asc) {
    function desc(tag, payload) {
      var w = W();
      w.u8(tag);
      var n = payload.length;
      w.u8(0x80 | ((n >> 21) & 0x7f)); w.u8(0x80 | ((n >> 14) & 0x7f));
      w.u8(0x80 | ((n >> 7) & 0x7f));  w.u8(n & 0x7f);
      w.bytes(payload);
      return w.merge();
    }
    var dec = W();
    dec.u8(0x40);                               // AAC
    dec.u8(0x15);                               // audio stream
    dec.u8(0); dec.u16(0);                      // buffer size
    dec.u32(0); dec.u32(0);                     // max/avg bitrate
    dec.bytes(desc(0x05, asc));                 // DecoderSpecificInfo
    var es = W();
    es.u16(1); es.u8(0);                        // ES_ID, flags
    es.bytes(desc(0x04, dec.merge()));          // DecoderConfigDescriptor
    es.bytes(desc(0x06, new Uint8Array([0x02])));// SLConfigDescriptor
    return fullBox('esds', 0, 0, wrap((function () { var w = W(); w.bytes(desc(0x03, es.merge())); return w; })()));
  }

  function trak(track, id, movieDuration) {
    var tkhdBody = W();
    tkhdBody.u32(0); tkhdBody.u32(0);           // creation, modification
    tkhdBody.u32(id);
    tkhdBody.u32(0);
    tkhdBody.u32(movieDuration);
    tkhdBody.u32(0); tkhdBody.u32(0);
    tkhdBody.u16(0);                            // layer
    tkhdBody.u16(0);                            // alternate group
    tkhdBody.u16(track.kind === 'audio' ? 0x0100 : 0); // volume
    tkhdBody.u16(0);
    [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].forEach(function (v) { tkhdBody.u32(v); });
    tkhdBody.u32((track.kind === 'video' ? track.width : 0) << 16);
    tkhdBody.u32((track.kind === 'video' ? track.height : 0) << 16);

    var mdhdBody = W();
    mdhdBody.u32(0); mdhdBody.u32(0);
    mdhdBody.u32(track.timescale);
    mdhdBody.u32(track.samples.length * track.sampleDelta);
    mdhdBody.u16(0x55c4);                       // 'und'
    mdhdBody.u16(0);

    var hdlrBody = W();
    hdlrBody.u32(0);
    hdlrBody.str(track.kind === 'video' ? 'vide' : 'soun');
    hdlrBody.u32(0); hdlrBody.u32(0); hdlrBody.u32(0);
    hdlrBody.str(track.kind === 'video' ? 'VideoHandler\0' : 'SoundHandler\0');

    var minfInner = W();
    if (track.kind === 'video') {
      var vmhd = W(); vmhd.u16(0); vmhd.u16(0); vmhd.u16(0); vmhd.u16(0);
      minfInner.bytes(fullBox('vmhd', 0, 1, wrap(vmhd)));
    } else {
      var smhd = W(); smhd.u16(0); smhd.u16(0);
      minfInner.bytes(fullBox('smhd', 0, 0, wrap(smhd)));
    }
    var dref = W(); dref.u32(1); dref.bytes(fullBox('url ', 0, 1, W()));
    minfInner.bytes(box('dinf', wrap((function () { var d = W(); d.bytes(fullBox('dref', 0, 0, wrap(dref))); return d; })())));
    minfInner.bytes(stblFor(track));

    var mdia = W();
    mdia.bytes(fullBox('mdhd', 0, 0, wrap(mdhdBody)));
    mdia.bytes(fullBox('hdlr', 0, 0, wrap(hdlrBody)));
    mdia.bytes(box('minf', minfInner));

    var t = W();
    t.bytes(fullBox('tkhd', 0, 3, wrap(tkhdBody)));
    t.bytes(box('mdia', mdia));
    return box('trak', t);
  }

  function buildMoov(tracks, movieDurationMs) {
    var mvhd = W();
    mvhd.u32(0); mvhd.u32(0);
    mvhd.u32(1000);                             // movie timescale: milliseconds
    mvhd.u32(movieDurationMs);
    mvhd.u32(0x00010000);                       // rate 1.0
    mvhd.u16(0x0100); mvhd.u16(0);              // volume 1.0
    mvhd.u32(0); mvhd.u32(0);
    [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].forEach(function (v) { mvhd.u32(v); });
    for (var i = 0; i < 6; i++) mvhd.u32(0);    // pre_defined
    mvhd.u32(tracks.length + 1);                // next_track_ID

    var m = W();
    m.bytes(fullBox('mvhd', 0, 0, wrap(mvhd)));
    tracks.forEach(function (t, i) { m.bytes(trak(t, i + 1, movieDurationMs)); });
    return box('moov', m);
  }

  function buildMp4(tracks) {
    var ftypBody = W();
    ftypBody.str('isom'); ftypBody.u32(512);
    ftypBody.str('isom'); ftypBody.str('iso2'); ftypBody.str('avc1'); ftypBody.str('mp41');
    var ftyp = box('ftyp', ftypBody);

    var mdatSize = 0;
    tracks.forEach(function (t) { t.samples.forEach(function (s) { mdatSize += s.size; }); });

    // Sample offsets are absolute, so they depend on where mdat lands, which
    // depends on moov's size, which depends on the offsets. Lay out mdat first
    // (ftyp + mdat header), fill in offsets, then append moov at the end.
    var mdatStart = ftyp.length + 8;
    var offset = mdatStart;
    var mdat = new Uint8Array(mdatSize);
    var o = 0;
    tracks.forEach(function (t) {
      t.samples.forEach(function (s) {
        s.offset = offset + o;
        mdat.set(s.data, o);
        o += s.size;
      });
    });

    var durMs = 0;
    tracks.forEach(function (t) {
      durMs = Math.max(durMs, Math.round(t.samples.length * t.sampleDelta / t.timescale * 1000));
    });
    var moov = buildMoov(tracks, durMs);

    var head = W();
    head.u32(mdatSize + 8);
    head.str('mdat');

    var out = new Writer();
    out.bytes(ftyp);
    out.bytes(head.merge());
    out.bytes(mdat);
    out.bytes(moov);
    return new Blob([out.merge()], { type: 'video/mp4' });
  }

  // ---------------------------------------------------------------- capability

  var VIDEO_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42003c', 'avc1.42001f'];

  function present() {
    return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' &&
           typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined';
  }

  var supportCache = null;
  async function support(aspect, quality) {
    if (!present()) return { ok: false, reason: 'This browser has no WebCodecs support.' };
    if (supportCache) return supportCache;
    var res = RES[aspect] || RES['9:16'];
    var found = null;
    for (var i = 0; i < VIDEO_CODECS.length && !found; i++) {
      try {
        var cfg = {
          codec: VIDEO_CODECS[i], width: res[0], height: res[1],
          bitrate: BITRATES[quality] || BITRATES.high, framerate: FPS,
          avc: { format: 'avc' }
        };
        var s = await VideoEncoder.isConfigSupported(cfg);
        if (s && s.supported) found = VIDEO_CODECS[i];
      } catch (e) {}
    }
    if (!found) return { ok: false, reason: 'No H.264 encoder available.' };

    var audioOk = false;
    try {
      var a = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 128000
      });
      audioOk = !!(a && a.supported);
    } catch (e) {}

    supportCache = { ok: true, codec: found, audio: audioOk };
    return supportCache;
  }

  // ---------------------------------------------------------------- frame pulls

  function seekTo(video, t) {
    return new Promise(function (resolve) {
      if (Math.abs(video.currentTime - t) < 1e-4) { resolve(); return; }
      var done = false;
      function finish() { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('seeked', finish); resolve(); }
      var timer = setTimeout(finish, 3000);
      video.addEventListener('seeked', finish);
      try { video.currentTime = t; } catch (e) { finish(); }
    });
  }

  function loadVideo(src) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      v.src = src; v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0;';
      document.body.appendChild(v);
      v.addEventListener('loadeddata', function () { resolve(v); }, { once: true });
      v.addEventListener('error', function () { reject(new Error('Could not read that clip.')); }, { once: true });
      setTimeout(function () { reject(new Error('Timed out reading that clip.')); }, 20000);
    });
  }

  // ---------------------------------------------------------------- audio

  async function decodeAudio(src, ac) {
    try {
      var buf = await (await fetch(src)).arrayBuffer();
      return await ac.decodeAudioData(buf);
    } catch (e) { return null; }
  }

  // Lay every clip's trimmed audio into one continuous stereo buffer so the
  // encoder sees a single uninterrupted stream.
  async function buildAudioTimeline(items, spans) {
    var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return null;
    var total = spans.reduce(function (a, b) { return a + b; }, 0);
    var frames = Math.max(1, Math.ceil(total * AUDIO_RATE));
    var ctx = new AC(2, frames, AUDIO_RATE);
    var decoder = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: AUDIO_RATE });
    var any = false;
    var at = 0;
    for (var i = 0; i < items.length; i++) {
      var clip = items[i].clip;
      var start = Math.max(0, clip.trimStart || 0);
      var decoded = await decodeAudio(items[i].src, decoder);
      if (decoded) {
        any = true;
        var srcNode = ctx.createBufferSource();
        srcNode.buffer = decoded;
        srcNode.connect(ctx.destination);
        srcNode.start(at, Math.min(start, Math.max(0, decoded.duration - 0.01)), spans[i]);
      }
      at += spans[i];
    }
    try { decoder.close(); } catch (e) {}
    if (!any) return null;
    return await ctx.startRendering();
  }

  // ---------------------------------------------------------------- export

  async function exportSequence(opts) {
    var items = opts.items, brand = opts.brand, onProgress = opts.onProgress;
    var E = window.CaptionEngine;
    var res = RES[opts.aspect] || RES['9:16'];
    var W_ = res[0], H_ = res[1];

    var cap = await support(opts.aspect, opts.quality);
    if (!cap.ok) throw new Error(cap.reason);

    var spans = items.map(function (it) {
      var c = it.clip;
      var st = Math.max(0, c.trimStart || 0);
      var en = (c.trimEnd && c.trimEnd > st) ? c.trimEnd : (c.duration || 0);
      return Math.max(0.1, en - st);
    });
    var totalDur = spans.reduce(function (a, b) { return a + b; }, 0);
    var totalFrames = Math.max(1, Math.round(totalDur * FPS));

    var canvas = document.createElement('canvas');
    canvas.width = W_; canvas.height = H_;
    var ctx = canvas.getContext('2d', { alpha: false });

    // --- video track
    var vSamples = [];
    var vDescription = null;
    var encErr = null;
    var encoder = new VideoEncoder({
      output: function (chunk, meta) {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !vDescription) {
          vDescription = new Uint8Array(meta.decoderConfig.description);
        }
        var data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        vSamples.push({ data: data, size: data.length, key: chunk.type === 'key', offset: 0 });
      },
      error: function (e) { encErr = e; }
    });
    encoder.configure({
      codec: cap.codec, width: W_, height: H_,
      bitrate: BITRATES[opts.quality] || BITRATES.high,
      framerate: FPS, avc: { format: 'avc' },
      latencyMode: 'quality'
    });

    var cleanup = [];
    var frameIndex = 0;
    try {
      for (var i = 0; i < items.length; i++) {
        var clip = items[i].clip;
        var video = await loadVideo(items[i].src);
        cleanup.push(video);
        var start = Math.max(0, clip.trimStart || 0);
        var n = Math.max(1, Math.round(spans[i] * FPS));

        for (var f = 0; f < n; f++) {
          if (encErr) throw encErr;
          var localT = start + f / FPS;
          await seekTo(video, localT);

          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W_, H_);
          E.drawVideoCover(ctx, video, W_, H_, clip.rotate || 0);
          E.renderAll(ctx, W_, H_, clip, brand, localT, null);

          var vf = new VideoFrame(canvas, {
            timestamp: Math.round(frameIndex * 1e6 / FPS),
            duration: Math.round(1e6 / FPS)
          });
          encoder.encode(vf, { keyFrame: frameIndex % GOP === 0 });
          vf.close();
          frameIndex++;

          if (onProgress && (frameIndex % 5 === 0 || frameIndex === totalFrames)) {
            onProgress(Math.min(0.97, frameIndex / totalFrames));
          }
          // Yield so the encoder queue drains and the UI stays responsive.
          if (encoder.encodeQueueSize > 8) {
            while (encoder.encodeQueueSize > 4) await new Promise(function (r) { setTimeout(r, 4); });
          }
        }
      }
      await encoder.flush();
    } finally {
      try { if (encoder.state !== 'closed') encoder.close(); } catch (e) {}
      cleanup.forEach(function (v) { try { v.pause(); v.removeAttribute('src'); v.remove(); } catch (e) {} });
    }
    if (encErr) throw encErr;
    if (!vSamples.length) throw new Error('The encoder produced no frames.');
    if (!vDescription) throw new Error('The encoder gave no H.264 parameter sets.');

    var tracks = [{
      kind: 'video', width: W_, height: H_,
      timescale: VIDEO_TIMESCALE, sampleDelta: FRAME_TICKS,
      description: vDescription, samples: vSamples
    }];

    // --- audio track (optional: a silent clip beats a failed export)
    if (cap.audio) {
      try {
        var pcm = await buildAudioTimeline(items, spans);
        if (pcm) {
          var aSamples = [], aDescription = null, aErr = null;
          var aEnc = new AudioEncoder({
            output: function (chunk, meta) {
              if (meta && meta.decoderConfig && meta.decoderConfig.description && !aDescription) {
                aDescription = new Uint8Array(meta.decoderConfig.description);
              }
              var d = new Uint8Array(chunk.byteLength);
              chunk.copyTo(d);
              aSamples.push({ data: d, size: d.length, key: true, offset: 0 });
            },
            error: function (e) { aErr = e; }
          });
          aEnc.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 128000 });

          var L = pcm.getChannelData(0);
          var R = pcm.numberOfChannels > 1 ? pcm.getChannelData(1) : L;
          for (var p = 0; p < pcm.length; p += AAC_FRAME) {
            var count = Math.min(AAC_FRAME, pcm.length - p);
            var inter = new Float32Array(count * 2);
            inter.set(L.subarray(p, p + count), 0);
            inter.set(R.subarray(p, p + count), count);
            aEnc.encode(new AudioData({
              format: 'f32-planar', sampleRate: AUDIO_RATE,
              numberOfFrames: count, numberOfChannels: 2,
              timestamp: Math.round(p / AUDIO_RATE * 1e6),
              data: inter
            }));
          }
          await aEnc.flush();
          try { aEnc.close(); } catch (e) {}
          if (!aErr && aSamples.length && aDescription) {
            tracks.push({
              kind: 'audio', channels: 2, sampleRate: AUDIO_RATE,
              timescale: AUDIO_RATE, sampleDelta: AAC_FRAME,
              description: aDescription, samples: aSamples
            });
          }
        }
      } catch (e) { /* keep the video, drop the audio */ }
    }

    if (onProgress) onProgress(0.99);
    var blob = buildMp4(tracks);
    if (onProgress) onProgress(1);
    return { blob: blob, ext: 'mp4', mime: 'video/mp4', hasAudio: tracks.length > 1, fast: true };
  }

  // A hand-written muxer deserves a hand-check: decode the result before we hand
  // it over, and let the caller fall back if it will not play.
  function verify(blob, expectedSeconds) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var v = document.createElement('video');
      var done = false;
      function finish(ok, why) {
        if (done) return; done = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        try { v.remove(); } catch (e) {}
        resolve({ ok: ok, why: why });
      }
      var timer = setTimeout(function () { finish(false, 'timed out while checking the file'); }, 12000);
      v.preload = 'metadata'; v.muted = true; v.playsInline = true;
      v.addEventListener('loadeddata', function () {
        var d = v.duration;
        if (!isFinite(d) || d <= 0) return finish(false, 'no duration');
        if (!v.videoWidth || !v.videoHeight) return finish(false, 'no video dimensions');
        if (expectedSeconds && Math.abs(d - expectedSeconds) > Math.max(0.7, expectedSeconds * 0.15)) {
          return finish(false, 'duration ' + d.toFixed(2) + 's, expected ' + expectedSeconds.toFixed(2) + 's');
        }
        finish(true, '');
      });
      v.addEventListener('error', function () { finish(false, 'the browser could not decode it'); });
      v.src = url;
    });
  }

  window.FastExport = { present: present, support: support, exportSequence: exportSequence, verify: verify };
})();
