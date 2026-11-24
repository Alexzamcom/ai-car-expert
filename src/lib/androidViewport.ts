/** Android WebView can publish its new visual viewport a frame after layout changes. */
export function watchAndroidViewport(update: () => void) {
  let frame = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const viewport = window.visualViewport;
  const request = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  const rotate = () => {
    request();
    clearTimeout(settle);
    settle = setTimeout(request, 200);
  };
  window.addEventListener('resize', request);
  window.addEventListener('orientationchange', rotate);
  viewport?.addEventListener('resize', request);
  request();
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(settle);
    window.removeEventListener('resize', request);
    window.removeEventListener('orientationchange', rotate);
    viewport?.removeEventListener('resize', request);
  };
}
