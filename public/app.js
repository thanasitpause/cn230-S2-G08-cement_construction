"use strict";
/* CN230 S2-G08 — เว็บแสดงฐานข้อมูล LCI บน MongoDB Atlas
   ทุกหน้าดึงข้อมูลจาก /api (Vercel Function → MongoDB Atlas) และทุกค่าแสดงแหล่งที่มาด้วยป้ายแหล่งข้อมูล */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
// สร้าง element: ข้อความจากฐานข้อมูลใส่เป็น text node เสมอ (ไม่ใช้ innerHTML กับข้อมูล)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v; // ใช้กับ SVG ไอคอนคงที่เท่านั้น
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const fmt = (v) => (v === null || v === undefined || v === "" ? "–" : typeof v === "number" ? nf.format(v) : String(v));
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const TH_M = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const ymText = (n) => `${TH_M[(n % 100) - 1]} ${Math.floor(n / 100)}`;
const thDate = (iso) => { if (!iso) return "–"; const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_M[m - 1]} ${y}`; };
const time = (iso) => new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const TYPE = {
  Statistics: { label: "สถิติจากหน่วยงานรัฐ", c: "var(--t-stat)", hex: "#2a78d6" },
  EPD: { label: "EPD (Environmental Product Declaration)", c: "var(--t-epd)", hex: "#1baf7a" },
  "LCI Database": { label: "ฐานข้อมูล LCI / ค่า Emission Factor", c: "var(--t-db)", hex: "#6250d6" },
  CFP: { label: "Carbon Footprint of Product", c: "var(--t-cfp)", hex: "#eda100" },
  Report: { label: "รายงาน", c: "var(--t-report)", hex: "#e87ba4" },
};
const typeOf = (t) => TYPE[t] || { label: t, c: "var(--hair-strong)" };
const FIELD_TH = {
  BeginMonthInv: "คงคลังต้นเดือน", Production: "การผลิต", Domestic: "ขายในประเทศ", Export: "ส่งออก",
  Total: "ขายรวม", ShipmentValue: "มูลค่าการส่งสินค้า", EndMonthInv: "คงคลังปลายเดือน", Capacity: "กำลังการผลิต",
};
const ICON_OK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.3l2.3 2.2 4.7-5"/></svg>';
const ICON_BAD = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

// ป้ายแหล่งข้อมูล: กดแล้วเปิดรายละเอียดของแหล่งนั้น
function srcChip(s) {
  if (!s) return h("span", { class: "ref" }, "ตารางอ้างอิง");
  const t = typeOf(s.SourceType);
  return h("button", {
    type: "button", class: "src", "data-source": s.SourceID, style: `--c:${t.c}`,
    title: `${s.Organization || ""}${s.Title ? "\n" + s.Title : ""}\nกดเพื่อดูรายละเอียดแหล่งข้อมูล`,
  }, h("span", { class: "dot", "aria-hidden": "true" }), s.SourceCode);
}
const typeTag = (t) => h("span", { class: "type" }, h("span", { class: "tdot", style: `--c:${typeOf(t).c}`, "aria-hidden": "true" }), typeOf(t).label);

function queriesBlock(queries, label = "คำสั่ง MongoDB ที่หน้านี้ใช้") {
  if (!queries?.length) return null;
  return h("details", { class: "q" }, h("summary", {}, `${label} (${queries.length})`),
    h("div", { class: "qlist" }, queries.map((q) => h("div", {}, h("p", { class: "qlabel" }, q.label), h("pre", {}, q.text)))));
}
const oneQuery = (text, label = "ดูคำสั่งที่ใช้ตรวจ") => text ? h("details", { class: "q" }, h("summary", {}, label), h("pre", { style: "margin-top:8px" }, text)) : null;

// ---------------------------------------------------------------------------
// API + สถานะการเชื่อมต่อ
// ---------------------------------------------------------------------------
const cache = new Map();
let dbInfo = null;
async function api(params, { fresh = false } = {}) {
  const key = new URLSearchParams(params).toString();
  if (!fresh && cache.has(key)) return cache.get(key);
  const p = (async () => {
    let r, j;
    try {
      r = await fetch("/api?" + key, { cache: "no-store" });
      j = await r.json();
    } catch {
      throw new Error("ติดต่อ API ไม่ได้ ตรวจว่าเว็บ deploy ครบ (โฟลเดอร์ api) และอินเทอร์เน็ตใช้ได้");
    }
    if (!r.ok || j.error) throw new Error(j.error || `API ตอบกลับ ${r.status}`);
    setConn(true, j);
    return j;
  })();
  cache.set(key, p);
  p.catch((e) => { cache.delete(key); setConn(false, e); });
  return p;
}
function setConn(ok, j) {
  const el = $("#conn");
  el.className = "conn " + (ok ? "is-ok" : "is-err");
  if (ok && j.db) dbInfo = { db: j.db, version: j.version };
  el.replaceChildren(
    h("p", { class: "conn-state" }, h("span", { class: "conn-dot", "aria-hidden": "true" }),
      h("span", {}, ok ? "เชื่อมต่อ MongoDB Atlas" : "เชื่อมต่อฐานข้อมูลไม่ได้")),
    ok ? h("dl", {},
      h("dt", {}, "database"), h("dd", {}, dbInfo?.db || "cement_and_construction"),
      dbInfo?.version ? [h("dt", {}, "เวอร์ชัน"), h("dd", {}, "MongoDB " + dbInfo.version)] : null,
      h("dt", {}, "ดึงล่าสุด"), h("dd", {}, `${time(j.fetchedAt)} (${j.queryMs} ms)`))
      : h("p", {}, String(j.message || j)),
    h("button", { type: "button", class: "btn", onclick: () => { cache.clear(); route(true); } }, "ดึงข้อมูลใหม่"),
  );
}

// ---------------------------------------------------------------------------
// router: #/  #/collection/Name?page=  #/lci[/id]  #/monthly[/id]  #/sources[/id]
// ---------------------------------------------------------------------------
let current = { page: null, key: null };
const charts = [];
function destroyCharts() { for (const c of charts.splice(0)) { try { c.destroy(); } catch { /* กราฟเดิมถูกถอดไปแล้ว */ } } hideTip(); }
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || "overview", arg: parts[1] || null, q: new URLSearchParams(qs || "") };
}
async function route(force = false) {
  const { page, arg, q } = parseHash();
  // เปลี่ยนแค่ id ของรายละเอียดในหน้าเดิม → เปิด/ปิดแผงด้านขวา ไม่ต้องโหลดหน้าใหม่
  const pageKey = page === "collection" ? `collection/${arg}?${q}` : page === "monthly" ? `monthly/${arg || ""}` : page;
  document.querySelectorAll(".nav a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.route === page || (page === "collection" && a.dataset.route === "overview")));
  if (!force && current.key === pageKey) return openFromHash(page, arg);
  current = { page, key: pageKey };
  closeDrawer(false);
  destroyCharts();
  const main = $("#main");
  main.style.opacity = main.childElementCount ? ".55" : "";
  try {
    let view;
    if (page === "overview") view = await pageOverview();
    else if (page === "collection") view = await pageCollection(arg, q);
    else if (page === "lci") view = await pageLci();
    else if (page === "monthly") view = await pageMonthly(arg);
    else if (page === "sources") view = await pageSources();
    else view = h("div", { class: "page-head" }, h("h1", {}, "ไม่พบหน้านี้"), h("p", { class: "lead" }, h("a", { href: "#/" }, "กลับไปที่ภาพรวมฐานข้อมูล")));
    if (current.key !== pageKey) return; // ผู้ใช้เปลี่ยนหน้าระหว่างรอ
    main.replaceChildren(view);
    main.style.opacity = "";
    afterRender.splice(0).forEach((f) => f());
    if (!force) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
    openFromHash(page, arg);
  } catch (e) {
    main.style.opacity = "";
    main.replaceChildren(errorPanel(e));
  }
}
const afterRender = [];
function openFromHash(page, arg) {
  if (page === "lci" && arg) openProcess(Number(arg));
  else if (page === "sources" && arg) openSource(Number(arg));
  else closeDrawer(false);
}
function errorPanel(e) {
  return h("div", { class: "panel pad err" },
    h("h2", {}, "ดึงข้อมูลจากฐานข้อมูลไม่สำเร็จ"),
    h("p", { style: "margin-top:6px" }, e.message),
    h("p", { style: "margin-top:12px" }, h("button", { type: "button", class: "btn", onclick: () => { cache.clear(); route(true); } }, "ลองอีกครั้ง")));
}
window.addEventListener("hashchange", () => route());

// ---------------------------------------------------------------------------
// หน้า 1: ภาพรวมฐานข้อมูล
// ---------------------------------------------------------------------------
const ARROW = '<svg viewBox="0 0 28 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8h25M20 2l6 6-6 6"/></svg>';
const LIN_COLLS = ["Monthly_Stat", "Process", "Process_Product", "Process_Standard", "LCI_Exchange"];

async function pageOverview() {
  const o = await api({ view: "overview" });
  const nColl = o.collections.filter((c) => !c.missing).length;
  const byName = Object.fromEntries(o.collections.map((c) => [c.name, c]));

  // จัดกลุ่มแหล่งข้อมูลตามประเภท แล้วรวมจำนวน document ที่แต่ละกลุ่มเป็นที่มา
  const groups = [];
  for (const s of o.sources) {
    let g = groups.find((x) => x.type === s.SourceType);
    if (!g) groups.push(g = { type: s.SourceType, sources: [], counts: {} });
    g.sources.push(s);
    for (const c of LIN_COLLS) g.counts[c] = (g.counts[c] || 0) + s.counts[c];
  }
  const orgs = (g) => [...new Set(g.sources.map((s) => s.Organization.split(" · ")[0]))];
  const groupTitle = { Statistics: () => "สถิติอุตสาหกรรมรายเดือน", EPD: (g) => `EPD ${g.sources.length} ฉบับ`, "LCI Database": () => "ค่า Emission Factor จากฐานข้อมูล LCI" };
  const lineage = h("div", { class: "lineage" }, groups.map((g) => {
    const t = typeOf(g.type);
    return h("div", { class: "lin-row", style: `--c:${t.c}` },
      h("div", { class: "lin-src" },
        h("h3", {}, (groupTitle[g.type] || (() => t.label))(g)),
        h("p", {}, `จาก ${orgs(g).join(", ")}`),
        h("div", { class: "src-list" }, g.sources.map(srcChip))),
      h("div", { class: "lin-arrow", html: ARROW, "aria-hidden": "true" }),
      h("div", { class: "lin-to" }, LIN_COLLS.filter((c) => g.counts[c] > 0).map((c) =>
        h("a", { href: `#/collection/${c}` }, h("b", {}, fmt(g.counts[c])), h("span", {}, c)))));
  }));
  const ref = ["Product", "TSIC_Class", "Flow"].map((n) => byName[n]).filter((c) => c && !c.missing);
  const okAll = o.checks.every((c) => c.ok);

  return h("div", {},
    h("header", { class: "page-head" },
      h("h1", {}, "ภาพรวมฐานข้อมูล"),
      h("p", { class: "lead" },
        h("strong", {}, `${fmt(o.total)} document`), ` ใน ${nColl} collection บน MongoDB Atlas มาจากแหล่งข้อมูล `,
        h("strong", {}, `${o.sources.length} แหล่ง`),
        o.period ? ` สถิติรายเดือนครอบคลุม ${ymText(o.period[0])} ถึง ${ymText(o.period[1])}` : "")),

    h("section", { style: "margin-top:0" },
      h("h2", {}, "ข้อมูลแต่ละส่วนมาจากไหน"),
      h("p", { class: "note" }, "ตัวเลขคือจำนวน document ที่มาจากแหล่งข้อมูลแต่ละกลุ่ม นับสดจาก SourceID ทุกครั้งที่เปิดหน้า กดป้ายแหล่งข้อมูลเพื่อดูเอกสารต้นฉบับ"),
      lineage,
      h("p", { class: "note", style: "margin-top:12px" },
        "ตารางที่ไม่มี SourceID ของตัวเอง: ",
        ref.map((c, i) => [i ? ", " : "", h("a", { href: `#/collection/${c.name}` }, c.name), ` ${fmt(c.count)} รายการ`]),
        ` (Product คือรายการสินค้าในไฟล์ของ สศอ. ส่วน TSIC_Class และ Flow เป็นตารางอ้างอิง) และ Data_Source ${fmt(byName.Data_Source?.count)} รายการคือตัวแหล่งข้อมูลเอง`)),

    h("section", {},
      h("div", { class: "sec-head" },
        h("h2", {}, "ตรวจความถูกต้องของข้อมูล"),
        h("span", { class: `status-line ${okAll ? "ok" : "bad"}` }, h("span", { class: `mark ${okAll ? "ok" : "bad"}`, html: okAll ? ICON_OK : ICON_BAD, "aria-hidden": "true" }),
          okAll ? `ผ่านทั้ง ${o.checks.length} ข้อ` : `ไม่ผ่าน ${o.checks.filter((c) => !c.ok).length} จาก ${o.checks.length} ข้อ`)),
      h("p", { class: "note" }, "รันกับข้อมูลจริงบน Atlas ทุกครั้งที่เปิดหน้า เป็นการตรวจแบบอ่านอย่างเดียว (ชุดทดสอบเต็ม 35 ข้อ รวมการลองเขียนข้อมูลผิด ใช้ไฟล์ cn230_verify.js ใน mongosh)"),
      h("ul", { class: "panel checks" }, o.checks.map((c) => h("li", {},
        h("span", { class: `mark ${c.ok ? "ok" : "bad"}`, html: c.ok ? ICON_OK : ICON_BAD, "aria-hidden": "true" }),
        h("span", { class: "t" }, h("span", { class: "vh" }, c.ok ? "ผ่าน: " : "ไม่ผ่าน: "), c.title),
        h("span", { class: "d" }, c.detail),
        c.rows ? h("details", { class: "q" }, h("summary", {}, "ดูผลแยกตาม foreign key"),
          h("div", { class: "table-wrap", style: "margin-top:8px" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", {}, "Foreign key"), h("th", { class: "r" }, "Orphan"))),
            h("tbody", {}, c.rows.map((r) => h("tr", {}, h("td", { class: "code" }, r.fk), h("td", { class: "r" }, r.orphans))))))) : null,
        oneQuery(c.query))))),

    h("section", {},
      h("h2", {}, "Collection ในฐานข้อมูล"),
      h("p", { class: "note" }, "กดชื่อ collection เพื่อดูข้อมูลทุกแถว พร้อมแหล่งที่มาของแต่ละแถว"),
      h("div", { class: "panel table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Collection"), h("th", {}, "เก็บอะไร"), h("th", { class: "r" }, "Document"),
          h("th", {}, "Primary key"), h("th", {}, "Foreign key"), h("th", {}, "Validator"))),
        h("tbody", {}, o.collections.map((c) => h("tr", {},
          h("td", {}, h("a", { href: `#/collection/${c.name}`, class: "rowlink" }, c.name)),
          h("td", {}, c.missing ? h("span", { style: "color:var(--critical)" }, "ไม่พบ collection นี้") : c.about),
          h("td", { class: "r" }, c.missing ? "–" : fmt(c.count)),
          h("td", { class: "code" }, (c.pk || []).join(", ") || "–"),
          h("td", { class: "code" }, c.fks?.length ? c.fks.map((f, i) => [i ? h("br") : "", `${f.field} → ${f.parent}`]) : h("span", { class: "dash" }, "–")),
          h("td", {}, c.missing ? "–" : c.strict ? "strict" : h("span", { style: "color:var(--critical)" }, c.validationLevel || "ไม่มี")))))),
      ),
      h("div", { class: "panel table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "View"), h("th", {}, "คำนวณอะไร"), h("th", { class: "r" }, "Document"), h("th", {}, "Pipeline"))),
        h("tbody", {}, o.views.map((v) => h("tr", {},
          h("td", {}, h("a", { href: `#/collection/${v.name}`, class: "rowlink" }, v.name)),
          h("td", {}, v.missing ? "ไม่พบ view นี้" : v.about),
          h("td", { class: "r" }, v.missing ? "–" : fmt(v.count)),
          h("td", {}, v.pipeline ? h("details", { class: "q", style: "margin:0" }, h("summary", {}, `บน ${v.viewOn}`), h("pre", { style: "margin-top:8px" }, v.pipeline)) : "–"))))))),

    h("section", {},
      h("h2", {}, "ความสัมพันธ์ระหว่าง collection"),
      h("p", { class: "note" }, "ER diagram ตาม schema v8 (PK = primary key, FK = foreign key, UK = unique)"),
      h("figure", { class: "panel er" }, h("img", { src: "er-diagram.svg", alt: "ER diagram: Data_Source เชื่อมกับ Monthly_Stat และ Process ผ่าน SourceID, Product เชื่อมกับ Monthly_Stat และ Process_Product, TSIC_Class เชื่อมกับ Process, Process เชื่อมกับ Process_Product, Process_Standard และ LCI_Exchange, Flow เชื่อมกับ LCI_Exchange", loading: "lazy" })),
      h("p", { class: "note", style: "margin-top:8px" }, h("a", { href: "er-diagram.svg", target: "_blank", rel: "noopener" }, "เปิดภาพขนาดเต็ม"))),

    h("section", {}, queriesBlock(o.queries)));
}

