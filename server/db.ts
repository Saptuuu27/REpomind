import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ServerApiVersion, type Collection, type Db } from 'mongodb';
import type {
  ChatMessage,
  CodeChunk,
  PersistenceMode,
  PersistenceStatus,
  RepositoryRecord,
  RepositorySummary,
} from '../src/types.ts';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), '.repomind-data');

export class DurablePersistenceError extends Error {
  readonly statusCode = 503;
  readonly isPersistenceError = true;

  constructor(message: string) {
    super(message);
    this.name = 'DurablePersistenceError';
  }
}

export function sanitizeMongoErrorText(raw: string): string {
  return raw.replace(/mongodb(?:\+srv)?:\/\/[^@\s'"]+@/gi, 'mongodb://***@');
}

function stripUndefinedFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const cleaned: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (cleaned as Record<string, unknown>)[key] = value;
    }
  }
  return cleaned;
}

export interface RepositoryStoreOptions {
  mongoUri?: string;
  dataDir?: string;
}

export class RepositoryStore {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private mode: PersistenceMode = 'local-disk';
  private mongoConfiguredFlag = false;
  private lastMongoError: string | null = null;
  private initPromise: Promise<void> | null = null;
  private repoCache = new Map<string, RepositoryRecord>();
  private readonly overrideMongoUri?: string;
  private readonly dataDir: string;
  private readonly reposDir: string;
  private readonly chunksDir: string;
  private readonly chatsDir: string;

  constructor(options?: RepositoryStoreOptions) {
    this.overrideMongoUri = options?.mongoUri;
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.reposDir = path.join(this.dataDir, 'repositories');
    this.chunksDir = path.join(this.dataDir, 'chunks');
    this.chatsDir = path.join(this.dataDir, 'chats');
  }

  private resolveMongoUri(): string | undefined {
    const raw =
      this.overrideMongoUri !== undefined
        ? this.overrideMongoUri
        : process.env.MONGODB_URI;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  }

