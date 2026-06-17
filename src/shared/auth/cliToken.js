import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import {
  isVerifiableLoopbackRequest,
  isPrivateLanAccessRequest,
} from "@/shared/utils/loopbackRequest.js";

export const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;

async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

export async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER)?.trim();
  if (!token) return false;
  const expected = await getCliToken();
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** CLI token valid only from verifiable loopback; opt-in LAN via GENESIS_CLI_TOKEN_ALLOW_LAN=1. */
export async function hasValidLocalCliToken(request) {
  if (!(await hasValidCliToken(request))) return false;
  if (isVerifiableLoopbackRequest(request)) return true;
  if (process.env.GENESIS_CLI_TOKEN_ALLOW_LAN === "1" && isPrivateLanAccessRequest(request)) {
    return true;
  }
  return false;
}
