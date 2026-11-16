// คำสั่ง MongoDB ทั้งหมดที่เว็บใช้ ทุกฟังก์ชันคืน { ...ข้อมูล, queries } โดย queries คือข้อความคำสั่งแบบ mongosh
// ที่รันจริง เพื่อแสดงในหน้าเว็บว่าแต่ละส่วนดึงมาจาก collection ไหนด้วย query อะไร

// ---------------------------------------------------------------------------
// โครงสร้างตาม schema v8 (ใช้ตรวจ FK และอธิบาย provenance ของแต่ละ collection)
// ---------------------------------------------------------------------------
export const COLLS = ["Data_Source", "TSIC_Class", "Product", "Flow", "Monthly_Stat", "Process",
  "Process_Product", "Process_Standard", "LCI_Exchange"];
export const VIEWS = ["v_monthly_stat", "v_process"];

export const META = {
  Data_Source: { pk: ["SourceID"], about: "แหล่งข้อมูล ทุกค่าในฐานข้อมูลย้อนกลับมาที่ตารางนี้", via: "self" },
  TSIC_Class: { pk: ["TSICClass"], about: "หมวดอุตสาหกรรม TSIC 4 หลัก ใช้จัดกลุ่ม Process และสินค้า", via: "reference" },
  Product: { pk: ["ProductID"], about: "สินค้าตามรายการของ สศอ. (TSIC 5 หลัก + Code)", via: "monthly" },
  Flow: { pk: ["FlowID"], about: "ชนิดของค่า LCI: GWP, พลังงาน (PENRT), น้ำ", via: "reference" },
  Monthly_Stat: { pk: ["ProductID", "Year", "Month", "SourceID"], about: "การผลิต ขาย ส่งออก รายเดือน", via: "SourceID" },
  Process: { pk: ["ProcessID"], about: "กระบวนการผลิตที่มี LCI (1 รายการต่อ 1 EPD หรือ 1 รายการ EF)", via: "SourceID" },
  Process_Product: { pk: ["ProcessID"], about: "จับคู่ Process กับสินค้า สศอ. ไม่มีแถวแปลว่าไม่มีรายการตรงในไฟล์ สศอ.", via: "process" },
  Process_Standard: { pk: ["ProcessID", "Standard"], about: "มาตรฐานผลิตภัณฑ์ (มอก. / ASTM) ของแต่ละ Process", via: "process" },
  LCI_Exchange: { pk: ["ProcessID", "FlowID"], about: "ค่า LCI ของแต่ละ Process ต่อ declared unit", via: "process" },
  v_monthly_stat: { pk: ["ProductID", "Year", "Month", "SourceID"], about: "view: Monthly_Stat + Total = Domestic + Export", via: "SourceID" },
  v_process: { pk: ["ProcessID"], about: "view: Process ⋈ Data_Source เพิ่ม Company และ DataYear", via: "SourceID" },
};

export const FKS = [
  ["Monthly_Stat", "ProductID", "Product", "ProductID"],
  ["Monthly_Stat", "SourceID", "Data_Source", "SourceID"],
  ["Process", "TSICClass", "TSIC_Class", "TSICClass"],
  ["Process", "SourceID", "Data_Source", "SourceID"],
  ["Process_Product", "ProcessID", "Process", "ProcessID"],
  ["Process_Product", "ProductID", "Product", "ProductID"],
  ["Process_Standard", "ProcessID", "Process", "ProcessID"],
  ["LCI_Exchange", "ProcessID", "Process", "ProcessID"],
  ["LCI_Exchange", "FlowID", "Flow", "FlowID"],
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
// BSON → JSON: Decimal128 → number, Date → "YYYY-MM-DD", ตัด _id
export function plain(v) {
  if (v === null || v === undefined) return v ?? null;
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const t = v._bsontype;
    if (t === "Decimal128" || t === "Long" || t === "Double" || t === "Int32") return Number(v.toString());
    if (t === "ObjectId") return undefined;
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== "_id") o[k] = plain(x);
    return o;
  }
  return v;
}

