/**
 * 联编对账服务。
 * 关键约束：合作馆字位独立落库；收藏号是同一件拓本的唯一对账线索；
 * 对账项使用「收藏号+字位」自然主键，失败批次原地重试也不会重复造字位。
 */
import { createId, db } from './db';
import type { Loss, LossSeverity, LossType } from '@/types/loss';
import { LOSS_SEVERITY_OPTIONS, LOSS_TYPE_OPTIONS } from '@/types/loss';
import type { Compare, CompareDraft } from '@/types/compare';
import {
  partnerLossId,
  reconciliationItemId,
  type NormalizedPartnerBatch,
  type NormalizedPartnerLoss,
  type PartnerLoss,
  type ReceivePartnerBatchResult,
  type ReconciliationBatch,
  type ReconciliationDecision,
  type ReconciliationItem,
  type ReconciliationItemStatus,
} from '@/types/reconciliation';
import { buildLossFingerprint, comparePairKey } from './collate';

const LOCAL_REVIEW_REASON = '本馆损泐已改动，请重新确认比对结论';
const lossTypes = new Set<LossType>(LOSS_TYPE_OPTIONS.map((item) => item.value));
const lossSeverities = new Set<LossSeverity>(LOSS_SEVERITY_OPTIONS.map((item) => item.value));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field}不能为空`);
  return value.trim();
}

function positiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${field}必须是 1-${max} 的整数`);
  }
  return value;
}

function normalizeLoss(value: unknown, collectionNo: string): NormalizedPartnerLoss {
  if (!isRecord(value)) throw new Error(`收藏号 ${collectionNo} 下存在不是对象的字位`);
  const lineNo = positiveInt(value.lineNo, '行号', 200);
  const charNo = positiveInt(value.charNo, '字位', 80);
  const type = requireText(value.type, '损泐类型') as LossType;
  if (!lossTypes.has(type)) throw new Error(`字位 L${lineNo}C${charNo} 的损泐类型不受支持：${type}`);
  const severity = requireText(value.severity, '严重程度') as LossSeverity;
  if (!lossSeverities.has(severity)) throw new Error(`字位 L${lineNo}C${charNo} 的严重程度不受支持：${severity}`);
  const transcription = typeof value.transcription === 'string' ? value.transcription : '';
  const remoteId = typeof value.remoteLossId === 'string' ? value.remoteLossId.trim() : undefined;
  return { collectionNo, lineNo, charNo, type, severity, transcription, remoteLossId: remoteId };
}

/** 解析合作馆 JSON。结构错误直接抛出；业务上找不到收藏号在接收事务中登记为失败批次。 */
export function parsePartnerBatch(input: unknown): NormalizedPartnerBatch {
  if (!isRecord(input)) throw new Error('合作馆文件不是合法 JSON 对象');
  const batchId = requireText(input.batchId, '批次号');
  const partnerName = requireText(input.partnerName, '合作馆名称');
  if (!Array.isArray(input.rubbings)) throw new Error('rubbings 必须是数组');
  if (input.rubbings.length === 0) throw new Error('批次内没有拓本');

  const rubbings = input.rubbings.map((rawRubbing) => {
    if (!isRecord(rawRubbing)) throw new Error('批次中存在不是对象的拓本');
    const collectionNo = requireText(rawRubbing.collectionNo, '收藏号');
    if (!Array.isArray(rawRubbing.losses)) throw new Error(`收藏号 ${collectionNo} 的 losses 必须是数组`);
    const seen = new Set<string>();
    const losses = rawRubbing.losses.map((rawLoss) => {
      const loss = normalizeLoss(rawLoss, collectionNo);
      const key = `${loss.lineNo}:${loss.charNo}`;
      if (seen.has(key)) throw new Error(`收藏号 ${collectionNo} 的 ${key} 字位重复`);
      seen.add(key);
      return loss;
    });
    return { collectionNo, losses };
  });

  const collectionSet = new Set<string>();
  rubbings.forEach((rubbing) => {
    if (collectionSet.has(rubbing.collectionNo)) throw new Error(`收藏号 ${rubbing.collectionNo} 在批次中重复`);
    collectionSet.add(rubbing.collectionNo);
  });

  const sentAt = typeof input.sentAt === 'number' && Number.isFinite(input.sentAt) ? input.sentAt : Date.now();
  return { batchId, partnerName, sentAt, rubbings };
}

