import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function streamFileEvidence(file) {
  const hash = createHash("sha256");
  let bytes = 0;

  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }

  return { bytes, sha256: hash.digest("hex") };
}