// พิมพ์ query แบบ mongosh (key ไม่มีเครื่องหมายคำพูด, object สั้นอยู่บรรทัดเดียว)
export function pretty(v, ind = "") {
  const one = (x) => {
    if (Array.isArray(x)) return "[" + x.map(one).join(", ") + "]";
    if (x && typeof x === "object") return "{ " + Object.entries(x).map(([k, y]) => key(k) + ": " + one(y)).join(", ") + " }";
    return JSON.stringify(x);
  };
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  const flat = one(v);
  if (flat.length <= 100 - ind.length || v === null || typeof v !== "object") return flat;
  const i2 = ind + "  ";
  if (Array.isArray(v)) return "[\n" + v.map((x) => i2 + pretty(x, i2)).join(",\n") + "\n" + ind + "]";
  return "{\n" + Object.entries(v).map(([k, y]) => i2 + key(k) + ": " + pretty(y, i2)).join(",\n") + "\n" + ind + "}";
}

class Log {
  constructor() { this.items = []; }
  add(label, text) { this.items.push({ label, text }); }
  async agg(db, label, coll, pipeline) {
    this.add(label, `db.${coll}.aggregate(${pretty(pipeline)})`);
    return db.collection(coll).aggregate(pipeline).toArray();
  }
  async find(db, label, coll, filter = {}, sort = null, projection = { _id: 0 }) {
    this.add(label, `db.${coll}.find(${pretty(filter)}${projection ? ", " + pretty(projection) : ""})` + (sort ? `.sort(${pretty(sort)})` : ""));
    let c = db.collection(coll).find(filter, projection ? { projection } : {});
    if (sort) c = c.sort(sort);
    return c.toArray();
  }
}

const ym = { $add: [{ $multiply: ["$Year", 100] }, "$Month"] };

// ---------------------------------------------------------------------------
// provenance: แต่ละแหล่งข้อมูลเป็นที่มาของ document ใน collection ไหนกี่รายการ
// ---------------------------------------------------------------------------
async function provenance(db, log) {
  const viaProcess = (coll) => log.agg(db, `${coll} นับตามแหล่งข้อมูล (ผ่าน Process.SourceID)`, coll, [
    { $lookup: { from: "Process", localField: "ProcessID", foreignField: "ProcessID", as: "p" } },
    { $unwind: "$p" },
    { $group: { _id: "$p.SourceID", n: { $sum: 1 } } },
  ]);
  const [sources, ms, pr, pp, ps, lci] = await Promise.all([
    log.find(db, "แหล่งข้อมูลทั้งหมด", "Data_Source", {}, { SourceID: 1 }),
    log.agg(db, "Monthly_Stat นับตามแหล่งข้อมูล", "Monthly_Stat", [
      { $group: { _id: "$SourceID", n: { $sum: 1 }, products: { $addToSet: "$ProductID" }, first: { $min: ym }, last: { $max: ym } } },
    ]),
    log.agg(db, "Process นับตามแหล่งข้อมูล", "Process", [{ $group: { _id: "$SourceID", n: { $sum: 1 } } }]),
    viaProcess("Process_Product"),
    viaProcess("Process_Standard"),
    viaProcess("LCI_Exchange"),
  ]);
  const by = (rows) => Object.fromEntries(rows.map((r) => [r._id, r]));
  const M = by(ms), P = by(pr), PP = by(pp), PS = by(ps), L = by(lci);
  return plain(sources).map((s) => {
    const m = M[s.SourceID];
    const counts = {
      Monthly_Stat: m?.n || 0,
      Process: P[s.SourceID]?.n || 0,
      Process_Product: PP[s.SourceID]?.n || 0,
      Process_Standard: PS[s.SourceID]?.n || 0,
      LCI_Exchange: L[s.SourceID]?.n || 0,
    };
    return {
      ...s,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0) + 1, // +1 = document ของแหล่งนั้นใน Data_Source
      statProducts: m ? m.products.map(Number).sort((a, b) => a - b) : [],
      statRange: m ? [Number(m.first), Number(m.last)] : null,
    };
  });
}

