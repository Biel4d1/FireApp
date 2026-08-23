import { useEffect, useRef, useContext } from 'react';
import { Video } from 'expo-av';
import { AuthContext } from './auth';

// playback handler registry to allow multiple listeners to a single player's status updates
const playbackHandlerMap: WeakMap<any, Set<Function>> = new WeakMap();
const configuredPlayers: WeakSet<any> = new WeakSet();

function ensureDispatcherFor(player: any) {
  try {
    if (!player || configuredPlayers.has(player)) return;
    const dispatcher = (s: any) => {
      try {
        const set = playbackHandlerMap.get(player);
        if (set && set.size > 0) {
          for (const fn of Array.from(set)) {
            try { fn(s); } catch (e) {}
          }
        }
      } catch (e) {}
    };

    // attach the status dispatcher only after the player reports it's loaded
    const tryAttach = async () => {
      try {
        // if player has getStatusAsync, check loaded state first
        if (typeof player.getStatusAsync === 'function') {
          const status = await (player as any).getStatusAsync().catch(() => null);
          if (!status || !('isLoaded' in status) || !status.isLoaded) {
            // retry shortly — player not ready yet
            setTimeout(tryAttach, 150);
            return;
          }
        }

        if (typeof player.setOnPlaybackStatusUpdate === 'function') {
          try {
            player.setOnPlaybackStatusUpdate((s: any) => {
              try { dispatcher(s); } catch (e) {}
            });
          } catch (e) {
            // failed to attach; try again
            setTimeout(tryAttach, 150);
            return;
          }
        }

        configuredPlayers.add(player);
      } catch (e) {
        // swallow errors — don't crash if player unmounts during attach
      }
    };

    // start attach attempts
    tryAttach();
  } catch (e) {}
}

export function useEvent(playerRef: React.RefObject<any>, eventName: string, handler: (s?: any) => void) {
  useEffect(() => {
    const player = playerRef?.current;
    if (!player) return;
    try {
      ensureDispatcherFor(player);
      let set = playbackHandlerMap.get(player);
      if (!set) { set = new Set<Function>(); playbackHandlerMap.set(player, set); }
      const wrapped = (s: any) => {
        if (eventName === 'playing') {
          try {
            if (s && ('isPlaying' in s) && s.isPlaying) handler(s);
          } catch (e) {}
        } else {
          try { handler(s); } catch (e) {}
        }
      };
      set.add(wrapped);
      return () => { try { set!.delete(wrapped); } catch (e) {} };
    } catch (e) { /* ignore */ }
  }, [playerRef, eventName, handler]);
}

