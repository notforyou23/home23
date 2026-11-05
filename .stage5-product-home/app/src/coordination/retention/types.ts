import type { SqliteValue } from "../db/index.js";
export const PROGRESS_RETENTION_DAYS = 30;
export const DELIVERY_ATTEMPT_RETENTION_DAYS = 90;
export type RetentionCandidateKind = "noisy_progress" | "delivery_attempt_detail";
export interface RetentionCandidate { kind:RetentionCandidateKind; key:string; sourceCount:number; sourceBytes:number; firstAt:string; lastAt:string; sourceDigest:string; sourceIds:readonly string[]; summary:Readonly<Record<string,unknown>>; }
export interface RetentionException { candidateKey:string; class:"legal"|"security"; reference:string; }
export interface RetentionPlan { version:1; asOf:string; cutoffs:{progressBefore:string;deliveryAttemptsBefore:string}; candidates:readonly RetentionCandidate[]; exceptions:readonly RetentionException[]; totals:{candidates:number;sourceRows:number;sourceBytes:number}; digest:string; }
export interface RetentionReader { readAll<T>(sql:string,...parameters:SqliteValue[]):T[]; }
export interface RetentionTransaction extends RetentionReader { run(sql:string,...parameters:SqliteValue[]):{changes:number|bigint}; }
export interface RetentionStore extends RetentionReader { transaction<T>(work:(transaction:RetentionTransaction)=>T):T; }
export interface RetentionBackupReceipt { sha256:string; byteLength:number; eventSequence:number; }
export interface RetentionBackupProvider { createPrecompactBackup():Promise<RetentionBackupReceipt>; }
export interface RetentionReceipt { planDigest:string; backup:RetentionBackupReceipt; compacted:{summaries:number;sourceRows:number;sourceBytes:number}; postCompactHash:string; }
