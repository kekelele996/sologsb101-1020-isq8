/**
 * 版本比对（Compare）数据模型
 * 同一碑刻下两份拓本的损泐差异清单与断代结论。
 */

/** 断代结论：早本 / 晚本 / 同版 / 待考 */
export type CompareConclusion = 'early' | 'late' | 'same' | 'pending';

export interface Compare {
  id: string;
  /** 所属碑刻 id */
  steleId: string;
  /** 拓本 A id */
  rubbingIdA: string;
  /** 拓本 B id */
  rubbingIdB: string;
  /** 差异字数 */
  diffCount: number;
  /** 断代结论 */
  conclusion: CompareConclusion;
  /** 操作人 */
  operator: string;
  /** 比对日期 yyyy-MM-dd */
  date: string;
  /** 本馆损泐改动后旧结论待重新确认（旧结论仍写入 CompareHistory 可查） */
  needsReconfirm?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CompareDraft = Omit<Compare, 'id' | 'createdAt' | 'updatedAt'>;

/** 比对结论变更历史：本馆损泐一改动，旧结论即入此表留痕，仍可查询 */
export type CompareHistoryReason = 'created' | 'reconfirmed' | 'lossChanged';

export interface CompareHistory {
  id: string;
  /** 所属比对记录 id */
  compareId: string;
  /** 所属碑刻 id */
  steleId: string;
  rubbingIdA: string;
  rubbingIdB: string;
  /** 当时差异字数 */
  diffCount: number;
  /** 当时断代结论 */
  conclusion: CompareConclusion;
  operator: string;
  /** 比对日期 yyyy-MM-dd */
  compareDate: string;
  /** 本条历史写入时间（毫秒） */
  recordedAt: number;
  /** 变更原因：新建 / 重新确认 / 损泐改动 */
  reason: CompareHistoryReason;
  /** 变更说明，如「本馆损泐变动：L03C07」 */
  detail: string;
}

export const COMPARE_HISTORY_REASON_LABEL: Record<CompareHistoryReason, string> = {
  created: '新建比对',
  reconfirmed: '重新确认',
  lossChanged: '损泐改动',
};

export const COMPARE_CONCLUSION_LABEL: Record<CompareConclusion, string> = {
  early: '早本',
  late: '晚本',
  same: '同版',
  pending: '待考',
};

export const COMPARE_CONCLUSION_COLOR: Record<CompareConclusion, string> = {
  early: '#2f6f4f',
  late: '#a8623a',
  same: '#3f5d6b',
  pending: '#8c8c8c',
};

export const COMPARE_CONCLUSION_OPTIONS: ReadonlyArray<{ value: CompareConclusion; label: string }> = [
  { value: 'early', label: '早本' },
  { value: 'late', label: '晚本' },
  { value: 'same', label: '同版' },
  { value: 'pending', label: '待考' },
];

export function createEmptyCompareDraft(steleId: string): CompareDraft {
  return {
    steleId,
    rubbingIdA: '',
    rubbingIdB: '',
    diffCount: 0,
    conclusion: 'pending',
    operator: '',
    date: new Date().toISOString().slice(0, 10),
  };
}
