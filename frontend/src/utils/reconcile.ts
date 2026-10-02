/**
 * 联编对账纯逻辑
 * - 按收藏号认同一件拓本（合作馆拓本 ↔ 本馆拓本）
 * - 按行号字位认一个字位，生成对账明细（一致 / 仅对方有 / 仅本馆有 / 冲突）
 * - 只在一边有的字位先记「待核」；双方一致的自动认定合并释文
 * - 明细 id 由批次 + 双方字位稳定派生，重复送件 / 重试不产生重复字位
 * 本文件只做纯计算，落库由 collabSlice thunk 负责。
 */
import type { Loss, LossSeverity, LossType } from '@/types/loss';
import type { Rubbing } from '@/types/rubbing';
import type {
  CollabBatch,
  CollabBatchStatus,
  CollabItem,
  CollabItemKind,
  CollabLoss,
  CollabRubbing,
} from '@/types/collab';

/** 收藏号归一：去首尾空格，按号匹配 */
export function normalizeCollectionNo(collectionNo: string): string {
  return collectionNo.trim();
}

/** 字位坐标键 */
export function coordKeyOf(lineNo: number, charNo: number): string {
  return `${lineNo}:${charNo}`;
}

/** 生成稳定的对账明细 id：同一批次同一字位唯一，重复对账不重复落库 */
export function collabItemId(batchId: string, collabLossId: string | null, ourLossId: string | null): string {
  if (collabLossId) return `cit_${batchId}_${collabLossId}`;
  return `cit_${batchId}_our_${ourLossId ?? 'na'}`;
}

export interface ReconcileInput {
  batch: CollabBatch;
  collabRubbings: CollabRubbing[];
  collabLosses: CollabLoss[];
  ourRubbings: Rubbing[];
  ourLosses: Loss[];
  /** 该批次已有明细（用于保留已认定 / 已退回状态） */
  existingItems: CollabItem[];
  now: number;
}

export interface ReconcileOutput {
  /** 全量明细（已按坐标排序），调用方整体覆盖落库 */
  items: CollabItem[];
  /** 对账后的批次状态 */
  batchStatus: CollabBatchStatus;
  /** 双方一致、可自动合并释文的明细（thunk 据此把对方释文并入本馆字位） */
  autoMergeItems: CollabItem[];
}

/** 对方字位 ↔ 本馆字位比对，决定明细种类 */
export function decideKind(
  ourRubbing: Rubbing | null,
  ourLoss: Loss | null,
  collabLoss: CollabLoss,
): CollabItemKind {
  if (!ourRubbing) return 'onlyPartner';
  if (!ourLoss) return 'onlyPartner';
  if (ourLoss.type === collabLoss.type && ourLoss.severity === collabLoss.severity) return 'matched';
  return 'conflict';
}

