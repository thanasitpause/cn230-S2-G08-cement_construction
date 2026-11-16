// Vercel Function เดียวสำหรับทุก API: /api?view=overview | collection | lci | products | monthly | sources
import { getDb, explainError } from "../lib/db.mjs";
import * as Q from "../lib/queries.mjs";

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); // ดึงสดจาก Atlas ทุกครั้ง

export default {
  async fetch(request) {
    const p = new URL(request.url).searchParams;
    const view = p.get("view") || "overview";
    try {
      const db = await getDb();
      const t0 = Date.now();
      let data;
      switch (view) {
        case "overview": data = await Q.overview(db); break;
        case "collection": data = await Q.collection(db, p.get("name"), Math.max(0, Number(p.get("page")) || 0), p.get("field"), p.get("value")); break;
        case "lci": data = await Q.lci(db); break;
        case "products": data = await Q.products(db); break;
        case "monthly": data = await Q.monthly(db, p.get("product")); break;
        case "sources": data = await Q.sources(db); break;
        default: return json({ error: `ไม่รู้จัก view "${view}"` }, 404);
      }
      return json({ ...data, fetchedAt: new Date().toISOString(), queryMs: Date.now() - t0 });
    } catch (err) {
      return json({ error: explainError(err) }, err.status || 500);
    }
  },
};
