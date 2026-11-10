// CarRadio HUD app: renders every car radio (yours and, on BeamMP, other players') in 3D.
// Opus packets arrive from game Lua ('CarRadioAudio'), are decoded with WebCodecs and fed
// to a per-car jitter buffer (AudioWorklet), then through that car's effects chain.
// Car positions/condition arrive as 'CarRadioState' (camera-relative, ~60 Hz).
angular.module('beamng.apps')
.directive('carRadio', [function () {
  return {
    template: `
<div style="width:100%;height:100%;overflow:auto;box-sizing:border-box;font:12px/1.35 sans-serif;color:#eee">
  <style>
    .cr-bar { display:flex; align-items:center; gap:8px; height:40px; padding:0 10px; border-radius:20px; background:rgba(18,18,22,0.88); box-sizing:border-box }
    .cr-btn { width:28px; height:28px; border-radius:14px; border:0; padding:0; cursor:pointer; flex:none; background:rgba(255,255,255,0.12); color:#fff; font-size:13px; line-height:28px; text-align:center }
    .cr-btn:hover { background:rgba(255,255,255,0.22) }
    .cr-btn.on { background:#ff6a00 }
    .cr-bass { font-weight:800; font-size:12px }
    .cr-vol { flex:1; min-width:60px; accent-color:#ff6a00; cursor:pointer }
    .cr-pct { width:42px; text-align:right; font-variant-numeric:tabular-nums; opacity:0.85; flex:none }
    .cr-panel { margin-top:6px; padding:10px; border-radius:10px; background:rgba(18,18,22,0.88) }
    .cr-row { display:flex; align-items:center; gap:8px; margin:5px 0 }
    .cr-row .cr-vol { min-width:80px }
    .cr-dim { opacity:0.7 }
    .cr-warn { color:#ffb36b }
    .cr-ultra { font-weight:800; letter-spacing:0.5px; border:1px solid #ff6a00; background:transparent; color:#ff6a00; border-radius:4px; padding:3px 8px; cursor:pointer }
    .cr-ultra.on { background:#ff6a00; color:#000 }
  </style>
  <div class="cr-bar">
    <button class="cr-btn" ng-class="{on: radioOn}" ng-click="togglePower()" title="{{radioOn ? 'Turn radio off' : 'Turn radio on'}}"><span ng-if="radioOn">&#9632;</span><span ng-if="!radioOn">&#9654;</span></button>
    <input class="cr-vol" type="range" min="0" max="1000" step="5" ng-model="cfg.vol" ng-change="saveCfg()" ng-dblclick="cfg.vol = 100; saveCfg()" title="Your radio volume (double-click for 100%)">
    <span class="cr-pct">{{cfg.vol}}%</span>
    <button class="cr-btn cr-bass" ng-class="{on: cfg.bass}" ng-click="cfg.bass = !cfg.bass; saveCfg()" title="Bass boost (shakes the car when loud)">B</button>
    <button class="cr-btn" ng-class="{on: ui.panel}" ng-click="togglePanel()" title="Settings">&#9881;</button>
  </div>
  <div class="cr-panel" ng-if="ui.panel">
    <div ng-class="{'cr-warn': !status.companion}">{{status.companionText}}</div>
    <div class="cr-dim" ng-if="status.mpText">{{status.mpText}}</div>
    <div class="cr-row"><span style="width:90px">Other cars</span>
      <input class="cr-vol" type="range" min="0" max="200" step="5" ng-model="cfg.others" ng-change="saveCfg()" ng-dblclick="cfg.others = 100; saveCfg()">
      <span class="cr-pct">{{cfg.others}}%</span></div>
    <div class="cr-row"><label><input type="checkbox" ng-model="cfg.damage" ng-change="saveCfg()"> Damage effects</label></div>
    <div class="cr-row"><label><input type="checkbox" ng-model="cfg.muffle" ng-change="saveCfg()"> Muffle outside the car</label></div>
    <div class="cr-row"><button class="cr-ultra" ng-class="{on: cfg.ultra}" ng-click="cfg.ultra = !cfg.ultra; saveCfg()" title="Multiplies the bass shake by 5">ULTRA BASS BOOST{{cfg.ultra ? ' ON' : ''}}</button></div>
    <div class="cr-dim" style="margin-top:6px">CarRadio {{version}}</div>
  </div>
</div>`,
    replace: true,
    restrict: 'EA',
    scope: true,
    link: function (scope, element) {
      var VERSION = '0.1.0'
      scope.version = VERSION
      scope.ui = { panel: false }
      scope.radioOn = false
      scope.status = { companion: false, companionText: 'Looking for CarRadio Companion…', mpText: '' }

      // ---------------- settings (remembered in this browser profile)
      var CFG_KEY = 'carradio.settings'
      var defaults = { vol: 100, others: 100, bass: false, ultra: false, damage: true, muffle: true }
      scope.cfg = (function () { try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')) } catch (e) { return Object.assign({}, defaults) } })()
      scope.saveCfg = function () {
        scope.cfg.vol = Math.max(0, Math.min(1000, Number(scope.cfg.vol) || 0))
        scope.cfg.others = Math.max(0, Math.min(200, Number(scope.cfg.others) || 0))
        try { localStorage.setItem(CFG_KEY, JSON.stringify(scope.cfg)) } catch (e) {}
        applyVolumes()
      }

      // The HUD slot is sized for the slim bar; grow it while the panel is open.
      var host = null, hostHeight = null
      scope.togglePanel = function () {
        scope.ui.panel = !scope.ui.panel
        if (!host) { var el = element[0].parentElement; for (var i = 0; i < 5 && el; i++) { if (el.style && /px$/.test(el.style.height)) { host = el; break } el = el.parentElement } }
        if (!host) return
        if (scope.ui.panel) { hostHeight = host.style.height; host.style.height = '250px' } else if (hostHeight) host.style.height = hostHeight
      }

      scope.togglePower = function () {
        ensureAudio()
        scope.radioOn = !scope.radioOn
        bngApi.engineLua('carradio_main.setOn(' + (scope.radioOn ? 'true' : 'false') + ')')
        if (!scope.radioOn && chains.own) destroyChain('own')
      }

      // ---------------- audio engine
      var ctx = null, master = null, ownBus = null, othersBus = null, workletReady = null
      var chains = {} // key -> chain

      function ensureAudio() {
        if (ctx) { if (ctx.state !== 'running') ctx.resume(); return workletReady }
        ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' })
        master = ctx.createGain()
        ownBus = ctx.createGain(); othersBus = ctx.createGain()
        ownBus.connect(master); othersBus.connect(master)
        master.connect(ctx.destination)
        applyVolumes()
        var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
        workletReady = ctx.audioWorklet.addModule(url).then(function () {
          URL.revokeObjectURL(url)
          var limiter = new AudioWorkletNode(ctx, 'carradio-limiter', { outputChannelCount: [2] })
          master.disconnect(); master.connect(limiter); limiter.connect(ctx.destination)
          return true
        })
        ctx.resume()
        if (window.__crDebug) window.__crDebug.engine = { ctx: ctx, master: master, chains: chains, scope: scope } // test pages only
        return workletReady
      }

      function applyVolumes() {
        if (!ctx) return
        var t = ctx.currentTime
        ownBus.gain.setTargetAtTime(0.6 * scope.cfg.vol / 100, t, 0.03)
        othersBus.gain.setTargetAtTime(0.6 * scope.cfg.others / 100, t, 0.03)
      }

      // Level-safe saturation: unity gain when quiet, peaks capped at 1/d.
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

      // One car radio: player node -> damage -> crash -> power -> bass -> cabin EQ -> muffle -> 3D/even/room.
      function createChain(key) {
        var own = key === 'own'
        var c = { key: key, own: own, lastAudio: performance.now(), roomSize: -1, cond: newCond(), seq: null }
        c.player = new AudioWorkletNode(ctx, 'carradio-player', { numberOfInputs: 0, outputChannelCount: [2],
          processorOptions: { targetMs: own ? 60 : 160 } })
        c.level = gain(0.5)
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
        c.player.connect(c.level); c.level.connect(c.dmgHP); c.dmgHP.connect(c.dmgLP)
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

      scope.$on('CarRadioAudio', function (e, m) {
        if (m.k === 'own' && !scope.radioOn) return
        if (!ctx) ensureAudio()
        workletReady.then(function () {
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
        var now = ctx.currentTime, cond = c.cond, inside = !!r.inside
        // Position and the inside/outside mix. Paused = clean stereo.
        var p = r.rel, pan = c.panner
        if (pan.positionX) { pan.positionX.setTargetAtTime(p[0], now, 0.03); pan.positionY.setTargetAtTime(p[1], now, 0.03); pan.positionZ.setTargetAtTime(p[2], now, 0.03) }
        else pan.setPosition(p[0], p[1], p[2])
        c.posGain.gain.setTargetAtTime(paused ? 0 : inside ? 0.35 : 1, now, 0.08)
        c.directGain.gain.setTargetAtTime(paused ? 1 : inside ? 0.65 : 0, now, 0.08)
        c.muffle.frequency.setTargetAtTime(scope.cfg.muffle && !inside && !paused ? 900 : 20000, now, 0.08)
        c.out.gain.setTargetAtTime(1, now, 0.05)
        // Damage
        var dmgOn = scope.cfg.damage && !paused, dpk = r.damagePerKg
        if (!scope.cfg.damage) cond.wrecked = false
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
        // Bass boost is the owner's radio EQ.
        if (c.own) {
          c.bassBoost.gain.setTargetAtTime(scope.cfg.bass ? 9 : 0, now, 0.15)
          c.bassTrim.gain.setTargetAtTime(scope.cfg.bass ? 0.6 : 1, now, 0.15)
          updateBassShake(c, paused)
        }
      }

      // ---------------- bass shake (own car only)
      var BASS_SCALE = 1.4, bass = { env: 0, lastSent: -1, lastAt: 0 }
      function sendBass(x, force) {
        var t = performance.now()
        if (!force && t - bass.lastAt < 33) return
        if (!force && x < 0.01 && bass.lastSent < 0.01) return
        bass.lastSent = x; bass.lastAt = t
        bngApi.engineLua('carradio_main.setBass(' + x.toFixed(3) + ',' + (scope.cfg.ultra ? 5 : 1) + ')')
      }
      function updateBassShake(c, paused) {
        if (!scope.cfg.bass || paused || !scope.radioOn) { bass.env = 0; sendBass(0); return }
        c.bassMeter.getFloatTimeDomainData(c.bassBuf)
        var sum = 0
        for (var i = 0; i < c.bassBuf.length; i++) sum += c.bassBuf[i] * c.bassBuf[i]
        var raw = Math.sqrt(sum / c.bassBuf.length) * BASS_SCALE * scope.cfg.vol / 100
        bass.env = raw > bass.env ? raw : bass.env * 0.85
        sendBass(bass.env)
      }

      // ---------------- state from game Lua
      var statusTick = 0
      scope.$on('CarRadioState', function (e, s) {
        if (ctx) {
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
        if (++statusTick % 15 === 0) scope.$evalAsync(function () { updateStatus(s) })
      })

      function updateStatus(s) {
        scope.radioOn = !!s.radioOn
        var c = s.companion
        scope.status.companion = !!c
        scope.status.companionText = !c ? 'CarRadio Companion is not running. Start it to play music.'
          : c.capturing ? 'Playing ' + (c.source || 'a program') + ' through your car'
          : 'Companion connected. Pick a program in it and press Start.'
        var others = s.radios.filter(function (r) { return r.k !== 'own' }).length
        if (!s.mp) scope.status.mpText = ''
        else if (!s.relay) scope.status.mpText = 'Multiplayer: this server has no CarRadio relay'
        else if (s.relay.state === 'connected') scope.status.mpText = 'Multiplayer: connected, ' + others + ' other radio' + (others === 1 ? '' : 's') + ' nearby'
        else scope.status.mpText = 'Multiplayer: relay ' + s.relay.state + (s.relay.error ? ' (' + s.relay.error + ')' : '')
      }

      scope.$on('$destroy', function () {
        for (var k in chains) destroyChain(k)
        if (ctx) ctx.close()
        bngApi.engineLua('carradio_main.setOn(false)')
      })

      // ---------------- audio worklets: jitter-buffered player + look-ahead peak limiter
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
        // Limiter: 3 ms look-ahead, -1 dBFS ceiling, transparent below it (see docs/BROWSER_PROBE_RESULTS.md).
        "class CarRadioLimiter extends AudioWorkletProcessor {",
        "  constructor() { super(); this.L = Math.max(64, Math.round(sampleRate * 0.003)); this.R = this.L + 1; this.ceiling = 0.891",
        "    this.d0 = new Float32Array(this.R); this.d1 = new Float32Array(this.R); this.need = new Float32Array(this.R)",
        "    this.dq = new Int32Array(this.R + 1); this.h = 0; this.t = 0; this.n = 0; this.g = 1",
        "    this.att = 1 - Math.exp(-1 / (sampleRate * 0.0015)); this.rel = 1 - Math.exp(-1 / (sampleRate * 0.15)) }",
        "  process(inputs, outputs) {",
        "    var inp = inputs[0], out = outputs[0]; if (!out || !out.length) return true",
        "    var frames = out[0].length, L = this.L, R = this.R, Q = R + 1, a = inp && inp[0], b = inp && inp[1] ? inp[1] : a",
        "    for (var i = 0; i < frames; i++) {",
        "      var xl = a ? a[i] : 0, xr = b ? b[i] : 0, pk = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr)",
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

      // Start audio early so other players' radios play without a click; resume on any click.
      ensureAudio()
      element[0].addEventListener('pointerdown', function () { if (ctx && ctx.state !== 'running') ctx.resume() })
    }
  }
}])
