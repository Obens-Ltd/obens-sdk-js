export type MappingType = 'SUB_ACTOR' | 'FACILITY' | 'ACCOUNT';
export type SubActorType = 'FARMER' | 'COLLECTOR' | 'COOPERATIVE' | 'COMPANY';
export type Gender = 'MALE' | 'FEMALE' | 'GROUP';
export type Status = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export interface ClientOptions {
  /** The core api, e.g. https://api.obens.so/v2/core */
  baseUrl: string;
  apiKey: string;
  /** act as this delegated account instead of the key's own */
  accountId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface SubActorPush {
  externalId: string;
  /** required to create, ignored afterwards */
  elementId?: string;
  name?: string;
  ref?: string;
  address?: string;
  type?: SubActorType;
  gender?: Gender;
  status?: Status;
  data?: Record<string, unknown>;
}

export interface FacilityPush {
  externalId: string;
  info?: { name?: string; description?: string; icon?: string; address?: string; imageUrl?: string };
  coordinates?: { type__: 'Point'; latitude: number; longitude: number } | { type__: 'Area'; type: string; features: unknown[] };
  data?: Record<string, unknown>;
  deleted?: boolean;
  /** External id of the farmer this facility belongs to; omit for the account's own facility. */
  subActorExternalId?: string;
}

export interface SyncResult {
  externalId: string;
  id: string | null;
  outcome: 'CREATED' | 'UPDATED' | 'FAILED';
  error: string | null;
}

export interface Mapping {
  type: MappingType;
  externalId: string;
  id: string;
}

export interface SyncReport {
  total: number;
  created: number;
  updated: number;
  failed: number;
  failures: { externalId: string; error: string | null }[];
  results: SyncResult[];
}

export class ObensApiError extends Error {
  status: number;
  body: unknown;
}

export interface Resource<P> {
  upsert(push: P): Promise<SyncResult>;
  bulk(items: P[], options?: { chunkSize?: number }): Promise<SyncResult[]>;
  get(externalId: string): Promise<any>;
}

export class IdMap {
  load(): Promise<this>;
  internal(externalId: string): Promise<string | undefined>;
  external(id: string): Promise<string | undefined>;
  remember(results: SyncResult[]): void;
}

export class Syncer<R, P> {
  init(records: Iterable<R> | AsyncIterable<R>): Promise<SyncReport>;
  push(record: R): Promise<SyncResult>;
  pushMany(records: R[]): Promise<SyncReport>;
  remove(record: R): Promise<SyncResult>;
}

export interface SyncerOptions<R, P> {
  map: (record: R) => P;
  chunkSize?: number;
  onProgress?: (report: SyncReport) => void;
}

export class ObensClient {
  constructor(options: ClientOptions);
  subActors: Resource<SubActorPush>;
  facilities: Resource<FacilityPush>;
  accounts: {
    accessible(): Promise<{ id: string; name: string; self: boolean }[]>;
    link(externalId: string, accountId: string): Promise<Mapping>;
    unlink(externalId: string): Promise<void>;
  };
  mappings: {
    list(type: MappingType): Promise<Mapping[]>;
    toInternal(type: MappingType, externalId: string): Promise<Mapping>;
    toExternal(type: MappingType, id: string): Promise<Mapping>;
  };
  /** A client acting as an account delegated to the key's account. */
  forAccount(accountId: string): ObensClient;
  whoami(): Promise<{ keyId: string; keyName: string; accountId: string; workspaceId: string }>;
  elements(): Promise<{ id: string; name: string; path: string }[]>;
  subActorSchema(elementId: string): Promise<{
    id: string; staticId?: string; name: string; type: string; writable: boolean; valueHint?: string;
    choices?: { id: string; label: string; value: string }[];
  }[]>;
  idMap(type: MappingType): IdMap;
  syncer<R>(kind: 'subActors', options: SyncerOptions<R, SubActorPush>): Syncer<R, SubActorPush>;
  syncer<R>(kind: 'facilities', options: SyncerOptions<R, FacilityPush>): Syncer<R, FacilityPush>;
}

/** A fixed value for every record; plain strings in a spec are paths into the record. */
export function constant<T>(value: T): () => T;

/** Spec entries: a (dotted) path string, a function of the record, or a non-string value. null / undefined results are left out. */
export function createMapper<R = any, P = any>(spec: Record<string, string | ((record: R) => unknown) | unknown>): (record: R) => P;
