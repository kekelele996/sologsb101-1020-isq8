/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录）
 * - 五张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare, CompareHistory } from '@/types/compare';
import type { CollabBatch, CollabItem, CollabLoss, CollabRubbing } from '@/types/collab';
import { sortLosses } from './collate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
} as const;

export interface UiPrefs {
  lastSteleId: string | null;
  lastRubbingId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastSteleId: null, lastRubbingId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastSteleId: typeof parsed.lastSteleId === 'string' ? parsed.lastSteleId : null,
      lastRubbingId: typeof parsed.lastRubbingId === 'string' ? parsed.lastRubbingId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  compareHistory!: Table<CompareHistory, string>;
  collabBatches!: Table<CollabBatch, string>;
  collabRubbings!: Table<CollabRubbing, string>;
  collabLosses!: Table<CollabLoss, string>;
  collabItems!: Table<CollabItem, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史字位记录仅有 lineNo）
    this.version(1).stores({
      steles: 'id, title, era, form, updatedAt',
      rubbings: 'id, steleId, versionNo, method, state, updatedAt',
      losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
    });

    // v2：Loss 增加 charNo 与 [rubbingId+lineNo+charNo] 复合索引，并按行号顺序重建历史字位记录
    this.version(2)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Loss>('losses');
        const all = await table.toArray();
        const byRubbing = new Map<string, Loss[]>();
        all.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuilt: Loss[] = [];
        byRubbing.forEach((list) => {
          // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
          const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
          const counter = new Map<number, number>();
          sorted.forEach((loss) => {
            const used = counter.get(loss.lineNo) ?? 0;
            const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
            counter.set(loss.lineNo, Math.max(used, charNo));
            rebuilt.push({ ...loss, charNo, updatedAt: Date.now() });
          });
        });
        await table.bulkPut(sortLosses(rebuilt));
      });

    // v3：联编对账（合作馆送件 / 对账明细）+ 比对结论历史；损泐补 transcription、比对补 needsReconfirm
    this.version(3)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, collectionNo, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, needsReconfirm, updatedAt',
        compareHistory: 'id, compareId, steleId, reason, recordedAt',
        collabBatches: 'id, batchNo, status, sentAt, updatedAt',
        collabRubbings: 'id, batchId, collectionNo, matchStatus, matchedRubbingId',
        collabLosses: 'id, batchId, collabRubbingId, collectionNo, [collabRubbingId+lineNo+charNo]',
        collabItems: 'id, batchId, collabLossId, ourRubbingId, confirmState, kind, [batchId+collabLossId]',
      })
      .upgrade(async (tx) => {
        // 损泐补 transcription（对方释文）默认空串
        const lossTable = tx.table<Loss>('losses');
        const losses = await lossTable.toArray();
        await lossTable.bulkPut(
          sortLosses(losses.map((loss) => ({ ...loss, transcription: loss.transcription ?? '' }))),
        );
        // 比对记录补 needsReconfirm 默认 false
        const compareTable = tx.table<Compare>('compares');
        const compares = await compareTable.toArray();
        await compareTable.bulkPut(
          compares.map((compare) => ({ ...compare, needsReconfirm: compare.needsReconfirm ?? false })),
        );
      });
  }
}

