// Container healthcheck entry point. The image is distroless, with no shell or
// curl, so Docker runs this with Node in exec (CMD) form. Exit status is the
// only output Docker uses. Like main.ts, it is excluded from coverage and
// holds no logic of its own; `checkHealth` is tested directly.

import { healthPath } from "../app.ts";
import { checkHealth } from "../healthcheck.ts";

const timeoutMs = 3_000;
const port = process.env["PORT"] ?? "3000";

const healthy = await checkHealth({
  timeoutMs,
  url: new URL(`http://127.0.0.1:${port}${healthPath}`),
});
process.exitCode = healthy ? 0 : 1;
