const registry: Record<string, any> = {};

export function registerPlayer(id: number | string, ref: any | undefined) {
  try {
    if (ref) registry[String(id)] = ref;
    else delete registry[String(id)];
  } catch (e) {}
}

export function getActivePlayer() {
  try {
    // Return the first/most recent registered player
    const keys = Object.keys(registry);
    if (keys.length > 0) {
      const lastKey = keys[keys.length - 1];
      return registry[lastKey]?.current;
    }
  } catch (e) {}
  return null;
}

export function pauseAllExcept(keepId?: number | string | null) {
  try {
    const keepKey = keepId == null ? null : String(keepId);
    Object.keys(registry).forEach(k => {
      if (keepKey !== null && k === keepKey) return;
      const r = registry[k];
      const player = r?.current;
      try {
        if (player && typeof player.pauseAsync === 'function') player.pauseAsync().catch(() => {});
      } catch (e) {}
    });
  } catch (e) {}
}

export default { registerPlayer, getActivePlayer, pauseAllExcept };
