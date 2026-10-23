// Thin WooCommerce REST API client.
//
// Auth mechanism (see the store chart's mu-plugin): in-cluster traffic is plain
// HTTP, but WooCommerce only honours consumer key/secret when is_ssl() is true.
// We therefore:
//   * target the internal Service (WOO_BASE_URL), but send the canonical Host
//     header (WOO_CANONICAL_HOST) so WordPress does not issue a canonical redirect;
//   * send "X-Forwarded-Proto: https", which the mu-plugin turns into is_ssl()=true;
//   * pass the key/secret as query-string params, because Apache strips the
//     Authorization header before PHP (so HTTP Basic auth would silently fail).

export interface WooConfig {
  baseUrl: string;        // e.g. http://store-default-wordpress
  canonicalHost: string;  // e.g. store.urumi.localhost:8080
  consumerKey: string;
  consumerSecret: string;
}

export class WooError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = "WooError";
  }
}

export class WooClient {
  constructor(private cfg: WooConfig) {}

  private buildUrl(path: string, params: Record<string, unknown> = {}): string {
    const url = new URL(`/wp-json/wc/v3/${path.replace(/^\/+/, "")}`, this.cfg.baseUrl);
    url.searchParams.set("consumer_key", this.cfg.consumerKey);
    url.searchParams.set("consumer_secret", this.cfg.consumerSecret);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async request<T>(method: string, path: string, opts: {
    params?: Record<string, unknown>;
    body?: unknown;
  } = {}): Promise<T> {
    const url = this.buildUrl(path, opts.params);
    const headers: Record<string, string> = {
      Host: this.cfg.canonicalHost,
      "X-Forwarded-Proto": "https",
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `HTTP ${res.status}`);
      throw new WooError(res.status, parsed, `WooCommerce ${method} ${path} failed: ${msg}`);
    }
    return parsed as T;
  }

  listProducts(params: { search?: string; per_page?: number; page?: number; status?: string }) {
    return this.request<unknown[]>("GET", "products", { params });
  }

  createProduct(body: {
    name: string; regular_price: string; description?: string;
    type?: string; status?: string; sku?: string;
  }) {
    return this.request<unknown>("POST", "products", {
      body: { type: "simple", status: "publish", ...body },
    });
  }

  listOrders(params: { status?: string; after?: string; before?: string; per_page?: number; page?: number }) {
    return this.request<unknown[]>("GET", "orders", { params });
  }

  getOrder(id: number) {
    return this.request<unknown>("GET", `orders/${id}`);
  }

  updateOrderStatus(id: number, status: string) {
    return this.request<unknown>("PUT", `orders/${id}`, { body: { status } });
  }
}