export function partnerBatchChecksum(batch: NormalizedPartnerBatch): string {
  const compact = {
    batchId: batch.batchId,
    partnerName: batch.partnerName,
    rubbings: batch.rubbings.map((rubbing) => ({
      collectionNo: rubbing.collectionNo,
      losses: rubbing.losses.map((loss) => ({
        lineNo: loss.lineNo,
        charNo: loss.charNo,
        type: loss.type,
        severity: loss.severity,
        transcription: loss.transcription,
        remoteLossId: loss.remoteLossId ?? '',
      })),
    })),
  };
  return JSON.stringify(compact);
}

function coordOf(lineNo: number, charNo: number): string {
  return `${lineNo}:${charNo}`;
}

function toPartnerLoss(row: NormalizedPartnerLoss, batch: NormalizedPartnerBatch, existing: PartnerLoss | undefined, now: number): PartnerLoss {
  const base = existing ?? {
    id: partnerLossId(row.collectionNo, row.lineNo, row.charNo),
    createdAt: now,
  };
  return {
    ...base,
    batchId: batch.batchId,
    collectionNo: row.collectionNo,
    lineNo: row.lineNo,
    charNo: row.charNo,
    type: row.type,
    severity: row.severity,
    transcription: row.transcription,
    remoteLossId: row.remoteLossId,
    partnerName: batch.partnerName,
    receivedAt: batch.sentAt,
    updatedAt: now,
  };
}

/** 本馆损泐变动后，让涉及拓本的当前比对结论进入待重新确认。 */
export async function invalidateComparesForRubbingIds(
  rubbingIds: string[],
  reason = LOCAL_REVIEW_REASON,
): Promise<void> {
  const uniqueIds = Array.from(new Set(rubbingIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  await db.transaction('rw', [db.losses, db.compares], async () => {
    const currentCompares = await db.compares.where('status').equals('current').toArray();
    const affectedCompares = currentCompares.filter(
      (compare) => uniqueIds.includes(compare.rubbingIdA) || uniqueIds.includes(compare.rubbingIdB),
    );
    const fingerprintIds = new Set<string>();
    affectedCompares.forEach((compare) => {
      if (uniqueIds.includes(compare.rubbingIdA)) fingerprintIds.add(compare.rubbingIdA);
      if (uniqueIds.includes(compare.rubbingIdB)) fingerprintIds.add(compare.rubbingIdB);
    });
    const fingerprintLosses =
      fingerprintIds.size > 0 ? await db.losses.where('rubbingId').anyOf(Array.from(fingerprintIds)).toArray() : [];
    const byRubbing = new Map<string, Loss[]>();
    fingerprintLosses.forEach((loss) => byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]));

    const stale = affectedCompares
      .map((compare) => {
        const changedA = uniqueIds.includes(compare.rubbingIdA);
        const changedB = uniqueIds.includes(compare.rubbingIdB);
        const fingerprintA = changedA ? buildLossFingerprint(byRubbing.get(compare.rubbingIdA) ?? []) : compare.fingerprintA;
        const fingerprintB = changedB ? buildLossFingerprint(byRubbing.get(compare.rubbingIdB) ?? []) : compare.fingerprintB;
        return { compare, changedA, changedB, fingerprintA, fingerprintB };
      })
      .filter(
        ({ compare, changedA, changedB, fingerprintA, fingerprintB }) =>
          (changedA && fingerprintA !== compare.fingerprintA) || (changedB && fingerprintB !== compare.fingerprintB),
      )
      .map(({ compare, fingerprintA, fingerprintB }) => ({
        ...compare,
        status: 'stale' as const,
        staleReason: reason,
        fingerprintA,
        fingerprintB,
        updatedAt: Date.now(),
      }));
    if (stale.length > 0) await db.compares.bulkPut(stale);
  });
}

