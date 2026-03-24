/**
 * pi-figma-mcp — pi extension
 *
 * Bridges the Figma MCP server into pi as native tools.
 *
 * Supports two modes:
 *   1. Remote server (default): https://mcp.figma.com/mcp — OAuth auth, full feature set including use_figma write tool
 *   2. Desktop server (fallback): http://127.0.0.1:3845/mcp — no auth, read-only, requires Figma desktop app
 *
 * Set FIGMA_MCP_MODE=desktop to force desktop mode.
 * Set FIGMA_MCP_PORT=<port> to override the desktop server port.
 *
 * Tools are discovered dynamically from the server on session start.
 * Commands:
 *   /figma-mcp       — show connection status and available tools
 *   /figma-mcp-auth  — run OAuth authentication for the remote server
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// ## Config

const REMOTE_URL = "https://mcp.figma.com/mcp";
const DESKTOP_URL = `http://127.0.0.1:${process.env.FIGMA_MCP_PORT ?? "3845"}/mcp`;
const MODE = (process.env.FIGMA_MCP_MODE ?? "remote") as "remote" | "desktop";
const MAX_OUTPUT_BYTES = 50 * 1024;
const TOKEN_PATH = join(homedir(), ".pi", "figma-mcp-token.json");

const OAUTH_AUTHORIZATION_URL = "https://www.figma.com/oauth/mcp";
const OAUTH_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const OAUTH_CALLBACK_PORT = 9876;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
const OAUTH_REGISTRATION_URL = "https://api.figma.com/v1/oauth/mcp/register";

// ## State

let mcpUrl = MODE === "desktop" ? DESKTOP_URL : REMOTE_URL;
let sessionId: string | undefined;
let requestId = 1;
let connected = false;
let serverMode: "remote" | "desktop" = MODE;
let availableTools: Array<{ name: string; description: string }> = [];
let accessToken: string | undefined;
let refreshToken: string | undefined;
let clientId: string | undefined;
let clientSecret: string | undefined;
let tokenExpiresAt = 0;

// ## Token persistence

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

function loadToken(): boolean {
  try {
    if (!existsSync(TOKEN_PATH)) return false;
    const data: TokenData = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    tokenExpiresAt = data.expiresAt ?? 0;
    clientId = data.clientId;
    clientSecret = data.clientSecret;
    return !!accessToken;
  } catch {
    return false;
  }
}

function saveToken(): void {
  try {
    mkdirSync(join(homedir(), ".pi"), { recursive: true });
    const data: TokenData = {
      accessToken: accessToken!,
      refreshToken,
      expiresAt: tokenExpiresAt,
      clientId,
      clientSecret,
    };
    writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Non-fatal
  }
}

// ## PKCE helpers

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ## OAuth 2.0 dynamic client registration + PKCE

async function registerOAuthClient(): Promise<{ clientId: string; clientSecret: string }> {
  const res = await fetch(OAUTH_REGISTRATION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code",
      redirect_uris: [OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:connect",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { client_id: string; client_secret?: string };
  return { clientId: data.client_id, clientSecret: data.client_secret ?? "" };
}

async function waitForAuthCode(
  state: string
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let server: Server;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error("OAuth timeout — no callback received within 120s"));
    }, 120_000);

    server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${OAUTH_CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authentication failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Invalid callback</h2><p>You can close this tab.</p></body></html>`
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h2>Authenticated with Figma ✓</h2><p>You can close this tab and return to pi.</p></body></html>`
      );
      clearTimeout(timeout);
      server.close();
      resolve({ code, state: returnedState });
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {});
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(`Could not start OAuth callback server on port ${OAUTH_CALLBACK_PORT}: ${err.message}`)
      );
    });
  });
}

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string
): Promise<void> {
  const params: Record<string, string> = {
    client_id: clientId!,
    redirect_uri: OAUTH_REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
  };
  if (clientSecret) params.client_secret = clientSecret;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiresAt = data.expires_in
    ? Date.now() + data.expires_in * 1000
    : 0;
  saveToken();
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken || !clientId) return false;

  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret ?? "",
      }).toString(),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    tokenExpiresAt = data.expires_in
      ? Date.now() + data.expires_in * 1000
      : 0;
    saveToken();
    return true;
  } catch {
    return false;
  }
}

async function runFullOAuthFlow(ctx: {
  ui: {
    notify: (msg: string, level: string) => void;
  };
}): Promise<boolean> {
  // Step 1: Dynamic client registration
  ctx.ui.notify("Registering with Figma MCP server...", "info");
  const reg = await registerOAuthClient();
  clientId = reg.clientId;
  clientSecret = reg.clientSecret;

  // Step 2: Generate PKCE verifier + challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  // Step 2: Build authorization URL
  const authUrl = new URL(OAUTH_AUTHORIZATION_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "mcp:connect");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Step 4: Open browser + wait for callback
  ctx.ui.notify(
    `Opening browser for Figma authentication...\n\nIf the browser doesn't open, visit:\n${authUrl.toString()}`,
    "info"
  );

  // Open browser
  const { exec } = await import("node:child_process");
  exec(`open "${authUrl.toString()}"`);

  // Wait for the callback
  const { code } = await waitForAuthCode(state);

  // Step 5: Exchange code for tokens
  await exchangeCodeForToken(code, codeVerifier);

  return true;
}

// ## MCP HTTP client

async function mcpPost(
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  // Auto-refresh if token is about to expire
  if (
    serverMode === "remote" &&
    tokenExpiresAt > 0 &&
    Date.now() > tokenExpiresAt - 60_000
  ) {
    await refreshAccessToken();
  }

  const id = requestId++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (accessToken && serverMode === "remote") {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal,
  });

  const newSid = response.headers.get("mcp-session-id");
  if (newSid) sessionId = newSid;

  if (!response.ok) {
    if (response.status === 401 && serverMode === "remote") {
      // Try refresh before giving up
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        // Retry once with new token
        const retryHeaders = { ...headers, Authorization: `Bearer ${accessToken}` };
        const retry = await fetch(mcpUrl, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
          signal,
        });
        const retrySid = retry.headers.get("mcp-session-id");
        if (retrySid) sessionId = retrySid;
        if (!retry.ok) throw new Error("AUTH_REQUIRED");

        const ct = retry.headers.get("content-type") ?? "";
        const txt = await retry.text();
        let j: { result?: unknown; error?: { message: string } };
        if (ct.includes("text/event-stream")) {
          const dl = txt.split("\n").find((l) => l.startsWith("data: "));
          if (!dl) throw new Error("No data in SSE response");
          j = JSON.parse(dl.slice(6));
        } else {
          j = JSON.parse(txt);
        }
        if (j.error) throw new Error(j.error.message);
        return j.result;
      }
      throw new Error("AUTH_REQUIRED");
    }
    throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  let json: { result?: unknown; error?: { message: string } };

  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error("No data in SSE response");
    json = JSON.parse(dataLine.slice(6));
  } else {
    json = JSON.parse(text);
  }

  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ## Initialize MCP session

async function initializeSession(signal?: AbortSignal): Promise<boolean> {
  try {
    sessionId = undefined;
    await mcpPost(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-figma-mcp", version: "2.0" },
      },
      signal
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "AUTH_REQUIRED") return false;
    throw err;
  }
}

// ## Try connecting — remote first, then desktop fallback

async function tryConnect(signal?: AbortSignal): Promise<boolean> {
  if (MODE === "remote") {
    mcpUrl = REMOTE_URL;
    serverMode = "remote";

    if (loadToken()) {
      try {
        const ok = await initializeSession(signal);
        if (ok) return true;
      } catch {
        // Fall through
      }
    }
  }

  // Fall back to desktop
  mcpUrl = DESKTOP_URL;
  serverMode = "desktop";
  accessToken = undefined;

  try {
    const ok = await initializeSession(signal);
    return ok;
  } catch {
    return false;
  }
}

// ## Tool discovery and invocation

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
        items?: unknown;
        default?: unknown;
      }
    >;
    required?: string[];
  };
}

interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

async function listTools(signal?: AbortSignal): Promise<McpTool[]> {
  const result = (await mcpPost("tools/list", undefined, signal)) as {
    tools: McpTool[];
  };
  return result.tools ?? [];
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpToolResult> {
  return (await mcpPost(
    "tools/call",
    { name, arguments: args },
    signal
  )) as McpToolResult;
}

// ## Content conversion

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  return (
    Buffer.from(text, "utf8").slice(0, MAX_OUTPUT_BYTES).toString("utf8") +
    "\n\n[Output truncated — use a more specific nodeId or break the design into smaller sections.]"
  );
}

function convertContent(
  mcpContent: McpContent[]
): Array<
  { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
> {
  const out: ReturnType<typeof convertContent> = [];
  for (const c of mcpContent) {
    if (c.type === "text" && c.text) {
      out.push({ type: "text", text: truncate(c.text) });
    } else if (c.type === "image" && c.data && c.mimeType) {
      out.push({ type: "image", mimeType: c.mimeType, data: c.data });
    } else if (c.type === "resource" && c.uri) {
      out.push({ type: "text", text: `[Resource: ${c.uri}]` });
    }
  }
  return out;
}

// ## Schema builder

function buildSchema(inputSchema: McpTool["inputSchema"]): TSchema {
  const props = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);
  const fields: Record<string, TSchema> = {};

  for (const [key, prop] of Object.entries(props)) {
    let schema: TSchema;

    if (prop.enum) {
      schema = Type.Union(prop.enum.map((v) => Type.Literal(v)));
    } else if (prop.type === "boolean") {
      schema = Type.Boolean();
    } else if (prop.type === "number" || prop.type === "integer") {
      schema = Type.Number();
    } else if (prop.type === "array") {
      schema = Type.Array(Type.Any());
    } else {
      schema = Type.String();
    }

    const description = prop.description ?? "";
    const withDesc = description ? { ...schema, description } : schema;
    fields[key] = required.has(key) ? withDesc : Type.Optional(withDesc);
  }

  return Type.Object(fields);
}

// ## Tool registration

function formatLabel(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function registerMcpTools(pi: ExtensionAPI, tools: McpTool[]) {
  availableTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
  }));

  for (const tool of tools) {
    const schema = buildSchema(tool.inputSchema);

    pi.registerTool({
      name: tool.name,
      label: formatLabel(tool.name),
      description: tool.description,
      parameters: schema,

      async execute(_id, params, signal) {
        if (!sessionId) {
          const ok = await initializeSession(signal);
          if (!ok) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    serverMode === "remote"
                      ? "Figma MCP remote server session expired. Run /figma-mcp-auth to re-authenticate."
                      : "Figma MCP server is not reachable. Make sure the Figma desktop app is open and the MCP server is enabled.",
                },
              ],
              isError: true,
            };
          }
        }

        try {
          const result = await callTool(
            tool.name,
            params as Record<string, unknown>,
            signal
          );
          return {
            content: convertContent(result.content),
            isError: result.isError ?? false,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "AUTH_REQUIRED") {
            accessToken = undefined;
            sessionId = undefined;
            return {
              content: [
                {
                  type: "text",
                  text: "Figma MCP authentication expired. Run /figma-mcp-auth to re-authenticate.",
                },
              ],
              isError: true,
            };
          }
          if (msg.includes("404") || msg.includes("session"))
            sessionId = undefined;
          return {
            content: [{ type: "text", text: `Figma MCP error: ${msg}` }],
            isError: true,
          };
        }
      },
    });
  }
}

// ## Extension

export default function (pi: ExtensionAPI) {

  // ## Lifecycle

  pi.on("session_start", async (_event, ctx) => {
    (async () => {
      const signal = AbortSignal.timeout(10_000);
      try {
        const ok = await tryConnect(signal);
        if (!ok) {
          connected = false;
          ctx.ui.setStatus("figma", "figma ✗");
          return;
        }

        const tools = await listTools(signal);
        connected = true;
        const modeLabel =
          serverMode === "remote"
            ? "figma ✓ (remote)"
            : "figma ✓ (desktop)";
        ctx.ui.setStatus("figma", modeLabel);
        registerMcpTools(pi, tools);
      } catch {
        connected = false;
        ctx.ui.setStatus("figma", "figma ✗");
      }
    })();
  });

  // ## System prompt

  pi.on("before_agent_start", async (event) => {
    if (!connected) return;

    const writeNote =
      serverMode === "remote"
        ? "The `use_figma` tool can **create, edit, and delete** content on the Figma canvas by executing Plugin API JavaScript. Use it for all canvas mutations. The `search_design_system` tool finds existing components and variables in connected libraries."
        : "This is a read-only connection (desktop server). To manipulate the canvas, use the `figma_*` tools (figma-labor bridge) instead.";

    return {
      systemPrompt:
        event.systemPrompt +
        `

## Figma MCP Server

You have a live connection to Figma via the ${serverMode} MCP server.

${writeNote}

**nodeId format:** Use \`123:456\` or \`123-456\`. Extract from Figma URLs: \`?node-id=1-2\` → \`1:2\`. If no nodeId is given, the tool uses whatever is currently selected in Figma.

**Design-to-code workflow:** call \`get_screenshot\` first for visual reference, then \`get_design_context\` for layout and structure. If the response is too large, use \`get_metadata\` to get an overview, then \`get_design_context\` on specific child nodes.
`,
    };
  });

  // ## Commands

  pi.registerCommand("figma-mcp", {
    description: "Show Figma MCP server connection status and available tools",
    handler: async (_args, ctx) => {
      if (!connected) {
        const msg =
          MODE === "remote"
            ? "Figma MCP server is not connected.\n\nRun /figma-mcp-auth to authenticate with the remote server, or set FIGMA_MCP_MODE=desktop to use the desktop server."
            : "Figma MCP server is not connected.\n\nTo enable:\n1. Open Figma desktop app\n2. Open a Design file\n3. Switch to Dev Mode (Shift+D)\n4. In the Inspect panel → MCP server → Enable desktop MCP server";
        ctx.ui.notify(msg, "error");
        return;
      }
      ctx.ui.notify(
        `Figma MCP server connected ✓ (${serverMode})\nURL: ${mcpUrl}\n\nAvailable tools (${availableTools.length}):\n${availableTools.map((t) => `  • ${t.name}`).join("\n")}`,
        "success"
      );
    },
  });

  pi.registerCommand("figma-mcp-auth", {
    description: "Authenticate with the Figma remote MCP server via OAuth",
    handler: async (_args, ctx) => {
      if (MODE === "desktop") {
        ctx.ui.notify(
          "Desktop mode doesn't require authentication. Set FIGMA_MCP_MODE=remote to use the remote server.",
          "info"
        );
        return;
      }

      try {
        await runFullOAuthFlow(ctx);

        mcpUrl = REMOTE_URL;
        serverMode = "remote";
        const signal = AbortSignal.timeout(15_000);
        const ok = await initializeSession(signal);
        if (!ok) {
          ctx.ui.notify(
            "OAuth completed but could not initialize MCP session.",
            "error"
          );
          return;
        }
        const tools = await listTools(signal);
        connected = true;
        ctx.ui.setStatus("figma", "figma ✓ (remote)");
        registerMcpTools(pi, tools);
        ctx.ui.notify(
          `Authenticated ✓\n\nAvailable tools (${tools.length}):\n${tools.map((t) => `  • ${t.name}`).join("\n")}`,
          "success"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Authentication error: ${msg}`, "error");
      }
    },
  });
}
