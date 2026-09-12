import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFolderLink, writeFolderLink, resolveAgent } from "./folder-link.js";

describe("folder links", () => {
  it("walk-up finds a parent link", async () => { const root=await mkdtemp(join(tmpdir(),"relay-link-")); await writeFolderLink(root,{handle:"a.dev",apiUrl:"https://api.relayapp.im"}); const child=join(root,"a","b"); await mkdir(child,{recursive:true}); expect((await readFolderLink(child))?.handle).toBe("a.dev"); });
  it("appends gitignore only when existing and missing", async () => { const root=await mkdtemp(join(tmpdir(),"relay-link-")); await writeFolderLink(root,{handle:"a.dev",apiUrl:"x"}); await expect(access(join(root,".gitignore"))).rejects.toThrow(); await writeFile(join(root,".gitignore"),"node_modules\n"); await writeFolderLink(root,{handle:"a.dev",apiUrl:"x"}); expect(await readFile(join(root,".gitignore"),"utf8")).toContain(".relay\n"); });
  it("resolves folder then env then default", async () => { const root=await mkdtemp(join(tmpdir(),"relay-link-")); const profiles={defaultAgent:{handle:"d",apiUrl:"d"}, env:{handle:"e",apiUrl:"e"}}; expect((await resolveAgent(root,{RELAY_AGENT:"env"},profiles))?.handle).toBe("e"); await writeFolderLink(root,{handle:"f",apiUrl:"f"}); expect((await resolveAgent(root,{RELAY_AGENT:"env"},profiles))?.handle).toBe("f"); expect((await resolveAgent(root,{},profiles))?.handle).toBe("f"); });
  it("mutation receipt: skip folder read in resolveAgent", async () => { const root=await mkdtemp(join(tmpdir(),"relay-link-")); expect((await resolveAgent(root,{}, {defaultAgent:{handle:"d",apiUrl:"d"}}, true))?.handle).toBe("d"); });
});
