/**
 * 联编对账（Collab）数据模型
 * 合作馆编目系统只送拓本与损泐字位过来联编，那边我们改不了；
 * 本馆编目库由编目员自己维护。两边各自持有自己那份，
 * 对账按收藏号认同一件拓本、按行号字位认一个字位，
 * 只在一边有的字位先记「待核」，编目员看过实物认定后才算数。
 */
import type { InkTone, RubbingMethod } from './rubbing';
import type { LossSeverity, LossType } from './loss';

/** 联编批次状态：待对账 / 对账中 / 部分退回 / 已完成 */
export type CollabBatchStatus = 'open' | 'reconciling' | 'partial' | 'done';

/** 对账明细种类：双方一致 / 仅对方有 / 仅本馆有 / 双方冲突 */
export type CollabItemKind = 'matched' | 'onlyPartner' | 'onlyOurs' | 'conflict';

/** 认定状态：待核 / 已认定 / 已退回 */
export type CollabConfirmState = 'pending' | 'confirmed' | 'returned';

/** 认定方式：采纳对方 / 保留本馆 / 合并释文 / 仅确认对方记录（本馆无对应拓本） */
export type CollabResolution = 'acceptPartner' | 'keepOurs' | 'merge' | 'acknowledged';

/** 合作馆拓本（只读，对方送过来的那份，我们改不了） */
export interface CollabRubbing {
  id: string;
  /** 所属联编批次 */
  batchId: string;
  /** 收藏号 —— 对账认同一件拓本的匹配键 */
  collectionNo: string;
  /** 对方著录的碑名 / 拓本名 */
  title: string;
  method: RubbingMethod;
  paperType: string;
  inkTone: InkTone;
  sizeCm: string;
  dateGuess: string;
  /** 对账匹配到的本馆拓本 id（按收藏号），未匹配为 null */
  matchedRubbingId: string | null;
  /** 对账匹配状态 */
  matchStatus: 'matched' | 'unmatched';
  createdAt: number;
}

/** 合作馆损泐字位（只读） */
export interface CollabLoss {
  id: string;
  batchId: string;
  collabRubbingId: string;
  /** 收藏号（冗余，便于未匹配拓本时也能按号追溯） */
  collectionNo: string;
  lineNo: number;
  charNo: number;
  type: LossType;
  severity: LossSeverity;
  /** 对方补的释文 */
  transcription: string;
  createdAt: number;
}

/** 联编批次：合作馆一次送件 */
export interface CollabBatch {
  id: string;
  /** 批次号，如 LH-2026-0920 */
  batchNo: string;
  /** 来源系统，固定「合作馆编目系统」 */
  source: string;
  /** 合作馆名称 */
  partner: string;
  /** 对方送件日期 yyyy-MM-dd */
  sentAt: string;
  status: CollabBatchStatus;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 对账明细：一个字位一条，记录双方快照与认定结果 */
export interface CollabItem {
  id: string;
  batchId: string;
  /** 对方字位 id（仅本馆有时为 null） */
  collabLossId: string | null;
  collabRubbingId: string | null;
  /** 本馆拓本 id（按收藏号匹配，未匹配为 null） */
  ourRubbingId: string | null;
  /** 本馆字位 id */
  ourLossId: string | null;
  collectionNo: string;
  lineNo: number;
  charNo: number;
  kind: CollabItemKind;
  confirmState: CollabConfirmState;
  resolution: CollabResolution | null;
  /** 对方释文快照 */
  transcription: string;
  /** 本馆备注快照（认定时保留，不被对方覆盖） */
  note: string;
  /** 对方损泐类型 / 程度快照 */
  type: LossType | null;
  severity: LossSeverity | null;
  /** 本馆损泐类型 / 程度快照 */
  ourType: LossType | null;
  ourSeverity: LossSeverity | null;
  confirmedAt: number | null;
  confirmedBy: string;
  returnedAt: number | null;
  returnReason: string;
  createdAt: number;
  updatedAt: number;
}

export const COLLAB_BATCH_STATUS_LABEL: Record<CollabBatchStatus, string> = {
  open: '待对账',
  reconciling: '对账中',
  partial: '部分退回',
  done: '已完成',
};

export const COLLAB_BATCH_STATUS_COLOR: Record<CollabBatchStatus, string> = {
  open: '#8c8c8c',
  reconciling: '#3a6ea5',
  partial: '#a8623a',
  done: '#2f6f4f',
};

export const COLLAB_ITEM_KIND_LABEL: Record<CollabItemKind, string> = {
  matched: '双方一致',
  onlyPartner: '仅对方有',
  onlyOurs: '仅本馆有',
  conflict: '双方冲突',
};

export const COLLAB_ITEM_KIND_COLOR: Record<CollabItemKind, string> = {
  matched: '#2f6f4f',
  onlyPartner: '#3a6ea5',
  onlyOurs: '#a8623a',
  conflict: '#b03a2e',
};

export const COLLAB_CONFIRM_STATE_LABEL: Record<CollabConfirmState, string> = {
  pending: '待核',
  confirmed: '已认定',
  returned: '已退回',
};

export const COLLAB_CONFIRM_STATE_COLOR: Record<CollabConfirmState, string> = {
  pending: '#c9963c',
  confirmed: '#2f6f4f',
  returned: '#b03a2e',
};

export const COLLAB_RESOLUTION_LABEL: Record<CollabResolution, string> = {
  acceptPartner: '采纳对方记录',
  keepOurs: '保留本馆记录',
  merge: '合并释文',
  acknowledged: '确认对方记录属实',
};

export function createEmptyBatchDraft(): Omit<CollabBatch, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    batchNo: '',
    source: '合作馆编目系统',
    partner: '合作馆',
    sentAt: new Date().toISOString().slice(0, 10),
    status: 'open',
    note: '',
  };
}
