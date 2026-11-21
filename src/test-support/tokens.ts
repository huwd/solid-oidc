import { createPublicKey, verify, type webcrypto } from "node:crypto";

/** Decode a JWT's header and payload, without checking its signature. */
export function decodeJwt(jwt: string): {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
} {
  const [header = "", payload = ""] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

type PublishedKey = webcrypto.JsonWebKey & { readonly kid: string };

/** The keys the broker publishes, found through its discovery document. */
export async function publishedKeys(issuer: string): Promise<readonly PublishedKey[]> {
  const discovery = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as {
    readonly jwks_uri: string;
  };
  const jwks = (await (await fetch(discovery.jwks_uri)).json()) as {
    readonly keys: readonly PublishedKey[];
  };
  return jwks.keys;
}

/**
 * Check a token's ES256 signature against the broker's published keys, as a
 * Solid server does.
 */
export async function checkSignature(
  issuer: string,
  jwt: string,
): Promise<"valid" | "invalid" | "unpublished key"> {
  const keys = await publishedKeys(issuer);
  const jwk = keys.find((key) => key.kid === decodeJwt(jwt).header["kid"]);
  if (jwk === undefined) {
    return "unpublished key";
  }
  const [encodedHeader, encodedPayload, signature = ""] = jwt.split(".");
  const valid = verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { dsaEncoding: "ieee-p1363", key: createPublicKey({ format: "jwk", key: jwk }) },
    Buffer.from(signature, "base64url"),
  );
  return valid ? "valid" : "invalid";
}
