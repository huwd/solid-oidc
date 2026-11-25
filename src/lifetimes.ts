/**
 * How long the provider's tokens, sessions and interactions last. Key
 * rotation waits on these: a key can be removed only once nothing it signed
 * can still be in use. See docs/decisions/0011-key-rotation.md.
 */

/** Access tokens and ID tokens, which the signing key signs. */
export const tokenLifetimeSeconds = 60 * 60;

/** A login session, whose cookie the cookie key signs. */
export const sessionLifetimeSeconds = 14 * 24 * 60 * 60;

/**
 * An app's refresh token, counted from the consent that first issued it. It
 * lasts as long as the grant behind it, so an app needs the person again at
 * least every 14 days. Refresh tokens are stored, not signed, so key
 * rotation doesn't wait on them.
 */
export const refreshTokenLifetimeSeconds = sessionLifetimeSeconds;

/** A login in progress, whose cookie the cookie key also signs. */
export const interactionLifetimeSeconds = 60 * 60;
