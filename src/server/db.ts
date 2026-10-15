import Database from "better-sqlite3";
import { join } from "node:path";
import { Storage, now } from "./core.js";
export type Row = Record<string, string | number | null>;
export class Store {
  readonly db: Database.Database;
  readonly storage: Storage;
  constructor(directory: string) {
    this.storage = new Storage(directory);
    this.db = new Database(join(this.storage.root, "app.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    const version = String(
      (this.db.prepare("SELECT sqlite_version() v").get() as Row).v,
    );
    const n = version.split(".").map(Number);
    if (n[0] < 3 || (n[0] === 3 && (n[1] < 51 || (n[1] === 51 && n[2] < 3))))
      throw new Error(`SQLite ${version}不满足WAL修复版本要求，需3.51.3+`);
    this.migrate();
  }
  get(sql: string, ...values: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...values) as Row | undefined;
  }
  all(sql: string, ...values: unknown[]): Row[] {
    return this.db.prepare(sql).all(...values) as Row[];
  }
  run(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).run(...values);
  }
  migrate() {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)`,
    );
    this.db
      .transaction(() => {
        if (this.get("SELECT version FROM migrations WHERE version=1")) return;
        this.db.exec(`
 CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password_hash TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
 CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
 CREATE TABLE projects(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',market TEXT NOT NULL DEFAULT '',brand TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
 CREATE TABLE assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>=0),duration REAL,width INTEGER,height INTEGER,storage_key TEXT NOT NULL UNIQUE,thumbnail_key TEXT,tags TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL DEFAULT 'upload',sha256 TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,deleted_at TEXT);
 CREATE TABLE project_assets(project_id TEXT NOT NULL REFERENCES projects(id),asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(project_id,asset_id));
 CREATE TABLE drafts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT REFERENCES projects(id),title TEXT NOT NULL,tool_id TEXT NOT NULL,input TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
 CREATE TABLE providers(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,kind TEXT NOT NULL,config TEXT NOT NULL,secret TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,disabled_at TEXT);
 CREATE TABLE batches(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner_id,idempotency_key));
 CREATE TABLE jobs(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT REFERENCES projects(id),tool_id TEXT NOT NULL,title TEXT NOT NULL,input TEXT NOT NULL,provider_snapshot TEXT,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','needs_review')),progress REAL NOT NULL DEFAULT 0,error_code TEXT,error TEXT,result TEXT,remote_task_id TEXT,remote_metadata TEXT,submission_started INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until TEXT,attempt INTEGER NOT NULL DEFAULT 0,parent_job_id TEXT REFERENCES jobs(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE job_assets(job_id TEXT NOT NULL REFERENCES jobs(id),asset_id TEXT NOT NULL REFERENCES assets(id),role TEXT NOT NULL CHECK(role IN('input','output')),PRIMARY KEY(job_id,asset_id,role));
 CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),message TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE conversations(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
 CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL CHECK(role IN('user','assistant')),content TEXT NOT NULL,job_id TEXT REFERENCES jobs(id),created_at TEXT NOT NULL);
 CREATE TABLE radar_assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,brand TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',industry TEXT NOT NULL DEFAULT '',objective TEXT NOT NULL DEFAULT '',format TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',asset_id TEXT REFERENCES assets(id),likes REAL,shares REAL,comments REAL,ctr REAL,budget REAL,metrics TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);
 CREATE TABLE favorites(user_id TEXT NOT NULL REFERENCES users(id),radar_id TEXT NOT NULL REFERENCES radar_assets(id),created_at TEXT NOT NULL,PRIMARY KEY(user_id,radar_id));
 CREATE TABLE analyses(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),asset_id TEXT NOT NULL REFERENCES assets(id),created_at TEXT NOT NULL);
 CREATE TABLE analysis_versions(id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL REFERENCES analyses(id),version INTEGER NOT NULL,prompt TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(analysis_id,version));
 CREATE TABLE analysis_jobs(version_id TEXT NOT NULL REFERENCES analysis_versions(id),section TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id),PRIMARY KEY(version_id,section));
 CREATE TABLE usage_events(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),job_id TEXT NOT NULL REFERENCES jobs(id),provider_name TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX jobs_queue ON jobs(status,created_at);CREATE INDEX jobs_owner ON jobs(owner_id,created_at);CREATE INDEX assets_owner ON assets(owner_id,deleted_at);CREATE INDEX sessions_expiry ON sessions(expires_at);
 `);
        this.run("INSERT INTO migrations VALUES(1,?)", now());
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