// ---------------------------------------------------------------------------
// หน้า 2: ดูข้อมูลดิบของ collection
// ---------------------------------------------------------------------------
const VIA = {
  self: "แต่ละแถวคือแหล่งข้อมูล 1 แหล่ง",
  SourceID: "แหล่งข้อมูลของแต่ละแถวมาจาก SourceID ของแถวนั้น ($lookup ไปที่ Data_Source)",
  process: "collection นี้ไม่มี SourceID เอง จึงหาแหล่งข้อมูลผ่าน ProcessID → Process.SourceID → Data_Source",
  monthly: "สินค้ามาจากรายการในไฟล์ของ สศอ. จึงแสดงแหล่งข้อมูลของสถิติรายเดือนของสินค้านั้น",
  reference: "ตารางอ้างอิง ไม่มี SourceID",
};
async function pageCollection(name, q) {
  const page = Math.max(0, Number(q.get("page")) || 0);
  const field = q.get("field"), value = q.get("value");
  const d = await api({ view: "collection", name, page, ...(field ? { field, value } : {}) });
  const go = (p, f = field, v = value) => {
    const qs = new URLSearchParams({ ...(p ? { page: p } : {}), ...(f && v !== null && v !== "" ? { field: f, value: v } : {}) });
    location.hash = `#/collection/${name}${qs.toString() ? "?" + qs : ""}`;
  };
  const from = d.count ? d.page * d.pageSize + 1 : 0, to = d.page * d.pageSize + d.rows.length;
  const hasSrc = d.via !== "reference";
  const fieldSel = h("select", { id: "f-field" }, (d.fields.length ? d.fields : [field || ""]).map((f) => h("option", { value: f, selected: f === field }, f)));
  const valInput = h("input", { id: "f-value", value: value ?? "", placeholder: "เช่น 3", inputmode: "text" });
  return h("div", {},
    h("p", { class: "crumb" }, h("a", { href: "#/" }, "ภาพรวมฐานข้อมูล"), " / collection"),
    h("header", { class: "page-head" },
      h("h1", {}, d.name),
      h("p", { class: "lead" }, `${d.about} ทั้งหมด `, h("strong", {}, `${fmt(d.count)} document`), field ? ` ที่ ${field} = ${value}` : ""),
      h("p", { class: "note", style: "margin-top:6px" }, "คอลัมน์แหล่งข้อมูล: ", VIA[d.via])),
    h("form", { class: "filters", onsubmit: (e) => { e.preventDefault(); go(0, fieldSel.value, valInput.value.trim()); } },
      h("label", { class: "field" }, "กรองตาม field", fieldSel),
      h("label", { class: "field" }, "ค่าที่ต้องการ (ตรงทุกตัวอักษร)", valInput),
      h("button", { class: "btn", type: "submit" }, "กรอง"),
      field ? h("button", { class: "btn", type: "button", onclick: () => go(0, null, null) }, "ล้างตัวกรอง") : null),
    h("div", { class: "panel", style: "margin-top:16px" },
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, d.fields.map((f) => h("th", { class: isNumField(d.rows, f) ? "r" : "" }, f)), hasSrc ? h("th", {}, "แหล่งข้อมูล") : null)),
        h("tbody", {}, d.rows.length ? d.rows.map((r) => h("tr", {},
          d.fields.map((f) => cell(f, r[f], isNumField(d.rows, f))),
          hasSrc ? h("td", {}, r._source?.length ? h("span", { class: "src-list" }, r._source.map(srcChip)) : h("span", { class: "dash" }, "–")) : null))
          : h("tr", {}, h("td", { colspan: d.fields.length + 1, class: "empty" }, "ไม่มีแถวที่ตรงกับตัวกรอง"))))),
      h("div", { class: "pager" },
        h("span", { class: "grow" }, d.count ? `แถว ${fmt(from)}–${fmt(to)} จาก ${fmt(d.count)}` : "ไม่มีข้อมูล"),
        h("button", { class: "btn", type: "button", disabled: d.page === 0, onclick: () => go(d.page - 1) }, "ก่อนหน้า"),
        h("button", { class: "btn", type: "button", disabled: to >= d.count, onclick: () => go(d.page + 1) }, "ถัดไป"))),
    h("section", { style: "margin-top:20px" }, queriesBlock(d.queries, "คำสั่ง MongoDB ที่ใช้ดึงหน้านี้")));
}
const NO_COMMA = /(ID|^Year|^Month|DataYear)$/; // รหัสและปีไม่ใส่ comma
const isNumField = (rows, f) => rows.length > 0 && rows.every((r) => r[f] === null || typeof r[f] === "number") && !NO_COMMA.test(f);
function cell(f, v, numeric) {
  if (f === "URL" && v) return h("td", {}, h("a", { href: v, target: "_blank", rel: "noopener noreferrer" }, "เปิดลิงก์"));
  if (f === "SourceType") return h("td", {}, typeTag(v));
  return h("td", { class: numeric ? "r" : "" }, v === null ? h("span", { class: "dash" }, "null") : numeric ? fmt(v) : String(v));
}