  async init(): Promise<void> {
    if (this.mode === 'mongodb' && this.db) return;
    if (this.mode === 'local-disk' && !this.resolveMongoUri() && this.initPromise === null) {
      // Already initialized local disk intentionally when no URI configured
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initInternal();
    try {
      await this.initPromise;
    } catch (err) {
      // Allow subsequent calls to retry MongoDB connection if Atlas recovers
      this.initPromise = null;
      throw err;
    }
  }

  private async _initInternal(): Promise<void> {
    const uri = this.resolveMongoUri();
    this.mongoConfiguredFlag = Boolean(uri);

    if (uri) {
      let candidateClient: MongoClient | null = null;
      try {
        candidateClient = new MongoClient(uri, {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          family: 4,
          serverApi: {
            version: ServerApiVersion.v1,
            strict: false,
            deprecationErrors: false,
          },
        });
        await candidateClient.connect();
        await candidateClient.db('repomind').command({ ping: 1 });
        this.client = candidateClient;
        this.db = candidateClient.db('repomind');
        this.mode = 'mongodb';
        this.lastMongoError = null;
        await this.ensureMongoIndexes();
        console.log('[RepoMind DB] Connected to durable MongoDB (database: repomind).');
        return;
      } catch (err) {
        if (candidateClient) {
          await candidateClient.close().catch(() => {});
        }
        const msg = sanitizeMongoErrorText(
          (err instanceof Error ? err.message : String(err)).trim()
        );
        this.client = null;
        this.db = null;
        this.mode = 'unavailable';
        this.lastMongoError = msg;
        console.error(
          `[RepoMind DB] MongoDB connection failed while MONGODB_URI is configured. Refusing silent local fallback: ${msg}`
        );
        throw new DurablePersistenceError(
          `Durable MongoDB persistence is unavailable: ${msg}. Verify MONGODB_URI and Atlas Network Access. Nothing was saved to temporary storage.`
        );
      }
    }

    // Intentional non-durable local development fallback only when MONGODB_URI is unset
    await fs.mkdir(this.reposDir, { recursive: true });
    await fs.mkdir(this.chunksDir, { recursive: true });
    await fs.mkdir(this.chatsDir, { recursive: true });
    this.mode = 'local-disk';
    this.lastMongoError = null;
    console.warn(
      '[RepoMind DB] MONGODB_URI not configured; using temporary, non-durable local disk persistence (.repomind-data/).'
    );
  }

  private async safeCreateIndex(
    collectionName: string,
    keys: Record<string, 1 | -1>,
    options?: { unique?: boolean }
  ): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.collection(collectionName).createIndex(keys, options ?? {});
    } catch (err) {
      if (options?.unique) {
        console.warn(
          `[RepoMind DB] Unique index on ${collectionName} skipped due to existing data conflict; ensuring non-unique index instead.`
        );
        await this.db.collection(collectionName).createIndex(keys, {});
      } else {
        throw err;
      }
    }
  }

  private async ensureMongoIndexes(): Promise<void> {
    if (!this.db) return;
    await this.safeCreateIndex('repositories', { id: 1 }, { unique: true });
    await this.safeCreateIndex('repositories', { ingestedAt: -1 });
    await this.safeCreateIndex('code_chunks', { repoId: 1 });
    await this.safeCreateIndex('code_chunks', { repoId: 1, id: 1 }, { unique: true });
    await this.safeCreateIndex('chat_messages', { repoId: 1, createdAt: 1 });
  }

  private assertWriteReady(): void {
    if (this.mode === 'unavailable' || (this.mongoConfiguredFlag && !this.db)) {
      throw new DurablePersistenceError(
        this.lastMongoError
          ? `Durable MongoDB persistence is unavailable (${this.lastMongoError}). Data was not saved.`
          : 'Durable MongoDB persistence is unavailable. Data was not saved.'
      );
    }
  }

  getMode(): PersistenceMode {
    return this.mode;
  }

  getPersistenceStatus(): PersistenceStatus {
    if (this.mode === 'mongodb' && this.db) return 'durable';
    if (this.mode === 'local-disk') return 'temporary-local';
    return 'unavailable';
  }

  isDurable(): boolean {
    return this.mode === 'mongodb' && this.db !== null;
  }

  isMongoConfigured(): boolean {
    return this.mongoConfiguredFlag || Boolean(this.resolveMongoUri());
  }

  getDatabaseName(): string | null {
    return this.db ? this.db.databaseName : this.mongoConfiguredFlag ? 'repomind' : null;
  }

  isMongoConnected(): boolean {
    return this.mode === 'mongodb' && this.db !== null;
  }

  getLastMongoError(): string | null {
    return this.lastMongoError;
  }

  clearInMemoryCache(repoId?: string): void {
    if (repoId) {
      this.repoCache.delete(repoId);
    } else {
      this.repoCache.clear();
    }
  }

  private reposCollection(): Collection<RepositoryRecord> {
    if (!this.db) throw new DurablePersistenceError('MongoDB not initialized');
    return this.db.collection<RepositoryRecord>('repositories');
  }

  private chunksCollection(): Collection<CodeChunk> {
    if (!this.db) throw new DurablePersistenceError('MongoDB not initialized');
    return this.db.collection<CodeChunk>('code_chunks');
  }

  private chatsCollection(): Collection<ChatMessage> {
    if (!this.db) throw new DurablePersistenceError('MongoDB not initialized');
    return this.db.collection<ChatMessage>('chat_messages');
  }

  private safeFileKey(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  async listRepositories(): Promise<RepositorySummary[]> {
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      const docs = await this.reposCollection()
        .find(
          { id: { $not: /^__repomind_diag_selftest_/ } },
          {
            projection: {
              id: 1,
              metadata: 1,
              detectedFacts: 1,
              chunkCount: 1,
              embeddingsCount: 1,
              embeddingsReady: 1,
              indexingStatus: 1,
              ingestedAt: 1,
            },
          }
        )
        .sort({ ingestedAt: -1 })
        .toArray();
      return docs.map((d) => ({
        id: d.id,
        owner: d.metadata.owner,
        name: d.metadata.name,
        fullName: d.metadata.fullName,
        description: d.metadata.description,
        defaultBranch: d.metadata.defaultBranch,
        commitSha: d.metadata.commitSha,
        stars: d.metadata.stars,
        primaryLanguage: d.metadata.primaryLanguage,
        ingestedFileCount: d.detectedFacts.ingestedFileCount,
        eligibleFileCount: d.detectedFacts.eligibleFileCount,
        chunkCount: d.chunkCount,
        embeddingsCount: d.embeddingsCount,
        embeddingsReady: d.embeddingsReady,
        indexingStatus: d.indexingStatus,
        ingestedAt: d.ingestedAt,
      }));
    }

    const entries = await fs.readdir(this.reposDir);
    const summaries: RepositorySummary[] = [];
    for (const file of entries) {
      if (!file.endsWith('.json') || file.startsWith('__repomind_diag_selftest_')) continue;
      try {
        const raw = await fs.readFile(path.join(this.reposDir, file), 'utf8');
        const repo = JSON.parse(raw) as RepositoryRecord;
        summaries.push({
          id: repo.id,
          owner: repo.metadata.owner,
          name: repo.metadata.name,
          fullName: repo.metadata.fullName,
          description: repo.metadata.description,
          defaultBranch: repo.metadata.defaultBranch,
          commitSha: repo.metadata.commitSha,
          stars: repo.metadata.stars,
          primaryLanguage: repo.metadata.primaryLanguage,
          ingestedFileCount: repo.detectedFacts.ingestedFileCount,
          eligibleFileCount: repo.detectedFacts.eligibleFileCount,
          chunkCount: repo.chunkCount,
          embeddingsCount: repo.embeddingsCount,
          embeddingsReady: repo.embeddingsReady,
          indexingStatus: repo.indexingStatus,
          ingestedAt: repo.ingestedAt,
        });
      } catch {
        // Ignore corrupted JSON files
      }
    }
    return summaries.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    await this.init();
    this.assertWriteReady();

    const cached = this.repoCache.get(id);
    if (cached) return cached;

    if (this.mode === 'mongodb' && this.db) {
      const doc = await this.reposCollection().findOne({ id }, { projection: { _id: 0 } });
      if (doc) {
        this.repoCache.set(id, doc);
        return doc;
      }
      return null;
    }

    const filePath = path.join(this.reposDir, `${this.safeFileKey(id)}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const doc = JSON.parse(raw) as RepositoryRecord;
      this.repoCache.set(id, doc);
      return doc;
    } catch {
      return null;
    }
  }

  async confirmRepositoryPersisted(id: string): Promise<boolean> {
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      const doc = await this.reposCollection().findOne(
        { id },
        { projection: { _id: 0, id: 1 } }
      );
      return Boolean(doc && doc.id === id);
    }

    const filePath = path.join(this.reposDir, `${this.safeFileKey(id)}.json`);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async saveRepository(repo: RepositoryRecord): Promise<void> {
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      const payload = stripUndefinedFields(repo as unknown as Record<string, unknown>);
      const result = await this.reposCollection().updateOne(
        { id: repo.id },
        { $set: payload },
        { upsert: true }
      );
      if (!result.acknowledged) {
        throw new DurablePersistenceError(
          `MongoDB did not acknowledge repository save for ${repo.id}.`
        );
      }
      this.repoCache.set(repo.id, repo);
      return;
    }

    this.repoCache.set(repo.id, repo);
    const filePath = path.join(this.reposDir, `${this.safeFileKey(repo.id)}.json`);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(repo), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async updateRepositoryFields(
    repoId: string,
    patch: Partial<RepositoryRecord>
  ): Promise<void> {
    await this.init();
    this.assertWriteReady();

    const cleanedPatch = stripUndefinedFields(patch as Record<string, unknown>);
    if (Object.keys(cleanedPatch).length === 0) return;

    if (this.mode === 'mongodb' && this.db) {
      const result = await this.reposCollection().updateOne(
        { id: repoId },
        { $set: cleanedPatch }
      );
      if (!result.acknowledged) {
        throw new DurablePersistenceError(
          `MongoDB did not acknowledge repository update for ${repoId}.`
        );
      }
      if (result.matchedCount === 0) {
        throw new DurablePersistenceError(
          `Repository record ${repoId} not found in MongoDB during targeted update.`
        );
      }
      const cached = this.repoCache.get(repoId);
      if (cached) {
        this.repoCache.set(repoId, { ...cached, ...cleanedPatch });
      }
      return;
    }

    const existing = await this.getRepository(repoId);
    if (!existing) {
      throw new DurablePersistenceError(
        `Repository record ${repoId} not found during update.`
      );
    }
    const updated: RepositoryRecord = { ...existing, ...cleanedPatch };
    this.repoCache.set(repoId, updated);
    const filePath = path.join(this.reposDir, `${this.safeFileKey(repoId)}.json`);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(updated), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async saveComprehensiveOverview(
    repoId: string,
    overview: import('../src/types.ts').ComprehensiveOverview,
    aiAnalysis?: import('../src/types.ts').AIAnalysis
  ): Promise<void> {
    const updateFields: Partial<RepositoryRecord> = {
      comprehensiveOverview: overview,
    };
    if (aiAnalysis) {
      updateFields.aiAnalysis = aiAnalysis;
    }
    await this.updateRepositoryFields(repoId, updateFields);
  }

  async deleteRepository(id: string): Promise<void> {
    await this.init();
    this.assertWriteReady();
    this.repoCache.delete(id);

    if (this.mode === 'mongodb' && this.db) {
      await Promise.all([
        this.reposCollection().deleteOne({ id }),
        this.chunksCollection().deleteMany({ repoId: id }),
        this.chatsCollection().deleteMany({ repoId: id }),
      ]);
      return;
    }

    const key = this.safeFileKey(id);
    await Promise.all([
      fs.rm(path.join(this.reposDir, `${key}.json`), { force: true }),
      fs.rm(path.join(this.chunksDir, `${key}.json`), { force: true }),
      fs.rm(path.join(this.chatsDir, `${key}.json`), { force: true }),
    ]);
  }

  async saveChunks(
    repoId: string,
    chunks: CodeChunk[],
    options?: { allowClear?: boolean }
  ): Promise<void> {
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      if (chunks.length === 0) {
        if (!options?.allowClear) {
          const existingCount = await this.chunksCollection().countDocuments({ repoId });
          if (existingCount > 0) {
            throw new DurablePersistenceError(
              `Refused to overwrite ${existingCount} existing code chunks for ${repoId} with an empty set.`
            );
          }
          return;
        }
        await this.chunksCollection().deleteMany({ repoId });
        return;
      }

      const BATCH_SIZE = 100;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const slice = chunks.slice(i, i + BATCH_SIZE);
        const result = await this.chunksCollection().bulkWrite(
          slice.map((chunk) => ({
            updateOne: {
              filter: { repoId, id: chunk.id },
              update: { $set: chunk },
              upsert: true,
            },
          })),
          { ordered: false }
        );
        if (!result.ok) {
          throw new DurablePersistenceError(
            `MongoDB chunk upsert failed for ${repoId}.`
          );
        }
      }

      // Remove only obsolete chunks AFTER all current chunks have been durably upserted
      const validIds = chunks.map((c) => c.id);
      await this.chunksCollection().deleteMany({
        repoId,
        id: { $nin: validIds },
      });
      return;
    }

    const filePath = path.join(this.chunksDir, `${this.safeFileKey(repoId)}.json`);
    if (chunks.length === 0 && !options?.allowClear) {
      const existing = await this.getChunks(repoId);
      if (existing.length > 0) {
        throw new DurablePersistenceError(
          `Refused to overwrite ${existing.length} existing chunks for ${repoId} with an empty set.`
        );
      }
      return;
    }
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(chunks), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async saveChunkBatch(repoId: string, updatedChunks: CodeChunk[]): Promise<void> {
    if (updatedChunks.length === 0) return;
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      const result = await this.chunksCollection().bulkWrite(
        updatedChunks.map((chunk) => ({
          updateOne: {
            filter: { repoId, id: chunk.id },
            update: { $set: chunk },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      if (!result.ok) {
        throw new DurablePersistenceError(
          `MongoDB chunk batch checkpoint failed for ${repoId}.`
        );
      }
      return;
    }

    const existing = await this.getChunks(repoId);
    const byId = new Map(existing.map((c) => [c.id, c]));
    for (const chunk of updatedChunks) {
      byId.set(chunk.id, chunk);
    }
    const filePath = path.join(this.chunksDir, `${this.safeFileKey(repoId)}.json`);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(Array.from(byId.values())), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async getChunks(repoId: string): Promise<CodeChunk[]> {
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      return this.chunksCollection()
        .find({ repoId }, { projection: { _id: 0 } })
        .toArray();
    }

    const filePath = path.join(this.chunksDir, `${this.safeFileKey(repoId)}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as CodeChunk[];
    } catch {
      return [];
    }
  }

  async getChatMessages(repoId: string): Promise<ChatMessage[]> {
    await this.init();
    this.assertWriteReady();

    if (this.mode === 'mongodb' && this.db) {
      return this.chatsCollection()
        .find({ repoId }, { projection: { _id: 0 } })
        .sort({ createdAt: 1 })
        .toArray();
    }

    const filePath = path.join(this.chatsDir, `${this.safeFileKey(repoId)}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as ChatMessage[];
    } catch {
      return [];
    }
  }

  async appendChatMessages(repoId: string, newMessages: ChatMessage[]): Promise<void> {
    await this.init();
    this.assertWriteReady();
    if (newMessages.length === 0) return;

    if (this.mode === 'mongodb' && this.db) {
      const result = await this.chatsCollection().insertMany(newMessages);
      if (!result.acknowledged || result.insertedCount !== newMessages.length) {
        throw new DurablePersistenceError(
          `MongoDB failed to persist chat messages for ${repoId}.`
        );
      }
      return;
    }

    const existing = await this.getChatMessages(repoId);
    const updated = [...existing, ...newMessages];
    const filePath = path.join(this.chatsDir, `${this.safeFileKey(repoId)}.json`);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(updated), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async clearChatMessages(repoId: string): Promise<void> {
    await this.init();
    this.assertWriteReady();
    if (this.mode === 'mongodb' && this.db) {
      await this.chatsCollection().deleteMany({ repoId });
      return;
    }

    await fs.rm(path.join(this.chatsDir, `${this.safeFileKey(repoId)}.json`), { force: true });
  }

  async runPersistenceSelfTest(): Promise<{
    connected: boolean;
    readSuccessful: boolean;
    writeSuccessful: boolean;
    persistenceVerified: boolean;
    persistenceMode: PersistenceMode;
    isDurable: boolean;
    databaseName: string | null;
    requiredCollections: Record<'repositories' | 'code_chunks' | 'chat_messages', boolean>;
    existingRepositoryCount: number | null;
    postCleanupRepositoryCount: number | null;
    chunkAndChatAccessible: boolean;
    cleanupVerified: boolean;
    diagnosticRecordId: string;
    error?: string;
  }> {
    const diagnosticRecordId = `__repomind_diag_selftest_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const requiredCollections: Record<'repositories' | 'code_chunks' | 'chat_messages', boolean> = {
      repositories: false,
      code_chunks: false,
      chat_messages: false,
    };

    let connected = false;
    let readSuccessful = false;
    let writeSuccessful = false;
    let chunkAndChatAccessible = false;
    let cleanupVerified = false;
    let existingRepositoryCount: number | null = null;
    let postCleanupRepositoryCount: number | null = null;

    try {
      await this.init();
      this.assertWriteReady();

      if (this.mode !== 'mongodb' || !this.db || !this.client) {
        return {
          connected: false,
          readSuccessful: false,
          writeSuccessful: false,
          persistenceVerified: false,
          persistenceMode: this.mode,
          isDurable: false,
          databaseName: this.getDatabaseName(),
          requiredCollections,
          existingRepositoryCount: null,
          postCleanupRepositoryCount: null,
          chunkAndChatAccessible: false,
          cleanupVerified: false,
          diagnosticRecordId,
          error:
            this.lastMongoError ||
            'MongoDB is not active; persistence self-test requires an active MongoDB connection.',
        };
      }

      // 1. Live ping
      await this.db.command({ ping: 1 });
      connected = true;

      // 2. Inspect required collections & existing counts (read-only)
      const cols = await this.db.listCollections({}, { nameOnly: true }).toArray();
      const colNames = new Set(cols.map((c) => c.name));
      requiredCollections.repositories = colNames.has('repositories');
      requiredCollections.code_chunks = colNames.has('code_chunks');
      requiredCollections.chat_messages = colNames.has('chat_messages');

      existingRepositoryCount = await this.reposCollection().countDocuments({
        id: { $not: /^__repomind_diag_selftest_/ },
      });
      await this.chunksCollection().countDocuments({ repoId: diagnosticRecordId });
      await this.chatsCollection().countDocuments({ repoId: diagnosticRecordId });
      readSuccessful = true;

      // 3. Write temporary isolated diagnostic records across all 3 collections
      const markerNonce = crypto.randomBytes(6).toString('hex');
      const diagRepoDoc = {
        id: diagnosticRecordId,
        diagnosticOnly: true,
        markerNonce,
        createdAt: new Date().toISOString(),
      };
      const repoWriteRes = await this.db
        .collection('repositories')
        .updateOne({ id: diagnosticRecordId }, { $set: diagRepoDoc }, { upsert: true });

      const diagChunkDoc: CodeChunk = {
        id: `chunk_${markerNonce}`,
        repoId: diagnosticRecordId,
        filePath: '__diag__/selftest.ts',
        startLine: 1,
        endLine: 1,
        language: 'TypeScript',
        content: '// self-test diagnostic chunk',
        embedding: [0.1, 0.2, 0.3],
      };
      const chunkWriteRes = await this.chunksCollection().insertOne(diagChunkDoc);

      const diagChatDoc: ChatMessage = {
        id: `chat_${markerNonce}`,
        repoId: diagnosticRecordId,
        role: 'user',
        content: 'self-test diagnostic message',
        createdAt: new Date().toISOString(),
      };
      const chatWriteRes = await this.chatsCollection().insertOne(diagChatDoc);

      // Refresh collection presence after write
      const postWriteCols = await this.db.listCollections({}, { nameOnly: true }).toArray();
      const postColNames = new Set(postWriteCols.map((c) => c.name));
      requiredCollections.repositories = postColNames.has('repositories');
      requiredCollections.code_chunks = postColNames.has('code_chunks');
      requiredCollections.chat_messages = postColNames.has('chat_messages');

      // 4. Read back exact diagnostic records directly from MongoDB (no cache)
      const readRepo = await this.db
        .collection('repositories')
        .findOne({ id: diagnosticRecordId }, { projection: { _id: 0 } });
      const readChunk = await this.chunksCollection().findOne(
        { repoId: diagnosticRecordId, id: diagChunkDoc.id },
        { projection: { _id: 0 } }
      );
      const readChat = await this.chatsCollection().findOne(
        { repoId: diagnosticRecordId, id: diagChatDoc.id },
        { projection: { _id: 0 } }
      );

      writeSuccessful =
        Boolean(repoWriteRes.acknowledged) &&
        Boolean(readRepo) &&
        readRepo?.markerNonce === markerNonce;

      chunkAndChatAccessible =
        Boolean(chunkWriteRes.acknowledged) &&
        Boolean(chatWriteRes.acknowledged) &&
        Boolean(readChunk) &&
        readChunk?.id === diagChunkDoc.id &&
        Array.isArray(readChunk?.embedding) &&
        readChunk.embedding.length === 3 &&
        Boolean(readChat) &&
        readChat?.id === diagChatDoc.id;

      // 5. Clean up ONLY the exact diagnostic record ID across all 3 collections
      await Promise.all([
        this.db.collection('repositories').deleteOne({ id: diagnosticRecordId }),
        this.chunksCollection().deleteMany({ repoId: diagnosticRecordId }),
        this.chatsCollection().deleteMany({ repoId: diagnosticRecordId }),
      ]);

      const remainingDiagRepo = await this.db
        .collection('repositories')
        .countDocuments({ id: diagnosticRecordId });
      const remainingDiagChunks = await this.chunksCollection().countDocuments({
        repoId: diagnosticRecordId,
      });
      const remainingDiagChats = await this.chatsCollection().countDocuments({
        repoId: diagnosticRecordId,
      });
      postCleanupRepositoryCount = await this.reposCollection().countDocuments({
        id: { $not: /^__repomind_diag_selftest_/ },
      });

      cleanupVerified =
        remainingDiagRepo === 0 &&
        remainingDiagChunks === 0 &&
        remainingDiagChats === 0 &&
        postCleanupRepositoryCount === existingRepositoryCount;

      const persistenceVerified =
        connected &&
        readSuccessful &&
        writeSuccessful &&
        chunkAndChatAccessible &&
        cleanupVerified;

      return {
        connected,
        readSuccessful,
        writeSuccessful,
        persistenceVerified,
        persistenceMode: this.mode,
        isDurable: this.isDurable(),
        databaseName: this.db.databaseName,
        requiredCollections,
        existingRepositoryCount,
        postCleanupRepositoryCount,
        chunkAndChatAccessible,
        cleanupVerified,
        diagnosticRecordId,
      };
    } catch (err) {
      if (this.db) {
        await Promise.allSettled([
          this.db.collection('repositories').deleteOne({ id: diagnosticRecordId }),
          this.chunksCollection().deleteMany({ repoId: diagnosticRecordId }),
          this.chatsCollection().deleteMany({ repoId: diagnosticRecordId }),
        ]);
      }
      return {
        connected,
        readSuccessful,
        writeSuccessful,
        persistenceVerified: false,
        persistenceMode: this.mode,
        isDurable: false,
        databaseName: this.getDatabaseName(),
        requiredCollections,
        existingRepositoryCount,
        postCleanupRepositoryCount,
        chunkAndChatAccessible,
        cleanupVerified,
        diagnosticRecordId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async inspectMongoDatabases(targetRepoId = 'saptuuu27__aeva-id'): Promise<{
    connected: boolean;
    persistenceMode: PersistenceMode;
    activeDatabase: string;
    driverDefaultDatabase: string | null;
    targetRepoId: string;
    listDatabasesStatus: 'ok' | 'permission-denied' | 'error' | 'not-connected';
    listDatabasesNote?: string;
    databases: Array<{
      databaseName: string;
      isActiveAppDatabase: boolean;
      collections: string[];
      hasRepositoriesCollection: boolean;
      repositoryCount: number | null;
      hasTargetRepository: boolean;
      targetRepositorySummary?: {
        id: string;
        fullName?: string;
        ingestedAt?: string;
        indexingStatus?: string;
        ingestedFileCount?: number;
        chunkCount?: number;
        embeddingsCount?: number;
      } | null;
      sampleRepositories?: Array<{
        id: string;
        fullName?: string;
        ingestedAt?: string;
        indexingStatus?: string;
      }>;
      hasChatMessagesCollection: boolean;
      totalChatMessageCount: number | null;
      targetChatMessageCount: number | null;
      hasCodeChunksCollection: boolean;
      totalCodeChunkCount: number | null;
      targetCodeChunkCount: number | null;
      permissionError?: string;
    }>;
  }> {
    await this.init();

    if (this.mode !== 'mongodb' || !this.client || !this.db) {
      return {
        connected: false,
        persistenceMode: this.mode,
        activeDatabase: 'repomind',
        driverDefaultDatabase: null,
        targetRepoId,
        listDatabasesStatus: 'not-connected',
        listDatabasesNote: this.lastMongoError || 'MongoDB client is not connected.',
        databases: [],
      };
    }

    const activeDatabase = this.db.databaseName;
    const rawDefaultDb = this.client.db().databaseName || null;
    const driverDefaultDatabase =
      rawDefaultDb && !['admin', 'local', 'config'].includes(rawDefaultDb)
        ? rawDefaultDb
        : null;

    const candidateDbs = new Set<string>([activeDatabase]);
    if (driverDefaultDatabase) {
      candidateDbs.add(driverDefaultDatabase);
    }

    let listDatabasesStatus: 'ok' | 'permission-denied' | 'error' = 'ok';
    let listDatabasesNote: string | undefined;

    try {
      const listed = await this.client.db('admin').admin().listDatabases();
      for (const dbInfo of listed.databases) {
        if (!['admin', 'local', 'config'].includes(dbInfo.name)) {
          candidateDbs.add(dbInfo.name);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      listDatabasesStatus =
        lower.includes('not authorized') ||
        lower.includes('unauthorized') ||
        lower.includes('permission') ||
        lower.includes('auth')
          ? 'permission-denied'
          : 'error';
      listDatabasesNote = msg;
    }

    const escapedTarget = targetRepoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const caseInsensitiveIdQuery = { id: new RegExp(`^${escapedTarget}$`, 'i') };

    const databases = [];

    for (const dbName of Array.from(candidateDbs)) {
      const db = this.client.db(dbName);
      try {
        const rawCollections = await db.listCollections({}, { nameOnly: true }).toArray();
        const collections = rawCollections.map((c) => c.name).sort();

        const hasRepositoriesCollection = collections.includes('repositories');
        const hasChatMessagesCollection = collections.includes('chat_messages');
        const hasCodeChunksCollection = collections.includes('code_chunks');

        let repositoryCount: number | null = null;
        let hasTargetRepository = false;
        let targetRepositorySummary: {
          id: string;
          fullName?: string;
          ingestedAt?: string;
          indexingStatus?: string;
          ingestedFileCount?: number;
          chunkCount?: number;
          embeddingsCount?: number;
        } | null = null;
        let sampleRepositories:
          | Array<{
              id: string;
              fullName?: string;
              ingestedAt?: string;
              indexingStatus?: string;
            }>
          | undefined;

        if (hasRepositoriesCollection) {
          const reposCol = db.collection('repositories');
          repositoryCount = await reposCol.countDocuments();
          const matchedDoc = await reposCol.findOne(caseInsensitiveIdQuery, {
            projection: {
              _id: 0,
              id: 1,
              'metadata.fullName': 1,
              ingestedAt: 1,
              indexingStatus: 1,
              'detectedFacts.ingestedFileCount': 1,
              chunkCount: 1,
              embeddingsCount: 1,
            },
          });

          if (matchedDoc) {
            hasTargetRepository = true;
            const meta = matchedDoc.metadata as { fullName?: string } | undefined;
            const facts = matchedDoc.detectedFacts as { ingestedFileCount?: number } | undefined;
            targetRepositorySummary = {
              id: String(matchedDoc.id ?? ''),
              fullName: meta?.fullName,
              ingestedAt:
                typeof matchedDoc.ingestedAt === 'string' ? matchedDoc.ingestedAt : undefined,
              indexingStatus:
                typeof matchedDoc.indexingStatus === 'string'
                  ? matchedDoc.indexingStatus
                  : undefined,
              ingestedFileCount: facts?.ingestedFileCount,
              chunkCount:
                typeof matchedDoc.chunkCount === 'number' ? matchedDoc.chunkCount : undefined,
              embeddingsCount:
                typeof matchedDoc.embeddingsCount === 'number'
                  ? matchedDoc.embeddingsCount
                  : undefined,
            };
          }

          if (repositoryCount > 0) {
            const sampleDocs = await reposCol
              .find(
                {},
                {
                  projection: {
                    _id: 0,
                    id: 1,
                    'metadata.fullName': 1,
                    ingestedAt: 1,
                    indexingStatus: 1,
                  },
                }
              )
              .limit(20)
              .toArray();
            sampleRepositories = sampleDocs.map((d) => {
              const meta = d.metadata as { fullName?: string } | undefined;
              return {
                id: String(d.id ?? ''),
                fullName: meta?.fullName,
                ingestedAt: typeof d.ingestedAt === 'string' ? d.ingestedAt : undefined,
                indexingStatus:
                  typeof d.indexingStatus === 'string' ? d.indexingStatus : undefined,
              };
            });
          }
        }

        let totalChatMessageCount: number | null = null;
        let targetChatMessageCount: number | null = null;
        if (hasChatMessagesCollection) {
          const chatsCol = db.collection('chat_messages');
          totalChatMessageCount = await chatsCol.countDocuments();
          targetChatMessageCount = await chatsCol.countDocuments({
            repoId: new RegExp(`^${escapedTarget}$`, 'i'),
          });
        }

        let totalCodeChunkCount: number | null = null;
        let targetCodeChunkCount: number | null = null;
        if (hasCodeChunksCollection) {
          const chunksCol = db.collection('code_chunks');
          totalCodeChunkCount = await chunksCol.countDocuments();
          targetCodeChunkCount = await chunksCol.countDocuments({
            repoId: new RegExp(`^${escapedTarget}$`, 'i'),
          });
        }

        databases.push({
          databaseName: dbName,
          isActiveAppDatabase: dbName === activeDatabase,
          collections,
          hasRepositoriesCollection,
          repositoryCount,
          hasTargetRepository,
          targetRepositorySummary,
          ...(sampleRepositories ? { sampleRepositories } : {}),
          hasChatMessagesCollection,
          totalChatMessageCount,
          targetChatMessageCount,
          hasCodeChunksCollection,
          totalCodeChunkCount,
          targetCodeChunkCount,
        });
      } catch (err) {
        databases.push({
          databaseName: dbName,
          isActiveAppDatabase: dbName === activeDatabase,
          collections: [],
          hasRepositoriesCollection: false,
          repositoryCount: null,
          hasTargetRepository: false,
          hasChatMessagesCollection: false,
          totalChatMessageCount: null,
          targetChatMessageCount: null,
          hasCodeChunksCollection: false,
          totalCodeChunkCount: null,
          targetCodeChunkCount: null,
          permissionError: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      connected: true,
      persistenceMode: this.mode,
      activeDatabase,
      driverDefaultDatabase,
      targetRepoId,
      listDatabasesStatus,
      ...(listDatabasesNote ? { listDatabasesNote } : {}),
      databases,
    };
  }
}

export const store = new RepositoryStore();