// ---------------------------------------------------------------------------
// 1) ภาพรวมฐานข้อมูล
// ---------------------------------------------------------------------------
export async function overview(db) {
  const log = new Log();
  const t0 = Date.now();
  await db.command({ ping: 1 });
  const pingMs = Date.now() - t0;
  let version = null;
  try { version = (await db.command({ buildInfo: 1 })).version; } catch { /* บาง user เรียกไม่ได้ */ }

  log.add("รายการ collection, validator และ view", "db.getCollectionInfos()");
  const infos = await db.listCollections().toArray();
  const info = Object.fromEntries(infos.map((i) => [i.name, i]));

  log.add("จำนวน document และ index ของแต่ละ collection", "db.<collection>.countDocuments()\ndb.<collection>.getIndexes()");
  const collections = await Promise.all(COLLS.map(async (name) => {
    const i = info[name];
    if (!i) return { name, missing: true, about: META[name].about };
    const [count, idx] = await Promise.all([
      db.collection(name).countDocuments(),
      db.collection(name).listIndexes().toArray(),
    ]);
    const js = i.options?.validator?.$jsonSchema || {};
    return {
      name,
      about: META[name].about,
      count,
      fields: Object.keys(js.properties || {}).filter((k) => k !== "_id"),
      required: js.required || [],
      strict: i.options?.validationLevel === "strict" && i.options?.validationAction === "error" && js.additionalProperties === false,
      validationLevel: i.options?.validationLevel || null,
      validationAction: i.options?.validationAction || null,
      pk: idx.find((x) => x.name === "pk" && x.unique)?.key ? Object.keys(idx.find((x) => x.name === "pk").key) : [],
      indexes: idx.filter((x) => x.name !== "_id_").map((x) => ({ name: x.name, key: Object.keys(x.key), unique: !!x.unique })),
      fks: FKS.filter((f) => f[0] === name).map(([, field, parent]) => ({ field, parent })),
    };
  }));
  const views = await Promise.all(VIEWS.map(async (name) => {
    const i = info[name];
    if (!i) return { name, missing: true };
    return { name, about: META[name].about, viewOn: i.options?.viewOn, pipeline: pretty(plain(i.options?.pipeline || [])), count: await db.collection(name).countDocuments() };
  }));

  const br17 = [
    { $lookup: { from: "Process", localField: "ProcessID", foreignField: "ProcessID", as: "p" } },
    { $unwind: "$p" },
    { $lookup: { from: "Product", localField: "ProductID", foreignField: "ProductID", as: "pr" } },
    { $unwind: "$pr" },
    { $match: { $expr: { $ne: ["$p.TSICClass", { $substrCP: ["$pr.TSIC", 0, 4] }] } } },
    { $project: { _id: 0, ProcessID: 1, ProductID: 1, TSICClass: "$p.TSICClass", TSIC: "$pr.TSIC" } },
  ];
  const gwp = [
    { $lookup: { from: "LCI_Exchange", localField: "ProcessID", foreignField: "ProcessID", as: "x" } },
    { $match: { "x.FlowID": { $ne: 1 } } },
    { $project: { _id: 0, ProcessID: 1, ProcessName: 1 } },
  ];
  const cover = [{ $group: { _id: "$ProductID", months: { $sum: 1 }, first: { $min: ym }, last: { $max: ym } } }];
  // รันทุกการตรวจพร้อมกันเพื่อลดเวลารอ
  const br17Rows = db.collection("Process_Product").aggregate(br17).toArray();
  const gwpRows = db.collection("Process").aggregate(gwp).toArray();
  const covRows = db.collection("Monthly_Stat").aggregate(cover).toArray();
  const productCountP = db.collection("Product").countDocuments();
  const sourcesP = provenance(db, log);
  const orphanRows = await Promise.all(FKS.map(async ([child, field, parent, pf]) => {
    const r = await db.collection(child).aggregate([
      { $lookup: { from: parent, localField: field, foreignField: pf, as: "_parent" } },
      { $match: { _parent: { $size: 0 } } },
      { $count: "n" },
    ]).toArray();
    return { fk: `${child}.${field} → ${parent}`, orphans: r[0]?.n || 0 };
  }));
  const bad17 = plain(await br17Rows);
  const noGwp = plain(await gwpRows);
  // ---- ตรวจความถูกต้องของข้อมูล (อ่านอย่างเดียว รันกับข้อมูลจริงทุกครั้งที่เปิดหน้า) ----
  const checks = [];
  const present = collections.filter((c) => !c.missing);
  checks.push({
    title: "ทุก collection มี validator แบบ strict และห้าม field ที่ไม่ได้ออกแบบไว้",
    ok: present.length === COLLS.length && present.every((c) => c.strict),
    detail: `${present.filter((c) => c.strict).length}/${COLLS.length} collection ตั้ง validationLevel: strict, validationAction: error, additionalProperties: false`,
  });
  checks.push({
    title: "ทุก collection มี primary key (unique index ชื่อ pk)",
    ok: present.length === COLLS.length && present.every((c) => c.pk.length > 0),
    detail: `${present.filter((c) => c.pk.length).length}/${COLLS.length} collection มี unique index ชื่อ pk`,
  });

  const [ex] = FKS;
  checks.push({
    title: "Foreign key ไม่มีค่าที่ชี้ไปหาแถวที่ไม่มีอยู่จริง (orphan)",
    ok: orphanRows.every((r) => r.orphans === 0),
    detail: `ตรวจ ${FKS.length} คู่ พบ orphan ${orphanRows.reduce((a, r) => a + r.orphans, 0)} รายการ`,
    rows: orphanRows,
    query: `// ตัวอย่าง 1 ใน ${FKS.length} คู่\ndb.${ex[0]}.aggregate(${pretty([
      { $lookup: { from: ex[2], localField: ex[1], foreignField: ex[3], as: "_parent" } },
      { $match: { _parent: { $size: 0 } } },
      { $count: "n" },
    ])})`,
  });

  checks.push({
    title: "หมวด TSIC ของ Process ตรงกับสินค้า สศอ. ที่ผูกไว้ (BR-17)",
    ok: bad17.length === 0,
    detail: bad17.length ? `ไม่ตรง ${bad17.length} คู่: ` + bad17.map((b) => `Process ${b.ProcessID} (${b.TSICClass}) ↔ ${b.TSIC}`).join(", ") : "ทุกคู่ใน Process_Product ตรงกับ 4 หลักแรกของ TSIC สินค้า",
    query: `db.Process_Product.aggregate(${pretty(br17)})`,
  });

  checks.push({
    title: "ทุก Process มีค่า GWP (FlowID 1)",
    ok: noGwp.length === 0,
    detail: noGwp.length ? `ไม่มี GWP: ${noGwp.map((p) => p.ProcessName).join(", ")}` : "ทุก Process มีค่า GWP อย่างน้อย 1 ค่า",
    query: `db.Process.aggregate(${pretty(gwp)})`,
  });

  const [cov, productCount] = await Promise.all([covRows, productCountP]);
  const months = [...new Set(cov.map((c) => Number(c.months)))];
  const first = Math.min(...cov.map((c) => Number(c.first))), last = Math.max(...cov.map((c) => Number(c.last)));
  checks.push({
    title: "สถิติรายเดือนครบทุกสินค้าและทุกเดือน",
    ok: cov.length === productCount && months.length === 1,
    detail: cov.length
      ? `${cov.length}/${productCount} สินค้ามีสถิติ จำนวนเดือนต่อสินค้า: ${months.join(", ")} (${fmtYm(first)} – ${fmtYm(last)})`
      : "ยังไม่มีสถิติรายเดือน",
    query: `db.Monthly_Stat.aggregate(${pretty(cover)})`,
  });

  const sources = await sourcesP;
  const total = present.reduce((a, c) => a + c.count, 0);
  return {
    db: db.databaseName,
    version,
    pingMs,
    total,
    collections,
    views,
    checks,
    sources,
    period: cov.length ? [first, last] : null,
    queries: log.items,
  };
}