// ---------------------------------------------------------------------------
// หน้า 3: LCI ของกระบวนการผลิต
// ---------------------------------------------------------------------------
const lciState = { unit: null, tsic: "", q: "" };
const declared = (p) => `${fmt(p.DeclaredAmount)} ${p.DeclaredUnit}`;
const flowVal = (p, id) => p.exchanges.find((x) => x.FlowID === id)?.Amount ?? null;
const procLabel = (p) => p.ProcessName + (p.Packaging && p.Packaging !== "n/a" ? ` (${p.Packaging})` : "");

async function pageLci() {
  const d = await api({ view: "lci" });
  const P = d.processes;
  const units = [...new Map(P.map((p) => [declared(p), p])).keys()];
  if (!units.includes(lciState.unit)) lciState.unit = units.includes("1,000 kg") ? "1,000 kg" : units[0];
  const classes = [...new Map(P.map((p) => [p.TSICClass, p.tsic])).values()].sort((a, b) => a.TSICClass.localeCompare(b.TSICClass));
  const stages = [...new Set(P.map((p) => p.LifecycleStage))];
  const F = Object.fromEntries(d.flows.map((f) => [f.FlowID, f]));

  const host = h("div", {});
  const render = () => {
    const rows = P.filter((p) => declared(p) === lciState.unit
      && (!lciState.tsic || p.TSICClass === lciState.tsic)
      && (!lciState.q || [p.ProcessName, p.source.Organization, p.source.SourceCode, p.product?.ProductName || "", p.TSICClass].join(" ").toLowerCase().includes(lciState.q.toLowerCase())));
    host.replaceChildren(
      h("div", { class: "panel" },
        h("div", { class: "chart-box" },
          h("p", { class: "chart-title" }, `GWP ต่อ ${lciState.unit} (kg CO2e)`),
          h("p", { class: "chart-sub" }, `${rows.length} กระบวนการ เรียงจากมากไปน้อย เทียบได้เฉพาะรายการที่ใช้หน่วยอ้างอิงเดียวกัน`),
          rows.length ? h("div", { class: "canvas-wrap", style: `height:${rows.length * 30 + 36}px; margin-top:10px` }, h("canvas", { id: "gwp", role: "img", "aria-label": `กราฟแท่ง GWP ของ ${rows.length} กระบวนการ ค่าทั้งหมดอยู่ในตารางด้านล่าง` }))
            : h("p", { class: "empty", style: "padding:16px 0" }, "ไม่มีกระบวนการที่ตรงกับตัวกรอง ลองล้างคำค้นหรือเลือกหมวด TSIC อื่น"))),
      h("div", { class: "panel table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "กระบวนการผลิต"), h("th", {}, "หมวด TSIC"), h("th", {}, "สินค้า สศอ."),
          h("th", { class: "r" }, `GWP (${F[1]?.Unit || "kg CO2e"})`), h("th", { class: "r" }, `PENRT (${F[2]?.Unit || "MJ"})`), h("th", { class: "r" }, `น้ำ (${F[3]?.Unit || "m3"})`),
          h("th", {}, "แหล่งข้อมูล"))),
        h("tbody", {}, rows.map((p) => h("tr", { class: "clickable", onclick: (e) => { if (!e.target.closest("button.src, a")) location.hash = `#/lci/${p.ProcessID}`; } },
          h("td", {}, h("a", { href: `#/lci/${p.ProcessID}`, class: "rowlink" }, procLabel(p)), h("span", { class: "sub" }, p.source.Organization)),
          h("td", { class: "num" }, p.TSICClass),
          h("td", {}, p.product ? p.product.ProductName : h("span", { class: "dash", title: "ไม่มีรายการตรงในไฟล์ สศอ." }, "–")),
          h("td", { class: "r" }, fmt(flowVal(p, 1))),
          h("td", { class: "r" }, flowVal(p, 2) === null ? h("span", { class: "dash", title: "แหล่งข้อมูลไม่ได้ระบุค่านี้" }, "–") : fmt(flowVal(p, 2))),
          h("td", { class: "r" }, flowVal(p, 3) === null ? h("span", { class: "dash", title: "แหล่งข้อมูลไม่ได้ระบุค่านี้" }, "–") : fmt(flowVal(p, 3))),
          h("td", {}, srcChip(p.source))))))),
      h("p", { class: "note", style: "margin-top:8px" }, "– คือแหล่งข้อมูลไม่ได้ระบุค่านั้น (ตาราง EF ของ อบก. มีเฉพาะ GWP) ไม่ใช่ค่าศูนย์"));
    if (rows.length) gwpChart(rows);
  };
  const unitSeg = h("div", { class: "seg", role: "group", "aria-label": "หน่วยอ้างอิง" }, units.map((u) =>
    h("button", { type: "button", "aria-pressed": String(u === lciState.unit), onclick: (e) => {
      lciState.unit = u; e.currentTarget.parentNode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); render();
    } }, `ต่อ ${u} (${P.filter((p) => declared(p) === u).length})`)));
  const tsicSel = h("select", { onchange: (e) => { lciState.tsic = e.target.value; render(); } },
    h("option", { value: "" }, "ทุกหมวด"), classes.map((c) => h("option", { value: c.TSICClass, selected: c.TSICClass === lciState.tsic }, `${c.TSICClass} ${c.ClassNameTH}`)));
  const search = h("input", { type: "search", value: lciState.q, placeholder: "ชื่อ บริษัท สินค้า หรือรหัสแหล่ง", oninput: (e) => { lciState.q = e.target.value; render(); } });
  afterRender.push(render);
  return h("div", {},
    h("header", { class: "page-head" },
      h("h1", {}, "LCI ของกระบวนการผลิต"),
      h("p", { class: "lead" }, `${P.length} กระบวนการ ช่วงวัฏจักรชีวิต ${stages.join(", ")} (cradle-to-gate) ค่าทั้งหมดต่อหน่วยอ้างอิง (declared unit) ของแต่ละแหล่ง กดแถวเพื่อดูรายละเอียดและเอกสารต้นฉบับ`)),
    h("div", { class: "filters", style: "margin-top:0" },
      h("div", { class: "field" }, h("span", { id: "unit-l" }, "หน่วยอ้างอิง"), unitSeg),
      h("label", { class: "field" }, "หมวด TSIC", tsicSel),
      h("label", { class: "field" }, "ค้นหา", search)),
    host,
    h("section", { style: "margin-top:20px" }, queriesBlock(d.queries)));
}

