import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { RETENTION_SCHEMA_DELTA_SQL, type RetentionStore } from "../../../src/coordination/retention/index.js";
export const AS_OF="2026-08-25T12:00:00.000Z";
export class Fixture implements RetentionStore{
 readonly dir=mkdtempSync(join(tmpdir(),"m30-retention-"));readonly path=join(this.dir,"source.sqlite");readonly db=new Database(this.path);
 constructor(){this.db.pragma("foreign_keys=ON");this.db.exec(`
 CREATE TABLE works(id TEXT PRIMARY KEY);CREATE TABLE deliveries(id TEXT PRIMARY KEY,outbox_id TEXT NOT NULL,state TEXT NOT NULL,final_disposition TEXT,terminal_at TEXT);CREATE TABLE outbox(id TEXT PRIMARY KEY,destination_reference TEXT NOT NULL);
 CREATE TABLE work_observations(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id),attempt_id TEXT,authority_reference TEXT NOT NULL,holder_instance_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,observation_kind TEXT NOT NULL,outcome_code TEXT NOT NULL,evidence_digest TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE delivery_attempts(delivery_id TEXT NOT NULL REFERENCES deliveries(id),ordinal INTEGER NOT NULL,claim_epoch INTEGER NOT NULL,claim_kind TEXT NOT NULL,endpoint_idempotency_key TEXT NOT NULL,claimant TEXT NOT NULL,started_at TEXT NOT NULL,settled_at TEXT,disposition TEXT,error_code TEXT,PRIMARY KEY(delivery_id,ordinal));
 CREATE TABLE messages(id TEXT PRIMARY KEY,body_text TEXT NOT NULL);CREATE TABLE events(sequence INTEGER PRIMARY KEY,payload_digest TEXT NOT NULL);CREATE TABLE authority_epochs(id TEXT PRIMARY KEY);CREATE TABLE import_items(id TEXT PRIMARY KEY);
 CREATE TRIGGER work_observations_no_delete BEFORE DELETE ON work_observations BEGIN SELECT RAISE(ABORT,'retained');END;CREATE TRIGGER delivery_attempts_no_delete BEFORE DELETE ON delivery_attempts BEGIN SELECT RAISE(ABORT,'retained');END;`);this.db.exec(RETENTION_SCHEMA_DELTA_SQL);this.seed();}
 readAll<T>(sql:string,...p:any[]):T[]{return this.db.prepare(sql).all(...p) as T[];} transaction<T>(work:(tx:any)=>T):T{return this.db.transaction(()=>work({readAll:<R>(sql:string,...p:any[])=>this.db.prepare(sql).all(...p) as R[],run:(sql:string,...p:any[])=>this.db.prepare(sql).run(...p)}))();}
 async backup(){const path=join(this.dir,"precompact.sqlite");await this.db.backup(path);return{path,sha256:hash(path),byteLength:readFileSync(path).byteLength,eventSequence:1};}
 hash(){this.db.pragma("wal_checkpoint(TRUNCATE)");return hash(this.path);}
 close(){this.db.close();}
 private seed(){this.db.exec(`INSERT INTO works VALUES('wrk_1'),('wrk_2');INSERT INTO outbox VALUES('obx_1','resident:bot_1');INSERT INTO deliveries VALUES('dlv_1','obx_1','delivered','accepted','2026-05-01T00:00:00.000Z');INSERT INTO messages VALUES('msg_1','conversation must remain');INSERT INTO events VALUES(1,'${"e".repeat(64)}');INSERT INTO authority_epochs VALUES('epoch_1');INSERT INTO import_items VALUES('import_1');`);const oi=this.db.prepare("INSERT INTO work_observations VALUES(?,?,?,?,?,?,?,?,?,?)");oi.run('obs_1','wrk_1',null,'resident:turn','instance',1,'running','heartbeat','a'.repeat(64),'2026-07-01T00:00:00.000Z');oi.run('obs_2','wrk_1',null,'resident:turn','instance',1,'running','progress','b'.repeat(64),'2026-07-02T00:00:00.000Z');oi.run('obs_terminal','wrk_1',null,'resident:turn','instance',1,'terminal','completed','c'.repeat(64),'2026-07-03T00:00:00.000Z');oi.run('obs_recent','wrk_2',null,'resident:turn','instance',1,'running','progress','d'.repeat(64),'2026-08-10T00:00:00.000Z');const di=this.db.prepare("INSERT INTO delivery_attempts VALUES(?,?,?,?,?,?,?,?,?,?)");di.run('dlv_1',1,1,'ordinary','x'.repeat(64),'worker','2026-05-01T00:00:00.000Z','2026-05-01T00:01:00.000Z','retryable_failure','timeout');di.run('dlv_1',2,2,'ordinary','x'.repeat(64),'worker','2026-05-01T00:02:00.000Z','2026-05-01T00:03:00.000Z','accepted',null);}
}
export function hash(path:string){return createHash("sha256").update(readFileSync(path)).digest("hex");}
export function restoreCopy(source:string,destination:string){copyFileSync(source,destination);return hash(destination);}
