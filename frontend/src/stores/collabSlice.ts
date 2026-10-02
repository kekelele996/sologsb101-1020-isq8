/**
 * 联编对账 slice（Redux Toolkit）
 * 维护合作馆送件（只读）、对账明细与认定 / 退回 / 重试。
 * 两边各自持有自己那份：合作馆数据只读，认定后才把对方释文并入本馆损泐，
 * 本馆备注一律保留；只在一边有的字位先记待核，退回后只重试退回项。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, markComparesAffectedByLoss, upsertLossByCoord } from '@/utils/db';
import {
  reconcileBatchData,
  resolveConfirmMerge,
  type ReconcileOutput,
} from '@/utils/reconcile';
import type {
  CollabBatch,
  CollabBatchStatus,
  CollabConfirmState,
  CollabItem,
  CollabItemKind,
  CollabLoss,
  CollabResolution,
  CollabRubbing,
} from '@/types/collab';
import { encodeCoord } from '@/utils/collate';
import type { RootState } from './store';

export interface CollabFilters {
  keyword: string;
  kinds: CollabItemKind[];
  confirmStates: CollabConfirmState[];
}

export interface CollabState {
  batches: CollabBatch[];
  collabRubbings: CollabRubbing[];
  collabLosses: CollabLoss[];
  items: CollabItem[];
  loading: boolean;
  ready: boolean;
  error: string;
  currentBatchId: string | null;
  filters: CollabFilters;
}

const initialState: CollabState = {
  batches: [],
  collabRubbings: [],
  collabLosses: [],
  items: [],
  loading: false,
  ready: false,
  error: '',
  currentBatchId: null,
  filters: { keyword: '', kinds: [], confirmStates: [] },
};

/** 由明细认定状态反推批次状态 */
function computeBatchStatus(items: CollabItem[]): CollabBatchStatus {
  if (items.length === 0) return 'open';
  if (items.some((item) => item.confirmState === 'returned')) return 'partial';
  if (items.some((item) => item.confirmState === 'pending')) return 'reconciling';
  return 'done';
}

export const loadCollab = createAsyncThunk('collab/load', async () => {
  const [batches, collabRubbings, collabLosses, items] = await Promise.all([
    db.collabBatches.toArray(),
    db.collabRubbings.toArray(),
    db.collabLosses.toArray(),
    db.collabItems.toArray(),
  ]);
  batches.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
  return { batches, collabRubbings, collabLosses, items };
});

/** 对账：按收藏号认同一件拓本、按坐标认一个字位，生成 / 刷新明细（幂等） */
export const reconcileBatch = createAsyncThunk(
  'collab/reconcile',
  async (batchId: string, { dispatch }) => {
    const [batch, collabRubbings, collabLosses, ourRubbings, ourLosses, existingItems] = await Promise.all([
      db.collabBatches.get(batchId),
      db.collabRubbings.where('batchId').equals(batchId).toArray(),
      db.collabLosses.where('batchId').equals(batchId).toArray(),
      db.rubbings.toArray(),
      db.losses.toArray(),
      db.collabItems.where('batchId').equals(batchId).toArray(),
    ]);
    if (!batch) return;
    const now = Date.now();
    const output: ReconcileOutput = reconcileBatchData({
      batch,
      collabRubbings,
      collabLosses,
      ourRubbings,
      ourLosses,
      existingItems,
      now,
    });

    // 刷新合作馆拓本匹配状态
    const matchedByCollectionNo = new Map<string, string>();
    ourRubbings
      .slice()
      .sort((a, b) => a.versionNo - b.versionNo)
      .forEach((rubbing) => {
        const key = rubbing.collectionNo.trim();
        if (key.length > 0 && !matchedByCollectionNo.has(key)) matchedByCollectionNo.set(key, rubbing.id);
      });
    const refreshedRubbings = collabRubbings.map((cr) => {
      const matchedRubbingId = matchedByCollectionNo.get(cr.collectionNo.trim()) ?? null;
      return {
        ...cr,
        matchedRubbingId,
        matchStatus: matchedRubbingId ? ('matched' as const) : ('unmatched' as const),
      };
    });

    await db.transaction('rw', [db.collabItems, db.collabRubbings, db.collabBatches, db.losses], async () => {
      await db.collabItems.bulkPut(output.items);
      await db.collabRubbings.bulkPut(refreshedRubbings);
      // 双方一致的字位：仅把对方释文并入本馆（不改动类型 / 程度，不触发比对重确认）
      for (const item of output.autoMergeItems) {
        if (!item.ourRubbingId) continue;
        await upsertLossByCoord(item.ourRubbingId, item.lineNo, item.charNo, {
          transcription: item.transcription,
        });
      }
      await db.collabBatches.update(batchId, { status: output.batchStatus, updatedAt: now } as never);
    });

    await dispatch(loadCollab());
  },
);

