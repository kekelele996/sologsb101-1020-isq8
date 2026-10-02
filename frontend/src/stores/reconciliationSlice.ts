/**
 * 联编对账 slice（Redux Toolkit）
 * 维护合作馆字位、送件批次与按收藏号生成的对账项。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  PartnerLoss,
  ReconciliationBatch,
  ReconciliationDecision,
  ReconciliationItem,
} from '@/types/reconciliation';
import {
  receivePartnerBatch as receivePartnerBatchService,
  reviewReconciliationItem as reviewReconciliationItemService,
} from '@/utils/reconciliation';
import { db } from '@/utils/db';
import type { RootState } from './store';

export interface ReconciliationState {
  partnerLosses: PartnerLoss[];
  batches: ReconciliationBatch[];
  items: ReconciliationItem[];
  loading: boolean;
  ready: boolean;
  error: string;
  selectedBatchId: string | null;
}

const initialState: ReconciliationState = {
  partnerLosses: [],
  batches: [],
  items: [],
  loading: false,
  ready: false,
  error: '',
  selectedBatchId: null,
};

export const loadReconciliation = createAsyncThunk('reconciliation/load', async () => {
  const [partnerLosses, batches, items] = await Promise.all([
    db.partnerLosses.toArray(),
    db.reconciliationBatches.toArray(),
    db.reconciliationItems.toArray(),
  ]);
  partnerLosses.sort((a, b) => b.receivedAt - a.receivedAt);
  batches.sort((a, b) => b.receivedAt - a.receivedAt);
  items.sort((a, b) => a.collectionNo.localeCompare(b.collectionNo) || a.lineNo - b.lineNo || a.charNo - b.charNo);
  return { partnerLosses, batches, items };
});

export const receivePartnerBatch = createAsyncThunk('reconciliation/receive', async (raw: unknown) =>
  receivePartnerBatchService(raw),
);

export const retryReconciliationBatch = createAsyncThunk(
  'reconciliation/retry',
  async (batchId: string) => {
    const batch = await db.reconciliationBatches.get(batchId);
    if (!batch) throw new Error('退回批次不存在');
    if (batch.status !== 'failed' || batch.rawPayload === undefined) throw new Error('该批次不是可重试的退回批次');
    return receivePartnerBatchService(batch.rawPayload);
  },
);

export const reviewReconciliationItem = createAsyncThunk(
  'reconciliation/review',
  async (payload: { id: string; decision: ReconciliationDecision; reviewedBy: string; reviewNote: string }) =>
    reviewReconciliationItemService(payload.id, payload.decision, payload.reviewedBy, payload.reviewNote),
);

const reconciliationSlice = createSlice({
  name: 'reconciliation',
  initialState,
  reducers: {
    setSelectedBatch(state, action: PayloadAction<string | null>) {
      state.selectedBatchId = action.payload;
    },
    clearReconciliationError(state) {
      state.error = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadReconciliation.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadReconciliation.fulfilled, (state, action) => {
        state.partnerLosses = action.payload.partnerLosses;
        state.batches = action.payload.batches;
        state.items = action.payload.items;
        state.loading = false;
        state.ready = true;
        state.error = '';
        const exists = state.selectedBatchId && state.batches.some((batch) => batch.id === state.selectedBatchId);
        if (!exists) state.selectedBatchId = state.batches[0]?.id ?? null;
      })
      .addCase(loadReconciliation.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '联编对账数据读取失败';
      })
      .addCase(receivePartnerBatch.rejected, (state, action) => {
        state.error = action.error.message ?? '合作馆批次接收失败';
      })
      .addCase(retryReconciliationBatch.rejected, (state, action) => {
        state.error = action.error.message ?? '退回批次重试失败';
      });
  },
});

export const { setSelectedBatch, clearReconciliationError } = reconciliationSlice.actions;

export const selectReconciliationState = (state: RootState): ReconciliationState => state.reconciliation;
export const selectPartnerLosses = (state: RootState): PartnerLoss[] => state.reconciliation.partnerLosses;
export const selectReconciliationBatches = (state: RootState): ReconciliationBatch[] => state.reconciliation.batches;
export const selectReconciliationItems = (state: RootState): ReconciliationItem[] => state.reconciliation.items;

export default reconciliationSlice.reducer;
