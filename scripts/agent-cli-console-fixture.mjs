// Authenticated Console fixture for installed CLI consumers, never a live service.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function installedConsoleFixture(consumer, context, card) {
  const config = await import(pathToFileURL(join(consumer, "node_modules/relaymessenger/dist/config.js")));
  context.env.RELAY_CONSOLE_API_URL = "https://console.staging.relayapp.im/api";
  const session = {
    type: "organization_key", organization_key: "rel_org_installedFixtureOnly",
    organization_id: "org_fixture", console_api_url: context.env.RELAY_CONSOLE_API_URL,
  };
  return {
    session,
    login: async () => {
      const saved = await config.readConfig(context);
      saved.console = session;
      await config.writeConfig(saved, context);
      return session;
    },
    wrap: (delegate) => async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const consoleRequest = url.pathname.includes("/orgs/") || url.pathname.endsWith("/me");
      if (consoleRequest && new Headers(init?.headers).get("authorization") !== `Bearer ${session.organization_key}`) {
        return Response.json({ error: "missing fixture organization key" }, { status: 401 });
      }
      if (url.pathname.endsWith("/me")) return Response.json({ org: { id: session.organization_id, handleNamespace: card.handle.split(".").at(-1) } });
      if (url.pathname.endsWith("/orgs/org_fixture/agents") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ id: "fixture-agent-id", handle: card.handle }]);
      }
      const response = await delegate(input, init);
      if (!consoleRequest || init?.method !== "POST" || !response.ok) return response;
      const result = await response.json();
      return Response.json({
        agent: { handle: result.agent.handle, displayName: result.agent.first_name, avatarUrl: result.agent.image_url },
        token: result.token ?? result.secret,
      }, { status: response.status });
    },
  };
}
