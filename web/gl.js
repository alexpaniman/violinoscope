// Dots on the GPU: each point has a position to glide from and one to glide to, a colour and a size; a negative
// size draws a hollow diamond, for a group of a single compilation. Drawn at the screen's pixel density, so they stay sharp at any zoom. Falls back to a 2D canvas.
(function () {
  'use strict';
  const X = window.TX;

  const VS = `
    attribute vec2 a_from;
    attribute vec2 a_to;
    attribute vec4 a_color;
    attribute float a_size;
    uniform vec2 u_res;
    uniform vec2 u_off;
    uniform float u_t;
    uniform float u_dpr;
    varying vec4 v_color;
    varying float v_px;
    varying float v_ring;
    varying float v_ringw;
    void main() {
      vec2 p = mix(a_from, a_to, u_t) - u_off;
      v_ringw = 1.6 * u_dpr;
      gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
      v_ring = a_size < 0.0 ? 1.0 : 0.0;
      v_px = abs(a_size) * u_dpr + 1.0;
      gl_PointSize = v_px;
      v_color = a_color;
    }`;
  const FS = `
    precision mediump float;
    varying vec4 v_color;
    varying float v_px;
    varying float v_ring;
    varying float v_ringw;
    void main() {
      vec2 q = abs(gl_PointCoord - 0.5) * v_px;
      float r = v_px * 0.5 - 0.5;
      float a;
      if (v_ring > 0.5) {
        // How far inside the diamond's edge, square to it.
        float e = (r - q.x - q.y) * 0.7071;
        a = clamp(e + 0.5, 0.0, 1.0) * clamp(v_ringw - e + 0.5, 0.0, 1.0);
      } else {
        a = clamp(r - length(q) + 0.5, 0.0, 1.0);
      }
      a *= v_color.a;
      if (a <= 0.003) discard;
      gl_FragColor = vec4(v_color.rgb * a, a);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  X.Points = function (canvas) {
    let gl = null;
    const fresh = () => {
      // A canvas keeps the first kind of context it gave out, so the fallback needs a new one.
      const c = canvas.cloneNode(false);
      canvas.replaceWith(c);
      canvas = c;
      return c.getContext('2d');
    };
    try { gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: true, alpha: true }); } catch (e) { gl = null; }
    // view: the part of the layer the canvas covers and its density, as X.layerView gives it.
    const state = { n: 0, from: null, to: null, t: 1, view: { x: 0, y: 0, w: 1, h: 1, s: 1 }, clip: null, anim: 0 };
    let prog, loc, bufFrom, bufTo, bufColor, bufSize, colors, sizes;
    if (gl) {
      try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        loc = {
          from: gl.getAttribLocation(prog, 'a_from'), to: gl.getAttribLocation(prog, 'a_to'),
          color: gl.getAttribLocation(prog, 'a_color'), size: gl.getAttribLocation(prog, 'a_size'),
          res: gl.getUniformLocation(prog, 'u_res'), off: gl.getUniformLocation(prog, 'u_off'), t: gl.getUniformLocation(prog, 'u_t'),
          dpr: gl.getUniformLocation(prog, 'u_dpr'),
        };
        bufFrom = gl.createBuffer(); bufTo = gl.createBuffer(); bufColor = gl.createBuffer(); bufSize = gl.createBuffer();
      } catch (e) { console.warn('Drawing dots without WebGL:', e.message); gl = null; }
    }
    const ctx = gl ? null : (canvas.getContext('2d') || fresh());

    function upload(buf, arr) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); }
    function attrib(buf, l, size, type, norm) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, type, norm, 0, 0);
    }

    function draw() {
      const { n, clip } = state, v = state.view, dpr = v.s;
      if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!n) return;
        if (clip) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(Math.floor((clip.x - v.x) * dpr), Math.floor((v.y + v.h - clip.y - clip.h) * dpr), Math.ceil(clip.w * dpr), Math.ceil(clip.h * dpr));
        }
        gl.useProgram(prog);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        attrib(bufFrom, loc.from, 2, gl.FLOAT, false);
        attrib(bufTo, loc.to, 2, gl.FLOAT, false);
        attrib(bufColor, loc.color, 4, gl.UNSIGNED_BYTE, true);
        attrib(bufSize, loc.size, 1, gl.FLOAT, false);
        gl.uniform2f(loc.res, v.w, v.h);
        gl.uniform2f(loc.off, v.x, v.y);
        gl.uniform1f(loc.t, state.t);
        gl.uniform1f(loc.dpr, dpr * (v.mark || 1));
        gl.drawArrays(gl.POINTS, 0, n);
        return;
      }
      // Fallback: a plain canvas, drawn at the end position.
      ctx.setTransform(...X.toView(v));
      ctx.clearRect(v.x, v.y, v.w, v.h);
      if (!n) return;
      ctx.save();
      if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
      const t = state.t, f = state.from, to = state.to;
      for (let i = 0; i < n; i++) {
        const x = f[2 * i] + (to[2 * i] - f[2 * i]) * t, y = f[2 * i + 1] + (to[2 * i + 1] - f[2 * i + 1]) * t;
        const s = sizes[i], r = Math.abs(s) / 2;
        ctx.globalAlpha = colors[4 * i + 3] / 255;
        const c = `rgb(${colors[4 * i]},${colors[4 * i + 1]},${colors[4 * i + 2]})`;
        ctx.beginPath();
        if (s < 0) {
          const d = r - 1.1;
          ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
          ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
        } else { ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    return {
      gpu: !!gl,
      resize(w, h, view) {
        state.view = X.fitCanvas(canvas, w, h, view);
        draw();
      },
      // positions: Float32Array of x, y pairs; glide from the dots' current places when `glide` holds and the counts
      // match.
      set(positions, rgba, size, clip, glide) {
        cancelAnimationFrame(state.anim);
        let from = positions;
        if (glide && state.to && state.n === positions.length / 2) {
          from = new Float32Array(positions.length);
          const t = state.t, f0 = state.from, t0 = state.to;
          for (let i = 0; i < from.length; i++) from[i] = f0[i] + (t0[i] - f0[i]) * t;
        }
        state.n = positions.length / 2;
        state.from = from; state.to = positions; state.clip = clip;
        colors = rgba; sizes = size;
        if (gl) { upload(bufFrom, from); upload(bufTo, positions); upload(bufColor, rgba); upload(bufSize, size); }
        if (from === positions || !gl) { state.t = 1; draw(); return; }
        const start = performance.now(), D = 240;
        const step = (now) => {
          const k = Math.min(1, (now - start) / D);
          state.t = 1 - Math.pow(1 - k, 3);
          draw();
          if (k < 1) state.anim = requestAnimationFrame(step);
        };
        state.t = 0;
        draw();
        state.anim = requestAnimationFrame(step);
      },
      clear() { state.n = 0; state.to = null; draw(); },
      redraw: draw,
    };
  };
})();