async function markComparesStaleInTransaction(rubbingIds: string[], reason: string): Promise<void> {
  const uniqueIds = Array.from(new Set(rubbingIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  const currentCompares = await db.compares.where('status').equals('current').toArray();
  const affectedCompares = currentCompares.filter(
    (compare) => uniqueIds.includes(compare.rubbingIdA) || uniqueIds.includes(compare.rubbingIdB),
  );
  const fingerprintIds = new Set<string>();
  affectedCompares.forEach((compare) => {
    if (uniqueIds.includes(compare.rubbingIdA)) fingerprintIds.add(compare.rubbingIdA);
    if (uniqueIds.includes(compare.rubbingIdB)) fingerprintIds.add(compare.rubbingIdB);
  });
  const fingerprintLosses =
    fingerprintIds.size > 0 ? await db.losses.where('rubbingId').anyOf(Array.from(fingerprintIds)).toArray() : [];
  const byRubbing = new Map<string, Loss[]>();
  fingerprintLosses.forEach((loss) => byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]));

  const stale = affectedCompares
    .map((compare) => {
      const changedA = uniqueIds.includes(compare.rubbingIdA);
      const changedB = uniqueIds.includes(compare.rubbingIdB);
      const fingerprintA = changedA ? buildLossFingerprint(byRubbing.get(compare.rubbingIdA) ?? []) : compare.fingerprintA;
      const fingerprintB = changedB ? buildLossFingerprint(byRubbing.get(compare.rubbingIdB) ?? []) : compare.fingerprintB;
      return { compare, changedA, changedB, fingerprintA, fingerprintB };
    })
    .filter(
      ({ compare, changedA, changedB, fingerprintA, fingerprintB }) =>
        (changedA && fingerprintA !== compare.fingerprintA) || (changedB && fingerprintB !== compare.fingerprintB),
    )
    .map(({ compare, fingerprintA, fingerprintB }) => ({
      ...compare,
      status: 'stale' as const,
      staleReason: reason,
      fingerprintA,
      fingerprintB,
      updatedAt: Date.now(),
    }));
  if (stale.length > 0) await db.compares.bulkPut(stale);
}

/**
 * 接收合作馆批次。
 * 成功时原子写入合作馆字位、对账批次和自然主键对账项；失败时只登记/更新该批次，等待原地重试。
 */
