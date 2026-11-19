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
  /** The trace api that holds batches and transactions. Default: baseUrl with /v2/core swapped for /v2/trace */
  traceUrl?: string;
  /** Batches and transactions wait for the platform to finish creating them (default 90000) */
  traceTimeoutMs?: number;
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

export interface QuantityPush {
  value: number;
  /** a unit symbol, e.g. KG, T, L, or a currency such as EUR for prices */
  unit: string;
}

export interface BatchPush {
  externalId: string;
  /** required to create, ignored afterwards */
  elementId?: string;
  /** required to create, ignored afterwards */
  productionMethodId?: string;
  name?: string;
  quantity?: QuantityPush;
  /** 2026-01-31 */
  productionDate?: string;
  expiryDate?: string;
  /** the production method's form by field name, see `batches.schema` */
  data?: Record<string, unknown>;
}

export interface TransactionPush {
  externalId: string;
  elementId: string;
  /** A purchase from a farmer: his platform id, or `subActorExternalId` (your id). Needs `collected`. */
  subActorId?: string;
  subActorExternalId?: string;
  /** A transfer between accounts: one of them is the key's account. Platform ids, or `...ExternalId` of linked accounts. */
  supplierId?: string;
  supplierExternalId?: string;
  clientId?: string;
  clientExternalId?: string;
  name?: string;
  date?: string;
  progress?: 'PROGRESS' | 'EXECUTED';
  unitPrice?: QuantityPush;
  transportPrice?: QuantityPush;
  packingPrice?: QuantityPush;
  servicesPrice?: QuantityPush;
  taxPrice?: QuantityPush;
  /** A transfer: the supplier's batches, by your id. Fixed once created. */
  batches?: { batchExternalId: string; quantity: QuantityPush }[];
  /** A purchase: the batch it creates. */
  collected?: {
    name: string;
    quantity: QuantityPush;
    productionDate?: string;
    expiryDate?: string;
    productionMethodId?: string;
    facilityIds?: string[];
    facilityExternalIds?: string[];
  };
  /** the transaction form by field name, see `transactions.schema` */
  data?: Record<string, unknown>;
}

export interface FieldRef {
  id: string; staticId?: string; name: string; type: string; writable: boolean; valueHint?: string;
  choices?: { id: string; label: string; value: string }[];
}

export interface Page<T> {
  data: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

export interface FieldValue {
  id: string;
  staticId?: string;
  name: string;
  type: string;
  /** string | number | { value, unit } | string[] */
  value: unknown;
}

export interface BatchSummary {
  id: string;
  name: string;
  ref?: string;
  externalId?: string;
  productionDate?: string;
  expiryDate?: string;
  element?: { id: string; name: string };
  owner?: { id: string; name: string };
  quantities: { value: number; unit: string; order?: number }[];
}

export interface TransactionSummary {
  id: string;
  name: string;
  externalId?: string;
  progress: string;
  date?: string;
  totalQuantity?: number;
  client?: { id: string; name: string };
  supplier?: { id: string; name: string };
  element?: { id: string; name: string };
  unitPrice?: { value: number; unit: string };
  totalPrice?: { value: number; unit: string };
}

export interface TraceResource<P> {
  upsert(push: P): Promise<SyncResult>;
  bulk(items: P[]): Promise<SyncResult[]>;
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
  batches: TraceResource<BatchPush> & {
    get(externalId: string, options?: { ownerId?: string }): Promise<any>;
    list(elementId: string, options?: { ownerId?: string; search?: string; year?: number; page?: number; size?: number }): Promise<Page<BatchSummary>>;
    data(externalId: string, options?: { ownerId?: string }): Promise<FieldValue[]>;
    schema(productionMethodId: string): Promise<FieldRef[]>;
  };
  transactions: TraceResource<TransactionPush> & {
    get(externalId: string, options?: { supplierId?: string }): Promise<any>;
    list(elementId: string, options?: { otherAccountId?: string; type?: 'BUY' | 'SELL'; start?: string; end?: string; search?: string; page?: number; size?: number }): Promise<Page<TransactionSummary>>;
    data(externalId: string, options?: { supplierId?: string }): Promise<FieldValue[]>;
    schema(elementId: string, options?: { clientId?: string }): Promise<FieldRef[]>;
  };
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