// Hook to control an expo-av Video instance
// enabled: whether playback should start when mounted (use focused state)
export function useVideoPlayer(enabledOrUri: boolean | string = true, onInit?: (player: any) => void) {
  const ref = useRef<Video | null>(null);
  const enabled = typeof enabledOrUri === 'string' ? true : Boolean(enabledOrUri);

  // Extra safeguard: pause/unload the player when the auth user becomes null
  // so background audio cannot continue after logout even if navigator state lags.
  const { user } = useContext(AuthContext);
  useEffect(() => {
    if (user) return;
    try {
      const player = ref.current as any;
      if (!player) return;
      try { if (typeof player.pauseAsync === 'function') player.pauseAsync().catch(() => {}); } catch (e) {}
      try { if (typeof player.unloadAsync === 'function') player.unloadAsync().catch(() => {}); } catch (e) {}
    } catch (e) {}
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    async function configurePlayer() {
      // retry a few times because the ref may not be set immediately
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        try {
          const player = ref.current;
          if (!player) {
            // wait briefly and retry
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 150));
            continue;
          }

          // helper to determine if the underlying player has finished loading
          async function waitForPlayerLoaded(maxAttempts = 10, delayMs = 100) {
            try {
              if (!player) return false;
              if (typeof (player as any).getStatusAsync !== 'function') return true;
              for (let i = 0; i < maxAttempts; i++) {
                // eslint-disable-next-line no-await-in-loop
                const status = await (player as any).getStatusAsync().catch(() => null);
                if (status && ('isLoaded' in status) && status.isLoaded) return true;
                // eslint-disable-next-line no-await-in-loop
                await new Promise(r => setTimeout(r, delayMs));
                if (!ref.current) return false; // unmounted while waiting
              }
            } catch (e) {}
            return false;
          }

          if (typeof (player as any).setIsLoopingAsync === 'function') {
            await (player as any).setIsLoopingAsync(true);
          }

          // fallback: some platforms expose simple properties/methods
          try {
            if ((player as any).loop === undefined) {
              // try setting loop property if available
              try { (player as any).loop = true; } catch (e) { /* ignore */ }
            }
            if (typeof (player as any).play === 'function') {
              // some environments (web) may have play() which returns a Promise
              try {
                const p = (player as any).play();
                if (p && typeof p.then === 'function') await p.catch(() => {});
              } catch (e) {
                // ignore
              }
            }
          } catch (e) {
            // ignore
          }

            // set autoplay flag where available to hint at auto-play behavior
            try {
              try { (player as any).autoplay = true; } catch (e) { /* ignore */ }
            } catch (e) {}

            // ensure loop flag is also set where possible
            try {
              if ((player as any).loop === undefined) {
                try { (player as any).loop = true; } catch (e) { /* ignore */ }
              } else {
                try { (player as any).loop = true; } catch (e) { /* ignore */ }
              }
            } catch (e) {}

            // attach a status update logger so playback errors surface in logs
            try {
              const loaded = await waitForPlayerLoaded();
              if (!loaded) {
                // player never loaded (or unmounted) — skip attaching listeners this attempt
                // let the retry loop handle future attempts
              } else if (typeof (player as any).setOnPlaybackStatusUpdate === 'function') {
                try {
                  (player as any).setOnPlaybackStatusUpdate(async (s: any) => {
                    try {
                      if (s && s.error) {
                        // eslint-disable-next-line no-console
                        console.error('useVideoPlayer playback error:', s.error);
                      }

                      // if status indicates loaded/ready, attempt to play (helps some native players)
                      try {
                        if (s && ('isLoaded' in s) && s.isLoaded && !s.isPlaying) {
                          // only attempt if not already playing
                          if (typeof (player as any).play === 'function') {
                            try {
                              const p = (player as any).play();
                              if (p && typeof p.then === 'function') await p.catch(() => {});
                            } catch (e) { /* ignore */ }
                          } else if (typeof (player as any).playAsync === 'function') {
                            try { await (player as any).playAsync(); } catch (e) { /* ignore */ }
                          }
                        }
                      } catch (err) {}

                      // if playback finished and looping isn't honored, restart
                      if (s && s.didJustFinish) {
                        try {
                          if (typeof (player as any).setPositionAsync === 'function') await (player as any).setPositionAsync(0);
                          if (typeof (player as any).playAsync === 'function') await (player as any).playAsync();
                        } catch (err) {
                          // ignore
                        }
                      }
                    } catch (err) {
                      // ignore
                    }
                  });
                } catch (e) {
                  // ignore attaching listener if player becomes invalid
                }
              }
            } catch (e) {
              // ignore outer listener setup errors
            }

            // Ensure audio/volume/flags only when enabled (prevent background unmute)
            try {
              if (enabled) {
                if (typeof (player as any).setIsMutedAsync === 'function') await (player as any).setIsMutedAsync(false);
                if (typeof (player as any).setVolumeAsync === 'function') await (player as any).setVolumeAsync(1.0);
                try { (player as any).muted = false; } catch (e) {}
                try { (player as any).volume = 1.0; } catch (e) {}
              } else {
                // keep non-enabled players muted to avoid audio bleed
                try { if (typeof (player as any).setIsMutedAsync === 'function') (player as any).setIsMutedAsync(true).catch(() => {}); } catch (e) {}
                try { (player as any).muted = true; } catch (e) {}
              }
            } catch (e) {}

            // enforce common playback flags explicitly, but avoid unmute/autoplay for disabled players
            try {
              try { (player as any).loop = true; } catch (e) {}
              if (enabled) try { (player as any).autoplay = true; } catch (e) {}
            } catch (e) {}

          if (enabled) {
            if (typeof (player as any).playAsync === 'function') {
              await (player as any).playAsync();
            } else if (typeof (player as any).setStatusAsync === 'function') {
              await (player as any).setStatusAsync({ shouldPlay: true });
            }
          } else {
            if (typeof (player as any).pauseAsync === 'function') {
              await (player as any).pauseAsync();
            } else if (typeof (player as any).setStatusAsync === 'function') {
              await (player as any).setStatusAsync({ shouldPlay: false });
            }
          }

          // call optional initializer callback after player is configured
          try {
            if (typeof onInit === 'function') {
              try { onInit(player); } catch (e) { /* ignore */ }
            }
          } catch (e) {}

          // configured successfully
          break;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.log('useVideoPlayer attempt error', e);
          // wait a bit before retrying
          // eslint-disable-next-line no-await-in-loop
          await new Promise(r => setTimeout(r, 150));
        }
      }
    }

    configurePlayer();

    return () => {
      cancelled = true;
      try {
        const player = ref.current as any;
        if (player) {
          if (typeof player.pauseAsync === 'function') player.pauseAsync().catch(() => {});
          if (typeof player.unloadAsync === 'function') player.unloadAsync().catch(() => {});
        }
      } catch (e) {
        // ignore
      }
    };
  }, [enabled]);

  // ensure we attempt a play after a short delay so the component is mounted
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(async () => {
      try {
        const player = ref.current as any;
        if (!player) return;
        if (typeof player.play === 'function') {
          try { player.play(); return; } catch (e) { /* ignore */ }
        }
        if (typeof player.playAsync === 'function') {
          try { await player.playAsync(); return; } catch (e) { /* ignore */ }
        }
        if (typeof player.setStatusAsync === 'function') {
          try { await player.setStatusAsync({ shouldPlay: true }); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        // ignore
      }
    }, 500);
    return () => clearTimeout(t);
  }, [enabled]);

  return ref;
}

export default useVideoPlayer;