export async function receivePartnerBatch(raw: unknown): Promise<ReceivePartnerBatchResult> {
  const normalized = parsePartnerBatch(raw);
  const checksum = partnerBatchChecksum(normalized);
  const now = Date.now();

  return (async () => {
    const collectionNos = normalized.rubbings.map((rubbing) => rubbing.collectionNo);
    const localRubbings = await db.rubbings.where('collectionNo').anyOf(collectionNos).toArray();
    const rubbingByCollection = new Map(localRubbings.map((rubbing) => [rubbing.collectionNo, rubbing]));
    const unknownCollections = collectionNos.filter((collectionNo) => !rubbingByCollection.has(collectionNo));
    const existingBatch = await db.reconciliationBatches.get(normalized.batchId);

    if (unknownCollections.length > 0) {
      const errorMessage = `本馆库找不到收藏号：${unknownCollections.join('、')}`;
      await db.reconciliationBatches.put({
        id: normalized.batchId,
        partnerName: normalized.partnerName,
        status: 'failed',
        attemptCount: (existingBatch?.attemptCount ?? 0) + 1,
        receivedAt: normalized.sentAt,
        failedAt: now,
        errorMessage,
        rubbingCount: normalized.rubbings.length,
        partnerLossCount: normalized.rubbings.reduce((sum, rubbing) => sum + rubbing.losses.length, 0),
        localLossCount: 0,
        itemCount: 0,
        unmatchedCollectionCount: unknownCollections.length,
        payloadChecksum: checksum,
        rawPayload: raw,
        createdAt: existingBatch?.createdAt ?? now,
        updatedAt: now,
      });
      throw new Error(errorMessage);
    }

    return db.transaction(
      'rw',
      [db.rubbings, db.losses, db.compares, db.partnerLosses, db.reconciliationBatches, db.reconciliationItems],
      async (): Promise<ReceivePartnerBatchResult> => {
        if (existingBatch?.status === 'completed' && existingBatch.payloadChecksum === checksum) {
          return { batch: existingBatch, reused: true, createdItemCount: 0, updatedItemCount: 0 };
        }

      const rubbingIds = localRubbings.map((rubbing) => rubbing.id);
      const localLosses = await db.losses.where('rubbingId').anyOf(rubbingIds).toArray();
      const localByCoord = new Map<string, Loss>();
      localLosses.forEach((loss) => {
        const rubbing = localRubbings.find((item) => item.id === loss.rubbingId);
        if (rubbing) localByCoord.set(`${rubbing.collectionNo}::${coordOf(loss.lineNo, loss.charNo)}`, loss);
      });

      const existingPartnerLosses = await db.partnerLosses.where('collectionNo').anyOf(collectionNos).toArray();
      const partnerByCoord = new Map<string, PartnerLoss>();
      existingPartnerLosses.forEach((loss) => partnerByCoord.set(`${loss.collectionNo}::${coordOf(loss.lineNo, loss.charNo)}`, loss));

      const existingItems = await db.reconciliationItems.where('collectionNo').anyOf(collectionNos).toArray();
      const itemByCoord = new Map<string, ReconciliationItem>();
      existingItems.forEach((item) => itemByCoord.set(`${item.collectionNo}::${coordOf(item.lineNo, item.charNo)}`, item));

      const partnerPuts: PartnerLoss[] = [];
      const itemPuts: ReconciliationItem[] = [];
      const lossPuts: Loss[] = [];
      let createdItemCount = 0;
      let updatedItemCount = 0;
      let partnerLossCount = 0;

      normalized.rubbings.forEach((rubbingPayload) => {
        partnerLossCount += rubbingPayload.losses.length;
        rubbingPayload.losses.forEach((partnerRow) => {
          const key = `${rubbingPayload.collectionNo}::${coordOf(partnerRow.lineNo, partnerRow.charNo)}`;
          const oldPartner = partnerByCoord.get(key);
          const partner = toPartnerLoss(partnerRow, normalized, oldPartner, now);
          partnerPuts.push(partner);
          partnerByCoord.set(key, partner);
        });
      });

      // 同批退件重试时，对账范围仍限定为退回拓本；自然主键保证先前已认定项不被重置。
      normalized.rubbings.forEach((rubbingPayload) => {
        const rubbing = rubbingByCollection.get(rubbingPayload.collectionNo);
        if (!rubbing) return;
        const keys = new Set<string>();
        rubbingPayload.losses.forEach((loss) => keys.add(coordOf(loss.lineNo, loss.charNo)));
        localLosses
          .filter((loss) => loss.rubbingId === rubbing.id)
          .forEach((loss) => keys.add(coordOf(loss.lineNo, loss.charNo)));

        keys.forEach((coord) => {
          const key = `${rubbingPayload.collectionNo}::${coord}`;
          const partner = partnerByCoord.get(key) ?? null;
          const local = localByCoord.get(key) ?? null;
          const existing = itemByCoord.get(key);
          const [lineNoText, charNoText] = coord.split(':');
          const lineNo = Number.parseInt(lineNoText ?? '0', 10);
          const charNo = Number.parseInt(charNoText ?? '0', 10);

          if (local && partner) {
            const merged: Loss = { ...local, partnerTranscription: partner.transcription || local.partnerTranscription, updatedAt: now };
            lossPuts.push(merged);
            localByCoord.set(key, merged);
          }

          const currentLocal = localByCoord.get(key) ?? null;
          const pendingStatuses: ReconciliationItemStatus[] = ['partnerOnlyPending', 'localOnlyPending'];
          const calculatedStatus: ReconciliationItem['status'] = partner && currentLocal
            ? 'matched'
            : partner
              ? 'partnerOnlyPending'
              : 'localOnlyPending';
          const status = existing && !pendingStatuses.includes(existing.status) ? existing.status : calculatedStatus;

          const item: ReconciliationItem = existing
            ? {
                ...existing,
                firstBatchId: existing.firstBatchId ?? normalized.batchId,
                batchId: normalized.batchId,
                rubbingId: rubbing.id,
                status,
                localLossId: currentLocal?.id ?? existing.localLossId,
                partnerLossId: partner?.id ?? existing.partnerLossId,
                localSnapshot: currentLocal ?? existing.localSnapshot,
                partnerSnapshot: partner ?? existing.partnerSnapshot,
                updatedAt: now,
              }
            : {
                id: reconciliationItemId(rubbing.collectionNo, lineNo, charNo),
                batchId: normalized.batchId,
                firstBatchId: normalized.batchId,
                collectionNo: rubbing.collectionNo,
                rubbingId: rubbing.id,
                lineNo,
                charNo,
                status,
                localLossId: currentLocal?.id ?? null,
                partnerLossId: partner?.id ?? null,
                reviewedBy: '',
                reviewedAt: null,
                reviewNote: '',
                localSnapshot: currentLocal,
                partnerSnapshot: partner,
                createdAt: now,
                updatedAt: now,
              };
          if (!existing) createdItemCount += 1;
          else updatedItemCount += 1;
          itemPuts.push(item);
          itemByCoord.set(key, item);
        });
      });

      const batch: ReconciliationBatch = {
        id: normalized.batchId,
        partnerName: normalized.partnerName,
        status: 'completed',
        attemptCount: (existingBatch?.attemptCount ?? 0) + 1,
        receivedAt: normalized.sentAt,
        completedAt: now,
        rubbingCount: normalized.rubbings.length,
        partnerLossCount,
        localLossCount: localLosses.filter((loss) => rubbingIds.includes(loss.rubbingId)).length,
        itemCount: itemPuts.length,
        unmatchedCollectionCount: 0,
        payloadChecksum: checksum,
        rawPayload: undefined,
        createdAt: existingBatch?.createdAt ?? now,
        updatedAt: now,
      };

      await db.partnerLosses.bulkPut(partnerPuts);
      await db.losses.bulkPut(lossPuts);
      await db.reconciliationItems.bulkPut(itemPuts);
      await db.reconciliationBatches.put(batch);
      return { batch, reused: false, createdItemCount, updatedItemCount };
      },
    );
  })();
}

