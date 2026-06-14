/**
 * Merge abort signals — uses AbortSignal.any when available, manual fan-in otherwise.
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
export function mergeAbortSignals(signals) {
  const list = (signals || []).filter(Boolean);
  if (list.length === 0) {
    return { signal: new AbortController().signal, cleanup: () => {} };
  }
  if (list.length === 1) {
    return { signal: list[0], cleanup: () => {} };
  }
  if (typeof AbortSignal?.any === "function") {
    return { signal: AbortSignal.any(list), cleanup: () => {} };
  }
  const ctrl = new AbortController();
  const handlers = new Map();

  const removeAllListeners = () => {
    for (const [sig, handler] of handlers) {
      sig.removeEventListener("abort", handler);
    }
    handlers.clear();
  };

  const onAbort = (sig) => {
    if (!ctrl.signal.aborted) {
      removeAllListeners();
      ctrl.abort(sig.reason);
    }
  };

  for (const sig of list) {
    if (sig.aborted) {
      onAbort(sig);
      break;
    }
    const handler = () => onAbort(sig);
    handlers.set(sig, handler);
    sig.addEventListener("abort", handler, { once: true });
  }

  ctrl.signal.addEventListener("abort", removeAllListeners, { once: true });
  return { signal: ctrl.signal, cleanup: removeAllListeners };
}
