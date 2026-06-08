import { authenticateRequest } from "../services/auth.js";
import * as log from "./logger.js";

export async function requireRouteAuth(request) {
  const auth = await authenticateRequest(request, log);
  if (!auth.ok) return { ok: false, response: auth.response };
  return { ok: true, auth };
}