// ---------------------------------------------------------------------------
// กราฟ (Chart.js) + tooltip ร่วม
// ---------------------------------------------------------------------------
function chartDefaults() {
  const C = window.Chart;
  C.defaults.font.family = getComputedStyle(document.body).fontFamily;
  C.defaults.font.size = 12;
  C.defaults.color = "#66716b";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) C.defaults.animation = false;
  else if (C.defaults.animation) C.defaults.animation.duration = 250;
}
function showTip(ctx, buildRows) {
  const { chart, tooltip } = ctx;
  const tip = $("#tip");
  if (!tooltip || tooltip.opacity === 0) { tip.hidden = true; return; }
  tip.replaceChildren(...buildRows(tooltip));
  tip.hidden = false;
  const r = chart.canvas.getBoundingClientRect();
  let x = r.left + tooltip.caretX + 14, y = r.top + tooltip.caretY - tip.offsetHeight / 2;
  if (x + tip.offsetWidth > innerWidth - 8) x = r.left + tooltip.caretX - tip.offsetWidth - 14;
  y = Math.max(8, Math.min(y, innerHeight - tip.offsetHeight - 8));
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => { $("#tip").hidden = true; };
addEventListener("scroll", hideTip, { passive: true });

function gwpChart(rows) {
  chartDefaults();
  const sorted = [...rows].sort((a, b) => flowVal(b, 1) - flowVal(a, 1));
  const max = $("#gwp").parentElement.clientWidth < 560 ? 16 : 34; // จอแคบตัดชื่อให้สั้นลง ชื่อเต็มอยู่ใน tooltip และตาราง
  const short = (s) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
  const valueLabels = {
    id: "valueLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = `500 12px ${Chart.defaults.font.family}`;
      ctx.fillStyle = "#47534d";
      ctx.textBaseline = "middle";
      chart.getDatasetMeta(0).data.forEach((bar, i) => ctx.fillText(fmt(chart.data.datasets[0].data[i]), bar.x + 6, bar.y));
      ctx.restore();
    },
  };
  const c = new Chart($("#gwp"), {
    type: "bar",
    data: { labels: sorted.map((p) => short(procLabel(p))), datasets: [{ data: sorted.map((p) => flowVal(p, 1)), backgroundColor: "#2a78d6", hoverBackgroundColor: "#256abf", borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: "start", maxBarThickness: 18, categoryPercentage: 0.8 }] },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      layout: { padding: { right: 64 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false, external: (ctx) => showTip(ctx, (t) => {
        const p = sorted[t.dataPoints[0].dataIndex];
        return [h("div", { class: "tt" }, procLabel(p)),
          h("div", { class: "tr", style: "--c:#2a78d6" }, h("i"), h("b", {}, fmt(flowVal(p, 1))), h("span", {}, `kg CO2e ต่อ ${declared(p)}`)),
          h("div", { class: "tt", style: "margin:4px 0 0" }, `แหล่งข้อมูล ${p.source.SourceCode} (${p.source.Organization.split(" · ")[0]})`)];
      }) } },
      onClick: (e, els) => { if (els[0]) location.hash = `#/lci/${sorted[els[0].index].ProcessID}`; },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      scales: {
        x: { beginAtZero: true, grid: { color: "#e3e8e2" }, border: { color: "#b4beb6" }, ticks: { callback: (v) => (v >= 10000 ? compact.format(v) : nf.format(v)) } },
        y: { grid: { display: false }, border: { color: "#b4beb6" }, ticks: { color: "#47534d", font: { size: 12.5 } } },
      },
    },
    plugins: [valueLabels],
  });
  charts.push(c);
}

