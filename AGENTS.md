# send: Agent guide

## Goal
Accountless client-side encrypted file/text transfer. This repository is public. Never commit real secrets, share links, personal files, or credentials. txt keys, accounts and storage must never be reused.

## Engineering
Use strict TDD: write and run a failing behavior test before production code, implement the minimum, then refactor. Protect concurrent quota/authority transitions with guarded SQL, not read-then-write checks. Use real Miniflare D1/R2 and real HTTP/browser integration tests. Never fake encrypted transport with base64 or claim tests using mocks exercised real persistence.

## Security
Never send the decryption key to the server. Keep capability secrets out of query strings, logs, analytics, and error messages. No third-party runtime scripts, fonts, trackers, or automatic previews of untrusted files. Render decrypted names/text using textContent, never innerHTML. Require authorization on every metadata/chunk operation. Expiry and revoke must deny reads even if physical deletion fails. Bound every request and response body.

## Delivery
No production deployments, remote database mutations, or public upload enabling without explicit authorization. Local operation and dry-runs are allowed. Public deployment must have a verified canonical origin, dedicated R2/D1, secret-backed rate limiting, enforced global storage caps, and documented retention. Do not claim external audits have occurred. Preserve downloaded-copy and compromised-browser limitations.

## Language
User-facing copy and project documentation: Japanese. Identifiers: English. Keep documentation concise and actionable.
