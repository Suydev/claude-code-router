import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import { loadAppConfig, saveAppConfig } from "@ccr/core/config/config.ts";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { replacePersistedApiKeys } from "@ccr/core/config/config-repository.ts";
import { probeExistingCcrGateway } from "@ccr/core/gateway/existing-gateway-probe.ts";
import { gatewayRuntimeConfigRevision } from "@ccr/core/gateway/runtime-config-control.ts";
import { gatewayService } from "@ccr/core/gateway/service.ts";

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function createHealthyCcrGateway(apiKey, state = {}) {
  if (state.revision === undefined) state.revision = "test-revision";
  return createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      sendJson(response, 200, {
        core: "http://127.0.0.1:3457",
        status: "running",
        timestamp: new Date().toISOString()
      });
      return;
    }
    if (url.pathname === "/") {
      sendJson(response, 200, {
        core: "next-ai-gateway",
        endpoints: ["GET /v1/models"],
        name: "claude-code-router",
        plugin: "claude-code-router"
      });
      return;
    }
    if (url.pathname === "/v1/models") {
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        sendJson(response, 401, { error: { message: "Invalid API key." } });
        return;
      }
      sendJson(response, 200, { data: [{ id: "test-model", object: "model" }], object: "list" });
      return;
    }
    if (url.pathname === "/__ccr/runtime/config") {
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        sendJson(response, 401, { error: { message: "Invalid API key." } });
        return;
      }
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          try {
            state.revision = JSON.parse(body).configRevision;
          } catch {
            // keep the previous revision
          }
          sendJson(response, 202, {
            accepted: true,
            configRevision: state.revision,
            restarting: false
          });
        });
        return;
      }
      sendJson(response, 200, { revision: state.revision, state: "running" });
      return;
    }
    sendJson(response, 404, { error: { message: "Not found." } });
  });
}

test("existing gateway probe finds a key that is only stored in the api key database", async () => {
  const apiKey = "persisted-only-key";
  const gatewayPort = await findAvailablePort();
  const config = createDefaultAppConfig();
  config.gateway.port = gatewayPort;
  // Modern installs keep the gateway key in the api_keys table and leave the
  // legacy config fields empty.
  config.APIKEY = "";
  config.APIKEYS = [];
  await replacePersistedApiKeys([{ createdAt: new Date().toISOString(), id: "local-gateway", key: apiKey, name: "Local Gateway" }]);

  const externalGateway = createHealthyCcrGateway(apiKey);
  await new Promise((resolve) => externalGateway.listen(gatewayPort, "127.0.0.1", resolve));

  try {
    const probe = await probeExistingCcrGateway(config);
    assert.equal(probe.state, "usable");
    assert.equal(probe.apiKey, apiKey);
  } finally {
    await new Promise((resolve) => externalGateway.close(resolve));
    await replacePersistedApiKeys([]);
  }
});

test("adopting an external gateway keeps a usable core auth token", async () => {
  const apiKey = "persisted-only-key";
  const gatewayPort = await findAvailablePort();
  const corePort = await findAvailablePort();
  const config = await loadAppConfig();
  config.gateway.port = gatewayPort;
  config.gateway.corePort = corePort;
  config.APIKEY = "";
  config.APIKEYS = [];
  await replacePersistedApiKeys([{ createdAt: new Date().toISOString(), id: "local-gateway", key: apiKey, name: "Local Gateway" }]);

  const externalGatewayState = { revision: undefined };
  const savedConfig = await saveAppConfig(config);
  externalGatewayState.revision = gatewayRuntimeConfigRevision(savedConfig);
  const externalGateway = createHealthyCcrGateway(apiKey, externalGatewayState);
  await new Promise((resolve) => externalGateway.listen(gatewayPort, "127.0.0.1", resolve));

  try {
    await gatewayService.stop();
    const status = await gatewayService.ensureStarted(config);

    assert.equal(status.state, "running", status.lastError);
    assert.equal(status.gatewayManagedExternally, true);
    // The adopted gateway owns its own core runtime, so the adopting process
    // cannot leave the core auth token empty: the upstream executor refuses to
    // send a request without a credential and every proxied call would fail
    // with "Core gateway auth token is not initialized.".
    assert.equal(gatewayService.coreAuthToken, apiKey);
    // Requests have to be forwarded to the endpoint this process can
    // authenticate against.
    assert.equal(status.coreEndpoint, `http://127.0.0.1:${gatewayPort}`);
  } finally {
    await gatewayService.stop();
    await new Promise((resolve) => externalGateway.close(resolve));
    await replacePersistedApiKeys([]);
  }
});