// ---------------------------------------------------------------------------
// หน้า 4: สถิติรายเดือน สศอ.
// ---------------------------------------------------------------------------
const SERIES = [
  { key: "Production", label: "การผลิต", color: "#2a78d6" },
  { key: "Domestic", label: "ขายในประเทศ", color: "#eb6834" },
  { key: "Export", label: "ส่งออก", color: "#1baf7a" },
];
let monthRange = 0; // 0 = ทั้งหมด

async function pageMonthly(arg) {
  const plist = (await api({ view: "products" })).products;
  if (!plist.length) return h("div", { class: "page-head" }, h("h1", {}, "สถิติรายเดือน สศอ."), h("p", { class: "lead" }, "ยังไม่มีสินค้าใน collection Product"));
  const id = Number(arg) || plist[0].ProductID;
  const d = await api({ view: "monthly", product: id });
  const p = d.product, rows = d.rows;
  const last = rows[rows.length - 1];
  const prevYear = last && rows.find((r) => r.Year === last.Year - 1 && r.Month === last.Month);

  const groups = [...new Map(plist.map((x) => [x.TSICClass, x.ClassNameTH])).entries()];
  const select = h("select", { onchange: (e) => { location.hash = `#/monthly/${e.target.value}`; } },
    groups.map(([cls, name]) => h("optgroup", { label: `${cls} ${name || ""}` },
      plist.filter((x) => x.TSICClass === cls).map((x) => h("option", { value: x.ProductID, selected: x.ProductID === id }, `${x.ProductName} (${x.TSIC}-${x.Code})`)))));

  const delta = (k) => {
    if (!prevYear || prevYear[k] === null || last[k] === null || !prevYear[k]) return null;
    const pct = ((last[k] - prevYear[k]) / prevYear[k]) * 100;
    return `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% จาก ${TH_M[prevYear.Month - 1]} ${prevYear.Year}`;
  };
  const tile = (label, value, unit, dl) => h("div", { class: "tile" }, h("p", { class: "l" }, label),
    h("p", { class: "v num" }, value, unit ? h("small", {}, unit) : null), h("p", { class: "dl" }, dl || " "));
  const util = last && last.Capacity ? (last.Production / last.Capacity) * 100 : null;

  const chartHost = h("div", {});
  const tableHost = h("div", {});
  const rangeSeg = h("div", { class: "seg", role: "group", "aria-label": "ช่วงเวลา" }, [[0, "ทั้งหมด"], [24, "24 เดือน"], [12, "12 เดือน"]].map(([n, l]) =>
    h("button", { type: "button", "aria-pressed": String(n === monthRange), onclick: (e) => {
      monthRange = n; e.currentTarget.parentNode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); draw();
    } }, l)));
  let showTable = false;
  const tableBtn = h("button", { type: "button", class: "linkbtn", onclick: () => { showTable = !showTable; tableBtn.textContent = showTable ? "ซ่อนตาราง" : "ดูเป็นตาราง"; drawTable(); } }, "ดูเป็นตาราง");
  const visible = () => (monthRange ? rows.slice(-monthRange) : rows);
  const draw = () => { drawChart(); drawTable(); };
  const drawChart = () => {
    destroyCharts();
    chartHost.replaceChildren(h("div", { class: "canvas-wrap", style: "height:340px" }, h("canvas", { id: "monthly", role: "img", "aria-label": `กราฟเส้น การผลิต ขายในประเทศ และส่งออก ของ ${p.ProductName} รายเดือน ดูตัวเลขทั้งหมดได้จากปุ่มดูเป็นตาราง` })));
    lineChart(visible(), p.Unit);
  };
  const cols = ["BeginMonthInv", "Production", "Domestic", "Export", "Total", "ShipmentValue", "EndMonthInv", "Capacity"];
  const drawTable = () => tableHost.replaceChildren(showTable ? h("div", { class: "table-wrap", style: "max-height:420px; border-top:1px solid var(--hair)" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "เดือน"), cols.map((c) => h("th", { class: "r", title: c }, FIELD_TH[c] || c)))),
    h("tbody", {}, [...visible()].reverse().map((r) => h("tr", {}, h("td", {}, `${TH_M[r.Month - 1]} ${r.Year}`), cols.map((c) => h("td", { class: "r" }, fmt(r[c])))))))) : "");
  afterRender.push(drawChart);

  return h("div", {},
    h("header", { class: "page-head" },
      h("h1", {}, p.ProductName),
      h("p", { class: "lead" }, `รหัส TSIC ${p.TSIC} รหัสสินค้า ${p.Code} หน่วย ${p.Unit}`, p.tsic ? ` อยู่ในหมวด ${p.tsic.TSICClass} ${p.tsic.ClassNameTH}` : "")),
    h("div", { class: "filters", style: "margin-top:0" },
      h("label", { class: "field" }, "สินค้า", select),
      h("div", { class: "field" }, "ช่วงเวลา", rangeSeg)),
    last ? h("div", { class: "tiles" },
      tile(`การผลิต ${TH_M[last.Month - 1]} ${last.Year}`, fmt(last.Production), p.Unit, delta("Production")),
      tile("ขายในประเทศ", fmt(last.Domestic), p.Unit, delta("Domestic")),
      tile("ส่งออก", fmt(last.Export), p.Unit, delta("Export")),
      tile("ใช้กำลังการผลิต", util === null ? "–" : util.toFixed(1), util === null ? null : "%", last.Capacity ? `กำลังการผลิต ${fmt(last.Capacity)} ${p.Unit}` : null)) : null,
    h("div", { class: "panel" },
      h("div", { class: "chart-box" },
        h("p", { class: "chart-title" }, `ปริมาณรายเดือน (${p.Unit})`),
        h("div", { class: "legend" }, SERIES.map((s) => h("span", {}, h("i", { style: `--c:${s.color}` }), s.label))),
        rows.length ? chartHost : h("p", { class: "empty" }, "ยังไม่มีสถิติของสินค้านี้")),
      h("div", { class: "chart-foot" }, "ที่มา", d.sources.map(srcChip), d.sources.map((s) => s.Organization).join(", "), h("span", { style: "flex:1" }), tableBtn),
      tableHost),
    h("section", {},
      h("h2", {}, "LCI ของสินค้านี้"),
      h("p", { class: "note" }, "กระบวนการผลิตที่ผูกกับสินค้านี้ใน Process_Product"),
      h("div", { class: "panel pad" }, d.linked.length ? h("ul", { class: "plain items" }, d.linked.map((l) => h("li", {},
        h("span", {}, h("a", { href: `#/lci/${l.ProcessID}` }, procLabel(l)), h("span", { class: "sub" }, l.Organization)),
        h("span", { class: "num" }, `GWP ${fmt(l.GWP)} kg CO2e ต่อ ${fmt(l.DeclaredAmount)} ${l.DeclaredUnit} `, srcChip(l)))))
        : h("p", { class: "empty" }, "ยังไม่มี LCI ที่ผูกกับสินค้านี้ ดูรายการ LCI ทั้งหมดได้ที่ ", h("a", { href: "#/lci" }, "LCI ของกระบวนการผลิต")))),
    h("section", { style: "margin-top:20px" }, queriesBlock(d.queries)));
}