function fmtYm(n) { return `${String(n % 100).padStart(2, "0")}/${Math.floor(n / 100)}`; }

// ---------------------------------------------------------------------------
// 2) ดูข้อมูลดิบของ collection พร้อมคอลัมน์แหล่งข้อมูล
// ---------------------------------------------------------------------------
const PAGE = 50;

export async function collection(db, name, page = 0, field = null, value = null) {
  if (!META[name]) throw Object.assign(new Error(`ไม่มี collection ชื่อ ${name}`), { status: 404 });
  const log = new Log();
  const filter = {};
  if (field) {
    if (!/^[A-Za-z]+$/.test(field)) throw Object.assign(new Error("ชื่อ field ไม่ถูกต้อง"), { status: 400 });
    filter[field] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  const sort = Object.fromEntries(META[name].pk.map((k) => [k, 1]));
  const via = META[name].via;
  const src = (localField) => [
    { $lookup: { from: "Data_Source", localField, foreignField: "SourceID", as: "_source" } },
    { $set: { _source: { $map: { input: "$_source", as: "s", in: {
      SourceID: "$$s.SourceID", SourceCode: "$$s.SourceCode", SourceType: "$$s.SourceType", Organization: "$$s.Organization" } } } } },
  ];
  let join = [];
  if (via === "SourceID") join = src("SourceID");
  else if (via === "self") join = [{ $set: { _source: [{ SourceID: "$SourceID", SourceCode: "$SourceCode", SourceType: "$SourceType", Organization: "$Organization" }] } }];
  else if (via === "process") join = [
    { $lookup: { from: "Process", localField: "ProcessID", foreignField: "ProcessID", as: "_p" } },
    { $set: { _sid: { $arrayElemAt: ["$_p.SourceID", 0] } } },
    ...src("_sid"),
  ];
  else if (via === "monthly") join = [
    { $lookup: { from: "Monthly_Stat", localField: "ProductID", foreignField: "ProductID", as: "_ms" } },
    { $set: { _sid: { $setUnion: ["$_ms.SourceID", []] } } },
    ...src("_sid"),
  ];
  const pipeline = [
    ...(field ? [{ $match: filter }] : []),
    { $sort: sort },
    { $skip: page * PAGE },
    { $limit: PAGE },
    ...join,
    { $project: { _id: 0, _p: 0, _ms: 0, _sid: 0 } },
  ];
  // $project แบบตัด field ที่ไม่มีอยู่ก็ไม่ error แต่ตัดเฉพาะที่ใช้จริงให้ query อ่านง่าย
  const proj = pipeline[pipeline.length - 1].$project;
  for (const k of ["_p", "_ms", "_sid"]) if (!JSON.stringify(join).includes(`"${k}"`)) delete proj[k];

  const [rows, count] = await Promise.all([
    log.agg(db, `${name} หน้า ${page + 1}`, name, pipeline),
    db.collection(name).countDocuments(filter),
  ]);
  const data = plain(rows);
  const fields = data.length ? Object.keys(data[0]).filter((k) => k !== "_source") : [];
  return { name, about: META[name].about, via, filter, page, pageSize: PAGE, count, fields, rows: data, queries: log.items };
}

// ---------------------------------------------------------------------------
// 3) LCI ของทุก Process พร้อมแหล่งข้อมูล หมวด TSIC สินค้า สศอ. มาตรฐาน และค่า LCI
// ---------------------------------------------------------------------------
export async function lci(db) {
  const log = new Log();
  const pipeline = [
    { $lookup: { from: "Data_Source", localField: "SourceID", foreignField: "SourceID", as: "source" } },
    { $unwind: "$source" },
    { $lookup: { from: "TSIC_Class", localField: "TSICClass", foreignField: "TSICClass", as: "tsic" } },
    { $unwind: "$tsic" },
    { $lookup: { from: "Process_Product", localField: "ProcessID", foreignField: "ProcessID", as: "link" } },
    { $lookup: { from: "Product", localField: "link.ProductID", foreignField: "ProductID", as: "product" } },
    { $lookup: { from: "Process_Standard", localField: "ProcessID", foreignField: "ProcessID", as: "standards" } },
    { $lookup: { from: "LCI_Exchange", localField: "ProcessID", foreignField: "ProcessID", as: "exchanges" } },
    { $project: { link: 0 } },
    { $sort: { ProcessID: 1 } },
  ];
  const [rows, flows] = await Promise.all([
    log.agg(db, "Process ⋈ Data_Source ⋈ TSIC_Class ⋈ Process_Product ⋈ Product ⋈ Process_Standard ⋈ LCI_Exchange", "Process", pipeline),
    log.find(db, "ชนิดของค่า LCI", "Flow", {}, { FlowID: 1 }),
  ]);
  const F = Object.fromEntries(plain(flows).map((f) => [f.FlowID, f]));
  const processes = plain(rows).map((p) => ({
    ...p,
    product: p.product[0] || null,
    standards: p.standards.map((s) => s.Standard),
    exchanges: p.exchanges
      .map((x) => ({ ...x, FlowName: F[x.FlowID]?.FlowName, FlowType: F[x.FlowID]?.FlowType, Unit: F[x.FlowID]?.Unit }))
      .sort((a, b) => a.FlowID - b.FlowID),
  }));
  return { processes, flows: plain(flows), queries: log.items };
}

// ---------------------------------------------------------------------------
// 4) สินค้า สศอ. + สถิติรายเดือน
// ---------------------------------------------------------------------------
export async function products(db) {
  const log = new Log();
  const pipeline = [
    { $set: { TSICClass: { $substrCP: ["$TSIC", 0, 4] } } },
    { $lookup: { from: "TSIC_Class", localField: "TSICClass", foreignField: "TSICClass", as: "tsic" } },
    { $lookup: { from: "Process_Product", localField: "ProductID", foreignField: "ProductID", as: "lci" } },
    { $project: { _id: 0, ProductID: 1, TSIC: 1, Code: 1, ProductName: 1, Unit: 1, TSICClass: 1,
      ClassNameTH: { $arrayElemAt: ["$tsic.ClassNameTH", 0] }, lciCount: { $size: "$lci" } } },
    { $sort: { TSIC: 1, Code: 1 } },
  ];
  const rows = await log.agg(db, "สินค้า ⋈ หมวด TSIC + จำนวน LCI ที่ผูก", "Product", pipeline);
  return { products: plain(rows), queries: log.items };
}

export async function monthly(db, productId) {
  const id = Number(productId);
  if (!Number.isInteger(id)) throw Object.assign(new Error("ต้องระบุ product เป็นตัวเลข"), { status: 400 });
  const log = new Log();
  const [prod] = await log.agg(db, "ข้อมูลสินค้า", "Product", [
    { $match: { ProductID: id } },
    { $set: { TSICClass: { $substrCP: ["$TSIC", 0, 4] } } },
    { $lookup: { from: "TSIC_Class", localField: "TSICClass", foreignField: "TSICClass", as: "tsic" } },
    { $project: { _id: 0, "tsic._id": 0 } },
  ]);
  if (!prod) throw Object.assign(new Error(`ไม่พบสินค้า ProductID ${id}`), { status: 404 });
  const rows = await log.find(db, "สถิติรายเดือน (จาก view ที่คำนวณ Total = Domestic + Export)", "v_monthly_stat", { ProductID: id }, { Year: 1, Month: 1 }, null);
  const ids = [...new Set(rows.map((r) => Number(r.SourceID)))];
  const [sources, linked] = await Promise.all([
    log.find(db, "แหล่งข้อมูลของสถิติชุดนี้", "Data_Source", { SourceID: { $in: ids } }, { SourceID: 1 }),
    log.agg(db, "LCI ที่ผูกกับสินค้านี้", "Process_Product", [
      { $match: { ProductID: id } },
      { $lookup: { from: "Process", localField: "ProcessID", foreignField: "ProcessID", as: "p" } },
      { $unwind: "$p" },
      { $lookup: { from: "Data_Source", localField: "p.SourceID", foreignField: "SourceID", as: "s" } },
      { $unwind: "$s" },
      { $lookup: { from: "LCI_Exchange", localField: "ProcessID", foreignField: "ProcessID", as: "x" } },
      { $project: { _id: 0, ProcessID: 1, ProcessName: "$p.ProcessName", Packaging: "$p.Packaging", DeclaredAmount: "$p.DeclaredAmount",
        DeclaredUnit: "$p.DeclaredUnit", SourceID: "$s.SourceID", SourceCode: "$s.SourceCode", SourceType: "$s.SourceType",
        Organization: "$s.Organization", x: { FlowID: 1, Amount: 1 } } },
      { $sort: { ProcessID: 1 } },
    ]),
  ]);
  const p = plain(prod);
  return {
    product: { ...p, tsic: p.tsic[0] || null },
    rows: plain(rows),
    sources: plain(sources),
    linked: plain(linked).map(({ x, ...l }) => ({ ...l, GWP: x.find((e) => e.FlowID === 1)?.Amount ?? null })),
    queries: log.items,
  };
}

// ---------------------------------------------------------------------------
// 5) แหล่งข้อมูล + ข้อมูลที่มาจากแต่ละแหล่ง
// ---------------------------------------------------------------------------
export async function sources(db) {
  const log = new Log();
  const [list, procs, prods] = await Promise.all([
    provenance(db, log),
    log.find(db, "Process ของแต่ละแหล่ง", "Process", {}, { ProcessID: 1 }, { _id: 0, ProcessID: 1, ProcessName: 1, Packaging: 1, SourceID: 1, DeclaredAmount: 1, DeclaredUnit: 1 }),
    log.find(db, "ชื่อสินค้า", "Product", {}, { ProductID: 1 }, { _id: 0, ProductID: 1, ProductName: 1, TSIC: 1, Code: 1 }),
  ]);
  const P = plain(procs), names = Object.fromEntries(plain(prods).map((p) => [p.ProductID, p]));
  return {
    sources: list.map((s) => ({
      ...s,
      processes: P.filter((p) => p.SourceID === s.SourceID).map(({ SourceID, ...p }) => p),
      statProducts: s.statProducts.map((id) => names[id] || { ProductID: id }),
    })),
    queries: log.items,
  };
}