/** 编目员看实物后的人工认定。系统自动 matched 项不需要再审核。 */
export async function reviewReconciliationItem(
  itemId: string,
  decision: ReconciliationDecision,
  reviewedBy: string,
  reviewNote = '',
): Promise<ReconciliationItem> {
  const operator = reviewedBy.trim();
  if (operator.length === 0) throw new Error('请填写看物认定的编目员');
  const now = Date.now();

  return db.transaction(
    'rw',
    [db.losses, db.compares, db.partnerLosses, db.reconciliationItems],
    async (): Promise<ReconciliationItem> => {
      const item = await db.reconciliationItems.get(itemId);
      if (!item) throw new Error('对账项不存在');
      if (item.status !== 'partnerOnlyPending' && item.status !== 'localOnlyPending') {
        throw new Error('该字位已经认定，不能重复审核');
      }
      const partner = item.partnerLossId ? await db.partnerLosses.get(item.partnerLossId) : null;
      let local = item.localLossId ? await db.losses.get(item.localLossId) : null;
      let changedLocal = false;
      let affectedRubbingId = item.rubbingId;

      if (decision === 'confirmPartner') {
        if (!partner) throw new Error('合作馆字位不存在，无法采入');
        if (local) {
          local = { ...local, partnerTranscription: partner.transcription || local.partnerTranscription, updatedAt: now };
        } else {
          local = {
            id: createId('loss'),
            rubbingId: item.rubbingId,
            lineNo: item.lineNo,
            charNo: item.charNo,
            type: partner.type,
            severity: partner.severity,
            note: '',
            partnerTranscription: partner.transcription,
            createdAt: now,
            updatedAt: now,
          };
        }
        await db.losses.put(local);
        changedLocal = true;
        affectedRubbingId = local.rubbingId;
      }

      if (decision === 'confirmLocal' && !local) throw new Error('本馆字位不存在，无法维持本馆记录');

      const rejectedLocal = decision === 'rejectLocal';
      if (rejectedLocal && !local) throw new Error('本馆字位不存在，无法撤销本馆记录');
      const localSnapshotAfterReview = local
        ? {
            rubbingId: local.rubbingId,
            lineNo: local.lineNo,
            charNo: local.charNo,
            type: local.type,
            severity: local.severity,
            note: local.note,
            partnerTranscription: local.partnerTranscription,
            removed: true as const,
          }
        : item.localSnapshot;
      if (rejectedLocal && local) {
        await db.losses.delete(local.id);
        changedLocal = true;
        affectedRubbingId = local.rubbingId;
      }

      // rejectLocal 在看物认定后核销本馆 Loss；未认定前本馆损泐仍按原记录保留。
      const nextStatus: ReconciliationItem['status'] =
        decision === 'confirmPartner'
          ? 'confirmedPartner'
          : decision === 'confirmLocal'
            ? 'confirmedLocal'
            : decision === 'rejectPartner'
              ? 'rejectedPartner'
              : 'rejectedLocal';

      const nextItem: ReconciliationItem = {
        ...item,
        status: nextStatus,
        localLossId: rejectedLocal ? null : local?.id ?? item.localLossId,
        partnerLossId: partner?.id ?? item.partnerLossId,
        reviewedBy: operator,
        reviewedAt: now,
        reviewNote,
        localSnapshot: rejectedLocal ? localSnapshotAfterReview : local ?? item.localSnapshot,
        partnerSnapshot: partner ?? item.partnerSnapshot,
        updatedAt: now,
      };
      await db.reconciliationItems.put(nextItem);
      if (changedLocal) await markComparesStaleInTransaction([affectedRubbingId], LOCAL_REVIEW_REASON);
      return nextItem;
    },
  );
}