function lineChart(rows, unit) {
  chartDefaults();
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const a = chart.tooltip?.getActiveElements?.() || [];
      if (!a.length) return;
      const { ctx, chartArea } = chart;
      ctx.save(); ctx.strokeStyle = "#b4beb6"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(a[0].element.x) + 0.5, chartArea.top); ctx.lineTo(Math.round(a[0].element.x) + 0.5, chartArea.bottom); ctx.stroke();
      ctx.restore();
    },
  };
  const c = new Chart($("#monthly"), {
    type: "line",
    data: {
      labels: rows.map((r) => `${TH_M[r.Month - 1]} ${String(r.Year).slice(2)}`),
      datasets: SERIES.map((s) => ({ label: s.label, data: rows.map((r) => r[s.key]), borderColor: s.color, backgroundColor: s.color,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: "#fbfcfa", tension: 0, spanGaps: false })),
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { enabled: false, external: (ctx) => showTip(ctx, (t) => {
        const r = rows[t.dataPoints[0].dataIndex];
        return [h("div", { class: "tt" }, `${TH_M[r.Month - 1]} ${r.Year}`),
          ...SERIES.map((s) => h("div", { class: "tr", style: `--c:${s.color}` }, h("i"), h("b", {}, fmt(r[s.key])), h("span", {}, `${s.label} (${unit})`)))];
      }) } },
      scales: {
        x: { grid: { display: false }, border: { color: "#b4beb6" }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } },
        y: { beginAtZero: true, grid: { color: "#e3e8e2" }, border: { display: false }, ticks: { callback: (v) => (v >= 10000 ? compact.format(v) : nf.format(v)) } },
      },
    },
    plugins: [crosshair],
  });
  c.canvas.addEventListener("mouseleave", hideTip);
  charts.push(c);
}

