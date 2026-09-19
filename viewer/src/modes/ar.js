// Hand-written session lifecycle: the request stays directly in the tap handler.
// Dependencies are passed in so lifecycle failures can be checked without an XR device.
export async function setupAR({ renderer, scene, camera, alignmentCloud, clock, params,
  omni, elements, onError, resetFps, xr = navigator.xr, secure = isSecureContext }) {
  const { enter, exit, pre, hud, status, tracking, benchmark } = elements;
  renderer.xr.enabled = true;
  scene.background = null;
  renderer.setClearAlpha(0);
  // This is only the pre-session view. During AR, three.js owns the camera pose.
  camera.position.set(0, 0, 0);
  if (alignmentCloud) alignmentCloud.visible = false;
  clock.pause();
  hud.classList.add('hidden');
  enter.disabled = true;
  exit.disabled = true;
  benchmark.disabled = true;
  let active = null;
  let referenceSpace = null;
  let busy = false;
  let firstPose = null;
  let started = false;
  const jig = 'Place the phone in the jig, face the textured wall, then tap Enter AR and hold still for 2 s.';

  const onReset = () => {
    omni.resets += 1;
    tracking.textContent = 'Tracking origin reset. Exit AR and restart from the jig.';
  };
  const restore = () => {
    referenceSpace?.removeEventListener('reset', onReset);
    referenceSpace = null;
    active = null;
    firstPose = null;
    started = false;
    omni.xrPresenting = false;
    omni.xrFramebuffer = null;
    omni.domOverlay = null;
    omni.tracking = false;
    clock.pause();
    clock.last = null;
    resetFps();
    hud.classList.add('hidden');
    pre.classList.remove('hidden');
    enter.disabled = false;
    enter.textContent = 'Enter AR';
    exit.disabled = true;
    benchmark.disabled = true;
    status.textContent = jig;
  };
  const fail = (error) => {
    const message = `AR could not start: ${error.message || error}. Use Chrome on the Samsung at http://localhost:5173/OmniSight/; check camera permission and Google Play Services for AR.`;
    status.textContent = message;
    onError(new Error(message));
  };

  const start = async () => {
    if (busy || active || enter.disabled) return;
    busy = true;
    enter.disabled = true;
    enter.textContent = 'Starting AR…';
    if (elements.error) elements.error.hidden = true;
    if (elements.xrError) elements.xrError.hidden = true;
    let requested = null;
    try {
      // Do not await a support check here: preserve the user's transient activation.
      requested = await xr.requestSession('immersive-ar', {
        requiredFeatures: ['local'], optionalFeatures: ['dom-overlay'], domOverlay: { root: hud },
      });
      active = requested;
      requested.addEventListener('end', restore, { once: true });
      // Without the overlay we cannot offer alignment or an in-session Exit button.
      if (!requested.domOverlayState) throw new Error('This browser did not grant the HUD DOM overlay');
      renderer.xr.setFramebufferScaleFactor(params.fbscale);
      renderer.xr.setReferenceSpaceType('local');
      hud.classList.remove('hidden');
      await renderer.xr.setSession(requested);
      if (active !== requested) return; // ended while setSession was awaiting reference space
      referenceSpace = renderer.xr.getReferenceSpace();
      referenceSpace.addEventListener('reset', onReset);
      omni.xrPresenting = true;
      omni.domOverlay = requested.domOverlayState.type;
      omni.resets = 0;
      clock.seek(params.bench ? clock.duration : params.t);
      clock.pause();
      clock.last = null;
      resetFps();
      pre.classList.add('hidden');
      exit.disabled = false;
      tracking.textContent = 'Hold still in the jig for 2 s.';
    } catch (error) {
      // A failed setup must release the camera and allow another tap.
      if (requested && active === requested) {
        try { await requested.end(); } catch { /* session may already have ended */ }
      }
      restore();
      fail(error);
    } finally {
      busy = false;
    }
  };
  enter.addEventListener('click', start);
  exit.addEventListener('click', async () => {
    if (!active || busy) return;
    busy = true;
    exit.disabled = true;
    try { await active.end(); } catch (error) {
      exit.disabled = false;
      tracking.textContent = `Could not exit AR: ${error.message}. Use the browser's Back control.`;
      onError(error);
    } finally { busy = false; }
  });

  if (!secure || !xr) {
    status.textContent = !secure
      ? 'AR needs a secure context. Use adb reverse and http://localhost:5173/OmniSight/ on the Samsung, or HTTPS.'
      : 'WebXR is unavailable. Open this page in Chrome on the Samsung with Google Play Services for AR installed.';
    enter.textContent = 'AR unavailable';
  } else {
    try {
      const supported = await xr.isSessionSupported('immersive-ar');
      enter.disabled = !supported;
      enter.textContent = supported ? 'Enter AR' : 'AR unavailable';
      status.textContent = supported ? jig : 'Immersive AR is not supported here. Use Chrome on an ARCore-supported Samsung.';
    } catch (error) { fail(error); }
  }

  return {
    name: 'ar',
    update(now, frame) {
      if (!active || !omni.xrPresenting || !frame) return;
      const pose = frame.getViewerPose(referenceSpace);
      omni.tracking = !!pose;
      if (!pose) {
        firstPose = null;
        const message = 'Tracking lost. Face a textured surface; return to the jig if alignment shifts.';
        if (tracking.textContent !== message) tracking.textContent = message;
        return;
      }
      const layer = renderer.xr.getBaseLayer();
      if (layer) {
        const width = layer.framebufferWidth ?? layer.textureWidth;
        const height = layer.framebufferHeight ?? layer.textureHeight;
        if (omni.xrFramebuffer?.width !== width || omni.xrFramebuffer?.height !== height) {
          omni.xrFramebuffer = { width, height };
        }
      }
      if (!started) {
        if (firstPose === null) firstPose = now;
        if (now - firstPose < 2000) return;
        started = true;
        if (!params.bench) clock.play();
        benchmark.disabled = false;
      }
      const message = omni.resets
        ? 'Tracking origin reset. Exit AR and restart from the jig.'
        : 'AR tracking · local space';
      if (tracking.textContent !== message) tracking.textContent = message;
    },
  };
}
