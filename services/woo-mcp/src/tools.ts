import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WooClient, WooError } from "./woo.js";

// Build a fresh McpServer with the WooCommerce tools registered. In stateless
// Streamable HTTP mode we create one of these per request.
export function buildServer(woo: WooClient, storeId: string): McpServer {
  const server = new McpServer(
    { name: `woocommerce-${storeId}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Helper: run a WooCommerce call and wrap the result/error as MCP tool output.
  const run = async (fn: () => Promise<unknown>) => {
    try {
      const data = await fn();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof WooError
        ? `WooCommerce error (HTTP ${err.status}): ${err.message}`
        : `Unexpected error: ${(err as Error).message}`;
      return { isError: true, content: [{ type: "text" as const, text: msg }] };
    }
  };

  server.registerTool("list_products", {
    description: "List products in the WooCommerce store. Supports search text, pagination, and status filter.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      search: z.string().optional().describe("Free-text search over product name/description"),
      status: z.enum(["any", "draft", "pending", "private", "publish"]).optional(),
      per_page: z.number().int().min(1).max(100).optional().describe("Results per page (default 10)"),
      page: z.number().int().min(1).optional(),
    },
  }, async (args) => run(() => woo.listProducts({ per_page: 10, ...args })));

  server.registerTool("create_product", {
    description: "Create a new product in the WooCommerce store. It appears on the storefront immediately.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      name: z.string().describe("Product name"),
      regular_price: z.string().describe("Price as a decimal string, e.g. \"19.99\""),
      description: z.string().optional(),
      sku: z.string().optional(),
      status: z.enum(["draft", "pending", "private", "publish"]).optional().describe("Default publish"),
    },
  }, async (args) => run(() => woo.createProduct(args)));

  server.registerTool("list_orders", {
    description: "List store orders. Filter by status and by date range (ISO-8601, e.g. for 'orders today').",
    annotations: { readOnlyHint: true },
    inputSchema: {
      status: z.enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]).optional(),
      after: z.string().optional().describe("ISO-8601 datetime; only orders created after this"),
      before: z.string().optional().describe("ISO-8601 datetime; only orders created before this"),
      per_page: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
    },
  }, async (args) => run(() => woo.listOrders({ per_page: 20, ...args })));

  server.registerTool("get_order", {
    description: "Get a single order by its numeric ID, including line items and customer details.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.number().int().positive().describe("The WooCommerce order ID"),
    },
  }, async (args) => run(() => woo.getOrder(args.id)));

  server.registerTool("update_order_status", {
    description: "Update an order's status (e.g. processing, completed, cancelled, refunded).",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      id: z.number().int().positive(),
      status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]),
    },
  }, async (args) => run(() => woo.updateOrderStatus(args.id, args.status)));

  return server;
}