// ---------------------------------------------------------------------------
// หน้า 5: แหล่งข้อมูล
// ---------------------------------------------------------------------------
async function pageSources() {
  const d = await api({ view: "sources" });
  const S = d.sources;
  const COLS = ["Monthly_Stat", "Process", "Process_Product", "Process_Standard", "LCI_Exchange"];
  const types = [...new Set(S.map((s) => s.SourceType))];
  const sum = (c) => S.reduce((a, s) => a + s.counts[c], 0);
  return h("div", {},
    h("header", { class: "page-head" },
      h("h1", {}, "แหล่งข้อมูล"),
      h("p", { class: "lead" }, `${S.length} แหล่ง ค่าสถิติและค่า LCI ทุกค่าอ้างกลับมาที่แหล่งใดแหล่งหนึ่งผ่าน SourceID กดแถวเพื่อดูรายละเอียดและลิงก์เอกสารต้นฉบับ`)),
    h("div", { class: "src-list", style: "gap:6px 20px" }, types.map(typeTag)),
    h("section", { style: "margin-top:16px" },
      h("h2", {}, "ข้อมูลแต่ละแหล่งอยู่ใน collection ไหนบ้าง"),
      h("p", { class: "note" }, "จำนวน document ที่มาจากแต่ละแหล่ง นับสดจากฐานข้อมูล (collection ที่ไม่มี SourceID นับผ่าน ProcessID → Process.SourceID)"),
      h("div", { class: "panel table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "แหล่งข้อมูล"), h("th", {}, "ประเภท"), h("th", { class: "r" }, "ปีข้อมูล"), COLS.map((c) => h("th", { class: "r" }, c)))),
        h("tbody", {}, S.map((s) => h("tr", { class: "clickable", onclick: (e) => { if (!e.target.closest("button.src, a")) location.hash = `#/sources/${s.SourceID}`; } },
          h("td", {}, srcChip(s), h("a", { href: `#/sources/${s.SourceID}`, class: "rowlink", style: "display:block; margin-top:4px; font-weight:400" }, s.Title), h("span", { class: "sub" }, s.Organization)),
          h("td", {}, h("span", { class: "type" }, h("span", { class: "tdot", style: `--c:${typeOf(s.SourceType).c}`, "aria-hidden": "true" }), s.SourceType)),
          h("td", { class: "r" }, s.DataYear ?? h("span", { class: "dash", title: "ข้อมูลรายเดือนหลายปี" }, "–")),
          COLS.map((c) => h("td", { class: "r" }, s.counts[c] ? fmt(s.counts[c]) : h("span", { class: "dash" }, "–")))))),
        h("tfoot", {}, h("tr", {}, h("th", { colspan: 3 }, "รวม"), COLS.map((c) => h("th", { class: "r" }, fmt(sum(c))))))))),
    h("section", { style: "margin-top:20px" }, queriesBlock(d.queries)));
}

// ---------------------------------------------------------------------------
// แผงรายละเอียดด้านขวา: แหล่งข้อมูล / กระบวนการผลิต
// ---------------------------------------------------------------------------
let lastFocus = null;
function openDrawer(content, backHash) {
  const dr = $("#drawer");
  if (dr.hidden) lastFocus = document.activeElement;
  dr.dataset.back = backHash || "";
  $("#drawer-body").replaceChildren(content);
  dr.hidden = false; $("#backdrop").hidden = false;
  dr.scrollTop = 0;
  $("#drawer-close").focus();
}
function closeDrawer(updateHash = true) {
  const dr = $("#drawer");
  if (dr.hidden) return;
  dr.hidden = true; $("#backdrop").hidden = true;
  hideTip();
  if (updateHash && dr.dataset.back !== undefined) {
    const { page, arg } = parseHash();
    if ((page === "lci" || page === "sources") && arg) location.hash = `#/${page}`;
  }
  lastFocus?.focus?.();
}
$("#drawer-close").addEventListener("click", () => closeDrawer());
$("#backdrop").addEventListener("click", () => closeDrawer());
addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-source]");
  if (b) { e.preventDefault(); e.stopPropagation(); openSource(Number(b.dataset.source)); }
});

