// workers-oauth-utils.ts — from cloudflare/ai template
// OAuth utility functions with CSRF and state validation

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
  constructor(public code: string, public description: string, public statusCode = 400) {
    super(description);
    this.name = "OAuthError";
  }
  toResponse(): Response {
    return new Response(
      JSON.stringify({ error: this.code, error_description: this.description }),
      { status: this.statusCode, headers: { "Content-Type": "application/json" } }
    );
  }
}

export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  const setCookie = `__Host-CSRF_TOKEN=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

export function validateCSRFToken(formData: FormData, request: Request): { clearCookie: string } {
  const tokenFromForm = formData.get("csrf_token");
  if (!tokenFromForm || typeof tokenFromForm !== "string") {
    throw new OAuthError("invalid_request", "Missing CSRF token in form data");
  }
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const csrfCookie = cookies.find((c) => c.startsWith("__Host-CSRF_TOKEN="));
  const tokenFromCookie = csrfCookie ? csrfCookie.substring("__Host-CSRF_TOKEN=".length) : null;
  if (!tokenFromCookie || tokenFromForm !== tokenFromCookie) {
    throw new OAuthError("invalid_request", "CSRF token mismatch");
  }
  return { clearCookie: `__Host-CSRF_TOKEN=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0` };
}

export async function createOAuthState(
  oauthReqInfo: AuthRequest, kv: KVNamespace, stateTTL = 600
): Promise<{ stateToken: string }> {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), { expirationTtl: stateTTL });
  return { stateToken };
}

export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(stateToken));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { setCookie: `__Host-CONSENTED_STATE=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600` };
}

export async function validateOAuthState(
  request: Request, kv: KVNamespace
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string }> {
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");
  if (!stateFromQuery) throw new OAuthError("invalid_request", "Missing state parameter");

  const storedDataJson = await kv.get(`oauth:state:${stateFromQuery}`);
  if (!storedDataJson) throw new OAuthError("invalid_request", "Invalid or expired state");

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const consentedStateCookie = cookies.find((c) => c.startsWith("__Host-CONSENTED_STATE="));
  const consentedStateHash = consentedStateCookie ? consentedStateCookie.substring("__Host-CONSENTED_STATE=".length) : null;

  if (!consentedStateHash) {
    throw new OAuthError("invalid_request", "Missing session binding cookie");
  }

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(stateFromQuery));
  const stateHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (stateHash !== consentedStateHash) {
    throw new OAuthError("invalid_request", "State token does not match session");
  }

  const oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
  await kv.delete(`oauth:state:${stateFromQuery}`);
  const clearCookie = `__Host-CONSENTED_STATE=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
  return { oauthReqInfo, clearCookie };
}

export async function isClientApproved(request: Request, clientId: string, cookieSecret: string): Promise<boolean> {
  const clients = await getApprovedClientsFromCookie(request, cookieSecret);
  return clients?.includes(clientId) ?? false;
}

export async function addApprovedClient(request: Request, clientId: string, cookieSecret: string): Promise<string> {
  const existing = (await getApprovedClientsFromCookie(request, cookieSecret)) || [];
  const updated = Array.from(new Set([...existing, clientId]));
  const payload = JSON.stringify(updated);
  const signature = await signData(payload, cookieSecret);
  return `__Host-APPROVED_CLIENTS=${signature}.${btoa(payload)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`;
}

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  server: { name: string; logo?: string; description?: string };
  state: Record<string, any>;
  csrfToken: string;
  setCookie: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
  const { client, server, state, csrfToken, setCookie } = options;
  const encodedState = btoa(JSON.stringify(state));
  const serverName = escapeHtml(server.name);
  const clientName = escapeHtml(client?.clientName ?? "Unknown MCP Client");
  const description = server.description ? escapeHtml(server.description) : "";
  const html = `<!DOCTYPE html><html><head><title>${serverName} — Authorization</title>
<style>body{font-family:system-ui;max-width:500px;margin:4rem auto;padding:1rem}
.card{border:1px solid #ddd;border-radius:8px;padding:2rem}
button{padding:.75rem 1.5rem;border-radius:6px;cursor:pointer;border:none;font-size:1rem}
.primary{background:#0070f3;color:white}.secondary{background:transparent;border:1px solid #ddd}</style></head>
<body><div class="card"><h2>${serverName}</h2>
${description ? `<p>${description}</p>` : ""}
<p><strong>${clientName}</strong> is requesting access.</p>
<form method="post" action="${new URL(request.url).pathname}">
<input type="hidden" name="state" value="${encodedState}">
<input type="hidden" name="csrf_token" value="${csrfToken}">
<button type="button" class="secondary" onclick="history.back()">Cancel</button>
<button type="submit" class="primary">Approve</button></form></div></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html", "Set-Cookie": setCookie, "X-Frame-Options": "DENY" },
  });
}

// --- Helpers ---
async function getApprovedClientsFromCookie(request: Request, secret: string): Promise<string[] | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const cookie = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith("__Host-APPROVED_CLIENTS="));
  if (!cookie) return null;
  const value = cookie.substring("__Host-APPROVED_CLIENTS=".length);
  const [sig, b64] = value.split(".");
  if (!sig || !b64) return null;
  const payload = atob(b64);
  if (!(await verifySignature(sig, payload, secret))) return null;
  try { return JSON.parse(payload) as string[]; } catch { return null; }
}

async function signData(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(sig: string, data: string, secret: string): Promise<boolean> {
  const key = await importKey(secret);
  try {
    const sigBytes = new Uint8Array(sig.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  } catch { return false; }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