/** 认定：编目员看过实物才算数；采纳对方 / 保留本馆，释文并入、备注留着 */
export const confirmCollabItem = createAsyncThunk(
  'collab/confirm',
  async (
    payload: { itemId: string; resolution: CollabResolution; operator: string },
    { dispatch, getState },
  ) => {
    const state = getState() as RootState;
    const item = state.collab.items.find((row) => row.id === payload.itemId);
    if (!item) return;
    const now = Date.now();

    // 未匹配到本馆拓本的字位：本馆无对应拓本，仅认定对方记录属实，不生成本馆字位
    const resolution: CollabResolution =
      !item.ourRubbingId && item.kind === 'onlyPartner'
        ? 'acknowledged'
        : payload.resolution;

    if (item.ourRubbingId && (resolution === 'acceptPartner' || resolution === 'keepOurs')) {
      const merged = resolveConfirmMerge(item, resolution);
      if (merged) {
        await upsertLossByCoord(item.ourRubbingId, item.lineNo, item.charNo, merged.patch);
        if (merged.meaningfulChange) {
          // 本馆损泐改动 → 先前比对结论需重新确认（旧结论已留痕可查）
          await markComparesAffectedByLoss(
            item.ourRubbingId,
            `联编认定 ${encodeCoord(item.lineNo, item.charNo)}（采纳对方记录）`,
          );
        }
      }
    }

    await db.collabItems.update(item.id, {
      confirmState: 'confirmed',
      resolution,
      confirmedAt: now,
      confirmedBy: payload.operator.trim() || '编目员',
      returnedAt: null,
      returnReason: '',
      updatedAt: now,
    } as never);

    const items = state.collab.items.map((row) =>
      row.id === item.id
        ? { ...row, confirmState: 'confirmed' as const, resolution, confirmedAt: now }
        : row,
    );
    await db.collabBatches.update(item.batchId, { status: computeBatchStatus(items), updatedAt: now } as never);
    await dispatch(loadCollab());
  },
);

/** 退回：对方数据存疑，退回合作馆；只重试退回项，已认定的留着 */
export const returnCollabItem = createAsyncThunk(
  'collab/return',
  async (payload: { itemId: string; reason: string }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const item = state.collab.items.find((row) => row.id === payload.itemId);
    if (!item) return;
    const now = Date.now();
    await db.collabItems.update(item.id, {
      confirmState: 'returned',
      returnedAt: now,
      returnReason: payload.reason.trim() || '对方记录与实物不符',
      updatedAt: now,
    } as never);
    const items = state.collab.items.map((row) =>
      row.id === item.id ? { ...row, confirmState: 'returned' as const, returnedAt: now } : row,
    );
    await db.collabBatches.update(item.batchId, { status: computeBatchStatus(items), updatedAt: now } as never);
    await dispatch(loadCollab());
  },
);

/** 重试退回项：只把退回的那批重置为待核并重新对账，先前认定过的留着 */
export const retryReturnedItems = createAsyncThunk(
  'collab/retryReturned',
  async (batchId: string, { dispatch, getState }) => {
    const state = getState() as RootState;
    const now = Date.now();
    const returned = state.collab.items.filter(
      (item) => item.batchId === batchId && item.confirmState === 'returned',
    );
    if (returned.length === 0) return;
    await db.collabItems.bulkPut(
      returned.map((item) => ({
        ...item,
        confirmState: 'pending' as const,
        resolution: null,
        returnedAt: null,
        returnReason: '',
        updatedAt: now,
      })),
    );
    // 重新对账：已认定的保留，退回项回到待核重审；幂等不产生重复字位
    await dispatch(reconcileBatch(batchId));
  },
);

const collabSlice = createSlice({
  name: 'collab',
  initialState,
  reducers: {
    setCurrentBatch(state, action: PayloadAction<string | null>) {
      state.currentBatchId = action.payload;
    },
    setCollabKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setCollabKinds(state, action: PayloadAction<CollabItemKind[]>) {
      state.filters.kinds = action.payload;
    },
    setCollabConfirmStates(state, action: PayloadAction<CollabConfirmState[]>) {
      state.filters.confirmStates = action.payload;
    },
    resetCollabFilters(state) {
      state.filters = { keyword: '', kinds: [], confirmStates: [] };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadCollab.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadCollab.fulfilled, (state, action) => {
        state.batches = action.payload.batches;
        state.collabRubbings = action.payload.collabRubbings;
        state.collabLosses = action.payload.collabLosses;
        state.items = action.payload.items;
        state.loading = false;
        state.ready = true;
        state.error = '';
        const exists =
          state.currentBatchId !== null && action.payload.batches.some((batch) => batch.id === state.currentBatchId);
        if (!exists) state.currentBatchId = action.payload.batches[0]?.id ?? null;
      })
      .addCase(loadCollab.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '联编数据读取失败';
      });
  },
});

export const {
  setCurrentBatch,
  setCollabKeyword,
  setCollabKinds,
  setCollabConfirmStates,
  resetCollabFilters,
} = collabSlice.actions;

export const selectCollabState = (state: RootState): CollabState => state.collab;
export const selectCollabBatches = (state: RootState): CollabBatch[] => state.collab.batches;
export const selectCollabItems = (state: RootState): CollabItem[] => state.collab.items;

/** 派生：当前批次的明细（关键字 + 种类 + 认定状态筛选） */
export function selectFilteredCollabItems(state: RootState): CollabItem[] {
  const { items, currentBatchId, filters } = state.collab;
  const keyword = filters.keyword.trim();
  return items
    .filter((item) => item.batchId === currentBatchId)
    .filter((item) => {
      if (filters.kinds.length > 0 && !filters.kinds.includes(item.kind)) return false;
      if (filters.confirmStates.length > 0 && !filters.confirmStates.includes(item.confirmState)) return false;
      if (keyword.length > 0) {
        const haystack = `${encodeCoord(item.lineNo, item.charNo)}${item.collectionNo}${item.transcription}${item.note}`;
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
}

export default collabSlice.reducer;
