const BOOT_TS = Date.now();

export class CartDurableObject extends DurableObject {
  async fetch() {
    this.ctx.storage.sql.exec("SELECT 1");
    return new Response(String(BOOT_TS));
  }
}

export default {
  async fetch(_req: Request, env: Record<string, any>) {
    await env.STOCK.fetch("https://internal/stock");
    await env.MISSING_BINDING.get("k");
    await env.ORDER_WF.create({ id: "order:2026:01" });
    await env.DB.prepare("SELECT id, status FROM orders WHERE id IN (?)").bind(...items).all();
    return new Response("ok");
  }
};
