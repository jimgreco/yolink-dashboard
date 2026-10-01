import { randomUUID } from "node:crypto";
import { inspectPersonalHome } from "./yolink.mjs";
import { encryptCredential, encryptionKey } from "./store.mjs";
import { validateHouseMapping } from "./houses.mjs";

// SSH-only administration. This module is never mounted as a web endpoint.
export async function preparePersonalConnection(input, keyValue, fetcher = fetch) {
  if (input?.approved !== true || !["inspect", "connect"].includes(input.action))
    throw new Error("Explicit personal connection approval is required");
  for (const value of [input.uaid, input.secret]) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096)
      throw new Error("Invalid personal credential");
  }
  if (input.action === "connect" && (typeof input.expectedHomeId !== "string" || !input.expectedHomeId))
    throw new Error("Confirm the discovered Home ID before connecting");
  const inspected = await inspectPersonalHome({ uaid: input.uaid, secret: input.secret, expectedHomeId: input.expectedHomeId }, fetcher);
  if (input.action === "inspect") return inspected;
  if (typeof input.ownerSub !== "string" || !input.ownerSub) throw new Error("Sign in as the owner first");
  const mapping = validateHouseMapping(input.label, input.deviceHouses || {}, inspected.devices);
  const id = randomUUID();
  const encrypted = encryptCredential({ uaid: input.uaid, secret: input.secret }, encryptionKey(keyValue), input.ownerSub, id, "personal_uac");
  return {
    id, ownerSub: input.ownerSub, expectedHomeId: inspected.homeId, ...mapping,
    cipher: encrypted.credential_cipher.toString("hex"),
    nonce: encrypted.credential_nonce.toString("hex"),
    tag: encrypted.credential_tag.toString("hex"),
  };
}