export const db = new RubbingDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.steles.count()) === 0) {
    await seedDatabase();
  }
  // 联编演示数据独立播种：老库升级上来时也能补上（幂等）
  if ((await db.collabBatches.count()) === 0) {
    await seedCollabData();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const steles: Stele[] = [
    {
      id: 'stele_01',
      title: '礼器碑',
      era: '东汉永寿二年',
      location: '山东曲阜孔庙',
      form: 'stele',
      sizeCm: '227×93',
      calligrapher: '佚名（隶书）',
      createdAt: now - day * 60,
      updatedAt: now - day * 3,
    },
    {
      id: 'stele_02',
      title: '石门颂',
      era: '东汉建和二年',
      location: '陕西汉中石门',
      form: 'cliff',
      sizeCm: '261×205',
      calligrapher: '王升（隶书）',
      createdAt: now - day * 48,
      updatedAt: now - day * 2,
    },
    {
      id: 'stele_03',
      title: '颜勤礼碑',
      era: '唐大历十四年',
      location: '陕西西安碑林',
      form: 'stele',
      sizeCm: '268×92',
      calligrapher: '颜真卿（楷书）',
      createdAt: now - day * 36,
      updatedAt: now - day,
    },
  ];

  const rubbings: Rubbing[] = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  const losses: Loss[] = [
    { id: 'loss_010101', rubbingId: 'rub_0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'light', note: '「壽」字右下漫漶', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'loss_010102', rubbingId: 'rub_0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', note: '石花漫及「年」字', createdAt: now - day * 30, updatedAt: now - day * 29 },
    { id: 'loss_010103', rubbingId: 'rub_0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字缺末笔', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'loss_010201', rubbingId: 'rub_0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', note: '晚拓，「壽」字已损', createdAt: now - day * 24, updatedAt: now - day * 24 },
    { id: 'loss_010202', rubbingId: 'rub_0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字全缺', createdAt: now - day * 24, updatedAt: now - day * 22 },
    { id: 'loss_010203', rubbingId: 'rub_0102', lineNo: 12, charNo: 4, type: 'crack', severity: 'medium', note: '碑面斜裂一道', createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'loss_020101', rubbingId: 'rub_0201', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_020201', rubbingId: 'rub_0202', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂（同前）', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'loss_020202', rubbingId: 'rub_0202', lineNo: 6, charNo: 3, type: 'blur', severity: 'medium', note: '晚拓，「頌」字已漫漶', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_030101', rubbingId: 'rub_0301', lineNo: 4, charNo: 3, type: 'blur', severity: 'heavy', note: '民国拓，字口已平', createdAt: now - day * 10, updatedAt: now - day * 10 },
  ];

  const seals: Seal[] = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Compare[] = [
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-03-06', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-03-08', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares], async () => {
    await db.steles.bulkPut(steles);
    await db.rubbings.bulkPut(rubbings);
    await db.losses.bulkPut(losses);
    await db.seals.bulkPut(seals);
    await db.compares.bulkPut(compares);
  });
}

/* --------------------------- 联编演示数据 --------------------------- */
/* 合作馆编目系统送件：按收藏号 TB-0101 / TB-0102 匹配本馆拓本，
   另送一件本馆没有的 TB-0999（未匹配拓本），覆盖一致 / 冲突 / 仅对方有 / 仅本馆有。 */

export async function seedCollabData(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const batch: CollabBatch = {
    id: 'cb_01',
    batchNo: 'LH-2026-0920',
    source: '合作馆编目系统',
    partner: '合作馆',
    sentAt: '2026-09-20',
    status: 'open',
    note: '合作馆首批联编拓本与损泐字位，请按收藏号对账。',
    createdAt: now - day * 12,
    updatedAt: now - day * 12,
  };

  const collabRubbings: CollabRubbing[] = [
    {
      id: 'cr_0101',
      batchId: 'cb_01',
      collectionNo: 'TB-0101',
      title: '礼器碑',
      method: 'rub',
      paperType: '宣纸',
      inkTone: 'thick',
      sizeCm: '210×88',
      dateGuess: '明拓',
      matchedRubbingId: null,
      matchStatus: 'unmatched',
      createdAt: now - day * 12,
    },
    {
      id: 'cr_0102',
      batchId: 'cb_01',
      collectionNo: 'TB-0102',
      title: '礼器碑',
      method: 'cicada',
      paperType: '棉连纸',
      inkTone: 'light',
      sizeCm: '208×86',
      dateGuess: '清拓',
      matchedRubbingId: null,
      matchStatus: 'unmatched',
      createdAt: now - day * 12,
    },
    {
      id: 'cr_0999',
      batchId: 'cb_01',
      collectionNo: 'TB-0999',
      title: '乙瑛碑（合作馆著录）',
      method: 'rub',
      paperType: '宣纸',
      inkTone: 'thick',
      sizeCm: '—',
      dateGuess: '明拓',
      matchedRubbingId: null,
      matchStatus: 'unmatched',
      createdAt: now - day * 12,
    },
  ];

  const collabLosses: CollabLoss[] = [
    // TB-0101：(3,7) 程度冲突（对方中 / 本馆轻）；(5,2)、(9,11) 一致；(11,5) 仅对方有
    { id: 'cl_010101', batchId: 'cb_01', collabRubbingId: 'cr_0101', collectionNo: 'TB-0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', transcription: '「壽」字漫漶已甚，几不可辨', createdAt: now - day * 12 },
    { id: 'cl_010102', batchId: 'cb_01', collabRubbingId: 'cr_0101', collectionNo: 'TB-0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', transcription: '石花漫及「年」字', createdAt: now - day * 12 },
    { id: 'cl_010103', batchId: 'cb_01', collabRubbingId: 'cr_0101', collectionNo: 'TB-0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', transcription: '「禮」字全泐', createdAt: now - day * 12 },
    { id: 'cl_010104', batchId: 'cb_01', collabRubbingId: 'cr_0101', collectionNo: 'TB-0101', lineNo: 11, charNo: 5, type: 'crack', severity: 'light', transcription: '碑面斜裂一道，拓本可见', createdAt: now - day * 12 },
    // TB-0102：(3,7) 程度冲突（对方重 / 本馆中）；(9,11) 一致；本馆 (12,4) 裂痕对方漏报 → 仅本馆有
    { id: 'cl_010201', batchId: 'cb_01', collabRubbingId: 'cr_0102', collectionNo: 'TB-0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'heavy', transcription: '「壽」字泐甚，晚拓本尤甚', createdAt: now - day * 12 },
    { id: 'cl_010202', batchId: 'cb_01', collabRubbingId: 'cr_0102', collectionNo: 'TB-0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', transcription: '「禮」字全缺', createdAt: now - day * 12 },
    // TB-0999：本馆无此拓本，字位全部仅对方有（未匹配拓本）
    { id: 'cl_099901', batchId: 'cb_01', collabRubbingId: 'cr_0999', collectionNo: 'TB-0999', lineNo: 4, charNo: 6, type: 'missing', severity: 'heavy', transcription: '「某」字泐（合作馆拓本）', createdAt: now - day * 12 },
  ];

  await db.transaction('rw', [db.collabBatches, db.collabRubbings, db.collabLosses], async () => {
    await db.collabBatches.put(batch);
    await db.collabRubbings.bulkPut(collabRubbings);
    await db.collabLosses.bulkPut(collabLosses);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RubbingSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  compareHistory?: CompareHistory[];
  collabBatches?: CollabBatch[];
  collabRubbings?: CollabRubbing[];
  collabLosses?: CollabLoss[];
  collabItems?: CollabItem[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, compareHistory, collabBatches, collabRubbings, collabLosses, collabItems] =
    await Promise.all([
      db.steles.toArray(),
      db.rubbings.toArray(),
      db.losses.toArray(),
      db.seals.toArray(),
      db.compares.toArray(),
      db.compareHistory.toArray(),
      db.collabBatches.toArray(),
      db.collabRubbings.toArray(),
      db.collabLosses.toArray(),
      db.collabItems.toArray(),
    ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
    compareHistory,
    collabBatches,
    collabRubbings,
    collabLosses,
    collabItems,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过）。五张核心表必备，联编表为可选（旧备份兼容） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const required: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of required) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

const ALL_TABLES: Table[] = [
  db.steles,
  db.rubbings,
  db.losses,
  db.seals,
  db.compares,
  db.compareHistory,
  db.collabBatches,
  db.collabRubbings,
  db.collabLosses,
  db.collabItems,
];

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await Promise.all(ALL_TABLES.map((table) => table.clear()));
  });
}

export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction('rw', ALL_TABLES, async () => {
    await db.steles.bulkPut(snapshot.steles);
    await db.rubbings.bulkPut(snapshot.rubbings);
    // 旧备份的损泐可能没有 transcription 字段，补默认值
    await db.losses.bulkPut(snapshot.losses.map((loss) => ({ ...loss, transcription: loss.transcription ?? '' })));
    await db.seals.bulkPut(snapshot.seals);
    await db.compares.bulkPut(snapshot.compares);
    if (Array.isArray(snapshot.compareHistory)) await db.compareHistory.bulkPut(snapshot.compareHistory);
    if (Array.isArray(snapshot.collabBatches)) await db.collabBatches.bulkPut(snapshot.collabBatches);
    if (Array.isArray(snapshot.collabRubbings)) await db.collabRubbings.bulkPut(snapshot.collabRubbings);
    if (Array.isArray(snapshot.collabLosses)) await db.collabLosses.bulkPut(snapshot.collabLosses);
    if (Array.isArray(snapshot.collabItems)) await db.collabItems.bulkPut(snapshot.collabItems);
  });
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
  await seedCollabData();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, compareHistory, collabBatches, collabRubbings, collabLosses, collabItems] =
    await Promise.all([
      db.steles.count(),
      db.rubbings.count(),
      db.losses.count(),
      db.seals.count(),
      db.compares.count(),
      db.compareHistory.count(),
      db.collabBatches.count(),
      db.collabRubbings.count(),
      db.collabLosses.count(),
      db.collabItems.count(),
    ]);
  return {
    steles,
    rubbings,
    losses,
    seals,
    compares,
    compareHistory,
    collabBatches,
    collabRubbings,
    collabLosses,
    collabItems,
  };
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对 / 比对历史 / 联编明细 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction('rw', ALL_TABLES, async () => {
    if (rubbingIds.length > 0) {
      await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
      await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
      await db.collabItems.where('ourRubbingId').anyOf(rubbingIds).delete();
      // 合作馆拓本对本馆拓本的匹配悬空，复位为未匹配
      const matched = await db.collabRubbings.where('matchedRubbingId').anyOf(rubbingIds).toArray();
      if (matched.length > 0) {
        await db.collabRubbings.bulkPut(
          matched.map((row) => ({ ...row, matchedRubbingId: null, matchStatus: 'unmatched' as const })),
        );
      }
    }
    await db.compareHistory.where('steleId').equals(steleId).delete();
    await db.compares.where('steleId').equals(steleId).delete();
    await db.rubbings.where('steleId').equals(steleId).delete();
    await db.steles.delete(steleId);
  });
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录与历史 / 联编明细 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    await db.losses.where('rubbingId').equals(rubbingId).delete();
    await db.seals.where('rubbingId').equals(rubbingId).delete();
    const compares = await db.compares.toArray();
    const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
    if (affected.length > 0) {
      const affectedIds = affected.map((row) => row.id);
      await db.compareHistory.where('compareId').anyOf(affectedIds).delete();
      await db.compares.bulkDelete(affectedIds);
    }
    await db.collabItems.where('ourRubbingId').equals(rubbingId).delete();
    const matched = await db.collabRubbings.where('matchedRubbingId').equals(rubbingId).toArray();
    if (matched.length > 0) {
      await db.collabRubbings.bulkPut(
        matched.map((row) => ({ ...row, matchedRubbingId: null, matchStatus: 'unmatched' as const })),
      );
    }
    await db.rubbings.delete(rubbingId);
  });
}

