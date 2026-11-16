// เชื่อม MongoDB Atlas ครั้งเดียวแล้วใช้ซ้ำ (serverless function ที่ยังอุ่นอยู่จะไม่ต้องต่อใหม่ทุก request)
import { MongoClient } from "mongodb";

export const DB_NAME = process.env.DB_NAME || "cement_and_construction";

export async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("NO_URI");
  if (!globalThis.__cn230Client) {
    const client = new MongoClient(uri, {
      appName: "cn230-web",
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
    });
    globalThis.__cn230Client = client.connect().catch((err) => {
      globalThis.__cn230Client = null; // ต่อไม่ได้ → request ถัดไปลองใหม่
      throw err;
    });
  }
  const client = await globalThis.__cn230Client;
  return client.db(DB_NAME);
}

// ข้อความ error ที่บอกวิธีแก้ (ไม่ส่ง connection string หรือรหัสผ่านออกไป)
export function explainError(err) {
  const msg = String(err?.message || err);
  if (msg === "NO_URI")
    return "ยังไม่ได้ตั้งค่า MONGODB_URI — ใส่ใน Vercel → Settings → Environment Variables แล้ว Redeploy";
  if (/auth|credential|password/i.test(msg))
    return "Atlas ไม่รับ username/password — ตรวจ user ใน Database Access และรหัสใน MONGODB_URI";
  if (/server selection|timed out|ENOTFOUND|ECONNREFUSED|querySrv/i.test(msg))
    return "เชื่อม Atlas ไม่ได้ — ตรวจ Network Access ว่าเพิ่ม 0.0.0.0/0 แล้ว และ cluster ยังทำงานอยู่";
  if (/not authorized/i.test(msg))
    return "user นี้ไม่มีสิทธิ์อ่าน database — ให้ role 'Only read any database'";
  return msg.replace(/mongodb(\+srv)?:\/\/\S+/g, "mongodb://…");
}
