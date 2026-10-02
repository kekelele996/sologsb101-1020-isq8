/**
 * 版本比对（Compare）数据模型
 * 同一碑刻下两份拓本的损泐差异清单、断代结论与复核版本。
 */

/** 断代结论：早本 / 晚本 / 同版 / 待考 */
export type CompareConclusion = 'early' | 'late' | 'same' | 'pending';

/** 结论状态：当前有效；源损泐已变待重新确认；已被新结论取代但保留可查 */
export type CompareStatus = 'current' | 'stale' | 'superseded';

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
  /** 结论版本状态 */
  status: CompareStatus;
  /** 待重新确认原因 */
  staleReason: string;
  /** 保存结论时的 A 拓本损泐指纹 */
  fingerprintA: string;
  /** 保存结论时的 B 拓本损泐指纹 */
  fingerprintB: string;
  createdAt: number;
  updatedAt: number;
}

export type CompareDraft = Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'staleReason'>;

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

export const COMPARE_STATUS_LABEL: Record<CompareStatus, string> = {
  current: '当前结论',
  stale: '待重新确认',
  superseded: '旧结论',
};

export const COMPARE_STATUS_COLOR: Record<CompareStatus, string> = {
  current: 'green',
  stale: 'gold',
  superseded: 'default',
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
    fingerprintA: '',
    fingerprintB: '',
  };
}
