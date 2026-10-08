import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ChannelAdapter, ChannelMessage, IncomingMessage } from "../src/pi-channels.js";

/**
 * The parts of pi-channels 0.2.1 the Relay adapter touches, copied from
 * @e9n/pi-channels (MIT, github.com/espennilsen/pi packages/pi-channels):
 * src/events.ts (setOnIncoming, channel:send, channel:register,
 * channel:list) and src/registry.ts (register, send). The chat bridge is
 * reduced to `handleMessage` and its reply, src/bridge/bridge.ts `sendReply`.
 */
export const piChannelsHost = (events: EventBus, options: { routes?: Record<string, { adapter: string; recipient: string }>; autoStart?: boolean } = {}) => {
  const adapters = new Map<string, ChannelAdapter>();
  const routes = new Map(Object.entries(options.routes ?? {}));
  const bridged: IncomingMessage[] = [];
  const received: IncomingMessage[] = [];
  events.on("channel:receive", (message) => { received.push(message as IncomingMessage); });
  const bridge = {
    handleMessage: (message: IncomingMessage) => { bridged.push(message); },
    sendReply: (adapter: string, recipient: string, text: string) => send({ adapter, recipient, text }),
  };
  const onIncoming = (message: IncomingMessage): void => {
    events.emit("channel:receive", message);
    bridge.handleMessage(message);
  };
  const send = async (message: ChannelMessage): Promise<{ ok: boolean; error?: string }> => {
    let adapterName = message.adapter;
    let recipient = message.recipient;
    const route = routes.get(adapterName);
    if (route) {
      adapterName = route.adapter;
      if (!recipient) recipient = route.recipient;
    }
    const adapter = adapters.get(adapterName);
    if (!adapter) return { ok: false, error: `No adapter "${adapterName}"` };
    try {
      await adapter.send({ ...message, adapter: adapterName, recipient });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };
  events.on("channel:send", (raw) => {
    const data = raw as ChannelMessage & { callback?: (result: { ok: boolean; error?: string }) => void };
    void send(data).then((result) => data.callback?.(result));
  });
  events.on("channel:register", (raw) => {
    const data = raw as { name: string; adapter: ChannelAdapter; callback?: (ok: boolean) => void };
    if (!data.name || !data.adapter) { data.callback?.(false); return; }
    adapters.set(data.name, data.adapter);
    if (options.autoStart !== false && (data.adapter.direction === "incoming" || data.adapter.direction === "bidirectional")) {
      void data.adapter.start((message) => { onIncoming({ ...message, adapter: data.name }); });
    }
    data.callback?.(true);
  });
  events.on("channel:list", (raw) => {
    const data = raw as { callback?: (items: { name: string; type: string; direction?: string }[]) => void };
    data.callback?.([...adapters].map(([name, adapter]) => ({ name, type: "adapter", direction: adapter.direction })));
  });
  return { adapters, bridge, bridged, received, send };
};
