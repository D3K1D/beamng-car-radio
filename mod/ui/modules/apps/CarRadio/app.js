// CarRadio HUD app.
// The audio engine is a page-level singleton (window.__carRadioEngine) listening on
// $rootScope, so music keeps playing while BeamNG swaps UI screens (Esc menu, big map)
// and the app is torn down and rebuilt. The directive is only the controls.
// Opus packets arrive as 'CarRadioAudio' and are decoded with WebCodecs into a per-car
// jitter buffer (AudioWorklet) and that car's effects chain; car positions/condition
// arrive as 'CarRadioState' (camera-relative, ~60 Hz).
(function () {
  var VERSION = '0.1.2'

  // =====================================================================================
  // Engine
  // =====================================================================================
  function createEngine($rootScope) {
    var E = { version: VERSION, chains: {}, ctx: null, view: {}, viewListeners: [], lastState: null }

    // ---------------- settings (remembered in this browser profile)
    var CFG_KEY = 'carradio.settings'
    var defaults = { vol: 100, others: 100, bass: false, ultra: false, damage: true, muffleOwn: true, muffleOthers: true }
    E.cfg = (function () {
      try {
        var saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}')
        if (saved.muffle === false) { saved.muffleOwn = false; saved.muffleOthers = false } // 0.1.0 setting
        return Object.assign({}, defaults, saved)
      } catch (e) { return Object.assign({}, defaults) }
    })()
    E.saveCfg = function () {
      var c = E.cfg
      c.vol = Math.max(0, Math.min(1000, Number(c.vol) || 0))
      c.others = Math.max(0, Math.min(200, Number(c.others) || 0))
      try { localStorage.setItem(CFG_KEY, JSON.stringify(c)) } catch (e) {}
      applyVolumes()
      sendMeta()
    }
    // Your car's volume and bass are shared, so others hear your car as you set it.
    function sendMeta() { bngApi.engineLua('carradio_main.setMeta(' + E.cfg.vol + ',' + (E.cfg.bass ? 'true' : 'false') + ')') }
    setInterval(sendMeta, 3000) // also covers a Lua reload

    E.media = function (cmd) { ensureAudio(); bngApi.engineLua('carradio_main.media("' + cmd + '")') }

    // ---------------- audio graph
    var ctx = null, master = null, ownBus = null, othersBus = null, workletReady = null
    var chains = E.chains

    function ensureAudio() {
      if (ctx) { if (ctx.state !== 'running') ctx.resume(); return workletReady }
      ctx = E.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' })
      master = ctx.createGain()
      ownBus = ctx.createGain(); othersBus = ctx.createGain()
      ownBus.connect(master); othersBus.connect(master)
      master.connect(ctx.destination)
      applyVolumes()
      var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
      workletReady = ctx.audioWorklet.addModule(url).then(function () {
        URL.revokeObjectURL(url)
        var limiter = new AudioWorkletNode(ctx, 'carradio-limiter', { outputChannelCount: [2],
          processorOptions: Object.assign({}, window.__crDebug && window.__crDebug.limiter) }) // tuning overrides: test pages only
        master.disconnect(); master.connect(limiter); limiter.connect(ctx.destination)
        E.limiter = limiter
        return true
      })
      ctx.resume()
      if (window.__crDebug) window.__crDebug.engine = E // test pages only
      E.master = master
      return workletReady
    }
    E.ensureAudio = ensureAudio

    function applyVolumes() {
      if (!ctx) return
      // Own car at your volume; other cars at their owner's volume (per chain) times "Other cars".
      ownBus.gain.setTargetAtTime(0.6 * E.cfg.vol / 100, ctx.currentTime, 0.03)
      othersBus.gain.setTargetAtTime(0.6 * E.cfg.others / 100, ctx.currentTime, 0.03)
    }

    function satCurve(d) { var n = 4096, c = new Float32Array(n); for (var i = 0; i < n; i++) { var x = i * 2 / (n - 1) - 1; c[i] = Math.tanh(d * x) / d } return c }
    function noiseBuffer() { var len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0); for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; return b }
    function roomImpulse(size) {
      var decay = 0.12 + 0.7 * size, pre = Math.floor(ctx.sampleRate * (0.002 + 0.016 * size)), len = pre + Math.floor(ctx.sampleRate * decay)
      var b = ctx.createBuffer(2, len, ctx.sampleRate)
      for (var c = 0; c < 2; c++) { var d = b.getChannelData(c); for (var i = pre; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - (i - pre) / (len - pre), 3) }
      return b
    }
    function biquad(type, f, q, g) { var n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; if (g != null) n.gain.value = g; return n }
    function gain(v) { var n = ctx.createGain(); n.gain.value = v; return n }

    // One car radio: player -> owner volume -> damage -> crash -> power -> bass -> cabin EQ -> muffle -> 3D/even/room.
    function createChain(key) {
      var own = key === 'own'
      var c = { key: key, own: own, lastAudio: performance.now(), roomSize: -1, cond: newCond() }
      c.player = new AudioWorkletNode(ctx, 'carradio-player', { numberOfInputs: 0, outputChannelCount: [2],
        processorOptions: { targetMs: own ? 60 : 250 } }) // other cars: more buffer against network jitter
      c.level = gain(0.5)
      c.ownerVol = gain(1) // other cars: their owner's volume setting
      c.dmgHP = biquad('highpass', 20); c.dmgLP = biquad('lowpass', 20000)
      c.shaper = ctx.createWaveShaper(); c.shaper.curve = satCurve(5); c.shaper.oversample = '2x'
      c.dry = gain(1); c.wet = gain(0); c.cut = gain(1)
      c.crashLP = biquad('lowpass', 20000)
      c.crashShaper = ctx.createWaveShaper(); c.crashShaper.curve = satCurve(5); c.crashShaper.oversample = '2x'
      c.crashDry = gain(1); c.crashWet = gain(0); c.crashOut = gain(1)
      c.noise = ctx.createBufferSource(); c.noise.buffer = noiseBuffer(); c.noise.loop = true
      c.staticGain = gain(0)
      c.power = gain(1)
      c.bassBoost = biquad('lowshelf', 90, null, 0); c.bassTrim = gain(1)
      c.eqLow = biquad('lowshelf', 120, null, 0); c.eqBox = biquad('peaking', 350, 1, 0)
      c.eqPres = biquad('peaking', 2500, 1.2, 0); c.eqHigh = biquad('highshelf', 9000, null, 0)
      c.muffle = biquad('lowpass', 20000)
      c.posGain = gain(1); c.directGain = gain(0); c.reverbSend = gain(0)
      c.panner = ctx.createPanner()
      c.panner.panningModel = 'HRTF'; c.panner.distanceModel = 'inverse'; c.panner.refDistance = 2; c.panner.rolloffFactor = 1; c.panner.maxDistance = 10000
      c.convolver = ctx.createConvolver()
      c.out = gain(0) // faded in once the car is known
      c.player.connect(c.level); c.level.connect(c.ownerVol); c.ownerVol.connect(c.dmgHP); c.dmgHP.connect(c.dmgLP)
      c.dmgLP.connect(c.dry); c.dmgLP.connect(c.shaper); c.shaper.connect(c.wet)
      c.dry.connect(c.cut); c.wet.connect(c.cut)
      c.cut.connect(c.crashLP); c.crashLP.connect(c.crashDry); c.crashLP.connect(c.crashShaper); c.crashShaper.connect(c.crashWet)
      c.crashDry.connect(c.crashOut); c.crashWet.connect(c.crashOut); c.crashOut.connect(c.power)
      c.noise.connect(biquad('bandpass', 2500, 0.7)).connect(c.staticGain); c.staticGain.connect(c.power); c.noise.start()
      c.power.connect(c.bassBoost); c.bassBoost.connect(c.bassTrim)
      c.bassTrim.connect(c.eqLow); c.eqLow.connect(c.eqBox); c.eqBox.connect(c.eqPres); c.eqPres.connect(c.eqHigh); c.eqHigh.connect(c.muffle)
      c.muffle.connect(c.posGain); c.posGain.connect(c.panner); c.panner.connect(c.out)
      c.muffle.connect(c.directGain); c.directGain.connect(c.out)
      c.muffle.connect(c.reverbSend); c.reverbSend.connect(c.convolver); c.convolver.connect(c.out)
      c.out.connect(own ? ownBus : othersBus)
      if (own) {
        c.bassMeter = ctx.createAnalyser(); c.bassMeter.fftSize = 1024; c.bassBuf = new Float32Array(1024)
        c.bassTrim.connect(biquad('lowpass', 120)).connect(c.bassMeter)
      }
      c.decoder = new AudioDecoder({
        output: function (ad) {
          var n = ad.numberOfFrames, l = new Float32Array(n), r = new Float32Array(n)
          ad.copyTo(l, { planeIndex: 0, format: 'f32-planar' })
          if (ad.numberOfChannels > 1) ad.copyTo(r, { planeIndex: 1, format: 'f32-planar' }); else r.set(l)
          ad.close()
          c.player.port.postMessage({ l: l, r: r }, [l.buffer, r.buffer])
        },
        error: function (e) { console.warn('CarRadio decoder', key, e); c.broken = true }
      })
      c.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 })
      c.ts = 0
      chains[key] = c
      return c
    }

    function destroyChain(key) {
      var c = chains[key]
      if (!c) return
      delete chains[key]
      try { c.decoder.close() } catch (e) {}
      try { c.noise.stop() } catch (e) {}
      try { c.out.disconnect(); c.player.disconnect() } catch (e) {}
      if (key === 'own') sendBass(0, true)
    }

    function b64ToBytes(b64) { var s = atob(b64), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u }

    $rootScope.$on('CarRadioAudio', function (e, m) {
      ensureAudio().then(function () {
        var c = chains[m.k] || createChain(m.k)
        if (c.broken) { destroyChain(m.k); return }
        c.lastAudio = performance.now()
        for (var i = 0; i < m.p.length; i++) {
          if (c.decoder.state !== 'configured') break
          c.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.ts, duration: 20000, data: b64ToBytes(m.p[i]) }))
          c.ts += 20000
        }
      })
    })

    // ---------------- car condition (damage, ignition, size) per chain
    var DMG = { light: 10, heavy: 150, wreck: 500, crashDelta: 2 }
    function newCond() { return { prevDpk: null, wrecked: false, lastCrash: -1, cutUntil: 0, accum: 0 } }

    function crash(c, severity) {
      var now = ctx.currentTime, dur = Math.min(1.5, 0.25 + severity / 30), depth = Math.max(0.3, 0.55 - severity / 200)
      ;[[c.crashOut.gain, depth, 1], [c.crashLP.frequency, Math.max(900, 3500 - severity * 40), 20000],
        [c.crashWet.gain, Math.min(1, 0.6 + severity / 60), 0], [c.crashDry.gain, 0.6, 1]].forEach(function (p) {
        p[0].cancelScheduledValues(now); p[0].setTargetAtTime(p[1], now, 0.01); p[0].setTargetAtTime(p[2], now + dur, 0.25)
      })
      c.cond.cutUntil = now + dur
    }

    function crackle(c, h) {
      var now = ctx.currentTime, dur = 0.03 + Math.random() * 0.09
      if (now < c.cond.cutUntil) return
      c.cut.gain.setTargetAtTime(0.35, now, 0.003); c.cut.gain.setTargetAtTime(1, now + dur, 0.01)
      c.staticGain.gain.setTargetAtTime(0.01 + 0.02 * h, now, 0.002); c.staticGain.gain.setTargetAtTime(0, now + dur, 0.01)
    }

    function applyCar(c, r, paused) {
      var cfg = E.cfg, now = ctx.currentTime, cond = c.cond, inside = !!r.inside
      // Position and the inside/outside mix. Paused = clean stereo (keeps playing).
      var p = r.rel, pan = c.panner
      if (pan.positionX) { pan.positionX.setTargetAtTime(p[0], now, 0.03); pan.positionY.setTargetAtTime(p[1], now, 0.03); pan.positionZ.setTargetAtTime(p[2], now, 0.03) }
      else pan.setPosition(p[0], p[1], p[2])
      c.posGain.gain.setTargetAtTime(paused ? 0 : inside ? 0.35 : 1, now, 0.08)
      c.directGain.gain.setTargetAtTime(paused ? 1 : inside ? 0.65 : 0, now, 0.08)
      var muffleSetting = c.own ? cfg.muffleOwn : cfg.muffleOthers
      c.muffle.frequency.setTargetAtTime(muffleSetting && !inside && !paused ? 900 : 20000, now, 0.08)
      c.out.gain.setTargetAtTime(1, now, 0.05)
      // Other cars: their owner's volume and bass setting.
      var bassOn = c.own ? cfg.bass : !!r.bass
      if (!c.own) c.ownerVol.gain.setTargetAtTime((r.vol != null ? r.vol : 100) / 100, now, 0.05)
      // Damage
      var dmgOn = cfg.damage && !paused, dpk = r.damagePerKg
      if (!cfg.damage) cond.wrecked = false
      if (dpk != null && !dmgOn) {
        cond.prevDpk = dpk
        c.dmgHP.frequency.setTargetAtTime(20, now, 0.1); c.dmgLP.frequency.setTargetAtTime(20000, now, 0.1)
        c.wet.gain.setTargetAtTime(0, now, 0.1); c.dry.gain.setTargetAtTime(1, now, 0.1)
      } else if (dpk != null) {
        if (cond.prevDpk != null) {
          if (dpk < cond.prevDpk * 0.5 && cond.prevDpk > DMG.light) cond.wrecked = false
          var delta = dpk - cond.prevDpk
          if (now - cond.lastCrash < 0.3 && delta > DMG.crashDelta * 0.25) { cond.accum += delta; cond.lastCrash = now; crash(c, cond.accum) }
          else if (delta > DMG.crashDelta && now - cond.lastCrash >= 0.3) { cond.accum = delta; cond.lastCrash = now; crash(c, delta) }
        }
        cond.prevDpk = dpk
        if (!cond.wrecked && dpk > DMG.wreck) { cond.wrecked = true; c.staticGain.gain.setTargetAtTime(0.03, now, 0.005); c.staticGain.gain.setTargetAtTime(0, now + 0.3, 0.05) }
        var h = Math.max(0, Math.min(1, (dpk - DMG.light) / (DMG.heavy - DMG.light)))
        c.dmgHP.frequency.setTargetAtTime(20 + h * 230, now, 0.2); c.dmgLP.frequency.setTargetAtTime(20000 - h * 16500, now, 0.2)
        c.wet.gain.setTargetAtTime(h * 0.6, now, 0.2); c.dry.gain.setTargetAtTime(1 - h * 0.45, now, 0.2)
        if (h > 0.05 && Math.random() < h * 0.04) crackle(c, h)
      }
      // Ignition: 0 off, 1 accessory, 2 on, 3 cranking; unknown = on.
      var ig = r.ignition
      var pw = cond.wrecked ? 0 : (ig == null || ig === 1 || ig === 2) ? 1 : ig === 3 ? 0.55 : ig >= 1 ? 1 : 0
      c.power.gain.setTargetAtTime(pw, now, cond.wrecked ? 0.3 : 0.12)
      // Cabin character by vehicle length.
      var size = r.length ? Math.max(0, Math.min(1, (r.length - 3.5) / 10.5)) : 0.1
      if (Math.abs(size - c.roomSize) > 0.05) { c.convolver.buffer = roomImpulse(size); c.roomSize = size }
      var amt = paused ? 0 : inside ? 1 : 0.5
      function lerp(a, b) { return a + (b - a) * size }
      c.eqLow.gain.setTargetAtTime(lerp(4, 1.5) * amt, now, 0.1); c.eqBox.gain.setTargetAtTime(lerp(-1.5, -0.5) * amt, now, 0.1)
      c.eqPres.gain.setTargetAtTime(amt, now, 0.1); c.eqHigh.gain.setTargetAtTime(lerp(-3, -1.5) * amt, now, 0.1)
      c.reverbSend.gain.setTargetAtTime(inside && !paused ? lerp(0.1, 0.35) : 0, now, 0.1)
      // Bass boost: the car owner's stereo EQ (heavier, not louder).
      c.bassBoost.gain.setTargetAtTime(bassOn ? 9 : 0, now, 0.15)
      c.bassTrim.gain.setTargetAtTime(bassOn ? 0.6 : 1, now, 0.15)
      if (c.own) updateBassShake(c, paused)
    }

    // ---------------- bass shake (own car only)
    var BASS_SCALE = 1.4, bass = { env: 0, lastSent: -1, lastAt: 0 }
    function sendBass(x, force) {
      var t = performance.now()
      if (!force && t - bass.lastAt < 33) return
      if (!force && x < 0.01 && bass.lastSent < 0.01) return
      bass.lastSent = x; bass.lastAt = t
      bngApi.engineLua('carradio_main.setBass(' + x.toFixed(3) + ',' + (E.cfg.ultra ? 5 : 1) + ')')
    }
    function updateBassShake(c, paused) {
      if (!E.cfg.bass || paused) { bass.env = 0; sendBass(0); return }
      c.bassMeter.getFloatTimeDomainData(c.bassBuf)
      var sum = 0
      for (var i = 0; i < c.bassBuf.length; i++) sum += c.bassBuf[i] * c.bassBuf[i]
      var raw = Math.sqrt(sum / c.bassBuf.length) * BASS_SCALE * E.cfg.vol / 100
      bass.env = raw > bass.env ? raw : bass.env * 0.85
      sendBass(bass.env)
    }

    // ---------------- state from game Lua
    var tick = 0
    $rootScope.$on('CarRadioState', function (e, s) {
      E.lastState = s
      if (ctx) {
        if (ctx.state === 'suspended' && tick % 60 === 0) ctx.resume()
        var seen = {}
        for (var i = 0; i < s.radios.length; i++) {
          var r = s.radios[i], c = chains[r.k]
          seen[r.k] = true
          if (c) applyCar(c, r, !!s.paused)
        }
        var now = performance.now()
        for (var k in chains) {
          var ch = chains[k]
          if (!seen[k]) ch.out.gain.setTargetAtTime(0, ctx.currentTime, 0.1) // car unknown here: silent
          if (now - ch.lastAudio > 5000) destroyChain(k)
        }
      }
      if (++tick % 15 === 0) updateView(s)
    })

    function updateView(s) {
      var v = E.view, c = s.companion
      v.companion = !!c
      v.playing = !!(c && c.playing)
      v.nowPlaying = c && c.title ? (c.artist ? c.artist + ' – ' + c.title : c.title) : ''
      v.companionText = !c ? 'CarRadio Companion is not running. Start it to play music.'
        : c.capturing ? 'Playing ' + (c.source || 'a program') + ' through your car'
        : 'Companion connected. Pick a program in it and press Start.'
      var others = s.radios.filter(function (r) { return r.k !== 'own' }).length
      if (!s.mp) v.mpText = ''
      else if (!s.relay) v.mpText = 'Multiplayer: this server has no CarRadio relay'
      else if (s.relay.state === 'connected') v.mpText = 'Multiplayer: connected, ' + others + ' other radio' + (others === 1 ? '' : 's') + ' nearby'
      else v.mpText = 'Multiplayer: relay ' + s.relay.state + (s.relay.error ? ' (' + s.relay.error + ')' : '')
      E.viewListeners.forEach(function (f) { f() })
    }

    // ---------------- worklets: jitter-buffered player + two-band look-ahead limiter
    var WORKLET_SRC = [
      // Player: ring buffer fed with decoded stereo chunks; starts once targetMs is buffered,
      // rebuffers after an underrun, and skips ahead if more than targetMs + 250 ms piles up.
      "class CarRadioPlayer extends AudioWorkletProcessor {",
      "  constructor(o) {",
      "    super(); var n = sampleRate * 3; this.l = new Float32Array(n); this.r = new Float32Array(n); this.size = n",
      "    this.w = 0; this.rd = 0; this.avail = 0; this.playing = false",
      "    this.target = Math.round(sampleRate * ((o.processorOptions && o.processorOptions.targetMs) || 100) / 1000)",
      "    this.port.onmessage = (e) => { var l = e.data.l, r = e.data.r, n = l.length",
      "      for (var i = 0; i < n; i++) { this.l[this.w] = l[i]; this.r[this.w] = r[i]; this.w = (this.w + 1) % this.size }",
      "      this.avail = Math.min(this.size, this.avail + n)",
      "      if (this.avail > this.target + sampleRate * 0.25) { var skip = this.avail - this.target; this.rd = (this.rd + skip) % this.size; this.avail -= skip } }",
      "  }",
      "  process(inputs, outputs) {",
      "    var out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length",
      "    if (!this.playing && this.avail >= this.target) this.playing = true",
      "    if (!this.playing || this.avail < n) { this.playing = false; L.fill(0); if (R !== L) R.fill(0); return true }",
      "    for (var i = 0; i < n; i++) { L[i] = this.l[this.rd]; R[i] = this.r[this.rd]; this.rd = (this.rd + 1) % this.size }",
      "    this.avail -= n; return true",
      "  }",
      "}",
      "registerProcessor('carradio-player', CarRadioPlayer)",
      // Limiter, two stages:
      //  1. Bass band (< 150 Hz, 4th-order split; high = input - low, so it sums back exactly)
      //     gets its own gentle compressor, so a heavy bass hit turns down the bass, not the song.
      //  2. A 3 ms look-ahead peak limiter at -1 dBFS on the result, transparent below it.
      "class CarRadioLimiter extends AudioWorkletProcessor {",
      "  constructor(o) { super(); this.bandOn = !(o && o.processorOptions && o.processorOptions.singleBand)",
      "    var w0 = 2 * Math.PI * 150 / sampleRate, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al",
      "    this.b0 = (1 - cs) / 2 / a0; this.b1 = (1 - cs) / a0; this.b2 = this.b0; this.a1 = -2 * cs / a0; this.a2 = (1 - al) / a0",
      "    this.z = new Float64Array(8)", // 2 channels x 2 cascaded biquads x 2 state values
      "    var po = (o && o.processorOptions) || {}; this.env = 0; this.gl = 1; this.lowTh = po.lowTh || 0.3",
      "    this.envAtt = 1 - Math.exp(-1 / (sampleRate * (po.lowAttMs || 2) / 1000)); this.envRel = 1 - Math.exp(-1 / (sampleRate * 0.25))",
      "    this.L = Math.max(64, Math.round(sampleRate * 0.003)); this.R = this.L + 1; this.ceiling = 0.891",
      "    this.d0 = new Float32Array(this.R); this.d1 = new Float32Array(this.R); this.need = new Float32Array(this.R)",
      "    this.dq = new Int32Array(this.R + 1); this.h = 0; this.t = 0; this.n = 0; this.g = 1",
      "    this.att = 1 - Math.exp(-1 / (sampleRate * 0.0015)); this.rel = 1 - Math.exp(-1 / (sampleRate * 0.25)) }",
      "  lp(x, k) { var z = this.z, y = this.b0 * x + z[k]; z[k] = this.b1 * x - this.a1 * y + z[k + 1]; z[k + 1] = this.b2 * x - this.a2 * y; return y }",
      "  process(inputs, outputs) {",
      "    var inp = inputs[0], out = outputs[0]; if (!out || !out.length) return true",
      "    var frames = out[0].length, L = this.L, R = this.R, Q = R + 1, a = inp && inp[0], b = inp && inp[1] ? inp[1] : a",
      "    for (var i = 0; i < frames; i++) {",
      "      var xl = a ? a[i] : 0, xr = b ? b[i] : 0",
      "      if (this.bandOn) {",
      "        var lowL = this.lp(this.lp(xl, 0), 2), lowR = this.lp(this.lp(xr, 4), 6)",
      "        var lv = Math.max(lowL < 0 ? -lowL : lowL, lowR < 0 ? -lowR : lowR)",
      "        this.env += (lv - this.env) * (lv > this.env ? this.envAtt : this.envRel)",
      "        var tgl = this.env > this.lowTh ? this.lowTh / this.env : 1; this.gl += (tgl - this.gl) * (tgl < this.gl ? 0.02 : 0.0005)",
      "        xl = xl - lowL + lowL * this.gl; xr = xr - lowR + lowR * this.gl",
      "      }",
      "      var pk = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr)",
      "      var need = pk > this.ceiling ? this.ceiling / pk : 1, idx = this.n, slot = idx % R",
      "      var ol = this.d0[slot], or = this.d1[slot], on = idx >= R ? this.need[slot] : 1",
      "      this.d0[slot] = xl; this.d1[slot] = xr",
      "      while (this.t > this.h && this.dq[this.h % Q] < idx - L) this.h++",
      "      var wm = Math.min(on, this.t > this.h ? this.need[this.dq[this.h % Q] % R] : 1)",
      "      while (this.t > this.h && this.need[this.dq[(this.t - 1) % Q] % R] >= need) this.t--",
      "      this.need[slot] = need; this.dq[this.t % Q] = idx; this.t++",
      "      var tg = Math.min(wm, need); this.g += (tg - this.g) * (tg < this.g ? this.att : this.rel)",
      "      var g = Math.min(this.g, on); out[0][i] = ol * g; if (out.length > 1) out[1][i] = or * g; this.n++",
      "    }",
      "    return true",
      "  }",
      "}",
      "registerProcessor('carradio-limiter', CarRadioLimiter)"
    ].join('\n')

    // Start right away so other players' radios play without any click.
    ensureAudio()
    sendMeta()
    return E
  }

  // =====================================================================================
  // HUD app (controls only; safe to be destroyed and rebuilt by BeamNG at any time)
  // =====================================================================================
  angular.module('beamng.apps')
  .directive('carRadio', ['$rootScope', '$compile', function ($rootScope, $compile) {
    var PANEL = `
<div class="cr-panel-float" ng-show="ui.panel">
  <div class="cr-panel-head"><b>CarRadio</b><span class="cr-dim"> {{E.version}}</span><button class="cr-close" ng-click="togglePanel()" title="Close">&#10005;</button></div>
  <div class="cr-np" ng-if="E.view.nowPlaying">&#9835; {{E.view.nowPlaying}}</div>
  <div ng-class="{'cr-warn': !E.view.companion}">{{E.view.companionText}}</div>
  <div class="cr-dim" ng-if="E.view.mpText">{{E.view.mpText}}</div>
  <div class="cr-sec">Volume</div>
  <div class="cr-row"><span class="cr-lbl">My car</span>
    <input class="cr-vol" type="range" min="0" max="1000" step="5" ng-model="E.cfg.vol" ng-change="E.saveCfg()" ng-dblclick="E.cfg.vol = 100; E.saveCfg()">
    <span class="cr-pct">{{E.cfg.vol}}%</span></div>
  <div class="cr-row"><span class="cr-lbl">Other cars</span>
    <input class="cr-vol" type="range" min="0" max="200" step="5" ng-model="E.cfg.others" ng-change="E.saveCfg()" ng-dblclick="E.cfg.others = 100; E.saveCfg()">
    <span class="cr-pct">{{E.cfg.others}}%</span></div>
  <div class="cr-hint">Other cars play at their owner's volume; this scales all of them for you.</div>
  <div class="cr-sec">Sound</div>
  <label class="cr-row"><input type="checkbox" ng-model="E.cfg.muffleOwn" ng-change="E.saveCfg()"> Muffle my car when viewed from outside</label>
  <label class="cr-row"><input type="checkbox" ng-model="E.cfg.muffleOthers" ng-change="E.saveCfg()"> Muffle other cars from outside</label>
  <label class="cr-row"><input type="checkbox" ng-model="E.cfg.damage" ng-change="E.saveCfg()"> Damage effects</label>
  <label class="cr-row"><input type="checkbox" ng-model="E.cfg.bass" ng-change="E.saveCfg()"> Bass boost (shakes the car when loud)</label>
  <div class="cr-row"><button class="cr-ultra" ng-class="{on: E.cfg.ultra}" ng-click="E.cfg.ultra = !E.cfg.ultra; E.saveCfg()" title="Multiplies the bass shake by 5">ULTRA BASS BOOST{{E.cfg.ultra ? ' ON' : ''}}</button></div>
</div>`

    var STYLE = `
.cr-bar { display:flex; align-items:center; gap:6px; height:40px; padding:0 8px; border-radius:20px; background:rgba(18,18,22,0.88); box-sizing:border-box; font:12px/1.35 sans-serif; color:#eee }
.cr-btn { width:28px; height:28px; border-radius:14px; border:0; padding:0; cursor:pointer; flex:none; background:rgba(255,255,255,0.12); color:#fff; font-size:12px; line-height:28px; text-align:center }
.cr-btn:hover { background:rgba(255,255,255,0.22) }
.cr-btn.on { background:#ff6a00 }
.cr-btn.cr-play { width:32px; height:32px; border-radius:16px; font-size:13px }
.cr-bass { font-weight:800 }
.cr-vol { flex:1; min-width:50px; accent-color:#ff6a00; cursor:pointer }
.cr-pct { width:42px; text-align:right; font-variant-numeric:tabular-nums; opacity:0.85; flex:none }
.cr-panel-float { position:fixed; top:90px; right:24px; width:340px; max-height:calc(100vh - 140px); overflow:auto; z-index:10000; padding:12px 14px; border-radius:12px;
  background:rgba(18,18,22,0.95); box-shadow:0 8px 30px rgba(0,0,0,0.5); font:12.5px/1.45 sans-serif; color:#eee; box-sizing:border-box }
.cr-panel-head { display:flex; align-items:center; gap:6px; margin-bottom:8px; font-size:14px }
.cr-close { margin-left:auto; border:0; background:transparent; color:#ccc; font-size:15px; cursor:pointer }
.cr-np { color:#ffb36b; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.cr-sec { margin:12px 0 2px; font-size:11px; text-transform:uppercase; letter-spacing:1px; opacity:0.6 }
.cr-row { display:flex; align-items:center; gap:8px; margin:6px 0 }
.cr-lbl { width:72px; flex:none }
.cr-hint { font-size:11px; opacity:0.55; margin-top:-2px }
.cr-dim { opacity:0.7 }
.cr-warn { color:#ffb36b }
.cr-ultra { font-weight:800; letter-spacing:0.5px; border:1px solid #ff6a00; background:transparent; color:#ff6a00; border-radius:4px; padding:3px 8px; cursor:pointer }
.cr-ultra.on { background:#ff6a00; color:#000 }`

    return {
      template: `
<div style="width:100%;height:100%">
  <div class="cr-bar">
    <button class="cr-btn" ng-click="E.media('prev')" title="Previous">&#9198;</button>
    <button class="cr-btn cr-play" ng-class="{on: E.view.playing}" ng-click="E.media('playpause')" title="Play / pause"><span ng-if="E.view.playing">&#10074;&#10074;</span><span ng-if="!E.view.playing">&#9654;</span></button>
    <button class="cr-btn" ng-click="E.media('next')" title="Next">&#9197;</button>
    <input class="cr-vol" type="range" min="0" max="1000" step="5" ng-model="E.cfg.vol" ng-change="E.saveCfg()" ng-dblclick="E.cfg.vol = 100; E.saveCfg()" title="Your car's volume (double-click for 100%)">
    <span class="cr-pct">{{E.cfg.vol}}%</span>
    <button class="cr-btn cr-bass" ng-class="{on: E.cfg.bass}" ng-click="E.cfg.bass = !E.cfg.bass; E.saveCfg()" title="Bass boost">B</button>
    <button class="cr-btn" ng-class="{on: ui.panel}" ng-click="togglePanel()" title="Settings">&#9881;</button>
  </div>
</div>`,
      replace: true,
      restrict: 'EA',
      scope: true,
      link: function (scope, element) {
        var E = window.__carRadioEngine || (window.__carRadioEngine = createEngine($rootScope))
        scope.E = E
        scope.ui = { panel: false }

        if (!document.getElementById('carradio-style')) {
          var st = document.createElement('style'); st.id = 'carradio-style'; st.textContent = STYLE; document.head.appendChild(st)
        }
        // Settings live in a floating window on the page, so the HUD slot never clips them.
        var panel = $compile(PANEL)(scope)
        document.body.appendChild(panel[0])
        scope.togglePanel = function () { scope.ui.panel = !scope.ui.panel; E.ensureAudio() }

        var onView = function () { scope.$evalAsync(angular.noop) }
        E.viewListeners.push(onView)
        element[0].addEventListener('pointerdown', function () { E.ensureAudio() })

        scope.$on('$destroy', function () {
          // Only the controls go away; the engine keeps playing.
          var i = E.viewListeners.indexOf(onView); if (i >= 0) E.viewListeners.splice(i, 1)
          panel.remove()
        })
      }
    }
  }])
})()
