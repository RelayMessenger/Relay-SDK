import { prepareAgentImage, type LocalAgentImage } from "./local-image.js";
import { uploadAgentImage, type AgentImageUploadResult } from "./agent-image-upload.js";
import { agentRecord, createAgent, type AgentDependencies, type CreateAgentInput } from "./agents.js";
import { safeMetadata } from "./output.js";
import Relay, { type AgentImageRecipe } from "@relaymessenger/sdk";
import { DEFAULT_API_URL, validateApiURL } from "./config.js";

/**
 * One creation path for every caller. `agents create` and `connect` both make an
 * agent, save its token privately, and then set its picture from a local file,
 * so the order, the retry wording and the "do not create another agent" rule
 * live here once rather than in each command.
 */
export interface CreateWithPictureInput extends CreateAgentInput {
  /** A file on this computer, or an https:// address. */
  image?: string;
  imageRecipe?: AgentImageRecipe;
  cwd?: string;
  home?: string;
}

export interface CreateWithPictureResult {
  result: Awaited<ReturnType<typeof createAgent>>;
  image?: AgentImageUploadResult;
}

export const createAgentWithPicture = async (
  input: CreateWithPictureInput,
  deps: AgentDependencies,
  fetchImplementation?: typeof globalThis.fetch,
): Promise<CreateWithPictureResult> => {
  let localImage: LocalAgentImage | undefined;
  let imageURL = input.imageURL;
  if (input.image !== undefined) {
    // Only creation may say "No agent was created": the same checks are reached
    // by a contact-card update with no agent in play.
    const image = await prepareAgentImage(input.image, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.home ? { home: input.home } : {}),
    }).catch((error: unknown) => { throw new Error(`${error instanceof Error ? error.message : String(error)} No agent was created.`); });
    if (image.kind === "file") localImage = image.file;
    else imageURL = image.url;
  }
  if (input.imageRecipe !== undefined && imageURL === undefined && !localImage) {
    throw new Error("--image-recipe requires its rendered --image or --image-url.");
  }
  const result = await createAgent({
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.apiURL === undefined ? {} : { apiURL: input.apiURL }),
    ...(input.tokenName === undefined ? {} : { tokenName: input.tokenName }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    ...(input.about === undefined ? {} : { about: input.about }),
    ...(imageURL === undefined ? {} : { imageURL }),
    ...(input.imageRecipe === undefined || localImage ? {} : { imageRecipe: input.imageRecipe }),
    ...(input.makeDefault ? { makeDefault: true } : {}),
  }, deps);
  if (!localImage) return { result };
  let image: AgentImageUploadResult;
  try {
    // The agent and its token are already saved. Never use a token from the
    // environment for a just-created agent's picture upload.
    const saved = (await deps.read()).profiles[result.profile];
    if (!saved?.agent_token || validateApiURL(saved.api_url ?? DEFAULT_API_URL) !== result.api_url) throw new Error("Saved identity changed.");
    const client = new Relay({ apiKey: saved.agent_token, baseURL: result.api_url, ...(fetchImplementation ? { fetch: fetchImplementation } : {}) });
    const outcome = await uploadAgentImage({ handle: result.handle, image: localImage }, client,
      (attachmentID) => client.contactCard.update({
        handle: result.handle,
        attachment_id: attachmentID,
        ...(input.imageRecipe ? { image_recipe: input.imageRecipe } : {}),
      }, { maxRetries: 0 }));
    image = safeMetadata(outcome, [saved.agent_token]);
    if (image.status === "updated") Object.assign(result, agentRecord(image.agent));
  } catch {
    image = { status: "incomplete", phase: "agent", message: "The agent was created and its token was saved. The picture did not go through. Set the picture on this profile; do not create the agent again." };
  }
  return { result, image };
};

/** The one sentence a caller prints when a picture did not finish. */
export const incompletePictureMessage = (
  handle: string,
  profile: string,
  image: AgentImageUploadResult,
  hasRecipe: boolean,
): string => {
  const retry = image.status === "incomplete" && image.attachment_id && ["check", "save"].includes(image.phase)
    ? `--attachment-id ${image.attachment_id}` : "--image <local-file>";
  return `Agent @${handle} was created and its profile and token are saved. The picture did not go through. Set it on this profile: npx relaymessenger --profile ${profile} contact-card update --handle ${handle} ${retry}${hasRecipe ? " --image-recipe <json-file>" : ""}. Do not create another agent.`;
};
