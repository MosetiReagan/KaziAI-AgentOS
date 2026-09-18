# MCP

MCP is a first-class tool source, not a special case (spec §19). A discovered MCP
tool becomes an ordinary tool in the registry, governed by the same policy, the
same permissions, the same journal and the same trace as a local one. The agent
cannot tell whether `github.create_issue` is local, HTTP or remote — and does not
need to.

## Configuring a server

```yaml
mcp:
  strict: true
  servers:
    - id: github
      transport:
        type: http
        url: https://mcp.example/mcp
        auth:
          header: authorization
          scheme: Bearer
          secretRef: secret://github/token     # never a literal credential
      clientInfo: { name: 'agentos', version: '0.1.0' }
      requestTimeoutMs: 30000
      risk: HIGH                     # what this server's tools are worth by default
      allowedTools: [create_issue, search_issues, get_file_contents]
      blockedTools: [delete_repository]
      idempotentTools: [search_issues]
      permissions:
        network: { enabled: true }

    - id: files
      transport:
        type: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspaces']
        env: {}
```

From code, servers are connected while the OS is being built, and the report is
read back afterwards:

```typescript
const os = await createAgentOS({
  mcp: { strict: true, servers: [{ id: 'github', transport: { type: 'http', url } }] },
});

const report = os.mcpReport();
console.log(report.statuses);        // per-server connect state and tool counts
console.log(report.registeredTools); // ['mcp.github.create_issue', ...]
```

## What the runtime decides for you

- **Discovery is bounded.** `allowedTools` and `blockedTools` are applied before
  registration, and a tool the run's permissions cannot support is not offered.
- **Risk defaults to HIGH.** A remote tool is not assumed to be a read just
  because its name says `get`. Set `risk` per server, and argument-aware rules
  still raise it.
- **Idempotency defaults to unknown.** Discovered tools are treated as
  non-idempotent unless you list them, so a retry asks a human rather than
  re-issuing a write (spec §32).
- **Timeouts are real.** `requestTimeoutMs` bounds each RPC and the handshake.
- **Authentication is by reference.** `secretRef` must be a `secret://` value;
  the schema rejects a literal token.
- **Failures are visible.** A server that cannot be reached shows up in
  `McpServerStatus` with `connected: false`, an error and a failure count, and in
  `kazi-agent doctor` and `GET /api/mcp`. With `strict: true` (the default), a
  failed startup is an error rather than a silently reduced tool set.

## Normalisation

MCP's JSON Schema tool definitions are converted to the same internal
representation as a Zod-defined local tool: validated inputs, a `ToolResult`,
classified errors, artifacts and redaction. A malicious or malformed tool
response is untrusted content like any other and cannot widen permissions
(spec §67).