/** 本馆新增/补录字位后，把仍待核且同坐标的合作馆字位转为对上。 */
export async function synchronizeReconciliationForRubbing(rubbingId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.rubbings, db.losses, db.partnerLosses, db.reconciliationItems],
    async () => {
      const rubbing = await db.rubbings.get(rubbingId);
      if (!rubbing || !rubbing.collectionNo) return;
      const localLosses = await db.losses.where('rubbingId').equals(rubbingId).toArray();
      const partners = await db.partnerLosses.where('collectionNo').equals(rubbing.collectionNo).toArray();
      const items = await db.reconciliationItems.where('collectionNo').equals(rubbing.collectionNo).toArray();
      const now = Date.now();
      const puts: ReconciliationItem[] = [];
      const lossPuts: Loss[] = [];

      const localMap = new Map(localLosses.map((loss) => [coordOf(loss.lineNo, loss.charNo), loss]));
      const partnerMap = new Map(partners.map((loss) => [coordOf(loss.lineNo, loss.charNo), loss]));

      items.forEach((item) => {
        const coord = coordOf(item.lineNo, item.charNo);
        const local = localMap.get(coord) ?? null;
        const partner = partnerMap.get(coord) ?? null;
        let next = item;
        let changed = false;

        if (item.status === 'partnerOnlyPending' && local && partner) {
          let mergedLocal = local;
          if (partner.transcription.length > 0 && local.partnerTranscription !== partner.transcription) {
            mergedLocal = { ...local, partnerTranscription: partner.transcription, updatedAt: now };
            lossPuts.push(mergedLocal);
            localMap.set(coord, mergedLocal);
          }
          next = {
            ...item,
            status: 'matched',
            rubbingId: rubbingId,
            localLossId: mergedLocal.id,
            partnerLossId: partner.id,
            localSnapshot: mergedLocal,
            partnerSnapshot: partner,
            updatedAt: now,
          };
          changed = true;
        } else if (item.status === 'matched' && !local && partner && !item.reviewedAt) {
          next = { ...item, status: 'partnerOnlyPending', localLossId: null, localSnapshot: null, updatedAt: now };
          changed = true;
        }

        if (changed) puts.push(next);
      });

      if (lossPuts.length > 0) await db.losses.bulkPut(lossPuts);
      if (puts.length > 0) await db.reconciliationItems.bulkPut(puts);
    },
  );
}

/** 保存一条新结论，并把同一拓本对的当前结论置为旧结论；历史记录不覆盖。 */
export async function saveCompareRevision(draft: CompareDraft): Promise<Compare> {
  const now = Date.now();
  return db.transaction('rw', [db.losses, db.compares], async () => {
    const [lossesA, lossesB] = await Promise.all([
      db.losses.where('rubbingId').equals(draft.rubbingIdA).toArray(),
      db.losses.where('rubbingId').equals(draft.rubbingIdB).toArray(),
    ]);
    const fingerprintA = draft.fingerprintA || buildLossFingerprint(lossesA);
    const fingerprintB = draft.fingerprintB || buildLossFingerprint(lossesB);
    const pair = comparePairKey(draft.rubbingIdA, draft.rubbingIdB);
    const existingCompares = await db.compares.toArray();
    const superseded = existingCompares
      .filter(
        (item) =>
          (item.status === 'current' || item.status === 'stale') &&
          comparePairKey(item.rubbingIdA, item.rubbingIdB) === pair,
      )
      .map((item) => ({
        ...item,
        status: 'superseded' as const,
        staleReason: `已由 ${draft.date} 的新结论取代`,
        updatedAt: now,
      }));
    const row: Compare = {
      ...draft,
      fingerprintA,
      fingerprintB,
      id: createId('cmp'),
      status: 'current',
      staleReason: '',
      createdAt: now,
      updatedAt: now,
    };
    if (superseded.length > 0) await db.compares.bulkPut(superseded);
    await db.compares.put(row);
    return row;
  });
}
