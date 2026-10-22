/** The WebGL2 renderer for the cockpit's scene: the black hole pass, the bloom chain and the final room pass. */
import { DOWN, FINAL, HOLE, PREFILTER, SCENE, UP, VERTEX } from './cockpit-shaders.mjs';

function compile(gl, type, source, name) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${name} shader: ${log}`);
  }
  return shader;
}

function program(gl, source, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX, `${name} vertex`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, source, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} shader: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i += 1) {
    const { name: uniform } = gl.getActiveUniform(p, i);
    uniforms[uniform] = gl.getUniformLocation(p, uniform);
  }
  return { p, u: uniforms };
}

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is not available');
  // Half-float targets keep the black hole in HDR for bloom and tone mapping; without them, or when the device cannot
  // allocate them, 8-bit targets still work.
  let hdr = Boolean(gl.getExtension('EXT_color_buffer_float'));
  let format = hdr ? gl.RGBA16F : gl.RGBA8;
  let type = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  // Neither side of the canvas goes past 4096 px or the device's texture and viewport limits.
  const viewportLimit = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const maxSide = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE), viewportLimit[0], viewportLimit[1]);
  const programs = { hole: program(gl, HOLE, 'hole'), prefilter: program(gl, PREFILTER, 'prefilter'), down: program(gl, DOWN, 'down'), up: program(gl, UP, 'up'), final: program(gl, FINAL, 'final') };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const levels = SCENE.bloomLevels;
  const targets = { hole: null, down: [], up: [] };
  let width = 0;
  let height = 0;
  let holeView = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** Whether the black hole target holds a frame: a new one is empty. */
  let holeFresh = false;

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, gl.RGBA, type, null);
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      throw new Error(`render target ${w} × ${h} is not supported`);
    }
    return { tex, fbo, w, h };
  }

  function release() {
    for (const old of [targets.hole, ...targets.down, ...targets.up]) {
      if (!old) continue;
      gl.deleteTexture(old.tex);
      gl.deleteFramebuffer(old.fbo);
    }
    targets.hole = null;
    targets.down = [];
    targets.up = [];
    holeFresh = false;
  }

  /** The black hole target and the bloom chain below it; on failure nothing is left allocated. */
  function allocate(hw, hh) {
    release();
    try {
      targets.hole = target(hw, hh);
      for (let i = 0; i < levels; i += 1) {
        targets.down[i] = target(Math.max(1, hw >> (i + 1)), Math.max(1, hh >> (i + 1)));
        if (i < levels - 1) targets.up[i] = target(Math.max(1, hw >> (i + 1)), Math.max(1, hh >> (i + 1)));
      }
    } catch (error) {
      release();
      throw error;
    }
  }

  function use(prog, into) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
    gl.viewport(0, 0, into ? into.w : width, into ? into.h : height);
  }
  function bind(unit, tex, location) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(location, unit);
  }

  function hole(view) {
    const { u } = programs.hole;
    use(programs.hole, targets.hole);
    gl.uniform2f(u.uRes, targets.hole.w, targets.hole.h);
    gl.uniform2f(u.uDesign, view.design[0], view.design[1]);
    gl.uniform1f(u.uFocal, view.focal);
    gl.uniform1f(u.uTime, view.time);
    gl.uniform1f(u.uPix, view.design[1] / targets.hole.h / view.focal);
    gl.uniformMatrix3fv(u.uView, false, view.view);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    holeView = view.view;
  }

  function bloom() {
    use(programs.prefilter, targets.down[0]);
    bind(0, targets.hole.tex, programs.prefilter.u.uSrc);
    gl.uniform2f(programs.prefilter.u.uTexel, 1 / targets.hole.w, 1 / targets.hole.h);
    gl.uniform1f(programs.prefilter.u.uThresh, SCENE.bloomThreshold);
    gl.uniform1f(programs.prefilter.u.uKnee, SCENE.bloomKnee);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (let i = 1; i < levels; i += 1) {
      const from = targets.down[i - 1];
      const into = targets.down[i];
      use(programs.down, into);
      bind(0, from.tex, programs.down.u.uSrc);
      gl.uniform2f(programs.down.u.uTexel, 1 / from.w, 1 / from.h);
      gl.uniform2f(programs.down.u.uDst, into.w, into.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    for (let i = levels - 2; i >= 0; i -= 1) {
      const from = i === levels - 2 ? targets.down[levels - 1] : targets.up[i + 1];
      const into = targets.up[i];
      use(programs.up, into);
      bind(0, from.tex, programs.up.u.uSrc);
      bind(1, targets.down[i].tex, programs.up.u.uAdd);
      gl.uniform2f(programs.up.u.uTexel, 1 / from.w, 1 / from.h);
      gl.uniform2f(programs.up.u.uDst, into.w, into.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  function final(view) {
    const { u } = programs.final;
    use(programs.final, null);
    bind(0, targets.hole.tex, u.uHole);
    bind(1, targets.up[0].tex, u.uBloom);
    gl.uniform2f(u.uRes, width, height);
    gl.uniform2f(u.uDesign, view.design[0], view.design[1]);
    gl.uniform1f(u.uFocal, view.focal);
    gl.uniformMatrix3fv(u.uView, false, view.view);
    gl.uniformMatrix3fv(u.uHoleView, false, holeView);
    gl.uniform3f(u.uCam, view.cam[0], view.cam[1], view.cam[2]);
    gl.uniform1f(u.uExposure, view.exposure);
    gl.uniform1f(u.uBloomK, view.bloom / levels);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const pixel = new Uint8Array(4);
  const pixelFloat = new Float32Array(4);
  /** Wait for the GPU: a one-pixel read cannot return before the passes that wrote it have finished. */
  function sync(into = null) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
    if (into && hdr) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixelFloat);
    else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  return {
    resize(cssWidth, cssHeight, dpr, holeScale) {
      // One scale for both sides keeps the aspect ratio; within the limits it is 1 and changes nothing.
      const scale = Math.min(1, maxSide / (cssWidth * dpr), maxSide / (cssHeight * dpr));
      width = Math.max(1, Math.min(maxSide, Math.round(cssWidth * dpr * scale)));
      height = Math.max(1, Math.min(maxSide, Math.round((cssHeight * width) / cssWidth)));
      canvas.width = width;
      canvas.height = height;
      const hw = Math.max(64, Math.round(width * holeScale));
      const hh = Math.max(36, Math.round(height * holeScale));
      try {
        allocate(hw, hh);
      } catch (error) {
        if (!hdr) throw error;
        // Half-float targets failed: switch to 8-bit targets for good and try once more.
        hdr = false;
        format = gl.RGBA8;
        type = gl.UNSIGNED_BYTE;
        allocate(hw, hh);
      }
      return { holeWidth: hw, holeHeight: hh, width, height, hdr };
    },
    /**
     * Draw a frame. Without drawHole the last black hole frame is reused, turned to the camera's current view; a new
     * target has no frame yet, so then the black hole is drawn anyway.
     */
    render(view, drawHole = true) {
      gl.bindVertexArray(vao);
      if (drawHole || !holeFresh) {
        hole(view);
        bloom();
        holeFresh = true;
      }
      final(view);
    },
    /** The frame just drawn, top row first. Call it in the same task as render(): the drawing buffer is not kept. */
    readFrame() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const row = width * 4;
      const flipped = new Uint8Array(data.length);
      for (let y = 0; y < height; y += 1) flipped.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
      return { width, height, data: flipped };
    },
    sync: () => sync(null),
    /** Each pass's time in ms, each forced to finish before the next starts. */
    timed(view) {
      gl.bindVertexArray(vao);
      sync(null);
      const t0 = performance.now();
      hole(view);
      sync(targets.hole);
      const t1 = performance.now();
      bloom();
      holeFresh = true;
      sync(targets.up[0]);
      const t2 = performance.now();
      final(view);
      sync(null);
      return { holeMs: t1 - t0, bloomMs: t2 - t1, finalMs: performance.now() - t2 };
    },
    info() {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), hdr, timer: Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2')) };
    },
    size: () => ({ width, height, holeWidth: targets.hole?.w ?? 0, holeHeight: targets.hole?.h ?? 0 }),
  };
}
