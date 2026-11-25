import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  DocumentViewSchema,
  type DocumentSnapshot,
  type DocumentView,
} from "./generated/editorinterop/v1/editor_interop_pb.js";
import { documentKey } from "./model.js";

/** Only this map allocates projection paths; host IDs never become path segments. */
export class Projections {
  private readonly paths = new Map<string, string>();
  constructor(readonly directory: string) {}
  async view(document: DocumentSnapshot): Promise<DocumentView> {
    const key = documentKey(document.ref);
    let path = this.paths.get(key);
    if (path === undefined) {
      path = join(
        this.directory,
        `${createHash("sha256").update(key).digest("hex")}.md`,
      );
      await this.replace(path, document.text);
      this.paths.set(key, path);
    }
    return create(DocumentViewSchema, { document, projectionPath: path });
  }
  async update(document: DocumentSnapshot): Promise<void> {
    const existing = this.paths.get(documentKey(document.ref));
    if (existing !== undefined) await this.replace(existing, document.text);
    else await this.view(document);
  }
  private async replace(path: string, text: string): Promise<void> {
    if ((await realpath(dirname(path))) !== this.directory)
      throw new Error("Projection directory changed");
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Projection is a symbolic link");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
}
