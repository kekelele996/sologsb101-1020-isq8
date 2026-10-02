/**
 * 合作馆损泐字位与联编对账模型。
 * 合作馆记录独立保存，不覆盖本馆 Loss；对账只按收藏号关联同一件拓本。
 */
import type { Loss, LossSeverity, LossType } from './loss';

/** 合作馆送来的单个损泐字位 */
export interface PartnerLoss {
  /** 自然主键：收藏号 + 行字位，重复送同一字位时更新而不是新增 */
  id: string;
  /** 最近一次所在批次号 */
  batchId: string;
  /** 对账用收藏号（对应 Rubbing.collectionNo） */
  collectionNo: string;
  lineNo: number;
  charNo: number;
  type: LossType;
  severity: LossSeverity;
  /** 合作馆释文；与本馆 Loss.note 分开保存 */
  transcription: string;
  /** 合作馆系统中的原始字位号（如有） */
  remoteLossId?: string;
  partnerName: string;
  receivedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type ReconciliationBatchStatus = 'completed' | 'failed';

/** 一次合作馆送件/退件重试批次 */
export interface ReconciliationBatch {
  id: string;
  partnerName: string;
  status: ReconciliationBatchStatus;
  attemptCount: number;
  /** 最近一次接收时间 */
  receivedAt: number;
  completedAt?: number;
  failedAt?: number;
  errorMessage?: string;
  /** 批次内合作馆拓本数 */
  rubbingCount: number;
  /** 批次内合作馆字位数 */
  partnerLossCount: number;
  /** 对账时纳入批次的本馆字位数（含首次发现的本馆独有字位） */
  localLossCount: number;
  /** 本批次字位对账项数 */
  itemCount: number;
  /** 未识别收藏号数 */
  unmatchedCollectionCount: number;
  /** 载荷校验码；同一批重复送入时用于提示幂等处理 */
  payloadChecksum: string;
  /** 失败批次保留原始退件，供编目员修正后直接原地重试 */
  rawPayload?: unknown;
  createdAt: number;
  updatedAt: number;
}

export type ReconciliationItemStatus =
  | 'matched'
  | 'partnerOnlyPending'
  | 'localOnlyPending'
  | 'confirmedPartner'
  | 'confirmedLocal'
  | 'rejectedPartner'
  | 'rejectedLocal';

export type ReconciliationDecision = 'confirmPartner' | 'confirmLocal' | 'rejectPartner' | 'rejectLocal';

/** 同一收藏号、同一行字位的一条对账结果 */
export interface ReconciliationItem {
  /** 自然主键：收藏号 + 行字位，保证重复对账不多出一条 */
  id: string;
  batchId: string;
  firstBatchId: string;
  collectionNo: string;
  /** 按收藏号匹配到的本馆拓本 id；未匹配时为空 */
  rubbingId: string;
  lineNo: number;
  charNo: number;
  status: ReconciliationItemStatus;
  localLossId: string | null;
  partnerLossId: string | null;
  /** 审核人；系统自动对齐的 matched 状态为空 */
  reviewedBy: string;
  reviewedAt: number | null;
  reviewNote: string;
  localSnapshot: Loss | PartnerLossSnapshotPlaceholder | null;
  partnerSnapshot: PartnerLoss | null;
  createdAt: number;
  updatedAt: number;
}

/** 本馆记录被核销后，仍保留足够字段供审计，不再被当作活动 Loss */
export type PartnerLossSnapshotPlaceholder = Pick<
  Loss,
  'rubbingId' | 'lineNo' | 'charNo' | 'type' | 'severity' | 'note'
> & {
  partnerTranscription?: string;
  removed: true;
};

export interface NormalizedPartnerLoss {
  collectionNo: string;
  lineNo: number;
  charNo: number;
  type: LossType;
  severity: LossSeverity;
  transcription: string;
  remoteLossId?: string;
}

export interface NormalizedPartnerBatch {
  batchId: string;
  partnerName: string;
  sentAt: number;
  rubbings: Array<{ collectionNo: string; losses: NormalizedPartnerLoss[] }>;
}

export interface ReceivePartnerBatchResult {
  batch: ReconciliationBatch;
  reused: boolean;
  createdItemCount: number;
  updatedItemCount: number;
}

export const RECONCILIATION_BATCH_STATUS_LABEL: Record<ReconciliationBatchStatus, string> = {
  completed: '对账完成',
  failed: '待退回重试',
};

export const RECONCILIATION_ITEM_STATUS_LABEL: Record<ReconciliationItemStatus, string> = {
  matched: '字位已对上',
  partnerOnlyPending: '仅合作馆有·待核',
  localOnlyPending: '仅本馆有·待核',
  confirmedPartner: '已看物·采合作馆',
  confirmedLocal: '已看物·维持本馆',
  rejectedPartner: '已看物·不采对方',
  rejectedLocal: '已看物·撤销本馆',
};

export const RECONCILIATION_ITEM_STATUS_COLOR: Record<ReconciliationItemStatus, string> = {
  matched: 'green',
  partnerOnlyPending: 'gold',
  localOnlyPending: 'gold',
  confirmedPartner: 'blue',
  confirmedLocal: 'green',
  rejectedPartner: 'default',
  rejectedLocal: 'default',
};

export const RECONCILIATION_PENDING_STATUSES: readonly ReconciliationItemStatus[] = [
  'partnerOnlyPending',
  'localOnlyPending',
];

export const RECONCILIATION_DECIDED_STATUSES: readonly ReconciliationItemStatus[] = [
  'confirmedPartner',
  'confirmedLocal',
  'rejectedPartner',
  'rejectedLocal',
];

export function partnerLossId(collectionNo: string, lineNo: number, charNo: number): string {
  return `ptl_${collectionNo.trim()}_L${lineNo}_C${charNo}`;
}

export function reconciliationItemId(collectionNo: string, lineNo: number, charNo: number): string {
  return `rcn_${collectionNo.trim()}_L${lineNo}_C${charNo}`;
}