/** 重排某碑刻下拓本的版本序号，保证连续 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1, updatedAt: Date.now() })));
}

/* --------------------------- 联编认定 / 比对留痕 --------------------------- */

/** 按行号字位查找本馆损泐（同一件拓本同一字位只有一条） */
export async function findLossByCoord(
  rubbingId: string,
  lineNo: number,
  charNo: number,
): Promise<Loss | undefined> {
  return db.losses.where('[rubbingId+lineNo+charNo]').equals([rubbingId, lineNo, charNo]).first();
}

/**
 * 按坐标 upsert 本馆损泐：同一拓本同一字位不重复新增（再送同一批不多出字位）。
 * 认定合并时调用：对方释文并入 transcription，本馆备注 note 一律保留（除非显式传入）。
 */
export async function upsertLossByCoord(
  rubbingId: string,
  lineNo: number,
  charNo: number,
  patch: Partial<Loss>,
): Promise<{ loss: Loss; created: boolean }> {
  const now = Date.now();
  const existing = await findLossByCoord(rubbingId, lineNo, charNo);
  if (existing) {
    const merged: Loss = {
      ...existing,
      ...patch,
      rubbingId,
      lineNo,
      charNo,
      // 本馆备注留着：对方数据永远不覆盖 note
      note: patch.note !== undefined ? patch.note : existing.note,
      transcription: patch.transcription ? patch.transcription : existing.transcription ?? '',
      updatedAt: now,
    };
    await db.losses.put(merged);
    return { loss: merged, created: false };
  }
  const created: Loss = {
    id: createId('loss'),
    rubbingId,
    lineNo,
    charNo,
    type: patch.type ?? 'missing',
    severity: patch.severity ?? 'medium',
    note: patch.note ?? '',
    transcription: patch.transcription ?? '',
    createdAt: now,
    updatedAt: now,
  };
  await db.losses.put(created);
  return { loss: created, created: true };
}