async function openSource(id) {
  let d;
  try { d = await api({ view: "sources" }); } catch (e) { return openDrawer(errorPanel(e)); }
  const s = d.sources.find((x) => x.SourceID === id);
  if (!s) return openDrawer(h("p", {}, `ไม่พบแหล่งข้อมูล SourceID ${id}`));
  const t = typeOf(s.SourceType);
  const COLS = Object.entries(s.counts).filter(([, n]) => n > 0);
  openDrawer(h("div", {},
    h("div", { class: "src-list" }, srcChip(s), typeTag(s.SourceType)),
    h("h2", { id: "drawer-title" }, s.Title),
    h("p", { class: "org" }, s.Organization),
    h("dl", { class: "facts" },
      h("dt", {}, "รหัสแหล่ง"), h("dd", {}, `${s.SourceCode} (SourceID ${s.SourceID})`),
      h("dt", {}, "ประเภท"), h("dd", {}, t.label),
      h("dt", {}, "ปีข้อมูล"), h("dd", {}, s.DataYear ?? "หลายปี (ข้อมูลรายเดือน)"),
      h("dt", {}, "วันที่ดึงข้อมูล"), h("dd", {}, thDate(s.RetrievedDate)),
      h("dt", {}, "เอกสารต้นฉบับ"), h("dd", {}, h("a", { href: s.URL, target: "_blank", rel: "noopener noreferrer" }, "เปิดเอกสารต้นฉบับ"), h("span", { class: "sub", style: "word-break:break-all" }, s.URL))),
    h("h3", {}, "ข้อมูลจากแหล่งนี้ในฐานข้อมูล"),
    h("ul", { class: "plain items" }, COLS.map(([c, n]) => h("li", {},
      ["Monthly_Stat", "Process"].includes(c) ? h("a", { href: `#/collection/${c}?field=SourceID&value=${s.SourceID}` }, c) : h("span", {}, c),
      h("span", { class: "num" }, `${fmt(n)} document`)))),
    s.processes.length ? [h("h3", {}, `กระบวนการผลิต (${s.processes.length})`), h("ul", { class: "plain items" }, s.processes.map((p) => h("li", {},
      h("a", { href: `#/lci/${p.ProcessID}` }, procLabel(p)), h("span", { class: "muted" }, `ต่อ ${fmt(p.DeclaredAmount)} ${p.DeclaredUnit}`))))] : null,
    s.statProducts.length ? [h("h3", {}, `สินค้าที่มีสถิติรายเดือน (${s.statProducts.length})`),
      s.statRange ? h("p", { class: "note" }, `ช่วงข้อมูล ${ymText(s.statRange[0])} ถึง ${ymText(s.statRange[1])}`) : null,
      h("ul", { class: "plain items" }, s.statProducts.map((p) => h("li", {},
        h("a", { href: `#/monthly/${p.ProductID}` }, p.ProductName || `ProductID ${p.ProductID}`), h("span", { class: "muted num" }, p.TSIC ? `${p.TSIC}-${p.Code}` : ""))))] : null));
}

async function openProcess(id) {
  let d;
  try { d = await api({ view: "lci" }); } catch (e) { return openDrawer(errorPanel(e)); }
  const p = d.processes.find((x) => x.ProcessID === id);
  if (!p) return openDrawer(h("p", {}, `ไม่พบกระบวนการ ProcessID ${id}`));
  const s = p.source;
  openDrawer(h("div", {},
    h("div", { class: "src-list" }, srcChip(s), h("span", { class: "ref" }, `ProcessID ${p.ProcessID}`)),
    h("h2", { id: "drawer-title" }, procLabel(p)),
    h("p", { class: "org" }, s.Organization),
    h("dl", { class: "facts" },
      h("dt", {}, "หมวด TSIC"), h("dd", {}, `${p.TSICClass} ${p.tsic.ClassNameTH}`),
      h("dt", {}, "สินค้า สศอ."), h("dd", {}, p.product
        ? [h("a", { href: `#/monthly/${p.product.ProductID}` }, p.product.ProductName), ` (${p.product.TSIC}-${p.product.Code})`]
        : h("span", { class: "muted" }, "ไม่มีรายการตรงในไฟล์ สศอ. (ไม่มีแถวใน Process_Product)")),
      h("dt", {}, "หน่วยอ้างอิง"), h("dd", {}, declared(p)),
      h("dt", {}, "ช่วงวัฏจักรชีวิต"), h("dd", {}, p.LifecycleStage),
      h("dt", {}, "พื้นที่"), h("dd", {}, p.Geography),
      h("dt", {}, "บรรจุภัณฑ์"), h("dd", {}, p.Packaging ?? "–"),
      h("dt", {}, "มาตรฐาน"), h("dd", {}, p.standards.length ? p.standards.join(", ") : "–")),
    h("h3", {}, "ค่า LCI"),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Flow"), h("th", {}, "ทิศทาง"), h("th", { class: "r" }, "ค่า"), h("th", {}, "หน่วย"))),
      h("tbody", {}, p.exchanges.map((x) => h("tr", {}, h("td", {}, x.FlowName), h("td", {}, x.Direction), h("td", { class: "r" }, fmt(x.Amount)), h("td", {}, `${x.Unit} ต่อ ${declared(p)}`)))))),
    p.exchanges.length < d.flows.length ? h("p", { class: "note", style: "margin-top:8px" }, "แหล่งข้อมูลนี้ระบุเฉพาะค่าที่แสดง ค่าที่ไม่มีไม่ได้แปลว่าเป็นศูนย์") : null,
    h("h3", {}, "แหล่งข้อมูลของค่าเหล่านี้"),
    h("div", { class: "srcbox" },
      h("p", { style: "font-weight:500" }, s.Title),
      h("dl", { class: "facts" },
        h("dt", {}, "รหัสแหล่ง"), h("dd", {}, s.SourceCode),
        h("dt", {}, "ปีข้อมูล"), h("dd", {}, s.DataYear ?? "–"),
        h("dt", {}, "วันที่ดึงข้อมูล"), h("dd", {}, thDate(s.RetrievedDate))),
      h("p", { style: "margin-top:10px; display:flex; flex-wrap:wrap; gap:8px 16px" },
        h("a", { href: s.URL, target: "_blank", rel: "noopener noreferrer" }, "เปิดเอกสารต้นฉบับ"),
        h("button", { type: "button", class: "linkbtn", "data-source": s.SourceID }, "ดูข้อมูลทั้งหมดจากแหล่งนี้"))),
    h("p", { class: "note", style: "margin-top:16px" }, "เอกสารดิบใน MongoDB: ",
      h("a", { href: `#/collection/Process?field=ProcessID&value=${p.ProcessID}` }, "Process"), ", ",
      h("a", { href: `#/collection/LCI_Exchange?field=ProcessID&value=${p.ProcessID}` }, "LCI_Exchange"), ", ",
      h("a", { href: `#/collection/Process_Standard?field=ProcessID&value=${p.ProcessID}` }, "Process_Standard"))));
}

// เริ่ม
route();
