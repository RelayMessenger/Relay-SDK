export type RelayAccountLifecycleLease = {
  signal: AbortSignal;
  release: () => void;
};

/** Owns exactly one abortable long-poll lifecycle per configured account. */
export function createRelayAccountLifecycleRegistry() {
  const controllers = new Map<string, AbortController>();

  return {
    acquire(accountId: string, parentSignal: AbortSignal): RelayAccountLifecycleLease {
      if (controllers.has(accountId)) {
        throw new Error(`relay: account "${accountId}" already has an active consumer`);
      }
      const controller = new AbortController();
      controllers.set(accountId, controller);
      const signal = AbortSignal.any([parentSignal, controller.signal]);
      let released = false;
      return {
        signal,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          if (controllers.get(accountId) === controller) {
            controllers.delete(accountId);
          }
        },
      };
    },

    stop(accountId: string): boolean {
      const controller = controllers.get(accountId);
      if (!controller) {
        return false;
      }
      controller.abort();
      return true;
    },
  };
}
