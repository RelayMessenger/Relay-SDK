import { prepareAgentImage, type LocalAgentImage } from "./local-image.js";
import { uploadAgentImage, type AgentImageUploadResult } from "./agent-image-upload.js";
import { agentRecord, createAgent, type AgentDependencies, type CreateAgentInput } from "./agents.js";
import { safeMetadata } from "./output.js";
import Relay, { type AgentImageRecipe } from "@relaymessenger/sdk";
import { defaultCreationApiURL, validateApiURL } from "./config.js";
import { createHash } from "node:crypto";

/**
 * The picture tree for a new agent (owner ruling, 2026-09-14): a supplied
 * picture wins; a supplied name or handle leaves the picture to the server,
 * which draws a monogram; an identity the CLI invented whole (no picture, no
 * name, no handle) gets a bird, chosen by the server's own rule so the CLI and
 * the server agree: sha256(handle) first byte, modulo 84, in manifest order
 * (Relay-Server server/src/default-avatar.ts). The bird is set after the agent
 * exists, from the handle Relay returned, through the same contact-card update
 * every picture uses: Relay Console's create route takes no picture field.
 */
const BIRD_COUNT = 84;
const manifests = new Map<string, Promise<string[] | undefined>>();

/** Forget the manifests read so far; tests use it between cases. */
export const forgetBirdManifests = (): void => { manifests.clear(); };

const birdFiles = (apiURL: string, fetchImplementation: typeof globalThis.fetch): Promise<string[] | undefined> => {
  const cached = manifests.get(apiURL);
  if (cached) return cached;
  const reading = (async () => {
    const response = await fetchImplementation(new URL("/avatars/manifest.json", apiURL));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json() as { assets?: Array<{ file?: unknown }> };
    const files = (manifest.assets ?? []).map((asset) => asset.file);
    if (files.length < BIRD_COUNT || files.some((file) => typeof file !== "string")) throw new Error("not the 84-bird manifest");
    return files as string[];
  })().catch((error: unknown) => {
    process.stderr.write(`Relay could not read the bird pictures (${error instanceof Error ? error.message : String(error)}); the server will pick this agent's picture.\n`);
    return undefined;
  });
  manifests.set(apiURL, reading);
  return reading;
};

/** The bird address for a handle, or undefined when the manifest could not be read. */
export const birdImageUrl = async (
  apiURL: string,
  handle: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> => {
  const files = await birdFiles(apiURL, fetchImplementation);
  if (!files) return undefined;
  const index = createHash("sha256").update(handle, "utf8").digest()[0]! % BIRD_COUNT;
  return new URL(`/avatars/${files[index]!}`, apiURL).toString();
};

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
  // Nothing typed at all: the CLI invented the name and the handle, so it also
  // names the bird. Any supplied field leaves the picture to the server.
  const invented = input.handle === undefined && input.firstName === undefined && imageURL === undefined && !localImage;
  const result = await createAgent({
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.apiURL === undefined ? {} : { apiURL: input.apiURL }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    ...(input.about === undefined ? {} : { about: input.about }),
    ...(imageURL === undefined ? {} : { imageURL }),
    ...(input.imageRecipe === undefined || localImage ? {} : { imageRecipe: input.imageRecipe }),
    ...(input.makeDefault ? { makeDefault: true } : {}),
  }, deps);
  if (invented) imageURL = await birdImageUrl(result.api_url, result.handle, fetchImplementation ?? globalThis.fetch);
  if (!localImage && !imageURL) return { result };
  let image: AgentImageUploadResult;
  try {
    // The agent and its token are already saved. Never use a token from the
    // environment for a just-created agent's picture upload.
    const saved = (await deps.read()).profiles[result.profile];
    if (!saved?.agent_token || validateApiURL(saved.api_url ?? defaultCreationApiURL()) !== result.api_url) throw new Error("Saved identity changed.");
    const client = new Relay({ apiKey: saved.agent_token, baseURL: result.api_url, ...(fetchImplementation ? { fetch: fetchImplementation } : {}) });
    if (imageURL) {
      const card = await client.contactCard.update({
        handle: result.handle, image_url: imageURL,
        ...(input.imageRecipe ? { image_recipe: input.imageRecipe } : {}),
      }, { maxRetries: 0 });
      Object.assign(result, safeMetadata(agentRecord(card), [saved.agent_token]));
      return { result };
    }
    const outcome = await uploadAgentImage({ handle: result.handle, image: localImage! }, client,
          (attachmentID) => client.contactCard.update({
            handle: result.handle, attachment_id: attachmentID,
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
