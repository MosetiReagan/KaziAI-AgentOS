import type { FastifyInstance } from 'fastify';
import { policyRuleSpec } from '@kazi-ai/agentos-policies';

/** Read-only views of what this deployment can do (spec §63). */
export function registerCatalogRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/agents', async (request) => {
    const principal = await context.principal(request);
    const items = await context.catalog.list({
      organizationId: principal.organizationId,
      projectId: principal.projectId ?? context.projectId,
    });
    return { items };
  });

  app.get('/api/tools', async (request) => {
    await context.principal(request);
    return { items: context.os.tools.describe() };
  });

  app.get('/api/providers', async (request) => {
    await context.principal(request);
    return { items: context.os.providers.describe() };
  });

  app.get('/api/policies', async (request) => {
    await context.principal(request);
    // The engine holds exactly the rules in force, including any registered
    // from configuration; a declarative rule also carries its own spec.
    return {
      items: context.os.runtime.policies.list().map((rule) => ({
        id: rule.id,
        description: rule.description,
        ...(policyRuleSpec(rule) ?? {}),
      })),
      riskRules: context.os.runtime.policies.classifier.list().map((rule) => ({
        id: rule.id,
        description: rule.description,
        risk: rule.risk,
        tool: rule.tool,
        conditional: rule.when !== undefined,
      })),
    };
  });

  app.get('/api/mcp', async (request) => {
    await context.principal(request);
    return context.os.mcpReport();
  });

  app.get('/api/info', async (request) => {
    await context.principal(request);
    return { info: context.os.info() };
  });
}