/** 写一条比对结论历史（旧结论留痕，仍可查询） */
export async function addCompareHistory(
  input: Omit<CompareHistory, 'id' | 'recordedAt'> & { recordedAt?: number },
): Promise<CompareHistory> {
  const row: CompareHistory = { ...input, id: createId('ch'), recordedAt: input.recordedAt ?? Date.now() };
  await db.compareHistory.put(row);
  return row;
}

/**
 * 本馆损泐一改动，先前的比对结论就要重新确认：
 * 把涉及该拓本的比对记录置 needsReconfirm，并把旧结论写入历史。已标记过的不重复写。
 */
export async function markComparesAffectedByLoss(rubbingId: string, detail: string): Promise<void> {
  const compares = await db.compares.toArray();
  const affected = compares.filter(
    (compare) =>
      (compare.rubbingIdA === rubbingId || compare.rubbingIdB === rubbingId) && !compare.needsReconfirm,
  );
  if (affected.length === 0) return;
  const now = Date.now();
  await db.transaction('rw', [db.compares, db.compareHistory], async () => {
    for (const compare of affected) {
      await db.compares.update(compare.id, { needsReconfirm: true, updatedAt: now } as never);
      await addCompareHistory({
        compareId: compare.id,
        steleId: compare.steleId,
        rubbingIdA: compare.rubbingIdA,
        rubbingIdB: compare.rubbingIdB,
        diffCount: compare.diffCount,
        conclusion: compare.conclusion,
        operator: compare.operator,
        compareDate: compare.date,
        reason: 'lossChanged',
        detail,
      });
    }
  });
}

/** 编目员重新确认比对结论：清除待确认标记并留痕 */
export async function markCompareReconfirmed(compareId: string): Promise<void> {
  const compare = await db.compares.get(compareId);
  if (!compare) return;
  const now = Date.now();
  await db.transaction('rw', [db.compares, db.compareHistory], async () => {
    await db.compares.update(compareId, { needsReconfirm: false, updatedAt: now } as never);
    await addCompareHistory({
      compareId,
      steleId: compare.steleId,
      rubbingIdA: compare.rubbingIdA,
      rubbingIdB: compare.rubbingIdB,
      diffCount: compare.diffCount,
      conclusion: compare.conclusion,
      operator: compare.operator,
      compareDate: compare.date,
      reason: 'reconfirmed',
      detail: '本馆损泐改动后重新确认结论',
    });
  });
}
