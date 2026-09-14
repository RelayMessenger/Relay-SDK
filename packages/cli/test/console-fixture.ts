import { readConfig, writeConfig, type ConfigContext, type RelayConsoleOrganizationKey } from "../src/config.js";

/** Explicit authenticated Console boundary for command/rendering fixtures.
 * The delegate still sees the real organization create/delete path and body.
 * ContactCard fixtures are serialized into Console's different create DTO. */
export function consoleFixture(
  context: ConfigContext,
  card: { handle: string; first_name: string; image_url: string | null },
) {
  context.env ??= {};
  context.env.RELAY_CONSOLE_API_URL ??= "https://console.staging.relayapp.im/api";
  const session: RelayConsoleOrganizationKey = {
    type: "organization_key", organization_key: "rel_org_fixtureOnlyNotARealKey",
    organization_id: "org_fixture", console_api_url: context.env.RELAY_CONSOLE_API_URL,
  };
  const login = async () => {
    const config = await readConfig(context);
    config.console = session;
    await writeConfig(config, context);
    return session;
  };
  const wrap = (delegate: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const isConsole = url.pathname.includes("/orgs/") || url.pathname.endsWith("/me");
    if (isConsole && new Headers(init?.headers).get("authorization") !== `Bearer ${session.organization_key}`) {
      return Response.json({ error: "missing fixture organization key" }, { status: 401 });
    }
    if (url.pathname.endsWith("/me")) return Response.json({ org: { id: session.organization_id, handleNamespace: card.handle.split(".").at(-1) } });
    if (url.pathname.endsWith("/orgs/org_fixture/agents") && (init?.method ?? "GET") === "GET") {
      return Response.json([{ id: "fixture-agent-id", handle: card.handle }]);
    }
    const response = await delegate(input, init);
    if (!isConsole || init?.method !== "POST" || !response.ok) return response;
    const result = await response.json();
    return Response.json({
      agent: { handle: result.agent.handle, displayName: result.agent.first_name, avatarUrl: result.agent.image_url },
      token: result.token ?? result.secret,
    }, { status: response.status });
  };
  return { login, wrap, session };
}
