import net from "node:net";

/** The host or socket path a `net.Socket.connect` call names, whichever of
 * its overloads is used: `(options, cb)`, `(port, host, cb)`, `(path, cb)`, or
 * the normalized `[options, cb]` array `net.connect` passes on. */
function target(args: unknown[]): { host: string; local: boolean } {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "string") return { host: first, local: true };
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: string; host?: string; port?: number };
    if (options.path) return { host: options.path, local: true };
    return local(options.host, options.port);
  }
  return local(typeof args[1] === "string" ? args[1] : undefined, Number(first));
}

function local(host = "localhost", port?: number): { host: string; local: boolean } {
  const name = host.replace(/^\[|\]$/g, "");
  return {
    host: `${name}:${port ?? ""}`,
    local: name === "localhost" || name === "::1" || name.startsWith("127."),
  };
}

/** Every connection the guard refused, newest last. */
export const refused: string[] = [];

// Tests never leave this machine, even with a real XAI_API_KEY or Relay key in
// the environment. Every socket Node opens (fetch and WebSocket through
// undici, node:http and node:https, node:tls, node:net) goes through
// net.Socket.prototype.connect, so the guard sits there; only loopback and
// local socket paths pass.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const { host, local: allowed } = target(args);
  if (!allowed) {
    refused.push(host);
    throw new Error(`tests never reach the network (${host})`);
  }
  return Reflect.apply(connect, this, args) as net.Socket;
} as typeof connect;