export function reconcileBatchData(input: ReconcileInput): ReconcileOutput {
  const { batch, collabRubbings, collabLosses, ourRubbings, ourLosses, existingItems, now } = input;

  // 收藏号 → 本馆拓本（同号取版本序号最小者）
  const ourByCollectionNo = new Map<string, Rubbing>();
  [...ourRubbings]
    .sort((a, b) => a.versionNo - b.versionNo)
    .forEach((rubbing) => {
      const key = normalizeCollectionNo(rubbing.collectionNo);
      if (key.length > 0 && !ourByCollectionNo.has(key)) ourByCollectionNo.set(key, rubbing);
    });

  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const items: CollabItem[] = [];
  const autoMergeItems: CollabItem[] = [];

  const upsertItem = (draft: Omit<CollabItem, 'id' | 'createdAt' | 'updatedAt'>): CollabItem => {
    const id = collabItemId(draft.batchId, draft.collabLossId, draft.ourLossId);
    const prev = existingById.get(id);
    if (prev) {
      // 已认定 / 已退回的明细保留其认定结果，仅刷新双方快照（本馆字位可能已改动）
      const kept: CollabItem = {
        ...prev,
        ...draft,
        id,
        confirmState: prev.confirmState,
        resolution: prev.resolution,
        confirmedAt: prev.confirmedAt,
        confirmedBy: prev.confirmedBy,
        returnedAt: prev.returnedAt,
        returnReason: prev.returnReason,
        createdAt: prev.createdAt,
        updatedAt: now,
      };
      items.push(kept);
      return kept;
    }
    const item: CollabItem = { ...draft, id, createdAt: now, updatedAt: now };
    items.push(item);
    return item;
  };

  // 1) 对方送的字位
  const sortedCollabLosses = [...collabLosses].sort((a, b) =>
    a.collabRubbingId === b.collabRubbingId
      ? a.lineNo - b.lineNo || a.charNo - b.charNo
      : a.collabRubbingId.localeCompare(b.collabRubbingId),
  );

  sortedCollabLosses.forEach((cl) => {
    const cr = collabRubbings.find((item) => item.id === cl.collabRubbingId) ?? null;
    const collectionNo = normalizeCollectionNo(cr?.collectionNo ?? cl.collectionNo);
    const ourRubbing = collectionNo.length > 0 ? (ourByCollectionNo.get(collectionNo) ?? null) : null;
    const ourLoss = ourRubbing
      ? (ourLosses.find(
          (loss) => loss.rubbingId === ourRubbing.id && loss.lineNo === cl.lineNo && loss.charNo === cl.charNo,
        ) ?? null)
      : null;
    const kind = decideKind(ourRubbing, ourLoss, cl);

    const item = upsertItem({
      batchId: batch.id,
      collabLossId: cl.id,
      collabRubbingId: cl.collabRubbingId,
      ourRubbingId: ourRubbing?.id ?? null,
      ourLossId: ourLoss?.id ?? null,
      collectionNo,
      lineNo: cl.lineNo,
      charNo: cl.charNo,
      kind,
      // 双方一致的自动认定合并；其余待编目员看过实物认定
      confirmState: kind === 'matched' ? 'confirmed' : 'pending',
      resolution: kind === 'matched' ? 'merge' : null,
      transcription: cl.transcription,
      note: ourLoss?.note ?? '',
      type: cl.type,
      severity: cl.severity,
      ourType: ourLoss?.type ?? null,
      ourSeverity: ourLoss?.severity ?? null,
      confirmedAt: kind === 'matched' ? now : null,
      confirmedBy: kind === 'matched' ? '系统对账' : '',
      returnedAt: null,
      returnReason: '',
    });
    if (kind === 'matched' && ourRubbing) autoMergeItems.push(item);
  });

  // 2) 仅本馆有：对方送了该拓本但漏报的字位（按坐标反查）
  const matchedOurRubbingIds = new Set(
    collabRubbings
      .map((cr) => ourByCollectionNo.get(normalizeCollectionNo(cr.collectionNo))?.id)
      .filter((id): id is string => Boolean(id)),
  );
  const collabCoordSet = new Set(
    collabLosses.map((cl) => `${cl.collabRubbingId}:${coordKeyOf(cl.lineNo, cl.charNo)}`),
  );
  ourLosses.forEach((ourLoss) => {
    if (!matchedOurRubbingIds.has(ourLoss.rubbingId)) return;
    const cr = collabRubbings.find(
      (item) => ourByCollectionNo.get(normalizeCollectionNo(item.collectionNo))?.id === ourLoss.rubbingId,
    );
    if (!cr) return;
    const key = `${cr.id}:${coordKeyOf(ourLoss.lineNo, ourLoss.charNo)}`;
    if (collabCoordSet.has(key)) return; // 对方也报了，已在上面处理
    upsertItem({
      batchId: batch.id,
      collabLossId: null,
      collabRubbingId: cr.id,
      ourRubbingId: ourLoss.rubbingId,
      ourLossId: ourLoss.id,
      collectionNo: normalizeCollectionNo(cr.collectionNo),
      lineNo: ourLoss.lineNo,
      charNo: ourLoss.charNo,
      kind: 'onlyOurs',
      confirmState: 'pending',
      resolution: null,
      transcription: '',
      note: ourLoss.note,
      type: null,
      severity: null,
      ourType: ourLoss.type,
      ourSeverity: ourLoss.severity,
      confirmedAt: null,
      confirmedBy: '',
      returnedAt: null,
      returnReason: '',
    });
  });

  items.sort((a, b) =>
    a.ourRubbingId === b.ourRubbingId
      ? a.lineNo - b.lineNo || a.charNo - b.charNo
      : (a.ourRubbingId ?? '').localeCompare(b.ourRubbingId ?? ''),
  );

  const hasReturned = items.some((item) => item.confirmState === 'returned');
  const hasPending = items.some((item) => item.confirmState === 'pending');
  const batchStatus: CollabBatchStatus =
    items.length === 0
      ? 'open'
      : hasReturned
        ? 'partial'
        : hasPending
          ? 'reconciling'
          : 'done';

  return { items, batchStatus, autoMergeItems };
}

/** 认定后本馆字位的合并结果 */
export interface ConfirmMergeResult {
  /** 是否改动了损泐类型 / 程度（影响比对结论，需触发重新确认） */
  meaningfulChange: boolean;
  /** 认定后本馆字位应有的字段补丁 */
  patch: {
    type: LossType;
    severity: LossSeverity;
    transcription: string;
  };
}

/**
 * 认定合并规则：
 * - 采纳对方（acceptPartner）：类型 / 程度以对方为准，释文并入，本馆备注保留
 * - 保留本馆（keepOurs）：类型 / 程度不动，仅把对方释文并入，本馆备注保留
 * - 仅本馆有（onlyOurs）：本馆记录无误，无需合并
 */
export function resolveConfirmMerge(
  item: CollabItem,
  resolution: 'acceptPartner' | 'keepOurs',
): ConfirmMergeResult | null {
  if (!item.ourRubbingId) return null;
  if (item.kind === 'onlyOurs') return null;
  if (resolution === 'keepOurs') {
    return {
      meaningfulChange: false,
      patch: {
        type: item.ourType ?? 'missing',
        severity: item.ourSeverity ?? 'medium',
        transcription: item.transcription,
      },
    };
  }
  const meaningfulChange =
    item.kind === 'onlyPartner' || item.ourType !== item.type || item.ourSeverity !== item.severity;
  return {
    meaningfulChange,
    patch: {
      type: item.type ?? 'missing',
      severity: item.severity ?? 'medium',
      transcription: item.transcription,
    },
  };
}
